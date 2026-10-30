/**
 * component_inverse — computed inverse-relation display (PHP
 * core/component_inverse). Its value is the record's BACKLINKS, computed live
 * at emit time (`emitHook: 'inverse'` → component_inverse/emit.ts), never read
 * from its `misc` slot. Not class-translatable. NOTE: despite relating records,
 * its matrix column is `misc`, so it is not part of the relation-resolver
 * registry.
 */
import type { ComponentModel } from '../types.ts';

export const component_inverse: ComponentModel = {
	model: 'component_inverse',
	column: 'misc',
	render: 'text',
	derived: true, // owns no stored value (types.ts `derived`)
	emitHook: 'inverse',
	importAppend: {
		refuse:
			'derived: the value is the computed backlinks of other records, there is no stored data to append to',
	},
};
