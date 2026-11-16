/**
 * component_date — structured date value (PHP core/component_date). Stores its
 * data in the dedicated `date` column as a structured object (NOT a plain
 * string), which is why it is a distinct model rather than a formatted string.
 * Not class-translatable.
 */
import type { ComponentModel } from '../types.ts';

export const component_date: ComponentModel = {
	model: 'component_date',
	flatValue: 'date',
	column: 'date',
	render: 'text',
	importAppend: 'items',
	searchBuilder: 'date',
	importConform: 'date',
	calculationData: 'date', // PHP get_calculation_data (components/calculation_data.ts)
};
