/**
 * component_password — password value (PHP core/component_password).
 * Stores {id,value,lang} items in the `string` column; CLASS-translatable.
 * Written hashed + policy-checked (security/password_hash.ts); resolved MASKED
 * for every display door (`secretValue` → resolve/component_data.ts).
 */
import type { ComponentModel } from '../types.ts';

export const component_password: ComponentModel = {
	model: 'component_password',
	column: 'string',
	render: 'text',
	importAppend: { refuse: 'opaque: a password is one secret value — use replace' },
	monovalue: true,
	classSupportsTranslation: true,
	dataItemEmptiness: 'common',
	importValueProperty: true,
	secretValue: true,
};
