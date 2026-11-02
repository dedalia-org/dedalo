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
*    - `render_column_id`           — "open record" button + drag handle per row.
*    - `open_move_to_position`      — the move-to-position modal (dblclick / Enter on the handle).
*    - `render_column_component_info` — optional `ddinfo` overlay for a row.
*    - `render_column_remove`       — unlink / delete button with confirmation modal.
*    - `get_buttons`                — toolbar above the list (add, link, tree, fullscreen…).
*    - `get_buttons_by_permissions` — permission-aware toolbar: full at >1, external refresh only at 1.
*    - `activate_autocomplete`      — lazily instantiates `service_autocomplete` on demand.
*    - `build_header`               — column-header row (hidden when list is empty).
*    - `render_references`          — read-only back-reference list for relation-related views.
*    - `render_list_after`          — the `.list_after` slot (order indicator, references, footer, error…).
*    - `render_order_indicator`     — the portal order indicator (temporary view order / declared order).
*    - `add_wrapper_events`         — click-to-activate-autocomplete + the wrapper MOVE zone.
*
* Rows are placed by the row door (section.js window_section_rows → record_window)
* and their drag/drop is DELEGATED (drag_and_drop.js bind_row_drag / bind_portal_drop):
* no listener sits on a row node (WC-2026-10-30-section-record-row-box).
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
	import {render_relation_list, render_print_notice} from '../../section/js/render_common_section.js'
	import {view_default_edit_portal} from './view_default_edit_portal.js'
	import {view_line_edit_portal} from './view_line_edit_portal.js'
	import {view_tree_edit_portal} from './view_tree_edit_portal.js'
	import {view_mosaic_edit_portal} from './view_mosaic_edit_portal.js'
	import {view_indexation_edit_portal} from './view_indexation_edit_portal.js'
	import {view_content_edit_portal} from './view_content_edit_portal.js'
	import {view_text_list_portal} from './view_text_list_portal.js'
	import {a11y} from '../../common/js/a11y.js'
	import {
		can_reorder,
		can_drag_out,
		can_save_view_order,
		declared_order_of,
		bind_portal_drop,
		move_to_position_decision
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

	// node. The view's wrapper (full) or content_data (content)
		const node = await render_edit_view(self, options)

	// header sort arrows. Every edit render (full or content) re-syncs them with
	// the order the rows were read in (self.view_order): a header click, a clear or
	// a save from the order indicator alike (portal order model, stage O2)
		const wrapper = (options?.render_level || 'full')==='content'
			? self.node
			: node
		const header_wrapper = wrapper?.list_body?.querySelector?.(':scope > .header_wrapper_list') || null
		ui.set_column_order_state(header_wrapper, self.view_order || null)


	return node
}//end edit



/**
* RENDER_EDIT_VIEW
* The view dispatch of `edit`: reads `self.view` / `self.context.view` and delegates
* to the matching view module.
* @param {Object} self - The `component_portal` instance
* @param {Object} options - The render options (render_level…)
* @returns {Promise<HTMLElement>} wrapper (full) or content_data (content)
*/
const render_edit_view = async function(self, options) {

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
					const path			= render_view.path || (`./${render_view.render}.js`)
					const render_method	= await import (path)
					return render_method[render_view.render].render(self, options)
				}

			return view_default_edit_portal.render(self, options)
		}
	}
}//end render_edit_view



/**
* RENDER_COLUMN_ID
* Build the ID-column cell for a single portal row: the "open record" button and,
* when the row may be dragged, the drag handle.
*
* The column serves three purposes:
* 1. **Navigation** — left-click calls `self.edit_record_handler()` to open the linked
*    record in the standard way (inline panel or separate page, depending on config).
* 2. **Context-menu navigation** — right-click opens the target record in a new window
*    (or a new browser tab when Alt is held). The window is given a stable name so
*    the browser reuses the same tab on repeated opens. An `on_blur` callback refreshes
*    the portal after the user returns from editing the target.
* 3. **Drag-to-reorder** — the drag handle (render_drag_node) is rendered only when the
*    portal source rule holds (`can_reorder || can_drag_out`, drag_and_drop.js): never
*    under a declared (ontology) order, never while a temporary `view_order` is active,
*    never for `reorderable===false`, never read-only. The handle carries NO listener:
*    dragstart, dblclick and Enter (move-to-position) are delegated on the rows'
*    content_data (drag_and_drop.js bind_row_drag), and its visibility is CSS-only
*    (component_portal.less). There is no per-row drop zone: every row is a target of
*    the delegated listener set (WC-2026-10-30-section-record-row-box).
*
* @param {Object} options - Options bag passed from the view module.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {string} options.section_id - The section_id of the linked target record.
* @param {string} options.section_tipo - The section_tipo of the linked target record.
* @param {boolean} [options.drag] - `false` never renders the handle (the mosaic hover
*   overlay and alt table: no drag source there).
* @returns {DocumentFragment} Fragment containing the button and the (optional) drag handle.
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
			class_name		: `button_edit button_view_${self.context.view}`,
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
			const url = `${DEDALO_CORE_URL}/page/?${object_to_url_vars({
				tipo			: section_tipo,
				section_tipo	: section_tipo,
				id				: section_id,
				mode			: 'edit',
				session_save	: false, // prevent to overwrite current section session
				menu			: true
			})}`
			open_window({
				url			: url,
				name		: `record_view_${section_id}`,
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
				if (e.which === 3 || e.altKey===true) {
					return
				}
			// handler
				self.edit_record_handler({
					section_tipo	: section_tipo,
					section_id		: section_id
				})
		})

	// drag_node. The portal source rule (never for a read-only, declared-order,
	// view-ordered or non-reorderable portal). Rendered only when it holds, so the
	// CSS opacity:0 base state never hides a disallowed control.
		if (options.drag!==false && (can_reorder(self) || can_drag_out(self))) {
			fragment.appendChild( render_drag_node(options) )
		}

	// section_id node
		if(show_interface.show_section_id){
			// apply smaller font when the ID string is long (> 5 chars)
			const small_css = section_id.length>5 ? ' small' : ''
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: `section_id${small_css}`,
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


	return fragment
}//end render_column_id



/**
* RENDER_DRAG_NODE
* Build the drag handle of a single portal row: a draggable element with NO
* listener (WC-2026-10-30-section-record-row-box).
*
* - Its gestures are delegated on the rows' content_data (drag_and_drop.js
*   bind_row_drag, `source:'handle'`): dragstart (the payload is read from the row
*   window at the event), dblclick (move-to-position, primary) and Enter when the
*   handle is reached by Tab (secondary) — both open `open_move_to_position`.
* - It is created WITHOUT the `hide` class (`display:none !important`, which no CSS
*   reveal can beat and which would take it out of the Tab order): its visibility
*   is CSS-only, `opacity:0` revealed on row hover / focus (component_portal.less).
* - `a11y.make_activable` gives it the button role, the tab stop and its accessible
*   name (`change_order_for`); no activation callback is wired here.
*
* @param {Object} options - Options bag from the view module.
* @param {string} options.section_id - The target record's section_id (accessible name).
* @returns {HTMLElement} The drag handle node.
*/
const render_drag_node = function(options) {

	// drag_node
		const drag_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'drag icon'
		})
		drag_node.draggable = true

	// a11y. Tab stop + name (Enter is handled by the delegated keydown)
		a11y.make_activable(drag_node, {
			label : (get_label.change_order_for || 'Change order for ') + options.section_id
		})


	return drag_node
}//end render_drag_node



/**
* OPEN_MOVE_TO_POSITION
* The move-to-position modal of a portal row: a numeric input pre-filled with the
* row's current 1-based ABSOLUTE position; OK / Enter sends `sort_data` with the
* keys of `move_to_position_decision` (both absolute, clamped to
* `[0, total - 1]`, the paginator offset never added).
*
* Opened by the delegated dblclick / Enter on the row's own `.drag` handle
* (drag_and_drop.js bind_row_drag `open_position`), which resolves the row, holds it
* while the modal is open, and reads `entry` and `total` WHEN THE EVENT FIRES. The
* hold is released when the modal closes.
*
* @param {Object} self - The `component_portal` instance.
* @param {number} index - The row's page position (hold anchor).
* @param {Object} options
* @param {Object} options.entry - The row's entry (`record_window.entry_of(index)`).
* @param {number} options.total - The portal's total at the event.
* @param {Function} options.release - Unholds the row (idempotent).
* @returns {Object|null} The modal, or null when the entry carries no key.
*/
export const open_move_to_position = function(self, _index, options) {

	// options
		const entry		= options.entry
		const release	= typeof options.release==='function' ? options.release : () => {}

	if (!entry || !Number.isInteger(entry.paginated_key)) {
		release()
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
			text_node		: (get_label.change_order_for || 'Change order for ') + entry.section_id,
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
			value			: entry.paginated_key + 1,
			class_name		: 'target_key',
			parent			: body
		})

	// footer
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'footer content'
		})
		const button_ok = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_sort_order success',
			text_content	: 'OK',
			parent			: footer
		})

	// modal (declared before the handlers that close it)
		let modal = null

	// change_order. The typed 1-based position → absolute keys (clamped).
	// `total` is read now, when the user confirms.
		const change_order = function() {
			const decision = move_to_position_decision(self, entry, target_key_input.value)
			if (modal) {
				modal.close()
			}
			if (!decision) {
				// same position or unreadable input: nothing to move
				return false
			}
			self.sort_data(decision)
		}
		button_ok.addEventListener('click', change_order)

	// modal
		modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'small', // string size big|normal|small
			minimizable	: false,
			callback	: () => {
				const keyup_handler = (evt) => {
					// Enter key
					if (evt.code==='Enter' || evt.code==='NumpadEnter') {
						change_order()
					}
				}
				target_key_input.addEventListener('keyup', keyup_handler)
				// focus input
				dd_request_idle_callback(
					() => {
						target_key_input.focus()
						target_key_input.select()
					}
				)
			}
		})
		// the row stays held (never released) while the modal is open
		if (modal) {
			modal.on_close = () => {
				release()
			}
		}else{
			release()
		}


	return modal
}//end open_move_to_position



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

			const info_value = component_info.value?.length
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
						inner_html		: `${get_label.delete || 'Delete'} ID: ${render_value(section_id, 'text')} <span class="note">[${render_value(section_tipo, 'text')}]</span>`,
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
							delete_diffusion_records_checkbox.addEventListener('change', (_e) => {
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
					const key = parseInt(row_key, 10)
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
					// the portal may be destroyed (or re-rendered away) before the frame
					if (!self.node || self.status==='destroyed') {
						return
					}
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
* RENDER_LIST_AFTER
* Build the `.list_after` slot of a portal row view: the ONE non-row sibling placed
* right after `list_body` (table views) or `content_data` (list views), never
* inside `content_data` (row invariant) nor inside a `role=table` list_body
* (WC-2026-10-30-section-record-row-box). Contents, in order:
*   - the order indicator (`render_order_indicator`: the TEMPORARY view order with
*     its clear / save actions, else the declared order), edit mode only, unless
*     `parts.order_indicator===false` (the mosaic alt table: the main list shows it);
*   - `ul.references` (component_relation_related back-references), unless
*     `parts.references===false`;
*   - `parts.list_footer` (indexation "Remove filter");
*   - `parts.error` (a `render_error` node);
*   - `parts.placeholder` (the iri `span.component_placeholder` of an empty line portal);
*   - the print notice (render_common_section.js `render_print_notice`, the ONE
*     implementation shared with the section lists): a `span.print_notice`,
*     visible only in print, while the window keeps rows unbuilt (placeholders):
*     unbuilt rows are neither printed nor findable, and the notice says so
*     instead of narrowing silently.
* The view hands the result to its content_data as the expando
* `content_data.list_after` (node or null); the full render places it with
* common.js `place_list_after`, and `common.render('content')` swaps it.
* @param {Object} self - The `component_portal` instance.
* @param {Object} [parts={}]
* @param {HTMLElement} [parts.content_data] - The rows' container (print notice).
* @param {Object} [parts.record_window] - Its row window handle (print notice).
* @param {boolean} [parts.order_indicator] - `false` skips the order indicator.
* @param {boolean} [parts.references] - `false` skips the references block.
* @param {Node|null} [parts.list_footer]
* @param {Node|null} [parts.error]
* @param {Node|null} [parts.placeholder]
* @returns {HTMLElement|null} The `.list_after` node, or null when it would be empty.
*/
export const render_list_after = function(self, parts={}) {

	const nodes = []

	// order indicator. Temporary view order / declared order (edit mode)
		if (parts.order_indicator!==false) {
			const order_indicator = render_order_indicator(self)
			if (order_indicator) {
				nodes.push(order_indicator)
			}
		}

	// references
		const references = self.data?.references || []
		if (parts.references!==false && references.length > 0) {
			nodes.push( render_references(references) )
		}

	// list_footer, error, placeholder
		for (const node of [parts.list_footer, parts.error, parts.placeholder]) {
			if (node) {
				nodes.push(node)
			}
		}

	// print notice. Only while the window keeps rows unbuilt
		const print_notice = render_print_notice(parts.content_data, parts.record_window)
		if (print_notice) {
			nodes.push(print_notice)
		}

	if (nodes.length===0) {
		return null
	}

	// list_after
		const list_after = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_after'
		})
		for (const node of nodes) {
			list_after.appendChild(node)
		}


	return list_after
}//end render_list_after



/**
* RENDER_ORDER_INDICATOR
* The portal order indicator (portal order model, stage O2 —
* WC-2026-10-31-portal-order-model). Edit mode only:
*   - a TEMPORARY `view_order` is active (a header click): "<Order>: <column> ↓"
*     + a reset button (back to the saved order, = the declared order on a
*     declared-order portal) + a save button iff `can_save_view_order` (never under a
*     declared order: the server refuses `sort_by_column` there);
*   - else, under a declared (ontology) order, on a non-empty list: the PERMANENT
*     declared order, no button;
*   - else nothing (the list shows its saved order).
* Labels are existing keys only (order, save, reset, ascending, descending); the
* column name is the column's own label. The direction arrow is decorative
* (aria-hidden): the group's accessible name spells it.
* @param {Object} self - The `component_portal` instance
* @returns {HTMLElement|null}
*/
export const render_order_indicator = function(self) {

	if (self.mode!=='edit') {
		return null
	}

	// entries. The temporary view order wins; else the declared order
		const view_order	= self.view_order || null
		const entries		= view_order
			? [view_order]
			: declared_order_of(self)
		if (entries.length===0) {
			return null
		}
		if (!view_order && (self.data?.entries || []).length===0) {
			return null // a declared order on an empty list orders nothing
		}

	// labels
		const order_label = get_label.order || 'Order'
		const direction_label = (direction) => direction==='DESC'
			? (get_label.descending || 'descending')
			: (get_label.ascending || 'ascending')

	// order_indicator
		const order_indicator = ui.create_dom_element({
			element_type	: 'div',
			class_name		: `order_indicator ${view_order ? 'temporary' : 'declared'}`
		})
		order_indicator.setAttribute('role', 'group')

	// text. "<Order>: <column> ↓[, <column> ↑]"
		const text = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'order_text',
			text_content	: `${order_label}: `,
			parent			: order_indicator
		})
		const spoken = []
		entries.forEach((entry, i) => {
			if (i>0) {
				text.appendChild( document.createTextNode(', ') )
			}
			const column_label = order_column_label(self, entry.tipo)
			if (column_label) {
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'order_column',
					text_content	: `${column_label} `,
					parent			: text
				})
			}
			const direction_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: `order_direction ${entry.direction==='DESC' ? 'desc' : 'asc'}`,
				text_content	: entry.direction==='DESC' ? '↓' : '↑',
				title			: direction_label(entry.direction),
				parent			: text
			})
			direction_node.setAttribute('aria-hidden', 'true')
			spoken.push( [column_label, direction_label(entry.direction)].filter(Boolean).join(' ') )
		})
		const group_name = `${order_label}: ${spoken.join(', ')}`
		order_indicator.setAttribute('aria-label', group_name)

	// actions. Only on a temporary view order
		if (view_order) {

			// save current order. Never under a declared order (can_save_view_order)
				if (can_save_view_order(self)) {
					const button_save = ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'order_save light',
						text_content	: get_label.save || 'Save',
						title			: `${get_label.save || 'Save'} · ${group_name}`,
						parent			: order_indicator
					})
					button_save.addEventListener('click', (e) => {
						e.stopPropagation()
						run_order_action(button_save, () => self.save_view_order())
					})
				}

			// reset. Back to the saved (or declared) order
				const button_reset = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'order_reset ghost',
					text_content	: get_label.reset || 'Reset',
					title			: `${get_label.reset || 'Reset'} · ${group_name}`,
					parent			: order_indicator
				})
				button_reset.addEventListener('click', (e) => {
					e.stopPropagation()
					run_order_action(button_reset, () => self.clear_view_order())
				})
		}


	return order_indicator
}//end render_order_indicator



/**
* ORDER_COLUMN_LABEL
* The display label of the column `tipo` (its own columns_map label, sub-columns
* included), or '' when this portal has no such column.
* @param {Object} self - The `component_portal` instance
* @param {string|null} tipo
* @returns {string}
*/
const order_column_label = function(self, tipo) {

	if (!tipo) {
		return ''
	}

	const find = (columns_map) => {
		for (const column of (columns_map || [])) {
			if (column?.tipo===tipo) {
				return column
			}
			const found = find(column?.columns_map)
			if (found) {
				return found
			}
		}
		return null
	}
	const column = find(self.columns_map)
	const label = column?.label

	return typeof label==='string' && label.length > 0 && label!==tipo
		? label
		: tipo
}//end order_column_label



/**
* RUN_ORDER_ACTION
* Runs one order indicator action once at a time: the button is disabled and marked
* `loading` while it runs (its own node is replaced by the re-render on success).
* @param {HTMLButtonElement} button
* @param {Function} action - async; its failures are logged, never thrown at the listener
* @returns {Promise<void>}
*/
const run_order_action = async function(button, action) {

	if (button.disabled) {
		return
	}
	button.disabled = true
	button.classList.add('loading')
	try {
		await action()
	} catch (error) {
		console.error('Order action failed:', error)
	} finally {
		button.disabled = false
		button.classList.remove('loading')
	}
}//end run_order_action



/**
* ADD_WRAPPER_EVENTS
* Attach the common set of event listeners to the portal's top-level wrapper node.
*
* 1. **Click → autocomplete**
*    A `click` listener calls `activate_autocomplete` (in a microtask) when the
*    portal is active (`self.active === true`).
*
* 2. **The wrapper MOVE zone** (drag_and_drop.js `bind_portal_drop`)
*    A record dragged from ANOTHER portal may be dropped anywhere on this portal
*    (an empty portal has no rows). One code path for every edit view: whether this
*    portal accepts the drop is the SOURCE's ontology (`properties.draggable_to`)
*    and this portal's permissions, decided by `decide_drop` — never a per-view
*    switch. A drag that is not a portal row (a thesaurus term, a file, text)
*    bubbles on untouched (foreign guard).
*
* @param {Object} self - The `component_portal` instance.
* @param {HTMLElement} wrapper - The portal's main wrapper node.
* @returns {boolean} Always returns `true`.
*/
export const add_wrapper_events = function(self, wrapper) {

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

	// MOVE zone (wrapper-level dragover / drop, MOVE only)
		bind_portal_drop(self, wrapper)

	return true
}//end add_wrapper_events



// @license-end
