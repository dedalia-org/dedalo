/**
 * ONTOLOGY — the core of everything (spec §3.1).
 *
 * Every menu, area, section, component, tool, button and widget in Dédalo is
 * DEFINED BY an ontology node: a record with a `tipo` (e.g. 'dd207',
 * 'numisdata3'), a `model` (the behavior/class that resolves it), a `parent`
 * (structural position), and a `properties` JSON blob (per-node configuration,
 * including request_config for relation components). There are no bespoke
 * feature tables — capability = ontology definition + a model that knows how
 * to resolve it.
 *
 * In this rewrite the ontology is modeled as a READ-ONLY resolver/registry
 * over the same PostgreSQL database the PHP server maintains (plan risk A5.3:
 * ontology import/update stays PHP-owned for now — explicitly uncovered scope).
 *
 * PHP reference: matrix_ontology / matrix_ontology_main tables; v7 uses
 * `properties` (NEVER the legacy `propiedades`) and flat virtual-tree
 * resolution — no v6 nested maps.
 *
 * TODO(phase-1): flesh out the node accessor API against real ontology rows
 * (resolve model by tipo, children-of, tipo→matrix-table mapping) and add the
 * in-process cache with correct invalidation (spec §4).
 */

import { z } from 'zod';

/**
 * Tipo codes: `letters+digits`, bounded — §7.6 gate shape.
 *
 * RE-EXPORTED, not redefined (as LANG_PATTERN below): the definition moved down
 * to the leaf `src/config/tipo_code.ts` because config validates tipos itself
 * (EXCLUDE_DIFFUSION_ELEMENTS, `src/config/element_tipo_list.ts`). ONE copy.
 */
import { TIPO_PATTERN } from '../../config/tipo_code.ts';

/**
 * Language codes: 'lg-*' or the 'all' sentinel — §7.6 gate shape.
 *
 * RE-EXPORTED, not redefined. The definition moved down to the leaf
 * `src/config/lang_code.ts` because `src/config/` may not import `src/core/`
 * and config now has to validate lang codes itself. Every existing importer
 * keeps working through this name; there is exactly ONE copy of the regex
 * ("link, never duplicate").
 */
export { isValidLang, LANG_PATTERN } from '../../config/lang_code.ts';
export { isValidTipo, TIPO_PATTERN } from '../../config/tipo_code.ts';

/**
 * A TLD (top-level-domain namespace) is two-or-more lowercase ASCII letters,
 * nothing else (PHP safe_tld) — the prefix every tipo carries. ONE copy:
 * `ontology/tld.ts safeTld`, the dd_ontology identifier predicate
 * (`db/dd_ontology.ts ddOntologyIdentifierViolations`) and the
 * `dd_ontology_tld_grammar` CHECK (migration `*_dd_ontology_identifier_grammar.sql`)
 * all state this shape (SURF-1).
 */
export const TLD_PATTERN = /^[a-z]{2,}$/;

/** Validate a TLD namespace (see TLD_PATTERN). */
export function isValidTld(candidate: unknown): candidate is string {
	return typeof candidate === 'string' && TLD_PATTERN.test(candidate);
}

export const tipoSchema = z.string().regex(TIPO_PATTERN, 'invalid ontology tipo');
export type Tipo = z.infer<typeof tipoSchema>;

/**
 * An ontology node as this server consumes it. Deliberately minimal for the
 * first milestone; grows with the resolver in Phase 1/2.
 */
export const ontologyNodeSchema = z
	.object({
		tipo: z.string(),
		/** Behavior/class name, e.g. 'component_input_text', 'section', 'area_thesaurus'. */
		model: z.string(),
		/** Parent tipo in the ontology tree. */
		parent: z.string().nullable().optional(),
		/** Per-node configuration JSON (request_config lives under properties.source). */
		properties: z.record(z.string(), z.unknown()).nullable().optional(),
		/** Human labels by language. */
		label: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
		/** Whether component data is language-translatable. */
		translatable: z.boolean().optional(),
	})
	.passthrough();

export type OntologyNode = z.infer<typeof ontologyNodeSchema>;
