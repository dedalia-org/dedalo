/**
 * component_info — read-only computed/info display (PHP core/component_info).
 * Stores its data in the shared `misc` column. Not class-translatable. Legacy
 * aliases component_state / component_calculation resolve here.
 */
import type { ComponentModel } from '../types.ts';

export const component_info: ComponentModel = {
	model: 'component_info',
	column: 'misc',
	render: 'text',
	importAppend: {
		refuse: 'derived: the value is computed at read time, there is no stored data to append to',
	},
	importValueProperty: true,
	emitHook: 'info',
	flatValue: 'info', // the LIVE widget outputs (WC-2026-11-12-info-live-publication-export)
	calculationData: 'info', // PHP get_calculation_data (components/calculation_data.ts)
	sortable: false, // PHP component_info::get_sortable() → false (also covers state/calculation aliases)
};
