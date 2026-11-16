/**
 * component_relation_related — symmetric "related records" relation (PHP
 * core/component_relation_related). Stores its locators in the `relation` column;
 * uses the dedicated related resolver (the portal path in every mode, list
 * included — own item even when empty + computed back-references).
 */
import type { ComponentModel } from '../types.ts';

export const component_relation_related: ComponentModel = {
	model: 'component_relation_related',
	column: 'relation',
	render: 'text',
	importAppend: 'items',
	defaultRelationType: 'dd89',
	resolveData: 'relation_related',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'relation',
	forbidsAddButton: true,
};
