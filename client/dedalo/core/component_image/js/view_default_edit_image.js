// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_EDIT_IMAGE
*
* Edit-mode view for component_image that renders an SVG-hosted raster image with
* quality switching and optional vector-editor affordances.
*
* Architecture overview
* ---------------------
* Dédalo stores images as groups of derivative files (different resolutions /
* quality tiers) alongside a companion SVG envelope that crops, frames, and
* anchors vector annotation layers drawn by the vector editor.  The SVG is
* served as an <object type="image/svg+xml"> element whose internal <image>
* element carries the raster URL.  This indirection lets the vector editor
* manipulate SVG layers without touching the raster, and lets quality switches
* only update the href attribute inside the SVG document without
* rebuilding the whole DOM.
*
* Rendering pipeline
* ------------------
* render()
*   └─ get_content_data()             — builds the scrollable area and loops entries
*        └─ get_content_value()       — per-entry: resolves quality, dispatches to
*             ├─ render_image_external()  (external URI path, bypasses SVG envelope)
*             └─ render_image_node()      (Dédalo-media path through SVG object)
*   └─ get_buttons()                  — toolbar: tools, vector-editor toggle, fullscreen
*
* External dependencies (browser globals expected via /*global*\/ pragma)
* -----------------------------------------------------------------------
*  DEDALO_MEDIA_URL  — base URL for Dédalo media files (e.g. '/media/')   (!)
*  page_globals      — runtime config: fallback_image, etc.
*  get_label         — i18n label lookup
*
* (!) DEDALO_MEDIA_URL is used in render_image_node but is NOT declared in the
*     /*global*\/ pragma at the top of this file. If the ESLint no-undef rule is
*     enforced this will produce a lint error. The variable is declared globally
*     by the Dédalo bootstrap before any component module loads.
*
* Exports
* -------
*  view_default_edit_image — namespace object; static .render() is the entry point
*/
// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {get_quality_selector} from './render_edit_component_image.js'
	import {lazy_load_media, media_fade_in} from '../../component_media_common/js/component_media_common.js'



/**
* VIEW_DEFAULT_EDIT_IMAGE
* Manage the components logic and appearance in client side
*/
export const view_default_edit_image = function() {

	return true
}//end view_default_edit_image



/**
* RENDER
* Entry point for the default edit view. Builds the full component wrapper
* containing the scrollable image area (content_data) and the action toolbar
* (buttons), then subscribes to the fullscreen event so the image is rescaled
* when the component enters/exits fullscreen mode.
*
* render_level
* ------------
* When options.render_level === 'content' only content_data is returned
* (no wrapper, no buttons). This is used by partial-refresh callers that want
* to replace the inner area without re-creating the surrounding chrome.
*
* Pointer convention
* ------------------
* wrapper.content_data is set so callers can reach the inner area via the
* returned node without keeping a separate reference.
*
* Event lifecycle
* ---------------
* Subscribes 'full_screen_'+self.id → fit_image(self). The token is pushed
* onto self.events_tokens so component_common.prototype.destroy() will
* unsubscribe it automatically.
*
* @param {Object} self - component_image instance
* @param {Object} options - render options
* @param {string} [options.render_level='full'] - 'full' builds the complete wrapper;
*   'content' returns only the content_data HTMLElement
* @returns {HTMLElement} wrapper element (build_wrapper_edit) or content_data when
*   render_level === 'content'
*/
view_default_edit_image.render = function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons,
			add_styles		: ['media_wrapper'] // common media classes
		}
		if (self.view==='line') {
			wrapper_options.label = null // prevent to crate label node
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data

	// event
		const full_screen_handler = () => {
			fit_image(self)
		}
		self.events_tokens.push(
			event_manager.subscribe('full_screen_'+self.id, full_screen_handler)
		)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the scrollable content area that holds all image entry nodes.
*
* Data shape consumed from self
* -----------------------------
* self.data.entries — Array of entry objects; each entry represents one image
*   upload (multi-image support). Most components have exactly one entry.
*   If entries is empty or missing, the loop still runs once (entries_length
*   defaults to 1) so a placeholder content_value is rendered — this lets
*   editors see the upload affordance even before any image has been uploaded.
*
* Numeric index pointer
* ---------------------
* content_data[i] = content_value provides O(1) access to each entry's node
* for callers that need to update a specific entry without DOM querying.
*
* @param {Object} self - component_image instance
* @returns {HTMLElement} content_data element populated with per-entry content_value nodes
*/
const get_content_data = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self)
		// common media classes
		content_data.classList.add('media_content_data')

	// values (images)
		const inputs_value	= entries
		const entries_length	= inputs_value.length || 1
		for (let i = 0; i < entries_length; i++) {
			const content_value = get_content_value(i, inputs_value[i], self)
			content_data.appendChild(content_value)
			// set the pointer
			content_data[i] = content_value
		}


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Builds the DOM node for a single image entry, choosing between the external-URI
* path and the Dédalo-media SVG path.
*
* Quality resolution order
* ------------------------
* 1. Use self.quality (user's last selection) or fall back to
*    self.context.features.quality (server-configured default).
* 2. Find a file_info whose .quality matches AND whose .file_exist is true.
* 3. If that file does not exist, scan files_info for any existing file and
*    mutate self.quality to match it — keeping the quality selector in sync
*    with what is actually displayed.
*
* External source fast-path
* -------------------------
* When data.external_source is set (image hosted at an arbitrary URI rather
* than in Dédalo media storage), the SVG envelope is bypassed entirely and
* render_image_external() is called instead.
*
* Side effects
* ------------
* - self.quality may be mutated if the originally requested quality file does
*   not exist and a fallback is found (see quality resolution above).
* - self.image_container is set to the image_container node produced by
*   render_image_node(); component_image uses this pointer in
*   image_quality_change_handler and fit_image.
*
* @param {number} i - zero-based entry index within data.entries
* @param {Object|undefined} value - the entry object (data.entries[i]); may be
*   undefined if entries is empty and the loop is running its guaranteed first pass
* @param {Object} self - component_image instance
* @returns {HTMLElement} content_value div containing the image node and quality selector
*/
const get_content_value = function(i, value, self) {

	// short vars
		const quality			= self.quality || self.context.features.quality
		const data				= self.data || {}
		const files_info		= value && value.files_info
			? value.files_info
			: []
		const external_source	= data.external_source

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value media_content_value sgv_editor'
		})

	// external_source case. render the image when the source is external, image from URI
		if(external_source && external_source.length){
			const image_external_node = render_image_external(external_source)
			content_value.appendChild(image_external_node)

			return content_value
		}

	// file_info
		let file_info = files_info.find(el => el.quality===quality && el.file_exist===true)

	// when the default quality file doesn't exist, fallback to the first available quality
	// this keeps the image and the quality selector consistent
		if (!file_info && files_info.length > 0) {
			const available_file = files_info.find(el => el.file_exist===true)
			if (available_file) {
				self.quality = available_file.quality
				// re-resolve file_info with the updated quality
				file_info = available_file
			}
		}

	// render image node
		self.image_container = render_image_node(self, file_info, content_value)
		content_value.appendChild(self.image_container)

	// quality_selector
		const quality_selector = get_quality_selector(self)
		content_value.appendChild(quality_selector)


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ (commented-out / dead code — preserved for reference)
* Read-only variant of get_content_value that was superseded by the shared
* view_default_read_image module. Kept here for archaeological reference only.
*
* @param {number} i - zero-based entry index
* @param {Object} value - entry object (data.entries[i])
* @param {Object} self - component_image instance
* @returns {HTMLElement} content_value element
*/
	// const get_content_value_read = function(i, value, self) {

	// 	// short vars
	// 		const quality	= self.quality || self.context.features.quality
	// 		const data		= self.data || {}
	// 		const datalist	= data.datalist || []

	// 	// content_value
	// 		const content_value = ui.create_dom_element({
	// 			element_type	: 'div',
	// 			class_name		: 'content_value read_only'
	// 		})

	// 	// file_info
	// 		const file_info	= datalist.find(el => el.quality===quality && el.file_exist===true)

	// 	// render the image when the source is external, image from URI
	// 		if(file_info && file_info.external) {

	// 			const img_node = render_image_external(file_info.file_url)
	// 			content_value.appendChild(img_node)

	// 			return content_value
	// 		}

	// 	// render de image in Dédalo media

	// 	// url
	// 		let url = file_info && file_info.file_url
	// 			? file_info.file_url
	// 			: null // DEDALO_CORE_URL + '/themes/default/0.jpg'
	// 		// fallback to default (when not already in default)
	// 		if (!url && quality!==self.context.features.default_quality) {
	// 			const file_info_dq	= datalist.find(el => el.quality===self.context.features.default_quality && el.file_exist===true)
	// 			url = file_info_dq
	// 				? file_info_dq.file_url
	// 				: null
	// 			if (url) {
	// 				// change the quality
	// 				self.quality = self.context.features.default_quality
	// 			}
	// 		}

	// 	// image. (!) Only to get background color and apply to li node
	// 		const bg_reference_image_url = url || page_globals.fallback_image
	// 		if (bg_reference_image_url) {
	// 			const image = ui.create_dom_element({
	// 				element_type	: 'img',
	// 				class_name 		: 'hide'
	// 			})
	// 			// image background color
	// 			image.addEventListener('load', set_bg_color, false)
	// 			function set_bg_color() {
	// 				this.removeEventListener('load', set_bg_color, false)
	// 				ui.set_background_image(this, content_value)
	// 				image.classList.remove('hide')
	// 			}
	// 			// image.addEventListener('error', function(){
	// 			// 	console.warn('Error on load image:', bg_reference_image_url, image);
	// 			// }, false)
	// 			image.src = bg_reference_image_url
	// 		}

	// 	// object_node <object type="image/svg+xml" data="image.svg"></object>
	// 		const object_node = ui.create_dom_element({
	// 			element_type	: 'object',
	// 			class_name		: 'image',
	// 			parent			: content_value
	// 		})
	// 		object_node.type = "image/svg+xml"

	// 		if (data.base_svg_url) {
	// 			// svg file already exists
	// 			object_node.data = data.base_svg_url
	// 		}else{
	// 			// fallback to default svg file
	// 			// base_svg_url_default. Replace default image extension from '0.jpg' to '0.svg'
	// 			const base_svg_url_default	= page_globals.fallback_image.substr(0, page_globals.fallback_image.lastIndexOf('.')) + '.svg'
	// 			object_node.data			= base_svg_url_default
	// 		}
	// 		// set pointer
	// 		self.object_node = object_node

	// 		// auto-change url the first time
	// 		object_node.onload = async function() {
	// 			if (quality!==self.context.features.default_quality) {
	// 				await fn_img_quality_change(url)
	// 			}
	// 			content_value.classList.remove('hide')
	// 		}


	// 	return content_value
	// }//end get_content_value_read



/**
* RENDER_IMAGE_EXTERNAL
* Renders an image whose source is a plain external URI rather than a Dédalo
* media file. The result is a simple <div.image_container> wrapping an <img>
* — no SVG envelope, no quality switching, no lazy loading.
*
* Used when data.external_source is populated (e.g. an image imported from a
* remote catalogue URL). External images bypass cache-busting because the URL
* is controlled by the third-party server, not by Dédalo.
*
* @param {string} file_url - absolute or root-relative URL of the external image
* @returns {HTMLElement} image_container div containing the <img> element
*/
const render_image_external = function(file_url) {

	const image_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'image_container work_area'
	})

	// image_external
	ui.create_dom_element({
		element_type	: 'img',
		class_name		: 'image image_external',
		src				: file_url,
		parent			: image_container
	})


	return image_container
}//end render_image_external



/**
* RENDER_IMAGE_NODE
* Creates an object of type 'image/svg+xml' with svg file and image
* cropped by the svg
*
* Builds the image_container for Dédalo-media images.  The image is hosted
* inside an SVG document (served as an <object type="image/svg+xml">) so that
* vector annotation layers drawn by the vector editor can overlay the raster
* using SVG's native compositing model.
*
* URL construction
* ----------------
* Priority order for the raster URL:
*  1. data.external_source (non-null) — used verbatim
*  2. file_info (non-null) — DEDALO_MEDIA_URL + file_info.file_path + cache-busting
*  3. fallback — page_globals.fallback_image (placeholder image)
* (!) DEDALO_MEDIA_URL is a runtime global injected by the Dédalo bootstrap; it
*     is not listed in the /*global*\/ pragma of this file.
*
* SVG data assignment strategy
* ----------------------------
* The <object>.data attribute that points to the SVG envelope is deferred via
* IntersectionObserver ('lazy load'): the SVG URL is not set until the
* image_container scrolls within 200 px of the viewport. This avoids loading
* dozens of SVG documents on long record lists.
*
* When data.base_svg_url is present (the server has generated the SVG
* envelope), object_node.data is set to that URL with a cache-busting query
* string. When it is absent (image not yet uploaded / SVG not yet generated),
* svg_fallback() points object_node.data to a generic placeholder SVG derived
* from page_globals.fallback_image and, if the user has write permissions,
* attaches a click handler that opens tool_upload so the user can upload an image.
*
* Load handler sequence
* ---------------------
* On object_node 'load':
*  1. If the current quality differs from default_quality, delegates to
*     self.image_quality_change_handler(url) to update the <image> href inside
*     the SVG document.
*  2. Applies a cache-busting timestamp to the SVG-internal <image> href using
*     setAttributeNS so the browser does not serve a stale cached file even
*     when the SVG itself is fresh.
*  3. Fades image_container from opacity 0 to 1 for a smooth appearance.
*
* Error handler
* -------------
* On object_node 'error': if the user has write permissions and a tool_upload
* exists in self.tools, attaches a click handler (guarded against duplicates
* via the 'clickable' class check) that opens the upload tool. Fades the
* container in so the UI is not stuck hidden.
*
* Pointer set on image_container
* --------------------------------
* image_container.object_node = object_node
* This pointer is read by fit_image() and by image_quality_change_handler()
* (accessed via self.image_container.object_node).
*
* @param {Object} self - component_image instance
* @param {Object|null} file_info - file descriptor for the active quality tier, or null
*   when no matching file exists yet. Shape:
*   { quality: string, file_path: string, file_exist: boolean, extension: string, … }
* @param {HTMLElement} content_value - the parent content_value element; used to
*   attach upload click handlers and to manage the 'hide'/'loading' classes
* @returns {HTMLElement} image_container div with .object_node pointer set
*/
const render_image_node = function(self, file_info, content_value) {

	// short vars
		const quality			= self.quality || self.context.features.quality
		const data				= self.data || {}
		const external_source	= data.external_source

	// render de image in Dédalo media
		const url = external_source
			? external_source
			: file_info
				? DEDALO_MEDIA_URL + file_info.file_path + '?t=' + (new Date()).getTime()
				: page_globals.fallback_image

	// image_container
		const image_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'image_container work_area'
		})
		// start invisible for smooth fade-in on load (shared media contract)
		const reveal = media_fade_in(image_container)

	// fallback to default svg file
		const svg_fallback = (object_node) => {
			// base_svg_url_default. Replace default image extension from '0.jpg' to '0.svg'
			const base_svg_url_default	= page_globals.fallback_image.substring(0, page_globals.fallback_image.lastIndexOf('.')) + '.svg'
			object_node.data			= base_svg_url_default

			if (self.permissions>1) {
				// tool_upload. Get the tool context to be opened
				const tool_upload = self.tools.find(el => el.model==='tool_upload')
				if (tool_upload) {
					// upload tool is open on click
					const click_handler = (e) => {
						e.stopPropagation();

						// open_tool (tool_common)
						open_tool({
							tool_context	: tool_upload,
							caller			: self
						})
					}
					content_value.addEventListener('click', click_handler)
					content_value.classList.add('clickable')
				}
			}
		}

	// object_node <object type="image/svg+xml" data="image.svg"></object>
		const object_node = ui.create_dom_element({
			element_type	: 'object',
			class_name		: 'image'
		})
		object_node.type	= "image/svg+xml"
		object_node.url		= url // image URL
		// set pointers
		image_container.object_node	= object_node

	// lazy load: defer setting object_node.data until the container is near the viewport
		const load_svg = () => {
			// append to DOM first so the object load triggers properly
			image_container.appendChild(object_node)

			if (data.base_svg_url) {
				// svg file already exists
				object_node.data = data.base_svg_url + '?t=' + (new Date()).getTime()
			}else{
				svg_fallback(object_node)
			}
		}
		// lazy load only when near viewport (shared media helper, 200px preload)
		lazy_load_media(image_container, load_svg)

	// load handler: update image quality and apply cache-busting
		const load_handler = async () => {
			// the lazy-load observer / <object> load can fire after destroy (context is null)
			if (self.status==='destroyed') {
				return
			}
			if (quality!==self.context.features?.default_quality) {
				await self.image_quality_change_handler(url)
			}

			// dynamic_url . prevents to cache files inside svg object
			const svg_doc = object_node.contentDocument
			if (svg_doc) {
				const image = svg_doc.querySelector('image')
				if (image) {
					const dynamic_url = image.href.baseVal + '?t=' + (new Date()).getTime()
					// Both: an editor-exported envelope links the raster with SVG2 `href`,
					// which takes precedence over xlink:href.
					image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dynamic_url);
					image.setAttribute('href', dynamic_url);
				}
			}

			// smooth appearance: fade in instead of instant show
			content_value.classList.remove('hide')
			reveal()
		}
		object_node.addEventListener('load', load_handler)

	// error handler: fallback when SVG fails to load
		object_node.addEventListener('error', () => {
			if (self.permissions>1 && !content_value.classList.contains('clickable')) {
				const tool_upload = self.tools.find(el => el.model==='tool_upload')
				if (tool_upload) {
					const click_handler = (e) => {
						e.stopPropagation();
						open_tool({
							tool_context	: tool_upload,
							caller			: self
						})
					}
					content_value.addEventListener('click', click_handler)
					content_value.classList.add('clickable')
				}
			}
			content_value.classList.remove('hide')
			reveal()
		})


	return image_container
}//end render_image_node



/**
* GET_BUTTONS
* Assembles the toolbar that appears alongside (or above) the image in edit mode.
*
* The toolbar contents depend on three guards drawn from self.show_interface:
*
*  show_interface.tools === true
*    → standard tool buttons (upload, crop, etc.) via ui.add_tools()
*    + vector-editor toggle button (only when also read_only===false and
*      permissions > 1)
*
*  show_interface.read_only === false && show_interface.tools === true
*    && self.permissions > 1
*    → vector_editor toggle button: a <span.button.vector_editor> that shows /
*      hides the vector_editor_tools panel. On first show, self.load_vector_editor()
*      is called to dynamically import and initialise the vector editor module.
*      self.vector_editor_tools is set as a pointer so the vector editor can
*      populate its own control panel into that container.
*    (!) vector_editor_tools is declared with `const` after it is referenced
*        inside mouseup_handler due to JS hoisting of const (temporal dead zone).
*        This works at runtime because the handler only fires after the outer
*        function has completed, but static analysers may warn about it.
*
*  show_interface.button_fullscreen === true
*    → fullscreen toggle button. On click: requests CSS fullscreen on self.node
*      via ui.enter_fullscreen(), then publishes 'full_screen_'+self.id with
*      true (entering) or false (exiting via the exit_callback). The render()
*      function subscribes to this event and calls fit_image() in response.
*
* Permissions guard
* -----------------
* get_buttons is only called from render() when self.permissions > 1, so all
* buttons in this function assume at minimum write access. The inner check
* self.permissions > 1 inside the vector-editor branch is therefore redundant
* but kept for clarity and forward safety.
*
* @param {Object} self - component_image instance; must have .show_interface,
*   .permissions, .tools, .node, .id, and .load_vector_editor()
* @returns {HTMLElement} buttons_container element built by
*   ui.component.build_buttons_container()
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true) {
			ui.add_tools(self, fragment)
		}

	// open svg editor tools
		if (show_interface.read_only === false && show_interface.tools === true && self.permissions > 1) {
			// vector_editor
			const vector_editor = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button vector_editor',
				title			: 'Toggle vector editor',
				parent			: fragment
			})
			// mouseup event
			const mouseup_handler = (e) => {
				e.stopPropagation()

				vector_editor_tools.classList.toggle('hide')
				if(!vector_editor_tools.classList.contains('hide')){
					self.load_vector_editor()
				}
			}
			vector_editor.addEventListener('mouseup', mouseup_handler)

			// svg editor tools
			const vector_editor_tools = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'vector_editor_tools hide',
				parent			: fragment
			})
			self.vector_editor_tools = vector_editor_tools
		}

	// button_fullscreen
		if(show_interface.button_fullscreen === true){

			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: fragment
			})
			// click event
			const click_handler = (e) => {
				e.stopPropagation()
				ui.enter_fullscreen(self.node, ()=>{
					event_manager.publish('full_screen_'+self.id, false)
				})
				event_manager.publish('full_screen_'+self.id, true)
			}
			button_fullscreen.addEventListener('click', click_handler)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)
		buttons_container.appendChild(fragment)

	// buttons_fold (allow sticky position on large components)
		// const buttons_fold = ui.create_dom_element({
		// 	element_type	: 'div',
		// 	class_name		: 'buttons_fold',
		// 	parent			: buttons_container
		// })
		// buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



/**
* FIT_IMAGE
* Resizes the image to fit the container
* Used on fullscreen mode to scale current image object to fit
* the new component dimensions
*
* Rescales all SVG layers inside the <object> node so that the image fills the
* available space without overflowing. Called in response to the
* 'full_screen_'+self.id event published by the fullscreen button click handler
* and by the window resize listener registered inside this function.
*
* Scale calculation
* -----------------
* Both height and width ratios between the image_container bounding rect and
* the actual SVG <image> element's intrinsic dimensions are computed. The
* minimum ratio is applied via element.style.scale on each SVG <layer> element
* so the image fits in both axes (letterbox / pillarbox behaviour).
*
* CSS scale vs transform
* ----------------------
* `el.style.scale = ratio` (logical property) is used instead of the
* commented-out `el.style.transform = \`scale(${ratio})\``. The logical
* property avoids compositing with other transforms.
*
* Width adjustment
* ----------------
* After scaling, the first layer's rendered width is read back (getBoundingClientRect)
* and applied to object_node.style.width so the SVG object element shrinks to
* match the scaled content, preventing empty space to the right.
* (!) object_node.style.height is intentionally left untouched (commented out).
*
* Resize listener
* ---------------
* A 'resize' listener is attached to window only when the wrapper element
* carries the 'fullscreen' class. The listener recursively calls fit_image so
* the image re-scales when the user resizes the browser window while in
* fullscreen mode.
* (!) No cleanup of this resize listener is performed when exiting fullscreen.
*     If fit_image is called again after the 'fullscreen' class is removed, a
*     new listener will accumulate. This is a known limitation.
*
* Early-return conditions
* -----------------------
* - self.vector_editor is truthy: the vector editor manages its own canvas
*   scaling; fit_image must not interfere.
* - self.image_container.object_node is falsy: no SVG object was rendered
*   (e.g. external-source path).
* - object_node.contentDocument is not accessible: SVG not yet loaded.
* - #main_image / 'image' element not found inside the SVG document.
*
* @param {Object} self - component_image instance; must have .vector_editor,
*   .image_container (with .object_node pointer), and .node (the wrapper)
* @returns {void}
*/
const fit_image = function(self) {

	// vector_editor. If isset, nothing to do, only for non edit image
		if (self.vector_editor || !self.image_container.object_node) {
			return
		}

	// wrapper
		const wrapper = self.node

	// image container
		const image_container		= self.image_container
		const bb_image_container	= image_container.getBoundingClientRect()

	// object_node
		const object_node = image_container.object_node
		if (!object_node || !object_node.contentDocument) {
			console.error('object_node not found in image_container!', image_container);
			return
		}
		const layers		= object_node.contentDocument.querySelectorAll('.layer')
		const main_image	= object_node.contentDocument.querySelector('#main_image')
			|| object_node.contentDocument.querySelector('image')
			if (!main_image) {
				console.error('main_image not found in object_node!', object_node);
				return
			}

	// ratio
		const image_container_height	= bb_image_container.height
		const image_container_width		= bb_image_container.width
		const main_image_height			= main_image.height.baseVal.value
		const main_image_width			= main_image.width.baseVal.value

		const ratio_h	= image_container_height / main_image_height
		const ratio_w	= image_container_width / main_image_width

		const ratio = Math.min(ratio_h, ratio_w)

	// style scale
		const layers_length = layers.length
		for (let i = 0; i < layers_length; i++) {
			const el = layers[i]

			// el.style.transform = `scale(${ratio})`;
			el.style.scale = ratio

			if (i===0) {
				const bb = el.getBoundingClientRect()
				object_node.style.width = bb.width + 'px'
				// object_node.style.height = bb.height + 'px'
			}
		}

	// event resize. Only if we are in fullscreen.
	// Register a single resize handler (stored on self) instead of adding a brand-new
	// closure on every fit_image call — otherwise listeners accumulate unbounded and
	// each one re-runs the layout-thrashing fit_image on every resize.
		if (wrapper.classList.contains('fullscreen')) {
			if (!self._fit_image_resize_handler) {
				self._fit_image_resize_handler = () => { fit_image(self) }
				window.addEventListener('resize', self._fit_image_resize_handler)
			}
		} else if (self._fit_image_resize_handler) {
			// leaving fullscreen: remove the resize handler
			window.removeEventListener('resize', self._fit_image_resize_handler)
			self._fit_image_resize_handler = null
		}
}//end fit_image



// @license-end
