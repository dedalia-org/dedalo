/**
 * component_filter_records — saved record-filter component (PHP
 * core/component_filter_records). Stores its data in the shared `misc` column.
 * Not class-translatable. NOTE: unlike component_filter/_master (relation
 * column), this one stores in `misc`, so it is not a relation-resolver model.
 * EXPORTABLE like any component (owner C44 2026-11-13,
 * WC-2026-11-13-export-acl-components-exportable): each stored item as a JSON
 * cell, under the ordinary export permission gate.
 */
import type { ComponentModel } from '../types.ts';

export const component_filter_records: ComponentModel = {
	model: 'component_filter_records',
	column: 'misc',
	render: 'text',
	importAppend: {
		refuse:
			'opaque: the row-ACL map is one document per section, not a list of items — use replace',
	},
	importValueProperty: true,
	emitHook: 'filter_records',
	flatValue: 'json', // export / panel cell = each stored item as JSON (owner C44 2026-11-13)
};
