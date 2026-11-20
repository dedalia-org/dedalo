// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RENDER_OBJECT_IMAGES
 * DOM for the console's "Associate image" section: picker, linked-image
 * import and gallery, the render half of object_image.js. Reaches the logic
 * through self.<method> wrappers only, as render_object_console.js does.
 *
 * @module render_object_images
 */

import { ui } from '../../../core/common/js/ui.js';
import { render_new_tab_link } from './render_download_line.js';

/**
 * RENDER_OBJECT_IMAGES
 * A file picker that uploads and associates in ONE gesture (the record only
 * turns dirty, as drawing does), then the gallery. v6's two modals live inline
 * here: a modal would hide the very geometry the pictures belong to. Thumbnails
 * open in a new tab instead of v6's `simpleLightbox`: no dependency to vendor.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} layer
 * @param {HTMLElement} parent
 * @returns {void}
 */
export const render_object_images = function (self, layer, parent) {
	const container = ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-section uca-maps-object-images',
		parent: parent,
	});

	ui.create_dom_element({
		element_type: 'h6',
		text_content: self.get_tool_label('object_images_title') || 'Associate image',
		parent: container,
	});

	// the action first, what it produced second: a gallery above the picker
	// would push the picker down every time a picture is associated. The
	// gallery subtitle is v6's "Galería" button.
	const file_input = ui.create_dom_element({
		element_type: 'input',
		type: 'file',
		class_name: 'uca-maps-object-image-file',
		parent: container,
	});
	file_input.accept = 'image/jpeg,image/png';

	const status = ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-object-image-status',
		parent: container,
	});

	// filled once the install answers whether the import is allowed
	const linked = ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-object-linked-images',
		parent: container,
	});

	ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-object-gallery-title',
		text_content: self.get_tool_label('object_images_gallery_title') || 'Gallery',
		parent: container,
	});

	const gallery = ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-object-gallery',
		parent: container,
	});
	populate_object_gallery(self, layer, gallery);
	render_linked_images_import(self, layer, linked);

	// choosing the file IS the gesture: a confirm button that can only be
	// pressed once, right after, is a step that asks nothing
	file_input.addEventListener('change', async function () {
		// the state is read off the DOM, never a cached flag: the picker stays
		// disabled for the whole round trip
		if (file_input.disabled) {
			return;
		}
		file_input.disabled = true;
		status.textContent = self.get_tool_label('object_images_uploading') || 'Uploading…';

		const result = await self.associate_image(layer, file_input.files && file_input.files[0]);

		// the panel may be gone, or showing another object, by now
		if (!status.isConnected) {
			return;
		}
		file_input.disabled = false;

		if (!result.ok) {
			status.textContent = result.error || '';
			return;
		}
		status.textContent = '';
		file_input.value = '';
		// the association landed on `layer` either way; the gallery is only
		// repainted when `layer` is still the object this panel is showing
		if (result.still_shown) {
			populate_object_gallery(self, layer, gallery);
		}
	});
}; //end render_object_images

/**
 * RENDER_LINKED_IMAGES_IMPORT
 * "Import N linked images", only when the install allows it and the object
 * links to images not yet in Dédalo (`object_image.js` `import_linked_images`).
 * An import that brings anything in commits and re-renders this panel, so the
 * failures are read back from the instance while their links remain.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} layer
 * @param {HTMLElement} holder
 * @returns {Promise<void>}
 */
const render_linked_images_import = async function (self, layer, holder) {
	if (self.linked_images(layer).length === 0 || !(await self.external_images_enabled())) {
		return;
	}
	// the panel may be gone, or showing another object, by now
	if (!holder.isConnected) {
		return;
	}

	const button = ui.create_dom_element({
		element_type: 'button',
		class_name: 'uca-maps-object-linked-import',
		parent: holder,
	});
	button.type = 'button';
	const count = self.linked_images(layer).length;
	button.textContent =
		self.get_tool_label('object_images_import_linked', count) || `Import ${count} linked images`;

	const status = ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-object-linked-status',
		parent: holder,
	});

	const show_report = function () {
		status.replaceChildren();
		const report = self._linked_import_report;
		if (!report || report.layer !== layer) {
			return;
		}
		const pending = self.linked_images(layer).map((entry) => entry.url.trim());
		const failures = report.failures.filter((failure) => pending.includes(failure.url));
		if (failures.length === 0) {
			return;
		}
		ui.create_dom_element({
			element_type: 'div',
			text_content:
				self.get_tool_label('object_images_import_failed') ||
				'These links could not be imported and stay on the object:',
			parent: status,
		});
		failures.forEach(function (failure) {
			ui.create_dom_element({
				element_type: 'div',
				class_name: 'uca-maps-object-linked-failure',
				text_content: failure.url + ' — ' + failure.error,
				parent: status,
			});
		});
	};
	show_report();

	button.addEventListener('click', async function () {
		if (button.disabled) {
			return;
		}
		button.disabled = true;

		await self.import_linked_images(layer, function (done, total) {
			status.textContent =
				self.get_tool_label('object_images_importing', done + 1, total) ||
				`Importing ${done + 1} of ${total}…`;
		});

		// nothing imported, nothing committed: this panel is still the live one
		if (holder.isConnected) {
			button.disabled = false;
			show_report();
		}
	});
}; //end render_linked_images_import

/**
 * POPULATE_OBJECT_GALLERY
 * Rebuilds the thumbnail list from the stored descriptors. Rebuilt whole on
 * every change rather than patched, the same criterion `populate_object_viewer`
 * uses: the list is short and bounded (30), and a patched list is where a
 * stale index silently detaches the wrong picture.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} layer
 * @param {HTMLElement} gallery
 * @returns {void}
 */
const populate_object_gallery = function (self, layer, gallery) {
	gallery.replaceChildren();

	const images = self.object_images(layer);
	if (images.length === 0) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'uca-maps-empty-state uca-maps-object-gallery-empty',
			text_content: self.get_tool_label('object_images_empty') || 'No images associated yet.',
			parent: gallery,
		});
		return;
	}

	images.forEach(function (image, index) {
		const url = self.object_image_url(image);
		if (!url) {
			return;
		}

		const item = ui.create_dom_element({
			element_type: 'div',
			class_name: 'uca-maps-object-gallery-item',
			parent: gallery,
		});

		const link = render_new_tab_link('uca-maps-object-gallery-link', undefined, url, item);
		link.title = image.name || String(image.section_id);

		const thumb = ui.create_dom_element({
			element_type: 'img',
			class_name: 'uca-maps-object-gallery-thumb',
			parent: link,
		});
		thumb.src = url;
		thumb.alt = image.name || '';

		const remove = ui.create_dom_element({
			element_type: 'button',
			class_name: 'uca-maps-object-gallery-remove',
			text_content: '×',
			parent: item,
		});
		remove.title = self.get_tool_label('object_images_remove') || 'Remove from this object';

		remove.addEventListener('click', function () {
			self.remove_object_image(layer, index);
			populate_object_gallery(self, layer, gallery);
		});
	});
}; //end populate_object_gallery

// @license-end
