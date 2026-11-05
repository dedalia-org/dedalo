// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_MEDIA_URL, page_globals*/
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



/**
* FALLBACK_ON_ERROR
* A media <img> whose file does not load (files_info says it exists, the disk
* disagrees: moved, deleted, still processing) shows the app placeholder instead
* of the browser's broken-image icon — once, so a failing placeholder cannot loop.
* @param {HTMLImageElement} image
* @returns {HTMLImageElement} image
*/
export const fallback_on_error = (image) => {

	image.addEventListener('error', () => {
		if (image.src !== page_globals.fallback_image) {
			image.src = page_globals.fallback_image
		}
	})

	return image
}//end fallback_on_error



/**
* MEDIA_FILE_READY
* Whether a media URL answers 2xx — checked before building a heavy viewer
* (pdf.js) so a missing file shows the placeholder, never a spinning reader.
* GET, not HEAD (the engine's media route is GET-only); the body is cancelled
* as soon as the status is known, so nothing beyond the headers is read.
* @param {string} url
* @returns {Promise<boolean>}
*/
export const media_file_ready = async (url) => {

	try {
		const response = await fetch(url, { credentials: 'same-origin' })
		response.body?.cancel()
		return response.ok
	} catch {
		return false
	}
}//end media_file_ready



// @license-end
