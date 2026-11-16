/**
 * component_security_access — per-record security/ACL matrix editor (PHP
 * core/component_security_access). Stores its data in the shared `misc` column.
 * Not class-translatable. EXPORTABLE like any component (owner C44 2026-11-13,
 * WC-2026-11-13-export-acl-components-exportable: a profile's permission map
 * travels between servers through the export; PHP's base get_export_value did
 * the same) — each stored item as a JSON cell, under the ordinary export
 * column / record permission gate and nothing more.
 */
import type { ComponentModel } from '../types.ts';

export const component_security_access: ComponentModel = {
	model: 'component_security_access',
	column: 'misc',
	render: 'text',
	importAppend: {
		refuse: 'opaque: the permission map is one document, not a list of items — use replace',
	},
	monovalue: true,
	emitHook: 'security_access',
	flatValue: 'json', // export / panel cell = each stored item as JSON (owner C44 2026-11-13)
	sortable: false, // PHP component_security_access::get_sortable() → false
};
