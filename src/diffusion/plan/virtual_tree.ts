/**
 * Flat VIRTUAL diffusion tree (DIFFUSION_SPEC §4.1 stage A→B input).
 *
 * The dd1190 diffusion ontology describes publications as a tree of domains →
 * groups → elements → databases → tables → fields, where any node may be an
 * `*_alias` that re-parents another node's subtree "virtually". This module
 * reproduces the PHP oracle walk byte-for-byte in semantics:
 *
 * - diffusion_utils::get_virtual_diffusion_tree (:194): one flat array of
 *   virtual nodes for the CONFIGURED domain (DEDALO_DIFFUSION_DOMAIN), with
 *   real nodes CONSUMED by an alias suppressed in their raw position.
 * - diffusion_utils::walk_virtual_diffusion_tree (:302): each node carries its
 *   alias-resolved identity, its `parents[]` path (immediate parent FIRST —
 *   PHP `array_merge([$path_item], $path)`), and `childrenTipos` = RECURSIVE
 *   own children + the real node's recursive children deduped by LABEL
 *   (alias children win a label collision).
 * - diffusion_utils::resolve_node_with_alias (:508): alias tipo/label WIN;
 *   properties inherited from the real node when the alias declares none.
 *   Faithful quirk: an alias whose target cannot be resolved keeps
 *   `properties = null` even if it has own properties (PHP only reads alias
 *   properties inside the `real_tipo !== null` branch).
 * - diffusion_utils::resolve_alias_recursive/_target (:430/:456): the alias
 *   target is the first RELATED node whose model is the alias model minus
 *   '_alias', chained up to 10 hops.
 *
 * Query strategy (same as src/core/diffusion_bridge/diffusion_map.ts:59-67): the whole
 * dd1190 subtree in ONE recursive CTE, plus one batched lookup that warms all
 * relation targets living OUTSIDE the subtree (sections, components, alias
 * targets in other branches). Anything still missing falls back to a targeted
 * single-node query.
 *
 * This module only READS the ontology. Plan caching / invalidation is
 * cache.ts's job (ontology-revision counter, spec §4.1).
 */

import { readEnv } from '../../config/env.ts';
import { sql } from '../../core/db/postgres.ts';
import { nameOrLabelOf } from '../../core/ontology/labels.ts';
import { getOrderedSubtree } from '../../core/ontology/resolver.ts';

/** DEDALO_DIFFUSION_TIPO — the dd1190 diffusion ontology root. */
const DIFFUSION_ROOT = 'dd1190';

/** Defensive walk cap (PHP recurses unbounded; alias cycles must not hang us). */
const MAX_WALK_DEPTH = 20;

/** One raw dd_ontology row as this module consumes it. */
export interface RawOntologyNode {
	tipo: string;
	parent: string | null;
	model: string;
	term: Record<string, string> | null;
	/**
	 * The language-free name (database / table / field / domain nodes) and its
	 * flag — read through labels.ts nameOrLabelOf, never by a lang. Optional so
	 * an in-memory node may omit the pair: it then reads as a row not derived
	 * yet (the legacy label reading, counted).
	 */
	machine_name?: string | null;
	use_machine_name?: boolean | null;
	properties: Record<string, unknown> | null;
	relations: { tipo?: string }[] | null;
}

/**
 * One item of a virtual node's `parents[]` path. PHP walk_virtual_diffusion_tree
 * stores {tipo, model, label(+type for elements)}; we additionally memo the
 * alias resolution (`realTipo`) so element_path_matches (:1130) does not have
 * to re-resolve — the value is identical to what PHP recomputes on demand.
 */
export interface VirtualPathItem {
	tipo: string;
	model: string;
	label: string | null;
	/** properties->diffusion->type, present only on diffusion_element(_alias) items. */
	type?: string;
	/** Alias resolution memo (null when the item is not an alias / unresolvable). */
	realTipo: string | null;
}

/** One node of the flat virtual diffusion tree (PHP $vnode). */
export interface VirtualTreeNode {
	/** Virtual identity: the alias tipo when aliased, else the node tipo. */
	tipo: string;
	/** The ACTUAL model (e.g. 'table_alias' — aliases keep their alias model). */
	model: string;
	/** Structure-lang term (alias label wins). Null when the term is empty. */
	label: string | null;
	/** Effective properties (alias own, or inherited from the real node). */
	properties: Record<string, unknown> | null;
	/** Resolved real node tipo (null when not an alias or unresolvable). */
	realTipo: string | null;
	isAlias: boolean;
	/** Path from the immediate parent (index 0) up to the domain node. */
	parents: VirtualPathItem[];
	/**
	 * Merged RECURSIVE children (PHP: own recursive children + the real node's
	 * recursive children whose label is not already taken by an own child).
	 * This is the UI/info list ONLY — PHP builds it "to populate the fields list
	 * for the UI" (diffusion_utils :320). NEVER use it as a column source: see
	 * directChildrenTipos.
	 */
	childrenTipos: string[];
	/**
	 * DIRECT children — the COLUMN source for a table node (PHP
	 * dd_diffusion_api::process_datum :996 `ontology_node::get_ar_children`,
	 * which is first-level only; :1017-1018 prepends the alias target's direct
	 * children so alias-own children come LAST and override).
	 *
	 * A table node may itself contain a nested `table` node (mdcat364
	 * 'documentales' → mdcat367 'documentales_portal'), so the recursive list
	 * would drag the nested table's fields into the parent table and collide on
	 * a shared column name.
	 */
	directChildrenTipos: string[];
	/**
	 * Related 'section' tipos of the node, with the PHP fallback: when the
	 * (alias) node declares none, the REAL node's section relations are used
	 * (get_section_diffusion_nodes :262-266).
	 */
	relatedSections: string[];
}

/**
 * Read-through index over dd_ontology used during and after the walk: the
 * dd1190 subtree is fully in memory; external tipos (sections, components,
 * out-of-subtree alias targets) resolve through a warmed cache with a
 * single-row query fallback.
 */
export interface OntologyIndex {
	nodeOf(tipo: string): Promise<RawOntologyNode | null>;
	/** Direct children tipos, sibling-ordered (order_number ASC, tipo tiebreak). */
	childTipos(tipo: string): Promise<string[]>;
	/** Related tipos of `tipo` whose model equals `wanted`. */
	relatedByModel(tipo: string, wanted: string): Promise<string[]>;
	/** ALL related tipos (PHP ontology_node::get_relation_nodes simple mode). */
	relationTipos(tipo: string): Promise<string[]>;
	/** Chained alias target resolution (≤10 hops), null when unresolvable. */
	resolveAlias(tipo: string): Promise<string | null>;
}

/** The built virtual tree plus the index compile.ts keeps using afterwards. */
export interface VirtualDiffusionTree {
	/** Configured domain name (DEDALO_DIFFUSION_DOMAIN) the tree was built for. */
	domainName: string;
	domainTipo: string;
	/** Flat virtual nodes in PHP walk order (domain node first). */
	nodes: VirtualTreeNode[];
	index: OntologyIndex;
}

/**
 * jsonb columns written as pre-stringified params come back as STRING scalars
 * (known Bun.sql trap) — parse-if-string keeps every consumer on objects.
 */
function parseJsonbColumn<T>(value: unknown): T | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string') {
		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}
	return value as T;
}

function normalizeRawNode(row: Record<string, unknown>): RawOntologyNode {
	return {
		tipo: row.tipo as string,
		parent: (row.parent as string | null) ?? null,
		model: (row.model as string) ?? '',
		term: parseJsonbColumn<Record<string, string>>(row.term),
		machine_name: (row.machine_name as string | null | undefined) ?? null,
		use_machine_name: (row.use_machine_name as boolean | null | undefined) ?? null,
		properties: parseJsonbColumn<Record<string, unknown>>(row.properties),
		relations: parseJsonbColumn<{ tipo?: string }[]>(row.relations),
	};
}

const NODE_COLUMNS =
	'tipo, parent, model, term, machine_name, use_machine_name, properties, relations';

/**
 * Build the read-through OntologyIndex: ONE recursive CTE for the whole
 * dd1190 subtree (pattern: diffusion_map.ts:59-67), one batched warm-up for
 * every relation target that lives outside it, targeted single-node lookups
 * for anything else (rare: children of out-of-subtree alias targets).
 */
async function loadOntologyIndex(): Promise<
	OntologyIndex & { inTreeChildren: Map<string, string[]>; byTipo: Map<string, RawOntologyNode> }
> {
	// Canonical accessor walk (S2-19/T3): full structural subtree, root
	// included. Sibling order matters: PHP walks children ORDER BY order_number
	// ASC (dd_ontology_db_manager::search) and walk order decides first-hit
	// selections (e.g. which table wins get_section_node_for_element); the
	// accessor's DFS pre-order applies exactly that policy (compareSiblingOrder:
	// order ASC nulls-last, tipo tiebreak), so the grouped inTreeChildren lists
	// below inherit it. normalizeRawNode keeps the defensive jsonb-string parse.
	const rows = (
		await getOrderedSubtree(DIFFUSION_ROOT, { includeRoot: true, crossSections: true })
	).map((node) => ({
		node: normalizeRawNode({
			tipo: node.tipo,
			parent: node.parent,
			model: node.model,
			term: node.term,
			machine_name: node.machine_name,
			use_machine_name: node.use_machine_name,
			properties: node.properties,
			relations: node.relations,
		}),
	}));

	const byTipo = new Map<string, RawOntologyNode>(rows.map((row) => [row.node.tipo, row.node]));

	const inTreeChildren = new Map<string, string[]>();
	for (const { node } of rows) {
		if (node.parent === null) continue;
		const list = inTreeChildren.get(node.parent) ?? [];
		list.push(node.tipo);
		inTreeChildren.set(node.parent, list);
	}

	// Warm-up: every relation target OUTSIDE the subtree in ONE query. These
	// are the section/component nodes the walk needs models for, plus alias
	// targets parked in other branches.
	const externalNodes = new Map<string, RawOntologyNode | null>();
	const externalTargets = new Set<string>();
	for (const { node } of rows) {
		for (const link of node.relations ?? []) {
			if (typeof link.tipo === 'string' && !byTipo.has(link.tipo)) externalTargets.add(link.tipo);
		}
	}
	if (externalTargets.size > 0) {
		const list = [...externalTargets];
		const warmed = (await sql.unsafe(
			`SELECT ${NODE_COLUMNS} FROM dd_ontology WHERE tipo = ANY($1::text[])`,
			[`{${list.join(',')}}`],
		)) as Record<string, unknown>[];
		for (const row of warmed) {
			const node = normalizeRawNode(row);
			externalNodes.set(node.tipo, node);
		}
		// Missing rows (dangling relations) are pinned to null so we never re-query.
		for (const tipo of list) {
			if (!externalNodes.has(tipo)) externalNodes.set(tipo, null);
		}
	}

	const nodeOf = async (tipo: string): Promise<RawOntologyNode | null> => {
		const inTree = byTipo.get(tipo);
		if (inTree !== undefined) return inTree;
		const cached = externalNodes.get(tipo);
		if (cached !== undefined) return cached;
		const found = (await sql.unsafe(`SELECT ${NODE_COLUMNS} FROM dd_ontology WHERE tipo = $1`, [
			tipo,
		])) as Record<string, unknown>[];
		const node = found[0] !== undefined ? normalizeRawNode(found[0]) : null;
		externalNodes.set(tipo, node);
		return node;
	};

	// External children lookup (only needed when an alias target lives outside
	// dd1190 entirely — rare, mirrored from diffusion_map.ts:399-411).
	const externalChildren = new Map<string, string[]>();
	const childTipos = async (tipo: string): Promise<string[]> => {
		if (byTipo.has(tipo)) return inTreeChildren.get(tipo) ?? [];
		const cached = externalChildren.get(tipo);
		if (cached !== undefined) return cached;
		const found = (await sql.unsafe(
			'SELECT tipo FROM dd_ontology WHERE parent = $1 ORDER BY order_number ASC, tipo ASC',
			[tipo],
		)) as { tipo: string }[];
		const list = found.map((row) => row.tipo);
		externalChildren.set(tipo, list);
		return list;
	};

	const relationTipos = async (tipo: string): Promise<string[]> =>
		((await nodeOf(tipo))?.relations ?? [])
			.map((link) => link.tipo)
			.filter((target): target is string => typeof target === 'string');

	const relatedByModel = async (tipo: string, wanted: string): Promise<string[]> => {
		const out: string[] = [];
		for (const target of await relationTipos(tipo)) {
			if ((await nodeOf(target))?.model === wanted) out.push(target);
		}
		return out;
	};

	// PHP resolve_alias_recursive (:430): target = first RELATED node of model
	// (alias model minus '_alias'), chained while the target is itself an alias,
	// max 10 hops.
	const resolveAlias = async (tipo: string, depth = 10): Promise<string | null> => {
		if (depth <= 0) return null;
		const model = (await nodeOf(tipo))?.model ?? '';
		if (!model.includes('_alias')) return null;
		const target = (await relatedByModel(tipo, model.replace('_alias', '')))[0] ?? null;
		if (target === null) return null;
		const targetModel = (await nodeOf(target))?.model ?? '';
		return targetModel.includes('_alias') ? resolveAlias(target, depth - 1) : target;
	};

	return {
		nodeOf,
		childTipos,
		relatedByModel,
		relationTipos,
		resolveAlias,
		inTreeChildren,
		byTipo,
	};
}

/** PHP resolve_node_with_alias (:508) result. */
interface ResolvedNode {
	tipo: string;
	model: string;
	label: string | null;
	realTipo: string | null;
	properties: Record<string, unknown> | null;
	isAlias: boolean;
}

async function resolveNodeWithAlias(index: OntologyIndex, tipo: string): Promise<ResolvedNode> {
	const node = await index.nodeOf(tipo);
	const model = node?.model ?? '';
	const isAlias = model.includes('_alias');
	const result: ResolvedNode = {
		tipo,
		model,
		// Mixed class: a database / table node is named by its machine name,
		// an element by its label (labels.ts nameOrLabelOf).
		label: nameOrLabelOf(node),
		realTipo: null,
		properties: null,
		isAlias,
	};
	if (isAlias) {
		result.realTipo = await index.resolveAlias(tipo);
		if (result.realTipo !== null) {
			// Alias own properties win; inherit from the real node when the alias
			// declares none. (Faithful PHP quirk: when the target is UNRESOLVABLE
			// this whole branch is skipped, so even declared alias properties stay
			// null — see resolve_node_with_alias :530-545.)
			const aliasProperties = node?.properties ?? null;
			if (aliasProperties !== null && Object.keys(aliasProperties).length > 0) {
				result.properties = aliasProperties;
			} else {
				result.properties = (await index.nodeOf(result.realTipo))?.properties ?? null;
			}
		}
	} else {
		result.properties = node?.properties ?? null;
	}
	return result;
}

/** Models that open an "under a diffusion element" scope in the walk. */
export const DIFFUSION_ELEMENT_MODELS: ReadonlySet<string> = new Set([
	'diffusion_element',
	'diffusion_element_alias',
]);

/**
 * Build the flat virtual diffusion tree for a diffusion domain.
 *
 * `domainName` defaults to the DEPLOYMENT's configured domain
 * (`DEDALO_DIFFUSION_DOMAIN`), which is what every production caller wants and
 * what this function used to read with no way to say otherwise.
 *
 * WHY IT TAKES AN ARGUMENT (2026-08-20). With the domain read only from config,
 * the tree this function returns is a property of the machine it runs on: a
 * caller could not ask "what does THIS domain compile to", and a test could not
 * build a domain of its own — a generic one would have to share its NAME with
 * the installation's node and would then win or lose by ontology child order.
 * That made two gates permanently bound to one install's diffusion domain. The
 * parameter is the seam: config supplies the default, the caller may be
 * explicit, and nothing about the resolution below changes.
 *
 * Returns null when no domain is configured or given, or when no dd1190 domain
 * node matches it — the PHP fresh-install early return
 * (get_virtual_diffusion_tree :204-210); the caller decides whether that is an
 * error (compile) or an empty answer (maps).
 */
export async function buildVirtualDiffusionTree(
	domainName: string | undefined = readEnv('DEDALO_DIFFUSION_DOMAIN'),
): Promise<VirtualDiffusionTree | null> {
	if (domainName === undefined || domainName === '') return null;

	const index = await loadOntologyIndex();

	// Domain node: dd1190 child of model 'diffusion_domain' whose term equals
	// the configured domain name (PHP get_diffusion_domain_tipo :585).
	let domainTipo: string | null = null;
	for (const childTipo of index.inTreeChildren.get(DIFFUSION_ROOT) ?? []) {
		const child = index.byTipo.get(childTipo);
		// The domain is a name node: matched by its MACHINE NAME, never a label.
		if (child?.model === 'diffusion_domain' && nameOrLabelOf(child) === domainName) {
			domainTipo = childTipo;
			break;
		}
	}
	if (domainTipo === null) return null;

	// 1. Real tipos consumed by an alias anywhere under the domain: their raw
	// branches are suppressed (the alias re-parents them virtually) — PHP
	// get_virtual_diffusion_tree step 1 (:212-223).
	const domainSubtree: string[] = [];
	const collectSubtree = (tipo: string): void => {
		for (const child of index.inTreeChildren.get(tipo) ?? []) {
			domainSubtree.push(child);
			collectSubtree(child);
		}
	};
	collectSubtree(domainTipo);
	const consumedByAlias = new Set<string>();
	for (const tipo of domainSubtree) {
		if ((index.byTipo.get(tipo)?.model ?? '').includes('_alias')) {
			const realTipo = await index.resolveAlias(tipo);
			if (realTipo !== null) consumedByAlias.add(realTipo);
		}
	}

	// ...and the SAME thing computed PER ELEMENT. Domain-wide suppression is only
	// right for whole elements (an element alias really does re-parent one); for a
	// node INSIDE an element it is too broad: the ts_web table mht96 lives under
	// element mht50 and relates to section mht72, but aliases in OTHER elements
	// (mht149 under mht2, mht147 under mht145) also target it, so it vanished from
	// the tree entirely and get_section_diffusion_nodes('mht72') returned [] — the
	// diffusion tool opened with no nodes. v6 has no such suppression (it
	// enumerates table + table_alias per element), and it does offer mht72.
	const consumedByAliasByElement = new Map<string, Set<string>>();
	const collectElementConsumed = async (tipo: string, depth = 0): Promise<void> => {
		if (depth > MAX_WALK_DEPTH) return;
		const model = index.byTipo.get(tipo)?.model ?? '';
		if (DIFFUSION_ELEMENT_MODELS.has(model)) {
			const sub: string[] = [];
			const collect = (current: string): void => {
				for (const child of index.inTreeChildren.get(current) ?? []) {
					sub.push(child);
					collect(child);
				}
			};
			collect(tipo);
			const set = new Set<string>();
			for (const descendant of sub) {
				if ((index.byTipo.get(descendant)?.model ?? '').includes('_alias')) {
					const realTipo = await index.resolveAlias(descendant);
					if (realTipo !== null) set.add(realTipo);
				}
			}
			consumedByAliasByElement.set(tipo, set);
			if (model.includes('_alias')) {
				const realTipo = await index.resolveAlias(tipo);
				if (realTipo !== null) consumedByAliasByElement.set(realTipo, set);
			}
		}
		for (const child of index.inTreeChildren.get(tipo) ?? []) {
			await collectElementConsumed(child, depth + 1);
		}
	};
	await collectElementConsumed(domainTipo);

	// Recursive-children helper (PHP ontology_node::get_ar_recursive_children):
	// DFS preorder over sibling-ordered children, depth-capped defensively.
	const recursiveChildren = async (tipo: string, depth = 0): Promise<string[]> => {
		if (depth > MAX_WALK_DEPTH) return [];
		const out: string[] = [];
		for (const child of await index.childTipos(tipo)) {
			out.push(child);
			out.push(...(await recursiveChildren(child, depth + 1)));
		}
		return out;
	};

	// 2. Walk the virtual structure top-down (PHP walk_virtual_diffusion_tree
	// :302). Every visited node becomes a flat VirtualTreeNode.
	const nodes: VirtualTreeNode[] = [];
	const walk = async (
		currentTipo: string,
		path: VirtualPathItem[],
		depth: number,
		elementTipo: string | null = null,
	): Promise<void> => {
		if (depth > MAX_WALK_DEPTH) return;
		const resolved = await resolveNodeWithAlias(index, currentTipo);

		const isElementNode = DIFFUSION_ELEMENT_MODELS.has(resolved.model);
		const currentElementTipo = isElementNode ? currentTipo : elementTipo;
		// Real node consumed by an alias: domain-wide for a whole ELEMENT (an
		// element alias re-parents it), element-SCOPED for anything inside one.
		if (!resolved.isAlias) {
			if (isElementNode) {
				if (consumedByAlias.has(currentTipo)) return;
			} else if (
				currentElementTipo !== null &&
				(consumedByAliasByElement.get(currentElementTipo)?.has(currentTipo) ?? false)
			) {
				return;
			}
		}

		// Merged recursive children: alias own children first, then the real
		// node's children whose LABEL is not already taken (PHP :335-357 —
		// labels_seen tracks OWN labels only; real-vs-real duplicates survive).
		// "Label" is each child's identifying string (nameOrLabelOf): a field
		// column is deduplicated by its machine name, an element by its label.
		const ownRecursive = await recursiveChildren(currentTipo);
		const mergedChildren = [...ownRecursive];
		if (resolved.isAlias && resolved.realTipo !== null) {
			const ownLabels = new Set<string>();
			for (const child of ownRecursive) {
				const label = nameOrLabelOf(await index.nodeOf(child));
				if (label !== null) ownLabels.add(label);
			}
			for (const child of await recursiveChildren(resolved.realTipo)) {
				const label = nameOrLabelOf(await index.nodeOf(child));
				if (label === null || !ownLabels.has(label)) mergedChildren.push(child);
			}
		}

		// Related sections with the real-node fallback ONLY when the (alias)
		// node declares none (PHP get_section_diffusion_nodes :262-266).
		let relatedSections = await index.relatedByModel(currentTipo, 'section');
		if (relatedSections.length === 0 && resolved.realTipo !== null) {
			relatedSections = await index.relatedByModel(resolved.realTipo, 'section');
		}

		// Direct children in the ORACLE's column order (dd_diffusion_api :1017-
		// 1018): the alias target's children FIRST, the alias's own children
		// LAST so they override a repeated name. Deduped (PHP array_unique).
		const ownDirect = await index.childTipos(currentTipo);
		const directChildrenTipos = [
			...new Set(
				resolved.isAlias && resolved.realTipo !== null
					? [...(await index.childTipos(resolved.realTipo)), ...ownDirect]
					: ownDirect,
			),
		];

		nodes.push({
			tipo: resolved.tipo,
			model: resolved.model,
			label: resolved.label,
			properties: resolved.properties,
			realTipo: resolved.realTipo,
			isAlias: resolved.isAlias,
			parents: path,
			childrenTipos: mergedChildren,
			directChildrenTipos,
			relatedSections,
		});

		// Path item for descendants — immediate parent goes FIRST (PHP :360).
		const pathItem: VirtualPathItem = {
			tipo: resolved.tipo,
			model: resolved.model,
			label: resolved.label,
			realTipo: resolved.realTipo,
		};
		if (DIFFUSION_ELEMENT_MODELS.has(resolved.model)) {
			const diffusion = resolved.properties?.diffusion as { type?: string } | undefined;
			pathItem.type = diffusion?.type ?? 'unknown';
		}
		const newPath = [pathItem, ...path];

		// Recurse into DIRECT children (own + the real node's when aliased),
		// deduped (PHP array_unique :366). NOTE the walk order is own-FIRST here,
		// unlike directChildrenTipos above (:1017 is the column order, :366 the
		// descent order) — both are the oracle's, in their own places.
		const directChildren = [...ownDirect];
		if (resolved.isAlias && resolved.realTipo !== null) {
			directChildren.push(...(await index.childTipos(resolved.realTipo)));
		}
		for (const child of new Set(directChildren)) {
			await walk(child, newPath, depth + 1, currentElementTipo);
		}
	};
	await walk(domainTipo, [], 0);

	return { domainName, domainTipo, nodes, index };
}

/**
 * PHP element_path_matches (:1130): does a path item denote the given
 * diffusion element? Callers may pass either the alias tipo or the resolved
 * real element tipo — both match (the realTipo memo replaces PHP's on-demand
 * resolve_node_with_alias call).
 */
export function elementPathMatches(pathItem: VirtualPathItem, elementTipo: string): boolean {
	if (!DIFFUSION_ELEMENT_MODELS.has(pathItem.model)) return false;
	if (pathItem.tipo === elementTipo) return true;
	return pathItem.model === 'diffusion_element_alias' && pathItem.realTipo === elementTipo;
}

/** All diffusion elements of the domain, in walk order (alias elements kept). */
export function findElementNodes(tree: VirtualDiffusionTree): VirtualTreeNode[] {
	return tree.nodes.filter((node) => DIFFUSION_ELEMENT_MODELS.has(node.model));
}

/**
 * PHP get_diffusion_sections_from_diffusion_element (:1080): every section
 * targeted by nodes under the element. Faithful asymmetry: enumeration takes
 * only the FIRST related section per node (get_related_section_tipo), while
 * per-section node lookup below matches against ALL of them.
 */
export function getSectionsForElement(tree: VirtualDiffusionTree, elementTipo: string): string[] {
	const sections: string[] = [];
	for (const node of tree.nodes) {
		const underElement = node.parents.some((item) => elementPathMatches(item, elementTipo));
		if (!underElement) continue;
		const first = node.relatedSections[0];
		if (first !== undefined && !sections.includes(first)) sections.push(first);
	}
	return sections;
}

/**
 * PHP get_section_node_for_element (:1163): the published artifact node of
 * (element, section) — the table node for SQL, the owl:Class node for RDF.
 * The NEAREST element in the parents path decides ownership (PHP breaks after
 * the first element-model path item), and a REAL 'table' node is preferred
 * over a 'table_alias' (v6 writes to the real table; alias only as fallback).
 */
export function getSectionNodeForElement(
	tree: VirtualDiffusionTree,
	elementTipo: string,
	sectionTipo: string,
): VirtualTreeNode | null {
	let aliasMatch: VirtualTreeNode | null = null;
	for (const node of tree.nodes) {
		if (!node.relatedSections.includes(sectionTipo)) continue;
		for (const pathItem of node.parents) {
			if (!DIFFUSION_ELEMENT_MODELS.has(pathItem.model)) continue;
			// first element found in the path decides this node's element
			if (elementPathMatches(pathItem, elementTipo)) {
				if (node.model === 'table_alias') {
					if (aliasMatch === null) aliasMatch = node;
				} else {
					return node;
				}
			}
			break;
		}
	}
	return aliasMatch;
}

/**
 * PHP get_database_name_for_element (:1205): label of the first
 * database/database_alias node whose parents path contains the element
 * (alias label wins — e.g. 'web_numisdata_mib' over 'web_numisdata_default').
 */
export function getDatabaseNameForElement(
	tree: VirtualDiffusionTree,
	elementTipo: string,
): string | null {
	for (const node of tree.nodes) {
		if (node.model !== 'database' && node.model !== 'database_alias') continue;
		if (node.parents.some((item) => elementPathMatches(item, elementTipo))) {
			return node.label;
		}
	}
	return null;
}
