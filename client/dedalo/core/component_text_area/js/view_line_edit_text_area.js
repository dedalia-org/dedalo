// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value, render_fallback_value} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'



/**
* VIEW_LINE_EDIT_TEXT_AREA
* Compact single-line rich-text editor view for component_text_area.
*
* This module implements the 'line' display variant used when a
* text-area component is rendered inside a list row or other space-constrained
* context (e.g. edit_in_list mode). It differs from view_default_edit_text_area
* in that:
*
*   - The wrapper is built WITHOUT a header label node (label: null).
*   - The toolbar is intentionally slim: bold / italic / underline / undo / redo /
*     button_save only — no find-and-replace, html-source, or semantic-tag buttons.
*   - Editor initialisation is deferred to first mousedown (or immediate if
*     auto_init_editor === true or render_level === 'content').
*
* The 'print' view is NOT handled here: it routes to the default view (it must
* keep its header label), read-only via self.permissions = 1 set upstream.
*
* Exported symbol:
*   view_line_edit_text_area  — static namespace; only the .render() method is
*                               used externally.
*/
export const view_line_edit_text_area = function() {

	return true
}//end view_line_edit_text_area



/**
* RENDER
* Render node for use in modes: edit, edit_in_list
*
* Entry point called by render_edit_component_text_area.prototype.edit when
* self.context.view === 'line'.
*
* When render_level === 'content' the function returns the bare content_data
* node (an HTMLElement with per-entry child nodes) so the caller can splice it
* into an existing wrapper without rebuilding it. For any other render_level the
* function builds and returns the full component wrapper via
* ui.component.build_wrapper_edit, which also holds a direct pointer to
* content_data as wrapper.content_data.
*
* Side effect: sets self.render_level so downstream helpers (e.g. auto_init_editor
* defaulting logic) can read it.
*
* @param {Object} self - component_text_area instance; must expose .data, .context,
*                        .permissions, .render_level, .show_interface, .auto_init_editor,
*                        .service_text_editor, .service_text_editor_instance, .text_editor,
*                        .events_tokens, .id, .view, .lang, .tags_to_html()
* @param {Object} options - render options
* @param {string} [options.render_level='full'] - 'full' builds the whole wrapper;
*        'content' returns only the content_data node
* @returns {Promise<HTMLElement>} wrapper node (render_level 'full') or content_data
*          node (render_level 'content')
*/
view_line_edit_text_area.render = async function(self, options) {
	// render_level
		const render_level = options.render_level || 'full'
		// fix render_level
		self.render_level = render_level

	// content_data
		const content_data = get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			label			: null
		}

		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data

	return wrapper
}//end render



/**
* GET_CONTENT_DATA_EDIT
* Build the content_data container and populate it with one content_value node
* per entry in self.data.entries.
*
* Iterates self.data.entries (the array of datum objects held by this component).
* Each entry produces either a read-only node (permissions === 1) or a full
* editable node with deferred CKEditor initialisation (permissions >= 2).
*
* When entries is empty the loop still runs once (value_length defaults to 1)
* so that a single blank editor slot is rendered, ready to accept new input.
*
* The resulting content_data node holds numeric index properties (content_data[0],
* content_data[1], …) that point to each child content_value node for direct
* access from callers.
*
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} content_data node containing one content_value per entry
*/
const get_content_data_edit = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []


	// content_data
		const content_data = ui.component.build_content_data(self)

	// values (inputs)
		const inputs_value	= entries // is array
		const value_length	= inputs_value.length || 1
		for (let i = 0; i < value_length; i++) {
			// get the content_value
			const content_value = (self.permissions===1)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self)
			// add node to content_data
			content_data.appendChild(content_value)
			// set pointers
			content_data[i] = content_value
		}

	return content_data
}//end get_content_data_edit



/**
* GET_CONTENT_VALUE
* Build a single editable entry node and wire up the CKEditor service.
*
* Constructs the DOM skeleton for one text-area entry:
*   content_value
*     ├── toolbar_container   (hidden initially; revealed by the editor service)
*     └── value_container     (editor mount point; receives the CKEditor instance)
*
* The CKEditor instance (self.service_text_editor) is NOT created immediately.
* Initialisation is deferred in one of two ways:
*
*   a) auto_init_editor === true (or render_level === 'content'):
*      A dd_request_idle_callback is scheduled so that the heavy editor
*      initialisation runs asynchronously after the current paint cycle.
*
*   b) Otherwise (default for render_level 'full'):
*      A one-shot 'mousedown' listener on content_value initialises the editor
*      on first user interaction and removes itself immediately afterwards to
*      prevent duplicate initialisations.
*
* Fallback value handling:
*   get_fallback_value() may return HTML-tagged strings (e.g. <em>fallback</em>).
*   get_fallback_value_clean() lazily strips all tags via a temporary DOM node,
*   producing plain text suitable for the CKEditor placeholder attribute.
*
* Once the editor is ready it is stored in both:
*   self.service_text_editor_instance[i]  — the raw service instance
*   self.text_editor[i]                   — the activated editor (same object)
*
* An 'editor_ready_{self.id}' event is published via event_manager so that
* tool_indexation and other observers can attach after editor boot.
*
* The dataframe glue (attach_item_dataframe) is appended outside the editor
* value_container so that dataframe nodes are never swallowed by CKEditor.
*
* @param {number} i - zero-based entry index within self.data.entries
* @param {Object|undefined} current_value - datum object for this entry; shape:
*        { value: string|null }  where value is the stored HTML content string,
*        or undefined when the entry slot is empty (new record)
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} content_value node ready to be appended to content_data
*/
const get_content_value = (i, current_value, self) => {

	// get fallback when current_value is empty
	// clean fallback to only text
		const data					= self.data || {}
		const entries				= data.entries || []
		const ar_fallback_value		= data.fallback_value || []
		const fallback				= render_fallback_value(entries, ar_fallback_value, self.context.render_class)
		const dirty_fallback_value	= fallback[i]
	// clean fallback of any tag (deferred until needed)
		let fallback_value = null
		const get_fallback_value_clean = () => {
			if (fallback_value !== null) {
				return fallback_value
			}
			const fallback_fragment = document.createDocumentFragment()
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: render_value(dirty_fallback_value, self.context.render_class),
				parent			: fallback_fragment
			})
			fallback_value = fallback_fragment.firstChild.innerText
			return fallback_value
		}

	// value_string is a raw html without parse into nodes (txt format)
		const value_string = current_value?.value
			? render_value(self.tags_to_html(current_value.value), self.context.render_class)
			: null

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// toolbar_container
		const toolbar_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_container hide',
			parent			: content_value
		})

	// value_container
		const value_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value_container editor_container',
			inner_html 		: value_string,
			parent			: content_value
		})
		// placeholder_node. Create a Place placeholder if no value found
		const placeholder_node = (!value_string)
			? ui.create_dom_element({
				element_type	: 'p',
				class_name		: 'placeholder ck-placeholder',
				inner_html		: render_value(get_fallback_value_clean(), 'text'),
				parent			: value_container
			  })
			: null

	// init_current_service_text_editor
		const init_current_service_text_editor = async function() {

			// permissions check
				if (!self.permissions || parseInt(self.permissions)<2) {
					return
				}

			// placeholder_node. Remove it from value_container
				if (placeholder_node) {
					placeholder_node.remove()
				}

			// service_editor. Fixed on init
				const current_service_text_editor = new self.service_text_editor()

			// fix service instance with current input key
				self.service_text_editor_instance[i] = current_service_text_editor

			// toolbar. create the toolbar base
				// (!) Intentionally narrow: only the most essential formatting controls.
				// view_default_edit_text_area additionally provides find_and_replace,
				// html_source, and semantic-tag buttons (person, geo, draw, note, etc.).
				const toolbar = ['bold','italic','underline','|','undo','redo','|', 'button_save']
				// toolbar add custum_buttons
					if(self.context?.toolbar_buttons){
						toolbar.push(...self.context.toolbar_buttons)
					}

			// editor_config
				const editor_config = {
					toolbar			: toolbar, // array of strings like ['bold','italic']
					custom_buttons	: get_custom_buttons(self, current_service_text_editor, i),
					custom_events	: get_custom_events(self, i, current_service_text_editor),
					read_only		: self.show_interface.read_only || false
				}

			// init editor
				await current_service_text_editor.init({
					caller				: self,
					value_container		: value_container,
					toolbar_container	: toolbar_container,
					fallback_value		: get_fallback_value_clean(),
					key					: i,
					editor_config		: editor_config,
					editor_class		: 'ddEditor' // ddEditor | InlineEditor
				})

			// fix current_service_text_editor when is ready
				self.text_editor[i] = current_service_text_editor

			// permissions <2 turn editor read only
				// if (!self.permissions || parseInt(self.permissions)<2) {
				// 	current_service_text_editor.editor.enableReadOnlyMode(
				// 		current_service_text_editor.editor.id
				// 	)
				// }

			// event ready
				event_manager.publish(
					'editor_ready_' + self.id,
					current_service_text_editor
				)

			return current_service_text_editor
		}//end init_current_service_text_editor


	// user click in the wrapper and init the editor. When it's not read only
		if (self.show_interface.read_only !== true && self.permissions > 1) {

			const auto_init_editor = self.auto_init_editor!==undefined
				? self.auto_init_editor
				: (self.render_level==='content') ? true : false
			// const auto_init_editor = true
			if (auto_init_editor===true) {

				// activate now
				value_container.classList.add('loading')
				// use timeout only to force real async execution
				dd_request_idle_callback(
					() => {
						init_current_service_text_editor()
						.then(() => {
							value_container.classList.remove('loading')
						})
						.catch((error) => {
							value_container.classList.remove('loading')
							console.error('[get_content_value] Error auto-initializing text editor:', error)
						})
					}
				)

			}else{

				// activate on user click

				// click event
				const click_handler = function(e) {
					e.stopPropagation()

					value_container.classList.add('loading')

					// init editor on user click
					init_current_service_text_editor()
					.then(function(service_editor) {
						value_container.classList.remove('loading')
						if (self.context?.view === 'html_text') {
							service_editor.editor?.focus()
						}else{
							// trigger service_editor click action (show toolbar and focus it)
							service_editor?.click?.(e)
						}
					})
					.catch(function(error) {
						value_container.classList.remove('loading')
						console.error('[get_content_value] Error initializing text editor on click:', error)
						// the listener was removed up front; re-arm it so a failed
						// LOAD is retried by a click instead of leaving the component
						// dead until a reload. Only when no editor was produced — a
						// failure AFTER the editor attached must not build a second one.
						if (!self.service_text_editor_instance[i]?.editor) {
							content_value.addEventListener('mousedown', click_handler)
						}
					})
					// once only. Remove event to prevent duplicates
					content_value.removeEventListener('mousedown', click_handler)
				}//end click_handler
				content_value.addEventListener('mousedown', click_handler)
			}
		}//end if (self.show_interface.read_only!==true)

	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
	// appended to content_value, outside the CKEditor value_container
		attach_item_dataframe({
			self		: self,
			item		: current_value,
			container	: content_value,
			view		: self.view
		})


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a read-only display node for a single entry.
*
* Used when self.permissions === 1 (view-only access). No editor service is
* created and no event listeners are attached. The stored HTML is rendered
* directly via tags_to_html (which converts internal tag markers to visible
* HTML representations) and injected as inner_html.
*
* The CSS class 'read_only' on content_value disables pointer interactions via
* the stylesheet and signals to parent tools that no editing is possible.
*
* @param {number} i - zero-based entry index (unused in the body but kept for
*        signature parity with get_content_value)
* @param {Object|undefined} current_value - datum object; { value: string|null }
* @param {Object} self - component_text_area instance; must expose .tags_to_html()
* @returns {HTMLElement} content_value node with class 'content_value editor_container read_only'
*/
const get_content_value_read = (i, current_value, self) => {

	// value is a raw html without parse into nodes (txt format)
		const value = render_value(self.tags_to_html(current_value?.value), self.context.render_class)

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value editor_container read_only',
			inner_html		: value
		})

	return content_value
}//end get_content_value_read




/**
* GET_CUSTOM_BUTTONS
* Build the custom-button descriptor array for the slim line-edit toolbar.
*
* Returns an array of button descriptor objects consumed by the text-editor
* service (service_ckeditor). Each descriptor has the shape:
*   {
*     name           : string   — button identifier used by the toolbar slot array
*     manager_editor : boolean  — true: the editor service manages the button
*                                 state (active/disabled) itself; false: Dédalo
*                                 manages the click handler directly
*     options        : Object   — tooltip, image path, class_name, onclick handler
*   }
*
* The 'line' view toolbar is intentionally minimal:
*   separator | bold | italic | underline | undo | redo | button_save
*
* button_save calls text_editor.save() directly (which in turn delegates to the
* component's save_value() method) rather than relying on a blur/auto-save
* mechanism. The save label text is stripped of HTML tags via a regex before
* display.
*
* @param {Object} self - component_text_area instance (needed for label lookups)
* @param {Object} text_editor - service_text_editor instance bound to entry i;
*        its .save() method is wired to the Save button onclick
* @param {number} i - zero-based entry index (reserved for future per-entry
*        customisation; not currently used inside the function body)
* @returns {Array} array of button descriptor objects
*/
const get_custom_buttons = (self, text_editor, i) => {

	// custom_buttons
	const custom_buttons = []

	// separator
		custom_buttons.push({
			name			: '|',
			manager_editor	: false,
			options	: {
				tooltip		: '',
				image		: '../../core/themes/default/icons/separator.svg',
				class_name	: 'separator',
				onclick		: null
			}
		})

	// bold
		custom_buttons.push({
			name			: "bold",
			manager_editor	: true,
			options	: {
				tooltip	: 'bold',
				image	: '../../core/themes/default/icons/bold.svg'
			}
		})

	// italic
		custom_buttons.push({
			name			: "italic",
			manager_editor	: true,
			options	: {
				tooltip	: 'italic',
				image	: '../../core/themes/default/icons/italic.svg'
			}
		})

	// underline
		custom_buttons.push({
			name			: "underline",
			manager_editor	: true,
			options	: {
				tooltip	: 'underline',
				image	: '../../core/themes/default/icons/underline.svg'
			}
		})

	// undo
		custom_buttons.push({
			name			: "undo",
			manager_editor	: true,
			options	: {
				tooltip		: 'undo',
				image		: '../../core/themes/default/icons/undo.svg',
				class_name	: 'disable'
			}
		})

	// redo
		custom_buttons.push({
			name			: "redo",
			manager_editor	: true,
			options	: {
				tooltip		: 'redo',
				image		: '../../core/themes/default/icons/redo.svg',
				class_name	: 'disable'
			}
		})

	// button_save
		const save_label = get_label.save.replace(/<\/?[^>]+(>|$)/g, "") || "Save"
		custom_buttons.push({
			name			: 'button_save',
			manager_editor	: false,
			options	: {
				text	: save_label,
				tooltip	: save_label,
				icon	: false,
				onclick	: function(e) {
					// save. text_editor save function calls current component save_value()
					text_editor.save()
				}
			}
		})


	return custom_buttons
}//end get_custom_buttons



/**
* GET_CUSTOM_EVENTS
* Build the custom-event handler map for the CKEditor service instance.
*
* Returns a plain object whose keys are CKEditor event names and whose values
* are handler functions. The service_ckeditor calls these after forwarding the
* raw CKEditor event so Dédalo logic remains decoupled from the editor library.
*
* Handlers defined here:
*
*   focus       — Activates the component via ui.component.activate(self) when it
*                 is not already the active component. This ensures the inspector
*                 panel and toolbar update to reflect this component's context.
*
*   click       — Prevents default browser and event-propagation behaviour for all
*                 clicks inside the editor. The line view does not implement
*                 tag-type routing (tc, indexIn/Out, geo, draw, etc.); those are
*                 only needed in the full-size view_default_edit_text_area.
*
*   KeyUp       — Handles two keyboard shortcuts:
*                   NumpadEnter → save immediately (same as clicking Save button)
*                   Tab         → suppressed entirely to prevent focus jumping to
*                                 the next browser tab stop while editing inline.
*
*   changeData  — Delegates to self.change_data_handler(options) whenever the
*                 editor's internal data changes (key strokes, paste, undo, etc.).
*                 This is the primary dirty-tracking pathway for the component.
*
* @param {Object} self - component_text_area instance; must expose .active,
*        .change_data_handler(), and .context.features
* @param {number} i - zero-based entry index (available to closures; currently
*        used implicitly via the outer text_editor binding)
* @param {Object} text_editor - service_text_editor instance; its .save() method
*        is called from the KeyUp NumpadEnter handler
* @returns {Object} custom_events map keyed by event name
*/
const get_custom_events = (self, i, text_editor) => {

	const custom_events	= {}
	const features		= self.context.features || {}

	// focus
		custom_events.focus = (evt, options) => {
			if (!self.active) {
				ui.component.activate(self)
			}
		}//end focus

	// click
		custom_events.click = (evt, options) => {
			// use the observe property into ontology of the components to subscribe to this events
			// img : click on img
			evt.preventDefault()
			evt.stopPropagation()
		}//end click

	// keyup
		custom_events.KeyUp = (evt, options) => {

			// use the observe property into ontology of the components to subscribe to this events
			switch(true) {

				// NumpadEnter (enter key from numeric keyboard)
				case (evt.code==='NumpadEnter'):
					evt.preventDefault()
					text_editor.save()
					break;

				// Tab
				case evt.code==='Tab': {
					evt.stopPropagation()
					// prevent to jump cursor to another input
					evt.preventDefault()
					break;
				}
			}
		}//end KeyUp

	// changeData
		custom_events.changeData = (evt, options) => {
			self.change_data_handler(options)
		}//end changeData event


	return custom_events
}//end get_custom_events



// @license-end
