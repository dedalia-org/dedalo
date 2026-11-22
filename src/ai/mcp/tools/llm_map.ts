/**
 * ONTOLOGY LLM MAP builder (PHP ontology_data_io::export_llm_map, the map-
 * BUILDING half). Emits the flat, multilingual section → fields map that
 * agent/MCP tooling loads for O(1) section/field lookup without touching the
 * database:
 *
 *   [{ tipo, label: {lg-eng: …, lg-spa: …},
 *      fields: [{tipo, label, type, target_sections?}] }, …]
 *
 * It REUSES the live MCP discovery machinery (SIMPLIFIED_TYPE_MAP,
 * sectionFieldNodes, linkTargetSections — PHP agent_view_builder::
 * section_label_map semantics: EXCLUDED_MODELS filtering, simplified types),
 * so the exported map exactly reflects what the agent can address at query
 * time — including describeSection's `target_sections` key, one vocabulary
 * for one fact.
 *
 * DELIBERATE DIVERGENCE from PHP export_llm_map: PHP emitted `target`, a
 * SINGLE tipo (the first of the resolved list). A link component's targets are
 * declared by its request_config sqo and are routinely plural — a
 * `hierarchy_types` source expands to every ACTIVE hierarchy of the typology —
 * so the first-only form told the agent a multi-target field linked to exactly
 * one section. That is a silent narrowing of what the ontology declared, and
 * the key is RENAMED (not merely re-typed) so a consumer written against the
 * PHP shape fails loudly instead of reading an array as a tipo string.
 *
 * This module lives NEXT TO discovery.ts (src/ai) rather than in
 * core/ontology because the dependency direction is ai → core; the core-side
 * caller (core/ontology/data_io.ts exportLlmMap) reaches it through a lazy
 * import (engineering/CONVENTIONS.md §2 rationale 2 — sanctioned boundary seam into
 * the optional ai subsystem).
 *
 * PHP catch-and-continue parity: one broken section never aborts the whole
 * map — it is collected in `skipped` and building continues.
 */

import type { OntologySubtreeNode } from '../../../core/ontology/resolver.ts';
import { listSectionNodes } from '../../../core/ontology/resolver.ts';
import { currentDataLang } from '../../../core/resolve/request_lang.ts';
import {
	LINK_TARGET_MODELS,
	linkTargetSections,
	SIMPLIFIED_TYPE_MAP,
	sectionFieldNodes,
} from './discovery.ts';

/** One field entry of the LLM map. */
export interface LlmMapField {
	tipo: string;
	/** Multilingual term object (all languages at once, PHP get_term_data). */
	label: Record<string, string>;
	/** Simplified type: text | html | number | date | geo | link | media | misc. */
	type: string;
	/**
	 * EVERY section this link field may address, in the request_config's own
	 * order — same key, same meaning and same omit-when-empty rule as
	 * discovery.ts describeSection (SectionMapField.target_sections). Absent for
	 * scalar fields and for a link field that resolves no target at all.
	 */
	target_sections?: string[];
}

/** One section entry of the LLM map. */
export interface LlmMapSection {
	tipo: string;
	label: Record<string, string>;
	fields: LlmMapField[];
}

/**
 * Injectable seams for fixture tests (production callers pass nothing). The
 * defaults are the live discovery/resolver implementations.
 */
export interface LlmMapDeps {
	listSectionNodes: () => Promise<{ tipo: string; term: Record<string, string> | null }[]>;
	sectionFieldNodes: (sectionTipo: string) => Promise<OntologySubtreeNode[]>;
	linkTargetSections: (
		componentTipo: string,
		sectionTipo: string,
		lang: string,
	) => Promise<string[]>;
}

/**
 * Build the LLM map for every dd_ontology node of model 'section'
 * (PHP dd_ontology_db_manager::search(['model'=>'section']) census).
 * Per-section failures are skipped and collected (PHP \Throwable catch).
 */
export async function buildLlmMap(
	deps: Partial<LlmMapDeps> = {},
): Promise<{ map: LlmMapSection[]; skipped: string[] }> {
	const listSections = deps.listSectionNodes ?? listSectionNodes;
	const fieldNodes = deps.sectionFieldNodes ?? sectionFieldNodes;
	const targetSections = deps.linkTargetSections ?? linkTargetSections;
	// PHP drives the field list with DEDALO_DATA_LANG — a per-request value: the
	// REQUEST data lang (only the link-target resolution is lang-parameterized;
	// labels carry ALL languages regardless).
	const lang = currentDataLang();

	const map: LlmMapSection[] = [];
	const skipped: string[] = [];
	for (const sectionNode of await listSections()) {
		try {
			const fields: LlmMapField[] = [];
			for (const node of await fieldNodes(sectionNode.tipo)) {
				const model = typeof node.model === 'string' ? node.model : '';
				const field: LlmMapField = {
					tipo: node.tipo,
					label: node.term ?? {},
					type: SIMPLIFIED_TYPE_MAP[model] ?? 'text',
				};
				if (LINK_TARGET_MODELS.has(model)) {
					// ALL resolved targets, never `[0]`: the caller's request_config sqo
					// is the declaration of what this field addresses, and the engine
					// never re-scopes it. Empty stays absent (a component with no
					// resolvable target declares nothing, which is not "links to []").
					const targets = await targetSections(node.tipo, sectionNode.tipo, lang);
					if (targets.length > 0) {
						field.target_sections = targets;
					}
				}
				fields.push(field);
			}
			map.push({
				tipo: sectionNode.tipo,
				label: sectionNode.term ?? {},
				fields,
			});
		} catch (error) {
			// Skip the failing section but keep building the rest (PHP parity).
			skipped.push(sectionNode.tipo);
			console.error(`[llm_map] Skipped section '${sectionNode.tipo}': ${(error as Error).message}`);
		}
	}
	return { map, skipped };
}
