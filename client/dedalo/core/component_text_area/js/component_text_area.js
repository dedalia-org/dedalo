// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/
// (!) SHOW_DEVELOPER is used in this module (lines ~149, ~187) but is NOT listed in the
//     /*global*/ directive above. Depending on the ESLint config, this may produce a no-undef
//     warning. SHOW_DEVELOPER is defined in core/common/js/environment.js.php and declared as
//     global in other modules (e.g. common.js, util.js) — flag for the /*global*/ maintainer.



/**
* COMPONENT_TEXT_AREA
* Rich-text component for multi-language, multi-paragraph text with inline annotation support.
*
* Wraps a CKEditor 5 instance (via service_ckeditor) and extends component_common for
* standard lifecycle (init → build → render → destroy) and change-tracking (change_value,
* set_changed_data, save). The component stores its data as an array of "entries", each an
* object {lang, value} where `value` is Dédalo's internal tag-markup string.
*
* Tag markup uses bracket-delimited tokens embedded in otherwise HTML text, e.g.:
*   [index-n-1-label_in_1-data::data]...[/index-n-1-label_in_1-data::data]
*   [TC_00:15:12:01.000]                   (timecode)
*   [geo-n-3-3-data::data]                 (geolocation anchor)
* These tokens are converted to/from <img> placeholder nodes in the editor
* by tr.add_tag_img_on_the_fly() (tags_to_html) and preprocess_text_to_save() (html→tags).
*
* Annotation types supported:
*   index (fragment pairs), tc / tc2 (timecodes), svg, draw, geo, page, person, note, lang,
*   reference (cross-section links).
*
* Render modes:  edit · list · tm · search · render_reference
* Views (edit):  default · mini · line · print · html_text
*
* Key properties set at init:
*   - service_text_editor        — the service_ckeditor constructor (set once, not per-instance)
*   - service_text_editor_instance[] — live CKEditor service instances (keyed by int)
*   - text_editor[]              — alias array; same instances (used in render helpers)
*   - auto_init_editor           — whether the editor opens immediately on render
*   - show_interface             — UI capability flags (read_only, button_create_fragment, …)
*   - q_split                    — search option: split query terms for full-text matching
*
* @exports component_text_area
*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {dd_console} from '../../common/js/utils/index.js'
	import {common, create_source} from '../../common/js/common.js'
	import {tr} from '../../common/js/tr.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {service_ckeditor} from '../../services/service_ckeditor/js/service_ckeditor.js'
	import {
			render_edit_component_text_area,
			render_layer_selector,
			render_page_selector
	} from './render_edit_component_text_area.js'
	import {render_list_component_text_area} from './render_list_component_text_area.js'
	import {render_search_component_text_area} from './render_search_component_text_area.js'
	import {render_reference} from './render_reference.js'
	import {response_data, request_failed} from '../../common/js/api_error.js'
	import {error_text} from '../../common/js/render_api_error.js'



/**
* COMPONENT_TEXT_AREA
* Constructor — declares instance properties; all methods live on the prototype.
* Instances are created by component_common.prototype.init via the component factory.
*/
export const component_text_area = function(){

	// element properties declare
	this.model			= null
	this.tipo			= null
	this.section_tipo	= null
	this.section_id		= null
	this.mode			= null
	this.lang			= null

	this.section_lang	= null
	this.context		= null
	this.data			= null
	this.parent			= null
	this.node			= null
	this.id				= null

	this.tag			= null // user selected tag DOM element (set on event click_tag_index_)
	this.text_editor	= [] // array. current active text_editor (service_ckeditor) for current node
	this.events_tokens	= []

	// service_text_editor. Name of desired service to call (service_ckeditor)
	this.service_text_editor			= null
	// service_text_editor_instance. array of created service instances based on input key (one is expected)
	this.service_text_editor_instance	= []
	// auto_init_editor. default is false. To activate, set Ontology property 'auto_init_editor' as true, or configure this component in run-time from tool (like tool_indexation do)
	this.auto_init_editor				= undefined

	// search config
	this.q_split = true
}//end component_text_area



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// lifecycle
	// component_text_area.prototype.init			= component_common.prototype.init
	component_text_area.prototype.build				= component_common.prototype.build
	component_text_area.prototype.render			= common.prototype.render
	component_text_area.prototype.refresh			= common.prototype.refresh
	component_text_area.prototype.destroy			= common.prototype.destroy

	// change data
	// component_text_area.prototype.save			= component_common.prototype.save
	component_text_area.prototype.change_value		= component_common.prototype.change_value
	component_text_area.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_text_area.prototype.update_data_value	= component_common.prototype.update_data_value
	component_text_area.prototype.update_datum		= component_common.prototype.update_datum
	component_text_area.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_text_area.prototype.list				= render_list_component_text_area.prototype.list
	component_text_area.prototype.edit				= render_edit_component_text_area.prototype.edit
	component_text_area.prototype.search			= render_search_component_text_area.prototype.search
	component_text_area.prototype.render_reference	= render_reference

	component_text_area.prototype.change_mode		= component_common.prototype.change_mode



/**
* INIT
* Lifecycle entry point. Calls the generic component_common init, then wires up
* all event subscriptions specific to this component's annotation workflow.
*
* Event channels subscribed (all scoped to self.id or self.id_base):
*   create_fragment_    — user clicks "Create fragment" button; wraps selection in index tags
*   click_tag_index_    — user clicks an index-tag <img>; activates component and scrolls editor
*   click_tag_reference_ — user clicks a reference-tag <img>; same activate-and-scroll flow
*   text_selection_     — CKEditor fires on every selection change; shows/hides create_fragment btn
*   create_geo_tag_     — external caller requests a new geo tag be inserted
*   build_tag_          — external caller (e.g. tool_indexation) requests a generic new tag
*   deactivate_component — fires globally; used here only for debug logging
*
* Side effects:
*   - Sets self.service_text_editor to the service_ckeditor constructor.
*   - Forces show_interface.read_only when permissions < 2.
*   - Applies options.auto_init_editor (if provided and permissions allow).
*
* @param {Object} options - Init options (auto_init_editor, plus those forwarded to component_common)
* @returns {Promise<boolean>} Resolves with the result of component_common.prototype.init
*/
component_text_area.prototype.init = async function(options) {

	const self = this

	// call the generic init method
		const common_init = await component_common.prototype.init.call(self, options);

	// events subscribe

		// create_fragment_ . User click over button 'create_fragment'
			const create_fragment_handler = (options) => {

				// options
					const key			= options.key
					const text_editor	= options.text_editor

				// create the HTML fragment inside the editor adding in/out tags. Returns new created tag_index_id
					const tag_id = self.create_fragment(key, text_editor)
					if (tag_id) {

						// save modified content
							const value = text_editor.get_value()
							self.save_value(key, value)
							.then((response)=>{
								if (response) {
									// select the new tag image in DOM
									const image_node_selector	= `img.index[data-tag_id=${tag_id}]`
									const image_node			= text_editor.dom_select(image_node_selector)[0]
									if (image_node) {
										image_node.click()
									}
								}
							})
					}else{
						console.error(`Error on create_fragment. tag_id is empty. key: ${key}, text_editor:`,text_editor);
					}//end if (created!==false)

				return true
			}
			self.events_tokens.push(
				event_manager.subscribe('create_fragment_' + self.id, create_fragment_handler)
			)

		// click_tag_index_. User click over image index tag
			const click_tag_index_handler = (options) => {

				// options
					const tag = options.tag // object

				// debug
					if(SHOW_DEVELOPER===true) {
						dd_console(`[component_text_area] click_tag_index ${self.id_base}, tag: ${tag}`, 'DEBUG', options)
					}

				// short vars
					const key			= 0; // key (only one editor is available but component could support multiple)
					const text_editor	= self.text_editor[key]

				// fix selected tag element
					self.tag = tag

					ui.component.activate(self)
					.then(function(){

						// set_selection. Implies scroll to the tag into view (!)
						text_editor.set_selection_from_tag(tag)
						dd_request_idle_callback(
							() => {
								if (text_editor.editor && text_editor.editor.editing) {
									// set focus to editor (if the event is fired by other components as portal indexation)
									text_editor.editor.editing.view.focus()
									// scroll to allow display the selection into the view
									text_editor.scroll_to_selection()
								}
							}
						)
					})


				return true
			}
			self.events_tokens.push(
				event_manager.subscribe('click_tag_index_' + self.id_base, click_tag_index_handler)
			)

		// click_reference_. User click over reference tag
			const click_tag_reference_handler = (options) => {

				if(SHOW_DEVELOPER===true) {
					dd_console(`[component_text_area] click_reference_ ${self.id_base}`, 'DEBUG', options)
				}

				// options
					const tag = options.tag // object

				// short vars
					const key			= 0; // key (only one editor is available but component could support multiple)
					const text_editor	= self.text_editor[key]

				// guard: the event may arrive before the (async) CKEditor instance is
				// ready (e.g. fired from another component during load).
					if (!text_editor) {
						return false
					}

				// fix selected tag element
					self.tag = tag

					ui.component.activate(self)
					.then(function(response){

						// set_selection. Implies scroll to the tag into view (!)
						text_editor.set_selection_from_tag(tag)
						dd_request_idle_callback(
							() => {
								// set focus to editor (if the event is fired by other components as portal indexation)
								text_editor.editor.editing.view.focus()
								// scroll to allow display the selection into the view
								text_editor.scroll_to_selection()
							}
						)
					})


				return true
			}
			self.events_tokens.push(
				event_manager.subscribe('click_tag_reference_' + self.id_base, click_tag_reference_handler)
			)

		// text_selection_
			const text_selection_handler = (options) => {

				// options
					const selection	= options.selection
					const caller	= options.caller

				// do not defined the interface to create the button_create_fragment
					if (!self.show_interface || !self.show_interface.button_create_fragment || self.show_interface.button_create_fragment===false) {
						return
					}

				// read_only case
					if (self.show_interface.read_only===true || self.permissions < 2) {
						return
					}

				// called by another text_area case. Sample: component history notes
					if (caller && self.caller && caller.model===self.caller.model) {
						return
					}

				// short vars
					const key						= 0; // key (only one editor is available but component could support multiple)
					const current_text_editor		= self.text_editor[key]
					const component_container		= self.node.content_data[key]
					const button					= component_container.querySelector(".create_fragment") // could exists or not

				if (selection.length<1) {
					if (button) {
						button.remove()
					}
				}else{
					const last_tag_id	= self.get_last_tag_id('index', current_text_editor)
					const label			= (get_label.create_fragment || "Create fragment") + ` ${render_value(last_tag_id+1, 'number')} ` + (SHOW_DEBUG ? ` (chars:${render_value(selection.length, 'number')})` : "")
					if (!button) {
						const create_button = function(selection) {
							const button_create_fragment = ui.create_dom_element({
								element_type	: 'button',
								class_name		: 'warning compress create_fragment',
								inner_html		: label,
								parent			: component_container
							})
							// event create_fragment add publish on click
								button_create_fragment.addEventListener("click", () => {
									event_manager.publish('create_fragment_'+ self.id, {
										caller	: self,
										key		: key,
										text_editor	: current_text_editor
									})
								})

							return button_create_fragment
						}//end fn create_button
						create_button(selection)
					}else{
						button.innerHTML = label
					}
				}

				return true
			}
			self.events_tokens.push(
				event_manager.subscribe('text_selection_'+ self.id, text_selection_handler)
			)

		// create_note_tag_ .
			// (!) Removed 09-02-2023 because is already direct called from render note click event
			// self.events_tokens.push(
			// 	event_manager.subscribe('create_note_tag_'+ self.id_base, self.create_note_tag)
			// )

		// create_geo_tag_
			const create_geo_tag_handler = (options) => {
				self.create_geo_tag(options)
			}
			self.events_tokens.push(
				event_manager.subscribe('create_geo_tag_'+ self.id_base, create_geo_tag_handler)
			)

		// build_tag_
			const build_tag_handler = (options) => {
				self.build_tag(options)
			}
			self.events_tokens.push(
				event_manager.subscribe('build_tag_'+ self.id_base, build_tag_handler)
			)

		// deactivate_component. Save content on deactivate
			const deactivate_component_handler = (component) => {
				if ( component.id === self.id ) {
					// (!) If self.data.changed_data has changed, save is fired automatically
					// from ui.component.deactivate
					if(SHOW_DEBUG===true) {
						const changed_data = self.data && self.data.changed_data
							? self.data.changed_data
							: null
						console.log('+++++ custom fn_deactivate self.data.changed_data:', changed_data);
					}

					// self.save()

					// const text_editor = self.text_editor[0] || null
					// if (!text_editor) {
					// 	console.error('No text editor found. Save failed!', self);
					// 	return false
					// }
					// if (text_editor.is_dirty === true) {
					// 	// save content from editor
					// 	text_editor.save()
					// }
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('deactivate_component', deactivate_component_handler)
			)

	// service_text_editor
		self.service_text_editor = service_ckeditor

	// self.show_interface.read_only
		if (self.permissions < 2) {
			self.show_interface.read_only = true
		}

	// auto_init_editor
		if (options.auto_init_editor && self.permissions > 1) {
			self.auto_init_editor = options.auto_init_editor
		}


	return common_init
}//end init



/**
* BUILD
* Lifecycle step that follows init. Resolves auto_init_editor and ensures
* context.features is initialised to an empty object when absent.
*
* auto_init_editor resolution priority:
*   1. Value already set on self (e.g. via options.auto_init_editor in init)
*   2. self.context.properties.auto_init_editor (Ontology-configured default)
*   3. false (hard default — editor is activated manually by the user)
*
* @param {Object} options - Build options forwarded to component_common.prototype.build
* @returns {Promise<boolean>} Resolves with the result of component_common.prototype.build
*/
component_text_area.prototype.build = async function(options) {

	const self = this

	// call the generic common method
		const common_build = await component_common.prototype.build.call(self, options);

	// auto_init_editor
		self.auto_init_editor = self.auto_init_editor!==undefined
			? self.auto_init_editor
			: self.context.properties && self.context.properties.auto_init_editor!==undefined
				? self.context.properties.auto_init_editor
				: false

	// fix context features non defined
		if (!self.context.features) {
			self.context.features = {}
		}


	return common_build
}//end build



/**
* DESTROY
* Force service_ckeditor instances to destroy editors (ckeditor instance)
* and later execute a standard self destroy from common
*
* CKEditor instances must be explicitly destroyed before unmounting their DOM
* to release internal event listeners and avoid memory leaks. This override
* iterates self.text_editor[] and calls service_ckeditor.destroy() on each,
* then delegates to the standard common.prototype.destroy for DOM cleanup and
* events_token unsubscription.
*
* @param {boolean} [delete_self=true] - Whether to delete the instance from the registry
* @param {boolean} [delete_dependencies=false] - Whether to destroy dependent child components
* @param {boolean} [remove_dom=false] - Whether to remove self.node from the DOM
* @returns {Promise<boolean>} Resolves with the result of common.prototype.destroy
*/
component_text_area.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// destroy the editors instances too
		if (self.text_editor && self.text_editor.length>0) {
			for (let i = 0; i < self.text_editor.length; i++) {
				// self.text_editor[x] is a instance of service_ckeditor
				const service_ckeditor = self.text_editor[i]
				service_ckeditor.destroy()
			}
		}

	// call the generic common method
		const common_destroy = await common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom);


	return common_destroy
}//end build



/**
* TAGS_TO_HTML
* Parses Dédalo server side tags to html tags
* e.g. '[TC_00:15:12:01.000]' => '<img id="[TC_00:00:25.684_TC]" class="tc" src="" ... />'
*
* Delegates the token-to-img conversion to tr.add_tag_img_on_the_fly() and then
* applies a legacy path fix for old data that embedded '/inc/btn.php/' image paths.
* The fix rewrites those paths to the current component_text_area tag endpoint.
*
* @param {string} value - Raw stored text value containing Dédalo bracket tokens
* @returns {string|null} HTML string with bracket tokens replaced by <img> placeholders,
*   or null when value is falsy
*/
component_text_area.prototype.tags_to_html = function(value) {

	const html = (value)
		? tr.add_tag_img_on_the_fly(value)
		: null

	// fix bug legacy data ../../../inc/btn.php/[geo-n-1-] => ../component_text_area/tag/?id=[geo-n-1-]
		const html_safe = html===null
			? html
			: html.replace('../../../inc/btn.php/', '../../core/component_text_area/tag/?id=')

	// debug
		if(SHOW_DEBUG===true) {
			if (html_safe!==html) {
				console.error('Fixed found legacy error tags path (btn.php)');
			}
		}


	return html_safe
}//end tags_to_html



/**
* SET_VALUE
* Set individual value based on element key
*
* Constructs a change_value call with a frozen changed_data item and triggers
* a component refresh. Unlike save_value, this method does NOT preprocess
* (i.e. does not convert HTML to Dédalo bracket tokens) — it stores the
* string_value verbatim. Use save_value when the source is the live CKEditor
* HTML output.
*
* @param {number} key - Entry index (corresponds to the language slot in data.entries)
* @param {string} string_value - Raw string value to store (already in Dédalo tag format)
* @returns {Promise<*>} Result of component_common.prototype.change_value
*/
component_text_area.prototype.set_value = function(key, string_value) {

	const self = this
	// get the unchange value object from component
	const data			= self.data || {}
	const entries		= data.entries || []
	const item_value	= (entries[key]) ? entries[key] : {lang: self.lang}

	// set the new value changing the item.value
	item_value.value = string_value

	const changed_data = [Object.freeze({
		action	: 'update',
		id		: entries[key]?.id || null,
		key		: key,
		value	: item_value
	})]
	return self.change_value({
		changed_data	: changed_data,
		refresh			: true
	})
}//end set_value



/**
* SAVE_VALUE
* Saves individual value based on element key
*
* Preprocesses the HTML from the CKEditor (converting <img> placeholders back
* to Dédalo bracket tokens, stripping temporary UI elements) via
* preprocess_text_to_save(), then persists the result through change_value
* with refresh:false (avoids re-rendering the component after save).
* Resets self.is_data_changed to false on success.
*
* @param {number} key - Entry index; corresponds to the language slot in data.entries
* @param {string} string_value - Raw HTML from the CKEditor (may include <img> tag-nodes)
* @returns {Promise<*>} Result of change_value (which calls the Dédalo API save action)
*/
component_text_area.prototype.save_value = async function(key, string_value) {

	const self = this

	// get the unchange value object from component
	const data			= self.data || {}
	const entries		= data.entries || []
	const item_value	= (entries[key]) ? entries[key] : {lang: self.lang}

	// set the value to be saved in component
	const new_data = await self.preprocess_text_to_save(string_value)

	// set the new value changing the item.value
	item_value.value = (new_data) ? new_data : null

	const changed_data = [Object.freeze({
		action	: 'update',
		id		: entries[key]?.id || null,
		key		: key,
		value	: item_value
	})]
	const js_promise = self.change_value({
		changed_data	: changed_data,
		refresh			: false
	})
	.then(()=>{
		// event to update the DOM elements of the instance
		// event_manager.publish('update_value_'+self.id, changed_data)

		// reset is_data_changed state
		self.is_data_changed = false
	})


	return js_promise
}//end save_value



/**
* SAVE_EDITOR
* Order text_editor[key] to save (only if state is dirty)
*
* Delegates to the underlying service_ckeditor_instance[key].save() method.
* The service is responsible for checking its own dirty state before POSTing.
*
* (!) Note: concatenation error on the error log string — uses `.` (PHP-style) instead
*     of `+` (JS) when building the error message; this is a pre-existing bug, do NOT fix here.
*
* @param {number} [key=0] - Index into service_text_editor_instance (normally always 0)
* @returns {Promise<boolean>} Resolves with the service save result, or false on missing instance
*/
component_text_area.prototype.save_editor = async function(key=0) {

	const self = this

	const text_editor = self.service_text_editor_instance[key]
	if (!text_editor) {
		console.error('Error on get text_editor from self.service_text_editor_instance:', self.service_text_editor_instance)
		return false
	}

	const result = text_editor.save() // return async bool


	return result
}//end save_editor



/**
* SAVE
* 	Alias of component_common.prototype.save with component specific added actions
*
* Resolves the changed_data to use: the caller may pass an explicit changed_data
* object (e.g. from a toolbar save button), otherwise the pending changed_data
* already set on self.data.changed_data (populated by update_changed_data) is used.
*
* @param {Object} [changed_data] - Optional explicit changed_data payload:
* 	{
* 		action : "update",
* 		key : 0,
* 		value : "XXX"
* 	}
* @returns {Promise<*>} Resolves with the result of component_common.prototype.save
*/
component_text_area.prototype.save = async function(changed_data = undefined) {

	const self = this

	// change data could be sent by the caller, if not is sent use the change_value that will be set by the change event
	const safe_changed_data = changed_data
		? changed_data
		: self.data.changed_data

	// call the generic common tool init
		const save_promise = await component_common.prototype.save.call(this, safe_changed_data);


	return save_promise
}//end save



/**
* PREPROCESS_TEXT_TO_SAVE
* Replace <section> tags to internal Dédalo tags
* Unify text content format
*
* Takes the raw HTML produced by CKEditor and converts it to the Dédalo internal
* storage format before persisting. The transformation pipeline is:
*
* 1. Clone the HTML into a detached <div> (avoids mutating live DOM nodes).
* 2. Convert <reference> custom elements → bracket tokens
*    e.g. <reference data-tag_id="2" ...>text</reference>
*      → [reference-n-2--data::data]text[/reference-n-2--data::data]
* 3. If context.legacy_model === 'component_html_text': return innerHTML as-is (no img conversion).
* 4. Convert <img> placeholder nodes (data-type set) → bracket tokens via build_data_tag.
*    SVG images are renumbered on the fly to avoid duplicate tag_id collisions.
* 5. Strip ephemeral UI elements: <h2> (TOC headings), <header> (TOC container),
*    <caret> (fake caret), and elements with data-mce-bogus="1" (TinyMCE leftovers).
* 6. Replace bare <br>/<br/> elements with </p><p> paragraph boundaries.
*
* (!) querySelectorAll is used for img tags (instead of getElementsByTagName) because
*     it returns a static NodeList — safe to iterate forward even when nodes are removed.
*     Reference elements use getElementsByTagName and iterate in reverse for the same reason.
*
* @param {string} html_value - Raw HTML string from the CKEditor getData() call
* @returns {Promise<string>} Processed Dédalo tag-markup string ready for API save
*/
component_text_area.prototype.preprocess_text_to_save = async function(html_value) {

	const self = this

	// clone text. Avoid interactions between html nodes
		const cloned_text = document.createElement('div')
			  cloned_text.insertAdjacentHTML('afterbegin', render_value(html_value, self.context.render_class));

	// reference tags
		// Iterate all reference elements
		const reference_elements = cloned_text.getElementsByTagName('reference')
		if (reference_elements) {
			//console.log(reference_elements)
			const reference_elements_len = reference_elements.length
			for (let i = reference_elements_len - 1; i >= 0; i--) {
				// Convert section tags to dedalo internal labels
				// <reference class="reference_struct text_unselectable" id="reference_2" data-state="n" data-label="" data-data="{'reference_tipo':'rsc370','reference_id':'3'}">..</reference>
				// [reference-a-1-1-data:{'reference_tipo':'rsc370','reference_id':'3'}:data]...[/reference-a-1-1-data:{'reference_tipo':'rsc370','reference_id':'3'}:data]
				const tag_id		= reference_elements[i].dataset.tag_id
				const state			= reference_elements[i].dataset.state
				const label			= reference_elements[i].dataset.label
				const data			= reference_elements[i].dataset.data ?? null
				// Compose Dédalo tags
				const tag_in		= self.build_data_tag('referenceIn', tag_id, state, label, data)
				const tag_out		= self.build_data_tag('referenceOut', tag_id, state, label, data)
				const final_string	= tag_in + reference_elements[i].innerHTML + tag_out

				// Replaces tag content string with new created (the editor's own
				// markup — the component's wire render_class, 'html' for text_area)
				reference_elements[i].innerHTML = render_value(final_string, self.context.render_class)

				// Unwrap section tag node (removes tags and leaves only contents)
				unwrap_element(reference_elements[i]);
			}//end for (var i = len - 1; i >= 0; i--) {
		}//end reference_elements


	// html_text case. Do not apply post-processing
		if (self.context.legacy_model==='component_html_text') {
			return cloned_text.innerHTML
		}

	// img tags (index, tc, svg, geo, person, etc.)
		const image_elements = cloned_text.querySelectorAll('img') // ! use querySelectorAll to avoid loop problems on i++
		if (image_elements) {

			const ar_svg_used_tag_id = [] // for re-numerate on the fly

			const image_elements_len = image_elements.length
			for (let i = 0; i < image_elements_len; i++) {

				const current_element = image_elements[i]
				// check if the image is a tag or other images
				// if the image is not a tag do not change the node
				const current_tag_type = current_element.dataset.type
				if(!current_tag_type){
					continue
				}

				let current_tag_id = current_element.dataset.tag_id

				// svg case. Keep current svg tag_id for renumber on the fly
					if (current_element.dataset.type==="svg") {

						current_tag_id = parseInt(current_tag_id)
						if(current_tag_id<1) current_tag_id = 1

						// console.log("ar_svg_used_tag_id.indexOf(current_tag_id):",ar_svg_used_tag_id.indexOf(current_tag_id), ar_svg_used_tag_id, current_tag_id);
						// If is zero or already exits, renumber
						if(ar_svg_used_tag_id.indexOf( current_tag_id ) > -1) {
							// renumber
							current_tag_id = Math.max.apply(Math, ar_svg_used_tag_id) + 1
						}
						ar_svg_used_tag_id.push( current_tag_id )
					}

				// build_data_tag. Build dedalo tag from node image dataset	info
				const final_string = self.build_data_tag(current_element.dataset.type,
														 current_tag_id,
														 current_element.dataset.state,
														 current_element.dataset.label,
														 current_element.dataset.data)
				if (final_string) {
					// Replaces tag content string with new created (editor markup)
					current_element.innerHTML = render_value(final_string, self.context.render_class)
					// Unwrap section tag node (removes tags and leaves only contents)
					unwrap_element(current_element)
				}
			}
		}//end if (image_elements)

	// temporal elements. Remove after use
		let temp_elements = []

		// remove temporal elements (h2)
			temp_elements = cloned_text.getElementsByTagName('h2')
			const h2_len = temp_elements.length
			for (let i = h2_len - 1; i >= 0; i--) {
				temp_elements[i].remove()
			}

		// remove temporal header (toc)
			temp_elements = cloned_text.getElementsByTagName('header')
			const header_len = temp_elements.length
			for (let i = header_len - 1; i >= 0; i--) {
				temp_elements[i].remove()
			}

		// remove fake caret
			temp_elements = cloned_text.getElementsByTagName('caret')
			const caret_len = temp_elements.length
			for (let i = caret_len - 1; i >= 0; i--) {
				temp_elements[i].remove()
			}

		// remove spacial bogus elements (<br data-mce-bogus="1">)
			const bogus_elements		= cloned_text.querySelectorAll('[data-mce-bogus="1"]')
			const bogus_elements_len	= bogus_elements.length
			for (let i = bogus_elements_len - 1; i >= 0; i--) {
				bogus_elements[i].remove()
			}

		// remove <br> and change for <p> </p>
			const string_text = cloned_text.innerHTML
			const reg_ex = /(<\/? ?br>)/gmi;
			const clean_text_value	= string_text.replace(reg_ex,'</p><p>')
			// const new_div			= document.createElement("div")
			// new_div.innerHTML		= clean_text_value

	if(SHOW_DEBUG===true) {
		//const end  	= new Date().getTime()
		//const time 	= end - start
		//console.log("[component_text_area.preprocess_text_to_save] exec in ms:",time);
		//console.log("[component_text_area.render_all_tags] time: " +time+ " ms")
	}


	return clean_text_value
}//end preprocess_text_to_save



/**
* UPDATE_CHANGED_DATA
* Reads the current CKEditor HTML, preprocesses it to Dédalo bracket-token format,
* and writes the result to self.data.changed_data via set_changed_data.
*
* This is the "mark dirty" path: called by service_editor.set_dirty whenever the
* editor content changes, so the pending save payload is always up to date before
* any auto-save or manual save fires.
*
* @see service_editor.set_dirty
* @param {Object} options
* @param {Object} options.text_editor - The service_ckeditor instance that changed
* @param {number} options.key - Entry index (language slot) that was edited
* @returns {void}
*/
component_text_area.prototype.update_changed_data = function (options) {

	const self = this

	// options
	const text_editor	= options.text_editor
	const key			= options.key

	// get the unchange value object from component
	const data			= self.data || {}
	const entries		= data.entries || []
	const item_value	= (entries[key]) ? entries[key] : {lang: self.lang}
	// get the text editor value
	const string_value = text_editor.editor.getData();

	// change the HTML string value to text value used as Dédalo data
	self.preprocess_text_to_save(string_value)
	.then(function(parsed_value) {
		// create a new item in data object to be sent as Dédalo API request body
		item_value.value = (parsed_value.length>0) ? parsed_value : null;

		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			key		: key,
			value	: item_value
		})

		// fix instance changed_data
		self.set_changed_data(changed_data_item)
	})
}//end update_changed_data



/**
* CHANGE_DATA_HANDLER
* Unified changeData event handler for text editor changes across views.
* Iterates over editor changes and publishes tag-specific events.
*
* When CKEditor reports a batch of data-model changes (e.g. an attribute update
* on a tag widget), this handler re-publishes each change as a named event
* 'editor_tag_<type>_change_<id_base>' so that tool panels (indexation, notes, geo)
* can react independently to the specific tag type that changed.
*
* @param {Array} options - Array of change objects from the CKEditor change:data event,
*   each with at least { type: string } identifying the changed annotation type
* @returns {void}
*/
component_text_area.prototype.change_data_handler = function(options) {

	const self = this

	// validate options is an array
	if (!Array.isArray(options)) {
		console.error('[component_text_area.change_data_handler] Invalid options parameter. Expected array, got:', typeof options)
		return
	}

	const ar_changes	= options
	const changes_len	= ar_changes.length
	for (let i = changes_len - 1; i >= 0; i--) {
		const change = ar_changes[i]
		const event_name = 'editor_tag_'+ change.type + '_change_' + self.id_base
		event_manager.publish(event_name, change)
	}
}//end change_data_handler



/**
* UNWRAP_ELEMENT
* Replaces an element in the DOM with its own child nodes, effectively stripping
* the wrapper element while preserving its content.
*
* Used during preprocess_text_to_save to remove custom element wrappers (<reference>,
* <img>) after their content has been converted to Dédalo bracket tokens and placed
* as innerHTML — the converted token string must live directly in the parent text node.
*
* @param {HTMLElement} el - The element to unwrap; must have a parentNode
* @returns {boolean} Always true
*/
const unwrap_element = function(el) {

	// get the element's parent node
	const parent = el.parentNode;

	// move all children out of the element
	while (el.firstChild) parent.insertBefore(el.firstChild, el);

	// remove the empty element
	parent.removeChild(el);

	return true
}//end unwrap_element



/**
* UPDATE_TAG
* Edit selected tag adding or modifying the dataset and image url
* This method has been unified to allow to use different services in the same way
*
* Converts a type string that may carry an 'In'/'Out' suffix into a [typeIn, typeOut]
* pair so the underlying service can update both bracket endpoints atomically.
* Types without a directional suffix (e.g. 'tc', 'geo') are passed as a single-element array.
*
* (!) Uses alert() to notify the user of missing options — retained from the original
*     code; alert() is not the preferred notification path (use event_manager 'notification'
*     instead). Do NOT change this — flag only.
*
* @param {Object} options - Tag update descriptor
* @param {string} options.type - Annotation type, e.g. 'indexIn', 'tc', 'geo'
* @param {string|number} options.tag_id - Numeric identifier of the tag to update
* @param {Object} options.new_data_obj - New dataset values to write to the tag node
* @param {number} [options.key=0] - Editor instance index
* @returns {Promise<boolean>} Resolves with the service update_tag result,
*   or false when options is undefined
*/
component_text_area.prototype.update_tag = async function(options) {

	const self = this

	// check options value
		if (typeof options==='undefined') {
			alert("Please select tag");
			console.error("[component_text_area.update_tag] ERROR. Stopped update_tag. Empty options:", options);
			console.trace();
			return false
		}

	// options
		const type			= options.type
		const tag_id		= options.tag_id
		const new_data_obj	= options.new_data_obj
		const key			= options.key || 0
		// const save		= options.save || false  (Unified component_text_area change-tag method. This method has been unified to allow to use different services in the same way (service_ckeditor, service_tinymce))

	// ar_type. Could be one like ['tc'] or a pair like ['indexIn','indexOut']
		const ar_type = (type.indexOf('In')!==-1 || type.indexOf('Out')!==-1)
			? (()=>{
				const type_in = (type.indexOf('Out')!==-1)
					? type.replace('Out', 'In')
					: type
				const type_out = (type.indexOf('In')!==-1)
					? type.replace('In', 'Out')
					: type
				return [type_in, type_out]
			  })()
			: [type]

	// trigger service action. result is a promise resolve bool
		const result = self.service_text_editor_instance[key].update_tag({
			type			: ar_type, // string|array
			tag_id			: tag_id, // int
			new_data_obj	: new_data_obj // object
		})


	return result
}//end update_tag



/**
* BUILD_DATA_TAG
* Unified way of create Dedalo internal custom tags from JAVASCRIPT
* i.e. '[index-d-7--data::data]'
*
* Produces the Dédalo bracket-token string for a given annotation type:
*   - Opening tags:  [type_name-state-tag_id-safe_label-data_string]
*   - Closing tags:  [/type_name-state-tag_id-safe_label-data_string]
*   - Timecode (tc): the raw tag_id string (which already embeds the TC brackets)
*
* Labels are truncated to 22 characters and hyphens replaced with underscores
* to avoid ambiguity with the hyphen delimiter in the token format.
*
* (!) Uses alert() on invalid type — retained from original; flag only.
*
* @param {string} type - Annotation type, must be one of:
*   'indexIn','indexOut','tc','tc2','svg','draw','geo','page','person','note','lang',
*   'referenceIn','referenceOut'
* @param {string|number} tag_id - Numeric ID of the tag (or the full TC string for timecodes)
* @param {string} state - Tag state flag, typically 'n' (normal) or 'a' (active)
* @param {string} label - Human-readable label; truncated to 22 chars, hyphens → underscores
* @param {string|null} data - Optional JSON-like data payload; wrapped as 'data:...:data'
* @returns {string|boolean} The bracket-token string, or false on invalid type
*/
component_text_area.prototype.build_data_tag = function(type, tag_id, state, label, data) {

	const self = this

	// check tag type
		const valid_types = ['indexIn','indexOut','tc','tc2','svg','draw','geo','page','person','note','lang','referenceIn','referenceOut']
		if (valid_types.includes(type)===false) {
			console.warn("[component_text_area.build_data_tag] Invalid tag type:", type);
			alert("[component_text_area.build_data_tag] Invalid tag type: " + type)
			return false
		}

	// bracket_in. Is different for close tag
		const bracket_in = (type.indexOf('Out')!==-1)
			? '[/'
			: '['

	// type_name. Removes suffixes 'In' and 'Out'
		const type_name = type.replace(/In|Out/, '')

	// label. Truncate and replace - avoid future errors
		const safe_label = (typeof label==='undefined')
			? ''
			: (label.substring(0,22)).replace(new RegExp('-', 'g'), '_');

	// data
		const data_string = ( data )
			? 'data:' + data + ':data'
			: 'data::data'

	// dedalo_tag
		const dedalo_tag = (type==='tc')
			? tag_id
			: bracket_in + type_name + '-' + state + '-' + tag_id + '-' + safe_label + '-' + data_string + ']'


	return dedalo_tag
}//end build_data_tag




/**
* BUILD_VIEW_TAG_OBJ
* Create a view object from tag info (type, state, label, data, id)
*
* Converts the parsed server-side tag descriptor into the view-layer tag object
* consumed by service_ckeditor.set_content() / update_tag() to insert or update
* an <img> placeholder node in the editor.
*
* The returned object encodes all attributes needed to reconstruct the bracket token
* on save, plus the src URL for the tag thumbnail image served by the tag endpoint
* (core/component_text_area/tag/?id=...).
*
* Timecode ('tc') tags have a special format — their tag_id already encodes the full
* [TC_HH:MM:SS.mmm_TC] string so the src/id fields differ from all other types.
*
* @param {Object} data_tag - Parsed tag descriptor from the server data
* @param {string} data_tag.type - Annotation type (e.g. 'indexIn', 'geo', 'tc')
* @param {string} data_tag.state - State flag ('n', 'a', …)
* @param {string} data_tag.label - Display label
* @param {Object|null} [data_tag.data] - Optional structured data payload
* @param {string|number} tag_id - The numeric tag identifier
* @returns {Object} view_tag_obj with properties:
*   {string} src        - URL for the tag image endpoint
*   {string} id         - HTML id attribute value
*   {string} class_name - CSS class for the <img> node
*   {string} type       - Original type (with 'In'/'Out' suffix if applicable)
*   {string} tag_id     - String form of the id (or TC string for timecodes)
*   {string} state      - State flag
*   {string} label      - Display label
*   {string|null} data  - Serialised data string (single-quoted JSON for HTML5 dataset)
*/
component_text_area.prototype.build_view_tag_obj = function(data_tag, tag_id) {

	const self = this

	const type			= data_tag.type
	const state			= data_tag.state
	const label			= data_tag.label
	// convert the data_tag to string to be used it in html
	// const data_string	= JSON.stringify(data_tag.data)
	// replace the " to ' to be compatible with the dataset of html5, the tag store his data ref inside the data-data html
	// json use " but it's not compatible with the data-data storage in html5
	// const data			= data_string.replace(/"/g, '\'')
	const data = data_tag.data
		? self.tag_data_object_to_string(data_tag.data)
		: null

	const images_factory_url = '../../core/component_text_area/tag/?id='

	// Renderer fingerprint appended to every DETERMINISTIC badge src, exactly as
	// tr.add_tag_img_on_the_fly does — the URL is otherwise version-free, so a
	// browser holding a badge from an older drawing would never refetch it
	// (see tr.tag_badge_version). The 'svg' tag is a media redirect, not a drawn
	// badge, so it is left unversioned.
	const version_suffix = (type==='svg')
		? ''
		: '&v=' + tr.tag_badge_version

	// Bracket_in is different for close tag
	const bracket_in = (type.indexOf('Out')!==-1)
		? '[/'
		: '['

	// Removes suffixes 'In' and 'Out'
	const type_name = type.replace(/In|Out/, '');

	const src = (type==='tc')
		? images_factory_url  + '[TC_' + tag_id + '_TC]' + version_suffix
		: images_factory_url  + bracket_in + type_name + "-" + state + "-" + tag_id + "-" + label + "]" + version_suffix

	const id = (type==='tc')
		? tag_id
		: bracket_in + type_name + '-' + state + '-' + tag_id + '-' + label + ']'

	const class_name = (type==='tc')
		? type
		: type_name

	const view_tag_obj ={
		src			: src,
		id			: id,
		class_name	: class_name,
		// dataset
		type		: type,
		tag_id		: (type==='tc') ? '[TC_' + tag_id + '_TC]' : String(tag_id),
		state		: (type==='tc') ? 'n': state,
		label		: (type==='tc') ? tag_id : label,
		data		: (type==='tc') ? tag_id : data
	}


	return view_tag_obj
}//end build_view_tag_obj



/**
* TAG_DATA_OBJECT_TO_STRING
* Serialises a tag data object to a string safe for HTML5 dataset attributes.
*
* JSON.stringify produces double-quoted keys/values. HTML5 data-* attributes that
* themselves live inside a double-quoted HTML attribute would break the markup, so
* all double-quote characters are replaced with single-quotes after serialisation.
*
* (!) This means the result is NOT valid JSON — it cannot be parsed with JSON.parse
*     directly. Callers that later need to re-parse it must first convert ' → ".
*
* @param {Object} data - Tag payload object to serialise
* @returns {string|null} Single-quote JSON string, or null when data is not an object
*/
component_text_area.prototype.tag_data_object_to_string = function(data) {

	// check valid object
		if (typeof data!=='object') {
			console.log('Error. data must be type object. Current type:', typeof data);
			return null
		}

	// convert the data_tag to string to be used it in html
	// replace the " to ' to be compatible with the dataset of HTML5, the tag store his data ref inside the data-data html
	// JSON use " but it's not compatible with the data-data storage in HTML5
		const data_string = JSON.stringify(data).replace(/"/g, '\'')


	return data_string
}//end tag_data_object_to_string



/**
* GET_LAST_TAG_ID
* Calculates all current text_editor editor tags id of given type (ex. 'reference') and get last used id
*
* Delegates to service_ckeditor_instance.get_last_tag_id which inspects the live
* editor model for all existing tag widgets of the given type and returns the highest
* numeric id found, or 0 when no tags of that type exist yet.
* Used before creating a new tag to determine the next sequential id.
*
* @param {string} tag_type - CSS class / annotation type name, e.g. 'index', 'geo', 'reference'
* @param {Object} text_editor - service_ckeditor instance to inspect
* @returns {number} Highest existing tag_id for the given type, or 0
*/
component_text_area.prototype.get_last_tag_id = function(tag_type, text_editor) {

	const self = this

	const last_tag_id = text_editor.get_last_tag_id({
		tag_type : tag_type
	})


	return last_tag_id
}//end get_last_tag_id



/**
* CREATE FRAGMENT (using index tags)
* Create the images (with the tags) at the beginning and end of the selected text
*
* Wraps the current editor text selection with a pair of index tag <img> nodes
* ([indexIn] / [indexOut]) numbered sequentially after the last existing index tag.
* After insertion, fires a click on the newly inserted opening tag node so that
* the indexation panel activates immediately.
*
* Returns false (instead of a tag_id) in the following cases:
*   - text_editor is missing
*   - current selection is empty (nothing to wrap)
*   - wrap_selection_with_tags fails (range_clon is null/falsy)
*
* @param {number} key - Editor instance index (currently always 0)
* @param {Object} text_editor - service_ckeditor instance owning the active selection
* @returns {number|boolean} The new tag_id (integer ≥ 1) on success, or false on failure
*/
component_text_area.prototype.create_fragment = function(key, text_editor) {

	const self = this

	// text_editor check
		if (!text_editor) {
			console.error('-> [component_text_area.create_fragment] text_editor not received! key:', key);
			return false
		}

	// selection text
		const selection_raw = text_editor.get_selection();
		if (!selection_raw || selection_raw.length<1) {
			console.warn('Ignored empty selection:', selection_raw, key);
			return false
		}

	// last_tag_id. Find last image of type index and returns id or 0
		const last_tag_index_id = self.get_last_tag_id('index', text_editor)

	// create new string wrapping selection with new tags
		// tag state. Default is 'n' (normal)
			const tag_state = 'n';

		// tag_id. Last id plus one
			const tag_id = parseInt(last_tag_index_id) + 1

		// tag images
			const image_in  = self.build_view_tag_obj({
				type	: 'indexIn',
				state	: tag_state,
				label	: 'label in ' + tag_id,
				data	: ''
			}, tag_id)
			const image_out  = self.build_view_tag_obj({
				type	: 'indexOut',
				state	: tag_state,
				label	: 'label in ' + tag_id,
				data	: ''
			}, tag_id)

		// wrap_selection_with_tags. Prepend and append tag image node to current editor text selection
			const range_clon = text_editor.wrap_selection_with_tags(image_in, image_out)

		// get the DOM node of the tag
			const inserted_tag_in = text_editor.get_view_tag_node({
				type	: 'indexIn',
				tag_id	: tag_id
			})
		// Fire click into the image node of the tag
			if (inserted_tag_in?.firstChild) {
				inserted_tag_in.firstChild.click()
			}


	return (range_clon)
		? tag_id
		: false
}//end create_fragment



/**
* DELETE_TAG
* Calls the server API to delete the metadata for a given annotation tag, then
* removes the corresponding <img> node(s) from the CKEditor model.
*
* For 'index' tags the server deletes both the In and Out records; the client
* mirror maps 'index' → ['indexIn','indexOut'] for the service delete call.
*
* @param {string} tag_id - Numeric id of the tag to delete, e.g. '2'
* @param {string} type - Annotation type without In/Out suffix, e.g. 'index', 'geo'
* @param {number} [key=0] - Editor instance index
* @returns {Promise<Object>} Resolves with the raw api_response from the server
*/
component_text_area.prototype.delete_tag = function(tag_id, type, key=0) {

	const self = this

	return new Promise(function(resolve){

		data_manager.request({
			body : {
				action	: 'delete_tag',
				dd_api	: 'dd_component_text_area_api', // component_text_area
				source	: {
					section_tipo	: self.section_tipo,
					section_id		: self.section_id,
					tipo			: self.tipo,
					lang			: self.lang
				},
				options : {
					tag_id	: tag_id, // string current selected tag (passed as param)
					type	: type // string current selected tag type (passed as param)
				}
			}
		})
		.then(async function(api_response){

			if (!request_failed(api_response)) {

				// delete editor tags
				await self.text_editor[key].delete_tag({
					type	: type==='index' ? ['indexIn','indexOut']: type,
					tag_id	: tag_id
				})
			}

			resolve(api_response)
		})
	})
}//end delete_tag



/**
* GET_TAGS_INFO
* Fetches server-side metadata for all tags of the specified type(s) in this
* component's current record (section_tipo + section_id + tipo + lang).
*
* Used by annotation panels (indexation, notes, geo) to load the structured data
* associated with each tag_id so the panel can render details and allow editing.
*
* (!) The Promise does not resolve when the call FAILED — callers
*     that depend on a resolved value may hang if the server returns an error.
*     This is a pre-existing design; do NOT change.
*
* @param {Array<string>} ar_type - List of annotation types to retrieve, e.g. ['index']
* @param {number} [key=0] - Entry key (language slot) to query
* @returns {Promise<*>} Resolves with the response payload (the tags metadata array/object)
*/
component_text_area.prototype.get_tags_info = function(ar_type, key=0) {

	const self = this

	return new Promise(function(resolve){

		data_manager.request({
			body : {
				action	: 'get_tags_info',
				dd_api	: 'dd_component_text_area_api', // component_text_area
				source	: {
					section_tipo	: self.section_tipo,
					section_id		: self.section_id,
					tipo			: self.tipo,
					lang			: self.lang
				},
				options : {
					ar_type	: ar_type ,// array current selected tag type (passed as param)
					key		: key // int, text_area data key, by default is 0
				}
			}
		})
		.then(async function(api_response){

			if (!request_failed(api_response)) {
				resolve(response_data(api_response))
			}
		})
	})
}//end get_tags_info



/**
* UPDATED_LAYER_DATA
* Synchronises the editor when a geo/svg layer tool reports that a layer has been
* updated (e.g. a new polygon drawn). If the corresponding tag_id does not already
* exist in the editor, a new tag <img> node is inserted at the current caret.
*
* The tag_id is stringified from options.layer.layer_id before lookup/construction
* because the editor model stores all tag_ids as strings.
*
* (!) `inserted_tag` is declared twice with `const` in the same function scope —
*     once in the outer scope (from get_view_tag) and once inside the if-block
*     (from set_content). This is a pre-existing issue; the inner const shadows
*     but does not conflict because the outer is not used inside the block.
*     Do NOT change.
*
* @param {Object} options - Update descriptor
* @param {Object} options.caller - The tool/component that triggered the update
* @param {Object} options.layer - Layer info object
* @param {string} options.layer.type - Annotation type, e.g. 'geo', 'svg'
* @param {number} options.layer.layer_id - Numeric layer/tag id
* @returns {void}
*/
component_text_area.prototype.updated_layer_data = function(options) {

	const self = this

	const caller	= options.caller
	const type		= options.layer.type
	const layer_id	= options.layer.layer_id
	const tag_id 	= JSON.stringify(layer_id)
	const tag_obj 	= {
		type	: type,
		tag_id	: tag_id
	}

	// check if the tag exists in the editor
	const key = 0;
	const inserted_tag = self.text_editor[key].get_view_tag(tag_obj)
	// if the editor do not find the tag, create new one
	if(inserted_tag === false){

		// create new string wrapping selection with new tags
		// tag state. Default is 'n' (normal)
			const tag_state = 'n';

		// tag images
			const geo_view_tag  = self.build_view_tag_obj({
				type	: type,
				state	: tag_state,
				label	: tag_id,
				data	: ""
			}, tag_id)

		// const tag = self.build_view_tag_obj(geo_view_tag, tag_id)
		// insert the new note tag in the caret position of the text_editor
		const inserted_tag = self.text_editor[key].set_content(geo_view_tag)
	}
}//end updated_layer_data



/**
* ADD_COMPONENT_HISTORY_NOTE
* Creates a new record in matrix_notes and set 'code' field value with received
* matrix_id from time_machine
*
* Enforces an ownership rule: only the user who originally created the time-machine
* row (identified by self.caller.locator.user_id) may attach a note. If the current
* page_globals.user_id differs, a 'warning' notification is published and null is returned.
*
* On success:
* 1. Creates a new section record in notes_section_tipo via 'create' API action.
* 2. Saves the matrix_id into the code component (hard-coded tipo 'rsc835') of that record.
*
* @param {Object} options - Note creation options
* @param {number} options.matrix_id - The time-machine matrix record id to link
* @param {string} options.notes_section_tipo - Section tipo of the notes matrix (e.g. 'rsc834')
* @returns {Promise<string|null>} The new section_id string on success, or null on any failure
*/
component_text_area.prototype.add_component_history_note = async function(options) {

	const self = this

	// options
		const notes_section_tipo	= options.notes_section_tipo
		const matrix_id				= options.matrix_id

	// check
		if (!matrix_id) {
			console.error('Undefined matrix_id. options:', options);
			return null
		}

	// check user creator
		// created_by_user_id: component text area note creation if is already created
		const created_by_user_id = self.data.created_by_user_id
		// user_id: current logged user
		const user_id			= page_globals.user_id
		// tm_user_id: column userID from time machine record
		const tm_user_id		= parseInt(self.caller.locator.user_id)

		if (user_id!==tm_user_id) {
			event_manager.publish('notification', {
				msg			: 'Only the owner can create a time machine note',
				type		: 'warning',
				remove_time	: 3000 // 3 secs
			})
			return null
		}

	// create new notes record
		const rqo = {
			action	: 'create',
			source	: {
				section_tipo : notes_section_tipo
			}
		}
		const api_response = await data_manager.request({
			body : rqo
		})
		const created_section_id = response_data(api_response)
		if (!created_section_id || created_section_id<1) {
			console.error('Error on create matrix note record. api_response:', api_response);
			event_manager.publish('notification', {
				msg			: request_failed(api_response)
					? error_text(api_response.error)
					: 'Error on create matrix note record',
				type		: 'error',
				remove_time	: 10000 // 10 secs
			})
			return null
		}
		const new_section_id = created_section_id || null
		if (!new_section_id) {
			console.error('Error on create the note record:', api_response);
			return null
		}

	// set code (component_number) value wit matrix_id
		const code_tipo	= 'rsc835'
		const source	= create_source({ // source object
			type			: 'component',
			action			: 'save',
			model			: null,
			tipo			: code_tipo,
			section_tipo	: notes_section_tipo,
			section_id		: new_section_id,
			mode			: 'list',
			view			: null,
			lang			: page_globals.dedalo_data_nolan
		}, null)
		const code_rqo = {
			action	: 'save',
			source	: source,
			data : {
				section_id			: new_section_id,
				section_tipo		: notes_section_tipo,
				tipo				: code_tipo,
				lang				: page_globals.dedalo_data_nolan,
				// from_component_tipo	: code_tipo,
				value				: null,
				changed_data : [{
					action	: 'insert',
					key		: 0,
					value	: {value: matrix_id}
				}]
			}
		}
		const code_api_response = await data_manager.request({
			body : code_rqo
		})
		const code_section_id = response_data(code_api_response)
		if (!code_section_id || code_section_id<1) {
			console.error('Error on set matrix note code. code_api_response:', code_api_response);
			return null
		}

	// All is OK
		if(SHOW_DEBUG===true) {
			console.log(`Created a new record in ${notes_section_tipo}:`, new_section_id, matrix_id );
		}


	return new_section_id
}//end add_component_history_note



/**
* BUILD_TAG
* Build a new annotation when user clicks on text editor button
*
* Responds to a toolbar button press (typically F2 keybinding or toolbar icon) by
* publishing 'key_up_f2_<id_base>' and collecting all subscriber responses. Each
* response is a data_tag descriptor from an annotation panel that is currently
* listening (e.g. tool_indexation, component_geolocation).
*
* For each response the method:
*   - Calculates the next sequential tag_id.
*   - Dispatches to type-specific creation logic via a switch:
*       'draw'  → render_layer_selector (callback: create_draw_tag)
*       'geo'   → render_layer_selector (callback: create_geo_tag)
*       'page'  → render_page_selector (modal)
*       default → build_view_tag_obj + text_editor.set_content
*
* (!) options parameter here is the raw event options from the build_tag_ event,
*     not a structured object. The caller (component_text_area instance) is extracted
*     as options.caller.
*
* @param {Object} options - Event options
* @param {Object} options.caller - The component_text_area instance that owns the editor
* @param {Object} options.text_editor - The service_ckeditor instance to insert into
* @returns {void}
*/
component_text_area.prototype.build_tag = function(options) {

	// options
		// component_text_area instance
		const self = options.caller
		// get the text_editor sent by the event (button_note event)
		const text_editor = options.text_editor

	const susbscriptors_responses			= event_manager.publish('key_up_f2' +'_'+ self.id_base, 'F2')
	const susbscriptors_responses_length	= susbscriptors_responses.length

	// iterate subscription responses
	for (let i = 0; i < susbscriptors_responses_length; i++) {
		const data_tag	= susbscriptors_responses[i]

		// last_tag_id. Find last geo and returns id or 0
			const last_tag_index_id = self.get_last_tag_id(data_tag.type, text_editor)

		// if the linked component create a tag_id, use it (as tc) otherwise get the last tag id and add 1
			const tag_id = (!data_tag.tag_id)
				// tag_id. Last id plus one
				? parseInt(last_tag_index_id) + 1
				: data_tag.tag_id;

		// set the tag_id into the tag data
		data_tag.tag_id = tag_id

		switch(data_tag.type) {

			case ('draw'):
				// open layer selector
				const layer_selector = render_layer_selector({
					self		: self,
					data_tag	: data_tag,
					text_editor	: text_editor,
					callback	: self.create_draw_tag.bind(self)
				})
				if (layer_selector) {
					self.node.appendChild(layer_selector)
				}
				break;

			case ('geo'): {
				// open layer selector
				 const layer_selector = render_layer_selector({
					self		: self,
					data_tag	: data_tag,
					text_editor	: text_editor,
					callback	: self.create_geo_tag.bind(self)
				})
				if (layer_selector) {
				 	self.node.appendChild(layer_selector)
				}
				break;
			}

			case ('page'): {
				// modal selector
				render_page_selector(self, data_tag, tag_id, text_editor)
				break;
			}

			default: {
				const tag = self.build_view_tag_obj(data_tag, tag_id)
				if (tag) {
					text_editor.set_content(tag)
				}
				break;
			}
		}// end switch
	}
}//end build_tag



/*	Persons
----------------------------------------------------------------------------------------- */



/*	Notes
----------------------------------------------------------------------------------------- */

	/**
	* CREATE_NEW_NOTE
	* Build a new annotation when user clicks on text editor button
	*
	* Creates a new section record in the notes matrix (identified by
	* self.context.features.notes_section_tipo) and returns the new section_id.
	* The note tag <img> node is inserted into the editor separately by the caller.
	*
	* @param {Object} options - Creation options
	* @param {Object} options.text_editor - The service_ckeditor instance (passed for context)
	* @returns {Promise<string|null>} The newly created note section_id, or null on failure
	*/
	component_text_area.prototype.create_note_tag = async function(options) {

		const self = this

		// options
			const text_editor = options.text_editor // get the text_editor sent by the event (button_note event)

		// short vars
			const notes_section_tipo = self.context.features.notes_section_tipo

		// Create the new note in the server, it will send the section_id created in the database
			const rqo = {
				action	: 'create',
				source	: {
					section_tipo : notes_section_tipo
				}
			}
			const api_response = await data_manager.request({
				body:rqo
			})
			const note_section_id = response_data(api_response) || null;


		return note_section_id;
	}//end create_new_note



/*	Geo location
----------------------------------------------------------------------------------------- */

	/**
	* CREATE_GEO_TAG
	* Build a new annotation when user clicks on text editor button
	* It is called wen user press F2 in the keyboard
	*
	* Inserts a new 'geo' tag <img> node at the current caret position.
	* The tag_id is assigned sequentially after the last existing 'geo' tag in the editor.
	* The actual geolocation data (coordinates, layers) is managed by the geo tool panel
	* and linked via the tag_id; this method only handles the editor side of the workflow.
	*
	* @param {Object} options - Geo tag creation options
	* @param {Object} options.data_tag - Tag descriptor:
	*   {data:[1], label:'15.1', last_layer_id: 3, layers: [{},{}], state: 'n', tag_id: 15, type: 'geo'}
	* @param {Object} options.text_editor - service_ckeditor instance to insert into
	* @returns {boolean} Result of text_editor.set_content (true on success)
	*/
	component_text_area.prototype.create_geo_tag = function(options) {

		const self = this

		// get the text_editor sent by the event (button_note event)
		const text_editor = options.text_editor

		// last_tag_id. Find last geo and returns id or 0
		const last_tag_index_id = self.get_last_tag_id('geo', text_editor)

		// tag_id. Last id plus one
			const tag_id = parseInt(last_tag_index_id) + 1

		// create new string wrapping selection with new tags
		// tag state. Default is 'n' (normal)
			const tag_state = 'n';

		// tag images
			const geo_view_tag  = self.build_view_tag_obj({
				type	: 'geo',
				state	: tag_state,
				label	: tag_id,
				data	: ''
			}, tag_id)

		// insert the new note tag in the caret position of the text_editor
		const inserted = text_editor.set_content(geo_view_tag)


		return inserted
	}//end create_geo_tag



/*	References
----------------------------------------------------------------------------------------- */

	/**
	* CREATE_REFERENCE
	* Build a new virtual section of reference when user clicks on text editor button
	*
	* Creates a new section record in the references matrix
	* (self.context.features.references_section_tipo) and returns the new section_id.
	*
	* (!) BUG (pre-existing, do not fix): The 'create' API call at line ~1564 uses
	*     `notes_section_tipo` (undefined in this scope) instead of
	*     `references_section_tipo`. The variable `references_section_tipo` is correctly
	*     declared but never used. This means the API request will fail with a ReferenceError.
	*
	* @param {Object} options - Creation options
	* @param {Object} options.text_editor - The service_ckeditor instance (passed for context)
	* @returns {Promise<string|null>} The new section_id on success, or null on failure
	*/
	component_text_area.prototype.create_reference = async function(options) {

		const self = this

		// options
			const text_editor = options.text_editor // get the text_editor sent by the event (button_note event)

		// short vars
			const references_section_tipo	= self.context.features.references_section_tipo
			const references_component_tipo	= self.context.features.references_component_tipo

		// Create the new note in the server, it will send the section_id created in the database
			const rqo = {
				action	: 'create',
				source	: {
					section_tipo : references_section_tipo
				}
			}
			const api_response = await data_manager.request({
				body:rqo
			})
			const note_section_id = response_data(api_response) || null;


		return note_section_id;
	}//end create_reference



/*	Draw
----------------------------------------------------------------------------------------- */

	/**
	* CREATE_DRAW_TAG
	* Build a new annotation when user clicks on text editor button
	*
	* Inserts a 'draw' type tag <img> node at the current caret using the
	* data_tag descriptor already populated by build_tag (which includes a
	* validated tag_id from the layer tool response).
	* The function does not compute a new tag_id — callers must set data_tag.tag_id first.
	*
	* (!) No return value — the result of text_editor.set_content (inserted_tag) is
	*     captured but not returned. Callers cannot confirm insertion success.
	*
	* @param {Object} options - Draw tag options
	* @param {Object} options.data_tag - Tag descriptor with type:'draw' and tag_id already set
	* @param {Object} options.text_editor - service_ckeditor instance to insert into
	* @returns {void}
	*/
	component_text_area.prototype.create_draw_tag = function(options) {

		const self = this

		const data_tag = options.data_tag

		// get the text_editor sent by the event (button_note event)
		const text_editor = options.text_editor

		// tag images
			const draw_view_tag  = self.build_view_tag_obj(data_tag, data_tag.tag_id)

		// const tag = self.build_view_tag_obj(draw_view_tag, tag_id)
		// insert the new note tag in the caret position of the text_editor
		const inserted_tag = text_editor.set_content(draw_view_tag)

	}//end create_draw_tag



/**
* CHANGE_LANG
* Set in Ontology properties client observer like:
 {
	"client": {
		"info": "Sync selector value with the transcription lang. Is called on render/change value 'Original lang' selector",
		"event": "change_lang_value",
		"perform": {
		  "function": "change_lang"
		}
	},
	"component_tipo": "rsc263"
 }
*
* Switches the component's active language and triggers a refresh to re-render the
* content for the new language. If the component is not yet in 'rendered' state,
* retries with an exponential-delay strategy (up to 4 attempts, 300ms apart).
* Silently returns false if the requested lang matches the current one.
*
* @param {string|null} lang - BCP-47 language code to switch to, e.g. 'lang_es'
* @param {number} [n_try=1] - Internal retry counter; callers should never set this
* @returns {Promise<boolean>} true after successful refresh, false when skipped or exceeded retries
*/
component_text_area.prototype.change_lang = async function(lang, n_try=1) {

	const self = this

	// lang check
		if (!lang || lang===self.lang) {
			return false
		}

	// n_try check
		if (n_try>4) {
			console.error('Unable to sync lang after 4 attempts', lang);
			return false
		}

	if (self.status==='rendered') {

		self.lang = lang
		await self.refresh()

	}else{

		// try new attempt after some ms
		setTimeout(async function(){
			self.change_lang(lang, n_try + 1)
		}, 300)
		return false
	}


	return true
}//end change_lang



/**
* FOCUS_FIRST_INPUT
* Allow focus editor area from service
*
* Focuses the CKEditor editing view (the contenteditable area). If the editor
* instance is not yet ready (e.g. called before auto_init_editor completes),
* subscribes to the 'editor_ready_<id>' event and defers the focus call until
* the service emits readiness.
*
* @returns {boolean} Always true (focus may be deferred if editor is not ready yet)
*/
component_text_area.prototype.focus_first_input = function() {

	const self = this

	// Bring the component on screen first, independent of editor readiness.
	// The CKEditor is lazy-initialised on viewport entry, so relying on
	// service.focus() to scroll deadlocks when the component is restored
	// off-screen (restore_section_selection): the scroll would wait for the
	// editor, but the editor only initialises once the component is scrolled
	// into view. Scrolling the wrapper directly (like component_svg) breaks
	// the cycle; block:'nearest' is a no-op when it is already visible (normal
	// click case). Deferred one frame so the section layout has settled.
	const wrapper = self.node
	if (wrapper && typeof wrapper.scrollIntoView==='function') {
		requestAnimationFrame(() => {
			// only when fully off-screen: on a wrapper taller than the viewport
			// 'nearest' still aligns its top, so a click inside a long text jumped
			const rect = wrapper.getBoundingClientRect()
			const off_screen = rect.bottom < 0 || rect.top > window.innerHeight
			if (self.active && off_screen) {
				wrapper.scrollIntoView({ block: 'nearest', inline: 'nearest' })
			}
		})
	}

	const service = self.text_editor[0]?.editor
	if (service) {

		service.focus()

	}else{

		const editor_ready_handler = (service) => {
			service.focus()
		}
		self.events_tokens.push(
			event_manager.subscribe('editor_ready_' + self.id, editor_ready_handler)
		)
	}


	return true
}//end focus_first_input



/**
* SELECT_TAG
* Select and scroll to the index tag identified by `tag_id`, as if the user had
* clicked it in the editor.
*
* This is the entry point used to OPEN a tool already positioned on one tag —
* the indexation grid's tag buttons carry a tag_id and expect the tool to land
* on that fragment rather than at the top of the transcription.
*
* (!) It deliberately does NOT re-implement selection/scrolling: it resolves the
* tag's full attribute set from the editor view and republishes the very event
* the real click publishes (`click_tag_index_<id_base>`). Everything downstream —
* component activation, `set_selection_from_tag`, `scroll_to_selection`, and the
* tool_indexation panels that subscribe to the same event (state selector, delete
* button, note) — then behaves identically to a user click. Synthesising a
* `{tag_id}`-only object instead would light up the panels with an undefined
* state and a missing note.
*
* Editor readiness: the CKEditor service is created asynchronously, and this is
* normally called right after the tool renders, so the editor is usually NOT
* ready yet. In that case the call defers itself on `editor_ready_<id>` and
* retries once.
*
* @param {string|number} tag_id - Tag identifier to select (matched as a string,
*   which is how the tag attributes are stored in the view).
* @returns {boolean} true when the tag was found and the event published; false
*   when deferred, when the editor is unavailable, or when no such tag exists.
*/
component_text_area.prototype.select_tag = function(tag_id) {

	const self = this

	// tag_id check. An absent tag is a no-op, not an error: most tool opens
	// carry no tag at all.
		if (tag_id===null || tag_id===undefined || tag_id==='') {
			return false
		}

	// short vars
		const key			= 0; // key (only one editor is available but component could support multiple)
		const text_editor	= self.text_editor[key]

	// editor readiness. Defer once on the service's own ready event.
		if (!text_editor || !text_editor.editor || !text_editor.editor.editing) {

			const editor_ready_handler = () => {
				self.select_tag(tag_id)
			}
			self.events_tokens.push(
				event_manager.subscribe('editor_ready_' + self.id, editor_ready_handler)
			)

			return false
		}

	// tag attributes. Resolve the whole tag from the view ('indexIn' is the
	// opening marker of the pair; set_selection_from_tag derives 'indexOut'
	// from it).
		const tag = text_editor.get_view_tag_attributes({
			type	: 'indexIn',
			tag_id	: String(tag_id)
		})
		if (!tag) {
			console.warn('Ignored select_tag. Tag not found in editor. tag_id:', tag_id);
			return false
		}

	// publish. Same event the user click publishes (see click_tag_index_handler)
		event_manager.publish('click_tag_index_' + self.id_base, {tag: tag})


	return true
}//end select_tag



// @license-end
