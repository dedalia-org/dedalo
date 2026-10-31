/**
 * LANG-VERSIONS emit hook (`emitHook: 'lang_versions'`) — the shared emission
 * particularity of the TRANSLITERABLE literal models: component_input_text
 * (when its ontology carries `properties.with_lang_versions: true`, e.g. a
 * name kept in an lg-nolan BASE "Augustus" beside per-language versions
 * "Αύγουστος" lg-ell) and component_iri (ALWAYS transliterable — PHP
 * class.component_iri.php:64 hard-sets the flag).
 *
 * THE KEY: `item.transliterate_value` (PHP component_input_text_json.php:195,
 * component_iri_json.php:178 — v6 semantics; see WC-2026-10-31-
 * transliterate-value-emitted) = the component's stored items in the OTHER
 * lang of the pair:
 *
 * - an instance running in its lg-nolan base gets the version in the REQUEST
 *   DATA LANG (PHP DEDALO_DATA_LANG) — the hint an edit form / list cell shows
 *   beside the base ("Augustus (Αύγουστος)" when browsing in lg-ell);
 * - an instance running in a version (the tool_lang target, built in e.g.
 *   lg-spa through an EXPLICIT source.lang) gets the lg-nolan BASE — what the
 *   translator transliterates from.
 *
 * Shape (PHP get_data_lang, exact): `null` when the component holds NO stored
 * data at all; otherwise the raw stored items of that lang, stored order, full
 * items (`{id, lang, value}` / `{id, lang, iri, title}` — the client views pair
 * by index and component_iri adopts the shared `id` for an empty row), `[]`
 * when that lang is empty. Unmasked/untruncated is correct: neither model is a
 * secret or truncated family.
 *
 * KEYED ON `item.lang` — the instance lang the generic path (and the save echo)
 * already stamped through the one rule (ontology/resolver.ts elementLang) —
 * never on the ambient request lang, which would mirror the very slice the
 * item shows. The request data lang is read from the request scope
 * (currentDataLang) exactly as PHP read DEDALO_DATA_LANG, NOT from the
 * context's `defaultLang` (which is a TM snapshot's lang in history cells).
 *
 * A plain (non-transliterable) component_input_text — the vast majority —
 * gets NO key (PHP emitted it only under with_lang_versions): the gate is the
 * one ontology rule `hasLangVersions`, cached, so the cost on a plain text
 * cell is one cached lookup.
 *
 * Doors reached: every emitDdoData literal emission (section edit/list reads,
 * portal/relation child cells, get_data / tool_lang target reads, TM preview,
 * TM list cells) and the scalar save echo (dd_core_api.ts dispatches
 * decorateItem on it). NOT the temporal (search-form scratch) echo: it has no
 * stored record to pair against (documented in the WC entry).
 *
 * Imports stay on the leaf side (import_scc_tripwire): the type-only import of
 * emit_hooks.ts is erased, and the ontology/request-scope modules load lazily.
 */

import type { DataItem } from '../resolve/component_data.ts';
import { filterItemsByLang, readComponentItems } from '../resolve/component_data.ts';
import type { ComponentEmitHook, EmitHookContext } from './emit_hooks.ts';

/** The lg-nolan BASE of a transliterable (PHP DEDALO_DATA_NOLAN). */
const NOLAN = 'lg-nolan';

/**
 * The PHP `get_data_lang(other)` value for one emitted item, or `undefined`
 * when the component is not transliterable (no key at all on the wire).
 * Exported for the gate.
 */
export async function transliterateValueOf(
	item: Pick<DataItem, 'lang'>,
	context: Pick<EmitHookContext, 'ddo' | 'record' | 'model'>,
): Promise<unknown[] | null | undefined> {
	const { hasLangVersions } = await import('../ontology/resolver.ts');
	if (!(await hasLangVersions(context.ddo.tipo, context.model))) return undefined;

	// An alias answers for its target: the items live under the DATA tipo.
	const { resolveDataTipo } = await import('../ontology/alias.ts');
	const dataTipo = await resolveDataTipo(context.ddo.tipo);
	const items = readComponentItems(context.record, dataTipo, context.model);
	// PHP get_data_lang returns get_data() verbatim when it is empty: null for
	// no stored data, [] for a stored empty array.
	if (items === null || items.length === 0) return items;

	const instanceLang = typeof item.lang === 'string' ? item.lang : NOLAN;
	let otherLang = NOLAN;
	if (instanceLang === NOLAN) {
		const { currentDataLang } = await import('../resolve/request_lang.ts');
		otherLang = currentDataLang();
	}
	return filterItemsByLang(items, otherLang);
}

export const langVersionsEmitHook: ComponentEmitHook = {
	async decorateItem(item: DataItem, context: EmitHookContext): Promise<void> {
		const value = await transliterateValueOf(item, context);
		if (value === undefined) return;
		item.transliterate_value = value;
	},
};
