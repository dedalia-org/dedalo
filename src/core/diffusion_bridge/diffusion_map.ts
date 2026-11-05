/**
 * Section-diffusion map (PHP diffusion_utils::get_section_diffusion_map):
 * which sections participate in ANY diffusion output — the O(1) lookup
 * behind tool_diffusion::is_available.
 *
 * Build (one flat VIRTUAL diffusion tree walk, v7 conventions — aliases
 * resolve flat, no v6 nested maps):
 *   1. domain node = the dd1190 child of model 'diffusion_domain' whose term
 *      equals the configured DEDALO_DIFFUSION_DOMAIN name;
 *   2. real nodes CONSUMED by an alias anywhere in the domain are skipped in
 *      their raw position (the alias re-parents them virtually);
 *   3. walk top-down; every node that sits UNDER a diffusion_element /
 *      diffusion_element_alias contributes its related 'section' tipos (the
 *      alias's REAL node's relations as fallback when the alias declares
 *      none); alias nodes also descend into their real node's children.
 *
 * THIS module owns only the DB seam + the two process caches: the walk rules
 * live in the pure ./diffusion_graph.ts (which imports neither postgres.ts
 * nor env.ts), driven through the DiffusionGraph built by
 * createDbDiffusionGraph() below.
 *
 * No configured domain (env DEDALO_DIFFUSION_DOMAIN unset / no match) →
 * EMPTY map, matching PHP's fresh-install early return.
 */

import { readEnv } from '../../config/env.ts';
import { sql } from '../db/postgres.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { getOrderedSubtree, type OntologySubtreeNode } from '../ontology/resolver.ts';
import {
	type DiffusionGraph,
	type DiffusionNode,
	type DiffusionSqlTarget,
	type MediaIndexTarget,
	resolveDomainTipo,
	selectMediaIndexTargets,
	walkDiffusionSections,
	walkDiffusionTargets,
} from './diffusion_graph.ts';

export type { DiffusionSqlTarget, MediaIndexTarget };

const DIFFUSION_ROOT = 'dd1190'; // DEDALO_DIFFUSION_TIPO

let mapCache: Set<string> | null = null;

export function clearDiffusionMapCache(): void {
	mapCache = null;
}

/** Accessor node → the graph's row shape (same fields the raw walk selected). */
function toNodeRow(node: OntologySubtreeNode): DiffusionNode {
	return {
		tipo: node.tipo,
		parent: node.parent,
		model: node.model ?? '',
		term: node.term,
		machine_name: node.machine_name,
		use_machine_name: node.use_machine_name,
		relations: node.relations as { tipo?: string }[] | null,
	};
}

/**
 * The DB-backed DiffusionGraph: the whole dd1190 subtree through the
 * canonical accessor (S2-19/T3 — full structural walk, crossSections, root
 * included), plus lazy dd_ontology reads for anything OUTSIDE it (alias
 * targets and related sections can live anywhere).
 *
 * Sibling order matters: PHP walks children ORDER BY order_number ASC
 * (dd_ontology_db_manager::search), and the walk order decides FIRST-hit
 * selections downstream (which database label an element inherits, which
 * table_alias indexes a section when no real table matches). The accessor's
 * DFS pre-order applies exactly that policy (compareSiblingOrder: order ASC
 * nulls-last, tipo tiebreak), so the grouped children lists are already
 * canonically sorted.
 */
async function createDbDiffusionGraph(): Promise<DiffusionGraph> {
	const rows = (
		await getOrderedSubtree(DIFFUSION_ROOT, { includeRoot: true, crossSections: true })
	).map(toNodeRow);
	const byTipo = new Map(rows.map((row) => [row.tipo, row]));
	const childrenOf = new Map<string, string[]>();
	for (const row of rows) {
		if (row.parent === null) continue;
		const list = childrenOf.get(row.parent) ?? [];
		list.push(row.tipo);
		childrenOf.set(row.parent, list);
	}

	const external = new Map<string, DiffusionNode | null>();
	const externalChildren = new Map<string, string[]>();

	return {
		async node(tipo: string): Promise<DiffusionNode | null> {
			const inTree = byTipo.get(tipo);
			if (inTree !== undefined) return inTree;
			const cached = external.get(tipo);
			if (cached !== undefined) return cached;
			const found = (await sql.unsafe(
				'SELECT tipo, parent, model, term, machine_name, use_machine_name, relations FROM dd_ontology WHERE tipo = $1',
				[tipo],
			)) as DiffusionNode[];
			const node = found[0] ?? null;
			external.set(tipo, node);
			return node;
		},
		async children(tipo: string): Promise<string[]> {
			const inTree = childrenOf.get(tipo);
			if (inTree !== undefined || byTipo.has(tipo)) return inTree ?? [];
			const cached = externalChildren.get(tipo);
			if (cached !== undefined) return cached;
			const found = (await sql.unsafe('SELECT tipo FROM dd_ontology WHERE parent = $1', [
				tipo,
			])) as {
				tipo: string;
			}[];
			const list = found.map((row) => row.tipo);
			externalChildren.set(tipo, list);
			return list;
		},
		async properties(tipo: string): Promise<Record<string, unknown> | null> {
			const found = (await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [
				tipo,
			])) as { properties: Record<string, unknown> | null }[];
			return found[0]?.properties ?? null;
		},
	};
}

/** Sections with diffusion (the map keys). Cached per process. */
export async function getSectionDiffusionMap(): Promise<Set<string>> {
	if (mapCache !== null) return mapCache;

	const domainName = readEnv('DEDALO_DIFFUSION_DOMAIN');
	if (domainName === undefined || domainName === '') {
		mapCache = new Set<string>();
		return mapCache;
	}

	const graph = await createDbDiffusionGraph();
	const domainTipo = await resolveDomainTipo(graph, DIFFUSION_ROOT, domainName);
	if (domainTipo === null) {
		mapCache = new Set<string>();
		return mapCache;
	}

	mapCache = await walkDiffusionSections(graph, domainTipo);
	return mapCache;
}

/** tool_diffusion::is_available — sections only, O(1) map lookup. */
export async function haveSectionDiffusion(sectionTipo: string): Promise<boolean> {
	return (await getSectionDiffusionMap()).has(sectionTipo);
}

let targetsCache: Map<string, DiffusionSqlTarget[]> | null = null;

export function clearDiffusionTargetsCache(): void {
	targetsCache = null;
}

/**
 * Per-section publish targets (PHP get_section_diffusion_nodes + the
 * diffusion_delete grouping): every virtual node under a diffusion element
 * that relates to the section becomes a target — for 'sql'/'socrata'
 * elements the pair (database node label under the element, the related
 * node's alias-aware label) is the published table address. File-based
 * types (rdf/xml/markdown) are collected with empty db/table (the caller
 * ledgers them).
 */
export async function getSectionDiffusionTargets(
	sectionTipo: string,
): Promise<DiffusionSqlTarget[]> {
	if (targetsCache === null) {
		targetsCache = await buildDiffusionTargets();
	}
	return targetsCache.get(sectionTipo) ?? [];
}

/**
 * The WHOLE per-section target map (every section that publishes, every
 * element/target it publishes to — sql AND file types). The public_tier
 * reconcile walks it to ask, per target, what the matrix says should be
 * there (2026-09-03, P1-12). Read-only view of the process cache.
 */
export async function getAllSectionDiffusionTargets(): Promise<
	ReadonlyMap<string, readonly DiffusionSqlTarget[]>
> {
	if (targetsCache === null) {
		targetsCache = await buildDiffusionTargets();
	}
	return targetsCache;
}

/**
 * EVERY sql/socrata publication target of the diffusion map, deduped by
 * (database, table, section) — PHP dd_diffusion_api::resolve_media_index_targets.
 * The selection rule itself is pure: ./diffusion_graph.ts selectMediaIndexTargets.
 */
export async function getAllMediaIndexTargets(): Promise<MediaIndexTarget[]> {
	if (targetsCache === null) {
		targetsCache = await buildDiffusionTargets();
	}
	return selectMediaIndexTargets(targetsCache);
}

async function buildDiffusionTargets(): Promise<Map<string, DiffusionSqlTarget[]>> {
	const domainName = readEnv('DEDALO_DIFFUSION_DOMAIN');
	if (domainName === undefined || domainName === '') return new Map();

	const graph = await createDbDiffusionGraph();
	const domainTipo = await resolveDomainTipo(graph, DIFFUSION_ROOT, domainName);
	if (domainTipo === null) return new Map();

	return walkDiffusionTargets(graph, domainTipo);
}

// Both caches are pure dd_ontology interpretation (dd1190 is runtime-mutable
// by design), so any ontology write invalidates them — register with the
// write-chokepoint hub at module load (the hub is a leaf import; an unloaded
// module holds no stale cache).
registerOntologyCacheClearer(clearDiffusionMapCache);
registerOntologyCacheClearer(clearDiffusionTargetsCache);
