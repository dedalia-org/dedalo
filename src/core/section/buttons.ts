/**
 * Section BUTTONS context (SECTION_SPEC §9).
 *
 * A section's action definitions — its ontology button_* children in order,
 * gated by permission and the disable/exclude rules, emitted as {typo,type,
 * tipo,model,label} DDOs. Extracted from resolve/structure_context.ts into the
 * section module home.
 *
 * PHP reference: common::get_buttons_context (class.common.php:4179-4326).
 * Per-button ACL: get_permissions(sectionTipo, buttonTipo) < 2 → skip (:4206);
 * properties.disable === true → skip (:4225). No button model is excluded:
 * PHP's $ar_temp_exclude_models holds only component models (the frozen
 * fixtures carry button_import DDOs on the wire).
 */

import { sql } from '../db/postgres.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { labelByTipo } from '../ontology/labels.ts';
import { getNode, getSectionRealTipo } from '../ontology/resolver.ts';
import { getPermissions, type Principal } from '../security/permissions.ts';
import { findSectionChildByModel } from './list_definitions/node_find.ts';

/** One emitted button DDO (PHP dd_object type='button' — null keys dropped). */
export interface ButtonContext {
	typo: string;
	type: string;
	tipo: string;
	model: string;
	/** The button node's ontology properties (dd_object drops the key when null). */
	properties?: unknown;
	label: string | null;
	/** Tool contexts (button_import/button_trigger only — PHP set_tools). */
	tools?: unknown[];
}

/**
 * Button models that dispatch tools: their DDO carries a `tools` array — the
 * user's tools that have a matching properties.tool_config entry, each as a
 * simple context + enriched tool_config (PHP get_buttons_context :4231-4305;
 * the client's open_tool consumes tools[0]). v5-compat pair, future button_tool.
 */
const TOOL_BUTTON_MODELS: ReadonlySet<string> = new Set(['button_import', 'button_trigger']);

/**
 * Ontology-derived caches for the section-context stamp (run on start + every
 * section read). Raw button rows per sectionTipo — permission filtering and
 * the disable check stay per-request downstream, so the rows are user-free.
 * relation_list resolution caches the null result too (a section WITHOUT a
 * relation_list child used to cost 2 queries on every stamp).
 */
const buttonRowsCache = createOntologyCache<string, { tipo: string; model: string }[]>();
const relationListTipoCache = createOntologyCache<string, string | null>();

export function clearSectionButtonsCache(): void {
	buttonRowsCache.clear();
	relationListTipoCache.clear();
}
registerOntologyCacheClearer(clearSectionButtonsCache);

/** A parent node's ordered raw button_* child rows (READ-ONLY, ontology order). */
async function readButtonRows(parent: string): Promise<{ tipo: string; model: string }[]> {
	return (await sql`
		SELECT tipo, model FROM dd_ontology
		WHERE parent = ${parent} AND model LIKE 'button_%'
		ORDER BY order_number NULLS LAST, tipo
	`) as { tipo: string; model: string }[];
}

/**
 * A section's ordered raw button_* child rows (READ-ONLY — shared cache
 * entry). Exported for the hub-completion identity probe
 * (test/unit/ontology_cache_hub_completion.test.ts); the production caller is
 * buildSectionButtons below.
 *
 * VIRTUAL-AWARE (PHP section::get_section_buttons_tipo, class.section.php:1121-1196):
 * a virtual section (getSectionRealTipo → a real section) INHERITS the
 * real section's button_* children, THEN appends its OWN, both filtered by the
 * tipos named in its FIRST exclude_elements child. A plain `WHERE parent = tipo`
 * query returns nothing for a virtual section whose only children are
 * section_list/exclude_elements (e.g. dd1244 → dd623 would lose button_new +
 * button_delete), which is why the buttons never rendered.
 */
export async function sectionButtonRows(
	sectionTipo: string,
): Promise<{ tipo: string; model: string }[]> {
	const cached = buttonRowsCache.get(sectionTipo);
	if (cached !== undefined) return cached;

	const ownRows = await readButtonRows(sectionTipo);

	// Resolve the real section (the ONE law, getSectionRealTipo: the first
	// relation of model 'section'); non-virtual sections resolve to themselves
	// and take their own buttons unchanged (mirrors resolveVirtualEditScope).
	const candidate = await getSectionRealTipo(sectionTipo);
	const realTipo = candidate !== sectionTipo ? candidate : null;

	let rows: { tipo: string; model: string }[];
	if (realTipo === null) {
		rows = ownRows;
	} else {
		// Excluded tipos: the FIRST exclude_elements child's relation nodes (PHP [0]).
		// Absent exclude_elements → nothing filtered (PHP logs a warning, continues).
		const exRows = (await sql`
			SELECT relations FROM dd_ontology
			WHERE parent = ${sectionTipo} AND model = 'exclude_elements'
			ORDER BY order_number NULLS LAST, id LIMIT 1
		`) as { relations: { tipo?: unknown }[] | null }[];
		const excluded = new Set<string>();
		for (const rel of exRows[0]?.relations ?? []) {
			if (typeof rel?.tipo === 'string') excluded.add(rel.tipo);
		}
		// Real section's buttons first, then the virtual section's own additions
		// (PHP [...children_real_tipos, ...children_virtual_tipos]); both filtered.
		// A button tipo has one parent, so the concat can't collide — no dedup.
		rows = [...(await readButtonRows(realTipo)), ...ownRows].filter((r) => !excluded.has(r.tipo));
	}

	buttonRowsCache.set(sectionTipo, rows);
	return rows;
}

/**
 * Build a section's button context. `principal`, when supplied, gates each
 * button by the real per-button ACL get_permissions(sectionTipo, buttonTipo) < 2
 * (PHP :4206). When only `callerPermissions` is available (legacy path), the
 * caller-level cap is used as a proxy — exact for the admin path, over-permissive
 * for non-admins (the §9 defect the Phase B principal wiring removes).
 */
export async function buildSectionButtons(
	sectionTipo: string,
	callerPermissions: number,
	principal?: Principal,
): Promise<ButtonContext[]> {
	// No principal: fall back to the caller-cap proxy (admin path exact).
	if (principal === undefined && callerPermissions < 2) return [];
	const rows = await sectionButtonRows(sectionTipo);
	const buttons: ButtonContext[] = [];
	for (const row of rows) {
		// Per-button ACL (PHP :4206): with a principal, the real grant on this
		// button; without one, the caller cap (already checked >= 2 above).
		if (principal !== undefined) {
			const buttonPermission = await getPermissions(principal, sectionTipo, row.tipo);
			if (buttonPermission < 2) continue;
		}
		const node = await getNode(row.tipo);
		if ((node?.properties as { disable?: boolean } | null)?.disable === true) continue;
		// OWN clone of the node's properties — the tools branch writes the
		// enriched tool_config back into it (see below), and the cache-owned
		// node must never be mutated.
		const properties =
			node?.properties != null
				? (structuredClone(node.properties) as Record<string, unknown>)
				: null;

		// Tool-dispatching buttons (PHP :4231-4305): each user tool with a
		// matching properties.tool_config.<name> becomes a tool context —
		// simple context + enriched tool_config (ddo_map 'self' → the section,
		// model/translatable/label stamped). PHP enriches the SHARED config
		// object, so the enriched map reaches the wire BOTH on tools[n]
		// .tool_config and on the button's own properties.tool_config (the
		// client's open_tool consumes tools[0]; unenriched, tool_common.js
		// never builds the configured components). The Tools-configuration /
		// register override (tool_common::get_tool_configuration, keyed on the
		// button tipo + the section) replaces the ontology ddo_map — and, PHP-
		// exact, an override alone makes the button carry that tool (it is not
		// written back into the button's properties: a fresh object in PHP).
		// T1-43, WC-2026-11-12-tool-configuration-override.
		let tools: unknown[] | null = null;
		if (TOOL_BUTTON_MODELS.has(row.model)) {
			tools = [];
			const { getSuperuserUserTools, getUserTools } = await import('../tools/registry.ts');
			const { resolveElementToolConfig } = await import('../tools/section_tool_context.ts');
			// PHP uses the FULL user tools list (get_user_tools), not the
			// element-filtered get_tools. No principal (legacy path) → the
			// superuser list, matching the admin-exact caller-cap proxy above.
			const userTools =
				principal !== undefined
					? await getUserTools(principal.userId, principal.isGlobalAdmin)
					: await getSuperuserUserTools();
			const toolConfigBag = (properties?.tool_config ?? {}) as Record<string, unknown>;
			for (const tool of userTools) {
				const { enriched, fromOntology } = await resolveElementToolConfig(
					tool.name,
					toolConfigBag[tool.name],
					row.tipo,
					sectionTipo,
					{ tipo: sectionTipo, sectionTipo },
				);
				if (enriched === null) continue;
				if (fromOntology) toolConfigBag[tool.name] = structuredClone(enriched);
				tools.push({ ...tool, tool_config: enriched });
			}
		}

		// Wire key order is PHP dd_object declaration order: properties between
		// model and label, tools last; null-valued keys dropped.
		buttons.push({
			typo: 'ddo',
			type: 'button',
			tipo: row.tipo,
			model: row.model,
			...(properties !== null ? { properties } : {}),
			label: await labelByTipo(row.tipo),
			...(tools !== null ? { tools } : {}),
		});
	}
	return buttons;
}

/**
 * A section's relation_list child tipo (PHP config.relation_list_tipo,
 * class.common.php:2094). A VIRTUAL section without its own node inherits the
 * real section's (rsc167, virtual of rsc2, resolves rsc17 under rsc2); first
 * by order_number. The node lookup is THE one, findSectionChildByModel (T0-7);
 * this keeps only the tipo + its cache.
 *
 * Own node FIRST — deliberately unlike PHP's class.common.php:2077, which calls
 * resolve_virtual=true directly and so would stamp the REAL section's node even
 * for a virtual declaring its own; that would key the References trigger off a
 * different node than the grid columns (getRelationListColumns, own-first).
 */
export async function sectionRelationListTipo(sectionTipo: string): Promise<string | null> {
	// has() (not get()) — a resolved NULL is a valid cached value here.
	if (relationListTipoCache.has(sectionTipo)) {
		return relationListTipoCache.get(sectionTipo) ?? null;
	}
	const resolved = (await findSectionChildByModel(sectionTipo, 'relation_list'))?.tipo ?? null;
	relationListTipoCache.set(sectionTipo, resolved);
	return resolved;
}
