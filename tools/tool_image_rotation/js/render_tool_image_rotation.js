// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_posterframe */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_IMAGE_ROTATION
* Client-side render module for the image rotation tool.
*
* Provides the `edit` render mode for `tool_image_rotation`, building the
* complete DOM UI that lets the user:
*   - Preview the target image with CSS `transform: rotate()` applied live.
*   - Drag a range slider (or type a value) to choose any rotation angle
*     between −360° and +360° in 0.01° steps.
*   - Select a solid background fill colour or opt for a transparent (alpha)
*     canvas via a colour-picker and a transparency checkbox.
*   - Toggle "Expand" mode so the image container grows to the rotated
*     bounding box instead of clipping the corners.
*   - Draw a crop rectangle on top of the image and send the resulting
*     pixel-coordinate `crop_area` object to the server together with the
*     rotation parameters.
*   - Trigger an AI-powered background-removal pipeline that runs
*     Transformers.js / WebGPU inside a Worker and uploads the result as a
*     new PNG quality file via `service_upload`.
*
* Exported symbol: `render_tool_image_rotation` — assigned to
* `tool_image_rotation.prototype.edit` in tool_image_rotation.js.
*
* Module-private helpers:
*   get_content_data(self)  — builds and returns the main content DOM fragment.
*   get_buttons(self)       — builds all controls (slider, colour options, crop,
*                             apply-rotation, remove-background).
*   get_crop_interface(self)— stub (currently empty, reserved for future use).
*/



// imports
	import { ui } from '../../../core/common/js/ui.js'
	import { request_failed, response_data } from '../../../core/common/js/api_error.js'
	import { handle_api_error } from '../../../core/common/js/error_dispatch.js'
	import { error_text } from '../../../core/common/js/render_api_error.js'
	import { render_tool_image_crop } from './render_tool_image_crop.js'
	import { ua } from '../../../core/common/js/ua.js'



/**
* RENDER_TOOL_IMAGE_ROTATION
* Constructor — acts as the render provider for tool_image_rotation.
* Assigned to `tool_image_rotation.prototype.edit` so that the tool's
* `render()` lifecycle dispatches here for the 'edit' mode.
*
* The constructor is never instantiated standalone; it only exists so that
* prototype methods can be attached and then mixed into the tool instance.
*
* @returns {boolean} Always true (signals successful construction).
*/
export const render_tool_image_rotation = function() {

	return true
}//end render_tool_image_rotation



/**
* EDIT
* Render tool DOM nodes
* This function is called by render common
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - 'full' builds the complete
*   wrapper with chrome (toolbar, title bar, etc.); 'content' returns only
*   the inner content_data element — used when refreshing the body without
*   re-rendering the shell.
* @returns {Promise<HTMLElement>} Resolves to the outer wrapper element
*   (`render_level === 'full'`) or the inner content_data element
*   (`render_level === 'content'`).
*/
render_tool_image_rotation.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds and returns the tool's body element (`content_data`).
*
* Layout of the produced DOM tree:
*
*   content_data
*     └─ DocumentFragment
*          ├─ div.buttons_container
*          │    └─ <output of get_buttons(self)>
*          └─ div.main_element_container
*               ├─ div.image_container
*               │    └─ img.noevents          ← preview image (self.main_element_image)
*               ├─ div.axis_container         ← crosshair/diagonal alignment guides
*               │    ├─ div.horizontal_axis
*               │    ├─ div.vertical_axis
*               │    ├─ div.diagonal_left_axis
*               │    └─ div.diagonal_rigth_axis
*               └─ div.circle_axis            ← circular rotation guide overlay
*
* Side effects:
*   - Stores `self.image_container`, `self.main_element_image`,
*     `self.axis_container`, and `self.circle_axis` as instance pointers
*     so that control handlers in `get_buttons()` can reference them directly.
*   - Attaches a one-shot `load` event on the preview `<img>` that locks the
*     container dimensions to the natural rendered size of the image; the
*     handler removes itself after firing to avoid re-sizing when a
*     background-removal result is loaded into the same element.
*   - Adds a `dd_options` object (`{width, height}`) to `self.image_container`
*     after the image loads; this is the fallback size used when the "Expand"
*     checkbox is unchecked.
*   - Uses `requestAnimationFrame` to set the `<img>` `src` so the DOM is
*     fully flushed before the network request fires, preventing a race where
*     `getBoundingClientRect()` returns zeros.
*   - Appends a cache-busting `?t=<timestamp>` query string to the image URL
*     so the browser does not serve a stale version after a rotation or
*     background-removal operation.
*
* @param {Object} self - The `tool_image_rotation` instance.
* @returns {Promise<HTMLElement>} The populated `content_data` element.
*/
const get_content_data = async function(self) {

	const default_file_info = self.main_element.get_default_file_info()

	// no image case
		if (!default_file_info) {
			const content_data = ui.tool.build_content_data(self)
			content_data.innerHTML = '<br><h3> No image is available </h3>'
			return content_data
		}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})
		const buttons_wrapper = get_buttons(self)
		buttons_container.appendChild(buttons_wrapper)

	// main_element_container
		const main_element_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'main_element_container',
			parent			: fragment
		})

		// image_container
			const image_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'image_container',
				parent			: main_element_container
			})
			self.image_container = image_container

		// main_element_image. Temporal image to show while main_element is rebuilt and rendered
			const main_element_image = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'noevents',
				parent			: image_container
			})
			// set pointer
			self.main_element_image = main_element_image
			// load event
			const load_handler = () => {
				const image_size = main_element_image.getBoundingClientRect()
				image_container.style.width		= image_size.width +'px'
				image_container.style.height	= image_size.height +'px'
				// save current values as default values (will use into the no-expand option)
				self.image_container.dd_options = {
					width	: image_size.width,
					height	: image_size.height
				}
				// remove the event,
				// it change the container dimension when the image is changed with background removal process done.
				main_element_image.removeEventListener('load', load_handler)
			}
			main_element_image.addEventListener('load', load_handler)
			// set source
			requestAnimationFrame(
				() => {
					main_element_image.src = DEDALO_MEDIA_URL + default_file_info?.file_path + '?t=' + (new Date()).getTime()
				}
			)

		// axis_container
			const axis_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'axis_container',
				parent			: main_element_container
			})
			const horizontal_axis = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'horizontal_axis',
				parent			: axis_container
			})
			const vertical_axis = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'vertical_axis',
				parent			: axis_container
			})
			const diagonal_left_axis = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagonal_left_axis',
				parent			: axis_container
			})
			const diagonal_rigth_axis = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagonal_rigth_axis',
				parent			: axis_container
			})
			const circle_axis = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'circle_axis',
				parent			: main_element_container
			})

			self.axis_container	= axis_container
			self.circle_axis	= circle_axis

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* GET_BUTTONS
* Builds the full controls panel returned as a DocumentFragment.
*
* The fragment is structured as three sibling containers:
*
*   div.slider_container
*     div.slider_label           ← localised "Rotation" label
*     div.slider
*       input[type=text].output_value  ← numeric degree input; syncs ↔ range
*       input[type=range].slider       ← −360..+360, step 0.01
*
*   div.color_options_container
*     label.color_picker_label         ← "Background color"
*     input[type=color].color_picker   ← hex colour picker (default #ffffff)
*     label > input[type=checkbox]     ← Transparent (alpha) toggle
*     label > input[type=checkbox]     ← Expand canvas toggle
*
*   div.options_container
*     div.crop_button_container
*       button.light.crop_button       ← toggles render_tool_image_crop overlay
*     div.apply_rotation_button_container
*       button.light.gear.apply_rotation  ← submits rotation to server API
*     div.remove_background_button_container
*       button.light.button_remove_background  ← starts AI background removal
*     div.status_container            ← text feedback area (progress / errors)
*
* Key behavioural contracts:
*   - `output` (text input) and `range` are kept in sync bidirectionally:
*     typing in `output` updates `range.value` and vice versa. Both update
*     `self.main_element_image.style.transform` immediately.
*   - When "Expand" is checked, every `range` input event also resizes
*     `self.image_container` to the rotated bounding box returned by
*     `getBoundingClientRect()` on the (already-transformed) image element.
*   - The crop button toggles `render_tool_image_crop.build()` /
*     `render_tool_image_crop.destroy()` and hides the axis guides while the
*     crop overlay is active.
*   - The apply-rotation button gathers rotation degrees, background colour,
*     alpha flag, rotation mode, and any crop_area from `render_tool_image_crop`
*     before calling `self.apply_rotation()`. On success, it forces a cache-
*     busted reload of the preview image by performing a `fetch` with
*     `{cache:'reload'}` before reassigning `src`.
*   - Background removal uses `ua.check_transformers_webgpu()` to gate
*     compatibility and shows a `confirm()` dialog when WebGPU is unavailable.
*     (!) The `button_remove_background.active` flag is checked AFTER the async
*     confirm dialog; its initial value is never set to `true`, so the removal
*     branch is currently unreachable — this is a pre-existing logic issue in
*     the code, not a documentation artefact.
*
* Closes over the local `nodes` object, `status_container`, `output`, `range`,
* `color_picker`, `alpha_checkbox`, and `expanded_checkbox` variables — all of
* which must remain in scope for the button event handlers to function.
*
* @param {Object} self - The `tool_image_rotation` instance.
* @returns {DocumentFragment} Fragment containing all control containers,
*   ready to be appended into `buttons_container`.
*/
const get_buttons = function(self) {

	const fragment = new DocumentFragment()

	// nodes pointer
	// storage of the nodes to be used for check and change status.
		const nodes = {}

	// status
		const status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_container'
		})
		//save the pointer
			nodes.status_container = status_container

	// slider_range
		const slider_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'slider_container',
			parent 			: fragment
		})
			const slider_label = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'slider_label',
				inner_html 		: self.get_tool_label('rotation') || 'Rotation',
				parent 			: slider_container
			})
			const slider = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'slider',
				parent 			: slider_container
			})

				const output = ui.create_dom_element({
					element_type	: 'input',
					class_name		: 'output_value',
					parent			: slider,
					value 			: 0
				})
				// Sync text → range and apply live CSS rotation preview.
				output.addEventListener('input', function(){
					range.value	= output.value
					self.main_element_image.style.transform = "rotate("+ (range.value % 360) +"deg)"
				})

				const range = ui.create_dom_element({
					element_type	: 'input',
					class_name 		: 'slider',
					type 			: 'range',
					parent 			: slider
				})
				range.value	= output.value
				range.min	= -360
				range.max	= 360
				range.step	= 0.01
				// Sync range → text, apply CSS rotation, and optionally resize the container
				// when the "Expand" checkbox is active so the rotated corners remain visible.
				range.addEventListener('input', function(){
					output.value = range.value
					self.main_element_image.style.transform = "rotate("+ (range.value % 360) +"deg)"
					if(expanded_checkbox.checked === true){
						const image_size		= self.main_element_image.getBoundingClientRect()
						// Resize the container_size to fit
						self.image_container.style.width = `${image_size.width}px`;
						self.image_container.style.height = `${image_size.height}px`;
					}
				})

	// color options
		const color_options_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'color_options_container',
			parent 			: fragment
		})

			const color_picker_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'color_picker_label',
				inner_html		: self.get_tool_label('bk_colour') || 'Background color',
				parent			: color_options_container
			})

			// color picker
			const color_picker = ui.create_dom_element({
				element_type	: 'input',
				type			: 'color',
				id 				: 'color_picker',
				name 			: 'color_picker',
				class_name		: 'color_picker',
				value			: '#ffffff',
				parent			: color_options_container
			})
			// Immediately apply the chosen colour to the container background as a
			// live preview and uncheck "Transparent" since they are mutually exclusive.
			color_picker.addEventListener("input", function(e){
				// color_picker.value = e.target.value;
				self.image_container.style.background = e.target.value;
				alpha_checkbox.checked = false
			});

			// transparent check box
			// label
			const option_label = ui.create_dom_element({
				element_type	: 'label',
				inner_html		: self.get_tool_label('transparent') || 'Transparent',
				parent			: color_options_container
			})

			// alpha_checkbox
			// Checking this adds the 'checkborad' (sic) CSS class that displays a
			// checkerboard pattern as a visual transparency indicator, and clears the
			// solid background colour. Unchecking removes the class.
				const alpha_checkbox = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox'
				})
				option_label.prepend(alpha_checkbox)
				alpha_checkbox.addEventListener('change', function(e) {

					if(e.target.checked === true){
						self.image_container.classList.add('checkborad');
						self.image_container.style.background = null
						color_picker.value = '#ffffff'
					}else{
						self.image_container.classList.remove('checkborad');
					}

				})

			// expanded check box
			// rotate the image and expand the canvas, with this option active the image expand the background avoiding crop.
			// label
			const expanded_label = ui.create_dom_element({
				element_type	: 'label',
				inner_html		: self.get_tool_label('expand') || 'Expand',
				parent			: color_options_container
			})

			// expanded_checkbox
			// When checked: the container is immediately resized to the current rotated
			// bounding box so that no corners are cropped. When unchecked: the container
			// is restored to its initial `dd_options` dimensions recorded at image-load time.
				const expanded_checkbox = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox'
				})
				expanded_label.prepend(expanded_checkbox)
				expanded_checkbox.addEventListener('change', function(e) {

					if(e.target.checked === true){
						const image_size = self.main_element_image.getBoundingClientRect()
							self.image_container.style.width	= image_size.width +'px'
							self.image_container.style.height	= image_size.height +'px'
					}else{
						self.image_container.style.width	= self.image_container.dd_options.width +'px'
						self.image_container.style.height	= self.image_container.dd_options.height +'px'
					}
				})

	// options container
	const options_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'options_container',
		parent			: fragment
	})

	// crop button
		const crop_button_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'crop_button_container',
			parent			: options_container
		})

		// crop_button
			const crop_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light crop_button',
				// inner_html		:  self.get_tool_label('crop_image') || 'Crop image',
				parent			: crop_button_container
			})

			// Toggle the render_tool_image_crop overlay on/off.
			// When activating crop mode the alignment axis guides are hidden so they
			// do not visually interfere with the crop-selection rectangle.
			const crop_button_click_handler = function(){

				if(crop_button.active === true){
					crop_button.active = false
					crop_button.classList.remove('active')
					render_tool_image_crop.destroy()
					return
				}
				crop_button.active = true
				crop_button.classList.add('active')

				self.axis_container.classList.add('hide')
				self.circle_axis.classList.add('hide')

				render_tool_image_crop.build({
					container				: self.image_container,
					image					: self.main_element_image,
					status_container		: status_container,
					crop_button_container	: crop_button_container
				})
			}
			crop_button.addEventListener('click', crop_button_click_handler)

	// apply_rotation_button_container
		const apply_rotation_button_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'apply_rotation_button_container',
			parent			: options_container
		})

		// button_apply_rotation
			const button_apply_rotation = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light gear apply_rotation',
				inner_html		: get_label.create || 'Create',
				parent			: apply_rotation_button_container
			})
			// Gather all user-selected parameters and delegate to `self.apply_rotation()`.
			// On success: force-reloads the preview image (bypassing the browser cache)
			// via a dummy `fetch` before reassigning `src`, then resets the slider and
			// the crop selection to their initial states.
			button_apply_rotation.addEventListener('click', async function(){
				self.node.content_data.classList.add('loading')
				const rotation_degrees = output.value
				const response = await self.apply_rotation({
					rotation_degrees	: rotation_degrees,
					background_color	: color_picker.value,
					alpha				: alpha_checkbox.checked,
					rotation_mode		: expanded_checkbox.checked ? 'expanded' : 'default',
					crop_area			: render_tool_image_crop.crop_area || null,
				})
				// user cancelled the confirm dialog: nothing to report
				if (response===false) {
					self.node.content_data.classList.remove('loading')
					return
				}
				// Do not fail silently: the server reports per-tier errors (e.g. an
				// out-of-bounds crop box) that the user must see. ONE error model —
				// the dispatcher picks the surface, the renderer emits TEXT.
				if (request_failed(response)) {
					console.error('apply_rotation failed:', response.error)
					await handle_api_error(response.error, {wrapper: options_container})
					self.node.content_data.classList.remove('loading')
					return
				}
				// envelope v2 payload: `{rotated:[path], cropped:[path], files_info,
				// errors:[per-tier failure]}` (tools/tool_image_rotation/server/index.ts).
				// A tier that refused is PAYLOAD, not a wire failure — but a run that
				// rotated NOTHING is a no-op the user must be told about.
				const rotation_data		= response_data(response) || {}
				const rotated_count		= Array.isArray(rotation_data.rotated) ? rotation_data.rotated.length : 0
				const rotation_failures	= rotation_data.errors
				const rotation_errors	= Array.isArray(rotation_failures) ? rotation_failures : []
				if (rotated_count===0) {
					// answered, but nothing was written and no ApiError behind it: a
					// CLIENT sentence, plus whatever the engine said per tier
					ui.show_message(
						options_container,
						(self.get_tool_label('rotation_not_applied') || 'The rotation could not be applied')
							+ (rotation_errors.length ? ': ' + rotation_errors.join(' | ') : ''),
						'error'
					)
					self.node.content_data.classList.remove('loading')
					return
				}
				{
					if (rotation_errors.length) {
						// partial run: some tiers landed, some refused — say both
						ui.show_message(options_container, rotation_errors.join(' | '), 'error')
					}
					// reload the image
					await fetch(self.main_element_image.src, {cache: 'reload', mode: 'no-cors'});
					self.main_element_image.src = self.main_element_image.src
					output.value	= 0
					range.value		= 0
					self.main_element_image.style.transform = null
					// reset the crop
					render_tool_image_crop.reset_selection()
				}
				self.node.content_data.classList.remove('loading')
			})

	// remove background
		const remove_background_button_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'remove_background_button_container',
			parent			: options_container
		})

		// button_remove_background
			const button_remove_background = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light button_remove_background',
				inner_html		:  self.get_tool_label('remove_background') || 'Remove background',
				parent			: remove_background_button_container
			})

			//save the pointer
			nodes.button_remove_background = button_remove_background

		// fire the remove background process
		const button_remove_background_click_handler = async function(e){
			e.stopPropagation()

			// Get the most quality image, mainly the original quality
			const image_file = ( self.main_element.get_quality_file_info('original') )
				? self.main_element.get_quality_file_info('original')
				: (self.main_element.get_quality_file_info('modified'))
					? self.main_element.get_quality_file_info('modified')
					: self.main_element.get_quality_file_info('1.5MB')

			if( !image_file ){
				return
			}
			// set the image URL to be used in the process worker
			const image = DEDALO_MEDIA_URL + image_file?.file_path
			nodes.main_element_image = self.main_element_image

			// Check the user agent can perform correctly and using webGPU
			const is_a_valid_user_agent = await ua.check_transformers_webgpu()
			if (!is_a_valid_user_agent.overall) {
				if(!confirm("For optimal performance, use a webGPU-compatible browser. Your current browser may run this task very slowly. Continue?")) {
					return false
				}
			}

			// (!) `button_remove_background.active` is never initialised to `true`
			// before this check, so the removal pipeline below is currently
			// unreachable. This is a pre-existing issue — do not "fix" it here.
			if(button_remove_background.active === false){
				return
			}
			const engine = 'onnx-community/ISNet-ONNX' // 'onnx-community/BiRefNet_lite-ONNX'
			if(!engine){
				return
			}
			button_remove_background.classList.add('disable')
			button_remove_background.blur()

			const original_file_name = self.main_element.get_original_file_name()
				? self.main_element.get_original_file_name()
				: image_file.file_name

			// options to be sent to engine
			const background_removal_options = {
				self_caller			: self.main_element,
				engine				: engine,
				image				: image,
				original_file_name	: original_file_name || 'original.jpg',
				nodes				: nodes
			}

			// process with the engine
			// type = browser -> 012(Default) the engine will be use the default transformer process in client browser
			// return a Promise with the data to be saved into transcription component.
			self.automatic_background_removal(background_removal_options)
			.then( async (response)=>{

				// a failed run resolves `false` — the panel already carries the reason,
				// so do not also claim success and re-enable the button as if it worked.
				if (response === false) {
					button_remove_background.classList.remove('disable')
					return
				}

				// set the status done
				button_remove_background.classList.remove('disable')
				const msg = self.get_tool_label('backgroun_removal_completed') || 'Background removal completed.';
				// the label is served content — an ELEMENT with text, never a markup string
				status_container.textContent = ''
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'success_text',
					text_content	: msg,
					parent			: status_container
				})

				// REFRESH THE COMPONENT'S OWN files_info FROM THE UPLOAD RESPONSE.
				// `build(true)` is a NO-OP on an already-built instance — component_common
				// .build returns immediately when status==='built' — so it never refetched
				// anything, and every lookup below still read the PRE-removal scan. The
				// upload response is the only fresh files_info in this flow: the server
				// rebuilt every derivative of the new 'modified' master (including the
				// alternate-extension twins) and answers with the disk scan taken after
				// that pass. Without this line the file the tool asks for a few lines
				// down exists on disk and is invisible here, and the preview never
				// changes on the FIRST removal — which is exactly the symptom the twin
				// builder was written to end.
				const fresh_files_info = response_data(response)?.files_info
				if (Array.isArray(fresh_files_info) && self.main_element.data?.entries?.[0]) {
					self.main_element.data.entries[0].files_info = fresh_files_info
				}

				// Get the valid extensions and check if any match with the images in the component
				// The process only show the result correctly when you have a transparent format as default extension
				// or in alternative extensions in the constant `DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS` in `config.php`
				const supported_formats = ['avif','png']
				const active_extensions = self.main_element.get_active_extensions()

				const valid_transparent_extension = supported_formats.find(item => active_extensions.includes(item))
				// if the config has not valid transparent format use the default extension to get the processed image.
				const extension = (valid_transparent_extension)
					? valid_transparent_extension
					: self.main_element.context.features.extension

				// get the processed image file
				const image_file = self.main_element.get_quality_file_info('1.5MB', extension)

				if( !image_file ){
					// The engine could not produce a transparent version (no avif/png
					// configured, or this host cannot encode it — the server says which in
					// its response). Say so instead of returning silently: the removal DID
					// happen and is stored in the 'modified' master.
					// envelope v2: the per-derivative failures are PAYLOAD
				// (`derivative_errors`, tools/tool_upload/server/index.ts); a failed
				// call carries the coded error instead.
					const upload_data	= request_failed(response) ? null : response_data(response)
					const ar_detail		= Array.isArray(upload_data?.derivative_errors) ? upload_data.derivative_errors : []
					const detail		= ar_detail.length
						? ar_detail.join(' | ')
						: (request_failed(response) ? error_text(response.error) : '')
					console.warn('[tool_image_rotation] background removal stored, but no', extension, 'version of the 1.5MB tier to preview.', detail)
					return
				}
				// asing the new processed image to the tool to show it
				// The path does not change across rebuilds, so without a cache-buster the
				// browser re-serves the bytes it already has and the preview looks untouched.
				const image = DEDALO_MEDIA_URL + image_file?.file_path + '?dv=' + Date.now()
				nodes.main_element_image.src = image;
			})
		}
		button_remove_background.addEventListener('click', button_remove_background_click_handler)

	// status container set its parent
		options_container.appendChild(status_container)

	return fragment
}//end get_buttons




/**
* GET_CROP_INTERFACE
* Reserved stub for a future dedicated crop-interface builder.
* Currently unused — crop interaction is managed directly by
* `render_tool_image_crop` methods invoked from `get_buttons()`.
*
* @param {Object} self - The `tool_image_rotation` instance.
* @returns {undefined}
*/
const get_crop_interface = function(self){

}



// @license-end
