/**
 * component_publication — publication-state relation backed by a datalist (PHP
 * core/component_publication). Relation-column storage; select-family resolution.
 */
import type { ComponentModel } from '../types.ts';

export const component_publication: ComponentModel = {
	model: 'component_publication',
	column: 'relation',
	render: 'text',
	importAppend: { refuse: 'single-choice: a publication flag is one yes/no value — use replace' },
	monovalue: true,
	defaultRelationType: 'dd151',
	resolveData: 'select_family',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'relation',
};
