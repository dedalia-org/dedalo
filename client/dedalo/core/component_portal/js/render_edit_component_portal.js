// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_COMPONENT_PORTAL
*
* Edit-mode rendering layer for `component_portal` — the relational component that
* links a host record to one or more records in a target section and presents them as
* a paginated, drag-reorderable list.
*
* This module fulfils two roles:
*
* 1. **View dispatch** (`render_edit_component_portal.prototype.edit`)
*    Mixed into `component_portal` as its `edit` prototype method.  Reads
*    `self.context.view` and delegates to the appropriate view render module
*    (`view_default_edit_portal`, `view_line_edit_portal`, etc.).  The `print` view
*    forces read-only permissions before falling through to the `default` handler.
*    Unknown or future views can be registered dynamically via `self.render_views`.
*
* 2. **Shared DOM helpers** (all exported)
*    These are imported and called by every concrete view module:
*    - `render_column_id`           — "open record" button + drag handle + drop zone per row.
*    - `render_column_component_info` — optional `ddinfo` overlay for a row.
*    - `render_column_remove`       — unlink / delete button with confirmation modal.
*    - `get_buttons`                — toolbar above the list (add, link, tree, fullscreen…).
*    - `get_buttons_by_permissions` — permission-aware toolbar: full at >1, external refresh only at 1.
*    - `activate_autocomplete`      — lazily instantiates `service_autocomplete` on demand.
*    - `build_header`               — column-header row (hidden when list is empty).
*    - `render_references`          — read-only back-reference list for relation-related views.
*    - `add_wrapper_events`         — click-to-activate-autocomplete + optional drag/drop on wrapper.
*    - `add_section_record_drag_and_drop` — marks a row node as draggable (mosaic/line).
*
* Key data shapes consumed from the component instance (`self`):
* - `self.data.entries`      — `Array<Locator>` where each Locator is
*                              `{ id, type, section_tipo, section_id, from_component_tipo }`.
* - `self.datum.data`        — flat array of all component data items for the portal's records,
*                              used to pull `ddinfo` values.
* - `self.data.pagination`   — `{ offset, limit }` for the current page window.
* - `self.total`             — total matched records (used to clamp sort-order input).
* - `self.show_interface`    — flags controlling which UI elements are visible
*                              (`button_add`, `button_link`, `button_list`, `show_section_id`, …).
* - `self.target_section`    — Array of DDO descriptors for the target section(s);
*                              each entry may carry a `buttons` array with `button_new` /
*                              `button_delete` entries that gate the corresponding UI buttons.
* - `self.render_views`      — Array of `{ view, mode, render, path? }` entries for
*                              dynamic-import of custom view modules.
* - `self.permissions`       — `1` = read-only, `2` = full edit.
*
* @module render_edit_component_portal
* @see component_portal.js            for the constructor and prototype wiring.
* @see view_default_edit_portal.js    for the default table view implementation.
* @see drag_and_drop.js               for the drag-and-drop event handlers.
* @see docs/core/components/component_portal.md for the full specification.
*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_instance} from '../../common/js/instances.js'
	import {when_in_dom,dd_request_idle_callback} from '../../common/js/events.js'
	import {object_to_url_vars, open_window, get_caller_by_model, same_section_id} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {render_relation_list} from '../../section/js/render_common_section.js'
	import {view_default_edit_portal} from './view_default_edit_portal.js'
	import {view_line_edit_portal} from './view_line_edit_portal.js'
	import {view_tree_edit_portal} from './view_tree_edit_portal.js'
	import {view_mosaic_edit_portal} from './view_mosaic_edit_portal.js'
	import {view_indexation_edit_portal} from './view_indexation_edit_portal.js'
	import {view_content_edit_portal} from './view_content_edit_portal.js'
	import {view_text_list_portal} from './view_text_list_portal.js'
	import {
		on_dragstart,
		on_dragstart_mosaic,
		on_dragover,
		on_dragleave,
		on_dragend,
		on_drop
	} from './drag_and_drop.js'
	import {buttons} from './buttons.js'



/**
* RENDER_EDIT_COMPONENT_PORTAL
* Constructor stub mixed into `component_portal` as the edit-mode render delegate.
*
* Its prototype methods are used directly by `component_portal` via prototype assignment
* (see component_portal.js: `component_portal.prototype.edit = render_edit_component_portal.prototype.edit`).
* The constructor itself is a no-op; instantiation never occurs — only the prototype is used.
*/
export const render_edit_component_portal = function() {

	return true
}//end render_edit_component_portal



/**
* EDIT
* Dispatch to the appropriate view render module based on the portal's configured view.
*
* The view is resolved from `self.view` (runtime override) or `self.context.view`
* (set from the ontology / request config at build time). Each case delegates entirely to
* the corresponding view module's static `render(self, options)` method and returns its result.
*
* Special cases:
* - `'print'` forces `self.permissions = 1` (read-only) before falling through to the
*   `'default'` branch, so inner components render without edit controls. The wrapper node
*   receives the CSS class `view_print` so print-specific CSS can target it.
* - `'default'` (and any unrecognised view) first checks `self.render_views` for a
*   dynamically registered view descriptor `{ view, mode, render, path? }`. If found, the
*   module is loaded via dynamic `import()` and its named export called. This lets integrators
*   register custom views without patching this switch.
*
* @param {Object} options - Render options forwarded verbatim to the view module.
* @param {string} [options.render_level='full'] - `'full'` rebuilds the entire wrapper;
*   `'content_data'` only refreshes the record list inside an existing wrapper.
* @returns {Promise<HTMLElement|null>} The rendered wrapper node, or null on failure.
*/
render_edit_component_portal.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.view || self.context?.view || null

	// wrapper
	switch(view) {

		case 'text':
			return view_text_list_portal.render(self, options)

		case 'line':
			return view_line_edit_portal.render(self, options)

		case 'tree':
			return view_tree_edit_portal.render(self, options)

		case 'mosaic':
			return view_mosaic_edit_portal.render(self, options)

		case 'indexation':
			return view_indexation_edit_portal.render(self, options)

		case 'content':
			return view_content_edit_portal.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_portal oh24 oh1_oh24 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1;

			// fallthrough

		case 'default':
		default: {
			// dynamic try
				const render_view = self.render_views.find(el => el.view===view && el.mode===self.mode)
				if (render_view) {
					const path			= render_view.path || ('./' + render_view.render +'.js')
					const render_method	= await import (path)
					return render_method[render_view.render].render(self, options)
				}

			return view_default_edit_portal.render(self, options)
		}
	}
}//end edit



/**
* RENDER_COLUMN_ID
* Build the ID-column cell for a single portal row: the "open record" button,
* the drag handle (edit-permission only), and the drag-drop target zone.
*
* The column serves three purposes:
* 1. **Navigation** — left-click calls `self.edit_record_handler()` to open the linked
*    record in the standard way (inline panel or separate page, depending on config).
* 2. **Context-menu navigation** — right-click opens the target record in a new window
*    (or a new browser tab when Alt is held). The window is given a stable name so
*    the browser reuses the same tab on repeated opens. An `on_blur` callback refreshes
*    the portal after the user returns from editing the target.
* 3. **Drag-to-reorder** — when permissions ≥ 2 the drag handle is added. The handle is
*    hidden by default (CSS class `hide`) and revealed on `mouseenter` of the button.
*    Double-clicking the handle opens a modal that lets the cataloguer type a target
*    position directly (useful for very long lists where dragging is impractical).
*
* The `drop_node` beneath the row is the drop target for reordering via drag-and-drop;
* it handles `dragover`, `dragleave`, and `drop` events using the shared handlers from
* `drag_and_drop.js`.
*
* @param {Object} options - Options bag passed from the view module.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {string} options.section_id - The section_id of the linked target record.
* @param {string} options.section_tipo - The section_tipo of the linked target record.
* @param {Object} options.locator - The full locator object for this row.
* @param {number} options.paginated_key - Zero-based position within the current page window.
* @returns {DocumentFragment} Fragment containing the button, (optional) drag handle, and drop zone.
*/
export const render_column_id = function(options) {

	// options
		const self			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	// short vars
		const show_interface = self.show_interface || {}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// button_edit. component portal caller (link)
		const button_edit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_edit button_view_' + self.context.view,
			parent			: fragment
		})
		button_edit.tabIndex = -1;

		// Prevent to show the context menu
		// open new window with the content
		// if user has alt pressed, open new tab
		button_edit.addEventListener('contextmenu', (e) => {
			e.preventDefault();

			// if alt is pressed, open new tab instead new window
			const features = e.altKey===true
				? 'new_tab'
				: null

			// open a new window
			const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
				tipo			: section_tipo,
				section_tipo	: section_tipo,
				id				: section_id,
				mode			: 'edit',
				session_save	: false, // prevent to overwrite current section session
				menu			: true
			})
			open_window({
				url			: url,
				name		: 'record_view_' + section_id,
				features	: features,
				on_blur : () => {
					// refresh current instance
					self.refresh({
						build_autoload : true
					})
				}
			})
		});
		button_edit.addEventListener('mousedown', function(e){
			e.stopPropagation()

			// if the user click with right mouse button stop
				if (e.which == 3 || e.altKey===true) {
					return
				}
			// handler
				self.edit_record_handler({
					section_tipo	: section_tipo,
					section_id		: section_id
				})
		})

	// drag and drop
	// permissions control
	// with read only permissions, stop
		if(self.permissions < 2){
			return fragment
		}

	// drag_node. Not for a model whose order is not a position in this list
	// (`reorderable===false`: component_relation_children — each child holds its
	// own order value, and the server refuses sort_data there).
		const drag_node = self.reorderable===false
			? null
			: render_drag_node(options)
		if (drag_node) {
			fragment.appendChild(drag_node)
		}

	// button_edit events
		button_edit.addEventListener('mouseenter', function(e) {
			e.stopPropagation()

			// permissions control
			// with read only permissions, stop
			if ( drag_node && self.permissions >= 2 && drag_node.classList.contains('hide') ) {
				drag_node.classList.remove('hide')
			}
		});
		button_edit.addEventListener('mouseleave', function(e) {
			e.stopPropagation()

			// permissions control
			// with read only permissions, stop
			if ( drag_node && self.permissions >= 2 && !drag_node.classList.contains('hide') ) {
				drag_node.classList.add('hide')
			}
		});

		// section_id node
			if(show_interface.show_section_id){
				// apply smaller font when the ID string is long (> 5 chars)
				const small_css = section_id.length>5 ? ' small' : ''
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'section_id' + small_css,
					text_content	: section_id,
					parent			: button_edit
				})
			}

		// edit icon
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button edit icon',
				parent			: button_edit
			})

	// drop_node: invisible drop target sitting below each row; reveals on dragover
		const drop_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'drop hide',
			parent			: fragment
		})
		drop_node.addEventListener('dragover', function(e) { return on_dragover(this, e, options)})
		drop_node.addEventListener('dragleave', function(e) { return on_dragleave(this, e)})
		drop_node.addEventListener('drop', function(e) { return on_drop(this, e, options)})


	return fragment
}//end render_column_id



/**
* RENDER_DRAG_NODE
* Build the drag handle icon element for a single portal row.
*
* The drag node is a small icon div that is hidden by default (`hide` class) and
* revealed when the user hovers over the parent `button_edit`. It supports:
*
* - **Standard drag-and-drop** — `dragstart` / `dragend` events communicate position
*   data to the drop zone via `DataTransfer` (and the `tmp` object in drag_and_drop.js,
*   since `dataTransfer` is unavailable in `dragover` for security reasons).
* - **Double-click to type a position** — Opens a small modal with a numeric input
*   pre-filled with the row's current 1-based position. The user can type any valid
*   position; the code clamps input to `[0, total_records - 1]` (0-based array indices)
*   and calls `self.sort_data()`. This is the primary ordering method for very long lists
*   where dragging across pages would be impractical.
*
* The node's own `mouseenter`/`mouseout` listeners keep it visible while the cursor is
* on the handle itself (complementing the parent button's enter/leave listeners).
*
* (!) The `change_order_modal` inner function relies on `modal` via closure — `modal`
* is declared after `button_ok` but the function is only called on click/keyup by which
* time the `modal` binding has been set. This temporal dependency is intentional.
*
* @param {Object} options - Options bag from the view module.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {string} options.section_id - The target record's section_id (used in modal title).
* @param {Object} options.locator - The full locator object for this row.
* @param {number} options.paginated_key - Zero-based position in the current page window;
*   used as `source_key` when sorting and as the default value in the position input.
* @returns {HTMLElement} The drag handle div node.
*/
const render_drag_node = function(options) {

	// options
		const paginated_key	= options.paginated_key
		const locator		= options.locator
		const self			= options.caller
		const section_id	= options.section_id
		const total_records	= self.total

	// drag_node
		const drag_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'drag icon hide'
		})
		// event mouseenter
		drag_node.addEventListener('mouseenter', function(e) {
			e.stopPropagation()

			if (drag_node.classList.contains('hide')) {
				drag_node.classList.remove('hide')
			}
		});
		// event mouseout
		drag_node.addEventListener('mouseout', function(e) {
			e.stopPropagation()

			// if (!drag_node.classList.contains('hide')) {
				drag_node.classList.add('hide')
			// }
		});
		// draggable options and events
		drag_node.draggable	= true
		drag_node.addEventListener('dragstart', function(e) { return on_dragstart(this, e, options)})
		drag_node.addEventListener('dragend', function(e) { return on_dragend(this, e, options)})
		// event dblclick
		drag_node.addEventListener('dblclick', function(e) {
			e.stopPropagation()

			// header
				const header = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'header'
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'label',
					text_node		: get_label.change_order_for || 'Change order for '+ section_id,
					parent			: header
				})

			// body
				const body = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'content body'
				})
				const target_key_input = ui.create_dom_element({
					element_type	: 'input',
					type			: 'number',
					value			: options.paginated_key + 1,
					class_name		: 'target_key',
					parent			: body
				})

			// footer
				const footer = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'footer content'
				})
				// button_ok
					const button_ok = ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'button_sort_order success',
						text_content	: 'OK',
						parent			: footer
					})
					// CHANGE_ORDER_MODAL
					// get the user data and check it to be correct before sort data
					// sort data if the new position is OK.
					const change_order_modal = function() {
						// user input data has not the array data order, the user will introduce the natural order 1,2,3,etc
						// it's necessary subtract one position to get the array position 0,1,2,etc
						const user_target_key = parseInt(target_key_input.value) -1
						// fix enter values with data boundaries,
						// the new position has to be between 0 (first array key of the data) and the last section_records (last key)
						const last_key = total_records - 1
						// check the position entered to be correct in boundaries
						const target_key = user_target_key < 0
							? 0
							: (user_target_key > last_key)
								? last_key
								: user_target_key
						// if the user enter the same position didn't nothing and close
						if(paginated_key===target_key){
							modal.close()
							return false
						}
						// change the order by the normal way
						const sort_data = {
							value		: locator,
							source_key	: paginated_key,
							target_key	: target_key
						}
						self.sort_data(sort_data)

						modal.close()
					}
					// click event
					button_ok.addEventListener('click', change_order_modal)

			// modal
				const modal = ui.attach_to_modal({
					header		: header,
					body		: body,
					footer		: footer,
					size		: 'small', // string size big|normal|small
					minimizable	: false,
					callback	: (el) => {
						// add events to modal options
						const keyup_handler = (evt) => {
							// Enter key
							if (evt.code==='Enter' || evt.code==='NumpadEnter') {
								change_order_modal()
							}
						}
						target_key_input.addEventListener('keyup', keyup_handler)
						// focus input
						dd_request_idle_callback(
							() => {
								// set the input field active
								target_key_input.focus()
								target_key_input.select()
							}
						)
					}
				})
		})//end drag_node.addEventListener('dblclick', function(e)


	return drag_node
}//end render_drag_node



/**
* RENDER_COLUMN_COMPONENT_INFO
* Build the component-info cell for a single portal row.
*
* `component_info` is the Dédalo `ddinfo` virtual component — a synthetic item injected
* into `self.datum.data` by the server when the target section contains a descriptor field
* (typically `ddinfo`, an auto-generated summary string).  Its `value` is an array of
* strings that is joined with `', '` for display.
*
* The column is only shown when `self.add_component_info === true` (set during init when
* the ontology or request config declares the column) and when a matching `ddinfo` entry
* is found for the current `section_id` / `section_tipo` pair.  If neither condition is met
* the returned fragment is an empty placeholder, keeping the column cell present in the DOM
* grid so column widths are not disturbed.
*
* @param {Object} options - Options bag from the view module.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {string} options.section_id - Target record's section_id.
* @param {string} options.section_tipo - Target record's section_tipo.
* @param {string[]|null} [options.from_ddo_tipos] - Optional. Tipos of the ddos
* (value_with_parents=true) anchored to the current ddinfo column. When the
* columns_map contains more than one ddinfo column, it allows to render only
* the info generated by the ddos of the current column.
* @see common.js get_columns_map and service_autocomplete.build
* @returns {DocumentFragment} Fragment with an optional `.ddinfo_value` span.
*/
export const render_column_component_info = function(options) {

	// options
		const self 				= options.caller
		const section_id		= options.section_id
		const section_tipo		= options.section_tipo
		const from_ddo_tipos	= options.from_ddo_tipos || null

	const fragment = new DocumentFragment()

	// component_info
		const component_info = self.datum.data.find(
			item => item.tipo==='ddinfo' &&
					same_section_id(item.section_id, section_id) &&
					item.section_tipo===section_tipo &&
					(!from_ddo_tipos || !item.from_ddo_tipo || from_ddo_tipos.includes(item.from_ddo_tipo))
		)
		if (component_info) {

			const info_value = component_info.value && component_info.value.length
				? component_info.value.join(', ')
				: null

			if (info_value) {
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'ddinfo_value',
					inner_html		: render_value(info_value, 'text'),
					parent			: fragment
				})
			}
		}

	return fragment
}//end render_column_component_info()



/**
* RENDER_COLUMN_REMOVE
* Build the remove-column cell for a single portal row: an icon button that opens a
* confirmation modal with two deletion strategies.
*
* The button is only rendered when the target section's ontology-declared `button_delete`
* descriptor is present in `self.target_section[tipo].buttons`. This means the button
* visibility is server-authoritative — the ontology controls it, not client-side logic.
*
* The confirmation modal offers two actions, each behind a separate user confirmation:
*
* 1. **Unlink only** (`button_unlink_record`) — removes the locator from the portal's
*    data array via `self.unlink_record(locator)`.  The server cascades the paired
*    dataframe rows automatically (single-writer rule), so no `delete_dataframe` call is
*    needed here.  This is the default and receives keyboard focus so Enter triggers it.
*
* 2. **Delete resource and all links** (`button_unlink_and_delete`) — only shown when
*    `show_interface.button_delete_link_and_record === true` AND the target section's
*    `button_delete.permissions > 1`.  Calls `self.delete_linked_record()` to remove
*    the target record itself; the server's record delete strips this host's locator
*    through the inverse-reference cleanup and cascades the paired dataframe rows with
*    it (single-writer rule — no client `delete_dataframe()` call, since 2026-09-21).
*    Requires two consecutive `confirm()` dialogs to prevent accidental
*    deletion of shared authority records.  Optionally also deletes diffusion records when
*    the `delete_diffusion_records` checkbox is checked (default: true).
*
* Pagination guard: when the deleted row is the first item on a non-first page (`key===0`
* and `offset>0`), the offset is decremented by one `limit` so the API returns the
* correct page after the refresh.
*
* @param {Object} options - Options bag from the view module.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {number} options.row_key - Zero-based position in the full data array (string|number).
* @param {number} options.paginated_key - Zero-based position within the current page window.
* @param {string} options.section_id - Target record's section_id.
* @param {string} options.section_tipo - Target record's section_tipo.
* @param {Object} options.locator - The full locator object (must include `.id` for dataframe pairing).
* @returns {DocumentFragment} Fragment containing an optional `.button_remove` button.
*/
export const render_column_remove = function(options) {

	// options
		const self			= options.caller
		const row_key		= options.row_key
		const paginated_key	= options.paginated_key
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	// short vars
		const show_interface = self.show_interface || {}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// button_remove
		// Resolve the target section DDO for this row's section_tipo to read its
		// ontology-declared buttons; defaults to empty object if no match found.
		const target_section_ddo	= self.target_section.find(el => el.tipo===section_tipo) || {}
		const section_buttons		= target_section_ddo.buttons || []
		const button_delete			= section_buttons.find(el => el.model==='button_delete')

		if(button_delete) {

			const button_remove = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_remove',
				title			: (get_label.delete || 'Delete'),
				parent			: fragment
			})
			button_remove.tabIndex = -1;
			// event click
			button_remove.addEventListener('click', function(e){
				e.stopPropagation()

				// invalid permissions
					if (self.permissions<2) {
						return
					}

				// header
					const header = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'header'
					})
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'label',
						inner_html		: (get_label.delete || 'Delete') + ` ID: ${render_value(section_id, 'text')} <span class="note">[${render_value(section_tipo, 'text')}]</span>`,
						parent			: header
					})

				// body
					const body = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'body content',
						inner_html		: ' '
					})

				// relation_list
					const relation_list_placeholder = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'relation_list_placeholder',
						parent			: body
					})
					const relation_list = render_relation_list({
						self			: self,
						section_id		: section_id,
						section_tipo	: section_tipo
					})
					relation_list_placeholder.replaceWith(relation_list);

				// footer
					const footer = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'footer content'
					})

				// button_unlink_and_delete (Deletes real target record)
					// interface control defined in Ontology properties. Default is true set in common init
					const button_delete_link_and_record	= show_interface.button_delete_link_and_record
					if (button_delete_link_and_record && button_delete.permissions>1) {
						// button_unlink_and_delete
							const button_unlink_and_delete = ui.create_dom_element({
								element_type	: 'button',
								class_name		: 'danger remove',
								text_content	: get_label.delete_resource_and_links || 'Delete resource and all links',
								parent			: footer
							})
							const unlink_and_delete_handler = async function(e) {
								e.stopPropagation()

								// stop if the user don't confirm 1
								if (!confirm(get_label.sure)) {
									return
								}

								// stop if the user don't confirm 2
								if (!confirm(get_label.sure)) {
									return
								}

								footer.classList.add('loading')

								// delete the record and pointers to it
								await self.delete_linked_record({
									section_tipo	: section_tipo,
									section_id		: section_id
								})

								// The row's paired dataframe frames need NO client call: the
								// server's record delete strips this host's locator through
								// the inverse-reference cleanup and cascades the frames with
								// it (removeDataframeDataById, each slot applying its own
								// delete policy). Until 2026-09-21 delete_dataframe was called
								// here on the STALE frame instance and sent a slot `remove`
								// for an entry the server had already dropped — a refused
								// save surfaced for a deletion that had fully succeeded. The
								// refresh below re-reads the record.

								// refresh the component. Don't wait here
								self.refresh({
									build_autoload : true
								})

								// close modal
								modal.close()

								footer.classList.remove('loading')
							}
							button_unlink_and_delete.addEventListener('click', unlink_and_delete_handler)
							button_unlink_and_delete.style = 'float:left'

						// delete diffusion records checkbox
							const delete_diffusion_records_label = ui.create_dom_element({
								element_type	: 'label',
								class_name		: 'block_label unselectable',
								inner_html		: get_label.delete_diffusion_records || 'Delete diffusion records',
								parent			: footer
							})
							const delete_diffusion_records_checkbox = ui.create_dom_element({
								element_type	: 'input',
								type			: 'checkbox'
							})
							// default value is true
							delete_diffusion_records_checkbox.checked	= true
							self.delete_diffusion_records				= true
							// change event
							delete_diffusion_records_checkbox.addEventListener('change', (e) => {
								self.delete_diffusion_records = delete_diffusion_records_checkbox.checked
							})
							// append node
							delete_diffusion_records_label.prepend(delete_diffusion_records_checkbox)
							delete_diffusion_records_label.style = 'float:left'
					}

				// button_unlink_record (Only delete the locator)
					const button_unlink_record = ui.create_dom_element({
						element_type	: 'button',
						class_name 		: 'warning remove',
						text_content 	: get_label.delete_only_the_link || 'Delete only the link',
						parent			: footer
					})
					const fn_click_unlink_record = async function(e){
						e.stopPropagation()

						// stop if the user don't confirm
						if (!confirm(get_label.sure)) {
							return
						}

						footer.classList.add('loading')

						// deletes the locator from component data and refresh the component
						// (!) Note that this function refresh the component and wait for it
						// dataframe cleanup is server-authoritative: unlink_record sends
						// update_data_value 'remove' and the server cascades the paired
						// dataframe rows (single-writer rule). No client delete_dataframe.
						const removed = await self.unlink_record(options.locator)

						footer.classList.remove('loading')

						// close modal ONLY after the unlink landed. A closing modal is the
						// grammar of "the link is gone": closing over a refusal tells the
						// curator the locator was removed while it is still stored.
						// (!) No toast here. The refusal travelled through change_value ->
						// data_manager.request, which already published its ApiError, and
						// error_dispatch's deduped_toast rendered it ONCE. A direct
						// render_error_toast would double-notice the same failure.
						if (removed!==true) {
							return
						}
						modal.close()
					}
					button_unlink_record.addEventListener('click', fn_click_unlink_record)

				// modal
					const modal = ui.attach_to_modal({
						header		: header,
						body		: body,
						footer		: footer,
						size		: 'normal', // string size small|big|normal
						callback	: (dd_modal) => {
							dd_modal.modal_content.style.width = '54rem'
							dd_modal.modal_content.style.maxWidth = '100%'
						}
					})
					// set the default button to be fired when the modal is active
					// when the user press the Enter key in the keyboard
					// the unlink option will be fired
					const focus_the_button = function() {
						// set the focus to the button_unlink
						dd_request_idle_callback(
							() => {
								button_unlink_record.focus()
								button_unlink_record.classList.add('focus')
							}
						)
						button_unlink_record.addEventListener('keyup', (e)=>{
							e.preventDefault()
							if(e.key==='Enter'){
								button_unlink_record.click()
							}
						})
					}
					// when the modal will be ready in DOM fire the function to attach the event
					when_in_dom(button_unlink_record, focus_the_button)

				// data pagination offset. Check and update self data to allow save API request return the proper paginated data
					const key = parseInt(row_key)
					if (key===0 && self.data.pagination?.offset>0) {
						const next_offset = (self.data.pagination.offset - self.data.pagination.limit)
						// set before exec API request on Save
						self.data.pagination.offset = next_offset>0
							? next_offset
							: 0
					}
			})
			// icon delete
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button delete_light icon',
				parent			: button_remove
			})

			// activate_tooltips
			ui.activate_tooltips(button_remove.parentNode, '.button_remove')
		}


	return fragment
}//end render_column_remove()



/**
* GET_BUTTONS
* Build the full portal toolbar (buttons_container + buttons_fold) for edit mode.
*
* Each button is guarded by its corresponding `show_interface` flag.  All flags default
* to `false`; they are set during `component_portal.prototype.init` from the ontology /
* request config `show.interface` property.
*
* Buttons rendered (in order, when enabled):
* - `button_external`  — syncs data from an external source (`source.mode: 'external'`).
* - `button_add`       — creates a new linked record in the target section. Requires the
*                        target section's `button_new.permissions > 1`. Only the first
*                        `target_section` entry is consulted; mixed-tipo portals that need
*                        per-tipo add buttons must use a custom view.
* - `button_link`      — opens the link picker to search and attach existing records.
* - `button_list`      — navigates to the target section in list mode. Skipped when
*                        `target_section` is empty (e.g. autocomplete-hi with unresolved tipo).
* - `list_from_component_data` — shows a filtered list derived from the portal's current data.
*                        Only rendered when a parent `section` caller can be resolved.
* - `button_tree`      — opens a thesaurus tree selector.
* - `tools`            — injects tool buttons (time-machine, propagate, etc.) via `ui.add_tools`.
* - `button_fullscreen` — toggles the component node into fullscreen; publishes
*                        `full_screen_<id>` on the event bus before and after.
*
* @param {Object} self - The `component_portal` instance.
* @returns {HTMLElement} The fully populated buttons_container node.
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface	= self.show_interface
		const target_section	= self.target_section || []

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})

	// button_external: button_update_data_external
		if(show_interface.button_external === true){
			const button_update_data_external = buttons.render_button_update_data_external(self)
			buttons_fold.appendChild(button_update_data_external)
		}

	// button_add
		if(show_interface.button_add === true){
			// section_buttons. Get target section_buttons (defined in request config -> sqo -> section). Sample:
				// {
				//     "typo": "ddo",
				//     "tipo": "rsc170",
				//     "model": "section",
				//     "label": "Image",
				//     "color": "#b9b9b9",
				//     "permissions": 2,
				//     "buttons": [
				//         {
				//             "model": "button_new",
				//             "permissions": 1
				//         },
				//         {
				//             "model": "button_delete",
				//             "permissions": 1
				//         }
				//     ]
				// }
			const first_target			= target_section[0]
			const target_section_ddo	= first_target ? target_section.find(el => el.tipo===first_target.tipo) : {}
			const section_buttons		= target_section_ddo.buttons || []
			const button_new			= section_buttons.find(el => el.model==='button_new')

			if (button_new && button_new.permissions > 1) {
				const button_add = buttons.render_button_add(self)
				buttons_fold.appendChild(button_add)
			}
		}//end button_add

	// button_link
		if(show_interface.button_link === true){
			const button_link = buttons.render_button_link(self)
			if(button_link) {
				buttons_fold.appendChild(button_link)
			}
		}//end button_link

	// button_list (go to target section in list mode)
		if(show_interface.button_list === true){

			// Note that in some component_autocomplete_hi items, target_section_tipo
			// resolution could result in zero sections. Check this value to prevent
			// errors in this cases (example: oh126 in section oh1)

			if (target_section[0]) {
				const button_list = buttons.render_button_list(self)
				buttons_fold.appendChild(button_list)
			}
		}

	// button list_from_component_data
		if(show_interface.list_from_component_data === true){
			// Check for caller section before render button
			const caller_section = get_caller_by_model(self, 'section')
			if(caller_section) {
				const list_from_component_data_button = buttons.render_list_from_component_data_button(self)
				buttons_fold.appendChild(list_from_component_data_button)
			}
		}

	// button_tree terms selector
		if(show_interface.button_tree === true){
			const button_tree_selector = buttons.render_button_tree_selector(self)
			buttons_fold.appendChild(button_tree_selector)
		}

	// buttons tools
		if(show_interface.tools===true) {
			ui.add_tools(self, buttons_fold)
		}//end add tools

	// button_fullscreen
		if(show_interface.button_fullscreen === true){

			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: buttons_fold
			})
			// event click
			const click_handler_fullscreen = (e) => {
				e.stopPropagation()

				ui.enter_fullscreen(self.node, ()=>{
					event_manager.publish('full_screen_'+self.id, false)
				})
				event_manager.publish('full_screen_'+self.id, true)
			}
			button_fullscreen.addEventListener('click', click_handler_fullscreen)
		}


	return buttons_container
}//end get_buttons



/**
* GET_BUTTONS_BY_PERMISSIONS
* Permission-aware toolbar entry point for the edit views: the ONE place that
* decides which toolbar a given permission level gets.
*
* - `permissions > 1`  — the full toolbar (`get_buttons`).
* - `permissions === 1` (read-only) — only the update-external button, and only
*   when the portal is external (`show_interface.button_external`): refreshing an
*   external mirror is a READ-level action (the mirror is a pure function of
*   committed data and the server gates it at record read access), so a reader
*   may ask for it. Every edit/link/add/tree/tools control stays hidden.
* - The `print` view (which forces `permissions = 1`) and `permissions < 1`
*   get no toolbar.
*
* @param {Object} self - The `component_portal` instance.
* @returns {HTMLElement|null} The buttons_container node, or null when no toolbar applies.
*/
export const get_buttons_by_permissions = (self) => {

	// full edit toolbar
		if (self.permissions > 1) {
			return get_buttons(self)
		}

	// read-only: external refresh only (never in print context)
		const view = self.view || self.context?.view || null
		if (self.permissions===1 && view!=='print' && self.show_interface?.button_external===true) {

			const buttons_container = ui.component.build_buttons_container(self)
			const buttons_fold = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'buttons_fold',
				parent			: buttons_container
			})
			buttons_fold.appendChild(
				buttons.render_button_update_data_external(self)
			)

			return buttons_container
		}


	return null
}//end get_buttons_by_permissions



/**
* ACTIVATE_AUTOCOMPLETE
* Lazily instantiate and show the `service_autocomplete` overlay when the user clicks
* inside the portal wrapper.
*
* This function is called from the wrapper's `click` handler (via `add_wrapper_events`)
* every time the portal receives a click while active.  It is idempotent:
* - If the autocomplete is already open (`self.autocomplete_active === true`), it simply
*   calls `.show()` and re-focuses the search input without rebuilding.
* - If `self.autocomplete_active === false` (initial state set by `component_portal.prototype.init`)
*   and all guards pass, it builds and appends the service node on demand.
* - If `self.autocomplete` is explicitly `false`, autocomplete is disabled for this
*   instance and the function exits early via the guard condition.
*
* Guards that suppress the autocomplete:
* - `self.permissions < 2` — read-only; editing is not allowed.
* - `self.show_interface.show_autocomplete !== true` — feature flag is off.
* - External source mode without an explicit show-interface override — in this case the
*   portal's data is computed server-side and the autocomplete picker would be meaningless.
*
* After first build the service node is appended directly to `self.node` (not the wrapper)
* and animated in with an `opacity` fade via the `active` CSS class.  In `search` mode
* the fade is skipped (`transition:none`) so the input appears instantly.
*
* The `id_variant` is randomised with a timestamp to prevent the instance cache from
* returning a stale autocomplete that belongs to another page component.
*
* Side effects:
* - Sets `self.autocomplete_active = true`.
* - Pushes the service instance onto `self.services` (for lifecycle cleanup on destroy).
*
* @param {Object} self - The `component_portal` instance.
* @param {HTMLElement} wrapper - The portal's wrapper node (not used directly, passed for
*   context; the service node is appended to `self.node`).
* @returns {Promise<boolean|undefined>} `true` when the autocomplete is shown or built;
*   `undefined` (implicit) when the function exits early due to a guard condition.
*/
export const activate_autocomplete = async function(self, wrapper) {

	// permissions check
		if (self.permissions<2) {
			return
		}

	// already active
		if (self.autocomplete_active===true) {
			self.autocomplete.show()
			// focus
			self.autocomplete.search_input.focus({preventScroll:true});
			return true
		}

	// Default source external buttons configuration,
	// if show.interface is defined in properties used the definition, else use this default
		if(self.context.properties?.source?.mode==='external' && !self.request_config_object?.show?.interface) {
			self.show_interface.show_autocomplete = false
		}//end if external

	// service_autocomplete instance
		if( self.show_interface.show_autocomplete===true
			&& self.autocomplete!==false
			&& self.autocomplete_active!==undefined
			&& self.autocomplete_active===false ){

			// id_variant. Don't allow cache instances here because interact with page instances.
			// Use always a custom id_variant to prevent it
			const id_variant = (self.id_variant || '') + '_' + new Date().getTime()

			// get instance and init for service_autocomplete
			self.autocomplete = await get_instance({
				model			: 'service_autocomplete',
				caller			: self,
				tipo			: self.tipo,
				section_tipo	: self.section_tipo,
				request_config	: self.context.request_config,
				properties		: self.context.properties.service_autocomplete || null,
				id_variant		: id_variant //self.id_variant
			})
			await self.autocomplete.build()
			// render. Build_autocomplete_input nodes
			const service_node = await self.autocomplete.render()

			// when service wrapper is rendered, move inside the wrapper
			// and activate it by style with opacity fade
			// in search mode skip rAF+setTimeout (no fade needed, transition:none)
			if (self.mode === 'search') {
				self.node.appendChild(service_node)
				service_node.classList.add('active')
				if (self.autocomplete.search_input) {
					self.autocomplete.search_input.focus({preventScroll:true});
				}
			} else {
				requestAnimationFrame(()=>{
					self.node.appendChild(service_node)
					setTimeout(function(){
						service_node.classList.add('active')
						// focus
						if (self.autocomplete.search_input) {
							self.autocomplete.search_input.focus({preventScroll:true});
						}
					}, 1)
				})
			}

			self.autocomplete_active = true

			// set the instance as component service
			self.services.push( self.autocomplete )
		}//end if(self.autocomplete_active!==undefined && self.autocomplete_active===false)


	return true
}//end activate_autocomplete



/**
* BUILD_HEADER
* Build the column-header row for a portal list and hide it when the list is empty.
*
* Delegates to `ui.render_list_header(columns_map, self)` which builds a row of header
* cells based on the ordered `columns_map` array.  The `component_info` column is
* included in `columns_map` only when `self.add_component_info === true` (set during
* `component_portal.prototype.init`); this function does not control that — it simply
* passes the map through.
*
* When `ar_section_record` is empty (no linked records on the current page) the header is
* hidden with the `hide` CSS class.  This avoids an orphaned header row floating above an
* empty list.  The header is re-shown on next render when records are present.
*
* @param {Array} columns_map - Ordered array of column descriptor objects, each with at
*   minimum `{ id, label, width }`.  Built by the view module before calling this helper.
* @param {Array} ar_section_record - Array of resolved section-record instances for the
*   current page (may be empty).
* @param {Object} self - The `component_portal` instance (forwarded to `ui.render_list_header`
*   for column width / sort-state context).
* @returns {HTMLElement} The list_header_node element, ready to prepend to the list body.
*/
export const build_header = function(columns_map, ar_section_record, self) {

	// build using common ui builder
		const list_header_node = ui.render_list_header(columns_map, self)

	// hide list_header_node if no records found
		if (ar_section_record.length<1) {
			list_header_node.classList.add('hide')
		}

	return list_header_node;
}//end build_header



/**
* RENDER_REFERENCES
* Build the back-reference list used by `component_relation_related` views to show
* records that point *at* the current component from the inverse side.
*
* Each entry in `ar_references` is an object of the shape:
*   `{ label: string, value: { section_tipo: string, section_id: string } }`
* where `label` is the display string for the referring record and `value` holds its
* locator coordinates.  Clicking the link icon opens the referring record in a new window.
*
* The `menu: false` flag hides the global navigation chrome in the popup window so the
* user gets a focused record view without the full page header.
*
* @see numisdata3 > numisdata36  (canonical example in the ontology)
*
* @param {Array} ar_references - Array of reference descriptors; each must have
*   `{ label: string, value: { section_tipo: string, section_id: string } }`.
* @returns {DocumentFragment} Fragment containing a `.references` `<ul>` list, or an
*   empty fragment when `ar_references` is empty.
*/
export const render_references = function(ar_references) {

	const fragment = new DocumentFragment()

	// ul
		const ul = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'references',
			parent			: fragment
		})

	// references label
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: get_label.references,
			parent			: ul
		})

	const ref_length = ar_references.length
	for (let i = 0; i < ref_length; i++) {

		const reference = ar_references[i]

		// li
			const li = ui.create_dom_element({
				element_type	: 'li',
				parent			: ul
			})

		// button_link
			const button_link = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button link grey',
				parent			: li
			})
			const click_handler = (e) => {
				e.stopPropagation()

				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo			: reference.value.section_tipo,
					id				: reference.value.section_id,
					mode			: 'edit',
					session_save	: false, // prevent to overwrite current section session
					menu			: false
				})
				open_window({
					url		: url,
					name	: 'record_view_' + reference.value.section_tipo +'_'+ reference.value.section_id
				})
			}
			button_link.addEventListener('mousedown', click_handler)

		// button_edit label
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label',
				inner_html		: render_value(reference.label, 'text'),
				parent			: li
			})
	}//end for (let i = 0; i < ref_length; i++)


	return fragment
}//end render_references



/**
* ADD_WRAPPER_EVENTS
* Attach the common set of event listeners to the portal's top-level wrapper node.
*
* Two categories of events are managed:
*
* 1. **Click → autocomplete** (always attached)
*    A `click` listener deferred via `dd_request_idle_callback` calls
*    `activate_autocomplete` when the portal is active (`self.active === true`).
*    The idle-callback deferral ensures the click has fully propagated and any
*    preceding focus changes have settled before the autocomplete is shown.
*
* 2. **Drag-and-drop on the wrapper** (only when `options.drag_drop === true`)
*    The default and mosaic views set this flag because they render records as a
*    flat list where the wrapper itself is a valid drop zone (e.g. for dropping a
*    drag that started from a different portal or from a tree view).  The handler
*    passes `{ caller: self }` as the minimal options bag required by the shared
*    drag-and-drop handlers in `drag_and_drop.js`.
*
* @param {Object} self - The `component_portal` instance.
* @param {HTMLElement} wrapper - The portal's main wrapper node.
* @param {Object} [options={}] - Optional configuration.
* @param {boolean} [options.drag_drop=false] - When `true`, also attaches
*   `dragover`, `dragleave`, and `drop` listeners to the wrapper.
* @returns {boolean} Always returns `true`.
*/
export const add_wrapper_events = function(self, wrapper, options={}) {

	// pre-warm the service_autocomplete module during idle time (once per page) so
	// the first activation click does not pay the dynamic-import cost. This is the
	// correct use of requestIdleCallback: genuine low-priority background work.
		if (!add_wrapper_events._prewarmed) {
			add_wrapper_events._prewarmed = true
			dd_request_idle_callback(() => {
				import('../../services/service_autocomplete/js/service_autocomplete.js').catch(() => {})
			})
		}

	// click handler (autocomplete activation)
	// Activation is a direct response to user intent, so it must NOT be deferred to
	// browser idle time (requestIdleCallback could delay it up to its 1000 ms timeout
	// on a busy main thread — the click moment is the least idle point). self.active
	// is already set synchronously on the preceding 'mousedown' (ui.component.activate),
	// so a microtask is enough to let the click finish propagating before we show the
	// autocomplete, without the idle penalty.
		const click_handler = (e) => {
			e.stopPropagation()
			queueMicrotask(() => {
				if (self.active) {
					activate_autocomplete(self, wrapper)
				}
			})
		}
		wrapper.addEventListener('click', click_handler)

	// drag and drop events on wrapper (optional, used by default and mosaic views)
		if (options.drag_drop === true) {
			wrapper.addEventListener('dragover', function(e) {
				on_dragover(this, e, {
					caller : self
				})
			})
			wrapper.addEventListener('dragleave', function(e) {
				on_dragleave(this, e)
			})
			wrapper.addEventListener('drop', function(e) {
				on_drop(this, e, {
					caller : self
				})
			})
		}

	return true
}//end add_wrapper_events



/**
* ADD_SECTION_RECORD_DRAG_AND_DROP
* Make an individual row node draggable and set up the full drag-and-drop event suite.
*
* Used by the `line` and `mosaic` views where entire row/card nodes are the draggable
* units (as opposed to the small drag-icon handle used in the `default` table view).
* The `dragstart` handler used here is `on_dragstart_mosaic` — a variant that encodes
* the full row node reference in the transfer data rather than just a locator/key pair.
*
* After this call the node:
* - Has `draggable="true"` set as an attribute.
* - Has the CSS class `draggable` added (for cursor and visual styling).
* - Listens for `dragstart`, `dragover`, `dragleave`, and `drop` events using the shared
*   handlers from `drag_and_drop.js`.
*
* @param {Object} options - Options bag from the view module. Must include at minimum:
* @param {HTMLElement} options.section_record_node - The row/card node to make draggable.
* @param {Object} options.caller - The `component_portal` instance.
* @param {Object} options.locator - The locator for this row (forwarded to drag handlers).
* @param {number} options.paginated_key - The row's position in the current page.
* @returns {boolean} `true` on success; `false` if `section_record_node` is missing.
*/
export const add_section_record_drag_and_drop = function(options) {

	// options
		const node = options.section_record_node
		if(!node){
			console.error('No node is given')
			return false
		}

	// not reorderable (component_relation_children): no drag source at all
		if (options.caller?.reorderable===false) {
			return false
		}

	// set properties/events
		node.draggable = true
		node.classList.add('draggable')
		node.addEventListener('dragstart', function(e) { on_dragstart_mosaic(this, e, options) })
		node.addEventListener('dragover', function(e) { on_dragover(this, e, options) })
		node.addEventListener('dragleave', function(e) { on_dragleave(this, e) })
		node.addEventListener('drop', function(e) { on_drop(this, e, options) })

	return true
}//end add_section_record_drag_and_drop



// @license-end
