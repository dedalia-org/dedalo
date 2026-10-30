// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_MEDIA_URL*/
/*eslint no-undef: "error"*/



/**
* GET_MEDIA_URL
* Media file URL versioned by the file itself — `file_time.time` (seconds) plus
* `file_size` from files_info — so renders share the HTTP cache and any re-publish
* (upload, transcode, rotate: all atomic renames, so never a partial file) gets a
* new URL. Size covers two writes in one second. THE one builder for every media
* component (av, 3d, image, pdf, svg — WC-2026-10-29-posterframe-url-version);
* server-emitted URLs (posterframe_url, base_svg_url) arrive already versioned.
* Without a file_time the render time is used — never cached, never stale.
* @param {Object} file_info - files_info item ({file_path, file_time})
* @returns {string} url
*/
export const get_media_url = (file_info) => {

	const version = file_info.file_time?.time
		? file_info.file_time.time + '-' + file_info.file_size
		: Date.now()

	return DEDALO_MEDIA_URL + file_info.file_path + '?v=' + version
}//end get_media_url



// @license-end
