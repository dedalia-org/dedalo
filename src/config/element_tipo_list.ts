/**
 * THE SHAPE OF A LIST OF ELEMENT TIPOS — one parse, two doors (R3 review MED-2).
 *
 * tool_diffusion's `EXCLUDE_DIFFUSION_ELEMENTS` is read by the engine
 * (`src/diffusion/api/excluded_elements.ts`) and written by the v6→v7 config
 * migration (`src/config/migration_map.ts` TOOL_CONFIG →
 * `src/core/tools/tool_config_move.ts`). Both must agree on what a well-formed
 * value IS, or the migration could move a value the reader then refuses (or
 * keep a stored value the reader refuses, instead of replacing it as v6 would
 * have ignored it). So the rule lives HERE, once.
 *
 * A LEAF in `src/config/` (it imports nothing): `src/config/` may not import
 * `src/core/` or `src/diffusion/`, and both of those may import this.
 */

/**
 * Parse a configured element-tipo list:
 *   - absent (`undefined` / `null`) → `[]` (nothing listed);
 *   - an array of non-empty strings → that list;
 *   - anything else → `null` (MALFORMED — the caller decides: the reader
 *     refuses, the migration does not move it / replaces it).
 * v6 used such a value only when `is_array` and silently ignored anything else.
 */
export function parseElementTipoList(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return null;
	return raw.every((tipo) => typeof tipo === 'string' && tipo !== '')
		? [...(raw as string[])]
		: null;
}
