/**
 * Time Machine component-search conformer — the dd15 twin of the standard
 * search builders (src/core/search/builders), for the flat matrix_time_machine
 * table whose components map to PHYSICAL SCALAR COLUMNS rather than tipo-keyed
 * jsonb. This is the TS port of PHP's `search_tm` + the five `trait.search_*_tm`
 * traits (component_{number,date,string_common,relation_common,json}_tm).
 *
 * The dd15 virtual section exposes seven column-components; each maps to a
 * physical column of matrix_time_machine and a comparison KIND:
 *
 *   Id           dd1573 → id              number
 *   When         dd559  → "timestamp"     date
 *   Who          dd578  → user_id         relation (scalar user id)
 *   Section tipo dd1772 → section_tipo    string (scalar varchar)
 *   Section id   dd1212 → section_id      number
 *   Process      dd1371 → bulk_process_id number
 *   Value        dd1574 → data            json (CAST-to-text contains)
 *   (tipo)       dd577  → tipo            string  (also the record-snapshot key)
 *
 * Before this, buildTmWhere ignored every component clause and returned ALL
 * rows (Time Machine search silently did nothing). Emits direct-column SQL with
 * `$N` positional params (matrix_time_machine has no per-type jsonb column, so
 * the jsonb-path builders do not apply). Operators mirror the `_tm` traits;
 * date directional operators follow WC-036 (the whole-period span semantics).
 *
 * SECURITY: column names come only from the fixed TM_FILTER_COLUMNS map (never
 * client input); every comparison VALUE travels as a bound `$N` parameter.
 */

import { isReferencedByLeaf } from '../concepts/sqo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	type NormalizedDate,
	normalizeDateQ,
	timeMachineDatePredicates,
} from '../search/builders/builder_date.ts';
import { TM_COLUMN_MATRIX_ID } from '../tm_record/tm_record.ts';

/** How a dd15 column-component compares (its physical column + value kind). */
interface TmColumn {
	/** Physical matrix_time_machine column (already SQL-safe; quoted where needed). */
	column: string;
	kind: 'number' | 'date' | 'string' | 'json' | 'relation';
}

/** dd15 column-component tipo → physical column + kind (PHP DEDALO_TIME_MACHINE_COLUMN_*). */
const TM_FILTER_COLUMNS: Readonly<Record<string, TmColumn>> = {
	[TM_COLUMN_MATRIX_ID]: { column: 'id', kind: 'number' }, // dd1573 Id = the TM row PK
	dd1212: { column: 'section_id', kind: 'number' },
	dd1371: { column: 'bulk_process_id', kind: 'number' },
	dd559: { column: '"timestamp"', kind: 'date' },
	dd578: { column: 'user_id', kind: 'relation' },
	dd577: { column: 'tipo', kind: 'string' },
	dd1772: { column: 'section_tipo', kind: 'string' },
	dd1574: { column: 'data', kind: 'json' },
};

const BOOLEAN_OPERATORS: ReadonlySet<string> = new Set(['$and', '$or', '$not', '$nand', '$nor']);

/** Mutable positional-parameter accumulator (buildTmWhere's `$N` convention). */
export interface ParamSink {
	params: unknown[];
	/**
	 * Set when any emitted leaf is a RANGE comparison (`>`, `>=`, `<`, `<=`) as
	 * opposed to equality / IS NULL / ILIKE. read_tm.ts reads this to decide
	 * whether the page query needs the optimisation barrier: a range predicate
	 * combined with the `id` sort has NO index that carries both, and the planner
	 * then walks the `id` PK filtering inline — which is catastrophic exactly when
	 * the filtered column CORRELATES with id. On this append-only log `timestamp`
	 * correlates almost perfectly, so a 2026 date search discarded 45,992,453 PK
	 * entries to return 10 rows (48.9 s). Equality leaves are NOT flagged: their
	 * column's `(col, id DESC)` index carries the equality AND the id order, and
	 * they are already 2.6 ms — barriering those would make them ~170x slower.
	 */
	rangePredicate?: boolean;
}

/** Register a value, return its `$N` placeholder. */
function bind(sink: ParamSink, value: unknown): string {
	sink.params.push(value);
	return `$${sink.params.length}`;
}

/** SQL comparison operators that select a RANGE rather than a point. */
const RANGE_OPERATORS: ReadonlySet<string> = new Set(['>', '>=', '<', '<=']);

/** Flag the sink when `cmp` is a range comparison (see ParamSink.rangePredicate). */
function markRange(sink: ParamSink, cmp: string): void {
	if (RANGE_OPERATORS.has(cmp)) sink.rangePredicate = true;
}

/** Unwrap the SQO q shape to its first scalar/object (array → [0], strip UI id). */
function firstQ(q: unknown): unknown {
	let value = Array.isArray(q) ? q[0] : q;
	if (value !== null && typeof value === 'object' && 'value' in (value as object)) {
		value = (value as { value: unknown }).value;
	}
	return value;
}

/** A LIKE pattern that matches q as a substring; q's own %/_ act as wildcards (PHP parity). */
function containsPattern(q: string): string {
	return `%${q}%`;
}

function emitNumber(col: string, rawQ: unknown, operator: string, sink: ParamSink): string | null {
	if (operator === '!*') return `${col} IS NULL`;
	if (operator === '*') return `${col} IS NOT NULL`;
	let text = String(firstQ(rawQ) ?? '').trim();
	if (text === '') return operator === '' ? null : `${col} IS NOT NULL`;
	// An operator may arrive glued to the value (e.g. '>=5').
	let cmp = operator;
	const inline = /^(>=|<=|!=|>|<|=)/.exec(text);
	if (cmp === '' && inline !== null) {
		cmp = inline[1] as string;
		text = text.slice(cmp.length).trim();
	}
	const n = Number(text);
	if (!Number.isFinite(n)) return '1=0'; // non-numeric input can never match (PHP parity)
	const sqlOp =
		cmp === '>='
			? '>='
			: cmp === '<='
				? '<='
				: cmp === '>'
					? '>'
					: cmp === '<'
						? '<'
						: cmp === '!='
							? '!='
							: '=';
	markRange(sink, sqlOp);
	return `${col} ${sqlOp} ${bind(sink, Math.trunc(n))}`;
}

function emitDate(col: string, rawQ: unknown, operator: string, sink: ParamSink): string | null {
	if (operator === '!*') return `${col} IS NULL`;
	if (operator === '*') return `${col} IS NOT NULL`;
	const date: NormalizedDate | null = normalizeDateQ(rawQ);
	if (date === null) return null;
	const effectiveOperator = date.op !== '' ? date.op : operator;
	const predicates = timeMachineDatePredicates(date, effectiveOperator);
	// A yearless q (e.g. `{start:{hour:14}}` typed into the dd559 "When" field)
	// has no expression on a timestamptz column — timeMachineDatePredicates
	// returns null and the clause is DROPPED, the same contract builder_date.ts
	// applies on the matrix_activity path. leaf.q reaches here straight from the
	// client SQO, so anything else here is a 500 from ordinary user input.
	if (predicates === null) return null;
	const parts = predicates.map((predicate) => {
		// Every date match is a range — even "on this day" is `>= d AND < d+1`.
		markRange(sink, predicate.cmp);
		return `${col} ${predicate.cmp} ${bind(sink, predicate.bound)}::date`;
	});
	return parts.length > 1 ? `(${parts.join(' AND ')})` : (parts[0] as string);
}

/** Scalar varchar columns (tipo, section_tipo): exact by default, ILIKE for wildcards. */
function emitString(col: string, rawQ: unknown, operator: string, sink: ParamSink): string | null {
	if (operator === '!*') return `(${col} IS NULL OR ${col} = '')`;
	if (operator === '*') return `(${col} IS NOT NULL AND ${col} != '')`;
	const text = String(firstQ(rawQ) ?? '');
	const effective = operator !== '' ? operator + text : text;
	if (effective === '') return null;
	if (effective.startsWith('==')) return `${col} = ${bind(sink, effective.slice(2))}`;
	// '!=' / '-' → not-contains (PHP resolve_different / not_contain _tm).
	if (effective.startsWith('!=') || effective.startsWith('-')) {
		const q = (effective.startsWith('!=') ? effective.slice(2) : effective.slice(1)).replaceAll(
			'*',
			'',
		);
		return `${col} NOT ILIKE ${bind(sink, containsPattern(q))}`;
	}
	const hasLead = effective.startsWith('*');
	const hasTrail = effective.endsWith('*');
	if (hasLead || hasTrail) {
		const q = effective.replaceAll('*', '');
		const pattern = hasLead && hasTrail ? `%${q}%` : hasLead ? `%${q}` : `${q}%`;
		return `${col} ILIKE ${bind(sink, pattern)}`;
	}
	if (effective.length >= 2 && effective.startsWith("'") && effective.endsWith("'")) {
		return `${col} = ${bind(sink, effective.slice(1, -1))}`;
	}
	// Default: exact equality (PHP scalar-column default — avoids full scans on
	// the tipo/section_tipo code columns).
	return `${col} = ${bind(sink, effective)}`;
}

/** The `data` jsonb column (Value): compared as its text projection. */
function emitJson(col: string, rawQ: unknown, operator: string, sink: ParamSink): string | null {
	const text = `CAST(${col} AS text)`;
	if (operator === '!*') return `${col} IS NULL`;
	if (operator === '*') return `${col} IS NOT NULL`;
	const q = String(firstQ(rawQ) ?? '');
	const effective = operator !== '' ? operator + q : q;
	if (effective === '') return null;
	if (effective.startsWith('==')) return `${text} ILIKE ${bind(sink, effective.slice(2))}`;
	if (effective.startsWith('!=') || effective.startsWith('-')) {
		const inner = (effective.startsWith('!=') ? effective.slice(2) : effective.slice(1)).replaceAll(
			'*',
			'',
		);
		return `${text} NOT ILIKE ${bind(sink, containsPattern(inner))}`;
	}
	const hasLead = effective.startsWith('*');
	const hasTrail = effective.endsWith('*');
	if (hasLead || hasTrail) {
		const inner = effective.replaceAll('*', '');
		const pattern = hasLead && hasTrail ? `%${inner}%` : hasLead ? `%${inner}` : `${inner}%`;
		return `${text} ILIKE ${bind(sink, pattern)}`;
	}
	// Default: contains.
	return `${text} ILIKE ${bind(sink, containsPattern(effective))}`;
}

/** user_id scalar column (Who): a portal locator's section_id, or a bare id. */
function emitRelation(
	col: string,
	rawQ: unknown,
	operator: string,
	sink: ParamSink,
): string | null {
	if (operator === '!*') return `${col} IS NULL`;
	if (operator === '*') return `${col} IS NOT NULL`;
	const value = firstQ(rawQ);
	const id =
		value !== null && typeof value === 'object' && 'section_id' in (value as object)
			? (value as { section_id: unknown }).section_id
			: value;
	if (id === undefined || id === null || String(id) === '') return null;
	const sqlOp = operator === '!=' || operator === '!==' ? '!=' : '=';
	return `${col} ${sqlOp} ${bind(sink, String(id))}`;
}

/** Conform ONE leaf (a component path clause) to TM column SQL, or null to drop it. */
function emitLeaf(leaf: Record<string, unknown>, sink: ParamSink): string | null {
	const path = Array.isArray(leaf.path) ? (leaf.path as { component_tipo?: string }[]) : [];
	const componentTipo = path[path.length - 1]?.component_tipo;
	if (componentTipo === undefined) return null;
	const target = TM_FILTER_COLUMNS[componentTipo];
	if (target === undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `time machine search: component '${componentTipo}' has no matrix_time_machine column (uncovered — ledger, never silently narrowed)`,
			coordinates: { tipo: componentTipo },
		});
	}
	const operator = typeof leaf.q_operator === 'string' ? leaf.q_operator : '';
	switch (target.kind) {
		case 'number':
			return emitNumber(target.column, leaf.q, operator, sink);
		case 'date':
			return emitDate(target.column, leaf.q, operator, sink);
		case 'string':
			return emitString(target.column, leaf.q, operator, sink);
		case 'json':
			return emitJson(target.column, leaf.q, operator, sink);
		case 'relation':
			return emitRelation(target.column, leaf.q, operator, sink);
	}
}

/**
 * The Time Machine refusal of a `referenced_by` leaf
 * (WC-2026-10-30-search-referenced-by-leaf). The leaf compiles to a predicate
 * over T's SCOPED MATRIX ROW SET — `(section_tipo, section_id) IN (<the targets
 * stored in the source rows' relation column>)`, evaluated against T's matrix
 * rows under T's own WHERE (sql_assembler buildScopedRowSetSql). The Time
 * Machine conformer works over the flat matrix_time_machine log, whose rows are
 * snapshots, not T's record rows: that predicate has no form here. Pathless, the
 * leaf would fall into the drop below and WIDEN the list — so it refuses loudly
 * instead. `engine.uncovered_scope`, not
 * `request.invalid_options`: the leaf is VALID input (sanitizeClientSqo accepts
 * it for any section); what is missing is engine scope on this table — the same
 * code as the unmapped-component refusal in emitLeaf.
 */
function refuseReferencedBy(): never {
	throw new DedaloError('engine.uncovered_scope', {
		message:
			'time machine search: a referenced_by filter leaf has no matrix_time_machine form (uncovered — ledger, never silently widened)',
	});
}

/**
 * Throw when ANY node of a TM read's sqo.filter is a `referenced_by` leaf.
 * buildTmWhere calls it FIRST, because its locator and tipo-column surfaces never
 * reach conformTmFilter — a leaf there would vanish just the same.
 */
export function assertNoTmReferencedBy(filter: unknown): void {
	if (filter === null || typeof filter !== 'object') return;
	if (isReferencedByLeaf(filter)) refuseReferencedBy();
	for (const child of filterChildren(filter)) assertNoTmReferencedBy(child);
}

/** A filter object's child nodes, in walk order: an array's items, else each boolean operator's items. */
function filterChildren(filter: object): unknown[] {
	if (Array.isArray(filter)) return filter;
	const children: unknown[] = [];
	for (const key of BOOLEAN_OPERATORS) {
		const items = (filter as Record<string, unknown>)[key];
		if (Array.isArray(items)) children.push(...items);
	}
	return children;
}

/** One boolean-operator node's conformed parts joined under its operator (null when none). */
function joinTmGroup(opKey: string, parts: readonly string[]): string | null {
	if (parts.length === 0) return null;
	if (opKey === '$or') return `(${parts.join(' OR ')})`;
	if (opKey === '$not' || opKey === '$nand') return `NOT (${parts.join(' AND ')})`;
	if (opKey === '$nor') return `NOT (${parts.join(' OR ')})`;
	return `(${parts.join(' AND ')})`;
}

/**
 * Conform a dd15 sqo.filter tree into a matrix_time_machine WHERE fragment.
 * Returns null when the filter carries no component clause this conformer models
 * (e.g. only the `tipo` COLUMN filter, handled by buildTmWhere's record-snapshot
 * path, or `filter_by_locators`). Column-name/format:'column' leaves are skipped
 * here (they are not component-path searches).
 */
export function conformTmFilter(filter: unknown, sink: ParamSink): string | null {
	if (filter === null || typeof filter !== 'object') return null;
	if (isReferencedByLeaf(filter)) refuseReferencedBy();
	const node = filter as Record<string, unknown>;

	const opKey = Object.keys(node).find((key) => BOOLEAN_OPERATORS.has(key));
	if (opKey !== undefined) {
		const rawItems = Array.isArray(node[opKey]) ? (node[opKey] as unknown[]) : [];
		const parts = rawItems
			.map((item) => conformTmFilter(item, sink))
			.filter((part): part is string => part !== null && part !== '');
		return joinTmGroup(opKey, parts);
	}

	// A leaf: a component-path clause conforms; a column_name/format clause is
	// not a component search and is left to buildTmWhere's other surfaces.
	if ('path' in node && !('column_name' in node)) {
		return emitLeaf(node, sink);
	}
	return null;
}
