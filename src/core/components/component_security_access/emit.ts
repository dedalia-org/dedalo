/**
 * component_security_access emit hook (audit S2-24; extracted verbatim from
 * section/read.ts): the permissions widget needs the ontology ACL tree +
 * parent locator (PHP component_security_access_json.php:155-170). PHP
 * attaches these on EVERY read path — the section read (edit form) AND the
 * direct get_data — so it lives on the SHARED emit path, not just the
 * get_data endpoint. Without the datalist the client's permissions tree
 * renders empty. parent_tipo is the component's OWN tipo (not the caller);
 * the datalist + changes_files are edit-READ-only: the scalar save echo
 * (door 'save_echo') carries parent_tipo/parent_section_id only — the client
 * keeps its datalist (WC-2026-11-09-security-access-save-echo-no-datalist).
 */

import type { DataItem } from '../../resolve/component_data.ts';
import type { ComponentEmitHook, EmitHookContext } from '../emit_hooks.ts';

export const securityAccessEmitHook: ComponentEmitHook = {
	async decorateItem(item: DataItem, context: EmitHookContext): Promise<void> {
		item.parent_tipo = context.ddo.tipo;
		// Section-read keeps section_id/parent_section_id as the raw (numeric) row
		// id; the direct get_data path stringifies them (PHP get_data_item) in the
		// readComponentData post-step.
		item.parent_section_id = context.row.section_id;
		if (context.ddoMode === 'edit' && context.door === 'read') {
			const { getSecurityAccessDatalist } = await import(
				'../../resolve/security_access_datalist.ts'
			);
			item.datalist = await getSecurityAccessDatalist();
			// changes_files: the "Latest changes" selector — ontology schema-change
			// filenames, newest first (PHP hierarchy::get_simple_schema_changes_files).
			const { listSchemaChangesFiles } = await import('../../ontology/schema_changes.ts');
			item.changes_files = listSchemaChangesFiles();
		}
	},
};
