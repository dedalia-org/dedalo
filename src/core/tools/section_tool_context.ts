/**
 * section_tool tool_context building — shared by the TWO flows that ship a
 * section_tool's configured components (its `properties.tool_config.<tool>.ddo_map`)
 * to the client:
 *
 *  - the menu rewrite (PHP class.menu.php:216-255 → api/handlers/menu.ts
 *    buildSectionToolItem), and
 *  - the direct-URL `start` reroute (PHP class.dd_core_api.php:388-458 →
 *    api/handlers/dd_core_api.ts start).
 *
 * Enrichment semantics are PHP tool_common::create_tool_simple_context
 * (class.tool_common.php:550-668): resolve the ddo_map 'self' sentinels to the
 * runtime tipo/section_tipo (null on both current flows — PHP passes none),
 * fill a missing `model` from the ontology, and stamp `translatable` + the
 * app-lang `label` on every entry. Without this context the client's
 * tool_common.js cascade falls back to a synthetic single-entry ddo_map and
 * the configured components are never built.
 */

import { getOntologyTermLabel } from '../ontology/labels.ts';
import { getModelByTipo, getTranslatableByTipo } from '../ontology/resolver.ts';
import type { ToolSimpleContext } from './types.ts';

/**
 * Enrich one raw `tool_config` value (the ontology row's
 * properties.tool_config[toolName]) for the wire. selfTipo/selfSectionTipo
 * replace the 'self' sentinels (PHP $tipo/$section_tipo — null on the menu and
 * start flows; the params exist for the still-unported full get_tools overlay,
 * class.common.php:1874-1913).
 */
export async function enrichToolConfig(
	rawToolConfig: unknown,
	selfTipo: string | null = null,
	selfSectionTipo: string | null = null,
): Promise<Record<string, unknown> | null> {
	// NEVER mutate the ontology row's properties — deep-clone before enriching.
	const toolConfig = structuredClone(rawToolConfig) as Record<string, unknown> | null;
	if (toolConfig !== null && Array.isArray(toolConfig.ddo_map)) {
		const enriched: unknown[] = [];
		for (const raw of toolConfig.ddo_map) {
			const entry = raw as Record<string, unknown>;
			if (entry.tipo === 'self') entry.tipo = selfTipo;
			if (entry.section_tipo === 'self') entry.section_tipo = selfSectionTipo;
			const entryTipo = typeof entry.tipo === 'string' ? entry.tipo : null;
			if (entryTipo !== null) {
				if (entry.model === undefined) {
					entry.model = await getModelByTipo(entryTipo);
				}
				entry.translatable = await getTranslatableByTipo(entryTipo);
				entry.label = await getOntologyTermLabel(entryTipo);
			}
			enriched.push(entry);
		}
		toolConfig.ddo_map = enriched;
	}
	return toolConfig;
}

/**
 * The `tool_context` DDO for one section_tool node: the registered tool's
 * simple context + the enriched tool_config (PHP appends tool_config LAST —
 * class.tool_common.php:663 — so the spread order is wire-load-bearing).
 * Returns null when the bag is empty or the named tool is not in the supplied
 * tools list (the CALLER decides drop-the-item (menu) vs ship-without (start)).
 */
export async function buildSectionToolContext(
	toolConfigBag: Record<string, unknown>,
	userTools: ToolSimpleContext[],
): Promise<Record<string, unknown> | null> {
	// The tool name is the first (and only) key of the tool_config sub-object.
	const toolName = Object.keys(toolConfigBag)[0];
	if (toolName === undefined) return null;
	const toolInfo = userTools.find((tool) => tool.name === toolName);
	if (toolInfo === undefined) return null;
	const toolConfig = await enrichToolConfig(toolConfigBag[toolName]);
	return { ...toolInfo, tool_config: toolConfig };
}
