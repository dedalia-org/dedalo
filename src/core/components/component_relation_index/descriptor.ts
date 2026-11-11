/**
 * component_relation_index — computed inverse-index relation (PHP
 * core/component_relation_index). Stores/computes in the `relation` column; uses
 * the dedicated index resolver (computed inverse pages in list/tm, portal
 * otherwise).
 *
 * SEARCH is UNPORTED: its computed-inverse search trait is not ported, so the
 * search dispatcher throws.
 */
import type { ComponentModel } from '../types.ts';

export const component_relation_index: ComponentModel = {
	model: 'component_relation_index',
	column: 'relation',
	render: 'text',
	// Computed, never stored forward (edit + list read the inverse question;
	// only search mode reads the column) — an append would be written and never read.
	derived: true, // owns no stored value (types.ts `derived`)
	importAppend: {
		refuse:
			'derived: the index is computed from the inverse locators pointing at this record, there is no stored data to append to (import the link on the pointing records)',
	},
	defaultRelationType: 'dd96',
	resolveData: 'relation_index',
	flatValue: 'datalist',
	search: { status: 'ported' }, // builder_relation_index.ts (dedicated computed-inverse pipeline)
	sortable: false, // PHP component_relation_common::get_sortable() → false (no subclass override)
	importConform: 'relation',
};
