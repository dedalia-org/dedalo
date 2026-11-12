/**
 * component_relation_parent — the UPWARD (parent) hierarchy link (PHP
 * core/component_relation_parent). Stores parent-link locators in the `relation`
 * column.
 *
 * READ projection reuses the portal path: a parent link renders like any other
 * relation cell, so resolveData === portalResolver. This is a DELIBERATE, safe
 * equivalence for ROW EMISSION ONLY — relation_parent's distinctive behavior is
 * NOT here; it lives in dedicated modules this descriptor links out to:
 *   - hierarchy mutation + ancestor walk + sibling ordering → relations/parent.ts
 *   - sibling ORDER (component_number id_key dataframe)      → relations/dataframe.ts
 *   - search (inverse-parent pipeline)                       → still unported
 * `forbidsAddButton`: the context never offers "+" (PHP json controller) — a
 * parent is attached from the children side / the tree.
 * If parent-cell rendering ever needs to diverge from the portal, give it its
 * own resolver here — this comment is where that decision gets recorded.
 */
import type { ComponentModel } from '../types.ts';

export const component_relation_parent: ComponentModel = {
	model: 'component_relation_parent',
	column: 'relation',
	render: 'text',
	importAppend: 'items',
	defaultRelationType: 'dd47',
	resolveData: 'portal',
	flatValue: 'datalist',
	search: { status: 'ported' },
	importConform: 'relation',
	forbidsAddButton: true,
};
