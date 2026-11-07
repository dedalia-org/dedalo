// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_API_URL */
/*eslint no-undef: "error"*/

import { ApiError, CLIENT_ERROR } from './api_error.js';

/**
 * LABELS
 * The UI-label dictionary is its own versioned, HTTP-cacheable resource
 * (WC-2026-11-07-labels-separate-resource), no longer a key of the environment.
 * `page_globals.labels_version` names the current dictionary: the URL carries it,
 * so a matching `v` is served `immutable` and every later boot reads it from the
 * browser cache; a new version is a new URL.
 */

/**
 * LABELS_URL
 * The labels route is the API base's sibling: `<…>/api/v1/json/` → `<…>/api/v1/labels`
 * (same base data_manager.url uses, so relative test-runner bases work too).
 * @param {string} lang - e.g. 'lg-eng'
 * @param {string} [version] - page_globals.labels_version
 * @returns {string}
 */
export const labels_url = (lang, version) => {
	const api_url = typeof DEDALO_API_URL !== 'undefined' ? DEDALO_API_URL : '../api/v1/json/';
	const base = api_url.replace(/json\/?$/, 'labels');
	const params = new URLSearchParams({ lang });
	if (version) params.set('v', version);

	return base + '?' + params.toString();
};

/**
 * LOAD_LABELS
 * Fetches the dictionary for `lang` and assigns the global `get_label` (the bare
 * global every module reads). Throws ApiError(client.bad_response) on any failure,
 * leaving `get_label` untouched.
 * @param {string} lang
 * @param {string} [version]
 * @returns {Promise<Object>} the dictionary
 */
export const load_labels = async (lang, version) => {
	const url = labels_url(lang, version);

	let labels;
	try {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		labels = await response.json();
	} catch (error) {
		throw new ApiError({
			code: CLIENT_ERROR.BAD_RESPONSE,
			message: `Unable to load UI labels (${url}): ${error.message}`,
		});
	}
	if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
		throw new ApiError({
			code: CLIENT_ERROR.BAD_RESPONSE,
			message: `Unable to load UI labels (${url}): not a dictionary`,
		});
	}

	globalThis.get_label = labels;

	return labels;
}; //end load_labels

// @license-end
