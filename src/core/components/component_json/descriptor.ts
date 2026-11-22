/**
 * component_json — raw JSON value component (PHP core/component_json). Stores its
 * data in the shared `misc` column. Not class-translatable.
 */
import type { ComponentModel } from '../types.ts';

export const component_json: ComponentModel = {
	model: 'component_json',
	column: 'misc',
	render: 'text',
	importAppend: {
		refuse: 'opaque: a JSON document has no item boundary to append at — use replace',
	},
	monovalue: true,
	searchBuilder: 'json',
	importValueProperty: true,
	importConform: 'json',
	// update_cache regenerate: a value stored as a JSON STRING is decoded (v6 regenerate_component).
	regenerate: 'json_string_decode',
	flatValue: 'json', // export/panel cell = each stored item as JSON (PHP get_export_value base)
};
