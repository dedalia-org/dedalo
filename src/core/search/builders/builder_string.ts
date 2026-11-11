/**
 * String-family fragment builder — component_input_text / component_text_area /
 * component_email (matrix column 'string').
 *
 * PHP reference: core/component_string_common/trait.search_component_string_common.php.
 * Data shape: {"<tipo>": [{"lang":"lg-spa","value":"Título"}, …]}.
 *
 * Operator dispatch (PHP precedence): '!*' empty, '*' not-empty, '!=' different,
 * '==' exact, '-' not-contain, wildcard/literal shapes, default contains.
 * All text matching is case- and accent-insensitive via f_unaccent(...) ~*.
 *
 * NOT YET COVERED (logged, plan §9 no-silent-narrowing): the
 * matrix_time_machine (_tm) builder twin. It throws.
 */

import { DedaloError } from '../../errors/dedalo_error.ts';
import type { BuilderContext, BuilderOpts, BuilderResult, Classified, Fragment } from './types.ts';
import {
	aggAclClause,
	anchoredRegexOperand,
	compound,
	effectiveOf,
	extractNormalizedQ,
	fragment,
	isLiteralQ,
	likeContainsPattern,
	regexOperand,
	splitSearchTerms,
} from './types.ts';

/** The lang-scoped jsonpath used by @? existence envelopes. */
function buildJsonPath(context: BuilderContext): string {
	return context.lang === 'all'
		? `$.${context.tipo}[*]`
		: `$.${context.tipo}[*] ? (@.lang == "${context.lang}")`;
}

/** The standard envelope: record has matching entries AND EXISTS(match). */
function existsEnvelope(context: BuilderContext, matchLogic: string): string {
	const jsonPath = buildJsonPath(context);
	return (
		`(${context.alias}.${context.column} @? '${jsonPath}') AND EXISTS (` +
		`SELECT 1 FROM jsonb_path_query(${context.alias}.${context.column}, '${jsonPath}') AS elem ` +
		`WHERE ${matchLogic})`
	);
}

/**
 * SEARCH-STORE PRE-FILTER for POSITIVE match shapes (contains / begins /
 * ends / equal / literal): the matrix_string_search per-value store queried
 * as `section_id = ANY (ARRAY(SELECT … WHERE sv.component_tipo = <tipo> AND
 * sv.string LIKE '%<q>%'))` — the composite btree_gin index
 * (component_tipo, string gin_trgm_ops) resolves the tipo equality AND
 * the trigram containment in ONE index scan, so the bitmap holds exactly
 * this component's matching values and the recheck runs on one short value
 * (rsc205 'sarde': 1.4s classic scan → ~20-50ms; whole-record expression
 * indexes were measured counterproductive, 2026-07-19 — TOASTed
 * re-flattening per recheck row — and a two-separate-indexes layout measured
 * 945ms whenever the planner skipped the BitmapAnd).
 *
 * SHAPE MATTERS: the subquery is deliberately UNCORRELATED so it plans as a
 * one-shot InitPlan and the main table is ENTERED by section_id — the
 * correlated-EXISTS variant let the planner semi-join from the matrix side
 * (jsonb-selectivity misestimates) and re-run the slow exact predicate on
 * every row (measured 1.4s vs 48ms). No section_tipo condition inside: a
 * shared component tipo may span sections and the multi-section UNION
 * replicates this WHERE verbatim into every branch — cross-section ids only
 * WIDEN the superset (the outer section_tipo pin + the exact predicate still
 * decide), never narrow it.
 *
 * The clause is a strict SUPERSET of every positive per-value match (store
 * rows are lower(f_unaccent(value)) of the same values, all langs), so the
 * exact EXISTS predicate that follows still decides membership.
 *
 * Emitted ONLY when:
 * - the table is store-covered (context.searchStoreCovered — the sync
 *   trigger exists; see search_store.ts: against an unmaintained table the
 *   empty store would wrongly EXCLUDE rows, so the gate is correctness);
 * - NO regex-plainness gate any more
 *   (DATA-34): every `~*` operand is now `f_regex_literal`-escaped in SQL,
 *   so the exact predicate is a LITERAL substring/anchor match for EVERY term
 *   — the pre-filter and the exact predicate agree on metacharacter-carrying
 *   terms too, which is exactly the class that used to fall back to the slow
 *   classic scan. The RAW (unescaped) q is what the pre-filter must match, so
 *   the two arrive separately: `tokenValues` carries the escaped pattern,
 *   `likeQ` the raw term, LIKE-escaped here (`% _ \\`);
 * - q has at least 3 characters: pg_trgm cannot extract trigrams from a
 *   shorter pattern, so `LIKE '%a%'` degenerates into a full store scan
 *   feeding a giant id array (measured: a 1-char autocomplete search went to
 *   31s, 2026-07-20). Short q's are also exactly where the CLASSIC path is
 *   fast — a common substring fills the ordered LIMIT walk almost instantly.
 * Never emitted for negations ('!*', '!=', '-') or bare '*'. The '!!'
 * duplicated shape has NO q at all and carries its own store superset (below),
 * which is a different clause built from the store's own duplicate groups.
 */
const TRGM_MIN_Q_LENGTH = 3;

function withStorePrefilter(
	context: BuilderContext,
	sentence: string,
	tokenValues: Record<string, unknown>,
	/** The RAW term the value must literally contain (escaped in SQL, after unaccent). */
	rawQ: string,
): Fragment {
	if (context.searchStoreCovered !== true || [...rawQ].length < TRGM_MIN_Q_LENGTH) {
		return fragment(sentence, tokenValues);
	}
	// LIKE's own wildcards and its escape character are literal characters in
	// the (now literal) exact predicate — `likeOperand` escapes them ON THE SQL
	// SIDE OF f_unaccent, the same order the exact predicate uses, or the
	// superset and the predicate disagree on every term unaccent expands into
	// one of them (`％`→`%`, `＿`→`_`).
	return fragment(
		`${context.alias}.section_id = ANY (ARRAY(SELECT sv.section_id FROM matrix_string_search sv ` +
			`WHERE sv.component_tipo = _Qt_ AND sv.string LIKE ${likeContainsPattern('_Q0_')})) AND ${sentence}`,
		{ _Qt_: context.tipo, _Q0_: rawQ, ...tokenValues },
	);
}

/**
 * '!!' — DUPLICATED values, extracted so the operator dispatch stays under the
 * complexity cap: the branch carries its own lang/store decisions and none of
 * them depend on q.
 */
/** The lang a '!!' duplicate compares within ('all' = lang-blind). */
function duplicateLang(context: BuilderContext): string {
	if (context.lang === 'all') return 'all';
	return context.translatable ? context.lang : 'lg-nolan';
}

function buildDuplicatedFragment(context: BuilderContext, opts?: BuilderOpts): Fragment {
	const dupLang = duplicateLang(context);
	const jsonPath =
		dupLang === 'all' ? `$.${context.tipo}[*]` : `$.${context.tipo}[*] ? (@.lang == "${dupLang}")`;
	const duplicatedSet = `(${context.alias}.section_tipo, ${context.alias}.section_id) IN (
  SELECT dup.section_tipo, dup_id
  FROM (
    SELECT dv.section_tipo AS section_tipo, array_agg(DISTINCT dv.section_id) AS ids
    FROM (SELECT m2.section_tipo AS section_tipo, m2.section_id AS section_id,
                 f_unaccent(m2_elem->>'value') AS val
          FROM ${opts?.aggTable ?? context.table} AS m2,
               jsonb_path_query(m2.${context.column}, '${jsonPath}') AS m2_elem
          WHERE m2_elem->>'value' IS NOT NULL${aggAclClause(opts)}) dv
    GROUP BY dv.section_tipo, dv.val
    HAVING count(DISTINCT dv.section_id) > 1
  ) dup, unnest(dup.ids) AS dup_id
 )`;
	if (context.searchStoreCovered === true && dupLang === 'all') {
		// Store SUPERSET (lang-blind comparison only): every record whose value
		// duplicates another's is in a store group of >1 distinct section_id —
		// the store normalises with lower(), which is WIDER than the exact
		// predicate's case-sensitive f_unaccent equality, so the AND still
		// decides. The tipo travels bound, exactly as in withStorePrefilter.
		return fragment(
			`${context.alias}.section_id = ANY (ARRAY(SELECT sv.section_id FROM matrix_string_search sv ` +
				`WHERE sv.component_tipo = _Qt_ AND sv.string IN (` +
				`SELECT sv2.string FROM matrix_string_search sv2 WHERE sv2.component_tipo = _Qt_ ` +
				`GROUP BY sv2.string HAVING count(DISTINCT sv2.section_id) > 1))) AND ${duplicatedSet}`,
			{ _Qt_: context.tipo },
		);
	}
	return fragment(duplicatedSet, {});
}

/** The one parsed operator of a string leaf (what the builder dispatches on). */
export type StringOp =
	| 'none'
	| 'empty'
	| 'notEmpty'
	| 'duplicated'
	| 'different'
	| 'exact'
	| 'equal'
	| 'notContains'
	| 'literal'
	| 'wildcard'
	| 'contains'
	| 'containsRaw'
	| 'hasEntries'
	| 'differentTwin';

/**
 * THE string-family classifier — the ONE parse of '<op><q>' (PHP precedence)
 * and its deep-search polarity (types.ts LeafPolarity). buildStringFragment
 * calls it at its top and dispatches on `op`, so the shallow SQL and the deep
 * polarity can never read the operator differently.
 *
 * Polarity: '!*' neg(twin '*'), '-x' neg(twin containsRaw x, lang kept),
 * '!=x' neq(has hasEntries, twin differentTwin x); everything else pos.
 * q_split is NOT decided here — a split q is classified per token by the
 * caller (positive tokens share one semi-join, negative ones get their own).
 */
export function classifyString(
	rawQ: unknown,
	qOperator: string | null,
	opts?: BuilderOpts,
): Classified<StringOp> {
	if (
		opts?.mode === 'containsRaw' ||
		opts?.mode === 'hasEntries' ||
		opts?.mode === 'differentTwin'
	) {
		return { kind: 'pos', op: opts.mode };
	}
	if (opts?.mode !== undefined) {
		throw new DedaloError('internal.invariant', {
			message: `builder_string: unsupported internal mode '${opts.mode}'`,
		});
	}
	const effective = effectiveOf(rawQ, qOperator);
	if (effective === '') return { kind: 'pos', op: 'none' };
	if (effective.startsWith('!*')) {
		return { kind: 'neg', op: 'empty', twin: { q: '*', qOperator: null } };
	}
	if (effective === '*') return { kind: 'pos', op: 'notEmpty' };
	if (effective.startsWith('!!')) return { kind: 'pos', op: 'duplicated' };
	if (effective.startsWith('!=')) {
		return {
			kind: 'neq',
			op: 'different',
			has: { q: '', qOperator: null, opts: { mode: 'hasEntries' } },
			twin: { q: effective.slice(2), qOperator: null, opts: { mode: 'differentTwin' } },
		};
	}
	if (effective.startsWith('==')) return { kind: 'pos', op: 'exact' };
	if (effective.startsWith('=')) return { kind: 'pos', op: 'equal' };
	if (effective.startsWith('-')) {
		return {
			kind: 'neg',
			op: 'notContains',
			twin: { q: effective.slice(1), qOperator: null, opts: { mode: 'containsRaw' } },
		};
	}
	if (isLiteralQ(effective)) return { kind: 'pos', op: 'literal' };
	if (effective.startsWith('*') || effective.endsWith('*')) return { kind: 'pos', op: 'wildcard' };
	return { kind: 'pos', op: 'contains' };
}

/** The '!=' match logic over the term after '!=' (wildcards read as anchors). */
function differentMatchLogic(rest: string): string {
	const hasLead = rest.startsWith('*');
	const hasTrail = rest.endsWith('*');
	return hasLead && hasTrail
		? `f_unaccent(elem->>'value') ~* ${regexOperand('_Q1_')}`
		: hasLead
			? `f_unaccent(elem->>'value') ~* ${anchoredRegexOperand('_Q1_', 'ends')}`
			: hasTrail
				? `f_unaccent(elem->>'value') ~* ${anchoredRegexOperand('_Q1_', 'begins')}`
				: // case-insensitive like the wildcard arms: '!=' is the complement of '=' (WC-014)
					`lower(f_unaccent(elem->>'value')) = lower(f_unaccent(_Q1_))`;
}

/** The '-' match body (raw term, lang as bound _Q2_, no lang in the path). */
function notContainsBody(context: BuilderContext, qClean: string): Fragment {
	const langFilter = context.lang !== 'all' ? ` AND elem->>'lang' = _Q2_` : '';
	const tokenValues: Record<string, unknown> =
		context.lang !== 'all' ? { _Q1_: qClean, _Q2_: context.lang } : { _Q1_: qClean };
	return fragment(
		`SELECT 1 FROM jsonb_path_query(${context.alias}.${context.column}, '$.${context.tipo}[*]') AS elem ` +
			`WHERE elem->>'value' IS NOT NULL AND f_unaccent(elem->>'value') ~* ${regexOperand('_Q1_')}${langFilter}`,
		tokenValues,
	);
}

export function buildStringFragment(
	rawQ: unknown,
	qOperator: string | null,
	qSplit: boolean,
	context: BuilderContext,
	opts?: BuilderOpts,
): BuilderResult {
	const q = extractNormalizedQ(rawQ) ?? '';
	const operator = qOperator ?? '';
	if (opts?.mode === undefined && q === '' && operator === '') {
		return false;
	}

	// q_split: fan each word out as an independent leaf, AND-joined.
	if (opts?.mode === undefined && qSplit && q !== '') {
		const tokens = splitSearchTerms(q);
		if (tokens.length > 1) {
			return compound(
				'$and',
				tokens.map((token) => buildStringFragment(token, qOperator, false, context)),
			);
		}
	}

	// Operator prefixes may arrive glued to q (e.g. '!=word') — PHP dispatches
	// on the leading characters of q when q_operator is not set. The ONE parse
	// is classifyString's.
	const effective = operator !== '' ? operator + q : q;
	const { op } = classifyString(rawQ, qOperator, opts);

	switch (op) {
		case 'none':
			return false;
		case 'containsRaw': {
			const body = notContainsBody(context, q);
			return fragment(`EXISTS (${body.sentence})`, body.tokenValues);
		}
		case 'hasEntries':
			return fragment(`(${context.alias}.${context.column} @? '${buildJsonPath(context)}')`);
		case 'differentTwin': {
			const jsonPath = buildJsonPath(context);
			return fragment(
				`EXISTS (SELECT 1 FROM jsonb_path_query(${context.alias}.${context.column}, '${jsonPath}') AS elem ` +
					`WHERE ${differentMatchLogic(q)})`,
				{ _Q1_: q.replaceAll('*', '') },
			);
		}
		case 'empty': {
			// '!*' — empty (no value for this lang, or column NULL)
			const path =
				context.lang === 'all'
					? `$.${context.tipo}[*].value ? (@ != "" && @ != null)`
					: `$.${context.tipo}[*] ? (@.lang == "${context.lang}" && @.value != "" && @.value != null)`;
			return fragment(
				`(${context.alias}.${context.column} IS NULL OR NOT (${context.alias}.${context.column} @? (_Q1_)::jsonpath))`,
				{ _Q1_: path },
			);
		}
		case 'notEmpty': {
			const path =
				context.lang === 'all'
					? `$.${context.tipo}[*].value ? (@ != "" && @ != null)`
					: `$.${context.tipo}[*] ? (@.lang == "${context.lang}" && @.value != "" && @.value != null)`;
			return fragment(`${context.alias}.${context.column} @? (_Q1_)::jsonpath`, { _Q1_: path });
		}
		// '!!' — DUPLICATED values: rows whose value (this lang) also appears on
		// ANOTHER record of the same section, unaccent-compared (PHP
		// resolve_duplicated_sql; non-translatable components force nolan).
		//
		// ONE UNCORRELATED SELF-AGGREGATE, materialised once per query (PERF-07,
		// 2026-09-05). The PHP shape this replaces was a CORRELATED EXISTS whose
		// inner FROM cross-joined the WHOLE matrix table with two
		// jsonb_path_query calls and was re-executed for EVERY outer row — O(n^2)
		// jsonpath evaluations, which on a museum-scale section is not slow but
		// unfinishable. The duplicate set does not depend on the outer row at all:
		// it is `group the lang-projected values, keep the groups holding more than
		// one record`, computed ONCE. Same rows, O(n log n).
		//
		// Section-exact by TUPLE, not by id: the groups are keyed by section_tipo
		// as well, and membership is asked as (section_tipo, section_id) — a bare
		// `section_id IN (…)` would let a duplicate pair in ANOTHER tipo of the
		// same physical table match a same-numbered record here.
		//
		// Lang-exact WITHOUT the store: `matrix_string_search` has no lang column
		// (db_pg_definitions.json), so it can only ever be a SUPERSET pre-filter,
		// and only when the comparison itself is lang-blind ('all'). No lang column
		// is added to the store here.
		//
		// VALUELESS ENTRIES ARE NOT DUPLICATES. The retired correlated shape
		// compared `f_unaccent(a) = f_unaccent(b)`, and NULL never equals NULL, so
		// entries carrying no `value` key could not pair. `GROUP BY` treats NULLs as
		// EQUAL, so the aggregate would report every such record as a duplicate of
		// every other — a widening of the answer, not of the plan. The inner
		// projection drops them.
		case 'duplicated':
			return buildDuplicatedFragment(context, opts);
		case 'different': {
			// '!=' — has data for the lang AND no entry matches. The term travels
			// RAW in every arm: the wildcard arms make it literal in SQL
			// (`regexOperand`, after f_unaccent), the plain arm compares with '='
			// and must keep it raw (DATA-34 boundary).
			const rest = effective.slice(2);
			const jsonPath = buildJsonPath(context);
			return fragment(
				`(${context.alias}.${context.column} @? '${jsonPath}') AND NOT EXISTS (` +
					`SELECT 1 FROM jsonb_path_query(${context.alias}.${context.column}, '${jsonPath}') AS elem ` +
					`WHERE ${differentMatchLogic(rest)})`,
				{ _Q1_: rest.replaceAll('*', '') },
			);
		}
		case 'exact': {
			// '==' — exactly equal: accent-insensitive, CASE-SENSITIVE (the import
			// tools' find-or-create lookups rely on it: codes, URLs)
			const qClean = effective.slice(2);
			return withStorePrefilter(
				context,
				existsEnvelope(context, `f_unaccent(elem->>'value') = f_unaccent(_Q1_)`),
				{ _Q1_: qClean },
				qClean,
			);
		}
		case 'equal': {
			// '=' — exactly equal, the single-char twin of '==' (TS-BEYOND-PHP,
			// owner-directed 2026-07-09: PHP has no single '=' operator — it
			// silently STRIPS the '=' and runs contains, so short names like
			// 'Ea'/'Ye'/'Ibi' drowned in 1000+ contains-matches and could never be
			// picked. The splitSearchTerms tokenizer already glued '=' to its word;
			// q_split multi-word input fans out per-word, each exact). Quoted
			// literals ('Ea') keep working as before on both engines.
			const qClean = effective.slice(1).replaceAll("'", '');
			if (qClean === '') return false;
			// accent- AND case-insensitive (WC-014): '=vic' finds 'Vic'. Unlike '==',
			// which stays case-sensitive for programmatic exact lookups.
			return withStorePrefilter(
				context,
				existsEnvelope(context, `lower(f_unaccent(elem->>'value')) = lower(f_unaccent(_Q1_))`),
				{ _Q1_: qClean },
				qClean,
			);
		}
		case 'notContains': {
			// '-' — not contain (lang as bound param _Q2_, no lang in path)
			const body = notContainsBody(context, effective.slice(1));
			return fragment(`NOT EXISTS (${body.sentence})`, body.tokenValues);
		}
		case 'literal': {
			// Literal 'text' — exact equality, quotes stripped, no wildcard handling.
			const qClean = effective.slice(1, -1);
			return withStorePrefilter(
				context,
				existsEnvelope(context, `f_unaccent(elem->>'value') = f_unaccent(_Q1_)`),
				{ _Q1_: qClean },
				qClean,
			);
		}
		case 'wildcard': {
			// Wildcard anchoring: leading '*' = ends-with, trailing '*' = begins-with.
			const hasLead = effective.startsWith('*');
			const hasTrail = effective.endsWith('*');
			const qClean = effective.replaceAll('*', '').replaceAll("'", '');
			const matchLogic =
				hasLead && hasTrail
					? `f_unaccent(elem->>'value') ~* ${regexOperand('_Q1_')}`
					: hasLead
						? `f_unaccent(elem->>'value') ~* ${anchoredRegexOperand('_Q1_', 'ends')}`
						: `f_unaccent(elem->>'value') ~* ${anchoredRegexOperand('_Q1_', 'begins')}`;
			// Anchored variants still pre-filter on the plain (unanchored) RAW q —
			// a value matching '^q'/'q$' contains q, so the superset holds.
			return withStorePrefilter(
				context,
				existsEnvelope(context, matchLogic),
				{ _Q1_: qClean },
				qClean,
			);
		}
		case 'contains': {
			// Default: contains (regex, accent/case-insensitive). Strip '+ * ='.
			const qClean = effective.replace(/[+*=]/g, '');
			if (qClean === '') {
				return false;
			}
			return withStorePrefilter(
				context,
				existsEnvelope(context, `f_unaccent(elem->>'value') ~* ${regexOperand('_Q1_')}`),
				{ _Q1_: qClean },
				qClean,
			);
		}
	}
}
