/**
 * ONTOLOGY TIPO CODES — the one shape, in a LEAF module.
 *
 * A tipo is `letters+digits` (`dd207`, `numisdata3`): the TLD namespace then the
 * node number. This regex IS the §7.6 identifier-gate shape.
 *
 * WHY IT LIVES HERE AND NOT IN core/concepts/ontology.ts (its original home):
 * `src/config/` may not import `src/core/`, and config now has to validate
 * tipos itself — `element_tipo_list.ts` parses tool_diffusion's
 * EXCLUDE_DIFFUSION_ELEMENTS for both the engine reader and the v6→v7 migration
 * (re-review LOW-4: a typo must be malformed, not "excludes nothing"). The same
 * move `lang_code.ts` made for the lang grammar: this module imports nothing,
 * and `core/concepts/ontology.ts` RE-EXPORTS `TIPO_PATTERN`/`isValidTipo`, so
 * every existing importer is unchanged — one definition, two doors ("link,
 * never duplicate").
 */

/** Tipo strings are strictly `letters+digits` — this regex IS the §7.6 gate shape. */
export const TIPO_PATTERN = /^[a-z]+[0-9]+$/;

/**
 * Max tipo length (INJ-06): a well-shaped but absurdly long tipo ('oh'+100k
 * digits) passes the pattern and no real ontology tipo approaches this — bound it
 * to the SQL identifier ceiling so it can never be interpolated into a key/jsonpath.
 */
const MAX_TIPO_LENGTH = 64;

/** Validate an ontology tipo (used by the search identifier chokepoint, §7.6). */
export function isValidTipo(candidate: string): boolean {
	return (
		candidate.length >= 2 && candidate.length <= MAX_TIPO_LENGTH && TIPO_PATTERN.test(candidate)
	);
}
