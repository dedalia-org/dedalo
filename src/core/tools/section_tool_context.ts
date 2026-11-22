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
import { getToolConfigurationOverride } from './config.ts';
import type { ToolSimpleContext } from './types.ts';

/**
 * Enrich one raw `tool_config` value (the ontology row's
 * properties.tool_config[toolName]) for the wire. selfTipo/selfSectionTipo
 * replace the 'self' sentinels (PHP $tipo/$section_tipo — null on the menu and
 * start flows; the element on the toolbar/button stamps, resolveElementToolConfig).
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

/** An element's resolved tool_config: the enriched value + where its base came from. */
export interface ElementToolConfig {
	/** The enriched tool_config for the wire (null: neither ontology nor override defines one). */
	enriched: Record<string, unknown> | null;
	/**
	 * True when the element's ONTOLOGY defined the tool's config. PHP mutates the
	 * shared properties object only then (a config created from an override alone
	 * is a fresh object), so only then do callers write the enriched value back
	 * into the emitted `properties.tool_config`.
	 */
	fromOntology: boolean;
}

/**
 * The ONE element tool_config stamp (PHP common::build_structure_context
 * :1874-1916 / get_buttons_context :4241-4295): the element's ontology
 * `properties.tool_config[toolName]`, its `ddo_map` replaced by the Tools
 * configuration / register override for (tipo, sectionTipo) when one matches
 * (src/core/tools/config.ts getToolConfigurationOverride), enriched with 'self'
 * resolved to `self` (default: the matched element; a section BUTTON matches on
 * its own tipo but resolves 'self' to its section — PHP passes $this->tipo).
 * Never mutates `ontologyToolConfig`.
 */
export async function resolveElementToolConfig(
	toolName: string,
	ontologyToolConfig: unknown,
	tipo: string,
	sectionTipo: string,
	self: { tipo: string; sectionTipo: string } = { tipo, sectionTipo },
): Promise<ElementToolConfig> {
	const fromOntology = ontologyToolConfig !== undefined && ontologyToolConfig !== null;
	const override = await getToolConfigurationOverride(toolName, tipo, sectionTipo);
	if (override === null) {
		if (!fromOntology) return { enriched: null, fromOntology };
		return {
			enriched: await enrichToolConfig(ontologyToolConfig, self.tipo, self.sectionTipo),
			fromOntology,
		};
	}
	// PHP `$tool_config ??= new stdClass(); $tool_config->ddo_map = …` — only the
	// ddo_map is replaced; every other ontology key of the tool's config stays.
	const base =
		typeof ontologyToolConfig === 'object' && ontologyToolConfig !== null
			? (structuredClone(ontologyToolConfig) as Record<string, unknown>)
			: {};
	base.ddo_map = override;
	return { enriched: await enrichToolConfig(base, self.tipo, self.sectionTipo), fromOntology };
}

/** The element whose toolbar is stamped (PHP build_structure_context `$this`). */
export interface ToolbarElement {
	tipo: string;
	sectionTipo: string;
	/** The context's mode: a tool declaring `properties.mode` shows only in it. */
	mode: string;
}

/**
 * A tool declaring `properties.mode` belongs to that mode only (PHP
 * build_structure_context :1869-1872, `$tool_object->properties->mode !== $mode`).
 */
function toolShowsInMode(tool: ToolSimpleContext, mode: string): boolean {
	const toolMode = (tool.properties as { mode?: unknown } | null | undefined)?.mode;
	return toolMode === undefined || toolMode === mode;
}

/**
 * Stamp each tool of an element's toolbar (PHP common::build_structure_context
 * :1866-1916), in PHP's order: the MODE filter first — here, so EVERY toolbar
 * applies it, a section's included (T2-O11-1: it lived in the component/area
 * stamp only, and a section toolbar ignored a tool's `properties.mode`) — then
 * resolveElementToolConfig per tool; a tool with no config ships bare. PHP
 * mutates the SHARED properties object when the ontology defined the config, so
 * the enriched map then reaches the wire BOTH on the tool context and on the
 * element's emitted `properties.tool_config` (the client builds the tool's
 * components from it; unenriched, tool_common.js falls back to a synthetic
 * single-entry ddo_map and the configured components never render); a config
 * created from an override alone is a fresh object and stays off the element's
 * properties.
 */
export async function stampElementToolConfigs(
	entry: { properties?: unknown },
	tools: ToolSimpleContext[],
	ontologyToolConfigBag: Record<string, unknown>,
	element: ToolbarElement,
): Promise<unknown[]> {
	const stamped: unknown[] = [];
	for (const tool of tools) {
		if (!toolShowsInMode(tool, element.mode)) continue;
		const { enriched, fromOntology } = await resolveElementToolConfig(
			tool.name,
			ontologyToolConfigBag[tool.name],
			element.tipo,
			element.sectionTipo,
		);
		if (enriched === null) {
			stamped.push(tool);
			continue;
		}
		if (fromOntology) writeBackToolConfig(entry, tool.name, enriched);
		stamped.push({ ...tool, tool_config: enriched });
	}
	return stamped;
}

/** Write an enriched ontology tool_config back into the element's emitted properties. */
function writeBackToolConfig(
	entry: { properties?: unknown },
	toolName: string,
	enriched: Record<string, unknown>,
): void {
	const entryProperties = (entry.properties ?? {}) as Record<string, unknown>;
	const entryToolConfig = (entryProperties.tool_config ?? {}) as Record<string, unknown>;
	entryToolConfig[toolName] = structuredClone(enriched);
	entryProperties.tool_config = entryToolConfig;
	entry.properties = entryProperties;
}
