/**
 * PORTAL family resolver (RELATIONS_SPEC.md §6.1) — component_portal plus the
 * legacy autocomplete/autocomplete_hi aliases, and (until their dedicated
 * phases land) every relation model without its own particularity:
 * relation_parent/children, filter, filter_master, external, dataframe.
 *
 * Emits the portal's paginated locator item and expands each paged locator's
 * target record through the child ddos (relation_core.expandPortal). The
 * children are the DIRECT children of the element's NODE
 * (../element_node.ts resolveElement): its effective config — the own config
 * through the one base resolver (request_config/own_config.ts: override → alias
 * → section_list swap in list/tm → real mode) with the caller's children
 * injected per engine and slot (PHP get_subdatum :2603-2681) — show + hide, in
 * every mode but 'solved'.
 *
 * A component may declare SEVERAL config items (a main + a secondary scope, or a
 * dedalo item + a non-dedalo one — rsc368, numisdata162, rsc1285, tchi29,
 * test204). ALL of them contribute children, flattened and deduped by
 * ../config_ddo_map.ts; which of those children a given locator sees is decided
 * by the LOCATOR's own section_tipo in relation_core, never by an api_engine
 * branch.
 *
 * PHP references: component_portal_json.php, class.common.php:2603-2681
 * (injected request_config precedence), trait.request_config_v5.php:618
 * (build_legacy_ddo_map).
 */

import type { Ddo } from '../../concepts/ddo.ts';
import { configOwnerOf, type EmitRow } from '../../concepts/emit_row.ts';
import type { RelationEmitContext, RelationModelResolver } from '../registry.ts';
import { expandPortal } from '../relation_core.ts';

/**
 * component_filter/filter_master resolver. PHP component_filter_json switches on
 * mode like the select family — NOT the portal path:
 * - list/tm → the authorized-project LABELS that appear in the stored data
 *   (get_list_value);
 * - edit → the stored locators as entries + the authorized-projects DATALIST
 *   (get_datalist, the {type:'project',…} option set);
 * - other modes → the generic portal machinery (no own-config child expansion —
 *   the projects panel never runs subdatum over the targets).
 */
export const filterResolver: RelationModelResolver = {
	model: 'component_filter',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const { ddo, record, row, ddoMode, callerTipo, emission } = context;
		// list/edit/search emit the authorized-projects datalist; SEARCH renders it
		// as filter checkboxes (client render_search reads data.datalist), reusing
		// the edit branch below. Other modes take the portal path.
		if (ddoMode !== 'list' && ddoMode !== 'edit' && ddoMode !== 'search') {
			await portalResolver.emitDdoItems({ ...context, allowOwnConfigChildren: false });
			return;
		}
		const { buildDataItem } = await import('../../resolve/component_data.ts');
		const { getFilterDatalist, getFilterListValue } = await import('../filter_projects.ts');
		const storedLocators =
			((record.columns.relation as Record<string, unknown[]> | null)?.[context.dataTipo] as {
				section_tipo?: unknown;
				section_id?: unknown;
			}[]) ?? [];

		if (ddoMode === 'list') {
			const labels = await getFilterListValue(storedLocators);
			const item = buildDataItem(
				ddo.tipo,
				row.section_tipo,
				row.section_id,
				ddoMode,
				'lg-nolan',
				labels.length > 0 ? labels : null,
			);
			item.row_section_id = row.section_id;
			item.parent_tipo = callerTipo;
			emission.items.push(item);
			return;
		}
		// edit: stored locators as entries + the authorized-projects datalist.
		// Empty → [] (not null) so data.entries is always an array (life-cycle
		// suite test_component_filter asserts Array.isArray(entries); the shared
		// record's value gets cleared by a prior test in the suite).
		const item = buildDataItem(
			ddo.tipo,
			row.section_tipo,
			row.section_id,
			ddoMode,
			'lg-nolan',
			storedLocators.length > 0 ? storedLocators : [],
		);
		item.datalist = await getFilterDatalist();
		item.row_section_id = row.section_id;
		item.parent_tipo = callerTipo;
		emission.items.push(item);
	},
};

/**
 * The section a portal cell's OWN config resolves against (its owner section —
 * what 'self' in that config means, and the node key's section): ALWAYS the
 * record the cell sits on (configOwnerOf — the subject record for a dd15 host
 * row, whose ddo section_tipo binds the HOST, not the owner).
 *
 * PHP get_subdatum builds every non-dataframe child with
 * `$section_tipo = $current_locator->section_tipo` (class.common.php
 * ~2443-2444): the ROW's section, never the ddo's declared one. That holds at
 * a read's top level too — a multi-section read (es1 + fr1 thesaurus rows, an
 * sqo over several sections) hands ONE column ddo to every row
 * (section/read_source.ts emitRow), and the column map keeps only its FIRST
 * section (read.ts deriveSectionDdoMap). Owning an fr1 row's cell by the ddo's
 * section resolved its 'self' targets against es1, stamped its children es1,
 * and expandPortal's per-locator filter then dropped every child at the fr1
 * targets (a blank cell); it also folded every section's rows into one es1
 * node. The ddo's declared section decides only whether a ddo applies to a
 * row — never whose config it is.
 */
export function ownConfigSectionTipo(row: EmitRow): string {
	return configOwnerOf(row).section_tipo;
}

export const portalResolver: RelationModelResolver = {
	model: 'component_portal',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const {
			ddo,
			ddoMap,
			record,
			row,
			model,
			ddoMode,
			ddoLang,
			defaultMode,
			defaultLang,
			callerTipo,
			emission,
			allowOwnConfigChildren,
			depth,
			scope,
			emitDdo,
		} = context;
		const {
			depthBoundNotice,
			MAX_DDO_DEPTH,
			nodeListPageLimit,
			occurrenceKey,
			recordCycleNotice,
			resolveEmittedElement,
		} = await import('../element_node.ts');

		// THE ELEMENT'S NODE (relations/element_node.ts): its EFFECTIVE config —
		// the own config (the ONE base resolver: override → alias → section_list
		// swap in list/tm → real mode) with the PARENT's children injected per
		// engine and slot (PHP get_subdatum :2603-2681), the governing ddo's limit
		// as its page size. At a read's top level the parent is the read's ROOT
		// map (the section's column map, a TM column map …). The children below
		// are that config's show + hide, in EVERY mode but 'solved' — the caller
		// map no longer has to carry every level, and a nested portal in a list
		// cell falls back to its own config like PHP (plan E2). Resolved through
		// the ONE emitted-element spelling (resolveEmittedElement — the own
		// config built in the READ's data lang, never the portal's lg-nolan), so
		// the item binding and the context door meet this same node.
		const node = await resolveEmittedElement({
			ddo,
			ddoMap,
			row,
			model,
			ddoMode,
			ddoLang,
			defaultMode,
			defaultLang,
			callerTipo,
			registry: emission.nodes,
			...(scope !== undefined ? { scope } : {}),
			useOwnConfig: allowOwnConfigChildren,
		});

		// RECORD CYCLE (owner decision (e)): this element on this record already
		// sits on the path from the read's top level (A's portal → B → B's portal
		// → A → A's portal …). Stop at the repeat: the portal's own item is still
		// emitted, its targets are not expanded again, and a typed notice names
		// the cycle. Only THIS path stops — the same record reached through a
		// different path (a diamond) is not a cycle.
		// The occurrence is the element's OWN record (configOwnerOf): a Time
		// Machine list cell is bound to a dd15 row but IS the subject record's
		// component — keyed by the dd15 row, the list would expand one cycle
		// round more than the preview of the same row (which is keyed by the
		// record, section/read.ts readComponentData).
		const owner = configOwnerOf(row);
		const path = scope?.path ?? [];
		const occurrence = occurrenceKey(owner, ddo.tipo);
		const isCycle = path.includes(occurrence);
		if (isCycle) {
			emission.nodes.addNotices([await recordCycleNotice(owner, ddo.tipo, path.length)]);
		}
		// DEPTH BOUND (element_node.ts MAX_DDO_DEPTH): the children would sit one
		// hop deeper than the bound. A chain the ONTOLOGY drives (own configs,
		// a derived map) is ordinary data — stop here with a typed notice, the
		// rest of the read completes. A CLIENT-map-driven chain goes on to
		// emitDdoData's loud refusal (the request asked for it).
		const atDepthBound = !isCycle && depth + 1 > MAX_DDO_DEPTH && node.childOrigin !== 'client';
		if (atDepthBound && node.children.length > 0) {
			emission.nodes.addNotices([await depthBoundNotice(owner, ddo.tipo, depth)]);
		}
		const children = isCycle || atDepthBound ? [] : (node.children as unknown as Ddo[]);

		// The LIST/TM cell page size follows the effective config (the section_list
		// swap included — what resolveListCellMap used to read raw); the governing
		// ddo's own `limit` still wins inside expandPortal.
		const cellLimit = ddoMode === 'list' ? nodeListPageLimit(node) : null;
		await expandPortal(
			record,
			ddo,
			model,
			children,
			ddoMode,
			ddoLang,
			row,
			callerTipo,
			emission,
			emitDdo,
			{
				node,
				path: [...path, occurrence],
				childrenLang: defaultLang,
				cellLimit,
				// The thesaurus-table ddinfo branch keeps its pre-existing scope (the
				// element's own DATA children — show + hide not replaced by a caller;
				// a search/choose-only caller leaves them own, plan E3, so it never
				// narrows the branch); the value_with_parents trigger
				// reads the governing children whoever supplied them (relation_core).
				childrenFromOwnConfig: node.configSource === 'own' && !node.dataChildrenInjected,
				depth,
			},
		);
	},
};
