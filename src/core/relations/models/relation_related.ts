/**
 * RELATION_RELATED resolver (RELATIONS_SPEC.md §6.6 — associative links with
 * directionality and the transitive closure "if a=b and b=c then c=a").
 *
 * Every non-search mode attaches the COMPUTED back-references to the item
 * as `references` [{value, label}] — [] stays OFF the item (PHP
 * component_relation_related_json :160-173). The graph walk lives in
 * relations/related.ts; UNIDIRECTIONAL components skip it entirely.
 *
 * Every mode (list included) emits through the generic portal path: the
 * own paginated locator item + each target expanded through the declared
 * show.ddo_map children (WC-2026-11-10-related-list-cells — PHP's list
 * subdatum emitted only the target's section_id item, a blank client cell).
 * Non-search items emit even when the stored data is EMPTY (PHP: "must be
 * available even when empty to allow adding references from client") —
 * unlike the generic portal path, which skips empty relations.
 *
 * PHP references: class.component_relation_related.php
 * (get_references_recursive :274, get_type_rel :231),
 * component_relation_related_json.php (:90-173).
 */

import { configOwnerOf } from '../../concepts/emit_row.ts';
import type { DataItem } from '../../resolve/component_data.ts';
import { buildDataItem } from '../../resolve/component_data.ts';
import type { RelationEmitContext, RelationModelResolver } from '../registry.ts';
import { PORTAL_LIST_LIMIT } from '../relation_core.ts';
import { portalResolver } from './portal.ts';

/** Attach computed references to the component's own item (non-search modes). */
async function attachReferences(
	context: RelationEmitContext,
	item: DataItem | undefined,
): Promise<void> {
	if (item === undefined || context.ddoMode === 'search') return;
	const { getCalculatedReferences } = await import('../related.ts');
	const { getNode } = await import('../../ontology/resolver.ts');
	const { buildRequestConfigForElement } = await import('../request_config/build.ts');
	const node = await getNode(context.ddo.tipo);
	const config = await buildRequestConfigForElement(node?.properties ?? null, {
		ownerTipo: context.ddo.tipo,
		ownerSectionTipo: configOwnerOf(context.row).section_tipo,
		mode: 'edit',
		ownerIsSection: false,
		lang: context.defaultLang,
	});
	const show = config[0]?.show as
		| { ddo_map: { tipo: string }[]; fields_separator?: string }
		| null
		| undefined;
	const references = await getCalculatedReferences(
		context.ddo.tipo,
		context.row.section_tipo,
		context.row.section_id,
		context.defaultLang,
		{
			showDdoTipos: (show?.ddo_map ?? []).map((ddo) => ddo.tipo),
			fieldsSeparator: show?.fields_separator ?? ' | ',
		},
	);
	if (references.length > 0) {
		item.references = references;
	}
}

export const relationRelatedResolver: RelationModelResolver = {
	model: 'component_relation_related',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const { ddo, row, ddoMode, callerTipo, emission } = context;

		// EVERY mode takes the generic portal path (the list grid included —
		// WC-2026-11-10-related-list-cells: the cell expands the declared
		// show.ddo_map children, never the target's section_id item) — with the
		// relation_related particularities: the item emits even when EMPTY, and
		// computed references attach to it. Legacy string section_id / external
		// remote ids: expandPortal canonicalizes the first and renders the second
		// through derived children; the own item always carries every stored
		// locator verbatim, so none is dropped.
		const before = emission.items.length;
		await portalResolver.emitDdoItems(context);
		let ownItem = emission.items
			.slice(before)
			.find((entry) => (entry as DataItem).tipo === ddo.tipo) as DataItem | undefined;
		if (ownItem === undefined && ddoMode !== 'search') {
			// Empty stored data: the portal path emits nothing — PHP still
			// emits the (empty) item so the client can add references. Its page
			// size is ddo.limit ?? the mode default (no list-config lookup: total 0).
			ownItem = buildDataItem(ddo.tipo, row.section_tipo, row.section_id, ddoMode, 'lg-nolan', []);
			ownItem.pagination = {
				total: 0,
				limit: ddo.limit ?? (ddoMode === 'list' ? PORTAL_LIST_LIMIT : 10),
				offset: 0,
			};
			ownItem.parent_tipo = callerTipo;
			ownItem.parent_section_id = row.section_id;
			ownItem.row_section_id = row.section_id;
			emission.items.push(ownItem);
		}
		await attachReferences(context, ownItem);
	},
};
