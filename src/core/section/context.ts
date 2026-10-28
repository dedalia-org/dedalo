/**
 * Section CONTEXT stamping (SECTION_SPEC §6) — the section-only extras a
 * structure-context entry carries beyond a component: matrix_table,
 * config.relation_list_tipo, buttons, tools (and, Phase B, the section_map
 * stamp + sqo_session). Extracted from resolve/structure_context.ts into the
 * section module home; invoked from buildStructureContext for model 'section'.
 *
 * PHP reference: common::build_structure_context_core, the $model==='section'
 * block (class.common.php:2056-2101).
 */

import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import type { StructureContextEntry } from '../resolve/structure_context.ts';
import { getPermissions, type Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
import { buildSectionButtons, sectionRelationListTipo } from './buttons.ts';
import {
	canAccessTimeMachineList,
	getTimeMachineListTipo,
} from './list_definitions/time_machine_list.ts';

/** Inputs the section stamp needs from the calling structure-context build. */
export interface SectionStampParams {
	tipo: string;
	permissions: number;
	/** The element's ontology properties (already deep-cloned by the caller). */
	properties: unknown;
	/** When present, buttons use the real per-button ACL (Phase B). */
	principal?: Principal;
	/**
	 * PHP's `$simple` (get_structure_context_simple): the start action and the
	 * search-filter panel build a section WITHOUT its toolbar. The caller derives
	 * it from addRequestConfig===false.
	 */
	simple?: boolean;
}

/**
 * Stamp the section-only context extras onto `entry` in place (PHP :2056-2100):
 * - matrix_table (the section's storage table);
 * - config.relation_list_tipo (the inverse-references inspector trigger, per principal);
 * - config.time_machine_list (the inspector history trigger, per principal);
 * - buttons (the section's permission-gated button_* children);
 * - tools (admin path — the section toolbar).
 */
export async function stampSectionContext(
	entry: StructureContextEntry,
	params: SectionStampParams,
): Promise<void> {
	// The four lookups are independent reads — fetched concurrently (ALS
	// request context flows into every Promise.all branch, docs/
	// REQUEST_ISOLATION.md), then assigned in the original field order (the
	// stamped key order is wire surface).
	const [matrixTable, relationListTipo, timeMachineList, sectionMap, buttons] = await Promise.all([
		getMatrixTableFromTipo(params.tipo),
		grantedRelationListTipo(params.tipo, params.principal ?? currentPrincipal()),
		grantedTimeMachineListTipo(params.tipo, params.principal ?? currentPrincipal()),
		// section_map: the section_map child node's properties (PHP :2075) — maps
		// functional roles (term/parent/order/…) to component tipos per scope.
		getSectionMap(params.tipo),
		// Buttons: the section's ontology button_* children, permission-gated
		// (PHP get_buttons_context). With a principal the per-button ACL applies;
		// without one the caller-cap proxy (admin path exact).
		buildSectionButtons(params.tipo, params.permissions, params.principal),
	]);
	entry.matrix_table = matrixTable;
	entry.config = { relation_list_tipo: relationListTipo, time_machine_list: timeMachineList };
	entry.section_map = sectionMap;
	entry.buttons = buttons;
	// sqo_session (PHP class.common.php:1695-98, stamped PER CALL — session
	// pagination state changes between calls, never cached): the section's
	// stored navigation SQO (sqo_id = the section tipo, section::build_sqo_id
	// is the identity), null when the session holds none. The client syncs its
	// pagination from this ("propagation data problem"); readSectionRows is
	// the writer. ALS-read at call time.
	const { currentRequestContext } = await import('../security/request_context.ts');
	entry.sqo_session = currentRequestContext()?.session?.sqoSession?.[params.tipo] ?? null;

	// Tools: the section's toolbar (PHP common::get_tools). PHP's `$simple`
	// (build_structure_context:1865) is the only MODE gate — a section satisfies
	// the mode half of that condition in EVERY mode, and get_tools() itself
	// carries no permission check (authorization is the per-user user_tools list
	// it iterates). A `permissions >= 3` gate here meant SUPERUSER-ONLY, since
	// only userId -1 reaches 3 (the profile matrix tops out at 2, global admins
	// included), so every real user got a toolbar-less section. The frozen
	// oracle shows PHP's own list-mode section contexts carrying tools, and the
	// perm-1 empties are all `start` — i.e. the SIMPLE build, not a level effect.
	// getSectionTools additionally returns [] for a consultation-only section
	// (Activity dd542 / Time Machine dd15, TODO-042) — those log sections carry
	// no toolbar.
	if (params.simple !== true) {
		const { getSectionTools } = await import('../tools/registry.ts');
		const toolConfigKeys = Object.keys(
			(params.properties as { tool_config?: Record<string, unknown> } | null)?.tool_config ?? {},
		);
		const sectionTools = await getSectionTools(params.tipo, toolConfigKeys);
		entry.tools = sectionTools.tools;
	}
}

/**
 * config.relation_list_tipo (WC-2026-10-27-relation-list-grant-stamp): the
 * section's relation_list node when `principal` holds it (the pair read's Gate A
 * asks, keyed on the possibly-virtual section tipo), else null — the client then
 * offers no Relations block and sends no request. Per call and per principal;
 * no principal answers null (fail-closed). The node lookup stays cached.
 */
async function grantedRelationListTipo(
	sectionTipo: string,
	principal: Principal | undefined,
): Promise<string | null> {
	if (principal === undefined) return null;
	const relationListTipo = await sectionRelationListTipo(sectionTipo);
	if (relationListTipo === null) return null;
	return (await getPermissions(principal, sectionTipo, relationListTipo)) >= 1
		? relationListTipo
		: null;
}

/**
 * config.time_machine_list (WC-2026-10-22-tm-scope-whole-request): the
 * section's time_machine_list tipo when `principal` may read its inspector
 * history (SECTION_SPEC §7.4 — the SAME canAccessTimeMachineList the read
 * gate asks), else null. The client renders the Latest changes / Component
 * history blocks only on a non-null value, so a refused user never sends the
 * dd15 request at all. Stamped PER CALL and PER PRINCIPAL (this stamp is never
 * cached); no principal answers null — fail-closed. An admin of a section with
 * no time_machine_list node gets the section tipo itself: the gate admits a
 * global admin regardless of the node, and the value is a trigger, not a tipo
 * the client resolves.
 */
async function grantedTimeMachineListTipo(
	sectionTipo: string,
	principal: Principal | undefined,
): Promise<string | null> {
	if (principal === undefined) return null;
	if (!(await canAccessTimeMachineList(principal, sectionTipo))) return null;
	return (await getTimeMachineListTipo(sectionTipo)) ?? sectionTipo;
}
