/**
 * component_inverse EMIT HOOK — a REPLACE hook (the media / section_id /
 * external shape): it fully owns the ddo's emission and the generic path
 * returns after it.
 *
 * It must own emission because the value is DERIVED (descriptor `derived`):
 * the backlinks of the host record — every locator, held by any relation
 * component of any record, that points at it. The generic literal path read
 * the empty `misc` slot under the tipo and emitted `entries: []` for every
 * row, so every consumer of the computed list (tool_cataloging's "used" drag
 * marker, the component's own list/edit views) saw no references at all.
 *
 * PHP parity (component_inverse::get_data → section_record::
 * get_inverse_references → search_related::get_referenced_locators): one entry
 * per referencing LOCATOR (the breakdown — an owner holding two locators to
 * this record in two components yields two entries), each the stored locator
 * itself (so it keeps its own `from_component_tipo`, `type`, …) stamped with
 * the owner's `from_section_tipo` and `from_section_id` (a STRING, as the PHP
 * row carried it — see samples/api_data.json). A record without a section_id
 * has no backlinks (PHP returns [] before searching).
 *
 * THE ITEM: `lang: 'lg-nolan'` (not translatable), `entries` per WC-001 (never
 * null; `[]` when nothing points here).
 */

import { buildDataItem } from '../../resolve/component_data.ts';
import { findInverseReferenceLocators } from '../../search/search_related.ts';
import type { ComponentEmitHook, EmitHookContext } from '../emit_hooks.ts';

/** One backlink as the wire carries it: the stored locator + its owner's coordinates. */
export type InverseEntry = Record<string, unknown> & {
	from_section_tipo: string;
	from_section_id: string;
};

/**
 * The backlinks of one record (PHP section_record::get_inverse_references).
 * Order: section_id ASC — PHP's default related-search order
 * (build_sql_query_order_default), with the breakdown's total tiebreak.
 */
export async function resolveInverseEntries(
	sectionTipo: string,
	sectionId: number,
): Promise<InverseEntry[]> {
	if (!sectionId) return [];
	const hits = await findInverseReferenceLocators(
		[{ section_tipo: sectionTipo, section_id: sectionId }],
		{ order: 'section_id' },
	);
	return hits.map((hit) => ({
		...hit.locator_data,
		from_section_tipo: hit.section_tipo,
		from_section_id: String(hit.section_id),
	}));
}

export const inverseEmitHook: ComponentEmitHook = {
	async emitItem(context: EmitHookContext): Promise<void> {
		const { ddo, row, ddoMode, callerTipo, emission } = context;
		const entries = await resolveInverseEntries(row.section_tipo, row.section_id);
		const item = buildDataItem(
			ddo.tipo,
			row.section_tipo,
			row.section_id,
			ddoMode,
			'lg-nolan',
			entries,
		);
		item.row_section_id = row.section_id;
		item.parent_tipo = callerTipo;
		emission.items.push(item);
	},
};
