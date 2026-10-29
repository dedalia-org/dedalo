// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_EDIT_3D
* Default edit-mode view for component_3d — 3-D model viewer with upload fallback.
*
* This module provides the HTML sub-tree for one component_3d instance rendered in
* 'default', 'line', or 'print' edit modes.  Responsibilities:
*
* - Build the outer `wrapper` and `content_data` nodes via `ui.component` helpers.
* - For each entry (maximum one is currently enforced) either:
*     • Lazy-load the Three.js-based 3-D viewer once the element scrolls into the
*       browser viewport (`when_in_viewport`), OR
*     • Show the posterframe thumbnail for read-only / low-permission contexts.
* - Wire the `3d_quality_change_<id>` event so the viewer reloads on quality switch.
* - Provide the toolbar (`get_buttons`) with optional tool buttons and a full-screen
*   toggle, gated by `self.show_interface` flags.
*
* Data shape expected on `self` (component_3d instance):
*   self.data  {Object}   — server-resolved component data
*     .entries            {Array<Object>} — one-element array; each entry holds:
*       .files_info       {Array<Object>} — per-quality file descriptors
*         [].quality      {string}        — e.g. 'thumb', 'medium', 'hd'
*         [].file_exist   {boolean}
*         [].file_path    {string}        — path relative to DEDALO_MEDIA_URL
*     .posterframe_url    {string|undefined}
*     .external_source    {string|undefined} — full URL override (skips files_info)
*   self.quality          {string}   — active quality tier
*   self.permissions      {number}   — ≥2 = write access; 1 = read-only
*   self.show_interface   {Object}   — flags: tools, button_fullscreen, …
*   self.tools            {Array}    — tool descriptors for `ui.add_tools`
*   self.viewer           {Object}   — set after viewer initialises; used by upload_handler
*   self.events_tokens    {Array}    — collects event subscriptions for cleanup
*
* Exports: view_default_edit_3d (namespace), get_content_value, get_content_value_read,
*          get_buttons
*/

// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {when_in_viewport,dd_request_idle_callback} from '../../common/js/events.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {get_quality_selector} from './render_edit_component_3d.js'



/**
* VIEW_DEFAULT_EDIT_3D
* Namespace constructor for the default edit view of component_3d.
* All functionality is exposed as static properties (e.g. `view_default_edit_3d.render`).
* The constructor itself is a no-op placeholder that keeps the prototype chain consistent
* with other Dédalo view modules.
*/
export const view_default_edit_3d = function() {

	return true
}//end view_default_edit_3d



/**
* RENDER
* Build and return the full edit-mode DOM tree for a component_3d instance.
*
* When `options.render_level === 'content'` only the inner `content_data` element is
* returned (used by refresh flows that replace content without re-building the wrapper).
* Otherwise the complete wrapper — including buttons — is returned and a pointer
* `wrapper.content_data` is set for callers that need direct access to the content node.
*
* @param {Object} self - component_3d instance; must expose data, permissions, view,
*   show_interface, tools, quality, context, node, events_tokens
* @param {Object} options - render options
* @param {string} [options.render_level='full'] - 'full' returns the complete wrapper;
*   'content' returns only the content_data sub-tree
* @returns {Promise<HTMLElement>} wrapper element (or content_data when render_level==='content')
*/
view_default_edit_3d.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		// Build the inner content sub-tree first; in 'content' mode we stop here
		// and return it directly (bypassing wrapper rebuild).
		const content_data = get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	/// buttons
		// Only users with write access (permissions > 1) receive an action toolbar.
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		// 'media_wrapper' is a shared CSS class applied to all media components
		// (image, av, 3d, pdf …) to enforce common sizing/border rules.
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons,
			add_styles		: ['media_wrapper'] // common media classes
		}
		if (self.view==='line') {
			// Suppress the label node in compact/line views — it wastes vertical space.
			wrapper_options.label = null // prevent to crate label node
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA_EDIT
* Build the scrollable content area that holds the 3-D entry (or entries).
*
* component_3d currently supports at most one 3-D file per record.  The loop
* iterates `entries` but `break`s after the first iteration; a console.warn is
* emitted when the server sends more than one entry so developers can spot data
* problems early.
*
* The content_data node is tagged with 'media_content_data', which is the shared
* CSS hook used across all media components for consistent layout.
*
* Permissions routing:
*   self.permissions === 1  → read-only thumbnail view (get_content_value_read)
*   self.permissions  >  1  → full interactive viewer  (get_content_value)
*
* @param {Object} self - component_3d instance
* @returns {HTMLElement} content_data - container node with one `content_value` child
*   and a numeric index pointer `content_data[0]` pointing to that child
*/
const get_content_data_edit = function(self) {

	// Load threeJS library
	// await self.load_editor_files()

	// short vars
		const data		= self.data || {}  // content generated by the server related to the involving data structure
		const entries	= data.entries || []  // content generated by the server related to the file itself

	// content_data
		const content_data = ui.component.build_content_data(self)
		// common media classes
		content_data.classList.add('media_content_data')

	// values (inputs)
		const inputs_value		= entries || [] // force one empty input at least
		const entries_length	= inputs_value.length || 1
		if (entries_length>1) {
			// (!) component_3d only supports a single 3-D asset per record for now.
			// Extra entries from the server are ignored — only index 0 is rendered.
			console.warn('More than one value in component_3d is not allowed at now. Ignored next values. N values: ', entries_length);
		}
		for (let i = 0; i < entries_length; i++) {

			const content_value = (self.permissions===1)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self)
			content_data.appendChild(content_value)
			// set pointer
			content_data[i] = content_value
			break; // only one is used for the time being
		}


	return content_data
}//end  get_content_data_edit



/**
* GET_CONTENT_VALUE
* Build the interactive 3-D viewer cell for one entry in write-access mode.
*
* Two rendering paths depending on available file data:
*
* PATH A — file found (`file_url` is non-null):
*   1. A posterframe `<img>` is shown immediately as a visual placeholder while the
*      Three.js viewer module is loaded lazily (dynamic import).
*   2. The viewer is initialised via `module.viewer.init` and `viewer_3d.build`, then
*      `viewer_3d.load(file_url)` fetches and renders the 3-D model.
*   3. Once loaded, `viewer_ready_<id>` is published so `component_3d.upload_handler`
*      can trigger posterframe generation, and the placeholder image is removed.
*   4. A `3d_quality_change_<id>` subscription reloads the model when the operator
*      selects a different quality tier in `get_quality_selector`.
*
* PATH B — no file (`file_url` is null, i.e. no upload yet):
*   A fallback image is shown and a `mousedown` listener opens `tool_upload` directly,
*   giving the operator a fast path to upload the first 3-D asset.
*
* Lazy loading is gated by `when_in_viewport` — the viewer is not initialised until the
* element scrolls into view, avoiding unnecessary Three.js bootstrapping for off-screen
* components.
*
* `self.viewer` is set as a side-effect so that `component_3d.upload_handler` and
* `component_3d.create_posterframe` can later reference the live viewer instance.
*
* The `external_source` field in `self.data` overrides `files_info` entirely; it is used
* when the 3-D model is hosted on an external URL rather than the Dédalo media server.
*
* `?t=<timestamp>` cache-busting query parameters are appended to all media URLs so that
* re-uploaded files are not served stale from browser caches.
*
* @param {number} i - zero-based entry index (always 0 in the current single-entry model)
* @param {Object|undefined} current_value - the raw entry object from `self.data.entries[i]`;
*   may be undefined when entries is empty
* @param {Object} self - component_3d instance; must expose data, quality, context,
*   viewer, events_tokens, tools, id
* @returns {HTMLElement} content_value - the mounted viewer/placeholder element;
*   a `content_value.posterframe` pointer is set when a posterframe img is created
*/
export const get_content_value = (i, current_value, self) => {

	// short vars
		const quality		= self.quality || self.context.features.quality
		const data			= self.data || {}
		// files_info: array of per-quality file descriptors sent by the server;
		// each item: { quality, file_exist, file_path, extension, … }
		const files_info	= current_value && current_value.files_info
			? current_value.files_info
			: []
		// external_source: full URL string; when present it overrides the files_info
		// lookup and the model is fetched from a third-party host (e.g. Sketchfab).
		const external_source = data.external_source

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value media_content_value'
		})

	// file_info
		// Find the matching quality descriptor; only render a posterframe if the
		// physical file is confirmed to exist on the server (file_exist === true).
		const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true)
		if(file_info) {
			// posterframe image
			// The server versions the URL by file mtime+size (?v=), so a re-uploaded image gets a new URL.
			const posterframe_url = data.posterframe_url
				? data.posterframe_url
				: page_globals.fallback_image
			content_value.posterframe = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'posterframe loading',
				parent			: content_value
			})
			content_value.posterframe.setAttribute('height', 392)
			// image background color
			// Once the posterframe loads, derive a dominant background colour from the
			// image so the viewer frame blends with the media (skip for fallback images).
			content_value.posterframe.addEventListener('load', set_bg_color, false)
			function set_bg_color() {
				this.removeEventListener('load', set_bg_color, false)
				if (content_value.posterframe.src!==page_globals.fallback_image) {
					ui.set_background_image(this, content_value)
				}
			}
			// If the posterframe URL fails (e.g. file not yet generated), fall back to
			// the global placeholder image to avoid a broken-image icon.
			const error_handler = () => {
				content_value.posterframe.removeEventListener('error', error_handler)
				if (content_value.posterframe.src !== page_globals.fallback_image) {
					content_value.posterframe.src = page_globals.fallback_image
				}
			}
			content_value.posterframe.addEventListener('error', error_handler)
			// set src url
			content_value.posterframe.src = posterframe_url
		}

	// init viewer when content_value node is in in browser viewport
	// Wrapping in `when_in_viewport` defers the heavy Three.js dynamic import until
	// the element is actually visible, reducing initial page-load cost.
	const load_viewer = async () => {

		// the epoch this build belongs to; component_3d.destroy bumps it
		const epoch = self.viewer_epoch || 0
		const stale = () => (self.viewer_epoch || 0)!==epoch

		// url
		// Priority: external_source > files_info entry > null (no file uploaded yet).
		const file_url = external_source
			? external_source
			: file_info
				? DEDALO_MEDIA_URL + file_info.file_path + '?t=' + (new Date()).getTime()
				: null

		if(file_url) {

			// Dynamic import keeps Three.js out of the main bundle; it is fetched only
			// when an actual 3-D file needs to be displayed.
			const module = await import('./viewer/viewer.js');

			// The build is lazy (when_in_viewport) and crosses two awaits, so the
			// component can be destroyed inside this window — the exact
			// fast-navigation case this whole path exists to survive. Nothing was
			// re-checked afterwards, so build() would go on to start a render loop
			// and attach an observer for a component that no longer exists, and then
			// re-assign self.viewer on an instance whose destroy had already run:
			// an orphan nobody could ever stop. Check after EVERY await.
			if (stale()) return;

			// viewer_3d
			// init() returns a NEW per-caller viewer (see viewer.init): each
			// component_3d owns its renderer and its WebGL context, and destroying
			// one cannot touch another's. cache:false is THREE.Cache — it keeps the
			// asset from being served from a stale XHR cache, nothing more.
			const viewer_3d = await module.viewer.init({
				cache : false
			})
			if (stale()) return;

			// fix viewer
			// Expose the viewer on self so upload_handler and create_posterframe can
			// reference it without a separate lookup.
			self.viewer = viewer_3d

			await viewer_3d.build(content_value, {})
			// destroyed while building: nothing else will ever call this teardown
			if (stale()) {
				viewer_3d.destroy()
				self.viewer = null
				return
			}

			viewer_3d.load(
				file_url  // + '?t=' + (new Date()).getTime()
			) // rootPath, fileMap
			.catch((e) => {
				console.error('Error loading 3D model:', e)
			})
			.then((gltf) => {
				// A FAILED load must not announce a ready viewer. This `.then` is
				// chained AFTER the `.catch` above, so it runs on the rejection path too
				// — and `load()`'s own internal `.catch` already resolves it to
				// undefined. Publishing regardless drove component_3d.upload_handler
				// into create_posterframe with an empty scene, which is one of the two
				// routes to "uploaded a 3D file and got no posterframe". `gltf` is the
				// honest success signal: the loader resolves it only from its onLoad.
				if (!gltf) return

				// Use idle callback to avoid blocking the render thread while the scene
				// is still being initialised by Three.js.
				dd_request_idle_callback(
					() => {
						// publish event viewer is ready
						// `viewer_ready_<id>` is consumed by component_3d.upload_handler
						// to trigger posterframe generation immediately after an upload.
						event_manager.publish('viewer_ready_'+self.id, viewer_3d)

						// remove posterframe
						// Once the WebGL scene is live the placeholder image is no longer
						// needed — remove it to free memory and avoid layering artefacts.
						if (content_value.posterframe) {
							content_value.posterframe.remove()
						}
					}
				)
			});

		}else{

			// add fallback image
				// No file has been uploaded yet.  Show the global placeholder image and
				// wire a click handler that opens the upload tool directly.
				const posterframe_url = page_globals.fallback_image
				content_value.posterframe = ui.create_dom_element({
					element_type	: 'img',
					class_name		: 'posterframe',
					parent			: content_value
				})
				// load event. Set image background color
				const load_handler = function(e) {
					this.removeEventListener('load', load_handler, false)
					// if (content_value.posterframe.src!==page_globals.fallback_image) {
				// 	ui.set_background_image(this, content_value)
				// }
				}
				content_value.posterframe.addEventListener('load', load_handler, false)
				content_value.posterframe.src = posterframe_url

			// content_value
				// The 'link' class adds a pointer cursor, signalling to the operator that
				// clicking will open the upload tool rather than a viewer.
				content_value.classList.add('link')
				// mousedown event
				const mousedown_handler = (e) => {
					e.stopPropagation();

					// Locate the upload tool among the component's registered tools and
					// open it immediately via the common tool launcher.
					const tool_upload = self.tools.find(el => el.model==='tool_upload')
					// open_tool (tool_common)
					open_tool({
						tool_context	: tool_upload,
						caller			: self
					})
				}
				content_value.addEventListener('mousedown', mousedown_handler);
		}

		// quality_change_handler. Subscribe to quality change events to reload the 3D viewer
		// only when a viewer will actually be loaded (file_url is not null)
		// The `3d_quality_change_<id>` event is published by `get_quality_selector` in
		// render_edit_component_3d.js whenever the operator picks a different quality tier.
		// The event payload is the ready-to-use file URL for the new quality.
		if(file_url) {
			const quality_change_handler = async (file_url) => {

				if (!self.viewer) {
					// Guard: this subscription is registered only when file_url is set, so
					// self.viewer should always exist here.  Warn if invariant is broken.
					console.warn('Ignored quality_change_handler call. No self.viewer is set');
					return
				}

				try {
					// show loading state
					content_value.classList.add('loading')

					// reload the 3D model with the new quality URL
					await self.viewer.load(file_url)

					if(SHOW_DEBUG===true) {
						console.log('3d quality_change_handler loaded:', file_url);
					}
				} catch(error) {
					console.error('Error on quality_change_handler:', error)
				} finally {
					// hide loading state
					// Runs regardless of success or failure to ensure the spinner is removed.
					content_value.classList.remove('loading')
				}
			}
			// Token is pushed to events_tokens so common.destroy() can unsubscribe it.
			self.events_tokens.push(
				event_manager.subscribe('3d_quality_change_'+self.id, quality_change_handler)
			)
		}
	};

	// observe in viewport
	when_in_viewport(content_value, load_viewer);

	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a read-only (non-interactive) view of a 3-D entry.
*
* Used when `self.permissions === 1` (view-only access) or when the component is
* rendered in 'print' mode (forced by `render_edit_component_3d.prototype.edit`).
*
* No Three.js viewer is initialised here — the read-only path shows only the
* pre-generated posterframe image so the component is lightweight.  The 'print'
* view especially must not trigger WebGL since print previews run in a restricted
* context.
*
* Note: the `inner_html` of the container currently outputs a placeholder string
* like "Working in this view default", which indicates this path is still under
* development.
*
* @param {number} i - zero-based entry index (currently always 0)
* @param {Object|undefined} current_value - raw entry object from `self.data.entries[i]`;
*   may be undefined when the component has no uploaded file
* @param {Object} self - component_3d instance; must expose quality, data, context, view
* @returns {HTMLElement} content_value - read-only container; a `content_value.posterframe`
*   pointer is set if a posterframe image is created
*/
export const get_content_value_read = (i, current_value, self) => {

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value media_content_value read_only',
			inner_html		: 'Working in this view ' + render_value(self.view, 'text')
		})

	// posterframe
		const quality		= self.quality || self.context.features.quality
		const data			= self.data || {}
		const files_info	= current_value && current_value.files_info
			? current_value.files_info
			: []
		// Select the descriptor for the active quality tier, confirmed as present on disk.
		const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true)
		if(file_info) {
			// posterframe image
			// The server versions the URL by file mtime+size (?v=), so a re-uploaded image gets a new URL.
			const posterframe_url = data.posterframe_url
				? data.posterframe_url
				: page_globals.fallback_image
			content_value.posterframe = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'posterframe loading',
				parent			: content_value
			})
			// image background color
			// Derive a dominant background colour from the posterframe image for visual
			// consistency, unless it is the generic fallback placeholder.
			content_value.posterframe.addEventListener('load', set_bg_color, false)
			function set_bg_color() {
				this.removeEventListener('load', set_bg_color, false)
				if (content_value.posterframe.src!==page_globals.fallback_image) {
					ui.set_background_image(this, content_value)
				}
			}
			// set source URL
			content_value.posterframe.src = posterframe_url
		}


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the action toolbar for a component_3d in edit mode.
*
* Only called when `self.permissions > 1` (write access); read-only instances receive
* `null` instead of a buttons_container (see `view_default_edit_3d.render`).
*
* Button visibility is controlled by the `show_interface` object on the instance, which
* is derived from ontology properties and/or the request_config.  Each flag is checked
* independently:
*
*   show_interface.tools            — insert registered tool buttons via `ui.add_tools`
*   show_interface.button_fullscreen — append a "Full screen" toggle button
*
* The `buttons_fold` wrapper div is always created inside the container; it allows the
* browser to apply `position: sticky` to the toolbar on tall components so the buttons
* remain visible while the operator scrolls the 3-D scene.
*
* The commented-out `button_info` / `player_3d` block is dead code from an in-progress
* picture-in-picture player feature — left in place intentionally pending a design
* decision.
*
* @param {Object} self - component_3d instance; must expose show_interface, tools, node
* @returns {HTMLElement} buttons_container - the mounted toolbar element with tool and
*   fullscreen buttons appended according to show_interface flags
*/
export const get_buttons = (self) => {

	// short vars
		// show_interface: derived from ontology properties + request_config;
		// individual boolean flags gate each button type.
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// des
		// (!) Dead code — in-progress player-3d (picture-in-picture) feature.
		// Kept pending design decision; do not delete.
		// const button_info = ui.create_dom_element({
		// 	element_type	: 'span',
		// 	class_name 		: 'button full_screen',
		// 	parent 			: fragment
		// })
		// button_info.addEventListener("mouseup", async (e) =>{

		// 	const player_3d = await get_instance({
		// 		model 			: 'component_3d',
		// 		section_tipo	: self.section_tipo,
		// 		section_id		: self.section_id,
		// 		tipo			: self.tipo,
		// 		context			: {},
		// 		mode 			: 'player'
		// 	})

		// 	await player_3d.build(true)

		// 	player_3d.fragment = {tc_in: 3, tc_out: 5}

		// 	const node = await player_3d.render()

		// 	// container, for every ipo will create a li node
		// 		const container = ui.create_dom_element({
		// 			element_type	: 'div'
		// 		})

		// 		self.node[0].appendChild(node)
		// })

	// buttons tools
		// Renders a button for each entry in self.tools[] (e.g. tool_upload, tool_3d_info).
		// Which tools appear is controlled by the ontology and component configuration.
		if(show_interface.tools === true) {
			ui.add_tools(self, fragment)
		}

	// button_fullscreen
		// The full-screen button calls the browser Fullscreen API on self.node, putting
		// the entire component (viewer + controls) into an immersive presentation mode.
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
		// The buttons_fold wrapper enables CSS `position: sticky` on the toolbar so that
		// buttons stay visible when the 3-D viewer is taller than the viewport.
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
