// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* RENDER_TS_ID_COLUMN
* Renders the leftmost "id column" action strip inside each thesaurus row (ts_object).
*
* The id column contains up to five interactive controls, built conditionally based
* on the ts_object's thesaurus_mode, permission levels, and node type:
*
*  - ADD button    — creates a new descriptor child under the current term (permissions_button_new >= 2)
*  - DRAG handle   — enables drag-and-drop reordering within the parent's children list
*  - DELETE button — opens a modal dialog for safe record deletion (permissions_button_delete >= 2)
*  - ORDER number  — displays virtual_order; clicking opens an inline edit form
*  - EDIT link     — opens the record editor; shows the numeric section_id
*
* When thesaurus_mode is 'relation' (the tree was opened as a term picker for a caller
* component) all of the above are replaced by the picker's single term control, built by
* the shared thesaurus_picker module. This file publishes nothing and decides nothing:
* the pick channel, the selection set and the per-term selectability answer all live in
* thesaurus_picker.js, so the tree row and the thesaurus list row offer the same
* affordance and there is one publisher instead of two.
*
* Exported functions: render_id_column
* Module-private functions: render_order_form
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {get_all_instances} from '../../common/js/instances.js'
	import {render_delete_record_dialog} from './render_ts_dialogs.js'
	import {same_section_id} from '../../common/js/utils/index.js'
	import {response_data} from '../../common/js/api_error.js'
	import {
		get_picker,
		render_term_pick_control,
		term_selectability
	} from '../../area_thesaurus/js/thesaurus_picker.js'
	import {bound_sqo_limit} from '../../common/js/sqo_limit.js'
	import {a11y} from '../../common/js/a11y.js'



/**
* RENDER_ID_COLUMN
* Builds and returns the `id_column_content` DOM node for a ts_object row.
*
* The rendered markup depends on two axes:
*   1. `thesaurus_mode` — when 'relation', only the picker's term control is produced;
*      all other modes fall through to the default set of action controls.
*   2. Permission levels and node flags — each button is gated individually:
*        - ADD and DRAG require `permissions_button_new >= 2` and `is_descriptor === true`.
*        - DELETE requires `permissions_button_delete >= 2`.
*        - ORDER requires the above ADD conditions plus `!is_root_node` (a root's caller is the
*          area, not a ts_object). It shows in search mode too; a sibling list that is not the
*          parent's exact children is refused by the server and the local order restored
*          (WC-2026-11-07-save-order-complete-list). Picker ('relation') trees never reach
*          it — that branch returns before ORDER.
*        - EDIT is always rendered.
*
* Expected DOM output (default mode, full permissions):
*   <div class="id_column_content">
*     <a class="id_column_link ts_object_add" title="add"><div class="ts_object_add_icon"></div></a>
*     <div class="id_column_link ts_object_drag" title="drag"><div class="ts_object_drag_icon"></div></div>
*     <a class="id_column_link ts_object_delete" title="delete"><div class="ts_object_delete_icon"></div></a>
*     <a class="id_column_link ts_object_order_number"><span>1</span></a>
*     <a class="id_column_link ts_object_edit" title="edit">
*       <div class="ts_object_section_id_number"><span>15</span></div>
*       <div class="ts_object_edit_icon"></div>
*     </a>
*   </div>
*
* Side effects:
*   - Stores a reference to the ORDER anchor on `self.order_number_link` so that
*     `render_order_form` can hide/show it without a DOM query.
*   - In 'relation' mode, delegates the whole term control to
*     `render_term_pick_control` (thesaurus_picker.js): it subscribes the control to the
*     picker's selection, repaints it on every change and publishes the pick through the
*     one publisher. The window resolution this file used to duplicate lives there too.
*
* @param {Object} self - ts_object instance providing all required state and methods.
* @returns {HTMLElement} The fully-populated `id_column_content` div; attach it to the row node.
*/
export const render_id_column = function(self) {

	// short vars
		const section_tipo		= self.section_tipo
		const section_id		= self.section_id
		const is_descriptor		= self.is_descriptor
		const virtual_order		= self.virtual_order
		const is_root_node		= self.is_root_node
		const thesaurus_mode	= self.thesaurus_mode

	// id column container
		const id_column_content = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'id_column_content'
		})
	switch(thesaurus_mode) {

		case 'relation': {

			// picker. Resolved from the linker this row already carries (one hop, no
			// caller-chain walk). A relation-mode tree with no picker attached is a
			// wiring defect in the host — attach_picker was never called — and it is
			// named here instead of degrading into an anchor that can publish nothing.
				const picker = get_picker(self)
				if (!picker) {
					console.error(`Error. No picker is attached to this tree.
						The host must call attach_picker(area_instance, {linker, caller}) before rendering it:`, self);
					break;
				}

			// term label. The first 'term' element of ar_elements, which is a
			// heterogeneous array also carrying 'qualifier', 'note', etc. items.
				const current_label_term = self.data.ar_elements.find(el => el.type==='term')

			// term control. Built by the shared picker module, so the tree row and the
			// thesaurus list row offer the exact same affordance and there is ONE
			// publisher of the pick.
			// (!) A non-selectable node gets NO control — render_term_pick_control
			// returns null for it, which is the same outcome as this branch's original
			// `if (is_indexable===false) break`. The arrow MEANS "this term can be
			// indexed": drawing a dimmed one on every structural/grouping level would
			// bury the terms that actually accept a link. Absence is the signal.
			// Selectability is the SERVER's answer (root_terms_selectable on the area
			// read, or this node's own is_indexable) and is read, never recomputed here.
				render_term_pick_control({
					picker		: picker,
					term		: {
						section_tipo	: section_tipo,
						section_id		: section_id,
						label			: current_label_term ? current_label_term.value : ''
					},
					selectable	: term_selectability(picker, self),
					parent		: id_column_content
				})
			break;
		}

		default: {

			// ADD . button + add element
				if (self.permissions_button_new>=2 && is_descriptor) {
					const link_add = ui.create_dom_element({
						element_type	: 'a',
						class_name		: 'id_column_link ts_object_add',
						title_label		: 'add',
						parent			: id_column_content
					})
					// click event
					const add_click_handler = async function(e) {
						e.stopPropagation()

						// Require explicit user confirmation before creating a new child node,
						// since the add_child API call cannot be trivially undone in the tree.
						// (!) The term text is record data and travels through the `note`
						// slot, which renders as text — never through `header`, which is HTML.
						const confirmed = await ui.confirm({
							header			: (get_label.new || 'New') + ' ' + (get_label.record || 'record'),
							note			: self.term_text?.textContent || null,
							body			: get_label.sure || 'Are you sure?',
							accept_class	: 'brand new'
						})
						if (confirmed!==true) {
							return
						}

						// mode set in dataset
						// Mark the anchor with its action so observers can track the operation.
							link_add.dataset.mode = 'add_child'

						// add_child
						// Calls the ts_object.add_child() method which issues the API request
						// and answers the new section_id as its payload on success.
							const response = await self.add_child()

						// new_section_id . Generated as response by the trigger add_child
							const new_section_id = response_data(response)
							if (!new_section_id) {
								return
							}

						// pagination. Built by value: never mutate the cached
						// self.children_data.pagination object.
						// When a pagination object is present (children were previously loaded
						// with limit/offset) restart at offset 0 with the SAME page size so
						// the refreshed list starts from the beginning, revealing the newly
						// added child (audit P2-31 / CLI-30: this sent `limit: 0` — the
						// whole branch — exactly when the node was known to be paginated).
							const pagination = self.children_data?.pagination
								? { limit: bound_sqo_limit(self.children_data.pagination.limit), offset: 0 }
								: null

						// children_data - get_children_data from API
						// cache:false forces a fresh server request so the new child appears.
							const children_data = await self.get_children_data({
								pagination	: pagination,
								children	: null,
								cache		: false // Forces call API again
							})
							if (!children_data) {
								// error case
								console.warn("[ts_object.render_children] Error, children_data is null");
								return false
							}

						// update children state
						// Syncs children_data AND has_descriptor_children (instance + self.data),
						// re-renders the children and refreshes the term line so the expand
						// arrow appears on a former leaf node. Setting children_data alone left
						// the arrow hidden (and a later content refresh rebuilt it from stale data).
							const updated = await self.update_children_state({
								children_data	: children_data,
								render			: true,
								refresh_content	: true,
								show_children	: true
							})

						// Open editor in new window
						// Only open the record editor when the update succeeded;
						// otherwise the DOM is in an unknown state.
							if (updated) {
								self.open_record(
									new_section_id, // section_id
									section_tipo // section_tipo
								);
							}
					}
					a11y.make_activable(link_add, {
						on_activate	: add_click_handler,
						label		: (typeof get_label!=='undefined' ? (get_label.new || 'New') : 'New')
					})

					// add_icon_link_add
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'ts_object_add_icon',
						parent			: link_add
					})
				}//end if (self.permissions_button_new>=2)

			// MOVE DRAG . button drag element
			// The drag handle is intentionally excluded for root nodes because root
			// items are anchored by a portal relation, not by a movable parent/child link.
				if (self.permissions_button_new>=2 && is_descriptor && !is_root_node) {
					const dragger = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'id_column_link ts_object_drag',
						title_label		: 'drag',
						parent			: id_column_content
					})
					// mousedown event
					// draggable is set to true only on mousedown over the explicit drag handle,
					// so clicking elsewhere on the row does not accidentally start a drag.
					const mousedown_handler = (e) => {
						e.stopPropagation()

						const wrapper = self.node
						// event_handle. set with event value
						// Store the originating event on the wrapper so the drag_and_drop
						// module can reference it when computing the drop target.
						wrapper.event_handle = e
						// activate draggable
						wrapper.draggable = true
					}
					// a11y: the drag handle keeps its pointer semantics (the drag itself is
					// pointer-driven); reordering by keyboard is the order-number control
					// below, which is why this handle takes a NAME but no tab stop.
					a11y.set_label(dragger, (typeof get_label!=='undefined' ? (get_label.order || 'Order') : 'Order'))
					dragger.addEventListener('mousedown', mousedown_handler)
					// mouseup event . Reverts mousedown wrapper draggable set
					// Clearing draggable on mouseup prevents the row from remaining in
					// drag-ready state when the user clicks without actually dragging.
					const mouseup_handler = (e) => {
						e.stopPropagation()
						const wrapper = self.node
						// event_handle. set with event value
						wrapper.event_handle = null
						// deactivate draggable
						wrapper.draggable = false
					}
					dragger.addEventListener('mouseup', mouseup_handler)

					// drag icon
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'ts_object_drag_icon',
						parent			: dragger
					})
				}

			// DELETE . button delete element
				if (self.permissions_button_delete>=2) {
					const link_delete = ui.create_dom_element({
						element_type	: 'a',
						class_name		: 'id_column_link ts_object_delete',
						title_label		: 'delete',
						parent			: id_column_content
					})
					// click event
					const click_handler = (e) => {
						e.stopPropagation()
						// delete record using wrapper data
						render_delete_record_dialog({
							self					: self,
							section_id				: section_id,
							section_tipo			: section_tipo,
							has_descriptor_children	: self.has_descriptor_children
						})
					}
					a11y.make_activable(link_delete, {
						on_activate	: click_handler,
						label		: (typeof get_label!=='undefined' ? (get_label.delete || 'Delete') : 'Delete')
					})

					// delete icon
					ui.create_dom_element({
						element_type    : 'div',
						class_name		: 'ts_object_delete_icon',
						parent			: link_delete
					 })
				}//end if (self.permissions_button_delete>=2)

			// ORDER number element
				if (self.permissions_button_new>=2 && is_descriptor && !is_root_node) {
					const order_number_link = ui.create_dom_element({
						element_type	: 'a',
						class_name		: 'id_column_link ts_object_order_number',
						text_node		: virtual_order,
						parent			: id_column_content
					})
					// Set pointer
					self.order_number_link = order_number_link
					// click event
					const click_handler = (e) => {
						e.stopPropagation()
						render_order_form({
							self				: self,
							order_number_link	: order_number_link
						})
					}
					a11y.make_activable(order_number_link, {
						on_activate	: click_handler,
						label		: (typeof get_label!=='undefined' ? (get_label.order || 'Order') : 'Order')
					})
				}

			// EDIT . button edit element
				const link_edit = ui.create_dom_element({
					element_type	: 'a',
					class_name		: 'id_column_link ts_object_edit',
					title_label		: 'edit',
					parent			: id_column_content
				})
				// mousedown event
				// mousedown is used instead of click so the record opens before focus
				// shifts to a different element on pointer-up.
				const mousedown_handler = (e) => {
					e.stopPropagation()

					// Get hierarchy1 from 'area_thesaurus' caller data value
					// Edge case: when ar_elements is empty the ts_object was loaded as a
					// shallow stub (e.g. from an area_thesaurus portal relation list) and
					// does not yet hold its own section_id. In this case resolve the
					// correct section_id from the caller's portal data by matching
					// target_section_tipo, then open that record instead.
					if(self.data?.ar_elements?.length === 0) {
						const value = self.caller?.data?.[0]?.value || []
						const hierarchy1 = value.find(item => item.target_section_tipo === self.section_tipo)
						if(hierarchy1) {
							self.open_record(
								hierarchy1.section_id,
								hierarchy1.section_tipo
							)
						}
						return
					}

					// edit call
					// Normal case: open the editor for this node's own section record.
					self.open_record(
						self.section_id,
						self.section_tipo
					)
				}
				a11y.make_activable(link_edit, {
					pointer_event	: 'mousedown',
					on_activate		: mousedown_handler,
					label			: (typeof get_label!=='undefined' ? (get_label.edit || 'Edit') : 'Edit')
				})

				// section_id number
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'ts_object_section_id_number',
					text_node		: self.section_id,
					parent			: link_edit
				})
				// edit icon
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'ts_object_edit_icon',
					parent			: link_edit
				})

			break;
		}
	}//end switch(self.thesaurus_mode)


	return id_column_content
}//end render_id_column



/**
* RENDER_ORDER_FORM
* Replaces the static “order number” link with an inline `<input>` for immediate re-ordering.
*
* When the user changes the value and presses Enter (change event fires), the function:
*   1. Calls `self.save_order(newValue)` to persist the new position via the API.
*   2. Re-sorts the sibling wrapper nodes in `self.caller.children_container` to match
*      the server-side `ar_children_data` order — without a full `render_children` call,
*      so that already-open child subtrees remain expanded in the DOM.
*   3. Calls `instance.refresh({ render_level:'content' })` on each sibling ts_object so
*      that individual order-number links reflect the updated positions.
*   4. Hilites the current term via `dd_request_idle_callback` to provide visual feedback.
*
* On blur (Escape or loss of focus) the input is removed and the original link is
* unhidden, regardless of whether the user confirmed a value change.
*
* Only one input.input_order may exist in the document at a time; opening a second
* one removes any previous instance globally.
*
* @param {Object} options
* @param {Object} options.self - ts_object instance owning the row being reordered.
* @param {HTMLElement} options.order_number_link - the anchor that triggered the edit form;
*        hidden while the input is visible and restored on blur.
* @returns {boolean} false when order_number_link is missing; true after setup completes.
*/
const render_order_form = function(options) {

	// options
	const {
		self,
		order_number_link
	} = options

	// Check mandatory order_number_link
	if (!order_number_link) {
		return false
	}

	// Remove all previous inputs
	document.querySelectorAll('input.input_order').forEach(node => node.remove())

	// Current value (old)
	const old_value = Number(self.virtual_order) || 0

	// input. Create a input to contain the current order value
	const input = document.createElement('input')
	input.classList.add('id_column_link','input_order')
	input.value = old_value

	// keydown event - prevent the event from bubbling up (e.g. to the tree view click)
	const keydown_handler = (e) => {
		e.stopPropagation()
		// Blur on Escape key to cancel the edit
		if (e.key === 'Escape') {
			input.blur()
		}
	}
	input.addEventListener('keydown', keydown_handler);

	// change handler – called when the user presses Enter
	const change_handler = async () => {

		const wrapper = self.node

		wrapper.classList.add('loading')

		// save order. Note that this function do not await the
		// API request for performance. If the request fails,
		// a error notification is displayed at top
		const saved = await self.save_order( input.value )

		wrapper.classList.remove('loading');
		input.blur();

		// not moved (same position) or not persisted (save_order restored the
		// local order): the DOM already shows the truth
		if (saved!==true) {
			return
		}

		// Re-order the children_container nodes
		// The nodes are ordered manually (avoiding use 'render_children') to
		// preserve the already open children ODM nodes.
		// Strategy: iterate the server-authoritative ar_children_data array in order
		// and move each matching DOM wrapper to the END of the container. After the
		// loop the DOM sequence matches the server order because each appendChild()
		// bumps the node past all others that have not yet been moved.
		const order_children	= self.caller.children_data.ar_children_data
		// Snapshot the live NodeList into an array once so subsequent appendChild()
		// calls do not affect iteration (live NodeLists update in place).
		const children_list		= [...self.caller.children_container.childNodes]

		for (const item of order_children) {

			// Find wrapper into the parent children_container
			// (!) Note: section_id comparison uses == (loose equality) because
			// dataset values are always strings while item.section_id may be a number.
			const found_wrapper = children_list.find(el => {
				return  el.dataset.section_tipo===item.section_tipo &&
						el.dataset.section_id==item.section_id;
			});

			if (!found_wrapper) continue;

			// Move wrapper node to the end of the container in each
			// iteration to ends matching the order of the children data (order_children).
			self.caller.children_container.appendChild(found_wrapper)

			// Instance refresh. Force instance to update order value link
			// without render their children nodes.
			// render_level:'content' re-renders only the row content (including the
			// order number display) while leaving child subtrees untouched.
			const instance = get_all_instances().find(el =>
				same_section_id(el.section_id, item.section_id) &&
				el.section_tipo===item.section_tipo &&
				el.model==='ts_object'
			);
			if (instance) {
				await instance.refresh({
					render_level	: 'content',
					destroy			: false,
					build_autoload	: false
				})
			}
		}

		// hilite current term
		// Defer the hilite until after the browser has processed the DOM mutations
		// so the scroll-into-view calculation uses final layout positions.
		dd_request_idle_callback(()=>{
			// hilite
			self.hilite_element(self.term_node)
		})
	}
	input.addEventListener('change', change_handler);

	// blur event – hide the input and show the original link
	const blur_handler = (e) => {
		e.stopPropagation()
		// Remove the unnecessary input field node
		input.remove()
		// Display the hidden order link
		order_number_link.classList.remove('hide')
	}
	input.addEventListener('blur', blur_handler);

	// Insert the input into the DOM

	// Add input element after the order_number_link
	order_number_link.parentNode.insertBefore(input, order_number_link.nextSibling);

	// Hide order_number_link
	order_number_link.classList.add('hide')

	// Focus and select new input element
	input.focus();
	input.select();


	return true
}//end render_order_form



// @license-end
