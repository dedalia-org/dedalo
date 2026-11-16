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
	flatValue: 'json', // export/panel cell = each stored item as JSON (PHP get_export_value base)
};
