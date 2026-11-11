/**
 * component_select_lang — language-choice select (PHP core/component_select_lang).
 * Same relation-column storage and select-family resolution as component_select,
 * with the datalist populated from the project languages.
 */
import type { ComponentModel } from '../types.ts';

export const component_select_lang: ComponentModel = {
	model: 'component_select_lang',
	column: 'relation',
	render: 'text',
	importAppend: {
		refuse:
			'single-choice: only one language is ever read, a second one cannot be added — use replace',
	},
	monovalue: true,
	defaultRelationType: 'dd151',
	resolveData: 'select_family',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'select_lang',
	// Options = the project languages, not the lg1 section's ~21.7k records
	// (relations/datalist.ts DATALIST_SOURCE_IMPLEMENTATIONS).
	datalistSource: 'project_langs',
};
