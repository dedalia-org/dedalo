// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * DOWNLOAD_DELIVERY
 * How every download reaches the browser: a local Blob, or a server answer
 * decoded from the envelope. Shared by the console's and the map image's
 * downloads and the image carrier's.
 *
 * @module download_delivery
 */

import { request_failed, response_data } from '../../../core/common/js/api_error.js';

/**
 * TRIGGER_BLOB_DOWNLOAD
 * The anchor-click download every format ends in, local Blob or decoded server
 * answer.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
export const trigger_blob_download = function (blob, filename) {
	const url = URL.createObjectURL(blob);

	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}; //end trigger_blob_download

/**
 * BASE64_TO_BLOB
 * Decodes a download carried in the API envelope: unlike v6's web-exposed
 * `downloads/` folder, no generated file reaches a servable path. A manual loop,
 * NOT `fetch('data:…')`: `APP_CSP` (`src/core/api/static_asset.ts`) has no `data:`
 * in `connect-src`, so that fetch fails.
 *
 * @param {string} base64
 * @param {string} mime
 * @returns {Blob}
 */
const base64_to_blob = function (base64, mime) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return new Blob([bytes], { type: mime });
}; //end base64_to_blob

/**
 * DELIVER_DOWNLOAD
 * The tail every server-built download shares: a refusal leaves the button's
 * line empty (core's page notice says why, once and translated); an answer
 * with no data gets the download's own text; one with data is decoded and
 * handed to the browser.
 *
 * @param {Object} response - the tool_request envelope
 * @param {string} failed - the download's own fallback text
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export const deliver_download = async function (response, failed) {
	const data = response_data(response);
	if (!data) {
		return request_failed(response) ? { ok: false } : { ok: false, error: failed };
	}

	const { content_base64, filename, mime } = data;
	trigger_blob_download(base64_to_blob(content_base64, mime), filename);

	return { ok: true };
}; //end deliver_download

// @license-end
