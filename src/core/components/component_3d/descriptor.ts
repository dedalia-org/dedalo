/**
 * component_3d — 3D-model media component (PHP core/component_3d). Stores its
 * data in the shared `media` column. Not class-translatable.
 */
import type { ComponentModel } from '../types.ts';

export const component_3d: ComponentModel = {
	model: 'component_3d',
	column: 'media',
	render: 'text',
	flatValue: 'media', // export/panel cell = default-quality URL (as component_av)
	importAppend: {
		refuse:
			'media: the file is the value — replace it through the media tools, there is nothing to append',
	},
	monovalue: true,
	emitHook: 'media',
	sortable: false, // PHP component_media_common::get_sortable() → false
};
