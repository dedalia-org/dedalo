// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_COMPONENT_EMAIL
* Client-side edit renderer for `component_email`.
*
* This module owns the DOM construction for edit mode and exposes three
* shared helpers (`get_content_data`, `get_buttons`, `change_handler`,
* `remove_handler`) that are consumed directly by the view modules:
*   - view_default_edit_email.js
*   - view_line_edit_email.js
*   - view_mini_email.js
*
* Entry point: `render_edit_component_email.prototype.edit(options)` —
* dispatched from `component_email.prototype.edit` (prototype alias in
* component_email.js).
*
* Data shape expected on `self.data`:
*   {
*     entries: [
*       { id: <number|null>, value: <string>, lang: <string> },
*       ...
*     ]
*   }
* Each entry represents one email address stored in a given language.
* An entry `id` of null means the row has never been persisted.
*
* Permissions model:
*   - self.permissions === 1  → read-only; inputs are replaced with plain
*                               `<div>` text nodes.
*   - self.permissions > 1   → full edit with add/remove/send buttons.
*
* `changed_data` mutation protocol: every edit or removal calls
* `self.change_value({ changed_data, refresh })` with a frozen array of
* change descriptors:
*   { action: 'insert'|'update'|'remove', id, key, value }
* The id originates from the server entry; it is null for new entries.
* `refresh: true` triggers a full re-render of the component's content area.
*
* Exports: `render_edit_component_email` (constructor),
*          `get_content_data`, `get_buttons`, `change_handler`,
*          `remove_handler`.
*/



// imports
	import { add_instance } from '../../common/js/instances.js'
import {ui} from '../../common/js/ui.js'
import {render_value} from '../../common/js/utils/render_escape.js'
import {attach_item_dataframe} from '../../component_common/js/component_common.js'
import {stop_page_shortcuts} from '../../common/js/utils/keyboard.js'
	import {view_default_edit_email} from './view_default_edit_email.js'
	import {view_line_edit_email} from './view_line_edit_email.js'
	import {view_mini_email} from './view_mini_email.js'



/**
* RENDER_EDIT_COMPONENT_EMAIL
* Constructor for the edit-mode renderer.
* Acts as a namespace for `prototype.edit`; all rendering helpers are
* module-level functions, not prototype methods, so only `edit` lives here.
*/
export const render_edit_component_email = function() {

	return true
}//end render_edit_component_email



/**
* EDIT
* Selects and delegates to the correct view for edit mode.
* Called via the `component_email.prototype.edit` prototype alias.
*
* Supported views (read from `self.context.view`):
*   - 'line'    → compact single-line widget with an exit-edit button.
*   - 'mini'    → minimal read-like display (no editing widgets).
*   - 'print'   → same DOM as 'default' but forces `self.permissions = 1`
*                 so all inputs render as read-only plain text, and the
*                 wrapper class is 'view_print'; CSS can target this class
*                 for print-specific styling.
*   - 'default' → full edit form with add/remove/send-email buttons.
*
* (!) The 'print' case intentionally falls through to 'default' after
* forcing permissions; this is correct switch-fall-through behaviour.
*
* @param {Object} options - Rendering options forwarded to the view (includes
*   `render_level`: 'full' | 'content').
* @returns {Promise<HTMLElement>} Resolved wrapper or content_data element.
*/
render_edit_component_email.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line':
			return view_line_edit_email.render(self, options)

		case 'mini':
			return view_mini_email.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1;

		case 'default':
		default:
			return view_default_edit_email.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA
* Builds the `content_data` container that holds one `content_value` row
* per entry in `self.data.entries`.
*
* When the entries array is empty, a single blank row is still rendered so
* the user sees at least one input field immediately (value_length defaults
* to 1).
*
* Each rendered row is stored as a numeric property on the returned element
* (`content_data[0]`, `content_data[1]`, …) so that callers can find rows
* by index without querying the DOM.
*
* Permissions gate:
*   - `self.permissions === 1` → `get_content_value_read` (plain text div).
*   - otherwise               → `get_content_value` (live `<input>` row).
*
* @param {Object} self - Component instance.
* @returns {HTMLElement} Populated `content_data` container div.
*/
export const get_content_data = function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self)

	// build values
		const inputs_value = entries
		const value_length = inputs_value.length || 1
		for (let i = 0; i < value_length; i++) {
			const input_element_node = (self.permissions===1)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self)
			content_data.appendChild(input_element_node)
			// set the pointer
			content_data[i] = input_element_node
			// dataframe (read-only path): get_content_value attaches the dataframe for
			// writers; the read-only branch (permissions===1, e.g. Time Machine preview)
			// is not handled there, so attach it here too. No-op without has_dataframe.
			if (self.permissions===1) {
				attach_item_dataframe({
					self		: self,
					item		: inputs_value[i],
					container	: input_element_node,
					view		: self.view
				})
			}
		}


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Builds one editable `content_value` row for a single email entry.
*
* The row contains:
*   - A text `<input>` pre-filled with `current_value?.value`.
*   - A 'remove' button (only rendered when `i > 0` so the first row
*     cannot be deleted — the user empties it instead).
*   - An 'email' button that opens the system mail client for the address.
*   - An optional dataframe literal-view glue injected by `attach_item_dataframe`.
*
* Mandatory styling: when `self.context.properties.mandatory` is true and
* the entry has no value, the CSS class `mandatory` is appended to the input
* so the UI can highlight required empty fields.
*
* Event strategy:
*   - `mousedown` / `click` on the input call `stopPropagation` to prevent
*     the section container from intercepting the event and stealing focus;
*     `mousedown` activates the component (the wrapper never sees it).
*   - `focus` activates the component (needed when the user tabs into the field).
*   - `keydown` with Tab key deactivates the component and lets the browser
*     move focus naturally.
*   - `change` triggers `change_handler`, which validates and persists the value.
*
* @param {number} i - Zero-based index of this entry within `data.entries`.
* @param {Object|undefined} current_value - Entry object `{ id, value, lang }`
*   from `data.entries[i]`; may be undefined for the blank first row.
* @param {Object} self - Component instance.
* @returns {HTMLElement} The `content_value` div for this email row.
*/
const get_content_value = (i, current_value, self) => {

	const mode = self.mode
	// check if the component is mandatory and it doesn't has value
	const add_class = self.context.properties.mandatory && !current_value
		? ' mandatory'
		: ''

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// input field
		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'input_value' + add_class,
			value			: current_value?.value,
			parent			: content_value
		})
		// mousedown event. Capture event propagation and activate here, before the
		// focus moves: the wrapper handler never sees this event
		const mousedown_handler = (e) => {
			e.stopPropagation()
			if (!self.active) {
				ui.component.activate(self, false)
			}
		}
		input.addEventListener('mousedown', mousedown_handler)

		// focus event
		const focus_handler = (e) => {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self, false)
			}
		}
		input.addEventListener('focus', focus_handler)

		// keydown event
		// (!) Escape is let through: the page-level handler deactivates the component.
		const keydown_handler = (e) => {
			stop_page_shortcuts(e)
			if(e.key==='Tab'){
				ui.component.deactivate(self)
				return
			}
		}
		input.addEventListener('keydown', keydown_handler)

		// click event. Capture event propagation
		const click_handler = (e) => {
			e.stopPropagation()
		}
		input.addEventListener('click', click_handler)

		// change event
		const input_change_handler = (e) => {
			change_handler(e, i, self)
		}
		input.addEventListener('change', input_change_handler)

	// add buttons to the email row
		// button_remove
			if (i>0) {
				const button_remove = ui.create_dom_element({
					element_type	: 'span',
					title			: get_label.delete || 'Delete',
					class_name		: 'button remove hidden_button',
					parent			: content_value
				})
				const mouseup_handler = (e) => {
					e.stopPropagation()
					remove_handler(input, current_value?.id, i, self)
				}
				button_remove.addEventListener('mouseup', mouseup_handler)
			}

		// button email
			const button_email = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button email hidden_button',
				parent			: content_value
			})
			const mouseup_handler = (e) => {
				e.stopPropagation()
				self.send_email(input.value)
			}
			button_email.addEventListener('mouseup', mouseup_handler)

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
* Renders a single email entry as a non-interactive read-only element.
* Used when `self.permissions === 1` (e.g. view='print', or the current
* user has view-only access).
*
* The raw email string is rendered as inner HTML. Empty/undefined entries
* produce an empty div rather than a broken layout.
*
* @param {number} i - Zero-based index of this entry within `data.entries`.
* @param {Object|undefined} current_value - Entry object `{ id, value, lang }`
*   from `data.entries[i]`; may be undefined.
* @param {Object} self - Component instance.
*
* @returns {HTMLElement} A `content_value read_only` div containing the
*   plain email string (no input, no buttons).
*/
const get_content_value_read = (i, current_value, self) => {

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only',
			inner_html		: render_value(current_value?.value, self.context.render_class)
		})


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Builds the buttons container for the component's toolbar area.
*
* Buttons are conditionally rendered based on `self.show_interface`:
*
* `button_add` (show_interface.button_add === true):
*   Inserts a new blank entry into `data.entries` via `self.change_value`
*   with `action: 'insert'`. After insertion the component re-renders
*   (`refresh: true`) and focus moves to the new input field.
*   Edge case: if `data.entries` is empty or absent, clicking add focuses
*   the existing first input instead of appending a duplicate blank row.
*
* `email_multiple` (show_interface.tools === true):
*   Compiles all email addresses in the current search result set by
*   calling `self.get_ar_emails()`, then opens a `mailto:?bcc=…` URI.
*   Because operating systems impose a character limit on mailto URIs
*   (approximately 2000 chars on Windows), `get_ar_emails` may return
*   more than one string chunk. When more than one chunk is returned a
*   modal is displayed with one button per chunk so the user can open
*   each batch separately.
*
* `tools` (show_interface.tools === true):
*   Standard shared tool buttons appended via `ui.add_tools`.
*
* @param {Object} self - Component instance.
* @returns {HTMLElement} The fully populated `buttons_container` element.
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// button add input
		if(show_interface.button_add === true){

			// button_add_input
			const add_button = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button add',
				title			: get_label.new || 'Add new input field',
				parent			: fragment
			})
			const click_handler = async (e) => {
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
						value : null,
						lang : self.lang
					}
				})]

				await self.change_value({
					changed_data	: changed_data,
					refresh			: true
				})

				const new_key = self.data.entries.length - 1
				const input_node = self.node.content_data[new_key]
					? self.node.content_data[new_key].querySelector('input')
					: null
				if (input_node) {
					input_node.focus()
				}else{
					console.warn('Empty input_node:', self.node.content_data, new_key);
				}
			}
			add_button.addEventListener('click', click_handler)
		}

	// button send_multiple_email
		if(show_interface.tools === true){
			const send_multiple_email = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button email_multiple',
				title			: get_label.send_email_to_all || 'Send an e-mail to all the records found (Bcc)',
				parent			: fragment
			})
			const click_handler = async (e) => {
				e.stopPropagation()

				const ar_emails	= await self.get_ar_emails()
				if(!ar_emails || !ar_emails.length){
					console.warn('Empty ar_emails:', ar_emails);
					return
				}
				const mailto_prefix	= 'mailto:?bcc=';
				// ar_mails could be an array with 1 string item with all addresses or more than 1 string when the length is more than length supported by the SO (in Windows 2000 charts)
				// if the maximum chars is surpassed the string it was spliced in sorted strings and passed as string items of the array
				// every item of the array will be opened by the user to create the email
				if(ar_emails.length > 1){

					const body = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'body'
					})

					const body_title = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'body_title',
						text_node		: get_label.email_limit_explanation,
						parent			: body
					})
					// create the mail with the addresses and create the buttons to open the email app
					for (let i = 0; i < ar_emails.length; i++) {

						const current_emails = ar_emails[i]
						// find the separator to count the total of emails for every chunk of emails.
						const regex = /;/g;
						const search_number_of_email =  current_emails.match(regex) || []
						const number_of_email = search_number_of_email.length > 0
							? search_number_of_email.length +1
							: 1
						const buton_option = ui.create_dom_element({
							element_type	: 'button',
							class_name		: 'warning',
							inner_html		: (get_label.email || 'email') + ': ' + render_value(number_of_email, 'number'),
							parent			: body
						})

						buton_option.addEventListener('mouseup', function (e) {
							// when the user click in the button remove the option and open the email with the addresses
							buton_option.remove()
							window.location.href = mailto_prefix + current_emails
						})
					}

					// modal. create new modal with the email buttons
						ui.attach_to_modal({
							header	: get_label.alert_limit_of_emails || 'emails limitation',
							body	: body,
							footer	: null,
							size	: 'small'
						})

				}else{
					window.location.href = mailto_prefix + ar_emails[0]
				}
			}
			send_multiple_email.addEventListener('click', click_handler)
		}

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)
		buttons_container.appendChild(fragment)


	return buttons_container
}//end get_buttons



/**
* CHANGE_HANDLER
* Validates the new input value and persists it via `self.change_value`.
*
* Called on the `change` event of each email `<input>`. Validation is
* delegated to `self.verify_email` (defined on `component_email.prototype`),
* which accepts an empty string as valid (allows the user to clear an address).
* When validation fails the `error` CSS class is applied to the input via
* `ui.component.error` and the function returns `false` without saving.
*
* The change is sent with `refresh: false` so the DOM is not rebuilt for a
* simple value edit — only `insert` and `remove` operations need a full
* re-render.
*
* The frozen `changed_data` descriptor:
*   { action: 'update', id: <number|null>, key: <number>, value: { value, lang } }
* `id` is null when the entry has never been saved to the server.
*
* @param {Event} e - The DOM change event from the input element.
* @param {number} key - Zero-based index of the entry being edited in
*   `self.data.entries`.
* @param {Object} self - Component instance.
* @returns {boolean} `true` when the value was valid and saved; `false` when
*   validation failed (no save is performed).
*/
export const change_handler = function(e, key, self) {

	const input_value = e.target.value || ''

	const data			= self.data || {}
	const entries			= data.entries || []
	const item_value	= (entries[key]) ? entries[key] : {lang: self.lang}

	// validate
	const validated = self.verify_email(input_value)
	// set errors class
	ui.component.error(!validated, e.target)
	if (!validated) {
		return false
	}

	item_value.value = input_value

	// change data
		const changed_data_item = Object.freeze({
			action	: 'update',
			id		: entries[key]?.id || null,
			key		: key,
			value	: item_value
		})

	// change_value (save data)
		self.change_value({
			changed_data	: [changed_data_item],
			refresh			: false
		})


	return true
}//end change_handler



/**
* REMOVE_HANDLER
* Handles the remove-button click for a single email entry.
*
* Behaviour differs based on `self.context.translatable`:
*
*   Translatable components (`is_translatable === true`):
*     Shows a confirmation modal warning the user that the entry will be
*     deleted across all languages. The user must explicitly confirm via
*     the 'Delete' button; cancelling aborts the removal entirely.
*     Deletion is deferred to `_do_remove` after the modal button click.
*
*   Non-translatable components:
*     Uses a synchronous `confirm()` dialog only when the input field
*     currently has a value. Emptied rows are removed silently.
*     Then calls `_do_remove` directly.
*
* In both paths, `document.activeElement.blur()` is called first to
* guarantee that any pending `change` event fires before the remove runs,
* preventing a race between a dirty input and the deletion.
*
* (!) `confirm()` is a blocking synchronous call. On some browsers this can
* interfere with animation frames. Consider migrating to a modal approach
* (as already done for translatable components) when refactoring the UI.
*
* @param {HTMLElement} input - The `<input>` element for this row (its
*   `.value` is read to populate the confirm dialog message).
* @param {number|null} id - Server-side id of the entry; null for unsaved rows.
* @param {number} key - Zero-based array index of the entry in `data.entries`.
* @param {Object} self - Component instance.
* @returns {Promise<*>|undefined} Returns the promise from `_do_remove` when
*   deletion proceeds; returns undefined when the user cancels.
*/
export const remove_handler = function(input, id, key, self) {

	// force possible input change before remove
		document.activeElement.blur()

	// value
		const current_value = input.value ? input.value : null

	// translatable components: show modal warning that deletion affects all languages
		const is_translatable = self.context?.translatable === true

	if (is_translatable) {

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
				button_delete.addEventListener('click', function(e) {
					e.stopPropagation()
					// proceed with deletion
					modal.on_close()
					_do_remove(id, key, self, current_value)
				})
			// button cancel
				const button_cancel = ui.create_dom_element({
					element_type	: 'button',
					class_name	: 'warning',
					text_content	: (get_label.cancel || 'Cancel'),
					parent			: footer
				})
				button_cancel.addEventListener('click', function(e) {
					e.stopPropagation()
					modal.on_close()
				})

		// modal
			const modal = ui.attach_to_modal({
				header	: header,
				body	: body,
				footer	: footer,
				size	: 'small'
			})

		return
	}

	// non-translatable: simple confirm dialog
	if (current_value) {
		if (!confirm(get_label.sure)) {
			return
		}
	}

	_do_remove(id, key, self, current_value)
}//end remove_handler



/**
* _DO_REMOVE
* Executes the actual remove operation after confirmation.
* Sends a single frozen `changed_data` descriptor with `action: 'remove'`
* to `self.change_value`. `refresh: true` causes the component to re-render
* its content area so the removed row disappears and remaining rows are
* re-indexed.
*
* `value` is set to null (the server ignores it for remove actions); the
* `label` field carries the original email string for activity-log purposes.
*
* @param {number|null} id - Server-side entry id; null for unsaved rows.
* @param {number} key - Zero-based index of the entry in `data.entries`.
* @param {Object} self - Component instance.
* @param {string|null} current_value - The email string that was in the
*   removed input; forwarded as `label` for the change-value activity log.
* @returns {Promise<*>} Promise resolved when the API acknowledges the change.
*/
const _do_remove = function(id, key, self, current_value) {

	// changed_data
		const changed_data = [Object.freeze({
			action	: 'remove',
			id		: id,
			key		: key,
			value	: null
		})]

	// change_value. Returns a promise that is resolved on api response is done
		const response = self.change_value({
			changed_data	: changed_data,
			label			: current_value,
			refresh			: true
		})


	return response
}//end _do_remove



// @license-end
