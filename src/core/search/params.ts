/**
 * Search params model — positional prepared-statement values (spec §7.7).
 *
 * PHP reference: trait.utils.php get_placeholder (:567) and
 * trait.where.php parse_search_object_sql (:539).
 *
 * Contract:
 * - `params` is a 0-indexed sequential list; `$N` ↔ params[N-1].
 * - getPlaceholder DEDUPS with STRICT comparison (PHP array_search(…, true)):
 *   1 (number) never collapses with '1' (string) or true — distinct typed
 *   values must produce distinct placeholders.
 * - Component builders emit `sentence` fragments with named `_Q1_`/`_Q2_`
 *   tokens plus a token→value map; substitute() swaps tokens for `$N`
 *   placeholders, registering values in insertion order.
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
	 * fragment's followed by `toArray()`, and no value is deduplicated ACROSS
	 * the two — a shared `$N` would have to carry one type in both, and the two
	 * fragments cast independently.
	 */
	constructor(private readonly firstPlaceholder = 1) {}

	/** Register a value (strict-dedup) and return its '$N' placeholder. */
	getPlaceholder(value: unknown): string {
		// Strict search: types must match exactly (mirrors PHP array_search strict).
		let index = this.values.indexOf(value);
		if (index === -1) {
			this.values.push(value);
			index = this.values.length - 1;
		}
		return `$${index + this.firstPlaceholder}`;
	}

	/**
	 * Resolve a component fragment: replace each named token (e.g. '_Q1_')
	 * with a positional placeholder for its value. Token iteration follows the
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
 * Postgres error ("could not determine data type of parameter"). Same strict
 * dedup as the base class; `tokenValues` is the substitute() map the real
 * collector consumes (substituteUsed) at render time. Tokens are
 * `_<prefix><n>_`: the trailing `_` keeps `_ACL1_` from being a substring of
 * `_ACL10_`.
 */
export class NamedTokenCollector extends ParamsCollector {
	readonly tokenValues: Record<string, unknown> = {};
	private readonly tokens: [unknown, string][] = [];

	constructor(private readonly prefix: string) {
		super();
	}

	override getPlaceholder(value: unknown): string {
		const found = this.tokens.find(([known]) => known === value);
		if (found !== undefined) return found[1];
		const token = `_${this.prefix}${this.tokens.length + 1}_`;
		this.tokens.push([value, token]);
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
