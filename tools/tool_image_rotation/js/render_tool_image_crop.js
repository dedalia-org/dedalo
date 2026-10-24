// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_posterframe */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_TOOL_IMAGE_CROP
* Interactive crop-selection overlay for the image-rotation tool.
*
* All state and methods live directly on the constructor function (static
* singleton pattern) — there is no instance created via `new`. The caller
* (render_tool_image_rotation.js) invokes `render_tool_image_crop.build()`
* once per editing session and `render_tool_image_crop.destroy()` when done.
*
* Interaction model:
*  - Clicking the image or its container begins a new rubber-band selection.
*  - Clicking in the shadow area outside an existing selection resets it.
*  - Eight resize handles (nw, n, ne, w, e, sw, s, se) allow resizing the box.
*  - Dragging anywhere else inside the selection moves the box.
*
* After every interactive change, `self.crop_area` is updated to the pixel
* rectangle in *natural image coordinates* (i.e. relative to the original
* file resolution, not the displayed size). This value is read directly by
* `tool_image_rotation.prototype.apply_rotation` as `render_tool_image_crop.crop_area`.
*
* State properties set by `build()` and used across methods:
*  - {boolean} is_selecting    — rubber-band draw is in progress
*  - {boolean} is_dragging     — whole-box drag is in progress
*  - {boolean} is_resizing     — handle-driven resize is in progress
*  - {number}  start_x         — interaction anchor X (viewport pixels)
*  - {number}  start_y         — interaction anchor Y (viewport pixels)
*  - {string|null} current_handle — CSS class name of the active resize handle
*  - {number}  natural_width   — source image naturalWidth (for coordinate scaling)
*  - {number}  natural_height  — source image naturalHeight (for coordinate scaling)
*  - {Object}  nodes           — map of DOM element references built by build()
*  - {Object|null} crop_area   — last computed crop in natural pixels
*                                 { x, y, width, height } or null when cleared
*/
export const render_tool_image_crop = function() {

	return this
}//end render_tool_image_crop



/**
* BUILD
* Creates the crop overlay DOM nodes, wires all mouse event listeners, and
* initialises the interaction state on the singleton.
*
* Eight resize handles are injected as children of the `crop_selection` div;
* their CSS classes follow the compass-point naming convention (nw, n, ne, w,
* e, sw, s, se) which is later read by `start_drag_or_resize` via
* `classList[1]` to identify the active handle.
*
* Bound references to all handlers (including the `mouseup` handler) are stored
* on `self` so that `destroy()` can call `removeEventListener` with the exact
* same function objects (anonymous functions cannot be removed later).
*
* @param {Object} options
* @param {HTMLElement} options.container        - Wrapper div that acts as the
*                                                 interactive canvas (positions
*                                                 the overlay and clips it).
* @param {HTMLElement} options.image            - The `<img>` element being
*                                                 cropped; used to read
*                                                 naturalWidth/naturalHeight for
*                                                 coordinate scaling.
* @param {HTMLElement} options.status_container - Inline status `<div>` updated
*                                                 with live crop coordinates.
* @returns {undefined}
*/
render_tool_image_crop.build = async function(options) {

	const self = this

	self.is_selecting	= false;
	self.is_dragging	= false;
	self.is_resizing	= false;
	self.start_x		= 0;
	self.start_y		= 0;
	self.current_handle	= null;
	self.natural_width	= 0;
	self.natural_height	= 0;
	self.nodes			= {};
	self.crop_area		= {};

	const container				= options.container
	const image					= options.image
	const status_container		= options.status_container

	// Capture source resolution for coordinate-scaling in update_crop_area().
	self.natural_width	= image.naturalWidth;
	self.natural_height	= image.naturalHeight;

	// crop_selection: the visible rubber-band rectangle drawn over the image.
	const crop_selection = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'crop_selection',
		parent			: container
	});
		// Eight compass-point resize handles. The second CSS class (classList[1])
		// encodes the handle name read in start_drag_or_resize().
		const nw_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle nw',
			parent			: crop_selection
		});
		const n_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle n',
			parent			: crop_selection
		});
		const ne_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle ne',
			parent			: crop_selection
		});
		const w_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle w',
			parent			: crop_selection
		});
		const e_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle e',
			parent			: crop_selection
		});
		const sw_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle sw',
			parent			: crop_selection
		});
		const s_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle s',
			parent			: crop_selection
		});
		const se_handle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resize_handle se',
			parent			: crop_selection
		});

	// set nodes pointer
	self.nodes.container		= container
	self.nodes.image			= image
	self.nodes.crop_selection	= crop_selection
	self.nodes.nw_handle		= nw_handle
	self.nodes.n_handle			= n_handle
	self.nodes.ne_handle		= ne_handle
	self.nodes.w_handle			= w_handle
	self.nodes.e_handle			= e_handle
	self.nodes.sw_handle		= sw_handle
	self.nodes.s_handle			= s_handle
	self.nodes.status_container = status_container
	// (!) se_handle is created above but is not stored in self.nodes.
	//     This is a pre-existing omission; do not change the code.


	 // Store references to bound methods
	// Bound versions are required so destroy() can pass the same function
	// reference to removeEventListener().
	self.bound_start_selection = self.start_selection.bind(self);
	self.bound_start_drag_or_resize = self.start_drag_or_resize.bind(self);
	self.bound_handle_mouse_move = self.handle_mouse_move.bind(self)
	self.bound_handle_mouse_up = function() {
		self.is_selecting	= false;
		self.is_dragging	= false;
		self.is_resizing	= false;
		self.current_handle	= null;
	};

    // Mouse down handlers
	self.nodes.container.addEventListener('mousedown', self.bound_start_selection );
	self.nodes.crop_selection.addEventListener('mousedown', self.bound_start_drag_or_resize );

	// Mouse move handler
	self.nodes.container.addEventListener('mousemove', self.bound_handle_mouse_move );

	// Mouse up handler
	// Bound reference is stored on self so destroy() can remove it.
	self.nodes.container.addEventListener('mouseup', self.bound_handle_mouse_up);

}// end build



/**
* DESTROY
* Removes the crop overlay from the DOM and detaches all named event listeners.
*
* Clears the current selection state first via `reset_selection()`, then walks
* the child nodes of `crop_selection` and removes them before detaching the
* element itself. The three named handlers (bound_start_selection,
* bound_start_drag_or_resize, bound_handle_mouse_move, bound_handle_mouse_up)
* are removed by the same bound references stored during `build()`.
*
* @returns {undefined}
*/
render_tool_image_crop.destroy = function() {

	const self = this

	// reset variables
	self.reset_selection()

	// remove DOM elements
	while (self.nodes.crop_selection.firstChild) {
		self.nodes.crop_selection.removeChild(self.nodes.crop_selection.firstChild);
	}

	// remove dom crop_selection
	self.nodes.crop_selection.remove();
	// Remove listeners

	// Mouse down handlers
	self.nodes.container.removeEventListener('mousedown', self.bound_start_selection );
	self.nodes.crop_selection.removeEventListener('mousedown',self.bound_start_drag_or_resize );
	// Mouse move handler
	self.nodes.container.removeEventListener('mousemove', self.bound_handle_mouse_move );
	// Mouse up handler
	self.nodes.container.removeEventListener('mouseup', self.bound_handle_mouse_up);

}// end destroy



/**
* START_SELECTION
* Handles `mousedown` on the container when no crop handle or box is involved.
*
* Guards:
* - If the event target is neither the bare image nor the container (e.g. it
*   lands on a resize handle), the function returns early so that
*   `start_drag_or_resize` takes precedence.
* - If a crop area already exists (`crop_area.width > 0`), a click in the
*   surrounding shadow region resets the selection and returns without starting
*   a new one. This prevents overlapping selections.
*
* When both guards pass, the click position is converted from viewport
* coordinates to container-local coordinates (via `getBoundingClientRect`),
* stored as `self.start_x / start_y`, and the crop_selection element is
* positioned and shown at zero size, ready for the mousemove handler to expand.
*
* @param {MouseEvent} e - The native mousedown event.
* @returns {undefined}
*/
render_tool_image_crop.start_selection = function(e) {

	const self = this

	// if the element target is not a valid element stop
	if (e.target !== self.nodes.image && e.target !== self.nodes.container){
		return;
	}

	// when the user click outside of the crop_area and exist a crop_area defined (click in shadow area)
	// reset the selection and set as no area selected
	// stop to create new crop area (as reset)
	if( self.crop_area?.width && self.crop_area.width > 0 ){
		self.reset_selection()
		return;
	}

	// get the container node area and calculate the click mouse position inside the node
	// it will be the starting point
	const rect = self.nodes.container.getBoundingClientRect();
	self.start_x = e.clientX - rect.left;
	self.start_y = e.clientY - rect.top;

	// create the new crop_selection area with the point of the mouse click
	self.is_selecting = true;
	self.nodes.crop_selection.style.left	= self.start_x + 'px';
	self.nodes.crop_selection.style.top		= self.start_y + 'px';
	self.nodes.crop_selection.style.width	= '0px';
	self.nodes.crop_selection.style.height	= '0px';
	self.nodes.crop_selection.style.display	= 'block';

}//end start_selection


/**
* START_DRAG_OR_RESIZE
* Handles `mousedown` on the crop_selection element to start either a
* whole-box drag or a single-handle resize.
*
* Detection:
* - If `e.target.closest('.resize_handle')` returns a node, resize mode is
*   activated. The handle's compass-point name is read from `classList[1]`
*   (the second CSS class, e.g. 'nw', 'se') and stored in `self.current_handle`.
*   The interaction anchor is the absolute viewport position of the mouse.
* - Otherwise, drag mode is activated. The anchor is computed as the offset
*   of the mouse relative to the top-left corner of the crop_selection box so
*   that dragging does not snap the box origin to the cursor position.
*
* (!) In resize mode, a `rect` variable is declared and assigned but never
*     read. This is a pre-existing condition; do not change the code.
*
* `e.preventDefault()` suppresses text-selection during drag/resize.
*
* @param {MouseEvent} e - The native mousedown event on crop_selection.
* @returns {undefined}
*/
render_tool_image_crop.start_drag_or_resize = function(e) {

	const self = this

	// if the user click close to any handle set as resize
	// else set as drag
	const handle = e.target.closest('.resize_handle');
	if (handle) {
		// Resize mode
		self.is_resizing = true;
		// get the name of the handle by the second parameter of the classList as nw or se
		self.current_handle = handle.classList[1];
		const rect = self.nodes.crop_selection.getBoundingClientRect();
		self.start_x = e.clientX;
		self.start_y = e.clientY;
	} else {
		// Drag mode
		self.is_dragging = true;
		const rect = self.nodes.crop_selection.getBoundingClientRect();
		self.start_x = e.clientX - rect.left;
		self.start_y = e.clientY - rect.top;
	}
	e.preventDefault();

}//end start_drag_or_resize



/**
* HANDLE_MOUSE_MOVE
* Dispatches `mousemove` events on the container to the correct sub-handler
* depending on the current interaction mode.
*
* Exactly one of the three state flags (`is_selecting`, `is_dragging`,
* `is_resizing`) should be true during an active interaction; the first
* matching branch wins.
*
* @param {MouseEvent} e - The native mousemove event fired on the container.
* @returns {undefined}
*/
render_tool_image_crop.handle_mouse_move = function(e) {

	const self = this

	if (self.is_selecting) {
		self.update_selection_size(e);
	} else if (self.is_dragging) {
		self.update_selection_position(e);
	} else if (self.is_resizing) {
		self.update_selection_resize(e);
	}
}//end handle_mouse_move



/**
* UPDATE_SELECTION_SIZE
* Expands or contracts the crop_selection box during rubber-band drawing.
*
* Both width and height are computed as the delta from the fixed anchor
* (`self.start_x/y`) to the current cursor position. Negative deltas
* (user drags left or up) are handled by using `Math.abs` for size and
* switching the origin to `current_x/y` instead of the anchor, keeping
* the box visually correct regardless of drag direction.
*
* Calls `update_crop_area()` after every move to keep `self.crop_area` in
* sync with the displayed box.
*
* @param {MouseEvent} e - The native mousemove event from `handle_mouse_move`.
* @returns {undefined}
*/
render_tool_image_crop.update_selection_size = function(e) {

	const self = this

	const rect		= self.nodes.container.getBoundingClientRect();
	const current_x	= e.clientX - rect.left;
	const current_y	= e.clientY - rect.top;

	const width		= current_x - self.start_x;
	const height	= current_y - self.start_y;

	self.nodes.crop_selection.style.width	= Math.abs(width) + 'px';
	self.nodes.crop_selection.style.height	= Math.abs(height) + 'px';
	self.nodes.crop_selection.style.left	= (width > 0 ? self.start_x : current_x) + 'px';
	self.nodes.crop_selection.style.top		= (height > 0 ? self.start_y : current_y) + 'px';

	self.update_crop_area();
}//end update_selection_size



/**
* UPDATE_SELECTION_POSITION
* Moves the whole crop_selection box during a drag operation.
*
* The target position is the current cursor position minus the drag offset
* captured in `start_drag_or_resize` (`self.start_x/y`), so the box
* follows the cursor from the point where the drag started rather than
* snapping its origin to the cursor.
*
* The position is clamped so the box cannot be dragged outside the container:
*  - left  : [0, container.width  - box.width]
*  - top   : [0, container.height - box.height]
*
* Calls `update_crop_area()` after every move to keep `self.crop_area` in sync.
*
* @param {MouseEvent} e - The native mousemove event from `handle_mouse_move`.
* @returns {undefined}
*/
render_tool_image_crop.update_selection_position = function(e) {

	const self = this

	const rect		= self.nodes.container.getBoundingClientRect();
	const current_x	= e.clientX - rect.left - self.start_x;
	const current_y	= e.clientY - rect.top - self.start_y;

	const max_x = self.nodes.container.clientWidth - self.nodes.crop_selection.clientWidth;
	const max_y = self.nodes.container.clientHeight - self.nodes.crop_selection.clientHeight;

	self.nodes.crop_selection.style.left	= Math.max(0, Math.min(current_x, max_x)) + 'px';
	self.nodes.crop_selection.style.top		= Math.max(0, Math.min(current_y, max_y)) + 'px';

	self.update_crop_area();

}// end update_selection_position


/**
* UPDATE_SELECTION_RESIZE
* Adjusts the crop_selection box geometry when the user drags one of the
* eight compass-point resize handles.
*
* For each handle the geometry update is:
*  - Corner handles (nw, ne, sw, se): both width/height and one or two
*    origin axes change.
*  - Edge handles (n, s, w, e): only the relevant dimension and, if the
*    leading edge, its corresponding origin axis change.
*
* After computing the new geometry, position and size are clamped so the box
* stays within the container. A minimum size of 10×10 px is enforced to
* prevent collapsing the selection to zero.
*
* Calls `update_crop_area()` to keep `self.crop_area` in natural-pixel
* coordinates in sync after every mousemove.
*
* @param {MouseEvent} e - The native mousemove event from `handle_mouse_move`.
* @returns {undefined}
*/
render_tool_image_crop.update_selection_resize = function(e) {

	const self = this

	const rect		= self.nodes.container.getBoundingClientRect();
	const current_x	= e.clientX - rect.left;
	const current_y	= e.clientY - rect.top;

	const selection_rect	= self.nodes.crop_selection.getBoundingClientRect();
	const box_x				= selection_rect.left - rect.left;
	const box_y				= selection_rect.top - rect.top;
	const box_width			= selection_rect.width;
	const box_height		= selection_rect.height;

	let new_x		= box_x;
	let new_y		= box_y;
	let new_width	= box_width;
	let new_height	= box_height;

	switch(self.current_handle) {
		case 'nw':
			new_width	= box_width + (box_x - current_x);
			new_height	= box_height + (box_y - current_y);
			new_x		= current_x;
			new_y		= current_y;
			break;
		case 'ne':
			new_width	= current_x - box_x;
			new_height	= box_height + (box_y - current_y);
			new_y		= current_y;
			break;
		case 'sw':
			new_width	= box_width + (box_x - current_x);
			new_height	= current_y - box_y;
			new_x		= current_x;
			break;
		case 'se':
			new_width	= current_x - box_x;
			new_height	= current_y - box_y;
			break;
		case 'n':
			new_height	= box_height + (box_y - current_y);
			new_y		= current_y;
			break;
		case 's':
			new_height 	= current_y - box_y;
			break;
		case 'w':
			new_width	= box_width + (box_x - current_x);
			new_x		= current_x;
			break;
		case 'e':
			new_width 	= current_x - box_x;
			break;
	}

	// Constrain to self.nodes.container
	new_x		= Math.max(0, new_x);
	new_y		= Math.max(0, new_y);
	new_width	= Math.min(new_width, self.nodes.container.clientWidth - new_x);
	new_height	= Math.min(new_height, self.nodes.container.clientHeight - new_y);

	if (new_width > 10 && new_height > 10) {
		self.nodes.crop_selection.style.left	= new_x 		+ 'px';
		self.nodes.crop_selection.style.top		= new_y 		+ 'px';
		self.nodes.crop_selection.style.width	= new_width 	+ 'px';
		self.nodes.crop_selection.style.height	= new_height 	+ 'px';
	}

	self.update_crop_area();

}//end update_selection_resize




/**
* UPDATE_CROP_AREA
* Converts the current CSS position and size of the crop_selection box from
* display pixels to natural (original-resolution) image pixels and stores the
* result in `self.crop_area`.
*
* The display-to-natural scale factors are computed as:
*   scale_x = image.naturalWidth  / image.clientWidth
*   scale_y = image.naturalHeight / image.clientHeight
*
* These factors correct for any CSS scaling applied to the `<img>` element.
* All four coordinates are rounded to integer pixels before being stored.
*
* `self.crop_area` shape:
* {
*   x      : {number} left edge in natural pixels
*   y      : {number} top  edge in natural pixels
*   width  : {number} width  in natural pixels
*   height : {number} height in natural pixels
* }
*
* The status_container is updated with a human-readable summary after each
* recalculation, giving the user live coordinate feedback.
*
* This value is read by `tool_image_rotation.prototype.apply_rotation` via
* `render_tool_image_crop.crop_area` and sent to the PHP server API.
*
* @returns {undefined}
*/
render_tool_image_crop.update_crop_area = function() {

	const self = this

	const left		= parseInt(self.nodes.crop_selection.style.left);
	const top		= parseInt(self.nodes.crop_selection.style.top);
	const width		= parseInt(self.nodes.crop_selection.style.width);
	const height	= parseInt(self.nodes.crop_selection.style.height);

	const scale_x = self.natural_width / self.nodes.image.clientWidth;
	const scale_y = self.natural_height / self.nodes.image.clientHeight;

	self.crop_area = {
		x		: Math.round(left * scale_x),
		y		: Math.round(top * scale_y),
		width	: Math.round(width * scale_x),
		height	: Math.round(height * scale_y),
	}

	self.nodes.status_container.textContent = `
		x: ${self.crop_area.x}, y: ${self.crop_area.y} | ${self.crop_area.width}x${self.crop_area.height}
	`;

}//end update_crop_area



/**
* RESET_SELECTION
* Hides the crop_selection overlay and clears the stored crop_area.
*
* Uses optional chaining (`?.`) on `self.nodes` so this method is safe to
* call before `build()` has completed or after partial initialisation.
*
* Sets `self.crop_area` to `null` (not an empty object) to signal "no active
* selection" — callers such as `apply_rotation` check for null before
* including crop coordinates in the API request.
*
* @returns {undefined}
*/
render_tool_image_crop.reset_selection = function() {

	const self = this

	if(self.nodes?.crop_selection){
		self.nodes.crop_selection.style.display	= 'none';
	}
	if(self.nodes?.status_container){
		self.nodes.status_container.textContent	= '';
	}

	self.crop_area = null

}// end reset_selection




