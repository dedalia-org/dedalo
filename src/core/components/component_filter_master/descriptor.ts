/**
 * component_filter_master — master (structural) filter relation (PHP
 * core/component_filter_master). Same resolution as component_filter: the filter
 * path (portal without own-config child expansion).
 */
import type { ComponentModel } from '../types.ts';

export const component_filter_master: ComponentModel = {
	model: 'component_filter_master',
	column: 'relation',
	render: 'text',
	importAppend: 'items',
	defaultRelationType: 'dd675',
	resolveData: 'filter',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'relation',
};
