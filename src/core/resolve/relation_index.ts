/**
 * component_relation_index — the "who points to me?" inverse-reference
 * component (PHP class.component_relation_index). It stores nothing of its
 * own: its data is COMPUTED by searching every relation-capable matrix table
 * for locators of type dd96 (DEDALO_RELATION_TYPE_INDEX_TIPO) that target the
 * current record.
 *
 * List-cell output (PHP component_relation_index_json):
 *   - entries: one page of inverse locators (parse_data field mapping:
 *     from_section_tipo/from_section_id → section_tipo/section_id,
 *     from_component_tipo → from_component_top_tipo), section_id as string.
 *   - pagination: {total: full inverse count, limit, offset}.
 *   - children: for each pointing section tipo (group_by), the section's
 *     related_list components resolved against [representative record, …page
 *     locator records] — the representative comes from a limit-1 default-order
 *     search (section_id ASC) in get_related_section_context; the page
 *     locators pile up in the SAME cached section instance's record pool, so
 *     the per-locator get_json emits representative + page records together.
 *
 * Helpers here; the emission loop lives in read_rows.ts (shares
 * emitDdoData/buildDataItem).
 */

import { sql } from '../db/postgres.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import type { InverseReferenceLocatorHit } from '../search/search_related.ts';
import { findSectionChildByModel } from '../section/list_definitions/node_find.ts';

/** PHP parse_data: raw breakdown hit → client locator entry. */
export function parseInverseEntry(hit: InverseReferenceLocatorHit): Record<string, unknown> {
	const raw = hit.locator_data as {
		type?: unknown;
		tag_component_tipo?: unknown;
		tag_id?: unknown;
		section_top_id?: unknown;
		section_top_tipo?: unknown;
		from_component_tipo?: unknown;
	};
	const entry: Record<string, unknown> = {
		type: raw.type,
		section_tipo: hit.section_tipo,
		// The owning record's address, canonical INT — the DB column's own type,
		// passed through untouched (WC-2026-08-10-section-id-int-canonical
		// repeals "PHP keeps the DB-driver string form").
		section_id: hit.section_id,
	};
	if (raw.tag_component_tipo !== undefined) entry.component_tipo = raw.tag_component_tipo;
	if (raw.tag_id !== undefined) entry.tag_id = raw.tag_id;
	if (raw.section_top_id !== undefined) entry.section_top_id = raw.section_top_id;
	if (raw.section_top_tipo !== undefined) entry.section_top_tipo = raw.section_top_tipo;
	if (raw.from_component_tipo !== undefined) {
		entry.from_component_top_tipo = raw.from_component_tipo;
	}
	return entry;
}

const relatedListCache = createOntologyCache<string, string[]>();

/** Drop the ontology-derived related_list child-tipos cache. */
export function clearRelatedListCache(): void {
	relatedListCache.clear();
}
registerOntologyCacheClearer(clearRelatedListCache);

/**
 * The section's related_list component tipos (PHP
 * resolve_ar_related_related_list, trait.request_config_v5.php:295-330): the
 * relation nodes of the section's relation_list ontology child — own first,
 * then through the VIRTUAL section's real section (rsc205 → rsc3 → rsc133 →
 * [rsc349, rsc140, rsc224]), first by order_number. The node lookup is THE one,
 * findSectionChildByModel (T0-7); this keeps only the relations + its cache.
 * No section_map scope here (PHP applies that to the References grid only).
 */
export async function getRelatedListChildTipos(sectionTipo: string): Promise<string[]> {
	const cached = relatedListCache.get(sectionTipo);
	if (cached !== undefined) return cached;

	const node = await findSectionChildByModel(sectionTipo, 'relation_list');
	const tipos = (node?.relations ?? [])
		.map((link) => link.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
	relatedListCache.set(sectionTipo, tipos);
	return tipos;
}

/**
 * The representative record of a pointing section (PHP
 * get_related_section_context: limit-1 search, default order section_id ASC).
 */
export async function getRepresentativeSectionId(
	table: string,
	sectionTipo: string,
): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT MIN(section_id) AS id FROM "${table}" WHERE section_tipo = $1`,
		[sectionTipo],
	)) as { id: number | string | null }[];
	const id = rows[0]?.id;
	return id === null || id === undefined ? null : Number(id);
}
