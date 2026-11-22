/**
 * component_text_area — multi-line free text (PHP core/component_text_area).
 * Stores {id,value,lang} items in the `string` column; CLASS-translatable.
 * Legacy aliases component_input_text_large / component_html_text resolve here.
 */
import type { ComponentModel } from '../types.ts';

export const component_text_area: ComponentModel = {
	model: 'component_text_area',
	column: 'string',
	render: 'html',
	importAppend: 'text_paragraphs',
	monovalue: true,
	classSupportsTranslation: true,
	dataItemEmptiness: 'rich_text',
	searchBuilder: 'string',
	flatValue: 'string',
	importValueProperty: true,
	emitHook: 'text_area',
	importConform: 'text_area',
	// update_cache regenerate: old TC marks get their milliseconds (v6 regenerate_component).
	regenerate: 'text_area_legacy_tc',
};
