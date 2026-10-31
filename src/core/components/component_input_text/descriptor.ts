/**
 * component_input_text — short single-line free text (PHP core/component_input_text).
 * Stores {id,value,lang} items in the `string` matrix column; CLASS-translatable
 * (its data items are lang-filtered on read).
 */
import type { ComponentModel } from '../types.ts';

export const component_input_text: ComponentModel = {
	model: 'component_input_text',
	column: 'string',
	render: 'text',
	importAppend: 'items',
	classSupportsTranslation: true,
	searchBuilder: 'string',
	flatValue: 'string',
	importValueProperty: true,
	importConform: 'input_text',
	// TRANSLITERABLE when its ontology says `with_lang_versions` (an lg-nolan
	// base + per-language versions): the hook emits `transliterate_value`, the
	// other-lang counterpart the views show beside the value (no key otherwise).
	emitHook: 'lang_versions',
};
