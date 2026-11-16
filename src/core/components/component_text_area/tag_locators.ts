/**
 * TAG LOCATORS — the stored locators behind a transcription's tag marks (PHP
 * component_text_area::get_component_tags_data): the data of the component a
 * text_area names in `properties.tags_<type>.tipo` (`tags_index` → rsc860,
 * `tags_draw` → rsc1369 on the shipped rsc ontology), read on the HOST record.
 *
 * A LEAF on purpose: two consumers read it — the resolved tag feed
 * (tags_info.ts, behind the read door) and the edit-read tag-integrity repair
 * (emit.ts → tag_integrity.ts). It imports only the resolve/ontology/concepts
 * kernel, so the emit path reaches it without an edge into tags_info's
 * security/term-resolver graph (import_scc_tripwire).
 */

import type { StoredSectionId } from '../../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../../concepts/section_id.ts';
import type { MatrixRecord } from '../../db/matrix.ts';
import { getModelByTipo, getTranslatableByTipo } from '../../ontology/resolver.ts';
import { filterItemsByLang, readComponentItems } from '../../resolve/component_data.ts';

/** PHP DEDALO_DATA_NOLAN — the lang of a non-translatable component. */
export const NOLAN = 'lg-nolan';

/** A stored tag locator, normalized to canonical ids (see tags_info.ts wire law). */
export interface TagLocator {
	section_tipo: string;
	/** Canonical int for a matrix address; verbatim string for a remote id. */
	section_id: StoredSectionId;
	component_tipo?: string;
	tag_id?: string;
	type?: string;
	[key: string]: unknown;
}

/**
 * One component's stored items for a lang (PHP component get_dato: the lang
 * slice for a translatable component, the full array otherwise). NO fallback
 * chain — PHP's get_dato has none either, and a note resolved from another
 * lang's text would be a silent lie about what the transcription says.
 */
export async function readComponentItemsForLang(
	record: MatrixRecord,
	componentTipo: string,
	lang: string,
): Promise<unknown[]> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	const items = readComponentItems(record, componentTipo, model) ?? [];
	if (!(await getTranslatableByTipo(componentTipo))) return items;
	return filterItemsByLang(items, lang);
}

/** Normalize a stored locator to the canonical wire shape. */
export function normalizeTagLocator(stored: Record<string, unknown>): TagLocator | null {
	const sectionTipo = stored.section_tipo;
	if (typeof sectionTipo !== 'string' || stored.section_id === undefined) return null;
	const locator: TagLocator = {
		...stored,
		section_tipo: sectionTipo,
		// Stored data is still mixed (pre-sweep '12' next to post-sweep 12), so
		// canonicalize on the way out instead of echoing whichever form the row
		// happens to hold — a padded/opaque remote id stays untouched.
		section_id: canonicalizeStoredSectionId(stored.section_id) as StoredSectionId,
	};
	// tag_id is a TEXT token, not an address: it is matched with strict `===`
	// against a regex capture from the transcription text. Keep it a string.
	if (stored.tag_id !== undefined && stored.tag_id !== null) {
		locator.tag_id = String(stored.tag_id);
	}
	return locator;
}

/**
 * The tag locators held by `componentTipo` on the host record (PHP
 * get_component_tags_data). The tag portal is structural, never translated —
 * PHP reads it in NOLAN. The ontology config's own `section_tipo`/`section_id`
 * are NOT consulted: they are the literal 'self' on the shipped ontology, and
 * PHP ignored them too.
 */
export async function readTagLocatorsOnRecord(
	record: MatrixRecord,
	componentTipo: string,
): Promise<TagLocator[]> {
	const items = await readComponentItemsForLang(record, componentTipo, NOLAN);
	const locators: TagLocator[] = [];
	for (const item of items) {
		if (item === null || typeof item !== 'object') continue;
		const locator = normalizeTagLocator(item as Record<string, unknown>);
		if (locator !== null) locators.push(locator);
	}
	return locators;
}
