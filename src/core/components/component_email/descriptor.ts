/**
 * component_email — email address value (PHP core/component_email).
 * Stores {id,value,lang} items in the `string` column; CLASS-translatable.
 */
import type { ComponentModel } from '../types.ts';

export const component_email: ComponentModel = {
	model: 'component_email',
	column: 'string',
	render: 'text',
	importAppend: 'items',
	classSupportsTranslation: true,
	dataItemEmptiness: 'string',
	searchBuilder: 'string',
	flatValue: 'string',
	importValueProperty: true,
	importConform: 'email',
};
