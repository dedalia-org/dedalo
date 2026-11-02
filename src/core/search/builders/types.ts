/**
 * Shared contracts for the per-component SQL fragment builders — the TS
 * re-expression of PHP's resolve_query_object_sql() (spec §3.3 conform phase).
 *
 * A builder receives one conformed filter LEAF plus its resolved context and
 * returns:
 *   - false                → leaf contributes nothing (dropped by the parser)
 *   - a Fragment           → SQL sentence with named _Q1_ tokens + values
 *   - a CompoundFragment   → $and/$or of sub-results (q_split fan-out,
 *                            section_id between, relation_search wrapping)
 *
 * SECURITY INVARIANT: every identifier interpolated into a sentence (alias,
 * column, tipo, lang) MUST have passed the identifier gate before the builder
 * runs. Builders interpolate only context fields, never raw leaf input;
 * comparison VALUES always travel as _Q_ tokens → bound parameters. jsonpath
 * literals cannot carry binds, so values embedded there (date times, jsonpath
 * filters) are built from validated/derived data only.
 */

import type { SqlTipo } from '../identifier_gate.ts';

/** Resolved context for one leaf (everything already gate-validated). */
export interface BuilderContext {
	/** Table alias in the current query (e.g. 'oh1', 'mix'). */
	alias: string;
	/** Matrix jsonb column for the component's model (e.g. 'string'). */
	column: string;
	/** The component's DATA tipo (e.g. 'oh62'; an alias's target) — gate-branded
	 * (identifier_gate.ts SqlTipo: minted only by asSqlTipo / resolveSqlDataTipo). */
	tipo: SqlTipo;
	/** The leaf path step's section tipo ('' when the step omits it) — the
	 * children builder resolves its paired parent against it; the index
	 * builder scopes the dd96 reference scan by it. */
	sectionTipo: string;
	/** Physical table (needed by self-join shapes). */
	table: string;
	/** Effective language for the comparison ('lg-*' or 'all'). */
	lang: string;
	/** Whether the component data is language-translatable. */
	translatable: boolean;
	/** The component model (dispatch key). */
	model: string;
	/**
	 * component_date leaves only: the ontology node's `date_mode` property
	 * ('date' | 'range' | 'period' | 'time' | 'date_time'), which selects the
	 * per-mode SQL handler exactly as PHP get_date_search_context does. Absent
	 * ⇒ PHP's own `?? 'date'` fallback; an unrecognised value THROWS in the
	 * builder rather than emitting a silently empty predicate.
	 */
	dateMode?: string;
	/**
	 * string-column leaves only: the physical table is COVERED by the
	 * matrix_string_search per-value store (its sync trigger exists — see
	 * search_store.ts), so builder_string may prepend its trigram-served
	 * contains pre-filter. Absent/false → the builder emits its exact classic
	 * SQL (byte-identical, store-less behavior).
	 */
	searchStoreCovered?: boolean;
	/**
	 * relation-family leaves only: a full SQL EXPRESSION to compare against in
	 * place of the default `<alias>.<column>`. Built by the builder itself from
	 * already-gated identifiers — never from leaf input — so it carries the same
	 * security invariant as `column`. Its one use is the autocomplete_hi ancestor
	 * wrap, which must read `relation_search` NULL-safely on its NEGATING arm:
	 * that column is NULL on 1964 of 2175 live `matrix` rows, and three-valued
	 * logic turned `NOT (NULL @> q)` into NULL, hiding 72 of 76 `oh1` records
	 * from a "different from X" search.
	 */
	columnExpr?: string;
}

/** A resolved SQL fragment: sentence with _Q1_-style tokens + their values. */
export interface Fragment {
	kind: 'fragment';
	sentence: string;
	/** token → value; insertion order must match token order in the sentence. */
	tokenValues: Record<string, unknown>;
	/**
	 * Set ONLY by builder_referenced_by.ts on a rendered source-set expansion:
	 * the statement this fragment lands in carries a `referenced_by` leaf, so
	 * the search executor bounds it (search/search_statement.ts).
	 */
	expandsReferencedBy?: true;
}

/** A boolean grouping of sub-results (resolved recursively by the parser). */
export interface CompoundFragment {
	kind: 'compound';
	op: '$and' | '$or';
	items: BuilderResult[];
}

export type BuilderResult = false | Fragment | CompoundFragment;

export function fragment(sentence: string, tokenValues: Record<string, unknown> = {}): Fragment {
	return { kind: 'fragment', sentence, tokenValues };
}

export function compound(op: '$and' | '$or', items: BuilderResult[]): CompoundFragment {
	return { kind: 'compound', op, items };
}

/**
 * Normalize a q payload to a plain string (PHP extract_normalized_q):
 * unwraps [scalar] and [{value:…}] shapes. Returns null when q is absent.
 */
export function extractNormalizedQ(q: unknown): string | null {
	let value = q;
	if (Array.isArray(value)) {
		value = value[0];
	}
	if (value !== null && typeof value === 'object' && 'value' in (value as object)) {
		value = (value as { value: unknown }).value;
	}
	if (value === undefined || value === null) {
		return null;
	}
	return String(value);
}

/**
 * Split a q string into search tokens (PHP split_search_terms): operators and
 * wildcards are glued to their word, then whitespace-split.
 */
export function splitSearchTerms(q: string): string[] {
	const compacted = q.replace(/(!=|==|!!|!\*|=|-)\s+/g, '$1').replace(/\s+(\*)/g, '$1');
	return compacted.split(/\s/).filter((token) => token.length > 0);
}

/**
 * Regex metacharacters — THE DECLARED CLASS.
 *
 * A curator's search term is TEXT, never a program. Every `~*` operand in this
 * family is a bound parameter that Postgres compiles as a POSIX regex, so a
 * term like `Denarius [sic]` used to become a character class and match
 * `Denariuss`, `Denariusi`, `Denariusc` — and `sar(de` used to be a SYNTAX
 * ERROR reaching the curator as an internal failure.
 *
 * The class is DECLARATIVE: it names what a metacharacter IS, for the corpus
 * distribution and for the gates. It is NOT the escaper — see
 * `regexOperand` below for why the escape cannot happen in TypeScript.
 */
export const REGEX_META = /[.*+?[\]{}()|\\^$]/;

/**
 * The SQL function that makes a term literal: `f_regex_literal(text)`,
 * declared in `src/core/db/db_pg_definitions.json` (ar_function) and applied
 * to existing installs by `install/db/migrations/0009_search_literal_escape.sql`.
 */
export const REGEX_LITERAL_FN = 'f_regex_literal';

/** The LIKE twin: `f_like_literal(text)` escapes `\\`, `%` and `_`. */
export const LIKE_LITERAL_FN = 'f_like_literal';

/**
 * THE OPERAND of every `~*` in this family — escape on the SQL side of
 * `f_unaccent`, never before it (DATA-34, corrected 2026-09-05).
 *
 * WHY NOT IN TYPESCRIPT. Every operand is normalized with `f_unaccent`, i.e.
 * Postgres's own `unaccent` dictionary, and that dictionary EXPANDS characters
 * INTO metacharacters: `×`→`*`, `©`→`(C)`, `…`→`...`, `∖`→`\\`, `¿`→`?`,
 * `±`→`+/-`, `⁅`→`[`, `‖`→`||`, `⑴`→`(1)` … (170 such rules in the shipped
 * unaccent.rules). A TypeScript escape runs BEFORE that expansion, so it
 * neutralises metacharacters that do not exist yet: `Museo © 1998` still
 * compiled as `Museo (C) 1998` and matched `Museo C 1998` while NOT matching
 * the record that literally says `Museo © 1998`, and `12 × 8` raised
 * `invalid regular expression: quantifier operand invalid`. Escaping AFTER
 * `f_unaccent` is the only order under which the pattern Postgres compiles is
 * the text the curator typed.
 *
 * BOUNDARY: this wraps only the OPERANDS of `~*`. The equality shapes
 * (`=`, `==`, quoted literal) compare with `=` and MUST keep the plain
 * `f_unaccent(_Qn_)`, or an exact search would stop finding the value the
 * curator typed. Anchors compose OUTSIDE the escaped operand
 * (`'^' || regexOperand(...)`), and Dedalo's own wildcard `*` is stripped from
 * `q` before binding — it is a Dedalo wildcard, not a regex one.
 */
export function regexOperand(token: string): string {
	return `${REGEX_LITERAL_FN}(f_unaccent(${token}))`;
}

/**
 * SQL's text concatenation operator, as a named constant.
 *
 * NOT tidiness: a literal `|| ${…}` is the shape GATE-18 (ws_a_tripwires) reads
 * as a VALUE bound into a jsonb concat — a write-path question it must keep
 * answering strictly. These read-path fragments concatenate SQL TEXT, never a
 * bind, so they name the operator instead of spelling a hole behind it.
 */
const SQL_CONCAT = ' || ';

/**
 * The same operand ANCHORED — `begins` for a trailing Dedalo wildcard, `ends`
 * for a leading one. The anchor composes OUTSIDE the escape (it is the
 * builder's own regex syntax, not the curator's text), and the composition
 * lives HERE rather than in each builder so no emitted literal ever spells
 * `|| ${…}` — a jsonb-concat-shaped hole the write-path scanner (GATE-18) must
 * read as a bind.
 */
export function anchoredRegexOperand(token: string, anchor: 'begins' | 'ends'): string {
	return anchor === 'begins'
		? `('^'${SQL_CONCAT}${regexOperand(token)})`
		: `(${regexOperand(token)}${SQL_CONCAT}'$')`;
}

/**
 * The trigram pre-filter's LIKE operand — the SAME order, for the same reason:
 * `%`, `_` and `\\` are LIKE's own class, and `unaccent` expands `％`→`%`,
 * `﹪`→`%` and `＿`→`_`, so a TypeScript-side LIKE escape leaves the superset
 * disagreeing with the (literal) exact predicate on exactly those terms.
 */
export function likeOperand(token: string): string {
	return `${LIKE_LITERAL_FN}(lower(f_unaccent(${token})))`;
}

/** The trigram pre-filter's whole LIKE pattern: a literal CONTAINS of the term. */
export function likeContainsPattern(token: string): string {
	return `'%'${SQL_CONCAT}${likeOperand(token)}${SQL_CONCAT}'%'`;
}

/** PHP search::is_literal — q wrapped in single quotes means exact match. */
export function isLiteralQ(q: string): boolean {
	return q.length >= 2 && q.startsWith("'") && q.endsWith("'");
}

/**
 * STRUCTURED builder options — the INTERNAL twins of the deep-search
 * classifiers. They travel as a typed argument, never as a q string, so no
 * SQO a client sends can reach them (they are not wire-reachable operators).
 *
 * - `mode: 'nonEmpty'`     — json: some entry carries a non-empty value (the
 *                             positive body of '!*').
 * - `mode: 'containsRaw'`  — string/iri/json: the POSITIVE body of the '-'
 *                             not-contain branch, byte-for-byte (raw term, no
 *                             operator stripping, lang kept) — so NOT EXISTS
 *                             over it is exactly the shallow negation lifted.
 * - `mode: 'hasEntries'`   — string/iri: the lang-scoped entries-exist guard
 *                             of '!=' (entries with EMPTY values count — the
 *                             exact guard, which '*' is not).
 * - `mode: 'differentTwin'` — string: the positive body of '!=' (q = the term
 *                             after '!=', wildcards kept, anchors as '!=' reads
 *                             them) — no re-parse through the q grammar.
 * - `aggTable`/`aggAcl`     — '!!': the duplicate aggregate reads this table
 *                             restricted by this record predicate (a deep hop's
 *                             SEC-02 ACL), so a hidden record never makes a
 *                             visible one a "duplicate".
 */
export interface BuilderOpts {
	mode?: 'nonEmpty' | 'containsRaw' | 'hasEntries' | 'differentTwin';
	aggTable?: string;
	aggAcl?: (alias: string) => string;
}

/** A builder invocation: what the deep renderer runs INSIDE its semi-join. */
export interface BuilderTwin {
	q: unknown;
	qOperator: string | null;
	opts?: BuilderOpts;
}

/**
 * The deep-search POLARITY of one leaf (engineering/wire_contract
 * WC-2026-09-29-search-deep-leaf-mixed-rule). Over R = the visible records a
 * deep path reaches:
 *   - pos: EXISTS r in R: P(r)                       (the builder itself)
 *   - neg: NOT EXISTS r in R: twin(r)
 *   - neq: EXISTS r in R: has(r) AND NOT EXISTS r in R: twin(r)
 * Every twin/has is POSITIVE. The shallow builder SQL is unaffected by the
 * classification (it only dispatches on `op`).
 */
export type LeafPolarity =
	| { kind: 'pos' }
	| { kind: 'neg'; twin: BuilderTwin }
	| { kind: 'neq'; has: BuilderTwin; twin: BuilderTwin };

/** A classifier's answer: the polarity plus the ONE parsed operator the builder dispatches on. */
export type Classified<Op extends string> = LeafPolarity & { op: Op };

export const POSITIVE: { kind: 'pos' } = Object.freeze({ kind: 'pos' }) as { kind: 'pos' };

/** '<op><q>' — the glued effective operator string every text family dispatches on. */
export function effectiveOf(rawQ: unknown, qOperator: string | null): string {
	const q = extractNormalizedQ(rawQ) ?? '';
	const operator = qOperator ?? '';
	return operator !== '' ? operator + q : q;
}

/**
 * The deep '!!' ACL restriction of the duplicate aggregate (BuilderOpts
 * aggAcl): '' on a shallow leaf, so the shallow sentence is byte-identical.
 */
export function aggAclClause(opts: BuilderOpts | undefined): string {
	return opts?.aggAcl ? ` AND (${opts.aggAcl('m2')})` : '';
}
