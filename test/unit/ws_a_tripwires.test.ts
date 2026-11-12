/**
 * WS-A WRITE-PATH TRIPWIRES — mechanical enforcement of two invariants whose
 * violations produced the audit's realized corruption incidents:
 *
 *  1. JSONB BINDING DISCIPLINE (S2-07; incidents S1-07, S1-08): on Bun 1.3.9
 *     — and, re-probed 2026-08-25, UNCHANGED on 1.4.0 —
 *     a parameter whose inferred type is jsonb gets JSON-encoded by BUN — a
 *     pre-encoded JSON string arrives DOUBLE-encoded (a jsonb string scalar,
 *     silently corrupting the SHARED database). The rule: every `$n::jsonb`
 *     bind in the write-path corpus must be `$n::text::jsonb` (app-owned
 *     encoding via json_codec) unless the FILE is on the object-binding
 *     allowlist (TS-owned jobs tables that bind raw JS objects, documented
 *     convention). Two matchers, one law: the CAST-shaped one (`$n::jsonb`
 *     anywhere) is the subset; the COLUMN-shaped one (audit GATE-18) reads
 *     each DML statement and requires EVERY placeholder that feeds a matrix
 *     jsonb column — `col = $n`, a jsonb_set path value, a `||` operand, a
 *     VALUES slot — to carry `::text::jsonb`, cast or no cast: a bare `$n`
 *     assigned to a jsonb column is inferred jsonb by Bun exactly like
 *     `$n::jsonb` is, so the spelling that evades the cast matcher is the
 *     same trap.
 *
 *  2. LOCATOR LAW (S2-03/S2-04 per DEC-21): locator equality lives in
 *     concepts/locator.ts (compareLocators — PHP-exact semantics: section_id
 *     loose-numeric, other properties strict + present-on-both). New inline
 *     `.section_id ===`-style matchers drift from the law over a DB where
 *     string and numeric section_id forms coexist IN THE SAME record. The
 *     allowlist below is the migration RATCHET: it may only SHRINK. When you
 *     migrate a listed file onto compareLocators/isLocatorInArray, delete its
 *     entry in the same change. Already migrated: relations/save.ts
 *     (sort_data + delete_locator), section/record/delete_record.ts
 *     (inverse-reference cleanup). Deliberately NOT locator comparisons (kept
 *     with a note, not migrated): section/locks.ts (lock-triple key equality
 *     over ITS OWN table's text-normalized section_id — consistent String()
 *     normalization on both sides at creation time, not stored-locator
 *     matching).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MATRIX_JSONB_COLUMNS } from '../../src/core/db/matrix.ts';
import { extractSourceLiterals, normalizeSqlLiteral } from '../helpers/sql_literals.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/**
 * THE census corpus: src/ + tools/ + scripts/, shared with the other write-path
 * gates (test/helpers/write_path_corpus.ts). scripts/ joined 2026-09-02
 * (P2-20/S-3): `scripts/migrate_section_id_locators.ts` rewrites matrix jsonb
 * and was outside the jsonb-bind law and the locator law.
 */
const sourceFiles = writePathSourceFiles;

describe('census corpus', () => {
	test('the shared write-path corpus is populated and includes scripts/', () => {
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		expect(files).toContain('scripts/migrate_section_id_locators.ts');
	});
});

function read(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf-8');
}

// ---------------------------------------------------------------------------
// 1. jsonb binding discipline.
// ---------------------------------------------------------------------------

/**
 * Files allowed to bind parameters as bare `$n::jsonb`: they bind raw JS
 * OBJECTS (not pre-encoded JSON text) into TS-OWNED tables, the documented
 * convention B — Bun's own encoding is correct for objects. Everything
 * touching the SHARED matrix/RAG tables binds encodeForJsonb text as
 * `$n::text::jsonb`.
 */
const BARE_JSONB_BIND_ALLOWLIST: readonly string[] = [
	'src/diffusion/jobs/', // dedalo_ts_diffusion_job* (TS-owned, raw-object binds)
];

describe('S2-07 — jsonb parameter binds are ::text::jsonb (json_codec owns encoding)', () => {
	test('no bare $n::jsonb bind outside the object-binding allowlist', () => {
		// $n::jsonb NOT preceded by ::text (negative lookbehind emulated by
		// matching the full cast chain). Case-insensitive and whitespace-tolerant
		// around `::` — Postgres accepts `$1::JSONB` and `$1 ::jsonb` alike, so
		// the scan must too (evasion-hole hardening, 2026-07-07). The sanctioned
		// `$n::text::jsonb` chain still never matches: the pattern requires
		// jsonb as the FIRST cast after the parameter.
		const barePattern = /\$\d+\s*::\s*jsonb/gi;
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			if (BARE_JSONB_BIND_ALLOWLIST.some((prefix) => file.startsWith(prefix))) continue;
			const content = read(file);
			for (const match of content.matchAll(barePattern)) {
				const start = match.index ?? 0;
				// Allow the sanctioned chain: `$n::text::jsonb` — the matched
				// `$n::jsonb` can only be bare (the chain contains `::text::`
				// between the param and ::jsonb, so it never matches this regex).
				const line = content.slice(0, start).split('\n').length;
				violations.push(`${file}:${line} ${match[0]}`);
			}
		}
		expect(
			violations,
			`Bare $n::jsonb bind: on every Bun this engine has run (1.3.9 through 1.4.0) this DOUBLE-encodes pre-encoded JSON into a jsonb string scalar (the S1-07/S1-08 corruption). Bind encodeForJsonb(...) as $n::text::jsonb, or — for raw-object binds into a TS-owned table — add the file to the allowlist WITH justification: ${violations.join(', ')}`,
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 1b. COLUMN-shaped jsonb binding (audit GATE-18).
//
// The cast matcher above only sees a bind that SPELLS `::jsonb`. Bun infers the
// parameter type from the COLUMN when there is no cast at all, so
// `SET data = $1` and `VALUES ($1, $2)` into a jsonb column double-encode a
// pre-encoded string just the same. This matcher therefore starts from the
// STATEMENT and its STRUCTURE, not from a list of spellings: every DML literal
// against a matrix-family target (a literal `matrix*` name — schema-qualified
// or not, `ONLY` or not — or an interpolated `${…}` target) is read whole, its
// write positions are parsed, and every placeholder found in one is judged.
//
// WRITE POSITIONS. (a) Every SET clause (UPDATE, MERGE … WHEN MATCHED THEN
// UPDATE, ON CONFLICT DO UPDATE): the assignments are split at top-level
// commas; `col = <expression>` and the row form `(a, b) = (<e1>, <e2>)` /
// `ROW(…)` pair by position, `(a, b) = (SELECT …)` assigns the whole subselect
// to every column. (b) Every INSERT (`INSERT INTO t` and MERGE's `INSERT`): the
// column list pairs by position with EVERY `VALUES (…), (…)` row, or with the
// `INSERT … SELECT` list; an INSERT against a matrix target with NO column list
// is red by itself (the slot↔column pairing is the table's physical column
// order, which no scanner can know — name the columns).
//
// THE VERDICT is FAIL-CLOSED over the whole expression assigned to a jsonb
// column, not over a catalogue of positions: the type of a bare placeholder is
// whatever Postgres infers from its context (`jsonb_set(data, $3, $2)`,
// `CASE WHEN $3 THEN $2 ELSE data END`, `(SELECT $2)`, `COALESCE(data, $2)` all
// infer jsonb and each was measured to land a string scalar), which a scanner
// cannot compute — so every placeholder in such an expression must STATE its
// type: a chain that names a JSON type ANYWHERE — `jsonb`, `json` (oid 114:
// Bun JSON-encodes it exactly like 3802, and `json` assigns to a jsonb column
// through the implicit cast, measured to land the same string scalar) or
// their `pg_catalog.` spellings — must be exactly `::text::jsonb`
// (`($1)::text::jsonb`, `($1::text)::jsonb` and `CAST($1::text AS jsonb)` are
// that chain spelled with parentheses; `($1::json)::jsonb`, `$1::pg_catalog.jsonb`
// and `CAST($1::text AS json)` are not); a chain of KNOWN SCALAR types
// (`$2::int`, `$1::text`, `$3::text[]`, `double precision`, `character
// varying`) is a scalar bind Postgres cannot mistake for jsonb; any other
// type name (a domain, an unknown, an enum) is red — the scanner does not
// know what it is, so it does not guess; `to_jsonb(<ph>…)` / `to_json(<ph>…)`
// is red whatever the cast (a bound scalar turned into a JSON scalar is the
// double-encode shape by construction). Placeholders inside quoted SQL
// strings (`'{${tipo}}'`) and quoted identifiers (`"${column}"`) are not
// binds; SQL comments are stripped from the literal first.
//
// A `${…}` hole in column position (`${column}`, `${sql('data')}`) counts as
// a jsonb column — the scanner cannot read the name, so it does not guess. A
// placeholder is `$n`, `$${…}` (a computed index) or a tagged `${…}` hole.
// Every matcher is case-insensitive and unquoted column names fold to
// lowercase (Postgres semantics).
//
// LIMITS, stated: a list that is itself ONE interpolation (`(${columns})`,
// `VALUES (${placeholders})`, `SET ${setClauses}` — matrix_write.ts's dynamic
// upsert) and a slot that is a `.join(`/`.map(` hole cannot be paired here —
// matrix_write.ts builds every slot with the cast and its round-trip gate
// proves the bytes. A WHERE predicate is not a write position (a bare bind
// there mis-compares, it does not corrupt).
// ---------------------------------------------------------------------------

const PLACEHOLDER = String.raw`(?:\$\$\{[^}]*\}|\$\d+|\$\{[^}]*\})`;
/** One `::type` step: an optional `schema.`, the name, an optional `[]`. */
const CAST_STEP = String.raw`::\s*(?:[a-z_]\w*\s*\.\s*)?[a-z_]\w*(?:\s*\[\s*\])?`;
const CAST_CHAIN = String.raw`((?:\s*${CAST_STEP})*)`;
const SANCTIONED_CHAIN = /^::text::jsonb$/i;
/** A JSON type name, in any spelling Postgres accepts (folded, `pg_catalog.` removed). */
const JSON_TYPE = /^jsonb?(?:\[\])?$/;
/**
 * The scalar types a bind may state: Postgres cannot read one of these as
 * JSON, whatever the column. A type NOT here (a domain, an enum, a typo) is
 * unknown to the scanner and therefore red — the list grows by evidence.
 */
const SCALAR_TYPES = new Set([
	'text',
	'varchar',
	'character',
	'char',
	'bpchar',
	'name',
	'int',
	'int2',
	'int4',
	'int8',
	'integer',
	'smallint',
	'bigint',
	'numeric',
	'decimal',
	'real',
	'float',
	'float4',
	'float8',
	'double',
	'boolean',
	'bool',
	'date',
	'time',
	'timetz',
	'timestamp',
	'timestamptz',
	'interval',
	'uuid',
	'bytea',
	'oid',
	'regclass',
]);
/** Fold a cast chain: whitespace and parentheses out, `pg_catalog.` out, lowercase. */
function foldChain(raw: string): string {
	return raw
		.replace(/[\s)]+/g, '')
		.toLowerCase()
		.replace(/::pg_catalog\./g, '::');
}
/** The verdict on one placeholder's cast chain + the `CAST(… AS <type>)` tail it may sit in. */
function chainStatesItsType(chain: string, tail: string): boolean {
	if (chain === '') return false; // bare: the type is whatever the context infers
	const steps = chain.split('::').slice(1);
	if (steps.some((step) => JSON_TYPE.test(step))) return SANCTIONED_CHAIN.test(chain);
	const castTo = /^\s*AS\s+(?:pg_catalog\s*\.\s*)?([a-z_]\w*(?:\s*\[\s*\])?)/i.exec(tail);
	if (castTo && JSON_TYPE.test((castTo[1] as string).replace(/\s/g, '').toLowerCase()))
		return chain === '::text' && /^jsonb(?:\[\])?$/i.test((castTo[1] as string).replace(/\s/g, '')); // CAST(<ph>::text AS jsonb)
	return steps.every((step) => SCALAR_TYPES.has(step.replace(/\[\]$/, '')));
}
/**
 * The DML verbs and their TARGET, read the way Postgres does: an optional
 * `ONLY`, an optional `schema.` (quoted or not), the name (quoted or not, or a
 * `${…}` hole). The name is group 1. MERGE's inner `UPDATE SET` names `set` —
 * a keyword, not a table — and is skipped by name.
 */
const DML_TARGET =
	/\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO)\s+(?:ONLY\s+)?(?:"?[a-z_]\w*"?\s*\.\s*)?"?(\$\{[^}]*\}|[a-z_]\w*)"?/gi;
const DML_VERB = /\b(?:UPDATE|INSERT\s+INTO|MERGE\s+INTO)\b/i;
/** A literal that BEGINS with a `${…}` hole and then a matrix target + write clause: the verb is in the hole. */
const HEADLESS_TARGET =
	/^(\s*\$\{[^}]*\}\s+)(?:ONLY\s+)?(?:"?[a-z_]\w*"?\s*\.\s*)?"?matrix\w*"?(?:\s+(?:AS\s+)?[a-z_]\w*)?\s*(?:\([^)]*\)\s*)?(?:SET|VALUES|SELECT|DEFAULT\s+VALUES)\b/i;
const READ_VERB = /\b(?:SELECT|DELETE)\b/i;
/** A statement is matrix-scoped unless a DML verb targets a literal NON-matrix name. */
function isMatrixScopedStatement(statement: string): boolean {
	for (const match of statement.matchAll(DML_TARGET)) {
		const name = (match[1] as string).toLowerCase();
		if (name === 'set') continue; // MERGE … WHEN MATCHED THEN UPDATE SET
		if (name.startsWith('${') || name.includes('matrix')) continue;
		return false;
	}
	return true;
}

/**
 * A verb-less FRAGMENT (an expression built by nesting and spliced into a
 * statement elsewhere — matrix_write.ts's jsonb_set_lax chain) has no SET
 * clause to parse; it is checked in the two positions that are unambiguously
 * WRITE positions, the jsonb_set value and a `||` operand. A fragment
 * `col = <ph>` is indistinguishable from a WHERE predicate (dd_ontology.ts
 * builds both lists the same way) and is NOT checked here — matrix_write.ts's
 * dynamic SET list is proven by matrix_write_roundtrip's byte comparison.
 */
const FRAGMENT_SHAPES: readonly { name: string; pattern: RegExp }[] = [
	{
		name: 'jsonb_set path value <ph>',
		pattern: new RegExp(String.raw`'\{[^']*\}'\s*,\s*(${PLACEHOLDER})${CAST_CHAIN}`, 'gi'),
	},
	{
		name: '|| <ph>',
		pattern: new RegExp(String.raw`\|\|\s*(${PLACEHOLDER})${CAST_CHAIN}`, 'gi'),
	},
];

/**
 * Walk SQL text from `start`, returning the index where the top-level region
 * ends: at a `)` that closes an unopened parenthesis, or (when `keywords` is
 * given) before a top-level keyword. Quoted strings, quoted identifiers and
 * `${…}` holes (nested braces balanced) are opaque.
 */
function scanTopLevel(text: string, start: number, keywords?: RegExp): number {
	let depth = 0;
	let caseDepth = 0; // CASE … END nesting: a WHEN inside it is not MERGE's WHEN
	let index = start;
	while (index < text.length) {
		const char = text[index] as string;
		if (char === "'" || char === '"') {
			const close = text.indexOf(char, index + 1);
			index = close === -1 ? text.length : close + 1;
			continue;
		}
		if (char === '$' && text[index + 1] === '{') {
			index = holeEnd(text, index);
			continue;
		}
		if (char === '(') depth++;
		else if (char === ')') {
			if (depth === 0) return index;
			depth--;
		} else {
			const wordStart = !/\w/.test(text[index - 1] ?? ' ');
			if (wordStart && /^CASE\b/i.test(text.slice(index, index + 5))) caseDepth++;
			else if (wordStart && /^END\b/i.test(text.slice(index, index + 4)))
				caseDepth = Math.max(0, caseDepth - 1);
			else if (depth === 0 && caseDepth === 0 && keywords) {
				keywords.lastIndex = index;
				if (keywords.test(text)) return index;
			}
		}
		index++;
	}
	return index;
}

/** The index just past the `${…}` hole opening at `start` (nested braces balanced). */
function holeEnd(text: string, start: number): number {
	let braces = 1;
	let index = start + 2;
	while (index < text.length && braces > 0) {
		if (text[index] === '{') braces++;
		else if (text[index] === '}') braces--;
		index++;
	}
	return index;
}

/** Split a list on the commas that are NOT inside parentheses / quotes / `${…}` holes. */
function splitTopLevel(list: string): string[] {
	const parts: string[] = [];
	let index = 0;
	let partStart = 0;
	while (index < list.length) {
		const end = scanTopLevel(list, index, /,/y);
		if (end >= list.length) break;
		if (list[end] === ')') {
			index = end + 1; // an unbalanced close: keep scanning
			continue;
		}
		parts.push(list.slice(partStart, end).trim());
		index = end + 1;
		partStart = index;
	}
	const tail = list.slice(partStart).trim();
	if (tail !== '') parts.push(tail);
	return parts;
}

/** The balanced `( … )` groups following `start`, comma-separated (`VALUES (…), (…)`). */
function parenGroups(text: string, start: number): { inner: string; end: number }[] {
	const groups: { inner: string; end: number }[] = [];
	let index = start;
	for (;;) {
		const open = /^\s*\(/.exec(text.slice(index));
		if (open === null) break;
		const innerStart = index + open[0].length;
		const close = scanTopLevel(text, innerStart);
		groups.push({ inner: text.slice(innerStart, close), end: close + 1 });
		index = close + 1;
		const comma = /^\s*,/.exec(text.slice(index));
		if (comma === null) break;
		index += comma[0].length;
	}
	return groups;
}

/** Fold an unquoted column name the way Postgres does; a quoted one is verbatim. */
function foldColumn(raw: string): string {
	const name = raw.trim();
	return name.startsWith('"') ? name.replace(/"/g, '') : name.toLowerCase();
}

/**
 * A column the scanner cannot READ (`${column}`, `${sql('data')}`) is a jsonb
 * column: fail-closed, an interpolated name is whatever the caller passes.
 * NON_JSONB_COLUMN_INTERPOLATIONS enumerates the typed-structural ones.
 */
function isJsonbColumn(column: string): boolean {
	return (
		MATRIX_JSONB_COLUMNS.includes(column as (typeof MATRIX_JSONB_COLUMNS)[number]) ||
		column.startsWith('${')
	);
}

/** A whole list (`${columns}`) or a `.join(`/`.map(` hole: the stated limit, nothing to pair. */
function isListInterpolation(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith('${') || holeEnd(trimmed, 0) !== trimmed.length) return false;
	return /^\$\{[^{}]*\}$/.test(trimmed) || /\.(?:join|map)\s*\(/.test(trimmed);
}

interface ColumnShapedBind {
	shape: string;
	/** The column the bind feeds (folded), `${…}` for an interpolated name. */
	column: string;
	bind: string;
	ok: boolean;
}

/**
 * Every placeholder of ONE expression assigned to a jsonb column, judged. The
 * expression is read with quoted strings / identifiers opaque, so `'{${tipo}}'`
 * is a path and `"${column}"` a column reference, never a bind.
 */
function expressionBinds(shape: string, column: string, expression: string): ColumnShapedBind[] {
	const binds: ColumnShapedBind[] = [];
	let index = 0;
	while (index < expression.length) {
		const char = expression[index] as string;
		if (char === "'" || char === '"') {
			const close = expression.indexOf(char, index + 1);
			index = close === -1 ? expression.length : close + 1;
			continue;
		}
		if (char !== '$') {
			index++;
			continue;
		}
		// `$n`, `$${…}` (a computed index) or a tagged `${…}` hole, braces balanced.
		let found: string | null = null;
		if (/^\$\d+/.test(expression.slice(index)))
			found = (/^\$\d+/.exec(expression.slice(index)) as RegExpExecArray)[0];
		else if (expression.startsWith('$${', index))
			found = expression.slice(index, holeEnd(expression, index + 1));
		else if (expression.startsWith('${', index))
			found = expression.slice(index, holeEnd(expression, index));
		if (found === null) {
			index++;
			continue;
		}
		const before = expression.slice(0, index);
		const after = expression.slice(index + found.length);
		// The cast chain, read through closing parentheses: `($1)::text::jsonb`,
		// `($1::text)::jsonb` and `$1::text::jsonb` are the same chain.
		const chainMatch = new RegExp(String.raw`^((?:\s*(?:${CAST_STEP}|\)))*)`, 'i').exec(
			after,
		) as RegExpExecArray;
		const chain = foldChain(chainMatch[1] as string);
		const tail = after.slice(chainMatch[0].length);
		const toJson = /\b(?:to_jsonb|to_json|row_to_json)\s*\(\s*$/i.test(before);
		const ok = !toJson && chainStatesItsType(chain, tail);
		binds.push({
			shape: `${shape} for ${column}`,
			column,
			bind: `${found}${chainMatch[0]}`.replace(/\s+/g, ' ').trim(),
			ok,
		});
		index += found.length;
	}
	return binds;
}

/** Pair a column list with a value list by position; every jsonb column's slot is an expression to judge. */
function pairedSlots(shape: string, columnList: string, valueList: string): ColumnShapedBind[] {
	if (isListInterpolation(columnList) || isListInterpolation(valueList)) return [];
	const columns = splitTopLevel(columnList).map(foldColumn);
	const values = splitTopLevel(valueList);
	const binds: ColumnShapedBind[] = [];
	for (const [index, column] of columns.entries()) {
		if (!isJsonbColumn(column)) continue;
		const value = values[index] ?? '';
		if (isListInterpolation(value)) continue;
		binds.push(...expressionBinds(shape, column, value));
	}
	return binds;
}

const SET_CLAUSE_END = /\b(?:WHERE|FROM|RETURNING|WHEN)\b/iy;
const INSERT_LIST_END = /\b(?:FROM|WHERE|ON\s+CONFLICT|RETURNING|WHEN)\b/iy;

/** The binds of every SET clause of a statement (UPDATE, MERGE's UPDATE, ON CONFLICT DO UPDATE). */
function setClauseBinds(statement: string): ColumnShapedBind[] {
	const binds: ColumnShapedBind[] = [];
	for (const set of statement.matchAll(/\bSET\b/gi)) {
		const start = (set.index as number) + set[0].length;
		const end = scanTopLevel(statement, start, SET_CLAUSE_END);
		for (const assignment of splitTopLevel(statement.slice(start, end))) {
			const rowForm = /^\(([^)]*)\)\s*=\s*(?:ROW\s*)?\(([\s\S]*)\)\s*$/i.exec(assignment);
			if (rowForm) {
				const columns = rowForm[1] as string;
				const values = rowForm[2] as string;
				if (/^\s*SELECT\b/i.test(values)) {
					// `(a, b) = (SELECT …)`: the subselect feeds every column.
					for (const column of splitTopLevel(columns).map(foldColumn)) {
						if (isJsonbColumn(column))
							binds.push(...expressionBinds('row-form SET subselect', column, values));
					}
				} else binds.push(...pairedSlots('row-form SET slot', columns, values));
				continue;
			}
			const single = /^("?(?:\$\{[^}]*\}|[a-z_]\w*)"?)\s*=\s*([\s\S]+)$/i.exec(assignment);
			if (single === null) continue; // `${setClauses}`: the stated limit
			const column = foldColumn(single[1] as string);
			if (!isJsonbColumn(column)) continue;
			binds.push(...expressionBinds('SET', column, single[2] as string));
		}
	}
	return binds;
}

/** The binds of every INSERT of a statement (`INSERT INTO t`, MERGE's `INSERT`). */
function insertBinds(statement: string): ColumnShapedBind[] {
	const binds: ColumnShapedBind[] = [];
	const insertHead =
		/\bINSERT\s+(?:INTO\s+(?:ONLY\s+)?(?:"?[a-z_]\w*"?\s*\.\s*)?"?(?:\$\{[^}]*\}|[a-z_]\w*)"?\s*)?/gi;
	for (const head of statement.matchAll(insertHead)) {
		let index = (head.index as number) + head[0].length;
		let columns: string | null = null;
		if (/^\s*\(/.test(statement.slice(index))) {
			const [group] = parenGroups(statement, index);
			if (group) {
				columns = group.inner;
				index = group.end;
			}
		}
		const rest = statement.slice(index);
		if (columns === null) {
			if (/^\s*(?:VALUES|SELECT|DEFAULT\s+VALUES)\b/i.test(rest))
				binds.push({
					shape: 'INSERT without a column list (slot order = physical column order, unknowable)',
					column: '*',
					bind: `${head[0]}${rest.slice(0, 24)}`.replace(/\s+/g, ' ').trim(),
					ok: false,
				});
			continue;
		}
		const values = /^\s*VALUES\b/i.exec(rest);
		if (values) {
			for (const row of parenGroups(rest, values[0].length)) {
				binds.push(...pairedSlots('VALUES slot', columns, row.inner));
			}
			continue;
		}
		const select = /^\s*SELECT\s+/i.exec(rest);
		if (select) {
			const listEnd = scanTopLevel(rest, select[0].length, INSERT_LIST_END);
			binds.push(
				...pairedSlots('INSERT…SELECT slot', columns, rest.slice(select[0].length, listEnd)),
			);
		}
	}
	return binds;
}

/**
 * `${…column…}` in column position that the TYPE says is NOT jsonb. The regex
 * cannot see a TypeScript type, so the one such site is enumerated with the
 * type it carries; a stale entry (the file no longer has the shape) is red.
 */
const NON_JSONB_COLUMN_INTERPOLATIONS: Readonly<Record<string, { binds: number; reason: string }>> =
	{
		'src/core/update/transform/tipos.ts': {
			binds: 1,
			reason:
				"renameColumn(): `${column}` is typed `'section_tipo' | 'tipo'` — a structural varchar column; `SET ${column} = $1` binds text, not jsonb (the WHERE predicate is not a write position).",
		},
	};

/** Every placeholder in a jsonb-column write position of ONE literal, with its verdict. */
function columnShapedBinds(literalText: string): ColumnShapedBind[] {
	let statement = normalizeSqlLiteral(literalText);
	if (!isMatrixScopedStatement(statement)) return [];
	// The verb in a hole (`${verb} matrix_test SET …`): the statement without
	// its first word. Any DML head lets the SET / column-list parsers run —
	// which one it was does not change where the write positions are.
	const headless = HEADLESS_TARGET.exec(statement);
	if (headless) statement = `INSERT INTO ${statement.slice(headless[1]?.length ?? 0)}`;
	const isStatement = DML_VERB.test(statement);
	if (!isStatement) {
		if (READ_VERB.test(statement)) return [];
		const binds: ColumnShapedBind[] = [];
		for (const { name, pattern } of FRAGMENT_SHAPES) {
			for (const match of statement.matchAll(pattern)) {
				binds.push({
					shape: name,
					column: '?',
					bind: match[0].replace(/\s+/g, ' '),
					ok: SANCTIONED_CHAIN.test(foldChain(match[2] ?? '')),
				});
			}
		}
		return binds;
	}
	return [...setClauseBinds(statement), ...insertBinds(statement)];
}

describe('GATE-18 — COLUMN-shaped jsonb binds: every placeholder feeding a matrix jsonb column is ::text::jsonb', () => {
	test('no bare / mis-cast placeholder in a jsonb-column write position of any DML statement', () => {
		const violations: string[] = [];
		let checked = 0;
		const exempted = new Map<string, number>();
		for (const file of sourceFiles()) {
			if (BARE_JSONB_BIND_ALLOWLIST.some((prefix) => file.startsWith(prefix))) continue;
			for (const literal of extractSourceLiterals(stripComments(read(file)))) {
				for (const bind of columnShapedBinds(literal.text)) {
					checked++;
					if (bind.ok) continue;
					if (file in NON_JSONB_COLUMN_INTERPOLATIONS && bind.column.startsWith('${')) {
						exempted.set(file, (exempted.get(file) ?? 0) + 1);
						continue;
					}
					violations.push(`${file}:${literal.line} [${bind.shape}] ${bind.bind}`);
				}
			}
		}
		for (const [file, entry] of Object.entries(NON_JSONB_COLUMN_INTERPOLATIONS)) {
			if (exempted.get(file) !== entry.binds)
				violations.push(
					`${file}: NON_JSONB_COLUMN_INTERPOLATIONS says ${entry.binds} typed-structural bind(s), found ${exempted.get(file) ?? 0} — stale or drifted entry`,
				);
		}
		expect(
			violations,
			`A placeholder feeds a matrix jsonb column without stating its type — Bun/Postgres infer jsonb from the context and DOUBLE-encode pre-encoded JSON (S1-07/S1-08). Bind encodeForJsonb(...) as $n::text::jsonb (a scalar inside a built object states its own type, $n::text / $n::int): ${violations.join(', ')}`,
		).toEqual([]);
		// Anti-vacuity: the corpus carries the sanctioned shape in every position
		// (34 judged binds at the floor's setting; a parser that stopped seeing
		// the SET clause or the VALUES rows would pass a list-only test).
		expect(checked).toBeGreaterThanOrEqual(30);
	});

	test('positive controls: every write position flags the bare / mis-cast evasions and passes the sanctioned chain', () => {
		const bad = (statement: string): string[] =>
			columnShapedBinds(statement)
				.filter((bind) => !bind.ok)
				.map((bind) => bind.shape);
		// --- the SET clause, in the spellings the audit's reviewers measured to
		// land a jsonb string scalar through the pool ---
		expect(bad('UPDATE matrix_test SET data = $1 WHERE section_id = $2')).toEqual(['SET for data']);
		expect(bad('UPDATE matrix_test SET "data" = $1::jsonb WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE "${table}" SET "${column}" = ${value} WHERE section_id = ${id}')).toEqual([
			'SET for ${column}',
		]);
		expect(bad('UPDATE "${table}" SET "${columnName}" = $${index + 3} WHERE id = $1')).toEqual([
			'SET for ${columnName}',
		]);
		expect(bad("UPDATE matrix_test SET ${sql('data')} = ${v} WHERE section_id = ${id}")).toEqual([
			"SET for ${sql('data')}",
		]); // a tagged column name the scanner cannot read is a jsonb column (fail-closed)
		expect(bad('UPDATE matrix_test SET data = ($1) WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = ($1::jsonb) WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = CAST($1 AS jsonb) WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('update matrix_test set DATA = $1 where section_id = $2')).toEqual(['SET for data']);
		// The JSON type in every spelling Postgres accepts: `json` (oid 114 —
		// Bun encodes it like 3802, and json→jsonb is an assignment cast, so
		// `data = $1::json` lands the same string scalar), upper-case,
		// `pg_catalog.`-qualified, wrapped, and the CAST(… AS json) form.
		expect(bad('UPDATE matrix_test SET data = $1::json WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = $1::JSON WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = $1::pg_catalog.jsonb WHERE section_id = $2')).toEqual(
			['SET for data'],
		);
		expect(bad('UPDATE matrix_test SET data = ($1::json)::jsonb WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(
			bad('UPDATE matrix_test SET data = CAST($1::text AS json) WHERE section_id = $2'),
		).toEqual(['SET for data']);
		expect(
			bad('UPDATE matrix_test SET data = CAST($1::text AS pg_catalog.jsonb) WHERE section_id = $2'),
		).toEqual([]); // the sanctioned chain, schema-spelled
		expect(bad('INSERT INTO matrix_test (section_tipo, data) VALUES ($1::text, $2::json)')).toEqual(
			['VALUES slot for data'],
		);
		// A type the scanner does not know is not a scalar it can vouch for.
		expect(bad('UPDATE matrix_test SET data = $1::my_domain WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = $1::jsonb[] WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		// SQL comments hide nothing; the verb in a hole is still a statement.
		expect(
			bad('UPDATE /* c */ matrix_test SET data = /* v */ $1 -- x\n WHERE section_id = $2'),
		).toEqual(['SET for data']);
		expect(bad(String.raw`UPDATE\nmatrix_test SET -- c\n data = $1 WHERE section_id = $2`)).toEqual(
			['SET for data'],
		); // the source bytes of a quoted string: `\n` is two characters, one newline at runtime
		expect(bad('UPDATE matrix_test SET -- c\n data = $1 WHERE section_id = $2')).toEqual([
			'SET for data',
		]); // a comment before the assignment would otherwise unshape `col = <expr>`
		expect(bad('INSERT INTO matrix_test /* c */ (section_id, data) VALUES ($1, $2)')).toEqual([
			'VALUES slot for data',
		]); // …or detach the column list from its INSERT
		expect(
			bad('UPDATE matrix_test SET data = $1::text::jsonb -- was $2\n WHERE section_id = $2'),
		).toEqual([]); // a placeholder inside a comment is not a bind
		expect(bad('${verb} matrix_test SET data = $1 WHERE section_id = $2')).toEqual([
			'SET for data',
		]);
		expect(bad('${verb} matrix_test (section_id, data) VALUES ($1, $2)')).toEqual([
			'VALUES slot for data',
		]);
		expect(
			bad("UPDATE matrix_test SET data = jsonb_set(data, '{test1}', $3) WHERE id = $1"),
		).toEqual(['SET for data']);
		expect(
			bad(
				"UPDATE matrix_test SET data = jsonb_set(data, '{test1}', COALESCE(data->'test1', '[]'::jsonb) || $3::jsonb)",
			),
		).toEqual(['SET for data']);
		// The context-inferred positions no catalogue of shapes listed: a bound
		// jsonb_set path with a bare value, CASE, a subselect, COALESCE, to_jsonb.
		expect(bad('UPDATE matrix_test SET data = jsonb_set(data, $3, $2) WHERE id = $1')).toEqual([
			'SET for data',
			'SET for data',
		]);
		expect(
			bad('UPDATE matrix_test SET data = CASE WHEN $3 THEN $2 ELSE data END WHERE id = $1'),
		).toEqual(['SET for data', 'SET for data']);
		expect(bad('UPDATE matrix_test SET data = (SELECT $2) WHERE id = $1')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = COALESCE(data, $2) WHERE id = $1')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET data = to_jsonb($2::text) WHERE id = $1')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE matrix_test SET relation = relation || to_jsonb($2) WHERE id = $1')).toEqual(
			['SET for relation'],
		);
		// Row forms: a list, ROW(), a subselect.
		expect(bad('UPDATE matrix_test SET (data, relation) = ($1, $2) WHERE section_id = $3')).toEqual(
			['row-form SET slot for data', 'row-form SET slot for relation'],
		);
		expect(bad('UPDATE matrix_test SET (data) = ROW($2) WHERE section_id = $1')).toEqual([
			'row-form SET slot for data',
		]);
		expect(
			bad('UPDATE matrix_test SET (data, relation) = (SELECT $2, $3) WHERE section_id = $1'),
		).toEqual([
			'row-form SET subselect for data',
			'row-form SET subselect for data',
			'row-form SET subselect for relation',
			'row-form SET subselect for relation',
		]); // both binds feed both columns (fail-closed)
		// The target spellings Postgres treats as the same table: ONLY, schema-qualified, MERGE.
		expect(bad('UPDATE ONLY matrix_test SET data = $2 WHERE section_id = $1')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE public.matrix_test SET data = $2 WHERE section_id = $1')).toEqual([
			'SET for data',
		]);
		expect(bad('UPDATE "public"."matrix_test" SET data = $2 WHERE section_id = $1')).toEqual([
			'SET for data',
		]);
		expect(
			bad(
				'MERGE INTO matrix_test t USING (SELECT $1::int AS sid) s ON t.section_id = s.sid WHEN MATCHED THEN UPDATE SET data = $2 WHEN NOT MATCHED THEN INSERT (section_id, data) VALUES ($1, $2)',
			),
		).toEqual(['SET for data', 'VALUES slot for data']);
		expect(
			bad(
				'MERGE INTO matrix_test t USING (SELECT $1::int AS sid) s ON t.section_id = s.sid WHEN NOT MATCHED THEN INSERT (section_id, data) VALUES ($1, $2)',
			),
		).toEqual(['VALUES slot for data']); // an insert-only MERGE is a statement too
		// --- INSERT: every VALUES row, the SELECT list, the column-less form ---
		expect(
			bad('INSERT INTO matrix_test (section_id, section_tipo, data) VALUES ($1, $2, $3::jsonb)'),
		).toEqual(['VALUES slot for data']);
		expect(
			bad('INSERT INTO matrix_test (section_id, section_tipo, "relation") VALUES ($1, $2, $3)'),
		).toEqual(['VALUES slot for relation']);
		expect(
			bad(
				"INSERT INTO matrix_test (section_id, data) VALUES ($1, $2::text::jsonb), ($3, $4), ($5, jsonb_build_object('a', $6))",
			),
		).toEqual(['VALUES slot for data', 'VALUES slot for data']); // rows 2 and 3
		expect(
			bad('INSERT INTO matrix_test (section_id, section_tipo, data) SELECT $1, $2, $3'),
		).toEqual(['INSERT…SELECT slot for data']);
		expect(
			bad(
				"INSERT INTO matrix_test (section_id, data) SELECT $1, jsonb_build_object('a', $2) FROM matrix_x",
			),
		).toEqual(['INSERT…SELECT slot for data']); // a bare scalar inside a built object states no type
		expect(bad('INSERT INTO matrix_test VALUES ($1, $2, $3::text::jsonb)')).toEqual([
			'INSERT without a column list (slot order = physical column order, unknowable)',
		]);
		expect(bad('INSERT INTO "${table}" SELECT * FROM dd_import_stage')).toEqual([
			'INSERT without a column list (slot order = physical column order, unknowable)',
		]);
		expect(bad('INSERT INTO public.matrix_test (section_id, data) VALUES ($1, $2)')).toEqual([
			'VALUES slot for data',
		]);
		// --- the sanctioned chain passes in every spelling and position ---
		expect(bad('UPDATE matrix_test SET data = ($1::text::jsonb)')).toEqual([]);
		expect(bad('UPDATE matrix_test SET data = ($1)::text::jsonb')).toEqual([]);
		expect(bad('UPDATE matrix_test SET data = ($1::text)::jsonb')).toEqual([]);
		expect(bad('UPDATE matrix_test SET data = CAST($1::text AS jsonb)')).toEqual([]);
		expect(bad('UPDATE matrix_test SET (data, section_tipo) = ($1::text::jsonb, $2)')).toEqual([]);
		expect(
			bad('INSERT INTO matrix_test (section_id, "Data") SELECT $1, $2::text::jsonb FROM x'),
		).toEqual([]); // a QUOTED mixed-case name is a different column (none exists)
		expect(bad('INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM "${source}"')).toEqual(
			[],
		); // a whole-list interpolation is the stated limit (matrix_write's dynamic lists)
		expect(
			bad(
				'INSERT INTO "${t}" (section_tipo, ${columns.map((c) => `"${c}"`).join(\', \')}) VALUES ($1, ${placeholders.join(\', \')})',
			),
		).toEqual([]); // a `.join(` slot is a list, not a bind (stated limit)
		expect(
			bad('UPDATE matrix_test SET data = $1::text::jsonb, section_tipo = $2 WHERE section_id = $3'),
		).toEqual([]);
		expect(
			bad(
				"UPDATE matrix_test SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{test1}', $3::text::jsonb)",
			),
		).toEqual([]);
		expect(
			bad(
				'INSERT INTO matrix_test (section_id, section_tipo, data) VALUES ($1, $2, $3::text::jsonb)',
			),
		).toEqual([]);
		expect(bad('UPDATE "${table}" SET "${column}" = ${value}::text::jsonb')).toEqual([]);
		expect(
			bad(
				'UPDATE matrix_test SET data = $1::pg_catalog.text::pg_catalog.jsonb WHERE section_id = $2',
			),
		).toEqual([]);
		expect(bad('${verb} matrix_test SET data = $1::text::jsonb WHERE section_id = $2')).toEqual([]);
		// The scalar types a bind may state, including the two-word spellings.
		expect(
			bad(
				"UPDATE matrix_test SET data = jsonb_build_object('a', $1::double precision, 'b', $2::character varying, 'c', $3::bigint[], 'd', $4::timestamptz) WHERE section_id = $5",
			),
		).toEqual([]);
		// A scalar that STATES its type inside a built object / path is not a jsonb bind…
		expect(
			bad(
				"UPDATE matrix_test SET relation = jsonb_set(relation, '{a,0}', (relation->'a'->0) || jsonb_build_object('k', $2::int)) WHERE section_id = $1",
			),
		).toEqual([]);
		expect(
			bad(
				'UPDATE "${table}" SET "${column}" = jsonb_set("${column}" #- ARRAY[$1::text, $2::text], ARRAY[$1::text, $3::text], "${column}" -> $1::text -> $2::text) WHERE x',
			),
		).toEqual([]);
		// …and a hole inside a quoted path / identifier is never a bind.
		expect(
			bad(
				"UPDATE \"${tableName}\" SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{${componentTipo}}', jsonb_build_array(jsonb_build_object('count', COALESCE((meta->'${componentTipo}'->0->>'count')::int, 0) + 1))) WHERE section_id = $2",
			),
		).toEqual([]);
		// The WHERE predicate is not a write position; the ON CONFLICT SET is.
		expect(bad('UPDATE matrix_test SET section_tipo = $1 WHERE data = $2')).toEqual([]);
		expect(
			bad(
				'INSERT INTO matrix_test (section_id, data) VALUES ($1, $2::text::jsonb) ON CONFLICT (section_id) DO UPDATE SET data = $2',
			),
		).toEqual(['SET for data']);
		// Non-matrix targets are the cast matcher's business, not this one's.
		expect(columnShapedBinds('UPDATE dedalo_ts_x SET data = $1')).toEqual([]);
		expect(columnShapedBinds('INSERT INTO dd_ontology (data) VALUES ($1)')).toEqual([]);
		// A verb-less FRAGMENT is checked in the two unambiguous write positions…
		expect(
			bad(
				"jsonb_set_lax(COALESCE(${expression}, '{}'::jsonb), '{${write.key}}', $${parameters.length}, true, 'delete_key')",
			),
		).toEqual(['jsonb_set path value <ph>']);
		expect(bad("COALESCE(data->'x', '[]'::jsonb) || $3")).toEqual(['|| <ph>']);
		// …and NOT in the `col = <ph>` position (a WHERE predicate looks the same; stated limit).
		expect(bad('"${columnName}" = $${index + 3}')).toEqual([]);
		// A read is never a bind of interest.
		expect(bad('SELECT relation || $1 FROM matrix_test WHERE data = $2')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. Locator-law ratchet (inline section_id comparisons).
// ---------------------------------------------------------------------------

/**
 * Files still running hand-rolled section_id equality (census 2026-07-07,
 * audit S2-04's ≥6-matcher inventory plus the comment-level echoes the
 * patterns also catch). RATCHET: only shrink. Migrate each site onto
 * concepts/locator.ts (compareLocators / isLocatorInArray) behind its parity
 * gate, then delete the entry.
 */
const INLINE_SECTION_ID_MATCH_RATCHET = new Set<string>([
	// WS-C S2-25: dispatch.ts's comment-level echoes of the client matcher moved
	// with the extracted handler bodies (comments only — no inline matcher code).
	'src/core/api/handlers/dd_core_api.ts',
	'src/core/section/read_facade.ts',
	'src/core/area/tree.ts',
	'src/core/ontology/parser.ts',
	'src/core/relations/children.ts',
	// datalist.ts, filter_projects.ts, tool_import_files/server/index.ts:
	// migrated onto compareLocators — entries retired 2026-07-07 (the staleness
	// self-test below now enforces this pruning mechanically). relations/parent.ts:
	// retired 2026-10-11 (CORE-3/ONT-5 — node + link identity via compareLocators).
	'src/core/relations/select_lang.ts',
	'src/core/ontology/hierarchy_provision.ts',
	// info_widgets.ts split into widgets/<tld>/ modules (Phase 1, 2026-07-10):
	// the PHP-verbatim '2' sentinel + strict thesaurus matchers and the
	// 'current'/'self' IPO sentinel checks moved with their widgets (net zero
	// — same code, new homes; the one info_widgets.ts entry became these five).
	// calculation.ts retired 2026-11-12 (T1-1): the scope check reads a local.
	// numisdata/get_archive_weights.ts + get_coins_by_period.ts retired
	// 2026-11-12 (T1-11): flag + term/tree/parent matching via compareLocators
	// (widget_common isFlagSet) — WC-2026-11-12-numisdata-widgets-locator-law.
	'src/core/components/component_info/widgets/oh/media_icons.ts',
	'src/core/components/component_info/widgets/state/state.ts',
	// SHRUNK 2026-09-05 (PERF-07): the two search builders' entries are GONE.
	// Both existed for one SQL text — `AND m2.section_id != <alias>.section_id`,
	// the correlated `'!!'` dedup self-join's column-to-column comparison — and
	// that self-join was replaced by an uncorrelated group-once aggregate, so
	// the text no longer exists to exempt. A ratchet entry outlives its code
	// only as debt; this is the shrink.
	'src/core/section/locks.ts', // lock-triple key equality (documented non-locator use)
	// Documented NON-LOCATOR use (2026-07-11, first green hermetic run): seed.ts's
	// `record.section_id === CLONE_SOURCE_ID` matches a CanonicalRecord inside the
	// in-memory test3 fixture, where section_id is a TYPED `number` (CanonicalRecord
	// = { section_id: number } & …) compared against the numeric const CLONE_SOURCE_ID.
	// There is no locator here — no section_tipo/component_tipo/type quad — so
	// compareLocators is inapplicable, and the loose-numeric hazard the law exists for
	// ('05' vs 5, a DB-stored string) cannot arise on a typed number. The regex simply
	// cannot see the type. NOT an upward extension of the inline-matcher debt.
	'src/core/test_data/seed.ts',
	'src/core/section/read.ts',
	'src/core/security/auth.ts',
	'src/core/tools/register.ts', // radio-button truthy check (dd64/1), not locator matching
	'src/core/tools/registry.ts', // radio-button truthy check (dd64/1), not locator matching
	'src/core/ts_object/node_repository.ts',
	'src/diffusion/resolve/resolver.ts',
	'tools/tool_propagate_component_data/server/propagate.ts',
	'tools/tool_time_machine/server/tool_time_machine.ts',
	// scripts/ entered the census 2026-09-02 (P2-20/S-3, shared write-path
	// corpus). Two hits, neither an upward extension of the locator debt:
	// clone_into_test_tld.ts: `Number(items[0].section_id) === 1` reads a
	// yes/no radio (dd64-style 1/0 value, same shape as tools/register.ts) — a
	// boolean, not a locator match.
	'scripts/clone_into_test_tld.ts',
	// migrate_component_alias.ts: `String(modelLocator?.section_id) === '164'`
	// recognizes the component_alias MODEL locator (dd0/164) on an
	// install-specific (numisdata) one-off migration that is never run by the
	// engine; derive_test_corpus.ts's real locator dedup was migrated onto
	// compareLocators in the same change instead of being listed.
	'scripts/migrate_component_alias.ts',
]);

/**
 * Inline matcher shapes: (a) `.section_id` compared with an equality operator
 * against anything but a null/undefined presence check; (b) String()/Number()
 * coercions of a section_id compared strictly.
 */
/*
 * A `typeof x.section_id !== 'string'` TYPE GUARD is not a matcher either: its
 * right-hand side is a typeof result name, never a section_id VALUE, so it
 * cannot express the loose-numeric law this ratchet protects ('05' matching 5).
 * The legacy-shape identifier in component_info/widgets/widget_common.ts is one
 * of these, and counting it would have meant extending the ratchet upward for a
 * file that never compares a locator at all.
 */
const TYPEOF_RESULT = '(?:string|number|object|undefined|boolean|bigint|symbol|function)';
const INLINE_PATTERNS: readonly RegExp[] = [
	// Presence/emptiness checks (null / undefined / '') are NOT matchers.
	new RegExp(
		String.raw`\.section_id\s*(?:===|!==|==|!=)(?!=)\s*(?=\S)(?!null\b|undefined\b|''|"")(?!'${TYPEOF_RESULT}')(?!"${TYPEOF_RESULT}")`,
	),
	/(?:String|Number)\([^)\n]*section_id[^)\n]*\)\s*(?:===|!==)/,
];

describe('S2-04/DEC-21 — locator-law ratchet: no NEW inline section_id matcher', () => {
	test('files with inline section_id equality only shrink', () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			if (file === 'src/core/concepts/locator.ts') continue; // the law itself
			const content = read(file);
			if (!content.includes('section_id')) continue;
			if (!INLINE_PATTERNS.some((pattern) => pattern.test(content))) continue;
			if (INLINE_SECTION_ID_MATCH_RATCHET.has(file)) continue;
			violations.push(file);
		}
		expect(
			violations,
			`New inline section_id comparison. Use compareLocators/isLocatorInArray from src/core/concepts/locator.ts (PHP-exact 4-property law; loose-numeric section_id — stored '05' matches 5, inline === does not). Do NOT extend the ratchet upward: ${violations.join(', ')}`,
		).toEqual([]);
	});

	test('ratchet stays honest — no stale entries for files that no longer match (staleness self-test)', () => {
		// Same posture as module_state_tripwire's allowlist self-tests: a stale
		// entry makes the ratchet look stricter than it is (a migrated file could
		// regress back to inline matchers without any diff review noticing). A
		// deleted/moved file is stale too.
		const stale = [...INLINE_SECTION_ID_MATCH_RATCHET].filter((file) => {
			try {
				const content = read(file);
				return (
					!content.includes('section_id') ||
					!INLINE_PATTERNS.some((pattern) => pattern.test(content))
				);
			} catch {
				return true; // file deleted or moved
			}
		});
		expect(
			stale,
			`Stale INLINE_SECTION_ID_MATCH_RATCHET entries — these files no longer contain an inline section_id matcher; delete their entries (the ratchet must match reality): ${stale.join(', ')}`,
		).toEqual([]);
	});
});
