// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value, render_fallback_value} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'
	import {get_instance} from '../../common/js/instances.js'
	import {pause, url_vars_to_object, same_section_id} from '../../common/js/utils/index.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {LZString as lzstring} from '/dedalo/lib/lz-string/lz-string.js'
	import {render_draw} from './render_draw.js'



/**
* VIEW_DEFAULT_EDIT_TEXT_AREA
* Default edit-mode view module for component_text_area.
*
* Responsible for building the full CKEditor-backed rich-text editing UI used
* when context.view is 'default' or 'html_text'. Key exports:
*
*   view_default_edit_text_area         — constructor shell (no state; exists so
*                                         its static methods can be called as a
*                                         namespace and the module is importable
*                                         by render_edit_component_text_area.js)
*   view_default_edit_text_area.render  — main async factory: builds the wrapper
*                                         DOM node that contains the editor
*   build_node_tag                      — public helper that converts a serialised
*                                         Dédalo tag descriptor into an <img> DOM
*                                         node (used by service_ckeditor to render
*                                         index, draw, geo, tc, page … tags inline
*                                         inside the editor content)
*
* Internal (non-exported) helpers:
*   get_content_data_edit       — iterates data.entries and dispatches each slot
*                                 to get_content_value (edit) or
*                                 get_content_value_read (read-only)
*   get_content_value           — builds one editable rich-text slot including
*                                 the CKEditor init logic and all event wiring
*   get_content_value_read      — builds a static read-only HTML view of one slot
*   get_buttons                 — assembles the component's outer button bar
*   get_custom_buttons          — returns the ordered list of CKEditor toolbar
*                                 button descriptors consumed by service_ckeditor
*   get_custom_events           — returns the event-handler map consumed by
*                                 service_ckeditor for focus, click, keyup, etc.
*   render_note                 — opens a modal showing (or creating) a linked
*                                 note section
*   render_persons_list         — opens a modal listing person tags available for
*                                 quick insertion
*   render_langs_list           — opens a modal listing project languages for
*                                 quick lang-tag insertion
*
* Tag types handled in get_custom_events.click:
*   tc, indexOut, indexIn, svg, draw, geo, page, person, note, lang, reference
*
* Keyboard shortcuts wired in get_custom_events.KeyUp:
*   NumpadEnter              → save
*   av_player.av_play_pause_code (Escape by default) → publish key_up_esc event
*   av_player.av_insert_tc_code (F2 by default)      → build_tag (timecode/draw)
*   Ctrl+0..9               → insert person tag by index
*   Ctrl+Shift+0..9         → insert lang tag by index
*   Tab                     → suppress default browser focus-move behaviour
*/
export const view_default_edit_text_area = function() {

	return true
}//end view_default_edit_text_area



// LARGE_VALUE_DEFER_LENGTH
// Values longer than this (in characters) are NOT converted with tags_to_html
// nor parsed into DOM at render time: a full PDF transcription can exceed 2 MB
// of HTML, and the eager regex pass + innerHTML parse + layout of the resulting
// tens of thousands of nodes costs whole seconds of main-thread time at page
// open. Such values render as a cheap plain-text excerpt and materialise only
// when the editor initialises (edit) or on user request (read-only).
const LARGE_VALUE_DEFER_LENGTH = 200000



/**
* BUILD_LARGE_VALUE_PREVIEW
* Build the lightweight placeholder shown instead of a deferred large value:
* a plain-text excerpt of the leading slice plus a size notice. All string work
* runs on a bounded slice, so cost is independent of the value size.
*
* @param {string} raw_value - the full raw (un-converted) value
* @returns {DocumentFragment} preview nodes to append into the value container
*/
const build_large_value_preview = (raw_value) => {

	// plain-text excerpt: strip HTML markup and Dédalo tag serialisation from a
	// bounded leading slice (the slice is generous because stripping shrinks it)
	const excerpt = raw_value
		.slice(0, 6000)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 1000)

	const fragment = new DocumentFragment()
	const preview = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'large_value_preview',
		parent			: fragment
	})
	ui.create_dom_element({
		element_type	: 'p',
		text_content	: excerpt + '…',
		parent			: preview
	})
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'large_value_notice',
		text_content	: (get_label.show_all || 'Show all') + ' (' + Math.round(raw_value.length / 1024) + ' KB)',
		parent			: preview
	})

	return fragment
}//end build_large_value_preview



/**
* RENDER
* Build and return the full component wrapper DOM node for edit and edit_in_list modes.
*
* When render_level is 'content', the function returns only the inner content_data
* node (skipping the outer wrapper and button bar). This is used by internal re-render
* calls that need to refresh only the editing area without rebuilding the surrounding
* chrome.
*
* Side effects:
*   - Sets self.render_level to the resolved render_level value.
*   - Attaches content_data as wrapper.content_data (pointer for later DOM access).
*   - When SHOW_DEVELOPER is true and view !== 'line', appends a lang badge to the label.
*
* (!) SHOW_DEVELOPER is used here but is not listed in the module's global directive.
*     This will trigger an eslint no-undef warning. The global is declared elsewhere
*     (page bootstrap) — document only, do not remove the reference.
*
* @param {Object} self - component_text_area instance
* @param {Object} options - render call options
* @param {string} [options.render_level='full'] - 'full' builds the complete wrapper;
*   'content' returns only the content_data node
* @returns {Promise<HTMLElement>} wrapper node (full mode) or content_data node (content mode)
*/
view_default_edit_text_area.render = async function(self, options) {

	// render_level
		const render_level = options.render_level || 'full'
		// fix render_level
		self.render_level = render_level

	// fix non value scenarios
		// self.data.value = (self.data && self.data.value.length>0)
		// 	? self.data.value
		// 	: [null]

	// content_data
		// Build the editable (or read-only) slot container. Returned early when
		// only the inner area needs to be refreshed, skipping wrapper/button overhead.
		const content_data = get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		// Outer button bar is suppressed entirely for read-only users (permissions <= 1).
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons
		}
		if (self.view==='line') {
			wrapper_options.label = null // prevent to create label node
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data

		// label add lang
		// Developer mode only: append a badge showing the active language code so
		// editors can confirm which language slot they are editing.
		if (SHOW_DEVELOPER===true && self.view!=='line') {
			wrapper.label.innerHTML += ' <span class="note">[' + render_value(self.lang, 'text') + ']</span>'
		}

	// label custom style based on activate/deactivate events. (!) Deactivated 11-02-2023. Moved to inspector)
		// event_manager.subscribe('activate_component', fn_activate_component)
		// function fn_activate_component(component) {
		// 	if (component.id===self.id) {
		// 		wrapper.label.classList.add('move_top')
		// 	}
		// }
		// event_manager.subscribe('deactivate_component', fn_deactivate_component)
		// function fn_deactivate_component(component) {
		// 	if (component.id===self.id) {
		// 		if(wrapper.label.classList.contains('move_top')) {
		// 			wrapper.label.classList.remove('move_top')
		// 		}
		// 	}
		// }

	// fix editor height. This guarantees that content_data grow to the maximum possible height
		// when_in_viewport(wrapper, ()=> {
		// 	const wrapper_height	= wrapper.offsetHeight
		// 	const label_height		= wrapper.label ? wrapper.label.offsetHeight : 0
		// 	wrapper.content_data.style.height = (wrapper_height - label_height) + 'px'
		// 	console.log('wrapper_height calculated but not set:', wrapper_height);
		// })


	return wrapper
}//end render



/**
* GET_CONTENT_DATA_EDIT
* Build the content_data container and populate it with one slot per data entry.
*
* Each entry in self.data.entries becomes a single content_value child node.
* When self.data.entries is empty the loop still runs once (value_length fallback
* to 1) so an empty editor slot is always visible.
*
* Permissions gate: read-only users (permissions === 1) get a static HTML node
* via get_content_value_read; all other users get the full CKEditor wrapper via
* get_content_value.
*
* Side effect: numeric index properties (content_data[0], content_data[1], …)
* are set on the returned node as convenience pointers to each slot.
*
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} content_data node containing all slot children
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
			// dataframe (read-only path): get_content_value attaches the dataframe for
			// writers; the read-only branch (permissions===1, e.g. Time Machine preview)
			// is not handled there, so attach it here too. No-op without has_dataframe.
			if (self.permissions===1) {
				attach_item_dataframe({
					self		: self,
					item		: inputs_value[i],
					container	: content_value,
					view		: self.view
				})
			}
		}

	return content_data
}//end get_content_data_edit



/**
* GET_CONTENT_VALUE
* Build one editable rich-text slot for entry index i.
*
* Structure of the returned node:
*   content_value (div)
*     ├── toolbar_container (div.toolbar_container.hide) — CKEditor toolbar mount point
*     ├── value_container   (div.value_container.editor_container.ck-content.ck)
*     │     [placeholder_node] — shown only when there is no stored value
*     └── [dataframe node]  — appended by attach_item_dataframe when applicable
*
* Editor initialisation strategy (lazy vs. eager):
*   The CKEditor instance (service_ckeditor) is expensive to initialise, so the
*   shared engine (bundle + langs) is warmed at page idle by the view dispatcher
*   (schedule_ckeditor_preload) and only the instance is left for activation:
*     - auto_init_editor === true  → initialise immediately via dd_request_idle_callback
*       (used when the component is opened in 'content' render_level or when explicitly
*        configured via ontology property or tool call, e.g. tool_indexation).
*     - auto_init_editor === false → attach a one-shot mousedown handler on content_value;
*       the editor is created the first time the user clicks inside the component and the
*       handler removes itself to avoid double-init (re-armed if the init fails).
*
* Tag URL pre-selection:
*   After init, the idle callback inspects window.location.search for a `raw_data`
*   LZString-encoded parameter. When the decoded object carries caller_options.tag_id
*   the corresponding indexIn tag is selected in the editor automatically. This supports
*   deep-linking from dd_grid indexation buttons.
*
* Fallback value:
*   Derived from data.fallback_value (API-supplied array of locale-keyed fallbacks).
*   Stripping HTML tags from the fallback is deferred via get_fallback_value_clean()
*   because it requires a DOM parse — only executed when the placeholder is needed or
*   the editor requests it.
*
* @param {number} i - zero-based index into self.data.entries
* @param {Object|undefined} current_value - data entry for slot i; may be undefined
*   when data.entries has fewer items than value_length
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} content_value node (editable slot)
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
		// The fallback may contain HTML tags from the API (inline formatting, tag markers).
		// Strip them by parsing through a temporary DOM node so the plain-text string
		// can be used as the CKEditor placeholder attribute, which must be plain text.
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
		// tags_to_html converts Dédalo tag serialisation to inline <img> placeholders
		// that CKEditor treats as atomic nodes (non-editable images).
		// Large values (see LARGE_VALUE_DEFER_LENGTH) skip the conversion here and
		// materialise in init_current_service_text_editor, just before CKEditor
		// attaches — the editor reads its initial data from value_container, so
		// deferring the DOM build is invisible to it.
		const raw_value				= current_value?.value || null
		const defer_large_value		= raw_value !== null && raw_value.length > LARGE_VALUE_DEFER_LENGTH
		const value_string = (raw_value && !defer_large_value)
			? render_value(self.tags_to_html(raw_value), self.context.render_class)
			: null

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// toolbar_container
		// CKEditor mounts its toolbar here; starts hidden (class 'hide') and is
		// shown by the editor itself once it attaches.
		const toolbar_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_container hide',
			parent			: content_value
		})

	// value_container
		// Pre-populate with converted HTML so the content is visible even before
		// CKEditor initialises (progressive enhancement).
		const value_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'value_container editor_container ck-content ck',
			inner_html 		: value_string,
			parent			: content_value
		})
		// placeholder_node. Create a Place placeholder if no value found
		// Mimics CKEditor's own placeholder styling (.ck-placeholder) so the pre-init
		// DOM looks identical to the post-init state.
		const placeholder_node = (!value_string && !defer_large_value)
			? ui.create_dom_element({
				element_type	: 'p',
				class_name		: 'placeholder ck-placeholder',
				inner_html		: render_value(get_fallback_value_clean(), 'text'),
				parent			: value_container
			  })
			: null

	// deferred large value. Show a cheap plain-text excerpt instead of parsing
	// the multi-MB HTML at page open; materialize_deferred_value swaps in the
	// real content the moment the editor is about to attach.
		if (defer_large_value) {
			value_container.appendChild(build_large_value_preview(raw_value))
		}
		const materialize_deferred_value = () => {
			if (!defer_large_value || value_container.dataset.materialized === 'true') {
				return
			}
			value_container.innerHTML = render_value(self.tags_to_html(raw_value), self.context.render_class)
			value_container.dataset.materialized = 'true'
		}

	// init_current_service_text_editor
		// Closure that creates and wires up one CKEditor instance for this slot.
		// Called either immediately (auto_init) or on first user click.
		const init_current_service_text_editor = async function() {

			// permissions check
				if (!self.permissions || parseInt(self.permissions)<2) {
					return
				}

			// placeholder_node. Remove it from value_container
				// The real CKEditor placeholder will take over once the editor attaches.
				if (placeholder_node) {
					placeholder_node.remove()
				}

			// deferred large value. Build the full HTML now — CKEditor reads its
			// initial data from value_container, so this must precede editor create.
				materialize_deferred_value()

			// service_editor. Fixed on init
				const current_service_text_editor = new self.service_text_editor()

			// fix service instance with current input key
				// Store by index so other parts of the component can reach the raw
				// service instance (e.g. before the editor is fully ready).
				self.service_text_editor_instance[i] = current_service_text_editor

			// toolbar. create the toolbar base
				// Core buttons are always present; custom buttons follow.
				const toolbar = ['bold','italic','underline','|','undo','redo','find_and_replace','html_source','|']
				// toolbar add custum_buttons
					if(self.context?.toolbar_buttons){
						toolbar.push(...self.context.toolbar_buttons)
					}
				// toolbar add standard buttons
					// toolbar.push(...['button_lang','reference','|','button_save'])
					toolbar.push(...['button_lang'])

			// editor_config
				const editor_config = {
					// plugins		: ['paste','image','print','searchreplace','code','noneditable','fullscreen'], // ,'fullscreen'
					toolbar			: toolbar, // array of strings like ['bold','italic']
					custom_buttons	: get_custom_buttons(self, current_service_text_editor, i),
					custom_events	: get_custom_events(self, i, current_service_text_editor),
					read_only		: self.show_interface.read_only || false
				}

			// init editor
				// 'html_text' view uses CKEditor's InlineEditor (no toolbar chrome);
				// all other views use the full ddEditor balloon toolbar variant.
				await current_service_text_editor.init({
					caller				: self,
					value_container		: value_container,
					toolbar_container	: toolbar_container,
					fallback_value		: get_fallback_value_clean(),
					key					: i,
					editor_config		: editor_config,
					editor_class		: self.context?.view==='html_text'
						? 'InlineEditor'
						: 'ddEditor' // ddEditor | InlineEditor
				})

			// fix current_service_text_editor when is ready
				// Exposed on self.text_editor[i] for use by component methods (save_value,
				// build_tag, etc.) once the editor is fully initialised.
				self.text_editor[i] = current_service_text_editor

			// permissions <2 turn editor read only
				// if (!self.permissions || parseInt(self.permissions)<2) {
				// 	current_service_text_editor.editor.enableReadOnlyMode(
				// 		current_service_text_editor.editor.id
				// 	)
				// }

			// event ready
				// Signal to subscribers (e.g. tool_indexation) that the editor for
				// this component id is now interactive.
				event_manager.publish(
					'editor_ready_' + self.id,
					current_service_text_editor
				)

			// tag selected case (URL) Normally from dd_grid indexation tag button
				// When the page was opened via a deep-link carrying a compressed
				// raw_data param, automatically select the referenced tag in the editor
				// so the user lands in the correct indexation context.
				dd_request_idle_callback(
					() => {
						const url_vars = url_vars_to_object(window.location.search)
						const raw_data = url_vars.raw_data ?? null
						if(raw_data) {

							const url_data_string	= lzstring.decompressFromEncodedURIComponent(raw_data)
							const url_data_object	= JSON.parse(url_data_string)
							const tag_id			= url_data_object.caller_options?.tag_id || null
							if(tag_id) {

								// tag. Get the tag object selecting the tag into the text_area editor (get the tag attributes)
								// needed to get the tag state, to show the tag info inside the tool_indexation
								const tag = current_service_text_editor.get_view_tag_attributes({
									type	: 'indexIn',
									tag_id	: tag_id
								})

								// fire the event to select tag
								event_manager.publish('click_tag_index_'+ self.id_base, {tag: tag})
							}
						}
					}
				)//end dd_request_idle_callback


			return current_service_text_editor
		}//end init_current_service_text_editor


	// user click in the wrapper and init the editor. When it's not read only
		if (self.show_interface.read_only !== true && self.permissions > 1) {

			// auto_init_editor resolution order:
			//   1. self.auto_init_editor (set by tool calls or ontology property)
			//   2. true when render_level is 'content' (inline re-render always eager)
			//   3. false (default: lazy init on first click)
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
				// (!) Uses mousedown (not click) so the editor receives focus before
				// any click event on child elements fires, avoiding a missed first click.
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
* Build a static (non-interactive) HTML view of one text-area entry slot.
*
* Used when self.permissions === 1 (view-only access). No CKEditor instance is
* created; the stored HTML is converted via tags_to_html and injected directly.
* The class list mirrors value_container in get_content_value so shared CSS rules
* apply for consistent typography, but the 'read_only' class suppresses editing chrome.
*
* @param {number} i - zero-based index into self.data.entries (not used internally
*   but kept for signature parity with get_content_value)
* @param {Object|undefined} current_value - data entry for slot i
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} content_value node (static, read-only)
*/
const get_content_value_read = (i, current_value, self) => {

	// value is a raw html without parse into nodes (txt format)
		// Large values (see LARGE_VALUE_DEFER_LENGTH) render as a plain-text
		// excerpt; the full HTML parses only when the user clicks the preview.
		const raw_value			= current_value?.value || null
		const defer_large_value	= raw_value !== null && raw_value.length > LARGE_VALUE_DEFER_LENGTH
		const value = (raw_value && !defer_large_value)
			? render_value(self.tags_to_html(raw_value), self.context.render_class)
			: null

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value editor_container read_only',
			inner_html		: value
		})

	// deferred large value. Excerpt now, full content on demand (one-shot click)
		if (defer_large_value) {
			content_value.appendChild(build_large_value_preview(raw_value))
			content_value.addEventListener('click', () => {
				content_value.innerHTML = render_value(self.tags_to_html(raw_value), self.context.render_class)
			}, { once: true })
		}

	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the outer button bar shown above the component for write-access users.
*
* Which buttons appear is controlled by self.show_interface flags (all optional,
* default false):
*   show_interface.tools            → generic tool buttons via ui.add_tools
*   show_interface.button_fullscreen → fullscreen toggle (expands self.node)
*   show_interface.button_save       → explicit save button (calls text_editor[0].save)
*
* Layout: all buttons are collected into a DocumentFragment, then moved into a
* 'buttons_fold' wrapper inside the standard buttons_container so that the fold
* div can use sticky positioning on tall components without the bar scrolling away.
*
* @param {Object} self - component_text_area instance
* @returns {HTMLElement} buttons_container node
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

	// save
		if (show_interface.button_save === true) {

			const save = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button tool save',
				title			: get_label.save || 'Save',
				parent			: fragment
			})
			save.addEventListener('click', fn_save)
			function fn_save(e) {
				e.stopPropagation()
				// (!) Hard-coded index 0: the save button always targets the first
				// (and normally only) editor slot. Multi-slot components would need
				// a separate approach.
				self.text_editor[0].save()
			}
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



/**
* GET_CUSTOM_BUTTONS
* Return the ordered list of custom button descriptors consumed by service_ckeditor.
*
* Each descriptor is an object of the shape:
*   {
*     name           : {string}   — button identifier; '|' creates a visual separator
*     manager_editor : {boolean}  — when true the button is managed by the CKEditor
*                                   plugin (built-in CKEditor command); when false the
*                                   onclick handler below controls behaviour entirely
*     options        : {
*       tooltip      : {string}   — tooltip text shown on hover
*       image        : {string}   — relative path to the SVG icon
*       class_name   : {string}   — optional extra CSS class
*       onclick      : {Function|null} — click handler (only used when manager_editor=false)
*     }
*   }
*
* Buttons in insertion order:
*   separator, bold, italic, underline, undo, redo, find_and_replace, html_source,
*   button_person, button_geo, button_draw, button_note, reference, button_lang
*
* button_person onclick → render_persons_list (modal)
* button_geo onclick    → publishes 'create_geo_tag_{id_base}'
* button_draw onclick   → if the selection is a 'draw' tag: open render_draw modal;
*                         otherwise: publish 'build_tag_{id_base}'
* button_note onclick   → calls self.create_note_tag, then inserts the tag and opens
*                         render_note modal on success
* button_lang onclick   → render_langs_list (modal)
*
* The button_save button is commented-out (deferred; see end of function).
*
* @param {Object} self - component_text_area instance
* @param {Object} text_editor - service_ckeditor instance for this slot
* @param {number} i - zero-based index of this editor slot within data.entries
* @returns {Array} ordered array of button descriptor objects
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

	// find_and_replace
		custom_buttons.push({
			name			: "find_and_replace",
			manager_editor	: true,
			options	: {
				tooltip	: 'find_and_replace',
				image	: '../../core/themes/default/icons/search.svg'
			}
		})

	// html_source
		custom_buttons.push({
			name			: "html_source",
			manager_editor	: true,
			options	: {
				tooltip	: 'html_source',
				image	: '../../core/themes/default/icons/html_source.svg'
			}
		})


	// button_person
		custom_buttons.push({
			name			: "button_person",
			manager_editor	: false,
			options	: {
				tooltip	: 'Show persons list',
				image	: '../../core/themes/default/icons/person.svg',
				onclick	: function(e) {
					e.stopPropagation()
					// event_manager.publish('toggle_persons_list_'+ self.id_base + '_' + i, {
					// 	caller		: self,
					// 	text_editor	: text_editor
					// })
					render_persons_list(self, text_editor, i)
				}
			}
		})

	// button_geo
		custom_buttons.push({
			name			: "button_geo",
			manager_editor	: false,
			options	: {
				tooltip	: 'Add georef',
				image	: '../../core/themes/default/icons/geo.svg',
				onclick	: function(e) {
					e.stopPropagation()
					event_manager.publish('create_geo_tag_'+ self.id_base, {
						caller		: self,
						text_editor	: text_editor
					})
				}
			}
		})

	// button_draw
		custom_buttons.push({
			name			: "button_draw",
			manager_editor	: false,
			options	: {
				tooltip	: 'Add draw_ref',
				image	: '../../core/themes/default/icons/eye.svg',
				onclick	: function(e) {
					e.stopPropagation()
					const tag_selected = text_editor.get_selected_tag()
					if(tag_selected.type === 'draw'){
						// get a default draw tag, it get the layers avalible into the image
						// to be used to create the layer selector into the draw editor.
						// (!) event_manager.publish returns an array of subscriber return values;
						// index 0 is expected to be the layer descriptor from component_image.
						const default_tag = event_manager.publish('key_up_f2' +'_'+ self.id_base, 'F2')

						tag_selected.layers = default_tag[0].layers
						// open the draw modal to get the locator to be assigned
						render_draw({
							self		: self,
							text_editor	: text_editor,
							i			: i,
							tag			: tag_selected,
						})
					}else{
						// No draw tag is currently selected: ask component_image (or another
						// subscriber) to build a fresh tag object via the build_tag event.
						event_manager.publish('build_tag_'+ self.id_base, {
							caller		: self,
							text_editor	: text_editor
						})
					}
				}
			}
		})

	// button_note
		custom_buttons.push({
			name			: "button_note",
			manager_editor	: false,
			options	: {
				tooltip	: 'Add note',
				image	: '../../core/themes/default/icons/note.svg',
				onclick	: function(e) {
					e.stopPropagation()
					event_manager.publish('create_note_tag_'+ self.id_base + '_' + i, {
						caller		: self,
						text_editor	: text_editor
					})
					// create the new tag in the server and get the new note section_id from server response
					self.create_note_tag({
						text_editor	: text_editor
					})
					.then((note_section_id)=>{
						if (note_section_id){
							// create the new locator of the new note section
							const locator = {
								section_tipo	: self.context.features.notes_section_tipo,
								section_id		: note_section_id
							};
							// create the new tag for the note
							const tag_type		='note'
							const last_tag_id	= self.get_last_tag_id(tag_type, text_editor)
							const note_number	= parseInt(last_tag_id) + 1
							const note_tag		= {
								type	: tag_type,
								label	: note_number,
								tag_id	: String(note_number),
								state	: 'a',
								data	: locator
							}
							const tag = self.build_view_tag_obj(note_tag, note_tag.tag_id)
							// insert the new note tag in the caret position of the text_editor
							text_editor.set_content(tag)
							// render and open the note section inside a modal
							render_note({
								self		: self,
								text_editor	: text_editor,
								i			: i,
								tag			: tag
							})
						}
					})
				}
			}
		})

	// button_reference
		custom_buttons.push({
			name			: "reference",
			manager_editor	: true,
			options	: {
				tooltip	: 'Add reference',
				image	: '../../core/themes/default/icons/link.svg'
			}
		})

	// button_lang
		custom_buttons.push({
			name			: 'button_lang',
			manager_editor	: false,
			options	: {
				tooltip	: 'Add lang',
				image	: '../../core/themes/default/icons/lang.svg',
				onclick	: function(e) {
					e.stopPropagation()
					// show the langs list to be selected the new lang for create the new tag
					// event_manager.publish('toggle_langs_list_'+ self.id_base + '_' + i, {
					// 	caller		: self,
					// 	text_editor	: text_editor
					// })
					render_langs_list(self, text_editor, i)
				}
			}
		})

	// button_save
		// const save_label = get_label.save.replace(/<\/?[^>]+(>|$)/g, "") || "Save"
		// custom_buttons.push({
		// 	name			: 'button_save',
		// 	manager_editor	: false,
		// 	options	: {
		// 		text	: save_label,
		// 		tooltip	: save_label,
		// 		icon	: false,
		// 		onclick	: function(e) {
		//			e.stopPropagation()
		// 			// save. text_editor save function calls current component save_value()
		// 			text_editor.save()
		// 		}
		// 	}
		// })


	return custom_buttons
}//end get_custom_buttons



/**
* GET_CUSTOM_EVENTS
* Return the event-handler map consumed by service_ckeditor for one editor slot.
*
* The returned object maps CKEditor event names to handler functions. service_ckeditor
* calls these after applying its own internal processing, so handlers can assume the
* editor is fully ready when they execute.
*
* Handler summary:
*
*   focus        — activates the component (ui.component.activate) if not already active,
*                  making it the current working component for tools such as tool_indexation.
*
*   click        — dispatches tag-type–specific events when the user clicks on an embedded
*                  <img> or <reference> node. Each type publishes a named event so external
*                  tools/components can react (e.g. tool_indexation subscribes to
*                  'click_tag_index_{id_base}'). The 'person' and 'lang' types additionally
*                  open small info modals inline, parsing the tag's data attribute (stored as
*                  JSON with single-quotes that must be replaced before JSON.parse).
*
*   MouseUp      — publishes 'text_selection_{id}' with the current selection string so
*                  other components (e.g. fragment-creation UI) can react to user selections.
*                  Also publishes 'click_no_tag_{id_base}' when evt is falsy (no event object
*                  means a programmatic deselect).
*
*   KeyUp        — keyboard shortcuts for audio/video transcription workflows:
*                    NumpadEnter                              → text_editor.save()
*                    features.av_player.av_play_pause_code   → publish 'key_up_esc_{id_base}'
*                    features.av_player.av_insert_tc_code    → self.build_tag()
*                    Ctrl+digit                              → insert person tag by index
*                    Ctrl+Shift+digit                        → insert lang tag by index
*                    Tab                                     → swallow (prevent focus escape)
*
*   changeData   — delegates to self.change_data_handler for data-change bookkeeping
*                  (dirty-state tracking, syncing to component data model).
*
* (!) Note on 'person' tag data attribute: the HTML stores JSON with single-quotes
*     (e.g. data="{'section_tipo':'dd123','section_id':5}") because CKEditor
*     serialises attribute values inside double-quoted HTML. These must be replaced
*     with double-quotes before JSON.parse. Same applies to the 'lang' tag type.
*
* @param {Object} self - component_text_area instance
* @param {number} i - zero-based index of this editor slot within data.entries
* @param {Object} text_editor - service_ckeditor instance for this slot
* @returns {Object} custom_events map with handler functions for each event name
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

	// blur
		// custom_events.blur = (evt, options) => {
		// 	// save. text_editor save function calls current component save_value()
		// 		text_editor.save()
		// }//end blur

	// click
		custom_events.click = (evt, options) => {
			// use the observe property into ontology of the components to subscribe to this events
			// img : click on img
			// (!) CKEditor delivers the click as a synthetic options object, not a raw DOM Event.
			// options.node_name identifies what was clicked ('img' for inline tag images,
			// 'reference' for CKEditor reference plugin nodes). Only these two cases carry
			// tag metadata; plain text clicks fall through to the else branch.
			evt.preventDefault()
			evt.stopPropagation()

			if(options.node_name==='img' || options.node_name==='reference') {
				const tag_obj = options
				switch(tag_obj.type) {

					case 'tc':
						// Video go to timecode by tc tag
						event_manager.publish('click_tag_tc_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
						break;

					case 'indexOut':
					case 'indexIn':
						// click_tag_index_
						// (!) Note publish 2 events: using 'id_base' to allow properties definition and
						// 'self.id' for specific uses like tool indexation
						// console.log("PUBLISH self.id:",self.id, self.id_base);
						// id_base is shared across all instances of the same component tipo,
						// so ontology-level tools receive every click for that component type.
						event_manager.publish('click_tag_index_'+ self.id_base, {tag: tag_obj})
						break;

					case 'svg' :
						// not defined yet
						break;

					case 'draw' :
						// Load draw editor
						event_manager.publish('click_tag_draw_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
						break;

					case 'geo' :
						// subscribed by component_geolocation from properties like 'numisdata264'
						event_manager.publish('click_tag_geo_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
						break;

					case 'page':
						// PDF go to the specific page
						event_manager.publish('click_tag_pdf_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
						break;

					case 'person': {
						// Show person info
						event_manager.publish('click_tag_person_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})
						// get the locator in string format
						const data_string	= tag_obj.data
						// rebuild the correct locator witht the " instead '
						const data			= data_string.replace(/\'/g, '"')
						// parse the string to object or create new one
						const locator		= JSON.parse(data) || {}
						// get the match of the locator with the tag_persons array inside the instance
						// console.log("self.data:",self.data);
						const tags_persons = self.data.tags_persons || []
						const person = tags_persons.find(el =>
							el.data.section_tipo===locator.section_tipo &&
							el.data.section_id==locator.section_id &&
							el.data.component_tipo===locator.component_tipo
						)
						// if person is available create a node with the full name of the person
						if(person) {

							// save editor changes to prevent conflicts with modal components changes
								// text_editor.save()

							// modal. create new modal with the person full name
								ui.attach_to_modal({
									header	: 'Person info',
									body	: render_value(person.full_name, 'text'), // record data; a string body is parsed as HTML
									footer	: null,
									size	: 'small'
								})
						}
						break;
					}

					case 'note':
						// Show note info
							event_manager.publish('click_tag_note_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})

						// save editor changes to prevent conflicts with modal components changes
							// text_editor.save()

						// modal tag note info
							render_note({
								self		: self,
								text_editor	: text_editor,
								i			: i,
								tag			: tag_obj
							})
						break;

					case 'lang': {
						// Show note info
						event_manager.publish('click_tag_lang_'+ self.id_base, {tag: tag_obj, caller: self, text_editor: text_editor})

						const ar_project_langs		= page_globals.dedalo_projects_default_langs
						const tag_data_lang_string	= tag_obj.data
						// rebuild the correct data with the " instead '
						const data_lang			= tag_data_lang_string.replace(/\'/g, '"')
						// parse the string to object or create new one
						const tag_data_lang		= JSON.parse(data_lang) || []
						// get the object of the lang clicked from all project_langs
						const lang_obj 			= ar_project_langs.find(el => el.value===tag_data_lang[0]) || {label: data_lang}

						// save editor changes to prevent conflicts with modal components changes
							// text_editor.save()

						// modal tag lang info
							ui.attach_to_modal({
								header	: 'Lang info',
								body	: render_value(lang_obj.label, 'text'), // a string body is parsed as HTML
								footer	: null,
								size	: 'small'
							})
						break;
					}

					case 'reference':
						// Show reference info
						event_manager.publish('click_tag_reference_'+ self.id_base, {tag: tag_obj})
						break;

					default:
						// nothing to do here
						break;
				}//end switch evt.target.className
			}else{
				// click_no_tag_
				// event_manager.publish('click_no_tag_'+ self.id_base, {caller: self})
			}//end click on img
		}//end click

	// mouseup
		custom_events.MouseUp = (evt, options) => {

			// user text selection event
				const selection = options.selection
				event_manager.publish('text_selection_'+ self.id, {selection: selection, caller: self})

			// click_no_tag_ . Used by tool_indexation to de-select the active tag
				if (!evt) {
					event_manager.publish('click_no_tag_'+ self.id_base, {caller: self})
				}
		}//end MouseUp

	// keyup
		custom_events.KeyUp = (evt, options) => {

			// use the observe property into ontology of the components to subscribe to this events
			switch(true) {

				// NumpadEnter (enter key from numeric keyboard)
				case (evt.code==='NumpadEnter'):
					evt.preventDefault()
					text_editor.save()
					break;

				// 'Escape'
				case features.av_player && evt.code===features.av_player.av_play_pause_code: {
					evt.stopPropagation()
					evt.preventDefault()

					event_manager.publish('key_up_esc' +'_'+ self.id_base, features.av_player.av_rewind_seconds)
					break;
				}

				// 'F2'
				case features.av_player && evt.code===features.av_player.av_insert_tc_code: {
					evt.stopPropagation()
					evt.preventDefault()

					self.build_tag({
						caller		: self,
						text_editor	: text_editor
					})

					/*
					// publish event and receive subscription responses
					const susbscriptors_responses			= event_manager.publish('key_up_f2' +'_'+ self.id_base, evt.code)
					const susbscriptors_responses_length	= susbscriptors_responses.length

					// debug
						if(SHOW_DEBUG===true) {
							console.log("[view_default_edit_text_area.get_custom_events] susbscriptors_responses (key_up_f2):", susbscriptors_responses);
						}

					// text_editor. get editor and content data
						// const editor_content_data = text_editor.get_editor_content_data()

					// iterate subscription responses
						for (let i = 0; i < susbscriptors_responses_length; i++) {
							const data_tag	= susbscriptors_responses[i]
							const tag_id	= (!data_tag.tag_id)
								? self.get_last_tag_id(data_tag.type, text_editor) + 1
								: data_tag.tag_id;

							switch(data_tag.type) {
								case ('draw'):
									data_tag.tag_id = tag_id
									const layer_selector = render_layer_selector({
										self		: self,
										data_tag	: data_tag,
										text_editor	: text_editor,
										callback	: self.create_draw_tag.bind(self)
									})
									// append layer selector to wrapper
									self.node.appendChild(layer_selector)
									break;
								case ('geo'): {
									data_tag.tag_id = tag_id
									const layer_selector = render_layer_selector({
										self		: self,
										data_tag	: data_tag,
										text_editor	: text_editor,
										callback	: self.create_geo_tag.bind(self)
									})
									// append layer selector to wrapper
									self.node.appendChild(layer_selector)
									break;
								}
								case ('page'): {
									// modal selector
									render_page_selector(self, data_tag, tag_id, text_editor)
									break;
								}
								default: {
									const tag = self.build_view_tag_obj(data_tag, tag_id)
									text_editor.set_content(tag)
									break;
								}
							}//end switch
						}
					*/
					break;
				}

				// ctrl + 0
				case evt.ctrlKey && !evt.shiftKey && (evt.code.startsWith('Digit') || evt.code.startsWith('Numpad')): {
					evt.stopPropagation()
					evt.preventDefault()

					// resolve the key number pressed by the user, it will be the key of the person array
					const key_person_number	= evt.code.match(/\d+/g);
					// get the person with the number pressed
					const person_tag		= key_person_number ? self.data.tags_persons?.[key_person_number[0]] : null
					if (!person_tag) {
						break;
					}
					event_manager.publish('key_up_persons' +'_'+ self.id_base, key_person_number)
					// get the node tag defined in the person (it's prepared in server)
					const node_tag_person	= self.build_view_tag_obj(person_tag, person_tag.tag_id)
					// set the new tag at caret position in the text.
					text_editor.set_content(node_tag_person)
					break;
				}

				// ctrl + Shift + 0
				case evt.ctrlKey && evt.shiftKey && (evt.code.startsWith('Digit') || evt.code.startsWith('Numpad')): {
					evt.stopPropagation()
					evt.preventDefault()

					// get the project langs
					const ar_project_langs	= page_globals.dedalo_projects_default_langs
					// resolve the key number pressed by user, it will match with the key of the array of languages
					const key_lang_number	= evt.code.match(/\d+/g);
					// get the lang object. Index with [0]: match() returns an array, so
					// indexing ar_project_langs with the whole array yields undefined.
					const current_lang		= key_lang_number ? ar_project_langs[key_lang_number[0]] : null
					if (!current_lang) {
						break;
					}
					// create the new lang tag
					const tag_type			='lang'
					const last_tag_id		= self.get_last_tag_id(tag_type, text_editor)
					const lang_number		= parseInt(last_tag_id) + 1
					const lang_tag			= {
						type	: tag_type,
						label	: current_lang.value.split('-')[1],
						tag_id	: String(lang_number),
						state	: 'a',
						data	: current_lang.value
					}
					const node_tag_lang = self.build_view_tag_obj(lang_tag, lang_tag.tag_id)
					// set the new tag at caret position in the text.
					text_editor.set_content(node_tag_lang)
					break;
				}

				// Tab
				case evt.code==='Tab': {
					evt.stopPropagation()
					// prevent to jump cursor to another input
					evt.preventDefault()
					break;
				}

				// case evt.code==='Backspace' || evt.code==='Delete':
					//	console.log(options)
					//	break;
			}
		}//end KeyUp

	// changeData
		custom_events.changeData = (evt, options) => {
			self.change_data_handler(options)
		}//end changeData event


	return custom_events
}//end get_custom_events



/**
* BUILD_NODE_TAG
* Convert a Dédalo tag descriptor object into an <img> DOM node for use inside
* the CKEditor rich-text area.
*
* Dédalo embeds semantic tags (index, draw, geo, tc, page, person, note, lang, …)
* as atomic <img> elements inside the editor HTML. This keeps the editor content
* serialisable as plain HTML while preserving structured metadata in the element's
* dataset attributes. service_ckeditor reads back these dataset properties when the
* user interacts with a tag (click, selection) and when saving the editor value.
*
* The view_data shape expected:
*   {
*     src        : {string}  — SVG icon URL for the tag type (shown as the img visual)
*     id         : {string}  — unique DOM id, e.g. 'indexIn_1' / 'geo_3'
*     class_name : {string}  — CSS classes, typically the tag type + state
*     type       : {string}  — Dédalo tag type ('indexIn', 'indexOut', 'tc', 'draw', …)
*     tag_id     : {string}  — sequential identifier of this tag within the component value
*     state      : {string}  — tag state code ('a' = inactive/draft, 'b' = active/published)
*     label      : {string|number} — human-readable label shown as tooltip / tag overlay
*     data       : {string}  — JSON string (with single-quote encoding) holding the tag
*                              payload (locator, timecode value, language code, etc.)
*   }
*
* @param {Object} view_data - tag descriptor object (see shape above)
* @returns {HTMLElement} <img> node with data-* attributes populated from view_data
*/
export const build_node_tag = function(view_data) {

	const src			= view_data.src
	const id			= view_data.id
	const class_name	= view_data.class_name
	const type			= view_data.type
	const tag_id		= view_data.tag_id
	const state			= view_data.state
	const label			= view_data.label
	const data			= view_data.data

	// dataset mirrors the tag descriptor so service_ckeditor can read back every
	// field from the DOM without re-parsing the serialised editor HTML.
	const dataset = {
		type	: type,
		tag_id	: tag_id,
		state	: state,
		label	: label,
		data	: data
	}

	const node_tag = ui.create_dom_element({
		element_type	: 'img',
		src				: src,
		id				: id,
		class_name		: class_name,
		dataset			: dataset
	})

	return node_tag
}//end build_node_tag



/**
* RENDER_NOTE
* Open a modal dialog that displays (or allows deletion of) a linked note section.
*
* A 'note' tag in a text_area holds a locator pointing at a separate Dédalo section
* (tipo defined in self.context.features.notes_section_tipo). This function:
*   1. Parses the tag's serialised locator (JSON with single-quote encoding).
*   2. Subscribes to the note section's publication-component change event so that the
*      tag state (active 'b' / inactive 'a') is kept in sync when the user toggles
*      the note's publication status inside the modal.
*   3. Builds a modal with header (note number + creator), body (note section rendered
*      in edit mode), and footer (date info + delete button).
*   4. Lazy-loads the note section via get_instance() inside a spinner; shows a
*      permissions error message if the current user cannot access the note.
*
* Tag state mapping (note publication status):
*   'a' = not publishable (component_publication section_id === '2')
*   'b' = publishable
*
* (!) The note section instance is published to the shared 'note_section' variable of
*     this function's scope as soon as get_note_section() resolves, because fn_remove
*     (the footer Delete button) needs it. The delete button is kept hidden until the
*     load finished, so fn_remove cannot normally run before the assignment; it still
*     bails out defensively if the instance is missing.
*
* (!) SEC-030: user-editable fields (created_by_user_name, section tipo) are written
*     via textContent (not innerHTML) to prevent HTML injection.
*
* @param {Object} options - call options
* @param {Object} options.self - component_text_area instance
* @param {Object} options.text_editor - active service_ckeditor instance
* @param {number} options.i - editor slot index
* @param {Object} options.tag - view_tag descriptor (from service_ckeditor tag click event)
* @returns {Promise<true>} resolves true after the modal has been constructed
*   (note section load is asynchronous and continues inside the spinner callback)
*/
const render_note = async function(options) {

	// options
		const self			= options.self
		const text_editor	= options.text_editor
		const i				= options.i
		const view_tag		= options.tag

	// short vars
		const data_string		= view_tag.data
		// convert the data_tag form string to json*-
		// replace the ' to " stored in the html data to JSON "
		// (!) CKEditor stores dataset attribute values inside double-quoted HTML attributes,
		// so JSON is serialised with single-quotes to avoid attribute-escaping issues.
		const data				= data_string.replace(/\'/g, '"')
		const locator			= JSON.parse(data)
		const note_section_id	= locator.section_id
		const note_section_tipo	= locator.section_tipo
		const features			= self.context.features || {}

	// note section
		// shared instance, assigned when the async load below resolves (used by fn_remove and modal.on_close)
		let note_section = null

		const get_note_section = async function(){
			// create the instance of the note section, it will render without inspector or filter and with edit mode
			const instance_options = {
				model			: 'section',
				tipo			: note_section_tipo,
				section_tipo	: note_section_tipo,
				section_id		: note_section_id,
				mode			: 'edit',
				lang			: self.lang,
				caller			: self,
				inspector		: false,
				filter			: false
			}
			// get the instance, built and render
			const instance	= await get_instance(instance_options)
							  await instance.build(true)

			return instance
		}

		// subscribe to the change publication of the component_publication of the section node
		// when the component_publication change it will change the tag note state, showing if the note is private or public
		const publication_id_base = note_section_tipo+'_'+note_section_id+'_'+features.notes_publication_tipo

		// change_publication_value_ event
		const change_publication_value_handler = (changed_value) => {
			// change the state of the note with the data of the component_publication (section_id = 2 means no publishable)
			const state = changed_value.section_id=='2' // no active value
				? 'a' // no publishable
				: 'b' // publishable
			const current_tag_state = view_tag.state || 'a'
			// create new tag with the new state of the tag

			if (current_tag_state !== state){
				const note_tag = {
					type	: 'note',
					label	: view_tag.label,
					tag_id	: view_tag.tag_id,
					state	: state,
					data	: locator // object format
				}
				text_editor.update_tag({
					type			: 'note',
					tag_id			: view_tag.tag_id,
					new_data_obj	: note_tag
				})

				// const tag				= self.build_view_tag_obj(note_tag, note_tag.tag_id)
				// // change the values to the current tag node
				// tag_node.id				= tag.id
				// tag_node.src			= tag.src
				// view_tag.state	= tag.dataset.state
				// Save the change, set the text_editor as dirty (has changes) and save it
				text_editor.set_dirty(true)
				// text_editor.save()
			}
		}
		self.events_tokens.push(
			event_manager.subscribe('change_publication_value_'+publication_id_base, change_publication_value_handler)
		)

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})
		// header_label_node
			const header_label_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label',
				inner_html		: (get_label.note || 'Note') + ' ' + render_value(note_section_id, 'text'),
				parent			: header
			})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body'
		})

	// footer
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'footer content distribute'
		})
		// section info
			const section_info = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'section_info hide',
				inner_html		: 'Loading',
				parent			: footer
			})
		// button remove
			const button_remove = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'danger remove hide',
				text_content	: get_label.delete || 'Delete',
				parent			: footer
			})
			// When the user click on remove button, two actions happens:
			// first, delete the section in the server
			// second, remove the tag from the text_area
			const fn_remove = function(e){
				e.stopPropagation()

				// ask to user if really want delete the note
				const delete_label = get_label.are_you_sure_to_delete_note || 'Are you sure you want to delete this note?' +' '+ view_tag.tag_id
				// if yes, delete the note section in the server
				if(window.confirm(delete_label)) {
					// remove the tag of the note in the component_text_area
					text_editor.delete_tag(view_tag)
					.then(function(){

						// note section instance not loaded yet (Delete clicked before the async
						// load resolved): the tag is already removed, nothing to delete server side
							if (!note_section) {
								text_editor.set_dirty(true)
								modal.remove()
								return
							}

						// Delete the server note data in the DDBB
							// create sqo the the filter_by_locators of the section to be deleted
							const sqo = {
								section_tipo		: [note_section.section_tipo],
								filter_by_locators	: [{
									section_tipo	: note_section.section_tipo,
									section_id		: note_section.section_id
								}],
								limit				: 1
							}
							// create the request to delete the record
							// telling the section to do the action
							note_section.delete_section({
								sqo			: sqo,
								delete_mode	: 'delete_record'
							})
							// destroy the instance of the note section
							// (cleared so modal.on_close does not destroy it a second time)
							note_section.destroy(true,true,true)
							note_section = null

						// text_area. Prepare the text_editor to save setting it in dirty mode and save the change
							text_editor.set_dirty(true)
							// text_editor.save()

						// remove the modal
							modal.remove()
					})
				}
			}//end fn_remove
			button_remove.addEventListener('click', fn_remove)

	// save editor changes to prevent conflicts with modal components changes
		// text_editor.save()

	// modal. Create a standard modal with the note information
		const modal = ui.attach_to_modal({
			header	: header,
			body	: body,
			footer	: footer
			// size	: 'normal' // string size big|normal|small
		})
		// resize modal content
		const modal_content = modal.get_modal_content()
				modal_content.style.width	= '600px'
				modal_content.style.height	= '515px';

	// load note section and render. On finish, add to body node and fill header and footer info
		ui.load_item_with_spinner({
			container : body,
			callback : async function() {

				// publish to the shared scope variable, fn_remove and modal.on_close need it
				note_section = await get_note_section()

				// permissions check
				if (!note_section.permissions || parseInt(note_section.permissions)<1) {
					body.classList.add('content')
					// SEC-030: textContent prevents HTML interpretation of note_section.tipo
					body.textContent = (get_label.no_access || 'Not access here') + ' ' + note_section.tipo
					return false
				}

				const note_section_node	= await note_section.render()
				body.appendChild(note_section_node)

				// on_close modal. when the modal is closed the section instance of the note need to be destroyed with all events and components
					modal.on_close = () => {
						if (note_section) {
							note_section.destroy(true,true,true)
							note_section = null
						}
					}

				if (!note_section.data.entries || !note_section.data.entries[0]) {
					section_info.remove()
					button_remove.remove()
					return false
				}

				// header_label. Created label with Title case (first letter to uppercase)
					const created_label			= get_label.created || 'created'
					const by_user_label			= get_label.by_user || 'by user'
					const created_by_user		= note_section.data.entries[0].created_by_user_name || 'undefined'
					const header_label			= (get_label.note || 'Note') + ' ' + created_label +' '+ by_user_label + ': ' + created_by_user
					// SEC-030: textContent prevents HTML interpretation of user-editable created_by_user_name
					header_label_node.textContent	= header_label

				// section info (bottom)
					const date_label			= get_label.date.toLowerCase() || 'date'
					const created_date			= note_section.data.entries[0].created_date || ''
					section_info.textContent	= created_label + ' ' + date_label + ': '+ created_date
					section_info.classList.remove('hide')
					button_remove.classList.remove('hide')
			}
		})


	return true
}//end render_note



/**
* RENDER_PERSONS_LIST
* Open a modal listing the persons available for quick insertion as 'person' tags.
*
* The persons list is built from two sources that are merged:
*   1. self.data.related_sections — persons from sections that are linked to this
*      component's section (e.g. an interview recording linked to interviewer sections).
*      Each related section is grouped under a section label heading.
*   2. self section itself (self.section_tipo + self.section_id) — persons directly
*      attached to the component's own section (e.g. the person being interviewed).
*
* Each person entry displays:
*   - keyboard shortcut hint (Ctrl + sequential index k)
*   - inline tag HTML preview (the icon image as it will appear in the editor)
*   - full name
*   - role label
*
* Clicking a person item calls text_editor.set_content(tag) to insert the person tag
* at the current caret position.
*
* Returns null (without opening a modal) when:
*   - ar_persons is falsy, empty, or undefined
*   - the related_sections data is absent or contains no 'sections' entry
*
* (!) The condition `ar_persons.length === 0 || typeof(ar_persons)==='undefined'`
*     checks undefined after a length access — if ar_persons were truly undefined the
*     length access would throw first. The order is a no-op guard. Document only.
*
* (!) The inner loop uses `el.typo` (likely a typo for `el.type`) when looking up
*     the 'sections' entry in data. Document only, do not fix.
*
* @param {Object} self - component_text_area instance
* @param {Object} text_editor - active service_ckeditor instance
* @param {number} i - editor slot index (not used internally; kept for signature parity)
* @returns {true|null} true after modal is opened; null if no persons are available
*/
const render_persons_list = function(self, text_editor, i) {

	// short vars
		const ar_persons = self.data.tags_persons
			// console.log(`(!ar_persons) ${self.tipo}:`, ar_persons);

	// if ar_persons is empty, stop and return the fragment
		if(!ar_persons || ar_persons.length === 0 || typeof(ar_persons)==='undefined') {
			return null
		}

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_node		: get_label.persons || 'Persons',
			parent			: header
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content text_area_persons_list_container'
		})

		// person sections
			const ref_datum	= self.data.related_sections || {}
			const context	= ref_datum.context
			const data		= ref_datum.data
			// (!) 'el.typo' is likely a typo for 'el.type'; do not fix here.
			const sections	= data.find(el => el.typo==='sections')

			if(!sections){
				return null
			}

		// sections loop
			// get the value of related sections (the locator of his data)
			const value_ref_sections = sections.value
			// add the self section, the section of the compnent_text_area, to be processed as common section (for interviewed, camera, etc.)
			const self_component_section = [{
				section_tipo	: self.section_tipo,
				section_id		: self.section_id
			}]
			// create unique array with all locators
			const value = [...value_ref_sections, ...self_component_section]

			const value_length	= value.length
			let k = 0;
			for (let i = 0; i < value_length; i++) {

				const section_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'section_container',
					parent			: body
				})
				// get current_locator to be used in common and simple way
				const current_locator = {
					section_tipo	: value[i].section_tipo,
					section_id		: value[i].section_id
				}
				// check if the section to be processed is the self section, the section of the component_text_area, (only related sections need to be processed)
				if(current_locator.section_tipo!==self.section_tipo){
					const section_label		= context.find(el => el.section_tipo===current_locator.section_tipo).label
					const ar_component_data	= data.filter(el => el.section_tipo===current_locator.section_tipo && same_section_id(el.section_id, current_locator.section_id))

					// get the ar_component_value of the components related to this section
						const ar_component_value = []
						for (let j = 0; j < ar_component_data.length; j++) {
							const current_value = ar_component_data[j].value // toString(ar_component_data[j].value)
							ar_component_value.push(current_value)
						}

					// label
						const label = 	render_value(section_label + ' | ' +
										current_locator.section_id +' | ' +
										ar_component_value.join(' | '), 'text')

					// section_label_node
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'label',
							inner_html		: label,
							parent			: section_container
						})
				}//end if check the section

				// get the people for every section, self section and related sections.
				// section_id compared as strings: the wire ids are strings (WC-065),
				// but the SELF group's id comes from the instance, which the tool
				// instantiation path types as a number — strict === dropped the
				// host record's own persons (interviewer/crew) from the modal.
				const ar_persons_for_this_section = ar_persons.filter(el => el.section_tipo === current_locator.section_tipo && String(el.section_id) === String(current_locator.section_id))
				for (let j = 0; j < ar_persons_for_this_section.length; j++) {

					const current_person = ar_persons_for_this_section[j] // toString(ar_component_data[j].value)

					// person_container
						const person_container = ui.create_dom_element({
							element_type	: 'div',
							class_name 		: 'person_container',
							parent			: section_container
						})
						person_container.addEventListener('mousedown', function (evt) {
							evt.preventDefault()
							evt.stopPropagation()

							// event_manager.publish('key_up_persons' +'_'+ self.id_base, k)
							const tag = self.build_view_tag_obj(current_person, current_person.tag_id)
							text_editor.set_content(tag)
						});

					// person_keyboard
						ui.create_dom_element({
							element_type	: 'span',
							text_node		: 'control ctrl+'+ k++,
							class_name		: 'label person_keyboard',
							parent			: person_container
						})
						const html_tag = render_value(self.tags_to_html(current_person.tag), self.context.render_class)
						person_container.insertAdjacentHTML('afterbegin', html_tag)

					// person_name
						ui.create_dom_element({
							element_type	: 'span',
							text_node		: current_person.full_name || '',
							class_name		: 'label person_name',
							parent			: person_container
						})
						// person_role
						ui.create_dom_element({
							element_type	: 'span',
							text_node		: '('+current_person.role + ')',
							class_name		: 'label person_role',
							parent			: person_container
						})
				}//end for (let j = 0; j < ar_persons_for_this_section.length; j++)
			}//end for (let i = 0; i < value_length; i++)

	// save editor changes to prevent conflicts with modal components changes
		// text_editor.save()

	// modal
		ui.attach_to_modal({
			header	: header,
			body	: body,
			footer	: null,
			size	: 'small' // string size big|normal|small
		})


	return true
}//end render_persons_list



/**
* RENDER_LANGS_LIST
* Open a modal listing the project's configured languages for quick lang-tag insertion.
*
* Each language from page_globals.dedalo_projects_default_langs is shown as a clickable
* row displaying:
*   - a lang icon (CSS-based, no separate image)
*   - the language label (localised name)
*   - keyboard shortcut hint (Ctrl+Shift + sequential index k)
*
* Clicking a language row:
*   1. Constructs a 'lang' tag descriptor with the language code as data
*      (e.g. data: ['es-ES']), using get_last_tag_id + 1 to assign a unique tag_id.
*   2. Calls text_editor.set_content(tag) to insert the tag at the caret.
*   3. Calls text_editor.set_dirty(true) to mark the editor as having unsaved changes.
*   4. Closes the modal.
*
* Lang tag data format: an array with a single BCP-47 language code string, e.g. ['es-ES'].
* The label shown in the editor uses the country/region part only (split('-')[1]).
*
* @param {Object} self - component_text_area instance
* @param {Object} text_editor - active service_ckeditor instance
* @param {number} i - editor slot index (not used internally; kept for signature parity)
* @returns {true} always returns true after opening the modal
*/
const render_langs_list = function(self, text_editor, i) {

	// short vars
		const ar_project_langs = page_globals.dedalo_projects_default_langs

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_node		: get_label.language || 'Language ',
			parent			: header
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content text_area_project_langs_container'
		})
		// sections loop
			const value_length = ar_project_langs.length
			let k = 0;
			for (let i = 0; i < value_length; i++) {

				const current_lang = ar_project_langs[i]

				const lang_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'lang_container',
					parent			: body
				})
				lang_container.addEventListener('click', function (evt) {
					evt.preventDefault()
					evt.stopPropagation()

					// create the new lang tag
					const tag_type		= 'lang'
					const last_tag_id	= self.get_last_tag_id(tag_type, text_editor)
					const lang_number	= parseInt(last_tag_id) + 1
					const lang_tag		= {
						type	: tag_type,
						label	: current_lang.value.split('-')[1], //.substring(0, 3),
						tag_id	: String(lang_number),
						state	: 'a',
						data	: [current_lang.value]
					}

					const tag = self.build_view_tag_obj(lang_tag, lang_tag.tag_id)
					// set the new lang tag at caret position of the text_editor.

					text_editor.set_content(tag)
					// save value
					text_editor.set_dirty(true)
					// close current modal
						modal.close()
				});

				// lang_icon
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button icon lang',
						parent			: lang_container
					})

				// lang_label
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'lang_label',
						inner_html		: render_value(current_lang.label, 'text'),
						parent			: lang_container
					})

				// label_keyboard
					ui.create_dom_element({
						element_type	: 'span',
						text_node		: 'Control + Shift + ' + k++,
						class_name		: 'label label_keyboard',
						parent			: lang_container
					})
			}//end for (let i = 0; i < value_length; i++)

	// save editor changes to prevent conflicts with modal components changes
		// text_editor.save()

	// modal
		const modal = ui.attach_to_modal({
			header	: header,
			body	: body,
			footer	: null,
			size	: 'small' // string size big|normal|default
		})


	return true
}//end render_langs_list



// @license-end
