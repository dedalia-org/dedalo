// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {download_file} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {get_floating_dock} from '../../common/js/floating_dock.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_VIEWER_IMAGE
* Floating popup viewer for a single component_image record.
*
* This module is mounted in a dedicated browser pop-up window (opened via
* window.open()) so the user can inspect a full-size image outside the main
* application chrome. It exposes a single static method — render — that builds
* the popup DOM and wires up all interaction.
*
* Responsibilities:
* - Selects the best-quality image URL from self.data.entries[0].files_info,
*   preferring `page_globals.dedalo_image_quality_default`; falls back to
*   `data.external_source` (externally-hosted image) or
*   `page_globals.fallback_image` when neither is available.
* - After the image loads, calls resize_window_to_image_size() to snap the
*   pop-up dimensions to the actual image dimensions, clipped to the available
*   screen area.
 * - Reveals a Download button (only when self.permissions > 1) that fetches
 *   the 'original' quality file and names it using the original upload filename,
 *   falling back to a tipo/section composite name. The button is a TENANT of
 *   #floating_dock (core/common/js/floating_dock.js) — the pop-up also hosts the
 *   error-report launcher at the same corner, and the dock column stacks them.
 * - Closes the pop-up window on mousedown (intended for single-click inspection).
*
* Expected self shape (component_image instance):
*   self.data.entries[0].files_info  — Array<FileInfo>
*   self.data.external_source        — string|undefined  (externally-hosted URL)
*   self.context.features.extension  — string  (e.g. 'jpg', 'png')
*   self.permissions                 — number  (> 1 means write-capable)
*   self.tipo / self.section_tipo / self.section_id — ontology locator parts
*
* FileInfo shape:
*   { quality: string, extension: string, file_path: string, file_exist: boolean }
*
* Namespace constructor — not instantiated; used only as a namespace for the
* static render method below.
*
* Exports: view_viewer_image (namespace object with static render method)
*/
export const view_viewer_image = function() {

	return true
}//end view_viewer_image



/**
* RENDER
* Builds the full DOM for the image popup viewer and attaches all event listeners.
*
* Selects the display URL by quality/extension match against files_info, or falls
* back to external_source or page_globals.fallback_image. The image is rendered
* hidden until the 'load' event fires, at which point the window is resized to
* fit the image and the image is made visible. The download button is kept hidden
* until the image loads and is only shown when self.permissions > 1.
*
* (!) DEDALO_MEDIA_URL is an implicit global injected by the server into the page
* environment. It is not declared in the /*global*\/ header but is expected to exist.
*
* @param {Object} self    - component_image instance with data, context, and permissions
* @param {Object} options - currently unused; reserved for future caller options
* @returns {HTMLElement} wrapper - the root <div class="component_image view_viewer"> element
*/
view_viewer_image.render = function(self, options) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		// files_info is an array of per-quality/per-extension availability descriptors;
		// only entries[0] is used — this view targets a single image record
		const files_info	= entries[0]
			? (entries[0].files_info || [])
			: []
		const external_source	= data.external_source
		// extension is the canonical file type for this component (e.g. 'jpg'), set in
		// context.features by the server; used to filter the correct FileInfo entry
		const extension			= self.context.features.extension

	// wrapper
		// const wrapper = ui.component.build_wrapper_mini(self)
		const wrapper = document.createElement('div')
			  wrapper.classList.add('component_image')
			  wrapper.classList.add('view_viewer')

	// url
		// dedalo_image_quality_default is a string key such as '1.5MB' that identifies
		// the preferred medium-resolution quality tier for display purposes
		const quality	= page_globals.dedalo_image_quality_default // '1.5MB'
		// Match both quality tier AND extension so that multi-format stores (e.g. original jpg
		// + webp derivative) resolve to the correct file
		const file_info	= files_info.find(el => el.quality===quality && el.extension===extension)
		// Resolution order: explicit external URL > matched file_info path > global fallback image
		const url		= external_source
			? external_source
			: file_info
				? get_media_url(file_info)
				: page_globals.fallback_image

	// image
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'viewer_image hidden',
			// a11y: the viewer window shows the image alone — no label beside it
			alt				: self.label ?? '',
			parent			: wrapper
		})
		// ui.component.add_image_fallback(image)

		// mousedown event
			// Clicking anywhere on the image closes the pop-up window; the viewer is
			// designed for quick single-look inspection, not persistent review
			image.addEventListener('mousedown', function() {
				window.close()
			})

		// image background color
			image.addEventListener('load', set_bg_color, false)
			function set_bg_color() {
				// if (image.src.indexOf(thumb_url)!==-1) {
				// 	return
				// }
				// Resize the pop-up window to match the actual pixel dimensions of the loaded
				// image (capped to available screen space) before revealing it
				resize_window_to_image_size(image)
				// Remove the one-shot handler to avoid double-calls if src is changed later
				this.removeEventListener('load', set_bg_color, false)
				// ui.set_background_image(this, wrapper)
				image.classList.remove('hidden')
				image.classList.add('fit')

				// show download_image_button
				// only if the user has permissions
				// permissions > 1 means the user has at least write access; read-only
				// users (permissions === 1) must not trigger a download action
				if(self.permissions > 1){
					download_image_button.classList.remove('hidden')
				}

			}

		// error event
			// Degrade gracefully: if the resolved URL fails to load (e.g. missing file,
			// network error) swap to the global fallback image, but only once, to prevent
			// an infinite error loop if the fallback itself is also broken
			image.addEventListener('error', function(){
				if (image.src!==page_globals.fallback_image) {
					image.src = page_globals.fallback_image
				}
			}, false)

		// set url
			image.src = url

	// button download
		// A TENANT of #floating_dock, never self-positioned. The pop-up window also
		// hosts the error-report launcher, and both buttons once hand-rolled the
		// same corner (the launcher disc covered this one). The dock column stacks
		// them; all geometry lives in core/page/css/layout/floating_dock.less.
		const download_image_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary download floating_dock_button hidden',
			title			: get_label.download || 'Download',
			// value		: ' ok ',
			parent			: get_floating_dock()
		})
		download_image_button.addEventListener('click', function(e) {
			e.stopPropagation()

			// get the original quality for download
			// 'original' is the unscaled source file stored at upload time
			const original = files_info.find(el => el.quality==='original' && el.extension===extension)

			// check if the original file exist else get the url of the default image
			// (!) If `original` is undefined (no 'original' quality entry in files_info), the
			// property access on the next line will throw a TypeError. No null-guard exists here.
			const download_url	= (original.file_exist)
				? get_media_url(original) // original image
				: url // default image

			// get the name of the original file uploaded (user filename)
			// else get the default name
			// (!) `name` is assigned here without a var/let/const declaration, making it an
			// implicit assignment to window.name (a pre-existing browser global string property).
			// This works at runtime because window.name accepts strings, but it is a side-effect
			// outside the function scope and violates strict-mode intent.
			name = self.data.entries[0].original_file_name
				? self.data.entries[0].original_file_name
				: self.tipo+'_'+self.section_tipo+'_'+self.section_id

			download_original_image({
				download_url	: download_url,
				name			: name
			})
		})


	return wrapper
}//end render



/**
* RESIZE_WINDOW_TO_IMAGE_SIZE
* Resizes the current pop-up window so its inner area matches the loaded image
* dimensions, scaled down to fit within the available screen space if necessary.
*
* The function computes the smallest uniform scaling ratio needed to fit the image
* within both screen_max_width and screen_max_height, then applies that ratio to
* the image's height (relying on the browser to reflow width proportionally via
* the img element's intrinsic aspect ratio). The outer chrome height (toolbars, etc.)
* is estimated as window.outerHeight - window.innerHeight with a 50 px fallback.
*
* Only the image height dimension is mutated; the width is left for the browser to
* compute proportionally (the commented-out `img_w` / `image.width` lines show the
* original intent of setting both explicitly, but only height is active).
*
* @param {HTMLElement} image - The fully loaded <img> element whose naturalWidth /
*   naturalHeight properties reflect the actual pixel dimensions after load
* @returns {boolean} Always returns true
*/
const resize_window_to_image_size = function(image) {
	// screen size
		const screen_max_width	= window.screen.availWidth;
		const screen_max_height	= window.screen.availHeight;

	// Image size, get the ratio of the image when the image is more bigger than screen size
		const ratio_h = screen_max_height < image.height
			?  screen_max_height / image.height
			: 1;
		const ratio_w = screen_max_width < image.width
			? screen_max_width / image.width
			: 1;
		// get the ratio of the most high multiplied
		// (lowest ratio is more difference between sizes; 0.5 > 0.7)
		// ratio 1 is not necessary change the values the change is null
		// Math.min of the two ratios picks the more constraining dimension; clamped
		// to 1 so images smaller than the screen are not upscaled
		const ratio		= Math.min(ratio_h, ratio_w, 1)
		const img_h		= image.height * ratio
		// const img_w	= image.width * ratio
		// set one size of the image, it will resize the other size
		image.height	= img_h
		// image.width	= img_w

		// use the image size to be applied to the window size
		const height	= image.height;
		const width		= image.width;

	// Estimate the height consumed by the browser's own chrome (title bar, toolbars).
	// Falls back to 50 px when the difference is 0 (e.g. fullscreen or certain browsers)
	const tool_bar_height = (window.outerHeight - window.innerHeight) || 50
		// console.log('width:', width, 'height:', height);
		// console.log('tool_bar_height:', tool_bar_height);

	window.resizeTo(width, height+tool_bar_height)


	return true
}//end resize_window_to_image_size



/**
* DOWNLOAD_ORIGINAL_IMAGE
* Triggers a browser file download for the specified URL, prefixing the filename
* with 'dedalo_download_' to distinguish Dédalo exports in the user's Downloads folder.
*
* Delegates to download_file() (core/common/js/utils/util.js), which creates a
* temporary <a download> anchor and programmatically clicks it.
*
* @param {Object} options              - Download configuration
* @param {string} options.download_url - Fully-qualified URL of the file to download
* @param {string} options.name         - Filename to use after the 'dedalo_download_' prefix
* @returns {boolean} Always returns true
*/
const download_original_image = function (options) {

	const download_url	= options.download_url
	const name			= options.name

	download_file({
		url			: download_url,
		file_name	: `dedalo_download_` + name
	})

	return true
}//end download_original_image



// @license-end
