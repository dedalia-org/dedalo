// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/* eslint no-undef: "error" */



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {strip_tags, safe_url} from '../../../core/common/js/utils/index.js'
	import {view_default_edit_iri} from './view_default_edit_iri.js'
	import {view_line_edit_iri} from './view_line_edit_iri.js'
	import {view_mini_iri} from './view_mini_iri.js'
	import {get_dataframe} from '../../component_common/js/component_common.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'



/**
* RENDER_EDIT_COMPONENT_IRI
* Edit-mode render layer for component_iri (IRI + title pairs with optional dataframe).
*
* This module provides all DOM-building logic needed when a component_iri instance is
* rendered in 'edit', 'line', 'mini', or 'print' mode. It is consumed by component_iri
* via prototype delegation (component_iri.prototype.edit = render_edit_component_iri.prototype.edit).
*
* Data shape managed here:
*   self.data = {
*     entries            : Array<{id, iri, title, dataframe?}>  — persisted rows
*     counter            : number                               — next provisional id hint
*     transliterate_value: Array<{id?, iri, title}|null>        — same-indexed rows from the
*                                                                  fallback/other-lang datum
*     changed_data       : Array<Object>                        — pending unsaved mutations
*   }
*
* Each entry row is paired with a component_dataframe identified by the entry's `id`
* (server-assigned) or a provisional counter+1 for unsaved rows. See the dataframe
* unified contract in docs/core/components/component_dataframe.md and memory note
* [IRI id dataframe pairing].
*
* Main exports: render_edit_component_iri (constructor + .edit prototype),
*   get_content_data, get_buttons, render_transliterate_value.
*/
export const render_edit_component_iri = function() {

	return true
}//end render_edit_component_iri



/**
* EDIT
* Entry point for rendering a component_iri instance in edit mode.
* Dispatches to the correct view renderer based on self.context.view:
*   'line'    → view_line_edit_iri  (compact single-line layout)
*   'mini'    → view_mini_iri       (minimal display, typically inside tool panels)
*   'print'   → view_default_edit_iri rendered read-only (permissions forced to 1)
*   'default' → view_default_edit_iri (full two-field layout with buttons)
*
* The 'print' case deliberately falls through to 'default' after setting
* self.permissions = 1. This ensures read-only DOM elements are used while
* still applying a 'view_print' CSS class on the wrapper (added by
* ui.component.build_wrapper_edit when permissions === 1).
* @param {Object} options - render options forwarded to the view renderer
* @returns {Promise<HTMLElement>} wrapper node produced by the selected view
*/
render_edit_component_iri.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line':
			return view_line_edit_iri.render(self, options)

		case 'mini':
			return view_mini_iri.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'default':
		default:
			return view_default_edit_iri.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA
* Builds the content_data container that holds one content_value row per entry.
* If self.data.entries is empty or absent, a single blank row is rendered so
* the user always sees at least one editable slot.
*
* For each entry, the function decides between the full editable renderer
* (get_content_value) and the read-only renderer (get_content_value_read)
* based on self.permissions: permissions === 1 → read-only.
*
* The returned element also carries numeric index properties (content_data[0],
* content_data[1], …) pointing to each content_value node so callers can
* address them by position (used by component_iri.build_value and get_buttons
* when auto-focusing the new row's URL input).
* @param {Object} self - component_iri instance
* @returns {HTMLElement} content_data container populated with content_value nodes
*/
export const get_content_data = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self)

	// values (inputs)
		const inputs_value	= (entries.length<1) ? [{}] : entries
		const entries_length	= inputs_value.length
		for (let i = 0; i < entries_length; i++) {
			const current_value = inputs_value[i]
			const content_value_node = (self.permissions===1)
				? get_content_value_read(i, current_value, self)
				: get_content_value(i, current_value, self)

			content_data.appendChild(content_value_node)
			// set pointers
			content_data[i] = content_value_node
		}


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Builds the editable DOM subtree for a single IRI entry.
*
* Structure of the returned node:
*   .content_value
*     .dataframe          (component_dataframe rendered asynchronously, if resolved)
*     input.input_value.title  (free-text label for the IRI, optional via use_title)
*     input.input_value.url    (the IRI itself)
*     input.input_iri_active   (checkbox, optional via use_active_check)
*     span.button.remove       (triggers confirmation modal before deletion)
*     span.button.link         (opens the IRI in a new window)
*     .transliterate_value     (sibling-language value hint, appended if present)
*
* Dataframe pairing:
*   Persisted rows carry a server-assigned `id` that is used as id_key
*   when requesting the paired component_dataframe. New, unsaved rows lack an id,
*   so a provisional key (self.data.counter + 1) is used as a render-context hint
*   only — it is NEVER written into the entry value; real ids are minted server-side
*   on save. When the entry is empty but the transliterate_value for the same index
*   carries an id, that id is shared into current_value so the dataframe pairing
*   works across languages (the subdatum may already exist in another lang).
*
* The dataframe is fetched asynchronously inside .then(); the surrounding
* content_value node is returned synchronously and the dataframe node is
* appended when the promise resolves. If the row is still empty when first
* rendered (value_is_empty && transliterate_value present), the dataframe node
* receives a 'loading' class and is refreshed on the first valid IRI change event.
*
* Event handlers attached:
*   - title input: change, focus, click, mousedown, keyup (Enter tabs to IRI input)
*   - IRI input:   change (validates URL, updates current_value, triggers dataframe
*                  refresh if 'loading'), click, mousedown, focus, keyup (Enter saves
*                  if pending data exists in changed_data)
*   - active checkbox: change (writes current_value.dataframe flag, calls change_value)
*   - remove button: mousedown (shows confirmation modal; real delete via _do_remove_iri_entry)
*   - link button:   mousedown (opens IRI in a popup window; clears opener to prevent
*                   reverse tabnabbing)
* @param {number} i - zero-based index of this entry in self.data.entries
* @param {Object} current_value - the entry object { id?, iri, title, dataframe? }, may be {}
* @param {Object} self - component_iri instance
* @returns {HTMLElement} content_value node (dataframe appended asynchronously)
*/
const get_content_value = (i, current_value, self) => {

	// current_value. (!) Fallback to {} because could be null when new blank value is added
		current_value = current_value || {}

	// short vars
		const mode					= self.mode
		const title					= current_value.title || ''
		const iri					= current_value.iri || ''
		const transliterate_value	= self.data?.transliterate_value?.[i] || null

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// If the value is empty, resolve the dataframe pairing context
		const value_is_empty = !current_value || Object.keys(current_value).length === 0
		if(value_is_empty && transliterate_value?.id){
			// the entry exists in another language: share its real id
			// so the update pairs across languages
			current_value.id = transliterate_value.id
		}

	// dataframe_id_key
	// Persisted rows pair by their real item id. New blank rows use the next
	// counter value as PROVISIONAL render context only: it is never written
	// into the value (ids are minted server-side on save, see I1/I3 in
	// docs/core/components/component_dataframe.md)
		const dataframe_id_key = current_value.id ?? (self.data.counter+1)

	// dataframe
	// Get a built component_datataframe instance ready for render
		get_dataframe({
			self				: self,
			section_id			: self.section_id,
			id_key				: dataframe_id_key,
			main_component_tipo	: self.tipo,
			view				: 'line',
			mode				: 'edit'
		})
		.then(async function(component_dataframe){

			// dataframe
				// set the component_dataframe, is mandatory use it.
				if(component_dataframe){
					// Add dataframe instance to component dependencies array
					self.ar_instances.push(component_dataframe)
					// Render it and add to content_value
					const dataframe_node = await component_dataframe.render()
					dataframe_node.classList.add('dataframe')
					// Ensure empty transliterations do not add new dataframes accidentally
					if (value_is_empty && transliterate_value) {
						dataframe_node.classList.add('loading')
					}
					content_value.appendChild(dataframe_node)
				}

			// title
				const use_title = typeof(self.context?.properties?.use_title) !== 'undefined'
					? self.context.properties.use_title
					: true
				if(use_title){
					// placeholder. Strip label HTML tags
						const placeholder_label = mode.indexOf('edit')!==-1
							? (get_label.title || 'Title')
							: null
						const placeholder_text = placeholder_label ? strip_tags(placeholder_label) : null

					// input title field
						const input_title = ui.create_dom_element({
							element_type	: 'input',
							type			: 'text',
							class_name		: 'input_value title',
							placeholder		: placeholder_text,
							value			: title,
							parent			: content_value
						})
						// change event
						const change_title_handler = (e) => {
							// update_value(self, i, current_value)
							current_value.title = input_title.value
							self.change_handler(i, current_value)
						}
						input_title.addEventListener('change', change_title_handler)
						// focus event
							input_title.addEventListener('focus', () => {
								// force activate on input focus (tabulating case)
								if (!self.active) {
									ui.component.activate(self, false)
								}
							})
						// click event
							input_title.addEventListener('click', (e) => {
								e.stopPropagation()
								if (!self.active) {
									ui.component.activate(self, false)
								}
							})
						// mousedown event
							input_title.addEventListener('mousedown', (e) => {
								e.stopPropagation()
								if (!self.active) {
									ui.component.activate(self, false)
								}
							})
						// keyup event
							const input_title_keyup_handler = (e) => {
								if(e.key === 'Enter'){
									input_iri.focus()
									return false
								}
							}
							input_title.addEventListener('keyup', input_title_keyup_handler)
				}// end if(use_title)

			// IRI input field
				// const regex = /^((https?):\/\/)?([w|W]{3}\.)+[a-zA-Z0-9\-\.]{3,}\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?$/;
				const input_iri = ui.create_dom_element({
					element_type	: 'input',
					type			: 'url',
					class_name		: 'input_value url',
					placeholder		: 'http://',
					value			: iri,
					parent			: content_value
				})
				// change event
					const change_iri_handler = (e) => {
						// check if the new value is valid
						// only uris with protocol (http || https) and valid domain are validated
						const valid_value = self.check_iri_value( input_iri.value )
						// if the value is not valid stop the change and show error style
						if( !valid_value ){
							input_iri.classList.add('error')
							return false
						}

						// clean error class if exists
						// if the new value is valid, remove previous error style
							if (input_iri.classList.contains('error')) {
								input_iri.classList.remove('error')
							}

						// update property iri
							current_value.iri = input_iri.value

						// update_value(self, i, current_value)
							self.change_handler(i, current_value)

						// Refresh dataframe once
							if(component_dataframe
								&& component_dataframe.node?.classList.contains('loading')
								){
								// Force render again component_dataframe to load
								// value that is not loaded if component_iri value is empty
								// because it depends of the subdatum in current lang.
								component_dataframe.refresh({
									build_autoload	: true,
									render_level	: 'content'
								})
								.then(function(){
									component_dataframe.node.classList.remove('loading')
								})
							}
					}//end change_iri_handler
					input_iri.addEventListener('change', change_iri_handler)
				// click event
					const click_handler = (e) => {
						e.stopPropagation()
						if (!self.active) {
							ui.component.activate(self, false)
						}
					}
					input_iri.addEventListener('click', click_handler)
				// mousedown event
					const mousedown_handler = (e) => {
						e.stopPropagation()
						if (!self.active) {
							ui.component.activate(self, false)
						}
					}
					input_iri.addEventListener('mousedown', mousedown_handler)
				// focus event
					const focus_handler = (e) => {
						// force activate on input focus (tabulating case)
						if (!self.active) {
							ui.component.activate(self, false)
						}
					}
					input_iri.addEventListener('focus', focus_handler)
				// keyup event
					const input_iri_keyup_handler = (e) => {
						// Enter key force to dispatchEvent change
						if ( e.key === 'Enter' && self.data.changed_data?.length ) {
							input_iri.dispatchEvent(new Event('change'))
							self.save()
							return false
						}
					}
					input_iri.addEventListener('keyup', input_iri_keyup_handler)

			// actions cluster: active checkbox + remove/link icons live together
			// in one flow element at the row end. As a flex item it wraps WITH the
			// row (and right-aligns itself on its own line), instead of the old
			// absolutely positioned icons that overlayed the inputs whenever the
			// row wrapped.
				const content_actions = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'content_actions',
					parent			: content_value
				})

			// active checkbox
				const use_active_check = typeof(self.context?.properties?.use_active_check) !== 'undefined'
					? self.context.properties.use_active_check
					: false
				if(use_active_check){

					const dataframe_data = current_value.dataframe
						? true
						: false

					const input_iri_active = ui.create_dom_element({
						element_type	: 'input',
						type			: 'checkbox',
						class_name		: 'input_iri_active',
						parent			: content_actions
					})
					input_iri_active.checked = dataframe_data
					// change event
					const change_active_handler = (e) => {

						// add style modified to wrapper node
							if (!self.node.classList.contains('modified')) {
								self.node.classList.add('modified')
							}

						// checked set for dataframe
							current_value.dataframe = input_iri_active.checked

						// update_value(self, i, current_value)
							self.change_handler(i, current_value)

						// force to save on every change
							const changed_data = self.data.changed_data || []
							self.change_value({
								changed_data	: changed_data,
								refresh			: false
							})
					}//end change_active_handler
					input_iri_active.addEventListener('change', change_active_handler)
				}
				const active_check_class = (use_active_check) ? 'active_check' : ''

			// button remove
				const button_remove = ui.create_dom_element({
					element_type	: 'span',
					title			: get_label.delete || 'Delete',
					class_name		: 'button remove hidden_button '+ active_check_class,
					parent			: content_actions
				})
				// mousedown event
				const button_remove_mousedown_handler = async (e) => {
					e.stopPropagation()
					e.preventDefault()

				// force possible input change before remove
					if (document.activeElement) {
						document.activeElement.blur()
					}

				// Show modal warning that deletion affects all languages
				// header
					const header = ui.create_dom_element({
						element_type	: 'div',
						class_name	: 'header'
					})
					ui.create_dom_element({
						element_type	: 'span',
						class_name	: 'label',
						inner_html	: (get_label.delete || 'Delete'),
						parent		: header
					})

				// body
					const body = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'content delete_entry'
					})
					ui.create_dom_element({
						element_type	: 'p',
						inner_html		: (get_label.sure_delete_entry_all_langs || 'This entry will be deleted from all languages.'),
						parent			: body
					})

				// footer
					const footer = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'content footer'
					})
					// button delete
						const button_delete = ui.create_dom_element({
							element_type	: 'button',
							class_name	: 'danger remove',
							text_content	: (get_label.delete || 'Delete'),
							parent			: footer
						})
						button_delete.addEventListener('click', function(evt) {
							evt.stopPropagation()
							modal.on_close()
							_do_remove_iri_entry(self, current_value, i, button_remove)
						})
					// button cancel
						const button_cancel = ui.create_dom_element({
							element_type	: 'button',
							class_name	: 'warning',
							text_content	: (get_label.cancel || 'Cancel'),
							parent			: footer
						})
						button_cancel.addEventListener('click', function(evt) {
							evt.stopPropagation()
							modal.on_close()
						})

				// modal
					const modal = ui.attach_to_modal({
						header	: header,
						body	: body,
						footer	: footer,
						size	: 'small'
					})
				}
				button_remove.addEventListener('mousedown', button_remove_mousedown_handler)

			// button link
				const button_link = ui.create_dom_element({
					element_type	: 'span',
					title			: get_label.link_resource || 'Link resource',
					class_name		: 'button link hidden_button '+ active_check_class,
					parent			: content_actions
				})
				// mousedown event
				const button_link_mousedown_handler = (e) => {
					e.stopPropagation()
					e.preventDefault()

					// open a new window
					//
					// THE SCHEME ALLOWLIST (P2-6 / XSS-04). `input_iri.value` is a
					// RECORD-AUTHORED value, and `window.open('javascript:…')` executes in
					// the window this page opens — the app CSP does not reach it. A
					// contributor who can write an IRI could therefore run script in a
					// curator's session by having them click the link button.
					const url = safe_url(input_iri.value)
					if (url===null) {
						console.warn('[component_iri] refused to open a non-http(s) URL:', input_iri.value)
						return
					}
					const current_window	= window.open(url, 'component_iri_opened', 'width=1024,height=720')
					// Ensure no reverse tabnabbing
					if (current_window) {
						current_window.opener = null;
						current_window.focus()
					}
				}//end button_link_mousedown_handler
				button_link.addEventListener('mousedown', button_link_mousedown_handler)

			// transliterate value object. Add only if has iri value.
				if(transliterate_value?.iri) {
					const transliterate_value_container = render_transliterate_value(transliterate_value);
					content_value.appendChild(transliterate_value_container)
				}
		})//end .then


	return content_value
}//end get_content_value



/**
* RENDER_TRANSLITERATE_VALUE
* Builds a read-only display node showing the IRI entry value from a sibling
* language (the transliteration fallback). This helps editors cross-reference
* the equivalent record in another language without leaving the edit form.
*
* Only fields that are present and non-empty on transliterate_value are rendered:
*   .title → <span class="title">
*   .iri   → <span class="iri">
* Elements are separated by a <span class="separator"> ' - ' inserted between
* each adjacent pair (not after the last).
* @param {Object} transliterate_value - sibling-language entry { title?, iri?, id? }
* @returns {HTMLElement} transliterate_value_container div with child spans
*/
export const render_transliterate_value = function (transliterate_value) {

	const transliterate_value_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'transliterate_value'
	})

	// elements
	const transliterate_elements = []

	// title
	if (transliterate_value.title) {
		const transliterate_title = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'title',
			inner_html		: render_value(transliterate_value.title, 'text')
		})
		transliterate_elements.push(transliterate_title)
	}

	// IRI
	if (transliterate_value.iri) {
		const transliterate_iri = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'iri',
			inner_html		: render_value(transliterate_value.iri, self.context.render_class)
		})
		transliterate_elements.push(transliterate_iri)
	}

	// Add nodes to transliterate_value_container
	const transliterate_elements_length = transliterate_elements.length
	for (let i = 0; i < transliterate_elements_length; i++) {
		const item = transliterate_elements[i]
		transliterate_value_container.appendChild(item)
		// separator. Add to all except the last node
		if (i < transliterate_elements_length -1) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'separator',
				inner_html		: ' - ',
				parent			: transliterate_value_container
			})
		}
	}


	return transliterate_value_container
}//end render_transliterate_value



/**
* GET_CONTENT_VALUE_READ
* Builds the read-only DOM subtree for a single IRI entry (permissions === 1).
*
* Used when the component is rendered in 'print' view or when the current user
* has read-only permissions. Unlike the editable variant (get_content_value),
* no inputs or action buttons are created. Instead:
*   - The paired component_dataframe is fetched only when current_value.id is
*     defined (rows without an id have no server-stored dataframe to display).
*     Rows that do have a value (component_dataframe.data?.value?.length > 0)
*     are rendered; empty dataframes are silently omitted.
*   - title is rendered as a <span class="title">.
*   - iri is rendered as an <a class="iri"> with rel="noopener noreferrer" to
*     prevent reverse tabnabbing when the link is opened in a new tab.
*
* The dataframe fetch is async; the content_value node is returned immediately
* and filled when the promise resolves.
* @param {number} i - zero-based index of this entry in self.data.entries
* @param {Object} current_value - the entry object { id?, iri, title }, may be {}
* @param {Object} self - component_iri instance
* @returns {HTMLElement} content_value node (read-only; dataframe appended asynchronously)
*/
const get_content_value_read = (i, current_value, self) => {

	// current_value. (!) Fallback to {} because could be null when new blank value is added
		current_value = current_value || {}

	// short vars
		const title	= current_value.title || ''
		const iri	= current_value.iri || ''

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only'
		})

	// dataframe (only for rows with id: the pairing key is the item id)
		const dataframe_promise = (typeof current_value.id!=='undefined')
			? get_dataframe({
				self				: self,
				section_id			: self.section_id,
				id_key				: current_value.id,
				main_component_tipo	: self.tipo,
				view				: 'line',
				mode				: 'list'
			})
			: Promise.resolve(null)

		dataframe_promise
		.then(async function(component_dataframe){

			// dataframe
				// set the component_dataframe, is mandatory use it.
				if(component_dataframe){
					// Add dataframe instance to component dependencies array
					self.ar_instances.push(component_dataframe)
					// Render it and append to content_value only if has value
					if (component_dataframe.data?.value?.length) {
						const dataframe_node = await component_dataframe.render()
						dataframe_node.classList.add('dataframe')
						content_value.appendChild(dataframe_node)
					}
				}

			// title
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'title',
					inner_html		: render_value(title, 'text'),
					parent			: content_value
				})

			// iri
				const link = ui.create_dom_element({
					element_type	: 'a',
					href			: iri,
					class_name		: 'iri',
					inner_html		: render_value(iri, self.context.render_class),
					parent			: content_value
				})
				// safe open
				link.setAttribute("rel", "noopener noreferrer");
		})


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Builds the component's top-level action buttons container.
*
* Rendered buttons are controlled by self.show_interface flags:
*   button_add : when true, adds a '+' button that appends a new blank entry row.
*                After insertion, an idle-callback focuses the new row's URL input.
*                If the position to be inserted already has a transliterate_value,
*                build_autoload is set to true so that the component immediately
*                fetches the dataframe subdatum from the server (otherwise the
*                dataframe starts in 'loading' state and refreshes on the first
*                IRI change).
*   tools      : when true, calls ui.add_tools to append any registered tool
*                buttons (e.g. tool_lang_multi, tool_history).
*
* The returned container uses a nested buttons_fold div to allow CSS sticky
* positioning on tall components.
* @param {Object} self - component_iri instance
* @returns {HTMLElement} buttons_container element with all applicable buttons inside
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// button add input
		if(show_interface.button_add === true){

			const button_add_input = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button add',
				title			: get_label.new || 'New',
				parent			: fragment
			})
			// click event
			const button_add_input_click_handler = (e) => {
				e.stopPropagation()

				// check existing key in transliterate_value
				// If the same key exists in the transliterate_value, force to refresh the component_iri
				// to get the subdatum of the dataframe.
				const current_key			= self.data.entries?.length || 0
				const transliterate_value	= self.data.transliterate_value || []
				const build_autoload		= transliterate_value[current_key] ? true : false

				const changed_data = [Object.freeze({
					action	: 'insert',
					id		: null,
					key		: current_key,
					value	: {value:null}
				})]
			self.change_value({
				changed_data	: changed_data,
				refresh			: true,
				build_autoload	: build_autoload
			})
			.then(()=>{
				dd_request_idle_callback(()=>{
					const new_key = self.data.entries ? self.data.entries.length - 1 : current_key
					const input_node = self.node.content_data[new_key]
						? self.node.content_data[new_key].querySelector('input.url')
						: null
					if (input_node) {
						input_node.focus()
					}
				})
			})
		}
		button_add_input.addEventListener('click', button_add_input_click_handler)
		}

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
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
* _DO_REMOVE_IRI_ENTRY
* Performs the confirmed deletion of a single IRI entry after the user has
* approved the confirmation modal opened by the button_remove mousedown handler.
*
* Steps:
*  1. Blurs any active input to commit pending changes before the remove.
*  2. Calls self.change_value with action:'remove' and the entry's server id
*     (null for unsaved rows). This persists the deletion and re-renders the
*     component.
*  3. Dataframe cleanup is server-authoritative: the PHP update_data_value
*     'remove' action cascades the paired dataframe row deletion. No client-side
*     dataframe delete call is made here.
*  4. If the component lives inside a caller (e.g. tool_lang_multi) that owns
*     other component_iri instances for the same model, those sibling instances
*     are refreshed so all language panels stay in sync.
*
* (!) alert() is called on caught errors. This is the existing contract;
*     it should ideally be replaced with a ui modal, but changing it is out of
*     scope for documentation-only edits.
* @param {Object} self - component_iri instance performing the removal
* @param {Object} current_value - the entry being removed { id?, iri, title, ... }
* @param {number} i - zero-based index of the entry in self.data.entries
* @param {HTMLElement} button_remove - the remove button span, used to read the
*   label from its previousElementSibling for the change_value label parameter
* @returns {Promise<void>}
*/
const _do_remove_iri_entry = async function(self, current_value, i, button_remove) {

	try {
		// force possible input change before remove
		if (document.activeElement) {
			document.activeElement.blur()
		}

		// Save value
		const changed_data = [Object.freeze({
			action	: 'remove',
			id		: current_value.id,
			key		: i,
			value	: null
		})]
		await self.change_value({
			changed_data	: changed_data,
			label			: button_remove?.previousElementSibling?.value || '',
			refresh			: true
		})

		// dataframe cleanup is server-authoritative: update_data_value 'remove'
		// cascades the paired dataframe rows (single-writer rule). No client
		// delete_dataframe call here.

		// Refresh caller instances (tool_lang_multi case)
		if (self.caller?.ar_instances) {
			const components = self.caller.ar_instances.filter(el =>
				el.model===self.model && el.data?.entries
			)

			if(SHOW_DEBUG===true) {
				console.log('Refreshing tool components. Total:', components.length - 1);
			}

			for (const component of components) {
				if (component.id !== self.id) {
					await component.refresh() // await the refresh if it's async
				}
			}
		}
	} catch (error) {
		console.error('Error in remove operation:', error)
		alert('An error occurred while removing the item. Please try again.')
	}
}//end _do_remove_iri_entry



// @license-end
