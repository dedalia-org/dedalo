// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global */
/*eslint no-undef: "error"*/



/**
* DRAG_TOOL_EXPORT
* Drag-and-drop for tool_export's "Active elements" list (the columns to export).
*
* Two drags share ONE drop model:
*
*  - 'add'  — a component dragged from the left-hand section elements list
*             (render_common wires its dragstart to `on_dragstart`).
*  - 'sort' — an already-selected export_component dragged within the list
*             (`do_sortable` in render_tool_export.js starts it and calls
*             `set_sort_payload`).
*
* THE DROP MODEL. The whole selection column (title + list + the free space
* below it) is ONE drop zone. While dragging over it, the insertion index is
* derived from the pointer: the first item whose vertical midpoint lies below
* the pointer — upper half of a row = before it, lower half = after it, below
* the last row = at the end. A single `.drop_marker` line is shown exactly at
* that index, so the user sees where the element will land BEFORE releasing;
* the rows never move under the pointer. The drop inserts at the same index.
*
* The payload is kept on the instance (`self.drag_payload`) at dragstart:
* dataTransfer cannot be read during dragover, and the marker must know the
* drag type and (for 'add') whether the element is already in the list. A
* duplicate shows no marker, highlights the existing row and refuses the drop
* (dropEffect 'none'); a sort onto its own position shows no marker either.
*
* All handlers are prototype methods on tool_export (tool_export.js), so they
* run with the tool instance as `this`.
*
* Exports: on_dragstart, on_dragover, on_dragleave, on_drop, on_dragend,
*          set_sort_payload, get_drop_index
*/



/**
* GET_DROP_INDEX
* The insertion index for a pointer at `client_y` over `items`: the index of
* the first item whose vertical midpoint lies below the pointer, or
* items.length (append) when the pointer is below every midpoint.
* @param {HTMLElement[]} items - the list rows, in DOM order
* @param {number} client_y - pointer Y (viewport coordinates)
* @returns {number} 0..items.length
*/
export const get_drop_index = function(items, client_y) {

	const items_length = items.length
	for (let i = 0; i < items_length; i++) {
		const rect = items[i].getBoundingClientRect()
		if (client_y < rect.top + rect.height / 2) {
			return i
		}
	}

	return items_length
}//end get_drop_index



/**
* GET_ITEMS
* The list rows (export_component nodes) — never the marker.
* @param {HTMLElement} list - user_selection_list
* @returns {HTMLElement[]}
*/
const get_items = function(list) {

	return [...list.children].filter(node => node.classList.contains('export_component'))
}//end get_items



/**
* ON_DRAGSTART
* Starts an 'add' drag from the left-hand section elements list. The payload
* goes to dataTransfer (the drag API requires data) AND to self.drag_payload,
* which the dragover/drop handlers read.
* @param {HTMLElement} obj - the dragged list node; exposes `.path` and `.ddo`
* @param {DragEvent} event
* @returns {boolean} true
*/
export const on_dragstart = function(obj, event) {
	event.stopPropagation();

	const self = this

	const data = {
		drag_type	: 'add',
		path		: obj.path, // full path from current section
		ddo			: obj.ddo
	}
	event.dataTransfer.effectAllowed = 'move';
	event.dataTransfer.setData(
		'text/plain',
		JSON.stringify(data)
	);

	self.drag_payload = {
		...data,
		id : self.compose_id(obj.ddo, obj.path)
	}

	return true
}//end on_dragstart



/**
* SET_SORT_PAYLOAD
* Starts a 'sort' drag of an already-selected row (called by do_sortable).
* @param {HTMLElement} element - the dragged export_component
* @returns {void}
*/
export const set_sort_payload = function(element) {

	const self = this

	self.dragged		= element
	self.drag_payload	= {
		drag_type : 'sort'
	}
}//end set_sort_payload



/**
* ON_DRAGOVER
* Resolves the insertion index under the pointer and shows the marker there
* (or, for a duplicate / no-op, highlights instead and refuses the drop).
* @param {HTMLElement} zone - the selection column (the drop zone)
* @param {DragEvent} event
* @returns {void}
*/
export const on_dragover = function(zone, event) {

	const self = this

	const payload = self.drag_payload
	if (!payload) {
		// not one of ours (a file from the desktop, a drag from another widget)
		return
	}

	event.preventDefault();
	event.stopPropagation();

	const list	= self.user_selection_list
	const items	= get_items(list)

	// duplicate: point at the row that already holds it
	if (payload.drag_type==='add') {
		const existing = items.find(node => node.ddo?.id===payload.id)
		if (existing) {
			event.dataTransfer.dropEffect = 'none'
			hide_marker(self)
			if (!existing.classList.contains('drop_duplicate')) {
				existing.classList.add('drop_duplicate')
				existing.scrollIntoView({block: 'nearest'})
			}
			return
		}
	}

	event.dataTransfer.dropEffect = 'move'

	const index = get_drop_index(items, event.clientY)

	// sort onto its own position (just above or below itself): nothing moves
	if (payload.drag_type==='sort') {
		const dragged_index = items.indexOf(self.dragged)
		if (dragged_index!==-1 && (index===dragged_index || index===dragged_index + 1)) {
			hide_marker(self)
			return
		}
	}

	show_marker(self, list, items, index)
}//end on_dragover



/**
* SHOW_MARKER
* Places the one insertion marker at `index` (moves it only when the index
* changed, so a still pointer causes no DOM churn).
* @param {Object} self - tool_export instance
* @param {HTMLElement} list - user_selection_list
* @param {HTMLElement[]} items - the list rows
* @param {number} index - insertion index
* @returns {void}
*/
const show_marker = function(self, list, items, index) {

	if (self.drop_index===index && self.drop_marker?.parentNode===list) {
		return
	}

	if (!self.drop_marker) {
		self.drop_marker = document.createElement('div')
		self.drop_marker.className = 'drop_marker'
	}
	list.insertBefore(self.drop_marker, items[index] || null)
	self.drop_index = index
}//end show_marker



/**
* HIDE_MARKER
* Removes the marker and any duplicate highlight; forgets the index.
* @param {Object} self - tool_export instance
* @returns {void}
*/
const hide_marker = function(self) {

	self.drop_marker?.remove()
	self.drop_index = null
}//end hide_marker



/**
* CLEAR_DRAG_STATE
* Full reset: marker, duplicate highlight, payload.
* @param {Object} self - tool_export instance
* @returns {void}
*/
const clear_drag_state = function(self) {

	hide_marker(self)
	self.user_selection_list?.querySelectorAll('.drop_duplicate').forEach(node => {
		node.classList.remove('drop_duplicate')
	})
}//end clear_drag_state



/**
* ON_DRAGLEAVE
* Hides the marker when the pointer really leaves the zone (dragleave also
* fires when moving between the zone's own children — those are ignored).
* @param {HTMLElement} zone - the selection column
* @param {DragEvent} event
* @returns {void}
*/
export const on_dragleave = function(zone, event) {

	const self = this

	if (event.relatedTarget && zone.contains(event.relatedTarget)) {
		return
	}
	clear_drag_state(self)
}//end on_dragleave



/**
* ON_DRAGEND
* Any drag of ours ended (dropped anywhere, or cancelled with Escape): no
* marker, highlight or payload may outlive it. Wired on the tool's grid, which
* contains both drag sources ('add' ends on the LEFT list, not on the zone).
* @returns {void}
*/
export const on_dragend = function() {

	const self = this

	clear_drag_state(self)
	self.drag_payload	= null
	self.dragged		= null
}//end on_dragend



/**
* ON_DROP
* Inserts at the index the marker showed: moves the dragged row ('sort') or
* builds and inserts a new export_component ('add'). The DOM is the single
* source of truth for column order — sync_ar_ddo_to_export then persists it.
* @param {HTMLElement} zone - the selection column
* @param {DragEvent} event
* @returns {boolean} true when something was placed
*/
export const on_drop = function(zone, event) {

	const self = this

	const payload	= self.drag_payload
	const index		= self.drop_index
	if (!payload) {
		return false
	}

	event.preventDefault()
	event.stopPropagation()

	clear_drag_state(self)
	self.drag_payload = null

	// no marker was shown (duplicate, or a sort onto its own position)
	if (index===null || index===undefined) {
		return false
	}

	const list	= self.user_selection_list
	const ref	= get_items(list)[index] || null

	// sort: move the row
	if (payload.drag_type==='sort') {
		const dragged = self.dragged
		self.dragged = null
		if (!dragged) {
			return false
		}
		list.insertBefore(dragged, ref)
		flash(dragged)
		self.sync_ar_ddo_to_export()
		self.update_local_db_data()
		return true
	}

	// add: build the new column
	const new_ddo = {
		id					: payload.id,
		tipo				: payload.ddo.tipo,
		section_tipo		: payload.ddo.section_tipo,
		model				: payload.ddo.model,
		parent				: payload.ddo.parent,
		lang				: payload.ddo.lang,
		mode				: payload.ddo.mode,
		label				: payload.ddo.label,
		value_with_parents	: false, // per-component parents export (checkbox in the item)
		value_with_references	: false, // per-component calculated relations export (checkbox in the item)
		path				: payload.path // full path from current section replaces ddo single path
	}
	self.build_export_component(new_ddo)
	.then((export_component_node)=>{
		// the reference row may have been removed while the node was built
		const anchor = ref && ref.parentNode===list ? ref : null
		list.insertBefore(export_component_node, anchor)
		flash(export_component_node)
		self.sync_ar_ddo_to_export()
		self.update_local_db_data()
	})

	return true
}//end on_drop



/**
* FLASH
* Re-triggers the 'active' arrival animation on a placed row.
* @param {HTMLElement} node
* @returns {void}
*/
const flash = function(node) {

	node.classList.remove('active')
	void node.offsetWidth // restart the animation
	node.classList.add('active')
}//end flash



// @license-end
