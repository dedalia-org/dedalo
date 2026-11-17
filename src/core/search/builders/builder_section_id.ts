/**
 * section_id fragment builder — component_section_id (REAL int column, not JSONB).
 *
 * PHP reference: core/component_section_id/trait.search_component_section_id.php.
 * The q may carry the operator as a prefix (PHP prepends q_operator to q).
 *
 * Operators: '...' between (as an $and compound), ',' sequence (= ANY array),
 * '!=', '>=', '<=', '>', '<', default '='. Values digit-stripped.
 */

import type { BuilderContext, BuilderResult, Classified } from './types.ts';
import { compound, extractNormalizedQ, fragment } from './types.ts';

/** Strip everything but digits (PHP preg_replace('/[^0-9]/','')). */
function digitsOnly(value: string): string {
	return value.replace(/[^0-9]/g, '');
}

/** q → string (PHP unwraps locator-shaped q: {value} then {section_id}). */
function sectionIdQ(rawQ: unknown): string | null {
	let q = extractNormalizedQ(rawQ);
	if (q === null && rawQ !== null && typeof rawQ === 'object' && 'section_id' in (rawQ as object)) {
		q = String((rawQ as { section_id: unknown }).section_id);
	}
	return q;
}

/** The one parsed operator of a section_id leaf. */
export type SectionIdOp = 'none' | 'between' | 'sequence' | 'compare' | 'notEqual' | 'equal';

/**
 * THE section_id classifier (see builder_string classifyString — same law).
 * Polarity: '!=n' NEG(twin '=n') — on a deep path "no related record has id
 * n", TRUE when there is no relation at all (owner decision D2 2026-09-24,
 * WC-2026-09-29-search-deep-leaf-mixed-rule); everything else pos. A '!=' with no digits
 * drops the clause (the builder returns false), so it classifies 'none' — and
 * so does a '...' with no digits on EITHER side (owner C41 2026-11-13, ruled
 * (b) open half-range: an empty range is an empty input, not PHP's `>= 0 AND
 * <= 0`; WC-2026-11-12-section-id-open-between addendum).
 */
export function classifySectionId(
	rawQ: unknown,
	qOperator: string | null,
): Classified<SectionIdOp> {
	const effective = `${qOperator ?? ''}${sectionIdQ(rawQ) ?? ''}`;
	if (effective === '') return { kind: 'pos', op: 'none' };
	if (effective.includes('...')) {
		const { low, high } = parseSectionIdBetween(effective);
		return { kind: 'pos', op: low === null && high === null ? 'none' : 'between' };
	}
	if (effective.includes(',')) return { kind: 'pos', op: 'sequence' };
	if (effective.startsWith('!=')) {
		const value = digitsOnly(effective.slice(2));
		if (value === '') return { kind: 'pos', op: 'none' };
		return { kind: 'neg', op: 'notEqual', twin: { q: value, qOperator: null } };
	}
	if (['>=', '<=', '>', '<'].some((comparison) => effective.startsWith(comparison))) {
		return { kind: 'pos', op: 'compare' };
	}
	return { kind: 'pos', op: 'equal' };
}

/** The two bounds of an 'a...b' q, digits-only; null when that side is empty. */
export function parseSectionIdBetween(effective: string): {
	low: string | null;
	high: string | null;
} {
	const [lowRaw, highRaw] = effective.split('...');
	const low = digitsOnly(lowRaw ?? '');
	const high = digitsOnly(highRaw ?? '');
	return { low: low === '' ? null : low, high: high === '' ? null : high };
}

/**
 * '...' between → $and of two comparisons (mirrors the PHP clone approach).
 * An OPEN range ('5...' / '...5') is an OPEN HALF-RANGE (owner C41, T1-35 D1
 * ruled (b) 2026-11-13): the typed bound is enforced, the absent side adds NO
 * predicate — '5...' = id ≥ 5, '...5' = id ≤ 5 (negative ids included). PHP
 * substituted low → 0 and high → low ('5...' meant exactly 5; recorded in
 * WC-2026-11-12-section-id-open-between). Returning false here (the pre-T1-35
 * shape) dropped the leaf and WIDENED the result to the whole section. '...'
 * with no digits on either side never reaches this branch: the classifier
 * answers 'none' (an empty input).
 */
function buildBetween(
	bounds: { low: string | null; high: string | null },
	idColumnSql: string,
	INT: string,
): BuilderResult {
	const predicates: BuilderResult[] = [];
	if (bounds.low !== null) {
		predicates.push(fragment(`${idColumnSql} >= _Q1_${INT}`, { _Q1_: bounds.low }));
	}
	if (bounds.high !== null) {
		predicates.push(fragment(`${idColumnSql} <= _Q1_${INT}`, { _Q1_: bounds.high }));
	}
	if (predicates.length === 2) return compound('$and', predicates);
	return predicates[0] ?? false;
}

export function buildSectionIdFragment(
	rawQ: unknown,
	qOperator: string | null,
	context: BuilderContext,
): BuilderResult {
	const effective = `${qOperator ?? ''}${sectionIdQ(rawQ) ?? ''}`;
	const { op } = classifySectionId(rawQ, qOperator);
	if (op === 'none') {
		return false;
	}
	const idColumnSql = `${context.alias}.section_id::integer`;
	// EVERY bind of a digit string against that integer column must carry its
	// own cast. Bun.sql sends a JS string as `text`, and Postgres has no
	// `integer = text` operator, so an uncast placeholder fails the whole query
	// with "operator does not exist: integer = text" — the search does not
	// return zero rows, it 500s. (The ANY branch below already casts, which is
	// why the ',' sequence was the one form that worked.) Digits-only is
	// enforced above, so the cast can never fail at runtime.
	const INT = '::integer';

	if (op === 'between') return buildBetween(parseSectionIdBetween(effective), idColumnSql, INT);
	// ',' sequence → = ANY('{a,b,c}'::integer[])
	if (op === 'sequence') {
		const ids = effective
			.split(',')
			.map(digitsOnly)
			.filter((id) => id !== '');
		if (ids.length === 0) return false;
		return fragment(`${idColumnSql} = ANY(_Q1_::integer[])`, { _Q1_: `{${ids.join(',')}}` });
	}
	// Comparison operators, longest first.
	for (const comparisonOperator of ['!=', '>=', '<=', '>', '<'] as const) {
		if ((op === 'notEqual' || op === 'compare') && effective.startsWith(comparisonOperator)) {
			const value = digitsOnly(effective.slice(comparisonOperator.length));
			if (value === '') return false;
			return fragment(`${idColumnSql} ${comparisonOperator} _Q1_${INT}`, { _Q1_: value });
		}
	}
	// Default '='
	const value = digitsOnly(effective);
	if (value === '') return false;
	return fragment(`${idColumnSql} = _Q1_${INT}`, { _Q1_: value });
}
