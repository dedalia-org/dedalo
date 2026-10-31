// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL, Promise */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import { render_value } from '../../common/js/utils/render_escape.js'
	import {get_instance} from '../../common/js/instances.js'
	import {same_section_id} from '../../common/js/utils/index.js'
	import {is_time_machine_view} from '../../component_common/js/events_subscription.js'



/**
* VIEW_DEFAULT_LIST_DATAFRAME
* Default list-mode view renderer for `component_dataframe`.
*
* `component_dataframe` is an alias of `component_portal` (see `component_dataframe.js`)
* that attaches frame records to individual data items of a main component.  In list
* mode, each dataframe button represents one attached frame section.  This view renders
* the compact button UI that appears inside the main component's list row:
*
*   - A pill-shaped "activate" button labelled with the component's ontology label.
*     When there is an existing frame record, clicking opens it in a modal.
*     When there is no frame record yet, clicking briefly reveals the "add" button.
*   - A hidden "add" (+) icon button that creates a new frame section via
*     `self.create_new_section()` and then opens the same modal.
*   - Optional background-color theming based on a rating value stored inside the
*     frame section's `hide.ddo_map` (a `component_radio_button` with role 'rating').
*     This provides at-a-glance visual feedback (e.g. quality confidence) directly
*     on the pill button without exposing the underlying radio component.
*
* Exported static methods:
*   view_default_list_dataframe.render(self, options) — entry point called by `list()`.
*   view_default_list_dataframe.is_read_only(self)    — the chip's read-only predicate.
*
* Private module-scoped helpers (not exported):
*   get_content_data(self)                — builds the .content_data container node.
*   render_content_value(options)         — builds the activate+add buttons and wires events.
*   open_target_section(self)             — creates the frame section instance and modal.
*
* Data shapes consumed from `self`:
*   self.data.entries  {Array}   — array of frame locators; each is a dataframe locator
*                                  of shape {type, section_tipo, section_id, id_key, …}.
*                                  Length 0 → no frame exists yet; ≥1 → at least one frame.
*   self.properties.label {string} — ontology label shown on the activate button.
*   self.get_rating()  {Object|null} — returns a datum entry for the 'rating' ddo, or null.
*   self.target_section {Array}   — array of {label, tipo} objects from the sqo section_tipo
*                                   config; index 0 is used as the modal header.
*   self.datum.data    {Array}    — full unfiltered datum data shared with parent section.
*
* Relationship to the mini view: `view_mini_list_dataframe` provides the same
* activate-button concept for inline/mini render contexts but omits click behaviour
* (read-only display).  This module adds full interactive create/open/delete flows.
*/
export const view_default_list_dataframe = function() {

	return true
}//end view_default_list_dataframe



/**
* RENDER
* Entry point for the default list view of a `component_dataframe` instance.
*
* Builds the content_data subtree and optionally wraps it in the standard
* component wrapper produced by `ui.component.build_wrapper_edit()`.
*
* Two render levels are supported (mirrors the pattern used by other list views):
*   - 'full'    (default): returns the full wrapper element including the outer
*     component shell.  Used on initial render.
*   - 'content': returns only the inner content_data node.  Used by the parent
*     component's refresh mechanism to replace only the dataframe cell area
*     without rebuilding the full outer shell.
*
* The returned wrapper carries a `content_data` pointer so callers can access
* the inner node without re-querying the DOM.
*
* @param {Object} self    - The `component_dataframe` instance (alias of `component_portal`).
* @param {Object} options - Render options passed from the list/render pipeline.
* @param {string} [options.render_level='full'] - 'full' → full wrapper;
*   'content' → content_data node only.
* @returns {Promise<HTMLElement>} The wrapper element (full) or content_data node (content).
*/
view_default_list_dataframe.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			label			: null
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* IS_READ_ONLY
* Whether this slot's chip must stay inert: no open of the frame target, no
* create, no refresh, no Delete.
*
* The chip's only interactive door (open_target_section) opens the LIVE target
* record in an EDITABLE modal whose Delete unlinks at the slot's own coordinates
* and whose close refreshes it from the live store. That is wrong everywhere the
* slot is not the live editable record:
*   - permissions < 2 (or show_interface.read_only), as for any read-only component;
*   - a Time Machine surface (is_time_machine_view — the dd15 history list, whose
*     cell coordinates are (host section, dd15 row id), or a tool preview): the
*     chip shows a HISTORICAL frame, and the live target is not what it shows.
* Read-only means no action at all (no read-only viewer): the chip still paints
* its label + rating colour, with the 'read_only' state other components use.
*
* @param {Object} self - The `component_dataframe` instance.
* @returns {boolean}
*/
view_default_list_dataframe.is_read_only = function(self) {

	return self.permissions < 2
		|| self.show_interface?.read_only===true
		|| is_time_machine_view(self)
}//end is_read_only



/**
* GET_CONTENT_DATA
* Builds the `.content_data` container element and populates it with the
* rendered content_value subtree (activate button + add button).
*
* Delegates all interactive logic to `render_content_value()`.
*
* @param {Object} self - The `component_dataframe` instance.
* @returns {HTMLElement} A `.content_data` div containing the button UI.
*/
const get_content_data = function(self) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// content_value. render content_value node
		const content_value = render_content_value({
			self : self
		})
		content_data.appendChild(content_value)


	return content_data
}//end get_content_data



/**
* RENDER_CONTENT_VALUE
* Builds the interactive button area for the dataframe list cell.
*
* Renders two sibling elements inside a `.content_value` div:
*
*   1. **button_activate** — a pill-shaped `<span>` labelled with the
*      component's ontology label (`self.properties.label`).  Its visual state
*      depends on whether a frame record already exists:
*
*      - No frame (entries.length === 0): clicking the button briefly hides itself
*        and reveals the "add" button for 5 seconds, then restores the original state.
*        This avoids a permanent mode switch and prevents accidental record creation.
*      - Frame exists (entries.length >= 1): clicking calls `open_target_section()`
*        to open the most-recent frame section in a modal.
*
*   2. **button_new** — a hidden "add" icon button.  On click it calls
*      `self.create_new_section()` (inherited from `component_dataframe.js`).
*      If that method returns `false` (meaning pending main-component changes were
*      flushed first — the save-then-attach rule), the modal is suppressed because
*      the component will re-render with fresh pairing keys.  Otherwise the new
*      frame section is immediately opened via `open_target_section()`.
*
* Rating colour theming:
*   When entries exist AND the request_config's hide.ddo_map contains a ddo with
*   `role === 'rating'` (a `component_radio_button`), the activate button's
*   background colour is driven by the matched datalist item's `hide[0].literal`
*   hex colour.  The text colour is auto-computed via `ui.get_text_color()` for
*   WCAG contrast.  When no rating value is set, `--color_blue_3` (#006ed2) is used
*   as the default background.
*
* The `altKey` modifier on mousedown is reserved for debugging instance selection
* (a developer tool) and bypasses all click handling.
*
* Read-only (view_default_list_dataframe.is_read_only — permissions < 2 or a
* Time Machine surface): the activate button gets no handler and button_new is
* not rendered; content_value carries 'read_only'. Label and rating colour stay.
*
* @param {Object} options      - Configuration object.
* @param {Object} options.self - The `component_dataframe` instance.
* @returns {HTMLElement} A `.content_value` div containing button_activate and button_new.
*/
const render_content_value = function(options) {

	// options
		const self	= options.self

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []
		const default_bk_color = ui.css_var('--color_blue_3', '#006ed2');
		const read_only	= view_default_list_dataframe.is_read_only(self)

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value' + (read_only ? ' read_only' : '')
		})

	// button_activate
		const button_activate = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button activate',
			text_content 	:  self.properties.label || '?',
			parent			: content_value
		})
		// read_only: an inert chip — no handler (the event reaches the row like any
		// read-only cell) and no pointer cursor (the stylesheet forces it !important)
		if (read_only) {
			button_activate.style.setProperty('cursor', 'default', 'important')
		}else{
			button_activate.addEventListener('mousedown', fn_mousedown)
		}
		function fn_mousedown(e) {
			e.stopPropagation()

			// debug selecting instance case
			if (e.altKey) {
				return
			}

			if(entries.length<1) {

				// hide self button
				button_activate.classList.add('hide')

				// show add button
				button_new.classList.remove('hide')

				// restore class after time interval
				setTimeout(function(){
					[button_activate,button_new].map(el => {
						el.classList.toggle('hide')
					})
				}, 5000)

			}else{

				// open modal
				open_target_section(self)
			}
		}//end fn_mousedown

		if(entries.length >= 1) {

			const rating_data = self.get_rating()
			// the selected rating locator lives in `entries` (the v7 data model);
			// `value` kept as a fallback for any legacy datum shape.
			const rating_entries = rating_data && (rating_data.entries ?? rating_data.value)
			if(rating_entries){

				const rating_value = rating_entries[0]
				// a rating item may arrive WITHOUT a datalist (a mode the server emits
				// stored data only for, e.g. 'solved'): no datalist = no option = the
				// default colour, never a throw (it killed the portal refresh after a
				// time machine apply).
				const datalist = Array.isArray(rating_data.datalist) ? rating_data.datalist : []
				const rating = (rating_value)
					? datalist.find(el => same_section_id(el.section_id, rating_value.section_id) )
					: {
						hide:[{
							literal: default_bk_color // gray/blue when the datalist is empty (the rating is not set)
						}]
					}

				// update background color
				// Defensive on BOTH steps: find() returns undefined when the stored
				// rating locator is not in the datalist (a deleted/out-of-scope option),
				// and a datalist option's `hide` is not guaranteed to be populated —
				// the TS engine currently emits `hide: []` for every datalist option
				// (src/core/relations/datalist.ts, ledgered uncovered scope), so
				// `rating.hide[0].literal` threw "Cannot read properties of undefined
				// (reading 'literal')" and killed the whole record render. The colour
				// is decoration; it must never be able to take the page down.
					const bg_color = rating?.hide?.[0]?.literal || default_bk_color
					button_activate.style.backgroundColor = bg_color

				// update text color based on background
					const text_color = ui.get_text_color(bg_color)
					button_activate.style.color = text_color
			}
		}

	// read_only: no add button (nothing to create) — the chip alone
		if (read_only) {
			return content_value
		}

	// button_new
		const button_new = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button add icon hide',
			title			: get_label.new || 'New',
			parent			: content_value
		})
		button_new.addEventListener('click', function (e) {
			e.stopPropagation()

			self.create_new_section({
				data : data
			})
			.then(function(response) {

				// aborted attach (save-then-attach flushed pending caller
				// changes and re-rendered): do not open the modal
				if (response===false) {
					return
				}

				// open modal
				open_target_section(self)
			})
		})


	return content_value
}//end render_content_value



/**
* OPEN_TARGET_SECTION
* Creates a `section` instance for the most-recent frame record and opens it in a modal.
*
* This is the primary interactive surface for editing dataframe content.  The modal
* provides a full edit form for the linked frame section, including a footer Delete
* button that removes the frame by calling `self.unlink_record()`.
*
* Flow:
*   1. Reads the LAST entry from `self.data.entries` (the most-recently linked frame
*      record).  The dataframe contract allows only one frame per main item in the
*      standard list view, so the last entry is the canonical one.
*   2. Builds a modal body container with a fixed height (34rem).
*   3. Uses `self.target_section[0].label` as the modal header title.  This value
*      comes from the ontology label of the frame section type resolved during
*      `component_portal.build()` into `self.target_section`.
*   4. Adds a Delete button in the modal footer.  On confirmation:
*      - Calls `self.unlink_record(last_value)` — removes the frame locator from
*        the slot. What happens to the frame TARGET record is the SERVER's
*        decision, resolved from this slot node's ontology by the one reader
*        (`dataframeDeletePolicyOf`, src/core/relations/dataframe.ts) and
*        served as `context.delete_policy`: `delete_target` empties it (row
*        kept, recoverable from Time Machine) once the unlink has committed,
*        `unlink` leaves it. No policy removes the target row — Time Machine
*        renders past states through it (the v6 `hard_delete: true` is
*        inert). The client never deletes the target.
*      - Closes the modal immediately after the unlink.
*   5. Opens the modal via `ui.attach_to_modal()`.  The `callback` is invoked once
*      the modal DOM is attached; it uses `ui.load_item_with_spinner()` to show a
*      loading spinner while the section instance is built asynchronously.
*   6. Inside the spinner callback, creates a `section` instance via `get_instance()`
*      using `session_key: 'section_<section_tipo>_<self.tipo>'`.  The session key
*      scopes the instance to this exact dataframe component so that multiple
*      dataframe columns on the same section record do not share state.
*      `session_save: false` prevents the section from being persisted to the
*      browser session store (frame records are transient to the modal).
*   7. When the modal closes (`modal.on_close`), calls `self.refresh()` with
*      `build_autoload: true` to re-fetch data from the server, ensuring the button's
*      rating colour and label reflect any edits made inside the modal.
*
* @param {Object} self - The `component_dataframe` instance.
*   self.data.entries must be non-empty (caller's responsibility; this function
*   does not guard against an empty entries array).
* @returns {Promise<void>}
*/
const open_target_section = async function (self) {

	// last_value. Get the last value of the portal to open the new section
		const last_value	= self.data.entries[self.data.entries.length-1]
		const section_tipo	= last_value.section_tipo
		const section_id	= last_value.section_id

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body block',
			style			: {
				height : '34rem'
			}
		})

	// header
		// (!) The modal header is parsed as HTML by attach_to_modal: the section
		// label is ontology data, it goes through the ONE escaper as text.
		const header = render_value(self.target_section[0].label, 'text')

	// footer
		const footer_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content center'
		})
		// button_delete
			const button_delete = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'delete icon danger',
				inner_html		: get_label.delete || 'Delete',
				parent			: footer_container
			})
			button_delete.addEventListener('click', async function (e) {
				e.stopPropagation()

				// stop if the user don't confirm
				if (!confirm(get_label.sure)) {
					return
				}

				footer_container.classList.add('loading')

				// unlink. The server applies the slot's delete policy to the
				// target AFTER the locator is gone. AWAITED and READ: the modal
				// closing is the grammar of "deleted", and it must not play over
				// a refused or cancelled unlink (false — the API failure itself
				// is already surfaced by the save path's handle_api_error).
					const removed = await self.unlink_record(last_value)

				footer_container.classList.remove('loading')

				// close modal only after the unlink landed
					if (removed===true) {
						modal.close()
					}
			})

	// modal. Create a modal to attach the section node
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer_container,
			callback : () => {
				ui.load_item_with_spinner({
					container	: body,
					label		: 'section',
					callback	: async () => {

						// section. Create the target section instance
						// caller: the slot. The modal lives outside the list row,
						// so this link is how the row's record window sees an
						// edit inside it (its pins walk `caller` to the row,
						// WC-2026-10-30-section-record-row-box): without it the row
						// could be released, and this slot destroyed, under an open
						// modal. Re-asserted after get_instance: `caller` is not
						// part of the instance key and a cache hit skips init.
						const section = await get_instance({
							model			: 'section',
							mode			: 'edit',
							tipo			: section_tipo,
							section_tipo	: section_tipo,
							section_id		: section_id,
							inspector		: false,
							session_save	: false,
							session_key		: 'section_' + section_tipo + '_' + self.tipo,
							caller			: self
						})
						section.caller = self
						await section.build(true)
						const section_node = await section.render()

						return section_node
					}
				})
			}
		})
		modal.on_close = function(){
			self.refresh({
				build_autoload : true
			})
		}
}//end open_target_section



// @license-end
