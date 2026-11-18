/**
 * DEEP-PATH FILTERS — a filter leaf whose path crosses relation hops, rendered
 * as a SEMI-JOIN over the related records it reaches
 * (engineering/wire_contract/WC-2026-09-29-search-deep-leaf-mixed-rule.md).
 *
 * SEMANTICS. R(m) = the related records main record m reaches through the path
 * (any stored locator at every hop; a record the caller may not read at a hop
 * — SEC-02 — is absent). conform.ts has classified each deep leaf into
 * POSITIVE clauses and NEGATED ones:
 *
 *   pos  EXISTS r in R(m): P(r)
 *   neg  NOT EXISTS r in R(m): twin(r)        ('-x', '!*', '!==', …)
 *   neq  pos(has) AND neg(twin)                ('!=x')
 *
 * A leaf is never evaluated per joined row: nothing enters the main FROM, so
 * no fan-out, no DISTINCT, count(*), and a negation means "NO related record
 * matches" (the forward-join shape it replaces answered "SOME related record
 * fails", e.g. mdcat '-NIF' 38,749 instead of 18,635).
 *
 * THE MIXED RULE (owner decision 2026-09-29) — sibling leaves of an AND
 * connective ($and, and the inside of $not/$nand) on the SAME chain:
 *  - all-positive leaves on DIFFERENT fields share ONE related record: their
 *    predicates are ANDed inside a single semi-join ("a movement to Madrid in
 *    1939");
 *  - a field repeated among them makes every one of them independent ("a
 *    movement to Madrid AND a movement to Valencia" — the PHP 2518d2059c
 *    conjunction);
 *  - a leaf with a negated clause never shares: a negation keeps meaning "no
 *    related record matches" whatever its siblings are.
 * Under $or/$nor every leaf is independent (EXISTS distributes over OR).
 *
 * TWO PHYSICAL SHAPES, one answer:
 *   FORWARD  correlated EXISTS / NOT EXISTS from the main row: unnest each
 *            hop's locators and join the step table on the locator identity,
 *            the hop ACL in the join ON — the same join text buildJoinChain
 *            always emitted, scoped inside the subquery.
 *   REVERSE  the matching LEAF records first, then each hop walked BACK through
 *            matrix_relation_index (target → source) — uncorrelated, a hashed
 *            semi-join (measured monedaiberica numisdata4 Tipo→Ceca→name:
 *            2906 ms forward-join vs 14 ms). Used for a POSITIVE semi-join in a
 *            positive context only, when the index covers every source table.
 *            Never for a negation: an anti-join over the index is plan-fragile
 *            (measured on mdcat 2026-09-24, '!*' 177 s reversed vs 0.23 s).
 *            The two shapes see the same record set: the reversed one only ever
 *            reaches real, ACL-visible target records, which is exactly R(m).
 *            The index carries no table, so every INTERMEDIATE record is
 *            joined back to its row in the hop's step table (hopSourceJoin),
 *            hop ACL or not — the row the forward join reads. Without it a
 *            locator naming a record of another table matched through that
 *            record's own index rows (TODO-012, owner decision 20).
 */

import type { BuilderResult } from './builders/types.ts';
import { compound } from './builders/types.ts';
import type {
	ConformedFilter,
	DeepChainPlan,
	DeepClause,
	DeepLeafNode,
	JoinHop,
} from './conform.ts';
import { relationIndexCovers } from './search_store.ts';

type GroupNode = Extract<ConformedFilter, { kind: 'group' }>;

const NEGATING_OPS: ReadonlySet<string> = new Set(['$not', '$nand', '$nor']);
/** The operators whose items are joined by AND (the mixed rule applies). */
const AND_CONNECTIVE_OPS: ReadonlySet<string> = new Set(['$and', '$not', '$nand']);

/**
 * Replace every `deep` node of the tree with semi-join nodes (in place).
 * `mainTables` = every table the main query reads (a multi-section UNION
 * reads several): the reversed shape needs the index to cover all of them.
 */
export async function planDeepFilters(
	tree: ConformedFilter,
	mainTables: readonly string[],
	aclTokens: Record<string, unknown>,
): Promise<ConformedFilter> {
	return planNode(tree, true, { mainTables, aclTokens });
}

/** What every semi-join of one query shares. */
interface PlanContext {
	mainTables: readonly string[];
	/** The hop ACL's named-token values (NamedTokenCollector.tokenValues). */
	aclTokens: Record<string, unknown>;
}

async function planNode(
	node: ConformedFilter,
	positive: boolean,
	ctx: PlanContext,
): Promise<ConformedFilter> {
	if (node.kind === 'deep') return renderUnit([node], positive, ctx);
	if (node.kind !== 'group') return node;
	node.items = await planGroupItems(node, positive && !NEGATING_OPS.has(node.op), ctx);
	return node;
}

/** A group's items with each shared-record unit rendered once, in its first leaf's slot. */
async function planGroupItems(
	group: GroupNode,
	childPositive: boolean,
	ctx: PlanContext,
): Promise<ConformedFilter[]> {
	const unitOf = sharedRecordIndex(group);
	const items: ConformedFilter[] = [];
	for (const item of group.items) {
		const unit = unitOf.get(item);
		if (unit === undefined) items.push(await planNode(item, childPositive, ctx));
		else if (unit[0] === item) items.push(await renderUnit(unit, childPositive, ctx));
	}
	return items;
}

/** Each leaf of a shared-record unit → its unit (empty outside an AND connective). */
function sharedRecordIndex(group: GroupNode): Map<ConformedFilter, DeepLeafNode[]> {
	const unitOf = new Map<ConformedFilter, DeepLeafNode[]>();
	if (!AND_CONNECTIVE_OPS.has(group.op)) return unitOf;
	for (const unit of sharedRecordUnits(group)) for (const leaf of unit) unitOf.set(leaf, unit);
	return unitOf;
}

/**
 * The mixed rule: the sets of sibling all-positive deep leaves on one chain
 * that share ONE related record (2+ leaves, pairwise-distinct fields).
 */
function sharedRecordUnits(group: GroupNode): DeepLeafNode[][] {
	const byChain = new Map<string, DeepLeafNode[]>();
	for (const item of group.items) {
		if (item.kind !== 'deep' || !item.positive) continue;
		const key = chainKey(item.plan);
		byChain.set(key, [...(byChain.get(key) ?? []), item]);
	}
	return [...byChain.values()].filter(
		(unit) => unit.length > 1 && new Set(unit.map((leaf) => leaf.field)).size === unit.length,
	);
}

function chainKey(plan: DeepChainPlan): string {
	return plan.hops.map((hop) => hop.alias).join('|');
}

/**
 * One unit (a single leaf, or a shared-record set of positive leaves) → its
 * semi-joins, ANDed: the shared positive semi-join first, then each negated
 * clause on its own.
 */
async function renderUnit(
	unit: DeepLeafNode[],
	positive: boolean,
	ctx: PlanContext,
): Promise<ConformedFilter> {
	const plan = (unit[0] as DeepLeafNode).plan;
	const clauses = unit.flatMap((leaf) => leaf.clauses);
	const positives = clauses.filter((clause) => !clause.neg);
	const items: ConformedFilter[] = [];
	if (positives.length > 0) {
		const merged: DeepClause = {
			neg: false,
			result: allOf(positives.map((clause) => clause.result)),
			reverse: allOf(positives.map((clause) => clause.reverse)),
		};
		items.push(await semijoin(merged, plan, positive, ctx));
	}
	for (const clause of clauses.filter((candidate) => candidate.neg)) {
		items.push(await semijoin(clause, plan, positive, ctx));
	}
	// SEC-1 row-section key (conform.ts rowKeyedLeaf): every leaf of one unit
	// shares the chain, hence the root component, hence the same key — ANDed
	// once, outside the semi-join(s), on the MAIN row.
	const rowKey = (unit[0] as DeepLeafNode).rowKey;
	if (rowKey !== undefined && rowKey !== false) items.unshift({ kind: 'leaf', fragment: rowKey });
	return items.length === 1 ? (items[0] as ConformedFilter) : { kind: 'group', op: '$and', items };
}

function allOf(results: BuilderResult[]): BuilderResult {
	return results.length === 1 ? (results[0] as BuilderResult) : compound('$and', results);
}

async function semijoin(
	clause: DeepClause,
	plan: DeepChainPlan,
	positive: boolean,
	ctx: PlanContext,
): Promise<ConformedFilter> {
	const tokens = ctx.aclTokens;
	if (!clause.neg && positive && (await reversible(plan, ctx.mainTables))) {
		return { kind: 'semijoin', ...reverseShell(plan), inner: clause.reverse, tokens };
	}
	return { kind: 'semijoin', ...forwardShell(plan, clause.neg), inner: clause.result, tokens };
}

/** matrix_relation_index covers every SOURCE table of the chain. */
async function reversible(plan: DeepChainPlan, mainTables: readonly string[]): Promise<boolean> {
	const sources = [...mainTables, ...plan.hops.slice(0, -1).map((hop) => hop.table)];
	return relationIndexCovers([...new Set(sources)]);
}

/**
 * FORWARD: `[NOT] EXISTS (SELECT 1 FROM <unnest> JOIN T1 … [CROSS JOIN LATERAL
 * <unnest> JOIN T2 …] WHERE <leaf predicate>)`. The join text is the one
 * buildJoinChain declares (hop.join), so the ACL cannot drift from it.
 */
function forwardShell(plan: DeepChainPlan, neg: boolean): { open: string; close: string } {
	const from = plan.hops
		.map((hop, index) => `${index === 0 ? '' : 'CROSS JOIN LATERAL '}${hop.join}`)
		.join('\n  ');
	return { open: `${neg ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${from}\n  WHERE (`, close: '))' };
}

/** REVERSE: the leaf records first, each hop walked back through the index. */
function reverseShell(plan: DeepChainPlan): { open: string; close: string } {
	const hops = plan.hops;
	const leafHop = hops[hops.length - 1] as JoinHop;
	let open =
		`SELECT ${leafHop.alias}.section_tipo, ${leafHop.alias}.section_id ` +
		`FROM ${leafHop.table} AS ${leafHop.alias} WHERE ` +
		(leafHop.acl === '' ? '' : `(${leafHop.acl}) AND `) +
		'(';
	let close = ')';
	for (let index = hops.length - 1; index >= 0; index--) {
		const hop = hops[index] as JoinHop;
		const ri = `ri_${hop.alias}`;
		const sourceJoin = index === 0 ? '' : hopSourceJoin(hops[index - 1] as JoinHop, ri);
		open =
			`SELECT ${ri}.section_tipo, ${ri}.section_id FROM matrix_relation_index AS ${ri}${sourceJoin} ` +
			`WHERE ${ri}.from_component_tipo = '${hop.hopDataTipo}' ` +
			`AND (${ri}.target_section_tipo, ${ri}.target_section_id) IN (${open}`;
		close = `${close})`;
	}
	return {
		open: `(${plan.mainAlias}.section_tipo, ${plan.mainAlias}.section_id) IN (${open}`,
		close: `${close})`,
	};
}

/**
 * The SOURCE record of a walked-back hop, as the forward join reads it: the row
 * of the hop's step table at the address the index names (section_tipo +
 * section_id), under the hop ACL when there is one. ALWAYS emitted — an index
 * row says a record somewhere holds the locator, never that it is a record of
 * this table. (The main row needs none: the outer IN binds the main alias.)
 */
function hopSourceJoin(source: JoinHop, ri: string): string {
	const acl = source.acl === '' ? '' : ` AND (${source.acl})`;
	return (
		` JOIN ${source.table} AS ${source.alias} ON ${source.alias}.section_tipo = ${ri}.section_tipo ` +
		`AND ${source.alias}.section_id = ${ri}.section_id${acl}`
	);
}
