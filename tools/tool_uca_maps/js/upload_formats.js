// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * UPLOAD_FORMATS
 * The extensions each upload takes, read by the logic module (the upload's
 * `allowed_extensions`) and by `render_file_upload.js` (the picker's `accept`).
 * A leaf: the logic modules import the render one, so it cannot import back.
 *
 * @module upload_formats
 */

export const VECTOR_UPLOAD_EXTENSIONS = ['zip', 'geojson', 'kml'];
export const IMAGE_UPLOAD_EXTENSIONS = ['tif', 'tiff', 'jpg', 'jpeg', 'png'];

/** Where "Download map as image" stages its PNG capture; `raster_download`
 * reads (and deletes) only what is staged here. */
export const MAP_IMAGE_KEY_DIR = 'uca_maps_map_image';

/**
 * ACCEPT_ATTRIBUTE
 * A file input's `accept` for a list of extensions: '.zip,.geojson,.kml'.
 *
 * @param {Array<string>} extensions - without the dot
 * @returns {string}
 */
export const accept_attribute = function (extensions) {
	return extensions.map((extension) => '.' + extension).join(',');
}; //end accept_attribute

// @license-end
