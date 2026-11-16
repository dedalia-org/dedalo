/**
 * component_iri — IRI/URL value (PHP core/component_iri). Stores its items in
 * the dedicated `iri` column; CLASS-translatable, and (unlike the string family)
 * honors the requested lang as-is on read rather than nolan-forcing.
 *
 * The NODE is never translatable (`ontologyTranslatable: false`, owner decision
 * 2026-11-11): an IRI has no language — the base value is lg-nolan and the
 * per-language IRIs are language VERSIONS (always-on with_lang_versions). The
 * class-level flag above is those versions; a node declaring is_translatable is
 * an ontology bug the health check names (ontology/model_rules.ts).
 */
import type { ComponentModel } from '../types.ts';

export const component_iri: ComponentModel = {
	model: 'component_iri',
	flatValue: 'iri',
	column: 'iri',
	render: 'url',
	importAppend: 'items',
	classSupportsTranslation: true,
	dataItemEmptiness: 'iri',
	ontologyTranslatable: false,
	searchBuilder: 'iri',
	// No `.value` scalar to sort on (items are {iri, title} frames): PHP offered
	// the column sortable and sorted it by NULL, a silent no-op. Owner C39
	// 2026-11-13 (WC-2026-11-13-sort-non-scalar-refused): not offered, refused.
	sortable: false,
	// PHP component_iri_json ALWAYS pairs with its dd560 label dataframe
	// (hardcoded DEDALO_COMPONENT_IRI_LABEL_DATAFRAME).
	fixedDataframeTipos: ['dd560'],
	importConform: 'iri',
	// ALWAYS transliterable (PHP class.component_iri.php:64): every literal item
	// carries `transliterate_value`, the other-lang counterpart (lang_versions_emit.ts).
	emitHook: 'lang_versions',
};
