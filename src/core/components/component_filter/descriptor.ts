/**
 * component_filter — project/records filter relation (PHP core/component_filter).
 * Stores its locators in the `relation` column and resolves through the filter
 * path (portal WITHOUT own-config child expansion — PHP filter cells never run
 * subdatum over the project targets).
 */
import type { ComponentModel } from '../types.ts';

export const component_filter: ComponentModel = {
	model: 'component_filter',
	column: 'relation',
	render: 'text',
	importAppend: 'items',
	defaultRelationType: 'dd675',
	resolveData: 'filter',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'relation',
};
