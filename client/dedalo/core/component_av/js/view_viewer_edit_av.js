// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {url_vars_to_object, download_file} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {get_floating_dock} from '../../common/js/floating_dock.js'
	import {
		get_content_data_player
	} from './view_player_edit_av.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_VIEWER_EDIT_AV
* Read-only "viewer" rendering for component_av in edit context.
*
* This view is the stripped-down counterpart of view_player_edit_av: it renders
* the AV media player without the full editing control-button toolbar, and adds a
* dedicated download button so authenticated users can retrieve the original-quality
* file without navigating away.
*
* Typical mounting context:
*   Opened as a standalone viewer window (e.g. via component_av.open_av_player) where
*   the caller URL may carry `tc_in`/`tc_out` query parameters to pre-seek the player
*   to a specific time fragment on load.
*
* Exports:
*   view_viewer_edit_av        — dummy constructor (namespace carrier)
*   view_viewer_edit_av.render — primary async render entry-point
*
* Internal (module-private):
*   download_original_av — triggers the browser file-download for the original AV file
*
* Globals expected at runtime (declared via ESLint /*global* / at file top):
*   get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL
*
* (!) DEDALO_MEDIA_URL is also used at lines 63 and 121 but is NOT listed in the
*   /*global* / declaration, which will cause an ESLint no-undef error.
*   Add 'DEDALO_MEDIA_URL' to the /*global* / comment to fix the lint warning.
*/



/**
* VIEW_VIEWER_EDIT_AV
* Namespace-carrier constructor for the viewer-edit AV view.
* All behaviour lives on static properties (view_viewer_edit_av.render).
* The function body does nothing beyond returning true so that calling it
* directly is benign.
* @returns {boolean} Always true.
*/
export const view_viewer_edit_av = function() {

	return true
}//end view_viewer_edit_av



/**
* RENDER
* Builds and returns the DOM tree for the read-only AV viewer.
*
* Workflow:
*  1. Extracts file metadata (files_info) from the first data entry and resolves
*     the playback URL for the configured default quality (page_globals.dedalo_av_quality_default).
*  2. Creates the outer wrapper div and, when the user lacks write permission
*     (permissions < 2), suppresses the browser's native right-click context menu
*     on it to prevent trivial media extraction.
*  3. Loads the posterframe image into a detached <img> element (never appended to
*     the DOM itself) so that the 'load' event can be used to reveal the download
*     button only after the posterframe is confirmed available.
*  4. Reads `tc_in` / `tc_out` from the current page URL and, if present, sets
*     `self.fragment` so that get_content_data_player will append a media fragment
*     URI to the video src (e.g. `?vbegin=10&vend=30`).
*  5. Delegates actual video/audio DOM construction to get_content_data_player
*     (imported from view_player_edit_av) with `with_control_buttons: false` —
*     the viewer intentionally omits the frame-stepping and timecode controls.
 *  6. Appends a download button that, on click, resolves the 'original'-quality
 *     file URL from files_info and triggers download_original_av. Falls back to the
 *     default-quality URL if no original file is recorded. The button starts hidden
 *     and is revealed by the posterframe 'load' handler (step 3) for users with
 *     write permissions. It is a TENANT of #floating_dock
 *     (core/common/js/floating_dock.js), so the dock column stacks it under/over
 *     the error-report launcher instead of both claiming the same corner.
*
* Data shape expected on `self` (populated by component_common.init):
*   self.data.entries[0].files_info  — Array of file-descriptor objects:
*     { quality: string, extension: string, file_exist: boolean, file_path: string,
*       original_file_name: string }
*   self.data.posterframe_url        — string | null; URL of the still image used
*     as poster for the video element.
*   self.context.features.extension  — Target file extension, e.g. 'mp4'.
*   self.permissions                 — number; < 2 = read-only, >= 2 = write access.
*   self.tipo / self.section_tipo / self.section_id — Used to build a fallback
*     filename when original_file_name is absent.
*
* Side effects:
*   May mutate self.fragment if tc_in is detected in the URL.
*
* @param {Object} self    - component_av instance; must have .data, .context, .permissions.
* @param {Object} options - Currently unused; reserved for future render options.
* @returns {Promise<HTMLElement>} Resolves to the outermost wrapper div for the viewer.
*/
view_viewer_edit_av.render = async function(self, options) {

	const render_level = options?.render_level || 'full'

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		const files_info	= entries[0]
			? (entries[0].files_info || [])
			: []
		const extension		= self.context.features.extension

	// url to download
		// Resolve the playback file descriptor for the platform-default quality tier.
		// The quality value comes from page_globals (e.g. '404' for 404p web quality).
		// The URL is versioned by its file (get_media_url, ?v=<file_time>-<size>).
		// Falls back to page_globals.fallback_image when no matching file descriptor exists.
		const quality	= page_globals.dedalo_av_quality_default // '404'
		const file_info	= files_info.find(el => el.quality===quality && el.extension===extension)
		const url		= file_info
			? get_media_url(file_info)
			: page_globals.fallback_image

	// wrapper background color from posterframe image
		// The <img> element is intentionally NOT appended to the DOM — it is only
		// used here to fire the 'load' / 'error' events so we can conditionally
		// show the download button after a successful posterframe fetch.
		const posterframe_url = self.data.posterframe_url
			? self.data.posterframe_url
			: page_globals.fallback_image
		const image = ui.create_dom_element({
			element_type : 'img'
		})
		image.addEventListener('error', function(e) {
			// Guard against infinite error loops: only substitute the fallback once.
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = posterframe_url

		// set the parameter when the posterframe is loaded
			image.addEventListener('load', function(e) {

				// fit the popup to the poster ratio first (it is known before any
				// media byte loads); the stream ratio refines it on loadedmetadata
				// (the fallback image says nothing about the media ratio)
				if (image.src!==page_globals.fallback_image) {
					fit_viewer_window(image.naturalWidth, image.naturalHeight)
				}

				// show download_image_button
				// only if the user has permissions
				// (!) download_image_button is declared further below via hoisting;
				//     the closure captures the variable reference, not the value, so
				//     the button will exist by the time this callback fires.
				if(self.permissions > 1){
					download_image_button.classList.remove('hidden')
				}
			})

	// fragment. if url params contains tc_in, set a fragment
		// When this view is opened via a deep-link that encodes a time range
		// (tc_in/tc_out as query parameters), we propagate them to self.fragment
		// so that get_content_data_player can append the Media Fragment URI spec
		// parameters (vbegin / vend) to the video src attribute.
		const url_vars = url_vars_to_object(window.location.search)
		if (url_vars && url_vars.tc_in) {
			self.fragment = {
				tc_in	: url_vars.tc_in,
				tc_out	: url_vars.tc_out
			}
		}

	// content_data: contains everything that changes on refresh
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data'
		})

	// media_component player
		// Reuse the shared player-content builder but without the edit control
		// buttons (Beginning / Play / SMPTE / frame-step / ±5s / ±10s).
		const media_player_node = get_content_data_player({
			self					: self,
			with_control_buttons	: false
		})
		content_data.appendChild(media_player_node)

	// window fit to the real stream ratio. Audio-only media reports 0×0 and
	// keeps the poster ratio already applied.
		if (self.video) {
			self.video.addEventListener('loadedmetadata', () => {
				fit_viewer_window(self.video.videoWidth, self.video.videoHeight)
			}, { once: true })
		}

	// button download
		// Starts hidden; revealed by the posterframe 'load' handler above once
		// the media is confirmed to exist and the user has write permissions.
		// A TENANT of #floating_dock, never self-positioned: when this view is
		// mounted as a standalone window the error-report launcher occupies the
		// same corner, and both buttons once hand-rolled it. The dock column
		// stacks them; all geometry lives in core/page/css/layout/floating_dock.less.
		const download_image_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary download floating_dock_button hidden',
			title			: get_label.download || 'Download',
			parent			: get_floating_dock()
		})
		download_image_button.addEventListener('click', function(e) {
			e.stopPropagation()

			// get the original quality for download
			const original = files_info.find(item => item.quality==='original')

			// check if the original file exist else get the url of the default image
			// Falls back to `url` (the default quality URL) when no 'original' entry
			// is recorded or when the original file is not present on disk (file_exist===false).
			const download_url = original && original.file_exist
				? get_media_url(original)
				: url // default image

			// get the name of the original file uploaded (user filename)
			// else get the default name
			// (!) Accessing self.data.entries[0] without a null-guard: if entries is
			//     empty this will throw. The earlier `files_info` derivation already
			//     guards via `entries[0] ?`, but here entries[0] is assumed to exist.
			const name = self.data.entries[0].original_file_name
				? self.data.entries[0].original_file_name
				: self.tipo+'_'+self.section_tipo+'_'+self.section_id

			download_original_av({
				download_url : download_url,
				name : name
			})
		})

	if (render_level==='content') {
		return content_data
	}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_component component_av view_viewer'
		})
		wrapper.content_data = content_data

	// permissions
	// set read only permissions, remove the context menu
		if(self.permissions < 2){
			wrapper.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				return false
			});
		}

		wrapper.appendChild(content_data)


	return wrapper
}//end render



/**
* FIT_VIEWER_WINDOW
* Resizes the viewer popup so its viewport matches the media aspect ratio
* (no letterbox bars). Keeps the current viewport width as anchor and shrinks
* to the available screen when the derived height does not fit.
* Only acts on the popup Dédalo opened itself (window.open target 'viewer',
* see handler_open_viewer / open_av_player): a regular tab cannot be resized
* and must never be. Skipped in fullscreen and for unknown (0) dimensions.
* @param {number} media_width - intrinsic width (poster or video)
* @param {number} media_height - intrinsic height (poster or video)
* @returns {boolean} true when a resize was requested
*/
const fit_viewer_window = function (media_width, media_height) {

	if (!window.opener || window.name!=='viewer' || document.fullscreenElement) {
		return false
	}
	if (!media_width || !media_height) {
		return false
	}

	const ratio		= media_width / media_height
	const chrome_w	= window.outerWidth - window.innerWidth
	const chrome_h	= window.outerHeight - window.innerHeight
	const max_w		= window.screen.availWidth - chrome_w
	const max_h		= window.screen.availHeight - chrome_h

	let width	= window.innerWidth
	let height	= Math.round(width / ratio)
	if (height > max_h) {
		height	= max_h
		width	= Math.round(height * ratio)
	}
	if (width > max_w) {
		width	= max_w
		height	= Math.round(width / ratio)
	}

	// already fitting (2px tolerance for rounding)
	if (Math.abs(width - window.innerWidth) < 2 && Math.abs(height - window.innerHeight) < 2) {
		return false
	}

	window.resizeTo(width + chrome_w, height + chrome_h)

	return true
}//end fit_viewer_window



/**
* DOWNLOAD_ORIGINAL_AV
* Triggers a browser file-download for the resolved AV URL.
*
* Delegates to the shared download_file utility (core/common/js/utils/util.js)
* which creates a temporary <a> element with the `download` attribute, clicks it
* programmatically, and removes it. The downloaded filename is prefixed with
* 'dedalo_download_' to make Dédalo-sourced files easy to identify in the user's
* downloads folder.
*
* Note: the doc-block above this function was previously titled DOWNLOAD_ORIGINAL_IMAGE
* (a copy-paste artefact from the image component). The correct name is
* DOWNLOAD_ORIGINAL_AV to match the function identifier.
*
* @param {Object} options
* @param {string} options.download_url - Fully-qualified URL of the file to download,
*   versioned by its file (?v=<file_time>-<size>).
* @param {string} options.name         - Base filename (without path); used as the
*   suggested save name, prefixed with 'dedalo_download_'.
* @returns {boolean} Always true.
*/
const download_original_av = function (options) {

	const download_url	= options.download_url
	const name			= options.name

	download_file({
		url			: download_url,
		file_name	: `dedalo_download_` + name
	})

	return true
}//end download_original_av



// @license-end
