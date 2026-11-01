// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global, page_globals, get_label */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_fallback_value} from '../../common/js/common.js'
	import {change_handler, remove_handler, check_duplicates} from './render_edit_component_input_text.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'
	import {stop_page_shortcuts} from '../../common/js/utils/keyboard.js'


/**
* VIEW_DEFAULT_EDIT_INPUT_TEXT
* Full-featured edit view for component_input_text.
*
* This module is the 'default' (and 'print') edit render for single-line text
* (or multi-line textarea, when context.properties.multi_line is true).  It is
* selected by render_edit_component_input_text.prototype.edit when the view is
* 'default', 'print', or unrecognised.
*
* Responsibilities:
*  - Build the outer component wrapper (via ui.component.build_wrapper_edit).
*  - Build the content area: one editable input/textarea per data entry, or a
*    single empty input when the entry list is empty.
*  - For read-only users (permissions === 1) render a static text node instead
*    of an interactive input.
*  - Wire keyboard, focus, and change events on every input, including debounced
*    duplicate detection for components marked unique in their ontology properties.
*  - Render per-entry remove buttons (for multi-value components, index > 0).
*  - Render transliterate_value annotations (parallel-language hints) when
*    context.properties.with_lang_versions is true.
*  - Attach the optional component_dataframe below each entry via attach_item_dataframe.
*  - Expose an "Add input field" button when show_interface.button_add is true and
*    permissions > 1.
*
* Main export: view_default_edit_input_text (constructor placeholder); all logic
* lives on the static .render() method assigned directly to the constructor.
*/
export const view_default_edit_input_text = function() {

	return true
}//end view_default_edit_input_text



/**
* RENDER
* Build and return the full component DOM node for the default-edit view.
*
* When options.render_level is 'content', only the inner content_data node is
* returned (no wrapper, no buttons).  This allows callers such as
* component_common.prototype.refresh to replace only the content area without
* re-creating the outer wrapper, preserving existing event listeners.
*
* Side effects:
*  - Sets wrapper.content_data pointer so callers can reach individual entry
*    nodes via self.node.content_data[i].
*
* @param {Object} self - The component instance (component_input_text).
*   Expected properties: self.permissions, self.data, self.context, self.lang,
*   self.show_interface, self.node, self.events_tokens, self.view, self.id.
* @param {Object} options - Render configuration.
*   options.render_level {string} 'full' (default) | 'content' — controls
*   whether to build the outer wrapper and buttons or only the content area.
* @returns {Promise<HTMLElement>} The wrapper div (render_level='full') or the
*   content_data div (render_level='content').
*/
view_default_edit_input_text.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data_edit(self)
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
			buttons			: buttons
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA_EDIT
* Build the content_data container and populate it with one entry node per item
* in self.data.entries.
*
* When entries is empty a synthetic placeholder [{value:null}] is used so that
* at least one editable input is always visible — without it the component
* would appear blank on a brand-new record.
*
* Each built entry node is stored both as a numeric property on content_data
* (content_data[i]) and appended as a DOM child, giving callers random access
* to individual rows via self.node.content_data[i].querySelector('input').
*
* Routing: read-only users (permissions === 1) get a static text node from
* get_content_value_read; all other users get a fully interactive node from
* get_content_value.
*
* @param {Object} self - The component instance.  Expected: self.data.entries,
*   self.permissions, self.context, self.lang, self.events_tokens, self.view.
* @returns {HTMLElement} content_data - The populated content container div.
*/
const get_content_data_edit = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self)

	// values (inputs)
		const inputs_value	= (entries.length<1) ? [{value:null}] : entries // force one empty input at least
		const value_length	= inputs_value.length

		for (let i = 0; i < value_length; i++) {
			// get the content_value
			const content_value = (self.permissions===1)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self)
			// set the pointer
			content_data[i] = content_value
			// add node to content_data
			content_data.appendChild(content_value)
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
* Build one interactive entry node — either an <input type="text"> or a
* <textarea> — for the entry at index i in the component's data.entries array.
*
* Element type selection:
*  - Reads context.properties.multi_line; true → <textarea>, otherwise <input>.
*  - The hasOwnProperty check (not a simple truthy test) is used so that an
*    explicit `multi_line: false` is honoured over the default.
*
* Placeholder: When the entry has no value the server-supplied fallback_value
* string for this index is shown as a placeholder hint.  When a value is present
* the placeholder is set to '' to avoid overlap with the rendered text.
*
* Mandatory styling: The 'mandatory' CSS class is added on first render when the
* component is mandatory, the current entry is empty, and the active language is
* the neutral language (NOLAN).  The class is toggled on every change via
* change_handler.
*
* Event strategy:
*  - mousedown / focus: activate the component if not already active; focus
*    prevents the component from missing keyboard input when the user tabs in.
*  - keydown: Tab key deactivates the component so focus moves to the next field.
*  - keyup (debounced, 300 ms): runs check_duplicates for unique components.
*    Only character-producing keys trigger the check; modifier/arrow keys are
*    filtered.  The UIUX-10 guard handles undefined e.key from IME/autofill.
*  - click: stops propagation only (prevents the wrapper mousedown from firing).
*  - change: delegates to the shared change_handler which persists the value via
*    self.change_value and manages mandatory-class toggling.
*
* Unique-value checking:
*  - When context.properties.unique is set, check_duplicates is also called once
*    100 ms after initial render (to catch pre-filled duplicates) and on every
*    subsequent 'activate_component' event for this instance.
*  - The activate_component subscription token is stored in self.events_tokens
*    so it is cleaned up when the component is destroyed.
*
* Remove button:
*  - Only rendered for i > 0 (the first entry cannot be removed).
*  - Uses mousedown+preventDefault to prevent loss of focus before the click
*    fires; the click delegates to remove_handler.
*  - current_value.id is passed so the server can identify the row to delete;
*    null is used for unsaved entries.
*
* Transliterate annotation:
*  - When with_lang_versions is true and the server provided transliterate_value
*    data for this index, a read-only <div class="transliterate_value"> is
*    appended below the input showing the parallel-language text (e.g. the
*    romanised form when editing Cyrillic, or the nolan form inside tool_lang).
*
* Dataframe attachment:
*  - attach_item_dataframe is called unconditionally; it is a no-op when the
*    component does not declare has_dataframe in its context properties.
*
* @param {number} i - Zero-based index of this entry in data.entries.
* @param {Object} current_value - The entry object: { value: string|null, id: number|null,
*   lang: string }.  id may be null for new unsaved rows.
* @param {Object} self - The component instance.  Expected: self.context.properties
*   (multi_line, with_lang_versions, mandatory, unique), self.data.fallback_value,
*   self.data.transliterate_value, self.lang, self.active, self.id,
*   self.events_tokens, self.view.
* @returns {HTMLElement} content_value - The built entry container <div>.
*/
const get_content_value = (i, current_value, self) => {

	// short vars
		const multi_line = (self.context.properties && self.context.properties.hasOwnProperty('multi_line'))
			? self.context.properties.multi_line
			: false
		const element_type			= (multi_line===true) ? 'textarea' : 'input'
		const with_lang_versions	= self.context.properties.with_lang_versions || false

	// check if the component is mandatory and it doesn't has value
		const add_class = self.context.properties.mandatory && !current_value.value && self.lang===page_globals.dedalo_data_nolan
			? ' mandatory'
			: ''

	// content_value node
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// input field
		const input = ui.create_dom_element({
			element_type	: element_type,
			type			: 'text',
			class_name		: 'input_value' + add_class,
			value			: current_value.value || '' ,
			placeholder		: (current_value.value) ? '' : self.data.fallback_value?.[i].value,
			// no `aria-lang`: it is not an ARIA attribute (axe aria-valid-attr), and
			// `lang` takes a BCP 47 tag, not a Dédalo 'lg-spa' code.
			parent			: content_value
		})
		// mousedown event. Capture event propagation
			input.addEventListener('mousedown', (e) => {
				e.stopPropagation()
				if (!self.active) {
					ui.component.activate(self, false)
				}
			})
		// focus event
			input.addEventListener('focus', function() {
				// force activate on input focus (tabulating case)
				if (!self.active) {
					ui.component.activate(self, false)
				}
			})
		// keydown event
		// (!) stop_page_shortcuts lets Escape through on purpose: the page-level
		// handler deactivates the active component on Escape.
			input.addEventListener('keydown', function(e) {
				stop_page_shortcuts(e)
				if(e.key==='Tab'){
					ui.component.deactivate(self)
					return
				}
			})
		// keyup event
			let debounce_timer = null
			input.addEventListener('keyup', function(e) {
				e.stopPropagation()
				// skip non-character keys (modifiers, arrows, etc.)
				// UIUX-10: e.key can be undefined for some synthetic/IME/autofill events;
				// guard before reading .length so the handler doesn't throw a TypeError.
				if ((e.key?.length ?? 0) > 1 && e.key !== 'Process' && e.key !== 'Backspace' && e.key !== 'Delete') {
					return
				}
				clearTimeout(debounce_timer)
				debounce_timer = setTimeout(function(){
					check_duplicates(self, input.value)
				}, 300)
			})
		// click event. Capture event propagation
			input.addEventListener('click', (e) => {
				e.stopPropagation()
			})
		// change event
			input.addEventListener('change', (e) => {
				change_handler(e, i, self)
			})

		// check duplicates on unique property
			if (self.context.properties.unique) {
				// first check
				setTimeout(function(){
					check_duplicates(self, input.value)
				}, 100)

				// check again on each component activation
				const activate_component_handler = (el) => {
					if (el.id===self.id) {
						check_duplicates(self, input.value)
					}
				}
				self.events_tokens.push(
					event_manager.subscribe('activate_component', activate_component_handler)
				)
			}

	// button remove. Triggered by wrapper delegated events
		if (i>0) {
			// button_remove
			const button_remove = ui.create_dom_element({
				element_type	: 'span',
				title			: get_label.delete || 'Delete',
				class_name		: 'button remove hidden_button',
				parent			: content_value
			})
			button_remove.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				e.preventDefault()
			})
			button_remove.addEventListener('click', function(e) {
				e.stopPropagation()
				const id = current_value.id || null;
				remove_handler(input, id, i, self)
			})
		}//end if(i>0)

	// transliterate_value
		if (with_lang_versions && Array.isArray(self.data.transliterate_value) && self.data.transliterate_value[i]) {
			const transliterate_value = self.data.transliterate_value[i].value || '';
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'transliterate_value',
				text_content	: transliterate_value,
				parent			: content_value
			});
		}

	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
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
* Build a read-only entry node for a user with permissions === 1 (view only).
*
* Rather than an <input>, a plain <div> is rendered.  The displayed text is
* resolved through get_fallback_value: when the entry's own value is present it
* is used directly; when it is null/empty the corresponding server-supplied
* fallback (e.g. the default-language value) is used and wrapped in <mark> tags
* so the UI can style it distinctively.
*
* get_fallback_value is called with a single-element array wrapping current_value
* because it expects an array of entry objects parallel to fallback_value.
*
* Note: The returned text_content is the joined result array from
* get_fallback_value, which may contain HTML markup (<mark>…</mark>) from the
* fallback path.  Currently text_content (not inner_html) is used, meaning the
* <mark> tags appear as literal text in read-only mode.  This appears to be the
* intended behaviour for this view (the list view uses a separate renderer).
*
* @param {number} i - Zero-based index of this entry, used to locate the
*   corresponding fallback entry in data.fallback_value.
* @param {Object} current_value - Entry object: { value: string|null }.
* @param {Object} self - The component instance.  Expected: self.data.fallback_value.
* @returns {HTMLElement} content_value - A <div class="content_value read_only"> node.
*/
const get_content_value_read = (i, current_value, self) => {

	const data				= self.data || {}
	const fallback_value	= data.fallback_value || []
	const final_value		= get_fallback_value([current_value], fallback_value)

	// content_value node
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only',
			text_content	: final_value
		})


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the action-button bar for the edit view.
*
* Returns a buttons_container element holding:
*  1. An "Add" button (when show_interface.button_add === true) that inserts a
*     new blank entry into the component's data and re-renders the content area.
*  2. Tool buttons registered in self.tools[] (when show_interface.tools === true),
*     rendered by ui.add_tools.
*
* Only called when self.permissions > 1 (the caller guards this).
*
* "Add" button behaviour:
*  - When the component currently has no entries (empty or absent data.entries),
*    focus is moved to the first existing input instead of inserting a duplicate
*    blank row.  This handles the common case where the user clicks "add" on an
*    already-empty component.
*  - Otherwise a changed_data item with action='insert' is built at the next
*    numeric key and passed to self.change_value({refresh:true}).  After the
*    save-and-refresh cycle, the newly added input is located via
*    self.node.content_data[new_key] and focused automatically.
*  - A console.warn is emitted if the expected input node cannot be found after
*    refresh (e.g. because the server did not confirm the insert), so the
*    condition is not silently swallowed.
*
* Layout: All button elements are built into a DocumentFragment and then moved
* into a buttons_fold <div> inside the buttons_container.  The buttons_fold
* wrapper enables the CSS sticky-position behaviour for tall components.
*
* @param {Object} self - The component instance.  Expected: self.show_interface
*   (button_add, tools booleans), self.data.entries, self.lang, self.node,
*   self.change_value, self.tools.
* @returns {HTMLElement} buttons_container - The outer buttons bar element.
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// button add input
		if(show_interface.button_add === true){

			const button_add = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button add',
				title			: get_label.new || 'Add new input field',
				parent			: fragment
			})
			button_add.addEventListener('click', function(e) {
				e.stopPropagation()

				// no value case
					if (!self.data.entries || !self.data.entries.length) {
						self.node.content_data[0].querySelector('input').focus()
						return
					}

				const key = self.data?.entries?.length || 0

				const changed_data = [Object.freeze({
					action	: 'insert',
					id		: null,
					key		: key,
					value	: {
						value: null,
						lang: self.lang
					}
				})]
				self.change_value({
					changed_data	: changed_data,
					refresh			: true
				})
				.then(()=>{
					const new_key = self.data?.entries?.length ? self.data.entries.length - 1 : key
					const input_node = self.node.content_data[new_key]
						? self.node.content_data[new_key].querySelector('input')
						: null
					if (input_node) {
						input_node.focus()
					}else{
						console.warn('Empty input_node:', self.node.content_data, key);
					}
				})
			})//end event click
		}

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}//end add tools

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
