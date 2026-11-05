/**
 * Diffusion ontology-graph interpretation — the PURE half of the section
 * diffusion map (src/core/diffusion_bridge/diffusion_map.ts).
 *
 * Everything here is a function of a `DiffusionGraph`: node / children /
 * properties lookups over the dd1190 virtual diffusion tree. The module
 * imports NEITHER postgres.ts NOR env.ts by design — the DB-backed graph is
 * built in diffusion_map.ts (accessor subtree + external dd_ontology reads)
 * and handed in, so the walk rules (alias resolution, consumed reals, the
 * element/database/table context, the media-index selection) are testable
 * without a database and without the ontology drift that makes every element
 * resolve 'unknown' on a stale dd_ontology.
 *
 * The walk rules themselves are PHP diffusion_utils semantics (v7 flat
 * virtual tree, no v6 nested maps):
 *   - real nodes CONSUMED by an alias anywhere in the domain are skipped in
 *     their raw position (the alias re-parents them virtually);
 *   - every node UNDER a diffusion_element / diffusion_element_alias
 *     contributes its related 'section' tipos (the alias's REAL node's
 *     relations as fallback when the alias declares none);
 *   - alias nodes also descend into their real node's children.
 */

import { requireSqlIdentifier } from '../db/sql_identifier.ts';
import { nameOrLabelOf } from '../ontology/labels.ts';

/** The dd_ontology row shape the diffusion walk reads. */
export interface DiffusionNode {
	tipo: string;
	parent: string | null;
	model: string;
	term: Record<string, string> | null;
	/**
	 * The language-free name and its flag (read through labels.ts
	 * nameOrLabelOf). Optional: an in-memory graph node may omit them and then
	 * reads as a row not derived yet (the legacy label reading, counted).
	 */
	machine_name?: string | null;
	use_machine_name?: boolean | null;
	relations: { tipo?: string }[] | null;
}

/**
 * The graph seam: the three ontology lookups the walk needs. The DB-backed
 * implementation resolves in-tree nodes from the accessor subtree and falls
 * back to dd_ontology for anything outside it (alias targets, related
 * sections); a test implementation is a plain in-memory map.
 */
export interface DiffusionGraph {
	node(tipo: string): Promise<DiffusionNode | null>;
	children(tipo: string): Promise<string[]>;
	properties(tipo: string): Promise<Record<string, unknown> | null>;
}

/** One publish target of a section (PHP diffusion_delete step 2). */
export interface DiffusionSqlTarget {
	element_tipo: string;
	type: string;
	database_name: string;
	table_name: string;
	/** true when the emitting node is a table_alias (real tables win selection). */
	table_is_alias?: boolean;
}

/** One media-index publication target (PHP resolve_media_index_targets). */
export interface MediaIndexTarget {
	database_name: string;
	table_name: string;
	section_tipo: string;
}

/** Frozen constant table (not a cache): the two element models. */
const ELEMENT_MODELS: ReadonlySet<string> = new Set([
	'diffusion_element',
	'diffusion_element_alias',
]);

async function relationsOf(graph: DiffusionGraph, tipo: string): Promise<string[]> {
	return ((await graph.node(tipo))?.relations ?? [])
		.map((link) => link.tipo)
		.filter((t): t is string => typeof t === 'string');
}

async function relatedByModel(
	graph: DiffusionGraph,
	tipo: string,
	wanted: string,
): Promise<string[]> {
	const out: string[] = [];
	for (const target of await relationsOf(graph, tipo)) {
		if ((await graph.node(target))?.model === wanted) out.push(target);
	}
	return out;
}

/**
 * The domain node: the `root` child of model 'diffusion_domain' whose term
 * equals the configured domain name. Null when no child matches (fresh
 * install / misconfigured DEDALO_DIFFUSION_DOMAIN) — the caller returns an
 * empty map, matching PHP's early return.
 */
export async function resolveDomainTipo(
	graph: DiffusionGraph,
	root: string,
	domainName: string,
): Promise<string | null> {
	for (const child of await graph.children(root)) {
		const node = await graph.node(child);
		// The domain is a name node: matched by its machine name (nameOrLabelOf).
		if (node?.model === 'diffusion_domain' && nameOrLabelOf(node) === domainName) {
			return child;
		}
	}
	return null;
}

/**
 * Alias target: the first RELATED node of model (alias's model minus
 * '_alias'), chained up to `depth` hops. Null for a non-alias node, for an
 * alias that relates nothing, and for a chain that exceeds the budget (a
 * cycle terminates there).
 */
export async function resolveAliasTarget(
	graph: DiffusionGraph,
	tipo: string,
	depth = 10,
): Promise<string | null> {
	if (depth <= 0) return null;
	const model = (await graph.node(tipo))?.model ?? '';
	if (!model.includes('_alias')) return null;
	const target = (await relatedByModel(graph, tipo, model.replace('_alias', '')))[0] ?? null;
	if (target === null) return null;
	const targetModel = (await graph.node(target))?.model ?? '';
	return targetModel.includes('_alias') ? resolveAliasTarget(graph, target, depth - 1) : target;
}

/** Every descendant of `tipo`, depth-first (the node itself excluded). */
async function subtreeOf(graph: DiffusionGraph, tipo: string): Promise<string[]> {
	const acc: string[] = [];
	const collect = async (current: string): Promise<void> => {
		for (const child of await graph.children(current)) {
			acc.push(child);
			await collect(child);
		}
	};
	await collect(tipo);
	return acc;
}

/** The REAL nodes the given nodes' aliases point at (non-aliases contribute none). */
async function aliasConsumedReals(
	graph: DiffusionGraph,
	tipos: readonly string[],
): Promise<Set<string>> {
	const consumed = new Set<string>();
	for (const tipo of tipos) {
		const real = await resolveAliasTarget(graph, tipo); // null unless an alias
		if (real !== null) consumed.add(real);
	}
	return consumed;
}

/**
 * Real nodes consumed by an alias anywhere under the domain — they are
 * skipped in their raw tree position because the alias re-parents them.
 */
export async function collectConsumedReals(
	graph: DiffusionGraph,
	domainTipo: string,
): Promise<Set<string>> {
	return aliasConsumedReals(graph, await subtreeOf(graph, domainTipo));
}

/**
 * Is this node re-parented AWAY from its raw tree position by an alias?
 *
 * The one skip rule of both walks, in one place. An alias node is never
 * skipped (it IS the new position). A real ELEMENT is skipped domain-wide (an
 * element alias re-parents the whole element); anything INSIDE an element is
 * skipped only when an alias OF THAT ELEMENT consumes it — a table aliased by
 * a different element still publishes its own section there.
 *
 * `elementKey` is the enclosing element's tipo (walkDiffusionSections) or its
 * real tipo (walkDiffusionTargets); collectConsumedRealsByElement stores the
 * set under BOTH, so either resolves.
 */
function isReparentedAway(args: {
	tipo: string;
	model: string;
	elementKey: string | null;
	consumed: ReadonlySet<string>;
	consumedByElement: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
	const { tipo, model, elementKey, consumed, consumedByElement } = args;
	if (model.includes('_alias')) return false;
	if (ELEMENT_MODELS.has(model)) return consumed.has(tipo);
	if (elementKey === null) return false;
	return consumedByElement.get(elementKey)?.has(tipo) ?? false;
}

/**
 * The node's related 'section' tipos, with the alias fallback: an alias that
 * declares no relations of its own borrows its REAL node's (PHP resolve_node).
 */
async function relatedSections(
	graph: DiffusionGraph,
	tipo: string,
	realTipo: string | null,
): Promise<string[]> {
	const sections = await relatedByModel(graph, tipo, 'section');
	if (sections.length > 0 || realTipo === null) return sections;
	return relatedByModel(graph, realTipo, 'section');
}

/**
 * Children of the node, plus the real node's children when it is an alias
 * (the alias descends into what it re-parents).
 *
 * `aliasRealTipo` is the ALIAS-RESOLVED target and MUST be null for a non-alias
 * node — pass `resolveAliasTarget()`'s result only after the model check, never
 * unconditionally, or a real node would absorb another node's children.
 */
async function walkChildren(
	graph: DiffusionGraph,
	tipo: string,
	aliasRealTipo: string | null,
): Promise<Set<string>> {
	const children = new Set(await graph.children(tipo));
	if (aliasRealTipo !== null) {
		for (const child of await graph.children(aliasRealTipo)) children.add(child);
	}
	return children;
}

/**
 * Alias-consumed real nodes, SCOPED PER DIFFUSION ELEMENT.
 *
 * A real node is "re-parented" only for the element whose own subtree carries
 * the alias that points at it. The domain-wide variant above cannot express
 * that: the ts_web table mht96 lives under element mht50 and publishes section
 * mht72, but two aliases in OTHER elements (mht149 under mht2, mht147 under
 * mht145) also target it — so mht96 counted as consumed everywhere and the
 * section walk skipped it inside its own element too. mht72 then never entered
 * the section map, `haveSectionDiffusion('mht72')` returned false and the
 * Difusión tool disappeared for those records, while v6 (which enumerates
 * table + table_alias per element and resolves each one's own section) offers
 * it. Keyed by the element tipo AND its real tipo, so an element alias resolves
 * to the same set.
 */
export async function collectConsumedRealsByElement(
	graph: DiffusionGraph,
	domainTipo: string,
): Promise<Map<string, ReadonlySet<string>>> {
	const out = new Map<string, ReadonlySet<string>>();

	const visit = async (tipo: string, depth: number): Promise<void> => {
		if (depth > 20) return;
		const model = (await graph.node(tipo))?.model ?? '';
		if (ELEMENT_MODELS.has(model)) {
			const set = await aliasConsumedReals(graph, await subtreeOf(graph, tipo));
			out.set(tipo, set);
			// an element ALIAS answers under its real tipo too
			const realTipo = await resolveAliasTarget(graph, tipo); // null unless an alias
			if (realTipo !== null) out.set(realTipo, set);
		}
		for (const child of await graph.children(tipo)) await visit(child, depth + 1);
	};
	await visit(domainTipo, 0);
	return out;
}

/**
 * Sections that participate in ANY diffusion output under the domain (the
 * getSectionDiffusionMap keys).
 */
export async function walkDiffusionSections(
	graph: DiffusionGraph,
	domainTipo: string,
): Promise<Set<string>> {
	const map = new Set<string>();
	// Domain-wide for ELEMENTS (an element alias re-parents the whole element),
	// element-scoped for the nodes INSIDE one (a table aliased by another
	// element still publishes its own section).
	const consumed = await collectConsumedReals(graph, domainTipo);
	const consumedByElement = await collectConsumedRealsByElement(graph, domainTipo);

	const walk = async (
		tipo: string,
		underElement: boolean,
		depth: number,
		elementTipo: string | null,
	): Promise<void> => {
		if (depth > 20) return;
		const model = (await graph.node(tipo))?.model ?? '';
		const isElement = ELEMENT_MODELS.has(model);
		const currentElementTipo = isElement ? tipo : elementTipo;
		if (
			isReparentedAway({ tipo, model, elementKey: currentElementTipo, consumed, consumedByElement })
		) {
			return;
		}
		const realTipo = model.includes('_alias') ? await resolveAliasTarget(graph, tipo) : null;

		if (underElement) {
			for (const sectionTipo of await relatedSections(graph, tipo, realTipo)) map.add(sectionTipo);
		}

		for (const child of await walkChildren(graph, tipo, realTipo)) {
			await walk(child, underElement || isElement, depth + 1, currentElementTipo);
		}
	};
	await walk(domainTipo, false, 0, null);
	return map;
}

/** The element context carried down the walk (database is FIRST-WINS). */
interface ElementContext {
	realTipo: string;
	type: string;
	database: string | null;
}

/** Frozen constant table (not a cache): the two database models. */
const DATABASE_MODELS: ReadonlySet<string> = new Set(['database', 'database_alias']);

/**
 * The context an element node opens: its real tipo + its diffusion type. An
 * alias inherits the real node's properties when it declares none of its own
 * (PHP resolve_node); an element without a declared type is 'unknown'.
 */
async function resolveElementContext(
	graph: DiffusionGraph,
	tipo: string,
	realTipo: string | null,
): Promise<ElementContext> {
	const properties = await elementProperties(graph, tipo, realTipo);
	const declared = (properties as { diffusion?: { type?: string } } | null)?.diffusion?.type;
	return {
		realTipo: realTipo ?? tipo,
		type: declared || 'unknown', // null / '' / absent all mean 'unknown'
		database: null,
	};
}

/** The element's own properties, or the real node's when it declares none. */
async function elementProperties(
	graph: DiffusionGraph,
	tipo: string,
	realTipo: string | null,
): Promise<Record<string, unknown> | null> {
	const own = await graph.properties(tipo);
	if (realTipo === null) return own;
	return own !== null && Object.keys(own).length > 0 ? own : await graph.properties(realTipo);
}

/**
 * Per-section publish targets: every virtual node under a diffusion element
 * that relates to a section becomes a target — the pair (database node label
 * under the element, the node's own label) is the published table address.
 * File-based types (rdf/xml/markdown) come out with empty db/table.
 *
 * DIFF-A (2026-07-28 audit): the ontology-label database/table names go
 * through the SAME chokepoint the publish plan uses (requireSqlIdentifier),
 * so delete targets are byte-identical to what was published. A label publish
 * would REJECT is skipped here too (keeps the two in lockstep).
 */
export async function walkDiffusionTargets(
	graph: DiffusionGraph,
	domainTipo: string,
): Promise<Map<string, DiffusionSqlTarget[]>> {
	const map = new Map<string, DiffusionSqlTarget[]>();
	const consumed = await collectConsumedReals(graph, domainTipo);
	const consumedByElement = await collectConsumedRealsByElement(graph, domainTipo);

	const pending: {
		section: string;
		element: ElementContext;
		table: string | null;
		tableIsAlias: boolean;
	}[] = [];

	const walk = async (
		tipo: string,
		element: ElementContext | null,
		depth: number,
	): Promise<void> => {
		if (depth > 20) return;
		const node = await graph.node(tipo);
		const model = node?.model ?? '';
		// Elements: domain-wide (an element alias re-parents the whole element).
		// Inside an element: scoped — a real table aliased by a DIFFERENT element
		// still publishes its own section here (mht96 -> mht72).
		if (
			isReparentedAway({
				tipo,
				model,
				elementKey: element?.realTipo ?? null,
				consumed,
				consumedByElement,
			})
		) {
			return;
		}
		const realTipo = model.includes('_alias') ? await resolveAliasTarget(graph, tipo) : null;
		// Mixed class: database / table nodes are named by their machine name,
		// elements by their label (labels.ts nameOrLabelOf).
		const label = nameOrLabelOf(node ?? undefined);

		let currentElement = element;
		if (ELEMENT_MODELS.has(model)) {
			currentElement = await resolveElementContext(graph, tipo, realTipo);
		} else if (element !== null && DATABASE_MODELS.has(model)) {
			// database node label, FIRST-WINS for the element it hangs under
			if (element.database === null && label !== null) element.database = label;
		}

		if (element !== null) {
			for (const section of await relatedSections(graph, tipo, realTipo)) {
				pending.push({ section, element, table: label, tableIsAlias: model === 'table_alias' });
			}
		}

		for (const child of await walkChildren(graph, tipo, realTipo)) {
			await walk(child, currentElement, depth + 1);
		}
	};
	await walk(domainTipo, null, 0);

	// materialize (database labels resolved after the full walk), dedup per
	// section by db|table
	for (const hit of pending) {
		const list = map.get(hit.section) ?? [];
		let databaseName: string;
		let tableName: string;
		try {
			databaseName = hit.element.database
				? requireSqlIdentifier(hit.element.database, 'database')
				: '';
			tableName = hit.table ? requireSqlIdentifier(hit.table, 'table') : '';
		} catch {
			continue;
		}
		const exists = list.some(
			(t) =>
				t.element_tipo === hit.element.realTipo &&
				t.database_name === databaseName &&
				t.table_name === tableName,
		);
		if (!exists) {
			list.push({
				element_tipo: hit.element.realTipo,
				type: hit.element.type,
				database_name: databaseName,
				table_name: tableName,
				table_is_alias: hit.tableIsAlias,
			});
			map.set(hit.section, list);
		}
	}
	return map;
}

/**
 * EVERY sql/socrata publication target, deduped — PHP
 * dd_diffusion_api::resolve_media_index_targets. File-based elements
 * (rdf/xml/markdown) and targets without a database or table name are
 * skipped, as PHP does. PHP's per-section node selection is mirrored: a
 * section related by BOTH a real 'table' node and a 'table_alias' publishes
 * to the REAL table — the engine only ever writes there, so only that table
 * holds rows worth indexing (real-preferred, first-alias fallback). Order is
 * section-major — the engine treats the list as a set.
 *
 * D12, FIXED 2026-08-09: the selection key was `database_name` ALONE, so when
 * one database held TWO REAL tables only the first survived and the second
 * table's media markers were never built (published media denied/absent for
 * that whole table). The key is now (database, table) — PHP's own
 * resolve_media_index_targets dedupes on the db|table|section triple, so this
 * RESTORES parity. The real-preferred / first-alias-fallback rule is the
 * remaining deliberate divergence and is ledgered:
 * engineering/wire_contract/WC-2026-08-09-media-index-target-selection.md.
 */
export function selectMediaIndexTargets(
	bySection: ReadonlyMap<string, DiffusionSqlTarget[]>,
): MediaIndexTarget[] {
	const targets: MediaIndexTarget[] = [];
	for (const [sectionTipo, list] of bySection) {
		for (const target of selectSectionMediaIndexTargets(list)) {
			targets.push({
				database_name: target.database_name,
				table_name: target.table_name,
				section_tipo: sectionTipo,
			});
		}
	}
	return targets;
}

/**
 * One section's indexable targets, in first-seen order: every distinct
 * (database, table) pair, minus the alias tables of any database that also
 * publishes to a REAL table (the engine only ever writes the real one), and
 * minus every alias after the first in a database that has no real table.
 */
function selectSectionMediaIndexTargets(list: readonly DiffusionSqlTarget[]): DiffusionSqlTarget[] {
	const eligible = list.filter(
		(target) =>
			(target.type === 'sql' || target.type === 'socrata') &&
			target.database_name !== '' &&
			target.table_name !== '',
	);
	const databasesWithRealTable = new Set(
		eligible.filter((target) => target.table_is_alias !== true).map((t) => t.database_name),
	);
	const aliasedDatabases = new Set<string>();
	const chosen = new Map<string, DiffusionSqlTarget>();
	for (const target of eligible) {
		if (target.table_is_alias === true) {
			if (databasesWithRealTable.has(target.database_name)) continue; // real wins
			if (aliasedDatabases.has(target.database_name)) continue; // first alias only
			aliasedDatabases.add(target.database_name);
		}
		const key = `${target.database_name}|${target.table_name}`;
		if (!chosen.has(key)) chosen.set(key, target);
	}
	return [...chosen.values()];
}
