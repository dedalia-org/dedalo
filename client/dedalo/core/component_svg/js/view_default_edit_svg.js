// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {lazy_load_media, media_fade_in} from '../../component_media_common/js/component_media_common.js'
	import {get_media_url, fallback_on_error} from '../../component_media_common/js/media_url.js'



/**
* VIEW_DEFAULT_EDIT_SVG
* Default edit-mode view for component_svg. Builds the full editable DOM layout
* for an SVG asset component, including a lazy-loaded SVG preview, tool buttons,
* and an optional fullscreen button.
*
* This module is the rendering target for the 'default' (and 'print') cases of
* render_edit_component_svg.prototype.edit. The 'line' view is handled separately
* by view_line_edit_svg, which reuses get_content_data from this module.
*
* Permission model:
*  - permissions > 1 → full edit: lazy IntersectionObserver load + upload shortcut
*    on the fallback image click; get_buttons() toolbar is added.
*  - permissions === 1 (read-only / print) → get_content_value_read() is used
*    instead; image is set immediately (no lazy load); no tool buttons.
*
* Data shape expected on self.data:
*  {
*    entries: [                  // zero or one element expected for SVG components
*      {
*        files_info: [           // array of available renditions
*          {
*            quality    : string,  // e.g. 'standard', 'original', 'thumb'
*            file_path  : string,  // server-relative path (appended to DEDALO_MEDIA_URL)
*            file_exist : boolean  // false when the file has been recorded but not yet stored
*          }
*        ]
*      }
*    ]
*  }
*
* When entries is empty, a single null entry is synthesised so the fallback
* (upload prompt) image is always rendered.
*
* Exported symbols:
*  - view_default_edit_svg  — constructor (namespace holder for static .render)
*  - get_content_data       — also imported by view_line_edit_svg for the line view
*/



/**
* VIEW_DEFAULT_EDIT_SVG
* Constructor — namespace holder; no instance state is used. All functionality
* is exposed via static properties (view_default_edit_svg.render).
* @returns {boolean} true
*/
export const view_default_edit_svg = function() {

	return true
}//end view_default_edit_svg



/**
* RENDER
* Build and return the full wrapper element for the default edit view.
*
* Selects between full-wrapper and content-only output via options.render_level:
*  - 'content' → returns the content_data element directly (used by portal overlays
*                and inline refresh paths that only replace the inner content)
*  - 'full' (default) → returns the outer wrapper built by ui.component.build_wrapper_edit
*
* Tool buttons are only added when self.permissions > 1 (write access).
* The 'media_wrapper' CSS class is appended via add_styles so that shared
* media layout rules apply to the wrapper.
*
* @param {Object} self - component_svg instance (must have data, context, permissions, tools)
* @param {Object} options - render options
* @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} wrapper element (or content_data when render_level is 'content')
*/
view_default_edit_svg.render = async function(self, options) {

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
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			buttons			: buttons,
			add_styles		: ['media_wrapper'] // common media classes
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* CONTENT_DATA_EDIT
* Build the content_data container holding one content_value element per entry.
*
* In practice, SVG components hold at most one entry (one asset). When entries
* is empty a synthetic [null] array is used so the loop always executes at least
* once and the upload-prompt fallback image is rendered.
*
* Dispatches to get_content_value (edit) or get_content_value_read (read-only)
* based on self.permissions: permissions === 1 → read-only rendering.
*
* The 'media_content_data' CSS class is applied so shared media layout rules
* (scroll, overflow, aspect-ratio constraints) take effect.
*
* Each content_value node is also indexed numerically on content_data[i] to allow
* callers to reach individual value nodes without a DOM query.
*
* @param {Object} self - component_svg instance
* @returns {HTMLElement} content_data - container with one child per entry
*/
export const get_content_data = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self)
		// common media classes
		content_data.classList.add('media_content_data')

	// values iterate (one or zero is expected)
		const inputs_value		= entries.length>0 ? entries : [null]
		const entries_length	= inputs_value.length
		for (let i = 0; i < entries_length; i++) {
			// get the content_value
			const content_value = (self.permissions===1)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self)
			// add node to content_data
			content_data.appendChild(content_value)
			// set the pointer
			content_data[i] = content_value
		}

	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Build the editable content_value element for a single SVG entry (write access).
*
* Two rendering paths:
*
*  1. File found (file_info is truthy): renders an <img> inside an image_container <div>.
*     The image is loaded lazily via IntersectionObserver with a 200px root-margin so it
*     begins loading slightly before it enters the viewport. On load, the container fades
*     in smoothly (opacity 0 → 1, CSS transition). The <img> has tabindex=0 so it can
*     receive keyboard focus.
*
*  2. No file (file_info is falsy): renders a fallback <img> (page_globals.fallback_image)
*     also loaded lazily. A mousedown handler on the image opens tool_upload so the user
*     can upload an SVG file immediately. The tool descriptor is located by searching
*     self.tools for model === 'tool_upload'.
*
* The URL is versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* (!) DEDALO_MEDIA_URL is used as a global but is NOT declared in the /*global*\/
*     comment at the top of this file. Under the active /*eslint no-undef:"error"*\/
*     rule this will produce a lint error. Add DEDALO_MEDIA_URL to the /*global*\/
*     directive to resolve it.
*
* (!) `extension` (from self.context.features.extension) and `external_source`
*     (from self.data.external_source) are read into local variables but are never
*     used by this function. They are likely vestiges of a planned feature or a
*     copy from a sibling component. Do not remove them without confirming no future
*     code path relies on them being evaluated.
*
* @param {number} i - zero-based entry index (used by the parent loop; unused inside)
* @param {Object|null} value - entry object from data.entries, or null when entries is empty
* @param {Object} self - component_svg instance
* @returns {HTMLElement} content_value div containing the SVG preview or fallback image
*/
const get_content_value = function(i, value, self) {

	// short vars
		const quality			= self.quality || self.context.features.quality
		const extension			= self.context.features.extension
		const data				= self.data || {}
		const files_info		= value && value.files_info
			? value.files_info
			: []
		const external_source	= data.external_source

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value media_content_value'
		})

	// media url from files_info based on selected context quality
		const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true)
		const url		= file_info
			? get_media_url(file_info)
			: page_globals.fallback_image

	// svg item
		if (file_info) {
			// image container for smooth fade-in
			const image_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'image_container',
				parent			: content_value
			})
			// start invisible for smooth fade-in on load (shared media contract)
			const reveal = media_fade_in(image_container)

			// image
			const image = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'image svg_element',
				// a11y: a FOCUSABLE image (tabindex 0 below) needs a name of its own
				alt				: self.label ?? '',
				parent			: image_container
			})
			image.setAttribute('tabindex', 0)

			// lazy load: defer setting image src until container is near viewport
			const load_svg = () => {
				image.src = url
			}
			// lazy load only when near viewport (shared media helper, 200px preload)
			lazy_load_media(image_container, load_svg)

			// load handler: smooth appearance fade-in
			const load_handler = () => {
				reveal()
			}
			image.addEventListener('load', load_handler)
			// error also reveals so a broken svg does not stay invisible, and swaps in the placeholder
			image.addEventListener('error', reveal)
			fallback_on_error(image)

		}else{

			// image fallback
			const image_url = page_globals.fallback_image
			const image_node = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'image svg_element fallback_image clickable',
				parent			: content_value
			})

			// lazy load for fallback (shared media helper, 200px preload)
			lazy_load_media(content_value, () => {
				image_node.src = image_url
			})

			// click handler
			const click_handler = (e) => {
				e.stopPropagation()
				const tool_upload = self.tools.find(el => el.model==='tool_upload')
				open_tool({
					tool_context	: tool_upload,
					caller			: self
				})
			}
			image_node.addEventListener('mousedown', click_handler)
		}


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build the read-only content_value element for a single SVG entry (permissions === 1).
*
* Unlike the editable path (get_content_value), this function:
*  - Does not use IntersectionObserver — the image src is set immediately.
*  - Does not attach any event listeners.
*  - Adds the 'read_only' CSS class to content_value so stylesheets can suppress
*    interactive affordances (e.g. cursor pointer, hover effects).
*
* Used by get_content_data when self.permissions === 1, which happens either
* because the current user genuinely lacks write access, or because the 'print'
* view path in render_edit_component_svg has forced permissions to 1.
*
* The url guard (`if (url)`) is always true in practice because the fallback URL
* (page_globals.fallback_image) is assigned when file_info is absent — so an empty
* src is never actually set.
*
* (!) `extension` and `external_source` are read but never consumed here, matching
*     the same unused-variable pattern as in get_content_value. See that function's
*     flag for details.
*
* (!) DEDALO_MEDIA_URL is used without being declared in the /*global*\/ comment.
*     See the flag in get_content_value.
*
* @param {number} i - zero-based entry index (passed by the caller loop; unused inside)
* @param {Object|null} value - entry object from data.entries, or null when entries is empty
* @param {Object} self - component_svg instance
* @returns {HTMLElement} content_value div containing the SVG image (or nothing if url is falsy)
*/
const get_content_value_read = function(i, value, self) {

	// short vars
		const quality			= self.quality || self.context.features.quality
		const extension			= self.context.features.extension
		const data				= self.data || {}
		const files_info		= value && value.files_info
			? value.files_info
			: []
		const external_source	= data.external_source

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value media_content_value read_only'
		})

	// media url from files_info based on selected context quality
		const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true)
		const url		= file_info
			? get_media_url(file_info)
			: page_globals.fallback_image

	// svg item
		if (url) {
			// image
			const image = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'image svg_element',
				src				: url,
				parent			: content_value
			})
			fallback_on_error(image)
		}


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the buttons_container element for the edit view.
*
* Two button types are conditionally added, controlled by self.show_interface flags:
*
*  - show_interface.tools === true → calls ui.add_tools(self, fragment) to attach
*    the component's tool buttons (e.g. tool_upload, tool_viewer) from self.tools[].
*
*  - show_interface.button_fullscreen === true → adds a 'Full screen' button that
*    calls ui.enter_fullscreen(self.node) on click, expanding the component's root
*    node to fullscreen via the Fullscreen API.
*
* All buttons are first collected in a DocumentFragment to minimise reflows, then
* transferred into a buttons_fold <div> which sits inside the buttons_container.
* The buttons_fold wrapper allows the button bar to use CSS sticky positioning on
* tall/scrollable components without reflow cost.
*
* @param {Object} self - component_svg instance (must have show_interface, tools, node)
* @returns {HTMLElement} buttons_container element ready to be injected into the wrapper
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// button_fullscreen
		if(show_interface.button_fullscreen === true){

			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: fragment
			})
			button_fullscreen.addEventListener('click', function(e) {
				e.stopPropagation()
				ui.enter_fullscreen(self.node)
			})
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
