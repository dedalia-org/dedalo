/**
 * Search params model — positional prepared-statement values (spec §7.7).
 *
 * Contract:
 * - `params` is a 0-indexed sequential list; `$N` ↔ params[N-1].
 * - THE LAW: a placeholder is NEVER shared between fragments. getPlaceholder
 *   mints a fresh `$N` on every call, whatever value it is given — equal
 *   values from two fragments bind twice. Postgres infers ONE type per
 *   parameter from its first typed use: a `$N` shared by
 *   `section_id::integer = $N` and `f_unaccent($N)` is integer for both, and
 *   the text use dies with "function f_unaccent(integer) does not exist" (an
 *   autocomplete whose ddo_map searches a component_section_id FIRST and text
 *   components after, same q). The same hazard stands between every typed
 *   family (::integer, ::numeric, ::jsonpath, dates, iri vs text), in either
 *   order.
 * - PHP parity is DROPPED deliberately: PHP get_placeholder
 *   (trait.utils.php) deduped with array_search(…, true), which is safe only
 *   while every use of a value is typed alike — a property no builder can see
 *   across fragments. The cost is a few repeated bound values; the gain is
 *   that each fragment types its own placeholders independently.
 * - Component builders emit `sentence` fragments with named `_Q1_`/`_Q2_`
 *   tokens plus a token→value map; substitute() mints ONE placeholder per
 *   token (a token repeated inside its own sentence keeps that one `$N` via
 *   replaceAll — one fragment, one typing context), registering values in
 *   insertion order.
 * - A site that knows several uses share one typing context (same column,
 *   same cast) may memo its own placeholders locally — never the collector.
 *
 * Gate: test/unit/search_section_id_bind_native.test.ts — executes every typed
 * family sharing a literal with a text leaf, in both orders.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import type { BuilderResult, Fragment } from './builders/types.ts';

export class ParamsCollector {
	private readonly values: unknown[] = [];
	private referencedBy = false;

	/**
	 * @param firstPlaceholder — the number of this collector's FIRST placeholder
	 * (default `$1`). A fragment built for a statement that already binds N
	 * values of its own starts at N+1 (search/sql_assembler.ts
	 * buildRowsInScopeSql): the statement's params are then the other
	 * fragment's followed by `toArray()` — nothing is shared across the two, as
	 * nothing is shared anywhere (the header's law).
	 */
	constructor(private readonly firstPlaceholder = 1) {}

	/** Register a value and return a FRESH '$N' placeholder (never shared — see the header). */
	getPlaceholder(value: unknown): string {
		this.values.push(value);
		return `$${this.values.length - 1 + this.firstPlaceholder}`;
	}

	/**
	 * Resolve a component fragment: replace each named token (e.g. '_Q1_')
	 * with a fresh positional placeholder for its value — every occurrence of
	 * one token gets the SAME `$N` (one sentence, one typing context); two
	 * tokens never share one, even when their values are equal. Token iteration follows the
	 * map's insertion order, which must match token order in the sentence
	 * (same contract as the PHP builders).
	 */
	substitute(sentence: string, tokenValues: Record<string, unknown>): string {
		let resolved = sentence;
		for (const [token, value] of Object.entries(tokenValues)) {
			resolved = resolved.replaceAll(token, this.getPlaceholder(value));
		}
		return resolved;
	}

	/** The bound values, in placeholder order ($1 first). */
	toArray(): unknown[] {
		return [...this.values];
	}

	/**
	 * Did a `referenced_by` expansion render INTO this collector's statement?
	 * Set by {@link resolveBuilderResult} when it substitutes a fragment marked
	 * `expandsReferencedBy` (builder_referenced_by.ts) — what the build DID, read
	 * by the assembler into its SearchStatement (search/search_statement.ts), so
	 * the executor's bound never re-walks an SQO a caller could swap.
	 */
	get carriesReferencedBy(): boolean {
		return this.referencedBy;
	}

	/** Record that a `referenced_by` expansion rendered into this statement. */
	noteReferencedBy(): void {
		this.referencedBy = true;
	}
}

/**
 * A collector that mints NAMED tokens instead of `$N` placeholders — for SQL
 * resolved BEFORE the query knows whether it will emit it: a deep filter leaf's
 * per-hop ACL (sql_assembler buildPathScope → recordPredicate) is built at
 * conform time, and a leaf that ends up emitting nothing (a refused or inert
 * leaf) must leave no bound value behind — an unreferenced `$N` is a
 * Postgres error ("could not determine data type of parameter"). Like the base
 * class, every call mints a FRESH token (no value dedup); `tokenValues` is the substitute() map the real
 * collector consumes (substituteUsed) at render time. Tokens are
 * `_<prefix><n>_`: the trailing `_` keeps `_ACL1_` from being a substring of
 * `_ACL10_`.
 */
export class NamedTokenCollector extends ParamsCollector {
	readonly tokenValues: Record<string, unknown> = {};
	private minted = 0;

	constructor(private readonly prefix: string) {
		super();
	}

	override getPlaceholder(value: unknown): string {
		this.minted += 1;
		const token = `_${this.prefix}${this.minted}_`;
		this.tokenValues[token] = value;
		return token;
	}

	override toArray(): unknown[] {
		throw new DedaloError('internal.invariant', {
			message: 'NamedTokenCollector: named tokens are substituted, never bound directly',
		});
	}
}

/** substitute() limited to the tokens `sentence` actually contains (no orphan `$N`). */
export function substituteUsed(
	params: ParamsCollector,
	sentence: string,
	tokenValues: Record<string, unknown>,
): string {
	const used = Object.fromEntries(
		Object.entries(tokenValues).filter(([token]) => sentence.includes(token)),
	);
	return params.substitute(sentence, used);
}

/** Substitute one leaf fragment, noting a referenced_by expansion when it is marked as one. */
function resolveFragment(fragment: Fragment, params: ParamsCollector): string {
	if (fragment.expandsReferencedBy === true) params.noteReferencedBy();
	return params.substitute(fragment.sentence, fragment.tokenValues);
}

/** Resolve a BuilderResult into an SQL fragment string (or '' when empty). */
export function resolveBuilderResult(result: BuilderResult, params: ParamsCollector): string {
	if (result === false) return '';
	if (result.kind === 'fragment') return resolveFragment(result, params);
	// compound: recurse and join
	const parts = result.items
		.map((item) => resolveBuilderResult(item, params))
		.filter((part) => part !== '');
	if (parts.length === 0) return '';
	const joiner = result.op === '$and' ? '\n AND ' : '\n OR ';
	return parts.length === 1 ? (parts[0] as string) : `( ${parts.join(joiner)} )`;
}
