/**
 * component_relation_children — the DOWNWARD (children) hierarchy links, computed
 * as the inverse (dd47) of the children's parent links (PHP
 * core/component_relation_children). `relation` is its column-map slot only —
 * nothing of its own is stored there (`derived`); uses the dedicated children resolver (portal machinery with COMPUTED inverse
 * children grafted in).
 *
 * SEARCH searches the CHILD records' relation columns (the inverse-parent
 * pipeline, search/builders/builder_relation_children.ts), never the caller's.
 */
import type { ComponentModel } from '../types.ts';

export const component_relation_children: ComponentModel = {
	model: 'component_relation_children',
	column: 'relation',
	render: 'text',
	// Computed, never stored forward: edit, list AND search (builder_relation_children,
	// over the CHILD rows) read the inverse question. A save writes THROUGH to each
	// child's component_relation_parent (relations/children_write.ts).
	derived: true, // owns no stored value (types.ts `derived`)
	importAppend: {
		refuse:
			"derived: children are computed from each child record's parent link, there is no stored data to append to (import the parent on the child records)",
	},
	defaultRelationType: 'dd48',
	resolveData: 'relation_children',
	flatValue: 'datalist',
	search: { status: 'ported' }, // builder_relation_children.ts (dedicated inverse-parent pipeline)
	sortable: false, // PHP component_relation_common::get_sortable() → false (no subclass override)
	importConform: 'relation',
};
