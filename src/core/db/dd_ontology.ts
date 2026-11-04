/**
 * dd_ontology write/read layer — the TS port of PHP
 * core/db/class.dd_ontology_db_manager.php.
 *
 * dd_ontology is the ACTIVE runtime table every engine resolves against (see
 * ontology/resolver.ts, which owns the cached READ registry). This module owns
 * the WRITE side plus the raw-row read and search primitives the ontology
 * pipeline needs — mirroring the PHP data-access class byte-for-byte:
 *
 *  - a fixed 13-column allowlist (no dynamic column injection);
 *  - jsonb columns (term / relations / properties) bound as `$n::text::jsonb`
 *    (the Bun double-encode gotcha — see db/matrix_write.ts header);
 *  - `order_number` is int, `propiedades` is TEXT (never jsonb — v6 legacy),
 *    is_model / is_translatable / is_main are booleans;
 *  - `upsertDdOntologyNode` = whole-row INSERT … ON CONFLICT(tipo) DO UPDATE
 *    writing EVERY column, so a cleared matrix component nulls its dd_ontology
 *    column on re-parse (parity with PHP create()'s full-shape upsert);
 *  - `updateDdOntologyColumns` = partial SET of an EXISTING row; an absent tipo
 *    answers false and writes nothing (SURF-1 deleted PHP update()'s INSERT
 *    fallback: it planted a partial row — no tld, no model — for any tipo it
 *    was handed, and its one caller, the sync_order path, already skips
 *    absent rows);
 *  - every INSERT door first heals a lagging id sequence
 *    (`alignDdOntologyIdSequence`): `ON CONFLICT (tipo)` does not cover the pkey.
 *  (The PHP backup-table protocol, dd_ontology_bk, is gone: regenerate is ONE
 *  transaction — ontology_state.ts rebuildOntology — so it had no caller.)
 *
 * THE IDENTIFIER GRAMMAR (SURF-1). `tipo`, `parent`, `model_tipo`, `tld` and
 * `properties.alias_of` are read back as IDENTIFIERS — the search engine
 * interpolates them into JSONB paths and SQL, tree walks follow `parent`, model
 * lookups join `model_tipo`. So they obey one grammar, stated THREE times that
 * must agree (gate: test/unit/dd_ontology_identifier_grammar_native.test.ts,
 * a hand-written truth table checked against all three):
 *   1. `ddOntologyIdentifierViolations` below — the pure TS predicate;
 *   2. the write doors here (`upsertDdOntologyNode`, `updateDdOntologyColumns`)
 *      and the archive restore plan run it BEFORE any SQL and refuse
 *      `ontology.invalid_node`;
 *   3. the six CHECK constraints of migration
 *      `0013_dd_ontology_identifier_grammar.sql` (`DD_ONTOLOGY_GRAMMAR_CONSTRAINTS`):
 *        tipo        letters+digits (TIPO_PATTERN), <= 32 chars
 *        parent      NULL, or the tipo grammar, <= 32
 *        model_tipo  NULL, or the tipo grammar, <= 8 (varchar(8))
 *        tld         NULL, or two-or-more letters (TLD_PATTERN), <= 32
 *        tipo_in_tld NULL tld, or the tipo's letter prefix IS the tld
 *        alias_of    when `properties` is an object carrying the key: a string
 *                    in the tipo grammar, <= 32
 *      NULL passes and '' fails, in the predicate exactly as in the CHECK.
 *      They are added NOT VALID (an installed DB may already hold violators;
 *      owner decision 2026-09-30): they bind every write from then on — an
 *      UPDATE of a legacy violating row is re-checked, and the 23514 is
 *      converted, typed, by `ddOntologyConstraintRefusal` — and the reconcile
 *      `ontology_identifiers` (ontology/identifier_grammar.ts) reports the
 *      violators, repairs them on an operator apply, and VALIDATEs each
 *      constraint whose column is clean (`validateDdOntologyIdentifierConstraints`).
 *
 * HARD RULE: this file is the ONLY dd_ontology SQL. Every WRITE ends by fanning
 * out `clearOntologyDerivedCaches()` (the single invalidation chokepoint) so no
 * reader observes a stale node after a mutation.
 *
 * LEDGER / deferred (not needed by Workstream B, ledgered per no-silent-narrowing):
 *  - search_fuzzy_term / search_exact_term (dd_ontology_api term search) — the
 *    trigram/jsonpath fuzzy lookups are out of scope for the definition pipeline.
 *  - the per-request read cache: resolver.ts already caches node reads; this
 *    layer's readDdOntologyRow is an uncached raw-row probe for the parser.
 */

import { isValidTipo, isValidTld } from '../concepts/ontology.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	clearOntologyDerivedCaches,
	registerOntologyCacheClearer,
} from '../ontology/cache_invalidation.ts';
import { safeTld } from '../ontology/tld.ts';
import { encodeForJsonb } from './json_codec.ts';
import { isInTransaction, sql, sqlStateOf, withTransaction } from './postgres.ts';

/**
 * One dd_ontology node — the shape the parser produces and the writer persists.
 * Field names are the dd_ontology column names (PHP $columns keys).
 */
export interface DdOntologyNode {
	tipo: string;
	parent: string | null;
	/** jsonb object: {lang: label}. */
	term: Record<string, string> | null;
	model: string | null;
	order_number: number | null;
	/** jsonb array: [{tipo}]. */
	relations: { tipo: string }[] | null;
	tld: string | null;
	/** jsonb object (v7 config). */
	properties: Record<string, unknown> | null;
	model_tipo: string | null;
	is_model: boolean;
	is_translatable: boolean;
	is_main: boolean;
	/** TEXT column (v6 legacy JSON text — pretty-printed). */
	propiedades: string | null;
}

/**
 * The column allowlist in PHP declaration order (dd_ontology_db_manager::$columns).
 * Order matters: it fixes the INSERT column/placeholder sequence for parity.
 */
const COLUMNS = [
	'tipo',
	'parent',
	'term',
	'model',
	'order_number',
	'relations',
	'tld',
	'properties',
	'model_tipo',
	'is_model',
	'is_translatable',
	'is_main',
	'propiedades',
] as const;
type DdOntologyColumn = (typeof COLUMNS)[number];

/** Columns stored as JSONB (bound as text::jsonb; propiedades is deliberately excluded). */
const JSON_COLUMNS: ReadonlySet<string> = new Set(['term', 'relations', 'properties']);
/** Columns cast to int. */
const INT_COLUMNS: ReadonlySet<string> = new Set(['order_number']);
/** Boolean flag columns. */
const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set(['is_model', 'is_translatable', 'is_main']);

/** Search operator allowlist (PHP dd_ontology_db_manager::search $allowed_ops). */
const ALLOWED_OPS: ReadonlySet<string> = new Set([
	'=',
	'!=',
	'<',
	'>',
	'<=',
	'>=',
	'LIKE',
	'ILIKE',
	'@>',
]);

/**
 * Bind one column's value to the SQL parameter form the column type dictates.
 * jsonb → text (Postgres parses it), boolean → 't'/'f', int → the int (bound as
 * text — Postgres coerces), everything else → the value as-is (null stays null).
 */
function boundValueFor(column: string, value: unknown): string | number | null {
	if (JSON_COLUMNS.has(column)) {
		return value === null || value === undefined ? null : encodeForJsonb(value);
	}
	if (BOOLEAN_COLUMNS.has(column)) {
		// PHP create() coerces non-bool → 'f'; a real bool → 't'/'f'.
		return value === true ? 't' : 'f';
	}
	if (INT_COLUMNS.has(column)) {
		return value === null || value === undefined ? null : Math.trunc(Number(value));
	}
	// tipo / parent / model / tld / model_tipo / propiedades — plain text or null.
	return value === null || value === undefined ? null : String(value);
}

/** The SQL placeholder for a column (jsonb needs the ::text::jsonb cast; booleans ::boolean). */
function placeholderFor(column: string, index: number): string {
	if (JSON_COLUMNS.has(column)) return `$${index}::text::jsonb`;
	if (BOOLEAN_COLUMNS.has(column)) return `$${index}::boolean`;
	return `$${index}`;
}

/**
 * Read the value of one column off a node object. `is_*` columns default to
 * false when the node omits them (PHP boolean default); everything else defaults
 * to null.
 */
function nodeColumnValue(node: Partial<DdOntologyNode>, column: DdOntologyColumn): unknown {
	if (column === 'tipo') return node.tipo;
	const value = (node as Record<string, unknown>)[column];
	if (value === undefined) {
		return BOOLEAN_COLUMNS.has(column) ? false : null;
	}
	return value;
}

// --- The identifier grammar (SURF-1) -------------------------------------------

/**
 * The varchar lengths of the identifier columns — equal to the live schema
 * (`information_schema.columns.character_maximum_length`; the G3 gate re-reads
 * them). A value longer than its column is refused by the predicate, never
 * left to die as an untyped 22001.
 */
export const DD_ONTOLOGY_IDENTIFIER_LIMITS = {
	tipo: 32,
	parent: 32,
	model_tipo: 8,
	tld: 32,
} as const;

/** The six CHECK constraints of migration 0013, by the rule each enforces. */
const GRAMMAR_CONSTRAINT_OF = {
	tipo: 'dd_ontology_tipo_grammar',
	parent: 'dd_ontology_parent_grammar',
	model_tipo: 'dd_ontology_model_tipo_grammar',
	tld: 'dd_ontology_tld_grammar',
	tipo_in_tld: 'dd_ontology_tipo_in_tld',
	alias_of: 'dd_ontology_alias_of_grammar',
} as const;

/** One rule of the identifier grammar (the column, or the tipo↔tld / alias_of rule). */
export type DdOntologyIdentifierRule = keyof typeof GRAMMAR_CONSTRAINT_OF;

/** The constraint names — the ONLY identifiers ever spliced into a VALIDATE statement. */
export const DD_ONTOLOGY_GRAMMAR_CONSTRAINTS: readonly string[] =
	Object.values(GRAMMAR_CONSTRAINT_OF);

/** Why a value broke the grammar. */
export type DdOntologyIdentifierReason = 'required' | 'grammar' | 'length' | 'prefix';

export interface DdOntologyIdentifierViolation {
	column: DdOntologyIdentifierRule;
	value: unknown;
	reason: DdOntologyIdentifierReason;
}

/** The identifier fields the predicate reads (all optional except tipo). */
export type DdOntologyIdentifierFields = Partial<
	Pick<DdOntologyNode, 'parent' | 'model_tipo' | 'tld' | 'properties'>
> & { tipo?: unknown };

/** The tipo grammar with a column bound: `null` when valid, else the reason. */
function tipoGrammarReason(value: unknown, limit: number): DdOntologyIdentifierReason | null {
	if (typeof value !== 'string' || !isValidTipo(value)) return 'grammar';
	return value.length > limit ? 'length' : null;
}

/** The letter prefix of a tipo (`zzgram1` → `zzgram`), null when it has none. */
function letterPrefixOf(tipo: unknown): string | null {
	if (typeof tipo !== 'string') return null;
	return /^[a-z]+/.exec(tipo)?.[0] ?? null;
}

/**
 * THE identifier predicate (pure; SURF-1). Every rule broken by `row`, as
 * `{column, value, reason}`. A field that is ABSENT from `row` (undefined) is
 * not checked — a partial update states only the columns it writes — except
 * `tipo`, which is always required. NULL passes and '' fails, exactly as in
 * the CHECK constraints (see the header).
 */
export function ddOntologyIdentifierViolations(
	row: DdOntologyIdentifierFields,
): DdOntologyIdentifierViolation[] {
	return IDENTIFIER_RULES.flatMap((rule) => rule(row));
}

/** A field the predicate does not check (absent from a partial row, or NULL). */
function isUnstated(value: unknown): value is null | undefined {
	return value === undefined || value === null;
}

/** `[violation]` when `reason` is set, else `[]`. */
function violation(
	column: DdOntologyIdentifierRule,
	value: unknown,
	reason: DdOntologyIdentifierReason | null,
): DdOntologyIdentifierViolation[] {
	return reason === null ? [] : [{ column, value, reason }];
}

/** Rule `tipo`: required, the tipo grammar, the column bound. */
function tipoViolations(row: DdOntologyIdentifierFields): DdOntologyIdentifierViolation[] {
	return violation(
		'tipo',
		row.tipo,
		isUnstated(row.tipo)
			? 'required'
			: tipoGrammarReason(row.tipo, DD_ONTOLOGY_IDENTIFIER_LIMITS.tipo),
	);
}

/** Rules `parent` / `model_tipo`: NULL passes, else the tipo grammar within the column bound. */
function referenceViolations(row: DdOntologyIdentifierFields): DdOntologyIdentifierViolation[] {
	return (['parent', 'model_tipo'] as const).flatMap((column) => {
		const value = row[column];
		if (isUnstated(value)) return [];
		return violation(
			column,
			value,
			tipoGrammarReason(value, DD_ONTOLOGY_IDENTIFIER_LIMITS[column]),
		);
	});
}

/** The tld grammar with its column bound: `null` when valid, else the reason. */
function tldGrammarReason(tld: string): DdOntologyIdentifierReason | null {
	if (!isValidTld(tld)) return 'grammar';
	return tld.length > DD_ONTOLOGY_IDENTIFIER_LIMITS.tld ? 'length' : null;
}

/** Rules `tld` + `tipo_in_tld`: NULL passes; else the tld grammar, and the tipo's letter prefix IS the tld. */
function tldViolations(row: DdOntologyIdentifierFields): DdOntologyIdentifierViolation[] {
	const tld = row.tld;
	if (isUnstated(tld)) return [];
	return [
		...violation('tld', tld, tldGrammarReason(tld)),
		...violation('tipo_in_tld', row.tipo, letterPrefixOf(row.tipo) === tld ? null : 'prefix'),
	];
}

/** Properties that state an `alias_of` key (an object, the key own-present). */
function statesAliasOf(properties: unknown): properties is { alias_of?: unknown } {
	return (
		properties !== null &&
		typeof properties === 'object' &&
		!Array.isArray(properties) &&
		Object.hasOwn(properties, 'alias_of')
	);
}

/** Rule `alias_of`: when stated, a string tipo within the tipo bound. */
function aliasOfViolations(row: DdOntologyIdentifierFields): DdOntologyIdentifierViolation[] {
	const properties = row.properties as unknown;
	if (!statesAliasOf(properties)) return [];
	return violation(
		'alias_of',
		properties.alias_of,
		tipoGrammarReason(properties.alias_of, DD_ONTOLOGY_IDENTIFIER_LIMITS.tipo),
	);
}

/** The rules, in report order (tipo, parent, model_tipo, tld, tipo_in_tld, alias_of). */
const IDENTIFIER_RULES: readonly ((
	row: DdOntologyIdentifierFields,
) => DdOntologyIdentifierViolation[])[] = [
	tipoViolations,
	referenceViolations,
	tldViolations,
	aliasOfViolations,
];

/** A value as it may appear in a log line / coordinate: JSON-escaped, cut to 64. */
function shownValue(value: unknown): string {
	return (JSON.stringify(value) ?? 'undefined').slice(0, 64);
}

/** Refuse `violations` (non-empty) as the typed `ontology.invalid_node`. */
function refuseIdentifierViolations(
	door: string,
	tipo: unknown,
	violations: readonly DdOntologyIdentifierViolation[],
): never {
	const summary = violations.map((v) => `${v.column}:${v.reason}`).join(',');
	throw new DedaloError('ontology.invalid_node', {
		message: `${door}: dd_ontology node ${shownValue(tipo)} refused — ${violations
			.map((v) => `${v.column} ${shownValue(v.value)} (${v.reason})`)
			.join('; ')} — identifier columns obey the tipo/tld grammar (SURF-1)`,
		coordinates: { tipo: shownValue(tipo), violations: summary },
	});
}

/** The constraint name a PostgreSQL error carries (own or on its cause chain). */
function constraintNameOf(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
		const name = (current as { constraint?: unknown; constraint_name?: unknown }).constraint;
		if (typeof name === 'string' && name !== '') return name;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * THE ONE converter of a dd_ontology grammar failure raised by the DATABASE:
 * a 23514 on one of the six grammar constraints, or a 22001 (a value longer
 * than its varchar), becomes `ontology.invalid_node` with
 * `coordinates.constraint`. Reached when a door's own check was satisfied but
 * the ROW was not — above all a NOT VALID legacy row, which PostgreSQL
 * re-checks whole on an UPDATE of any column (an `order_number` sync of a row
 * whose parent predates the grammar). Null for any other error (rethrow it).
 */
export function ddOntologyConstraintRefusal(error: unknown, tipo: unknown): DedaloError | null {
	const state = sqlStateOf(error);
	const constraint = constraintNameOf(error);
	const grammar =
		(state === '23514' &&
			constraint !== undefined &&
			DD_ONTOLOGY_GRAMMAR_CONSTRAINTS.includes(constraint)) ||
		state === '22001';
	if (!grammar) return null;
	const named = state === '22001' ? 'column_length' : (constraint as string);
	return new DedaloError('ontology.invalid_node', {
		message: `dd_ontology: the write of ${shownValue(tipo)} violates ${named} — the stored row breaks the identifier grammar (SURF-1); run reconcile ontology_identifiers`,
		coordinates: {
			tipo: shownValue(tipo),
			constraint: named,
			hint: 'run reconcile ontology_identifiers',
		},
		cause: error,
	});
}

/** Run one dd_ontology statement, converting a grammar failure (see above). */
async function guardedWrite<T>(tipo: unknown, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		throw ddOntologyConstraintRefusal(error, tipo) ?? error;
	}
}

/**
 * UPSERT a whole ontology node (PHP dd_ontology_db_manager::create).
 * Writes EVERY allowlisted column with the supplied-or-default value, then
 * INSERT … ON CONFLICT(tipo) DO UPDATE SET <all columns except tipo> = EXCLUDED.
 * Whole-row semantics: an omitted/cleared field overwrites the existing column
 * with its default (null / false), so a re-parse never leaves stale data behind.
 * Returns the row id. Fans out cache invalidation on success.
 */
export async function upsertDdOntologyNode(
	node: Partial<DdOntologyNode> & { tipo: string },
): Promise<number> {
	// The WHOLE row is checked (an omitted field writes its default, null).
	const violations = ddOntologyIdentifierViolations({
		tipo: node.tipo,
		parent: node.parent ?? null,
		model_tipo: node.model_tipo ?? null,
		tld: node.tld ?? null,
		properties: node.properties ?? null,
	});
	if (violations.length > 0)
		refuseIdentifierViolations('upsertDdOntologyNode', node.tipo, violations);
	const params: (string | number | null)[] = [];
	const columnIdents: string[] = [];
	const placeholders: string[] = [];
	COLUMNS.forEach((column, position) => {
		columnIdents.push(`"${column}"`);
		params.push(boundValueFor(column, nodeColumnValue(node, column)));
		placeholders.push(placeholderFor(column, position + 1));
	});
	const updateParts = COLUMNS.filter((column) => column !== 'tipo').map(
		(column) => `"${column}" = EXCLUDED."${column}"`,
	);
	await alignDdOntologyIdSequence();
	const rows = (await guardedWrite(node.tipo, () =>
		sql.unsafe(
			`INSERT INTO dd_ontology (${columnIdents.join(', ')})
			 VALUES (${placeholders.join(', ')})
			 ON CONFLICT (tipo) DO UPDATE SET ${updateParts.join(', ')}
			 RETURNING id`,
			params,
		),
	)) as { id: number }[];
	await clearOntologyDerivedCaches();
	return Number(rows[0]?.id);
}

/** A raw dd_ontology row (columns hydrated to JS types, mirroring PHP read()). */
export interface DdOntologyRow {
	tipo: string;
	parent: string | null;
	term: Record<string, string> | null;
	model: string | null;
	order_number: number | null;
	relations: { tipo: string }[] | null;
	tld: string | null;
	properties: Record<string, unknown> | null;
	model_tipo: string | null;
	is_model: boolean;
	is_translatable: boolean;
	is_main: boolean;
	propiedades: string | null;
}

/**
 * Read one raw dd_ontology row (PHP read()). Returns null when the tipo does not
 * exist. Uncached — the parser/pipeline needs the current on-disk state; the
 * cached read registry lives in resolver.ts.
 */
export async function readDdOntologyRow(tipo: string): Promise<DdOntologyRow | null> {
	const rows = (await sql`
		SELECT tipo, parent, term, model, order_number, relations, tld,
		       properties, model_tipo, is_model, is_translatable, is_main, propiedades
		FROM dd_ontology WHERE tipo = ${tipo} LIMIT 1
	`) as DdOntologyRow[];
	const row = rows[0];
	if (row === undefined) return null;
	// PHP read() casts int_columns to (int) — the driver may hand order_number
	// back as a numeric string; normalize so callers get a number (or null).
	row.order_number =
		row.order_number === null || row.order_number === undefined
			? null
			: Math.trunc(Number(row.order_number));
	return row;
}

/** The row as it will read after an UPDATE's SET, restricted to what the SET states. */
function statedIdentifierFields(
	tipo: string,
	values: Partial<Record<DdOntologyColumn, unknown>>,
	columns: readonly DdOntologyColumn[],
): DdOntologyIdentifierFields {
	const stated: Record<string, unknown> = { tipo };
	for (const column of ['parent', 'model_tipo', 'tld', 'properties'] as const) {
		if (columns.includes(column)) stated[column] = values[column] ?? null;
	}
	return stated as DdOntologyIdentifierFields;
}

/**
 * Every grammar rule an UPDATE of `tipo` with `values` would break. The WHERE
 * tipo names an identifier too: a non-grammar tipo is refused, not probed.
 */
function updateViolations(
	tipo: string,
	values: Partial<Record<DdOntologyColumn, unknown>>,
	columns: readonly DdOntologyColumn[],
): DdOntologyIdentifierViolation[] {
	const stated = statedIdentifierFields(tipo, values, columns);
	return [
		...ddOntologyIdentifierViolations({ tipo }),
		...(columns.includes('tipo')
			? ddOntologyIdentifierViolations({ ...stated, tipo: values.tipo })
			: ddOntologyIdentifierViolations(stated).filter((v) => v.column !== 'tipo')),
	];
}

/**
 * Partial column update (PHP dd_ontology_db_manager::update). Only the given
 * columns are written, on an EXISTING row: true when a row matched, false when
 * the tipo is absent — nothing is inserted (SURF-1: PHP's INSERT fallback
 * planted a partial row, no tld and no model, for any tipo it was handed).
 * Unknown columns are rejected (allowlist). The tipo and every identifier
 * column given are checked against the grammar BEFORE any SQL; a NOT VALID
 * legacy row that the database re-checks on this UPDATE is refused, typed
 * (`ddOntologyConstraintRefusal`).
 */
export async function updateDdOntologyColumns(
	tipo: string,
	values: Partial<Record<DdOntologyColumn, unknown>>,
): Promise<boolean> {
	const columns = Object.keys(values) as DdOntologyColumn[];
	const validColumns = columns.filter((column) => COLUMNS.includes(column));
	if (validColumns.length === 0) {
		return false;
	}
	const violations = updateViolations(tipo, values, validColumns);
	if (violations.length > 0)
		refuseIdentifierViolations('updateDdOntologyColumns', tipo, violations);

	// UPDATE: $1 = tipo (WHERE), then each column.
	const updateParams: (string | number | null)[] = [tipo];
	const setClauses: string[] = [];
	validColumns.forEach((column, index) => {
		updateParams.push(boundValueFor(column, values[column]));
		setClauses.push(`"${column}" = ${placeholderFor(column, index + 2)}`);
	});
	const updated = (await guardedWrite(tipo, () =>
		sql.unsafe(
			`UPDATE dd_ontology SET ${setClauses.join(', ')} WHERE tipo = $1 RETURNING id`,
			updateParams,
		),
	)) as { id: number }[];
	if (updated.length === 0) return false;
	await clearOntologyDerivedCaches();
	return true;
}

/**
 * Delete one node by tipo (PHP delete()). Returns the rows removed (0 or 1).
 * Fans out cache invalidation.
 */
export async function deleteDdOntologyNode(tipo: string): Promise<number> {
	const removed = (await sql`DELETE FROM dd_ontology WHERE tipo = ${tipo} RETURNING tipo`) as {
		tipo: string;
	}[];
	await clearOntologyDerivedCaches();
	return removed.length;
}

/**
 * The advisory-lock class (int4) of the per-tld PROJECTION lock: the key is
 * (class, hashtext(tld)). The two-int key space cannot collide with the
 * single-bigint advisory locks (node locks, the pending-retry / RAG drains);
 * 17580002 is the diffusion target fence (diffusion_bridge/target_lock.ts).
 */
export const ONTOLOGY_PROJECTION_LOCK_CLASS = 17580003;

/**
 * The advisory-lock class (int4) of the per-tld REGISTRY-ROW MINT lock: the key
 * is (class, hashtext(tld)). Taken ONLY by ontology_write.ts createMainSection,
 * inside its transaction, BEFORE its "no row names this tld" check — so the
 * check and the mint are one step and two minters of one tld never both mint
 * (cross-write:r2). Its own class: it never orders against the projection lock.
 */
export const ONTOLOGY_REGISTRY_MINT_LOCK_CLASS = 17580004;

/**
 * Take the per-tld REGISTRY-ROW MINT lock (ONTOLOGY_REGISTRY_MINT_LOCK_CLASS) — the
 * key shape's one home. `tld` must already be the NORMALIZED tld the mint checks
 * and writes (ontology_write.ts mintMainSection): a raw spelling would lock a key
 * no other minter of that tld takes. Refused outside a transaction (an xact lock
 * there is a no-op).
 */
export async function lockOntologyRegistryMint(tld: string): Promise<void> {
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'lockOntologyRegistryMint: called outside a transaction; the lock would be ineffective (call inside withTransaction)',
			coordinates: { tld },
		});
	}
	await sql.unsafe('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
		ONTOLOGY_REGISTRY_MINT_LOCK_CLASS,
		tld,
	]);
}

/**
 * Serialize every writer that derives a tld's NODES from its source records
 * (ONT-1/2/3 under concurrency, audit 2026-09-26 r0). The invariant
 * `dd_ontology(tld) == parse(matrix_ontology(<tld>0))` is a read-modify-write
 * over the tld: the whole-tld re-derive (ontology_state.ts rebuildOntology /
 * retractOntology) parses the records and then deletes/upserts nodes, the
 * per-record doors (section_record/ontology_projection.ts projectOntologyNode /
 * unprojectOntologyNode, the record-lifecycle hook) read a record or a node and
 * then write. Under READ COMMITTED withTransaction alone does not order them: a
 * rebuild whose parse predates a concurrent delete re-inserts the deleted
 * record's node from the stale parse, one whose parse predates a concurrent
 * undelete removes the node the undelete just committed. Every such writer
 * takes THIS lock for each tld it derives, BEFORE its first read, inside its
 * transaction (released at COMMIT/ROLLBACK; re-entrant within the session).
 *
 * Several tlds are locked in sorted order, so two multi-tld holders never wait
 * on each other in a cycle; a cross-order pair of separate calls is still
 * possible (a bulk run undeleting records of two tlds) and Postgres aborts one
 * side, loudly. Refused outside a transaction (an xact lock there is a no-op).
 * Gate: test/unit/ontology_projection_race_native.test.ts.
 */
export async function lockOntologyProjection(tlds: Iterable<string>): Promise<void> {
	const ordered = [...new Set(tlds)].sort();
	if (ordered.length === 0) return;
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'lockOntologyProjection: called outside a transaction; the lock would be ineffective (call inside withTransaction)',
			coordinates: { tld: ordered.join(',') },
		});
	}
	for (const tld of ordered) {
		await sql.unsafe('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
			ONTOLOGY_PROJECTION_LOCK_CLASS,
			tld,
		]);
	}
}

/** A search filter entry: scalar (→ '=') or {operator, value}. */
export type DdOntologySearchFilter = Record<string, unknown | { operator: string; value: unknown }>;

/**
 * Search tipos by column filters (PHP dd_ontology_db_manager::search). Each
 * filter value is a scalar (equality) or {operator, value} (op-allowlisted).
 * Returns the matching tipo strings, ordered by order_number when order=true.
 * Throws on an invalid column or operator (PHP returns false — we surface it).
 */
export async function searchDdOntology(
	values: DdOntologySearchFilter,
	order = false,
	limit: number | null = null,
): Promise<string[]> {
	const entries = Object.entries(values);
	if (entries.length === 0) {
		return [];
	}
	const params: (string | number | boolean | null)[] = [];
	const whereClauses: string[] = [];
	let paramIndex = 1;
	for (const [column, raw] of entries) {
		if (!COLUMNS.includes(column as DdOntologyColumn)) {
			throw new DedaloError('internal.invariant', {
				message: `searchDdOntology: invalid column '${column}'`,
				coordinates: { column },
			});
		}
		if (raw !== null && typeof raw === 'object' && 'operator' in (raw as object)) {
			const opValue = raw as { operator: string; value: unknown };
			if (!ALLOWED_OPS.has(opValue.operator)) {
				throw new DedaloError('internal.invariant', {
					message: `searchDdOntology: invalid operator '${opValue.operator}'`,
					coordinates: { column, operator: opValue.operator },
				});
			}
			let paramValue = opValue.value;
			if (BOOLEAN_COLUMNS.has(column) && typeof paramValue === 'boolean') {
				paramValue = paramValue ? 'true' : 'false';
			}
			params.push(paramValue as string | number | null);
			whereClauses.push(`"${column}" ${opValue.operator} $${paramIndex}`);
		} else {
			let scalar: unknown = raw;
			if (BOOLEAN_COLUMNS.has(column)) {
				scalar = scalar === true ? 'true' : 'false';
			}
			params.push(scalar as string | number | null);
			whereClauses.push(`"${column}" = $${paramIndex}`);
		}
		paramIndex++;
	}
	const orderClause = order ? ' ORDER BY order_number ASC' : '';
	const limitClause = limit && limit > 0 ? ` LIMIT ${Math.trunc(limit)}` : '';
	const rows = (await sql.unsafe(
		`SELECT tipo FROM dd_ontology WHERE ${whereClauses.join(' AND ')}${orderClause}${limitClause}`,
		params,
	)) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

/**
 * Tipos whose `properties` carries an `api_config` key — the CANDIDATE set for
 * external-service sections (src/external/config.ts validates each; a key can
 * exist and be malformed). Query lives here, not in src/external, so raw SQL
 * stays confined to the db layer (sql_confinement tiering).
 */
export async function listTiposWithApiConfig(): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT tipo FROM dd_ontology WHERE properties ? 'api_config'`,
	)) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

/** One node that DECLARES a request_config (readDdOntologyRequestConfigRows). */
export interface DdOntologyRequestConfigRow {
	tipo: string;
	tld: string | null;
	parent: string | null;
	model: string | null;
	/** `properties.source.request_config` verbatim (a JSON array — the WHERE guarantees it). */
	request_config: unknown[];
}

/**
 * Every dd_ontology node whose `properties.source.request_config` is an
 * ARRAY — the definitions the level >= 2 'self' ontology check walks
 * (relations/request_config/self_depth_check.ts). `tlds` narrows to those
 * TLDs; null = the whole installed ontology. Read-only, uncached (an operator
 * check must see the current rows). Lives here, not in relations/, so raw
 * SQL stays confined to the db layer (sql_confinement tiering).
 */
export async function readDdOntologyRequestConfigRows(
	tlds: readonly string[] | null,
): Promise<DdOntologyRequestConfigRow[]> {
	if (tlds !== null && tlds.length === 0) return [];
	const rows = (await sql.unsafe(
		`SELECT tipo, tld, parent, model, properties->'source'->'request_config' AS request_config
		   FROM dd_ontology
		  WHERE jsonb_typeof(properties->'source'->'request_config') = 'array'
		    AND ($1::text IS NULL OR tld = ANY(string_to_array($1::text, ',')))
		  ORDER BY tld, id`,
		[tlds === null ? null : tlds.join(',')],
	)) as DdOntologyRequestConfigRow[];
	return rows;
}

/**
 * One SECTION's list-config facts (readDdOntologySectionListFacts): whether it
 * keeps its own config in list mode, its relations (the virtual→real walk's
 * input) and the list-node models among its OWN children.
 */
export interface DdOntologySectionListFacts {
	tipo: string;
	/**
	 * `properties.source.request_config` is SET — any non-null JSON value, the
	 * read's isset test (build.ts `sectionKeepsOwn`, PHP :274), never the array
	 * shape alone.
	 */
	keeps_own: boolean;
	relations: { tipo?: unknown }[] | null;
	/** The distinct `section_list` / `section_list_thesaurus` models of its own children. */
	list_models: string[];
}

/**
 * Every model='section' node of the WHOLE installed ontology with the facts
 * that decide whether a read ever swaps a section_list node in
 * (relations/request_config/self_depth_check.ts configReaders): its keep-own
 * test and, for the virtual fallback, its relations and own list children.
 * Never TLD-scoped — a list node's reader (its section, or a virtual section
 * of it) may live in another TLD. Read-only, uncached.
 */
export async function readDdOntologySectionListFacts(): Promise<DdOntologySectionListFacts[]> {
	return (await sql.unsafe(
		`SELECT s.tipo,
		        COALESCE(jsonb_typeof(s.properties->'source'->'request_config') <> 'null', false) AS keeps_own,
		        s.relations,
		        COALESCE((SELECT jsonb_agg(DISTINCT c.model)
		                    FROM dd_ontology c
		                   WHERE c.parent = s.tipo
		                     AND c.model IN ('section_list', 'section_list_thesaurus')), '[]'::jsonb) AS list_models
		   FROM dd_ontology s
		  WHERE s.model = 'section'`,
	)) as DdOntologySectionListFacts[];
}

/**
 * The list nodes a read can ever swap in: per (parent, model), the FIRST
 * `section_list` / `section_list_thesaurus` child by `order_number` — exactly
 * the row build.ts `findSectionListChild` picks (`ORDER BY order_number ASC
 * LIMIT 1`; Postgres puts a NULL order_number last in both). A parent may hold
 * several list children (tch546 ×4, oh123 ×2, tch20 ×2): only the first is
 * ever a request_config (relations/request_config/self_depth_check.ts
 * configReaders). Whole ontology, read-only, uncached.
 */
export async function readDdOntologyFirstListNodeTipos(): Promise<Set<string>> {
	const rows = (await sql.unsafe(
		`SELECT DISTINCT ON (parent, model) tipo
		   FROM dd_ontology
		  WHERE model IN ('section_list', 'section_list_thesaurus')
		    AND parent IS NOT NULL
		  ORDER BY parent, model, order_number ASC`,
	)) as { tipo: string }[];
	return new Set(rows.map((row) => row.tipo));
}

// --- Active-TLD set (PHP ontology_utils::get_active_tlds / check_active_tld) --

/**
 * The set of TLDs that HAVE dd_ontology rows. PHP's `check_active_tld` means
 * "this TLD is installed in dd_ontology" (SELECT tld … GROUP BY tld) — NOT the
 * hierarchy4 active flag. Module-cached (ontology content carries no request
 * identity) and cleared by the invalidation hub after any write.
 */
let activeTldsCache: string[] | null = null;

export async function getActiveTlds(): Promise<string[]> {
	if (activeTldsCache !== null) {
		return activeTldsCache;
	}
	const rows = (await sql`SELECT tld FROM dd_ontology GROUP BY tld`) as { tld: string | null }[];
	activeTldsCache = rows
		.map((row) => row.tld)
		.filter((tld): tld is string => tld !== null && tld !== '');
	return activeTldsCache;
}

/**
 * Whether dd_ontology holds ANY row of `tld` — getActiveTlds' "active" for ONE tld, read
 * LIVE (never the module cache: a cache filled by a reader racing an uncommitted teardown
 * would still list it). The question a whole-tld door re-asks UNDER the tld's projection
 * lock (ontology_state.ts syncOntologyActivation / rebuildOntology `onlyIfProjected`), so a
 * teardown that committed first is seen.
 */
export async function tldHoldsNodes(tld: string): Promise<boolean> {
	const rows = (await sql.unsafe(
		'SELECT EXISTS (SELECT 1 FROM dd_ontology WHERE tld = $1) AS holds',
		[tld],
	)) as { holds: boolean }[];
	return rows[0]?.holds === true;
}

/**
 * The set of TLDs whose ontology package actually carries CONTENT.
 *
 * Declaring an ontology in the ontologies catalogue creates its registry root —
 * `<tld>0` (ontology/tld.ts mapTldToTargetSectionTipo) — before anything is
 * imported. A declared-but-never-imported package therefore leaves exactly that
 * one row, which getActiveTlds (PHP check_active_tld: "has rows") counts as
 * installed. For the question "can this deployment resolve nodes of this package
 * at all" that answer is wrong, so this variant ignores the root row.
 *
 * Observed 2026-08-11: an install with a single `zenon0` row and no zenon1…11 —
 * getActiveTlds said 'zenon', every real zenon tipo resolved to null.
 *
 * Module-cached and hub-cleared, same as getActiveTlds.
 */
let populatedTldsCache: string[] | null = null;

export async function getPopulatedTlds(): Promise<string[]> {
	if (populatedTldsCache !== null) {
		return populatedTldsCache;
	}
	const rows = (await sql`
		SELECT tld FROM dd_ontology WHERE tipo <> tld || '0' GROUP BY tld
	`) as { tld: string | null }[];
	populatedTldsCache = rows
		.map((row) => row.tld)
		.filter((tld): tld is string => tld !== null && tld !== '');
	return populatedTldsCache;
}

/**
 * The structural columns of every node of `tlds` — what the reference
 * classifier (ontology/ontology_references.ts) measures, plus `model` (null
 * when the node's model could not be resolved at derive time). Read-only,
 * uncached (the installer's post-import verification needs the current state).
 */
export async function readDdOntologyReferenceRows(tlds: readonly string[]): Promise<
	{
		tipo: string;
		tld: string | null;
		parent: string | null;
		model: string | null;
		model_tipo: string | null;
		relations: { tipo?: unknown }[] | null;
	}[]
> {
	if (tlds.length === 0) return [];
	return (await sql`
		SELECT tipo, tld, parent, model, model_tipo, relations
		  FROM dd_ontology
		 WHERE tld = ANY(string_to_array(${tlds.join(',')}, ','))
		 ORDER BY id
	`) as {
		tipo: string;
		tld: string | null;
		parent: string | null;
		model: string | null;
		model_tipo: string | null;
		relations: { tipo?: unknown }[] | null;
	}[];
}

/** Which of `tipos` exist in dd_ontology. Read-only, uncached. */
export async function existingDdOntologyTipos(tipos: readonly string[]): Promise<Set<string>> {
	if (tipos.length === 0) return new Set();
	const rows = (await sql`
		SELECT tipo FROM dd_ontology
		 WHERE tipo = ANY(string_to_array(${[...new Set(tipos)].join(',')}, ','))
	`) as { tipo: string }[];
	return new Set(rows.map((row) => row.tipo));
}

/** The model nodes' parent links (the model tree the diffusion-model set is walked over). */
export async function readDdOntologyModelParents(): Promise<
	{ tipo: string; parent: string | null }[]
> {
	return (await sql`
		SELECT tipo, parent FROM dd_ontology WHERE is_model = true
	`) as { tipo: string; parent: string | null }[];
}

/** Register the TLD caches with the invalidation hub (dropped on any write). */
registerOntologyCacheClearer(() => {
	activeTldsCache = null;
	populatedTldsCache = null;
});

/**
 * Delete every dd_ontology row for one TLD (PHP ontology_utils::delete_tld_nodes).
 * The TLD MUST pass safeTld (`/^[a-z]{2,}$/`) — a mismatch refuses the delete
 * (leaves the table untouched), byte-identical to PHP's `safe_tld !== tld` gate.
 * Returns true on success. Fans out cache invalidation.
 */
export async function deleteTldNodes(tld: string): Promise<boolean> {
	const safe = safeTld(tld);
	if (safe === null || safe !== tld) {
		return false;
	}
	await deleteTldNodesReturningTipos(safe);
	return true;
}

/**
 * True when the NEXT value the id sequence would hand out is already taken
 * (effective next = last_value + 1, or last_value itself when is_called=false —
 * a freshly restarted/reset sequence). NULL-safe: an empty table never lags.
 */
async function idSequenceLags(): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(
		   (SELECT MAX(id) FROM dd_ontology) >=
		   (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM dd_ontology_id_seq),
		   false) AS lags`,
		[],
	)) as { lags: boolean }[];
	return rows[0]?.lags === true;
}

/**
 * Raise the dd_ontology id sequence to MAX(id) when it lags behind the table.
 *
 * Every insert here takes `id` from the sequence, and `ON CONFLICT (tipo)` does
 * not cover the primary key: a sequence below MAX(id) (rows brought in by a
 * dump/COPY restore or hand SQL, which never advance it) makes the insert die on
 * `dd_ontology_id_pkey`. Retrying then "works" only because nextval is not
 * transactional — each failed attempt burned values past the taken ids.
 *
 * Healthy path = ONE lock-free read (MAX(id) is a pkey index probe), no write.
 * Lagging path = LOCK TABLE … SHARE ROW EXCLUSIVE, re-check, setval. The lock
 * conflicts with every inserter's ROW EXCLUSIVE, and this table is the
 * sequence's only consumer, so no nextval is in flight while the check and the
 * setval run: a value already handed out can never be reissued (a check-then-
 * setval without it could LOWER the sequence under a concurrent writer). Inside
 * an ambient transaction the lock is held to its end; otherwise it lives in its
 * own short transaction. Call it BEFORE the caller's first dd_ontology write and
 * OUTSIDE the caller's transaction when possible (rebuildOntology does, before it
 * opens its own): upgrading a held ROW EXCLUSIVE to this lock can deadlock against a
 * twin, and a table lock held while the tld's projection lock (lockOntologyProjection)
 * is awaited deadlocks against a lifecycle unit that holds that lock and then writes
 * dd_ontology — Postgres then aborts one side, loudly.
 * Returns true when the sequence was moved.
 */
export async function alignDdOntologyIdSequence(): Promise<boolean> {
	if (!(await idSequenceLags())) return false;
	return withTransaction(async () => {
		await sql.unsafe('LOCK TABLE dd_ontology IN SHARE ROW EXCLUSIVE MODE', []);
		if (!(await idSequenceLags())) return false; // a twin healed it while we waited
		await sql.unsafe(`SELECT setval('dd_ontology_id_seq', (SELECT MAX(id) FROM dd_ontology))`, []);
		return true;
	});
}

/**
 * The whole-tld delete statement (T2): every row of the tld goes, the removed
 * tipos come back so a caller (ontology_state.ts retractOntology — only the tld
 * teardown, ontology_delete.ts, routes through it; the activation never retracts)
 * can count and report them. `tld` MUST already be safeTld-validated by the caller; a mismatch is
 * refused loudly rather than turned into a wider delete. Fans out cache
 * invalidation.
 */
export async function deleteTldNodesReturningTipos(tld: string): Promise<string[]> {
	if (safeTld(tld) !== tld) {
		throw new DedaloError('internal.invariant', {
			message: `deleteTldNodesReturningTipos: '${tld}' is not a safe tld`,
			coordinates: { tld },
		});
	}
	const removed = (await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1 RETURNING tipo', [
		tld,
	])) as { tipo: string }[];
	await clearOntologyDerivedCaches();
	return removed.map((row) => row.tipo);
}

/**
 * The RECONCILE delete of one tld (ontology_state.ts rebuildOntology): every row of
 * the tld EXCEPT `keepTipos` goes — the rows the re-derive is about to upsert keep
 * their ids (no id churn), everything else (orphans) is removed. Same safe-tld
 * refusal as deleteTldNodesReturningTipos; returns the removed tipos. Fans out
 * cache invalidation.
 */
export async function deleteTldNodesExcept(
	tld: string,
	keepTipos: readonly string[],
): Promise<string[]> {
	if (safeTld(tld) !== tld) {
		throw new DedaloError('internal.invariant', {
			message: `deleteTldNodesExcept: '${tld}' is not a safe tld`,
			coordinates: { tld },
		});
	}
	const removed = (await sql.unsafe(
		`DELETE FROM dd_ontology WHERE tld = $1 AND NOT (tipo = ANY(string_to_array($2::text, ',')))
		 RETURNING tipo`,
		// Tipos are letters+digits (the identifier grammar), so a comma join is lossless.
		[tld, keepTipos.join(',')],
	)) as { tipo: string }[];
	await clearOntologyDerivedCaches();
	return removed.map((row) => row.tipo);
}

// --- Recovery slice + the retired backup table ----------------------------------

/**
 * Validate a list of TLDs for the recovery slice. Since safe TLDs are strictly
 * `[a-z]{2,}`, they can be inlined into DDL that cannot take bind parameters
 * with zero injection surface — the same reasoning PHP uses (pg_escape_literal
 * there; a validated allowlist here).
 */
function assertSafeTlds(tlds: readonly string[]): string[] {
	const safe = tlds.map((tld) => {
		const value = safeTld(tld);
		if (value === null) {
			throw new DedaloError('internal.invariant', {
				message: `dd_ontology recovery slice: refusing unsafe tld '${tld}'`,
				coordinates: { tld },
			});
		}
		return value;
	});
	if (safe.length === 0) {
		throw new DedaloError('internal.invariant', {
			message: 'dd_ontology recovery slice: empty tld list',
		});
	}
	return safe;
}

/**
 * Drop the dd_ontology_bk table the retired PHP backup protocol
 * (create/restore_bk_table) left behind on an upgraded install. Idempotent.
 * (The protocol itself is gone: regenerate is one transaction.)
 */
export async function dropBackupTable(): Promise<boolean> {
	await sql.unsafe('DROP TABLE IF EXISTS "dd_ontology_bk" CASCADE', []);
	return true;
}

/** What `createRecoverySlice` produced: whether a slice exists, and the tipos it left out. */
export interface RecoverySliceResult {
	created: boolean;
	/** Rows of the whitelisted TLDs that break the identifier grammar — NOT in the slice. */
	skipped: string[];
}

/**
 * Materialize the dd_ontology_recovery slice table (PHP
 * installer_ontology_manager::build_recovery_version_file SQL half): DROP +
 * CREATE LIKE … INCLUDING ALL + INSERT of the whitelisted TLDs. The caller
 * dumps it with pg_dump and then drops it (dropRecoverySlice).
 *
 * SURF-1: rows that break the identifier grammar are LEFT OUT and reported in
 * `skipped` (the TS scan decides, one predicate). `INCLUDING ALL` copies the
 * grammar CHECKs onto the slice VALIDATED (the slice starts empty), so a slice
 * that loads here is certified loadable by any destination carrying them — a
 * recovery file must never carry a row its own install would refuse.
 */
export async function createRecoverySlice(tlds: readonly string[]): Promise<RecoverySliceResult> {
	if (tlds.length === 0) return { created: false, skipped: [] };
	const safe = assertSafeTlds(tlds);
	const inList = safe.map((tld) => `'${tld}'`).join(',');
	const violators = await scanDdOntologyIdentifierRows({ tlds: safe });
	await sql.unsafe('DROP TABLE IF EXISTS "dd_ontology_recovery" CASCADE', []);
	await sql.unsafe('CREATE TABLE "dd_ontology_recovery" ( LIKE "dd_ontology" INCLUDING ALL )', []);
	await guardedWrite('dd_ontology_recovery', () =>
		sql.unsafe(
			`INSERT INTO "dd_ontology_recovery" SELECT * FROM dd_ontology
			  WHERE tld IN (${inList}) AND id <> ALL(string_to_array($1, ',')::bigint[])`,
			[violators.map((row) => String(row.id)).join(',')],
		),
	);
	return { created: true, skipped: violators.map((row) => row.tipo) };
}

/** The recovery-slice single-flight lock's name (hashed to the advisory key, per database). */
const RECOVERY_SLICE_LOCK_NAME = 'dedalo_ontology_recovery_file';

/**
 * Run `work` holding the RECOVERY-SLICE single-flight lock, or answer `busy()`
 * without running it (cross-write:r2). Every build and restore of the recovery
 * file DROP/CREATEs the one `dd_ontology_recovery` table and writes beside the
 * one slot (ontology/recovery_file.ts), so they run one at a time, per
 * database, across every engine process. Outside a transaction: a
 * SESSION-level try-lock on a RESERVED connection (the unlock must reach the
 * connection that locked). Inside one (a caller's transaction the slice must
 * join): the XACT-level try-lock on the pinned connection, released at its
 * COMMIT/ROLLBACK — a session lock there would outlive an aborted transaction,
 * whose unlock statement can no longer run.
 */
export async function withRecoverySliceLock<T>(work: () => Promise<T>, busy: () => T): Promise<T> {
	const won = (rows: unknown): boolean => {
		const got = (rows as { got: boolean | string }[])[0]?.got;
		return got === true || got === 't' || got === 'true';
	};
	if (isInTransaction()) {
		const rows = await sql.unsafe('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got', [
			RECOVERY_SLICE_LOCK_NAME,
		]);
		return won(rows) ? work() : busy();
	}
	const reserved = await sql.reserve();
	try {
		const rows = await reserved.unsafe('SELECT pg_try_advisory_lock(hashtext($1)) AS got', [
			RECOVERY_SLICE_LOCK_NAME,
		]);
		if (!won(rows)) return busy();
		try {
			return await work();
		} finally {
			await reserved.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [RECOVERY_SLICE_LOCK_NAME]);
		}
	} finally {
		reserved.release();
	}
}

/** Drop the dd_ontology_recovery slice table (always run after the dump). */
export async function dropRecoverySlice(): Promise<boolean> {
	await sql.unsafe('DROP TABLE IF EXISTS "dd_ontology_recovery" CASCADE', []);
	return true;
}

// --- Report + repair primitives (reconcile `ontology_identifiers`) -------------

/** One stored dd_ontology row that breaks the identifier grammar. */
export interface DdOntologyIdentifierRow {
	id: number;
	tipo: string;
	parent: string | null;
	model_tipo: string | null;
	tld: string | null;
	violations: DdOntologyIdentifierViolation[];
}

/** One row as the identifier scan reads it (identifier columns + the alias_of probe). */
interface ScannedIdentifierRow {
	id: number | string;
	tipo: string;
	parent: string | null;
	model_tipo: string | null;
	tld: string | null;
	properties_type: string | null;
	has_alias_of: boolean | null;
	alias_of: unknown;
}

/**
 * Every STORED row that breaks the identifier grammar, judged by the TS
 * predicate (one grammar — the CHECKs state the same). Reads only the
 * identifier columns plus `properties->'alias_of'`; narrowed to `tlds`
 * (safeTld-validated by the caller) when given.
 */
export async function scanDdOntologyIdentifierRows(
	options: { tlds?: readonly string[] } = {},
): Promise<DdOntologyIdentifierRow[]> {
	const narrowed = options.tlds !== undefined;
	const rows = (await sql.unsafe(
		`SELECT id, tipo, parent, model_tipo, tld,
		        jsonb_typeof(properties) AS properties_type,
		        (jsonb_typeof(properties) = 'object' AND properties ? 'alias_of') AS has_alias_of,
		        properties->'alias_of' AS alias_of
		   FROM dd_ontology
		  ${narrowed ? `WHERE tld = ANY(string_to_array($1, ','))` : ''}
		  ORDER BY id`,
		narrowed ? [(options.tlds ?? []).join(',')] : [],
	)) as ScannedIdentifierRow[];
	return rows.flatMap((row) => {
		const violations = ddOntologyIdentifierViolations(scannedIdentifierFields(row));
		if (violations.length === 0) return [];
		return [
			{
				id: Number(row.id),
				tipo: row.tipo,
				parent: row.parent,
				model_tipo: row.model_tipo,
				tld: row.tld,
				violations,
			},
		];
	});
}

/**
 * The predicate's view of one scanned row: `properties` stands in as
 * `{alias_of}` when the key is present on an object, `{}` for an object
 * without it, null otherwise — the scan never reads the whole payload.
 */
function scannedIdentifierFields(row: ScannedIdentifierRow): DdOntologyIdentifierFields {
	const properties =
		row.has_alias_of === true
			? { alias_of: row.alias_of }
			: row.properties_type === 'object'
				? {}
				: null;
	return {
		tipo: row.tipo,
		parent: row.parent,
		model_tipo: row.model_tipo,
		tld: row.tld,
		properties: properties as DdOntologyIdentifierFields['properties'],
	};
}

/** A grammar constraint's state on this database. */
export type DdOntologyConstraintState = 'absent' | 'not_valid' | 'valid';

/** The state of each of the six grammar constraints (pg_constraint.convalidated). */
export async function ddOntologyConstraintStates(): Promise<
	Record<string, DdOntologyConstraintState>
> {
	const rows = (await sql.unsafe(
		`SELECT conname, convalidated FROM pg_constraint
		  WHERE conrelid = 'dd_ontology'::regclass AND contype = 'c'`,
		[],
	)) as { conname: string; convalidated: boolean }[];
	const live = new Map(rows.map((row) => [row.conname, row.convalidated]));
	return Object.fromEntries(
		DD_ONTOLOGY_GRAMMAR_CONSTRAINTS.map((name) => {
			const validated = live.get(name);
			return [name, validated === undefined ? 'absent' : validated ? 'valid' : 'not_valid'];
		}),
	);
}

/** What `validateDdOntologyIdentifierConstraints` did. */
export interface DdOntologyValidationOutcome {
	/** Constraints VALIDATEd by this call. */
	validated: string[];
	/** NOT VALID constraints left so, because stored rows still break their rule. */
	blocked: { constraint: string; rows: number }[];
	/** Violating rows found by the scan (all rules). */
	violators: DdOntologyIdentifierRow[];
	states: Record<string, DdOntologyConstraintState>;
}

/** Violating-row count per grammar constraint (a row counts once per rule it breaks). */
function brokenRowsByConstraint(
	violators: readonly DdOntologyIdentifierRow[],
): Map<string, number> {
	const brokenRows = new Map<string, number>();
	for (const row of violators) {
		for (const rule of new Set(row.violations.map((v) => v.column))) {
			const constraint = GRAMMAR_CONSTRAINT_OF[rule];
			brokenRows.set(constraint, (brokenRows.get(constraint) ?? 0) + 1);
		}
	}
	return brokenRows;
}

/** VALIDATE one grammar constraint, lock wait bounded (`constraint` ∈ DD_ONTOLOGY_GRAMMAR_CONSTRAINTS). */
async function validateGrammarConstraint(constraint: string): Promise<void> {
	await withTransaction(async () => {
		await sql.unsafe(`SET LOCAL lock_timeout = '5s'`, []);
		await guardedWrite(constraint, () =>
			sql.unsafe(`ALTER TABLE dd_ontology VALIDATE CONSTRAINT "${constraint}"`, []),
		);
	});
}

/**
 * VALIDATE every grammar constraint that is NOT VALID and whose rule has zero
 * violating rows (the TS scan decides). A constraint whose rule is still
 * broken stays NOT VALID and is reported in `blocked` — never a failure: an
 * install with legacy violators keeps serving and updating (owner decision
 * 2026-09-30); the reconcile `ontology_identifiers` repairs them. The lock wait
 * is bounded (VALIDATE takes SHARE UPDATE EXCLUSIVE: readers and writers
 * proceed; it scans the table once). Only names from the fixed
 * DD_ONTOLOGY_GRAMMAR_CONSTRAINTS list reach the statement.
 */
export async function validateDdOntologyIdentifierConstraints(): Promise<DdOntologyValidationOutcome> {
	const violators = await scanDdOntologyIdentifierRows();
	const brokenRows = brokenRowsByConstraint(violators);
	const before = await ddOntologyConstraintStates();
	const validated: string[] = [];
	const blocked: { constraint: string; rows: number }[] = [];
	for (const constraint of DD_ONTOLOGY_GRAMMAR_CONSTRAINTS) {
		if (before[constraint] !== 'not_valid') continue;
		const rows = brokenRows.get(constraint) ?? 0;
		if (rows > 0) {
			blocked.push({ constraint, rows });
			continue;
		}
		await validateGrammarConstraint(constraint);
		validated.push(constraint);
	}
	return { validated, blocked, violators, states: await ddOntologyConstraintStates() };
}

/** A whole dd_ontology row as the repair deleted it (kept for the report and the log). */
export type DeletedDdOntologyRow = DdOntologyRow & { id: number };

/**
 * Delete rows by id, returning each WHOLE row (the repair of rows no request
 * gate can address — a non-grammar tipo, or one under no safe tld; the caller
 * reports and logs every row it removed). Fans out cache invalidation.
 */
export async function deleteDdOntologyRowsReturning(
	ids: readonly number[],
): Promise<DeletedDdOntologyRow[]> {
	if (ids.length === 0) return [];
	const rows = (await sql.unsafe(
		`DELETE FROM dd_ontology WHERE id = ANY(string_to_array($1, ',')::bigint[])
		 RETURNING id, tipo, parent, term, model, order_number, relations, tld,
		           properties, model_tipo, is_model, is_translatable, is_main, propiedades`,
		[ids.map((id) => String(Math.trunc(id))).join(',')],
	)) as DeletedDdOntologyRow[];
	await clearOntologyDerivedCaches();
	return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

// --- SQL for a database the pool is NOT bound to (the install seed compiler) --

/**
 * The install seed compiler (install/seed_build.ts) reads dd_ontology in its
 * SCRATCH database over psql — the cached accessors read the installation's.
 * The SQL text lives here, the dd_ontology repository home (T3).
 */
export const DD_ONTOLOGY_TLDS_SQL = 'SELECT DISTINCT tld FROM dd_ontology ORDER BY 1';

/**
 * The parser scaffold the seed compiler derives over (seed_sources.ts
 * SEED_SCAFFOLD_PATH): the `ontology` TLD's own nodes and the model nodes of
 * the shipped TLDs, in tipo order, as a `\copy (…)` query.
 */
export function ddOntologyScaffoldQuery(
	columns: readonly string[],
	tlds: readonly string[],
): string {
	for (const name of [...columns, ...tlds]) {
		if (!/^[a-z_]+$/.test(name)) {
			throw new DedaloError('internal.invariant', {
				message: `ddOntologyScaffoldQuery: refusing identifier '${name}'`,
			});
		}
	}
	return `(SELECT ${columns.join(', ')} FROM dd_ontology WHERE tld IN (${tlds.map((tld) => `'${tld}'`).join(',')}) AND (tld = 'ontology' OR is_model) ORDER BY tipo)`;
}
