/**
 * component_info — read-only computed/info display (PHP core/component_info).
 * Its storage route is the shared `misc` column, but it is DERIVED: the value
 * is the live widget compute and whatever sits under its tipo is never served
 * (WC-2026-09-03; owner C10 2026-11-13 — the `derived` facet, so tool_update_cache
 * skips it and the CSV import refuses a column mapped to it). Not
 * class-translatable. Legacy aliases component_state / component_calculation
 * resolve here.
 */
import type { ComponentModel } from '../types.ts';

export const component_info: ComponentModel = {
	model: 'component_info',
	column: 'misc',
	render: 'text',
	derived: true, // owner C10 2026-11-13 (WC-2026-11-13-info-derived-async-published)
	importAppend: {
		refuse: 'derived: the value is computed at read time, there is no stored data to append to',
	},
	importValueProperty: true,
	emitHook: 'info',
	flatValue: 'info', // the LIVE widget outputs (WC-2026-11-12-info-live-publication-export)
	calculationData: 'info', // PHP get_calculation_data (components/calculation_data.ts)
	sortable: false, // PHP component_info::get_sortable() → false (also covers state/calculation aliases)
};
