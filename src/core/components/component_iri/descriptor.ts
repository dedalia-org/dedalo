/**
 * component_iri — IRI/URL value (PHP core/component_iri). Stores its items in
 * the dedicated `iri` column; CLASS-translatable, and (unlike the string family)
 * honors the requested lang as-is on read rather than nolan-forcing.
 */
import type { ComponentModel } from '../types.ts';

export const component_iri: ComponentModel = {
	model: 'component_iri',
	flatValue: 'iri',
	column: 'iri',
	render: 'url',
	importAppend: 'items',
	classSupportsTranslation: true,
	searchBuilder: 'iri',
	// PHP component_iri_json ALWAYS pairs with its dd560 label dataframe
	// (hardcoded DEDALO_COMPONENT_IRI_LABEL_DATAFRAME).
	fixedDataframeTipos: ['dd560'],
	importConform: 'iri',
	// ALWAYS transliterable (PHP class.component_iri.php:64): every literal item
	// carries `transliterate_value`, the other-lang counterpart (lang_versions_emit.ts).
	emitHook: 'lang_versions',
};
