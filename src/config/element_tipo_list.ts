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
 * In `src/config/`, importing only the leaf tipo grammar (`tipo_code.ts`):
 * `src/config/` may not import `src/core/` or `src/diffusion/`, and both of those
 * may import this.
 */

import { isValidTipo } from './tipo_code.ts';

/**
 * Parse a configured element-tipo list:
 *   - absent (`undefined` / `null`) → `[]` (nothing listed);
 *   - an array whose every entry is a TIPO (`isValidTipo`, the §7.6 grammar) →
 *     that list;
 *   - anything else → `null` (MALFORMED — the caller decides: the reader
 *     refuses, the migration does not move it / replaces it).
 * v6 used such a value only when `is_array` and silently ignored anything else.
 *
 * WHY THE GRAMMAR, not just "a non-empty string" (re-review LOW-4): a typo
 * (`'oh 63'`, `'OH63'`) matches no element, so the list would silently exclude
 * nothing while the operator believes the element is withdrawn — and a
 * comma-joined entry could be read two ways by two consumers. A non-tipo entry
 * is a config fault, loudly, like any other malformed value.
 */
export function parseElementTipoList(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return null;
	return raw.every((tipo) => typeof tipo === 'string' && isValidTipo(tipo))
		? [...(raw as string[])]
		: null;
}
