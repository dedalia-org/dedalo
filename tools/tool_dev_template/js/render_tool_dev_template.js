// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_dummy */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
// import ui to create DOM nodes and common HTML structures as wrappers or content_data compatible with the all Dédalo
	import {ui} from '../../../core/common/js/ui.js'
	import {pause} from '../../../core/common/js/utils/index.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {response_data} from '../../../core/common/js/api_error.js'



/**
* RENDER_TOOL_DEV_TEMPLATE
* Client-side render module for the tool_dev_template development scaffold.
*
* This module is the canonical starting point when creating the render layer of a
* new Dédalo v7 tool.  It demonstrates the three main interaction patterns that a
* tool render module typically needs:
*
*  1. Displaying a component inside the tool body (self.main_element, rendered via
*     the standard component render pipeline).
*  2. Fetching data from the server and reflecting it in the DOM (test_button 1 & 2,
*     ui.load_item_with_spinner, self.get_some_data_from_server).
*  3. Uploading files — generic variant via service_upload (test_button3) and the
*     image-resource variant via open_tool(tool_upload) (test_button4).
*
* Architectural note:
*  `render_tool_dev_template` is a constructor-as-namespace.  The single prototype
*  method `edit` is mixed into the `tool_dev_template` class via `wire_tool()` in
*  tool_dev_template.js.  The module-private `get_content_data` helper builds the
*  actual DOM tree so that the public `edit` entry point stays thin.
*
* Globals expected at runtime (declared in the /*global*\/ directive above):
*  - DD_TIPOS      — ontology tipo constants map (e.g. DD_TIPOS.DEDALO_SECTION_RESOURCES_IMAGE_TIPO)
*  - DEDALO_MEDIA_URL — base URL for constructed media file URLs
*
* (!) DD_TIPOS and DEDALO_MEDIA_URL are NOT listed in the /*global*\/ directive at the
*     top of this file, which will cause ESLint no-undef warnings on the four
*     call-sites inside test_button4's click handler.  This is a pre-existing
*     oversight in the scaffold; do not add runtime stubs or suppress the lint here —
*     a real tool should declare them or import them from the appropriate module.
*
* @module render_tool_dev_template
*/
export const render_tool_dev_template = function() {

	return true
}//end render_tool_dev_template



/**
* EDIT
* Render tool DOM nodes
* This function is wired onto the tool prototype by wire_tool() in 'tool_dev_template.js'
*
* Entry point for the edit-mode render pipeline.  Delegates body construction to
* the module-private `get_content_data` helper and then wraps the result in a
* standard tool shell built by `ui.tool.build_wrapper_edit`.
*
* When `options.render_level === 'content'`, only the inner content_data node is
* returned (used for partial refreshes without re-building the outer chrome).
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' returns the full wrapper;
*   'content' returns only the inner content_data node (partial refresh path)
* @returns {Promise<HTMLElement>} wrapper element (full) or content_data node (content)
*/
render_tool_dev_template.prototype.edit = async function(options) {

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


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Render tool body or 'content_data'
*
* Builds the complete inner DOM tree of the tool and returns it wrapped in the
* standard content_data container created by `ui.tool.build_content_data`.
*
* Layout produced (top to bottom):
*  1. info_container     — static descriptive text pointing developers to the docs.
*  2. components_container / main_component_container — renders `self.main_element`
*     (the component identified by `role: 'main_element'` in the ddo_map) into the
*     DOM.  The render call is non-blocking (`.then`); the component node is appended
*     whenever the promise resolves.
*  3. footer_buttons_container — four demo buttons (see below).
*  4. value_container    — display area shared by all four button callbacks.
*
* Demo buttons:
*  - test_button  : reads self.main_element.data.value from the in-memory instance
*    and displays it as pretty-printed JSON via ui.load_item_with_spinner.
*  - test_button2 : calls self.get_some_data_from_server() (routes to the
*    server module's 'read_demo' action) and displays the result.
*  - test_button3 : spawns a generic service_upload widget, subscribes to the
*    'upload_file_done_' + self.id event, then calls self.file_upload_handler on
*    completion and tears down the service instance.
*  - test_button4 : creates a fresh resource-image section via data_manager,
*    instantiates a component_image on that section, finds its tool_upload context,
*    opens it in a modal via open_tool(), and handles the
*    'process_uploaded_file_done_' event to display the resulting files_info.
*
* (!) value_container is referenced inside the four button click handlers that are
*     registered before the variable is declared in the code below.  This works
*     because closures capture the binding, not the value at registration time; the
*     handlers are only invoked after the async function has fully returned and the
*     user actually clicks — by then value_container is fully initialised.  A future
*     refactor may wish to reorder the declaration for clarity.
*
* @param {Object} self - The tool_dev_template instance (provides self.main_element,
*   self.id, self.get_tool_label, self.get_some_data_from_server,
*   self.file_upload_handler)
* @returns {Promise<HTMLElement>} content_data wrapper node ready to be inserted into the DOM
*/
const get_content_data = async function(self) {

	const fragment = new DocumentFragment()

	// info_container
		const info_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'info_container',
			inner_html 		: `This sample tool is only to be used as a basis or reference for creating new tools..<br>
							   To see more complete information about how to create tools see the http://dedalo.dev documentation about tools`,
			parent 			: fragment
		})

	// components_container
		const components_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'components_container',
			parent 			: fragment
		})

	// source component
		const main_component_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'main_component_container',
			parent			: components_container
		})
		// Render self.main_element and append its node once ready.
		// The .then is intentionally non-awaited so the rest of the DOM builds
		// without blocking on the component render pipeline.
		self.main_element.render()
		.then(function(component_node){
			main_component_container.appendChild(component_node)
		})

	// footer_buttons_container
		const footer_buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'footer_buttons_container',
			parent			: fragment
		})

	// test_button 1
	// Reads the current in-memory value of self.main_element and renders it as
	// pretty-printed JSON inside value_container using a spinner while "loading".
	// The 700 ms pause is artificial — replace with real async work in a real tool.
		const test_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary',
			inner_html		: self.get_tool_label('my_first_label') || 'Hello button without label 1',
			parent			: footer_buttons_container
		})
		test_button.addEventListener('click', function(e) {
			e.stopPropagation()

			const node = ui.load_item_with_spinner({
				container			: value_container,
				preserve_content	: false,
				label				: 'component local value',
				callback			: async () => {

					await pause(700) // fake process wait

					// record data serialised into a <pre>: TEXT only (DS-1)
					const value_node = ui.create_dom_element({
						element_type	: 'pre',
						class_name		: '',
						text_content	: JSON.stringify(self.main_element.data.value, null, 2)
					})
					return value_node
				}
			})//end ui.load_item_with_spinner
		})

	// test_button 2
	// Calls the server-side get_component_data action via self.get_some_data_from_server
	// and displays the JSON result.  The 500 ms pause is artificial.
		const test_button2 = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary',
			inner_html		: self.get_tool_label('my_second_label') || 'Hello button without label 2',
			parent			: footer_buttons_container
		})
		test_button2.addEventListener('click', function(e) {
			e.stopPropagation()

			const node = ui.load_item_with_spinner({
				container			: value_container,
				preserve_content	: false,
				label				: 'value from server',
				callback			: async () => {

					await pause(500) // fake process wait

					const response = await self.get_some_data_from_server()

					// server payload serialised into a <pre>: TEXT only (DS-1)
					const value_node = ui.create_dom_element({
						element_type	: 'pre',
						class_name		: '',
						text_content	: JSON.stringify(response_data(response), null, 2)
					})
					return value_node
				}
			})//end ui.load_item_with_spinner
		})


	// test_button3 upload_file (generic)
	// Demonstrates the generic file-upload flow using service_upload:
	//  1. Instantiates and renders a service_upload widget (allowed: zip, kml).
	//  2. Subscribes to the 'upload_file_done_' + self.id event that service_upload
	//     fires once the file transfer is complete.
	//  3. In the handler: calls self.file_upload_handler (server action: write_demo),
	//     destroys the service_upload widget, and shows a confirmation message.
		const test_button3 = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary',
			inner_html		: self.get_tool_label('upload_file') || 'Upload generic file',
			parent			: footer_buttons_container
		})
		test_button3.addEventListener('click', function(e) {
			e.stopPropagation()

			const node = ui.load_item_with_spinner({
				container			: value_container,
				preserve_content	: false,
				label				: 'service upload',
				callback			: async () => {

					await pause(300) // fake process wait

					const service_upload = await get_instance({
						id_variant			: 'generic_upload_file', // prevent id collisions
						model				: 'service_upload',
						allowed_extensions	: ['zip','kml'],
						mode				: 'edit',
						caller				: self
					})
					await service_upload.build()
					const service_upload_node = await service_upload.render()

					// event upload_file_done_
					// service_upload fires this event with a response object containing
					// file_data (name, key_dir, tmp_name, etc.) once the upload succeeds.
					event_manager.subscribe('upload_file_done_' + self.id, fn_upload_done)
					async function fn_upload_done(response) {
						// handle the result
						await self.file_upload_handler(response)
						// remove service
						await service_upload.destroy(true, true, true)
						// add info. The file NAME is user data: TEXT only (DS-1)
						value_container.replaceChildren(
							document.createTextNode('File "'+response.file_data.name+'" uploaded successfully. Processing file.. please wait')
						)
					}

					return service_upload_node
				}
			})//end ui.load_item_with_spinner
		})

	// test_button4 upload_file (image)
	// Demonstrates the image-resource upload flow using tool_upload (a dedicated
	// upload tool that handles media encoding/conversion):
	//  1. Creates a fresh rsc section (section_resources_image_tipo) via data_manager
	//     create action so there is a real section_id to attach the image to.
	//  2. Instantiates a component_image on that section as the upload context.
	//  3. Locates the tool_upload tool in the component's tools array and opens it
	//     as a modal via open_tool().
	//  4. Subscribes to 'process_uploaded_file_done_' + tool.id; when fired:
	//     closes the modal, rebuilds component_image to reload DDBB data, reads
	//     files_info from the updated component data, and renders image previews.
	//
	// (!) DD_TIPOS and DEDALO_MEDIA_URL are referenced below but not declared in
	//     the /*global*\/ directive at the top of this file.  This causes ESLint
	//     no-undef warnings and will throw at runtime if those globals are absent.
	//     A real tool must either import these constants or declare them globally.
		const test_button4 = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary',
			inner_html		: self.get_tool_label('upload_image_file') || 'Update image file',
			parent			: footer_buttons_container
		})
		test_button4.addEventListener('click', function(e) {
			e.stopPropagation()

			const node = ui.load_item_with_spinner({
				container			: value_container,
				preserve_content	: false,
				label				: 'service upload',
				callback			: async () => {

					console.log('self:', self);

					await pause(300) // fake process wait

					const section_resources_image_tipo	 = DD_TIPOS.DEDALO_SECTION_RESOURCES_IMAGE_TIPO // 'rsc170';
					const component_resources_image_tipo = DD_TIPOS.DEDALO_COMPONENT_RESOURCES_IMAGE_TIPO // 'rsc29';

					// data_manager. create
					// Creates a new resource-image section record so we have a real
					// section_id before instantiating the component_image.
					const rqo = {
						action	: 'create',
						source	: {
							section_tipo : section_resources_image_tipo
						}
					}
					const api_response = await data_manager.request({
						body : rqo
					})
					// `create` answers with the new section_id as the payload
					const new_section_id = response_data(api_response)
					if (new_section_id && new_section_id>0) {

						const section_id = new_section_id

						// resource component used as tool_upload caller
						// It is necessary because he knows the proper tool context
						// The component_image instance holds the ddo_map that tool_upload
						// needs to resolve the correct upload target and encoding config.
							const component_image = await get_instance({
								model			: 'component_image',
								tipo			: component_resources_image_tipo,
								section_tipo	: section_resources_image_tipo,
								section_id		: section_id,
								mode			: 'edit',
								caller			: self
							})
							await component_image.build(true);

						// tool context. Get the upload tool context to be fired
						// component_image.tools is populated during build() from the
						// component's ddo_map; find the tool_upload entry by model name.
							const tool_upload = component_image.tools.find(el => el.model === 'tool_upload')

						// open_tool, it will be the interface to upload data in new window.
						// open_as:'modal' renders the tool in an overlay dialog rather than
						// a separate browser window.
							const tool = await open_tool({
								tool_context	: tool_upload,
								open_as			: 'modal',
								caller			: component_image
							})

						// event process_uploaded_file_done_
						// tool_upload fires this event after the server finishes processing
						// (encoding, thumbnail generation, etc.) — not just after the raw
						// HTTP transfer completes.  api_response here is the server result object.
							const fn_process_done = async function(api_response) {

								// close modal. This action also destroys the tool
									if (tool.node && tool.node.modal) {
										tool.node.modal.close()
									}

								// add info
									value_container.innerHTML = 'File uploaded and processed successfully.'

								// available files
									// build component again to force read DDBB updated data
									await component_image.build(true);
									const data	= component_image.data || {}
									const value	= data.value || []
									// files_info is an array of file descriptors produced by the
									// image processor; each entry contains extension, quality, file_path, etc.
									const files_info = value[0]
										? value[0].files_info
										: null

									if (files_info) {
										// display available files list
										// (!) Note that if this install's config defines
										// DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS, other formats
										// than default JPG will be available to use (like PNG, AVIF ...)
										// @see DOCU https://dedalo.dev/docs/v7/administration/configuration/config/#image
										ui.create_dom_element({
											element_type	: 'pre',
											class_name		: '',
											text_content	: JSON.stringify(files_info, null, 2),
											parent			: value_container
										})

										// preview all available images
										// Iterates files_info to build one <img> + metadata <pre> per variant.
										// DEDALO_MEDIA_URL is the CDN/media-server base URL configured at install time.
											const files_info_length = files_info.length
											for (let k = 0; k < files_info_length; k++) {
												const url = DEDALO_MEDIA_URL + files_info[k].file_path
												ui.create_dom_element({
													element_type	: 'img',
													src				: url,
													title			: files_info[k].extension + ' ' + files_info[k].quality,
													parent			: value_container
												})
												ui.create_dom_element({
													element_type	: 'pre',
													class_name		: '',
													text_content	: JSON.stringify(files_info[k], null, 2),
													parent			: value_container
												})
											}
									}else{
										console.error('Failed to read files info from component data:', data);
									}
							}
							event_manager.subscribe('process_uploaded_file_done_' + tool.id, fn_process_done)
					}

					return null
				}
			})//end ui.load_item_with_spinner
		})



	// value_container
	// Shared output area rendered at the bottom of the tool body.
	// All four button callbacks write their results here (replacing previous content).
		const value_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value_container',
			parent			: fragment
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* ADD_COMPONENT_SAMPLE
* Exported helper that loads and renders a language-specific component instance
* into a given container node.
*
* Intended use: a language-selector widget (e.g. a `<select>`) passes the chosen
* `lang` value to this function on change.  When the user selects a blank/null lang
* the container is cleared and the function returns `false` immediately.
*
* When a valid lang is supplied:
*  1. Calls `self.load_component_sample({ lang, ddo })` to fetch context + data
*     from the server and produce a live component instance.
*  2. Renders the instance into a DOM node.
*  3. Clears the container and appends the new node.
*
* (!) The call `self.load_component_sample({ lang: self, ddo: self.main_element })`
*     passes `self` (the tool instance) as the `lang` argument instead of the `lang`
*     parameter received by this function.  This is a pre-existing bug in the
*     scaffold template — do not "fix" it here; document only.
*
* @param {Object} self - The tool_dev_template instance
* @param {HTMLElement} component_container - DOM node that will hold the rendered component
* @param {string|null} lang - Dédalo language code (e.g. 'lg-eng') or null/empty to clear
* @returns {Promise<boolean>} true on success, false when lang is blank
*/
export const add_component_sample = async (self, component_container, lang) => {

	// user select blank lang case
		if (!lang) {
			while (component_container.firstChild) {
				// remove node from DOM (not component instance)
				component_container.removeChild(component_container.firstChild)
			}
			return false
		}

	const component = await self.load_component_sample({
		lang	: lang,
		ddo		: self.main_element
	})
	const node 		= await component.render()

	// clean container
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}

	// append node
		component_container.appendChild(node)


	return true
}//end add_component_sample



// @license-end
