// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * STAGED_PAYLOAD
 * A payload too big for a request's `options` (core caps them at 512 KiB): the map
 * capture, an object's GeoJSON. Staged through core's upload door under a key_dir
 * whose one server action reads it and deletes it (`server/staged_upload.ts`).
 *
 * @module staged_payload
 */

import { response_data } from '../../../core/common/js/api_error.js';
import { upload } from '../../../core/services/service_upload/js/service_upload.js';
import { upload_refusal_text } from './panel_error_text.js';

/**
 * STAGE_PAYLOAD
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {File} file - named with the extension the upload door checks
 * @param {string} key_dir - the action's own (`upload_formats.js`)
 * @param {string} lead - the panel's sentence for a refusal, already resolved
 * @returns {Promise<{file_data: Object|null, error: string|null}>}
 */
export const stage_payload = async function (self, file, key_dir, lead) {
	const extension = file.name.slice(file.name.lastIndexOf('.') + 1);
	const upload_response = await upload({
		id: self.id,
		file: file,
		key_dir: key_dir,
		allowed_extensions: [extension],
		tipo: self.geolocation.tipo,
	});
	if (!response_data(upload_response)) {
		return { file_data: null, error: upload_refusal_text(upload_response.error, lead) };
	}
	return { file_data: upload_response.file_data, error: null };
}; //end stage_payload

// @license-end
