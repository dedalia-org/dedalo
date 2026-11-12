/**
 * component_number — numeric value (PHP core/component_number). Stores its data
 * in the dedicated `number` column. Not class-translatable.
 */
import type { ComponentModel } from '../types.ts';

export const component_number: ComponentModel = {
	model: 'component_number',
	column: 'number',
	render: 'number',
	importAppend: 'items',
	searchBuilder: 'number',
	flatValue: 'string',
	importValueProperty: true,
	importConform: 'number',
	calculationData: 'number', // PHP get_calculation_data (components/calculation_data.ts)
};
