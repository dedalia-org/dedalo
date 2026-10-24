// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label,  SHOW_DEBUG, DEDALO_ROOT_WEB, svgcanvas, iro */
/*eslint no-undef: "error"*/



// imports
	import SvgCanvas from '../../../lib/svgedit/dist/svgcanvas.js'
	import '../../../lib/iro/dist/iro.min.js';
	import {ui} from '../../common/js/ui.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {clone} from '../../common/js/utils/index.js'



/**
* VECTOR_EDITOR
* SVG-based vector drawing overlay for component_image.
*
* Wraps the third-party SvgCanvas (SVG-Edit) library to provide a
* multi-layer vector annotation editor on top of a raster image.
* The editor is initialised once per component_image instance via
* init_canvas() and holds:
*   - A named-layer stack (ar_layers) where layer_id 0 is always the
*     immutable raster base and higher ids are freely deletable vector layers.
*   - An iro.js colour picker that drives both the active fill and the
*     per-element fill/opacity on the live SVG stage.
*   - A keyboard shortcut registry (this.shortcuts) populated before the
*     SvgCanvas 'extensions_added' event fires.
*
* Data is persisted back to component_image via save_data(), which
* serialises each layer's SVG children as JSON and writes the result to
* self.data.changed_data before delegating to component_common.change_value().
*
* Typical lifecycle:
*   1. component_image instantiates vector_editor and calls init_canvas(self).
*   2. init_canvas() creates the SvgCanvas, loads existing lib_data, binds
*      events, and renders the tool palette via render_tools_buttons(self).
*   3. The user draws shapes, switches layers, and eventually clicks Save.
*   4. save_data(self) serialises all layers and calls self.change_value().
*
* @returns {boolean} true — constructor sentinel used by the prototype chain
*/
export const vector_editor = function() {

	this.id

	this.stage = null
	// svgcanvas vars
	this.active_layer			= null
	this.active_fill_color		= '#ffffff'
	this.active_opacity			= 0.3
	this.button_color_picker	= null
	this.selected_element		= null
	// Descriptors of layers removed by an undoable action, keyed by layer name.
	// Undo restores the DOM layer; this restores its data descriptor with it.
	this._layer_snapshots		= new Map()
	// The owning component_image instance (set in init_canvas).
	this.component				= null
	// true while undo/redo is applying a command (skip history compaction)
	this._history_applying		= false
	this.shortcuts = [
		// Shortcuts not associated with buttons
		{ key: ['meta+z/ctrl+z', true], fn: () => { this.undo() } },
		{ key: ['shift+meta+z/shift+ctrl+z', true], fn: () => { this.redo() } },
		{ key: ['ctrl+y', true], fn: () => { this.redo() } },
		{ key: 'tab', fn: () => { this.stage.cycleElement(0) } },
		{ key: 'shift+tab', fn: () => { this.stage.cycleElement(1) } },
		{
			key: ['delete/backspace', true],
			fn: () => {
				const stage = this.stage
				// A multi-selection leaves selected_element null (this.multiselected
				// was never set), so gate on the stage selection instead.
				if (stage.getSelectedElements().length === 0) {
					return
				}
				// The raster <image> is the photograph, not an annotation: the
				// raster layer's trash button resets/restores it. Deleting it here
				// would persist a layer_0 with no background.
				const base_image = this.image_definition?.image_node
				if (base_image) {
					stage.removeFromSelection([base_image])
				}
				if (stage.getSelectedElements().filter(Boolean).length > 0) {
					stage.deleteSelectedElements()
				}
			}
		},
		{ key: 'a', fn: () => { this.stage.selectAllInCurrentLayer() } },
		{ key: 'alt+a', fn: () => { this.stage.selectAllInCurrentLayer() } },
		{ key: 'alt+x', fn: () => { this.cutSelected() } },
		{ key: 'alt+c', fn: () => { this.copySelected() } },
		{ key: 'alt+v', fn: () => { this.pasteInCenter() } }
	]


	return true
}//end component_image



/**
* INIT_CANVAS
* Bootstrap the SVG vector editor inside the given component_image instance.
*
* Steps performed:
*   1. Sizes the svg_canvas div to the full screen so users can scroll/zoom freely.
*   2. Reads the original image URL and dimensions from the DOM image node that
*      component_image has already rendered (object_node), then removes that node so
*      the SVG canvas occupies the same position.
*   3. Creates a SvgCanvas instance (third-party, lib/svgedit/) with default fill,
*      stroke, text and dimension settings derived from the image size.
*   4. Binds SvgCanvas events: 'selected' → selected_changed, 'extensions_added' →
*      keyboard_shortcuts, 'zoomed' → zoom_changed, 'exported' → export_handler.
*   5. Attaches document-level 'paste' and 'copy' listeners.
*      (!) The 'copy' handler references an undefined `project` variable — it is
*      currently dead/broken code left from a Paper.js migration.
*   6. Calls load_data(self) to hydrate the stage from existing layer data stored in
*      component_image's lib_data.
*   7. Calls update_canvas() to scale the stage to fit the container, then
*      render_tools_buttons(self) to build the tool palette.
*   8. Subscribes to the 'full_screen_<id>' event so the canvas reflows on
*      full-screen toggle.
*
* @param {Object} self - The owning component_image instance. Must expose:
*   self.image_container {HTMLElement}, self.events_tokens {Array},
*   self.id {string}, self.vector_editor_tools {HTMLElement|falsy}
* @returns {Promise<boolean>} Resolves true when the stage is fully ready.
*/
vector_editor.prototype.init_canvas = async function(self) {

	// owning component: undo/redo must reconcile its ar_layers with the drawing
		this.component				= self

	// init with the DOM image_container (work_area)
	// get his size
		this.image_container			= self.image_container
		// const image_container_size	= image_container.getBoundingClientRect()
		// active_editor set style
		this.image_container.classList.add('active_editor')

	// init a empty canvas to be used to test if the browser support it

		ui.create_dom_element({
			element_type	: 'canvas',
			parent 			: this.image_container.parentNode
		})

	// initial image node
	// the image node will be deleted when konva will initiated
	// get the image size and the source (see it in view_xxxx)
	// calculate the ratio of the image, it will be fixed when is resized
		const object_node	= this.image_container.object_node
		const image_size	= object_node.getBoundingClientRect()
		const image_url		= object_node.url
		const image_ratio	= image_size.width / image_size.height

	// initial svg_canvas node
		const svg_canvas = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'svg_canvas',
			parent 			: this.image_container
		})
		// set the size of the node to the user screen (the max space to be used to work)
		svg_canvas.style.width	= window.screen.width +'px'
		svg_canvas.style.height	= window.screen.height +'px'

		this.svg_canvas			= svg_canvas
		const svg_canvas_size	= svg_canvas.getBoundingClientRect()

	// image definition
	// store the image size and source to update the image when is changed
		const image_definition = {
			src			: image_url,
			width		: image_size.width,
			height		: image_size.height,
			// SVG user units of the authored raster. width/height above are
			// overwritten by update_canvas() with the container size; these keep
			// the raster's real geometry for a reset_raster() rebuild.
			user_width	: image_size.width,
			user_height	: image_size.height,
			image_ratio	: image_size.width / image_size.height,
			image_node	: null,
		}
		this.image_definition = image_definition

		const config = {
			initFill	: { color: 'FFFFFF', opacity: 1 },
			initStroke	: { color: '000000', opacity: 1, width: 1 },
			text		: { stroke_width: 0, font_size: 24, font_family: 'serif' },
			initOpacity	: 1,
			imgPath		: '../themes/default/icons',
			dimensions	: [ image_definition.width, image_definition.height ],
			baseUnit	: 'px'
		}

	// SvgCanvas
	// create the SvgCanvas instance
		const stage = new SvgCanvas( svg_canvas, config)
		stage.updateCanvas(svg_canvas_size.width, svg_canvas_size.height)

		this.stage = stage

	// set the segment type to be square
		stage.setSegType(4)
	// set the color
		stage.setColor('fill', this.active_fill_color)

	// Events listeners
	// bind the selected event to our function that handles updates to the UI
		this.stage.bind('selected', this.selected_changed.bind(this))
		// this.stage.bind('mouseMove', this.element_transition.bind(this))
		this.stage.bind('extensions_added', this.keyboard_shortcuts.bind(this))
		this.stage.bind('zoomed', this.zoom_changed.bind(this))
		this.stage.call('extensions_added')
		this.stage.bind('exported', this.export_handler.bind(this));
		// this.stage.bind('changed', this.changed.bind(this));

	// paste event. Paste svg clipboard to active layer
		document.addEventListener('paste', fn_paste)
		function fn_paste(event) {
			// get the clipboard data
			const clipboard = event.clipboardData.getData('text/plain')
			// check if the clipboard is a svg data
			if ( clipboard.indexOf('<svg version="')!==-1 ) {

				// const pasted_svg = self.current_paper.project.importSVG( clipboard )
				// pasted_svg.clipped = true;

				// optional: remove the clipped path
					// pasted_svg.clipped = false;
					// pasted_svg.children[0].remove()
					// pasted_svg.parent.insertChildren(pasted_svg.index,pasted_svg.removeChildren());
					// pasted_svg.remove();
			}
		}

	// copy event
		document.addEventListener('copy', fn_copy)
		function fn_copy(event) {
			// copy the current canvas svg to the clipboard.
			// Use the SvgCanvas API (stage.getSvgString) — the previous code referenced
			// an undefined `project` (paper.js leftover) and threw a ReferenceError on
			// every copy after already calling preventDefault (breaking native copy too).
			const project_svg = (stage && typeof stage.getSvgString==='function')
				? stage.getSvgString()
				: null
			if (!project_svg) {
				// nothing to copy from the editor; let the native copy proceed
				return
			}
			event.preventDefault();
			if (event.clipboardData) {
				event.clipboardData.setData('text/plain', project_svg);
			} else if (window.clipboardData) {
				window.clipboardData.setData('Text', project_svg);
			}
		};

	// store the document-level handlers so destroy() can remove them (avoids
	// accumulating copy/paste listeners across record navigation).
		this._document_handlers = this._document_handlers || []
		this._document_handlers.push(
			{ type:'paste', handler:fn_paste },
			{ type:'copy', handler:fn_copy }
		)

	// create the main layer
	// main layer is the layer that define the area to be cropped.
	// // add the layer to the stage
	// 	this.stage.add(main_layer);
		// object_node.classList.add('hide')
		object_node.remove();

	// load data
		this.load_data(self)

	// hydration is NOT user history: load_data renames the default layer to
	// layer_0 through the history-recording stage wrapper, and undoing that
	// rename would turn the raster layer into 'Layer 1' and break save_data.
		this.stage.undoMgr.resetUndoStack()
	// drop the transient opacity changes the library records before inserting a
	// new shape, so one draw is one undo
		this.stage.bind('changed', this.compact_history.bind(this))

	// update canvas to fit it into the space
		this.update_canvas();

	// init the the interface
		this.render_tools_buttons(self);

	// subscription to the full_screen change event
		const full_screen_handler = () => {
			this.update_canvas()
		}
		self.events_tokens.push(
			event_manager.subscribe('full_screen_'+self.id,  full_screen_handler)
		)


	return true
}//end init_canvas



/**
* SELECTED_CHANGED
* Called by the SvgCanvas 'selected' event when the user selects one or more
* SVG elements on the canvas.
*
* Updates this.selected_element to the single selected element (null when
* multiple elements are selected simultaneously) and then synchronises the
* colour-picker button to reflect the selected element's fill colour via
* set_color_picker().
*
* @param {Window} win - The host window reference forwarded by SvgCanvas.
* @param {Array<SVGElement>} elems - Array of currently selected SVG elements.
*   An empty second slot (elems[1] falsy) indicates a single-element selection.
* @returns {void}
* @listens module:svgcanvas.SvgCanvas#event:selected
* @fires module:svgcanvas.SvgCanvas#event:ext_selectedChanged
*/
vector_editor.prototype.selected_changed = function(win, elems) {

	const stage	= this.stage
	const layer	= this.active_layer
	this.selected_element = elems.length === 1 || !elems[1] ? elems[0] : null

	this.set_color_picker()
	// const path = stage.getPathObj()

	// const drawnPath = stage.getDrawnPath()

	// if(drawnPath){
	// 	const seglist = drawnPath.pathSegList
	// 	console.log("seglist:",seglist);
	// }

	// const current_mode = stage.getMode()

	// if(current_mode==='pathedit'){
	// 	const path_actions = stage.pathActions

	// 	const node_point = path_actions.getNodePoint()
	// 	document.onkeydown = function(e) {
	// 		if (e.altKey) {
	// 			path_actions.linkControlPoints(true)
	// 			console.log("linkControlPoints:---true");
	// 		}else{
	// 			path_actions.linkControlPoints(false)
	// 			console.log("inkControlPoints:---false:");
	// 		}
	// 	}



	// }

	// 	console.log("current_mode:",current_mode);

	// 	console.log("stage.pathActions:",stage.pathActions);


	// const point = path
	// 	? path.pathActionsMethod.getNodePoint()
	// 	: null
		// console.log("stage.getSegType():",stage.setSegType());
		// console.log("path:",stage.getSegData());
}//end selected_changed



/**
* ELEMENT_TRANSITION
* Handles mouse-move events on the canvas while in path-edit mode.
*
* Intended to be bound to the SvgCanvas 'mouseMove' event (currently commented
* out in init_canvas). When in 'pathedit' mode it wires a keydown listener that
* toggles SvgCanvas linkControlPoints() on/off as the user holds Alt.
*
* (!) This method is not currently connected — the bind call in init_canvas is
* commented out. The local `seglist` and `node_point` variables are declared but
* never read. Left for future path-editing feature work.
*
* @param {Window} win - Host window reference forwarded by SvgCanvas.
* @param {Array<SVGElement>} elems - Elements under the cursor (forwarded by SvgCanvas).
* @returns {void}
*/
vector_editor.prototype.element_transition = function(win, elems) {

	const stage	= this.stage
	const layer	= this.active_layer

	const path = stage.getPathObj()

	const drawnPath = stage.getDrawnPath()

	if(drawnPath){
		const seglist = drawnPath.pathSegList
	}

	const current_mode = stage.getMode()

	if(current_mode==='pathedit'){
		const path_actions = stage.pathActions

		const node_point = path_actions.getNodePoint()
		document.onkeydown = function(e) {
			if (e.altKey) {
				path_actions.linkControlPoints(true)
				console.log("linkControlPoints:---true");
			}else{
				path_actions.linkControlPoints(false)
				console.log("inkControlPoints:---false:");
			}
		}
	}

	// const point = path
	// 	? path.pathActionsMethod.getNodePoint()
	// 	: null
		// console.log("stage.getSegType():",stage.setSegType());
		// console.log("path:",stage.getSegData());
}//end element_transition



/**
* KEYBOARD_SHORTCUTS
* Registers the vector editor's keyboard shortcuts with the document.
*
* Called once when the SvgCanvas fires the 'extensions_added' event, which
* signals that all internal extensions are ready. The method builds a flat
* key→handler map from this.shortcuts (populated in the constructor), then
* attaches a single 'keydown' listener on document.
*
* Key format normalisation: modifier prefix order is
*   alt+ → shift+ → meta+ → ctrl+ → lowercase key name.
* Text fields (INPUT, TEXTAREA, contentEditable) are never intercepted; keys
* from other page controls are ignored except Delete/Backspace and undo/redo,
* which act on the canvas, so the quality selector (or any other control) cannot
* make Delete silently do nothing. Undo is Cmd+Z / Ctrl+Z; redo is
* Shift+Cmd+Z / Ctrl+Shift+Z, plus Ctrl+Y on Windows.
*
* Shortcut entries support a two-element array form:
*   [keyString, preventDefault] e.g. ['delete/backspace', true]
* The '/' separator allows a single handler to cover two physical keys.
*
* (!) The original baseline carried @param and @listens/@fires annotations
* copied from the SvgCanvas 'selected' event handler — they do not match
* this function, which takes no arguments and listens to 'extensions_added'.
* Those misleading tags have been removed; the function signature is definitive.
*
* @returns {void}
* @listens module:svgcanvas.SvgCanvas#event:extensions_added
*/
vector_editor.prototype.keyboard_shortcuts = function() {

	// guard: this is fired via stage.call('extensions_added'); register the document
	// keydown listener only once per instance to avoid duplicate shortcut handlers.
	if (this.extensionsAdded===true) {
		return
	}
	this.extensionsAdded = true

	const key_handler = {} // will contain the action for each pressed key

	this.shortcuts.forEach(shortcut => {
		// Bind function to shortcut key
		if (shortcut.key) {
			// Set shortcut based on options
			let key_value = shortcut.key
			let pd = false
			if (Array.isArray(shortcut.key)) {
				key_value = shortcut.key[0]
				if (shortcut.key.length > 1) {
					pd = shortcut.key[1]
				}
			}
			key_value = String(key_value)
			const { fn } = shortcut
			key_value.split('/').forEach(key => {
				key_handler[key] = { fn, pd }
			})
		}
		return true
	})
	// register the keydown event
	const keydown_handler = (e) => {

		// never steal keys from a field the user is typing in
		const target		= e.target
		const tag_name		= target?.nodeName
		const is_editable	= tag_name==='INPUT' || tag_name==='TEXTAREA' || target?.isContentEditable===true
		if (is_editable) return

		// normalize key
		const key = `${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.metaKey ? 'meta+' : ''}${e.ctrlKey ? 'ctrl+' : ''}${e.key.toLowerCase()}`

		// return if no shortcut defined for this key
		if (!key_handler[key]) return
		// non-destructive shortcuts (tab, a, paste…) only from the page surface:
		// they must not hijack navigation while focus sits on a page control.
		// Delete and undo/redo are allowed from any non-editable target: after
		// using the image quality <select> (or any other control) focus stays
		// there, and the user still expects Delete/undo to act on the canvas.
		const is_delete = key==='delete' || key==='backspace'
		const is_history = key==='meta+z' || key==='ctrl+z'
			|| key==='shift+meta+z' || key==='shift+ctrl+z' || key==='ctrl+y'
		if (tag_name!=='BODY' && !is_delete && !is_history) return
		// launch associated handler and preventDefault if necessary

		key_handler[key].fn()

		if (key_handler[key].pd) {
			e.preventDefault()
		}
	}
	document.addEventListener('keydown', keydown_handler)

	// store for teardown in destroy()
	this._document_handlers = this._document_handlers || []
	this._document_handlers.push({ type:'keydown', handler:keydown_handler })
}//end keyboard_shortcuts



/**
* POINTER
* Activates the SvgCanvas select/pointer mode and auto-converts the currently
* selected non-path shape to a path.
*
* SVG shapes like rect and ellipse cannot be edited at the node level while
* they remain native SVG shape elements. This method calls
* stage.convertToPath() to promote them to <path> elements so the user can
* immediately edit individual nodes after switching to the pointer tool.
*
* (!) convertToPath() must only be applied once per element. Calling it a
* second time on an element that is already a <path> can disconnect control
* points. The guard on element_name covers known safe types: image, text,
* path, g, and use.
*
* @returns {boolean} true — implicit end-of-function sentinel; the stage
*   mutation is a side effect.
*/
vector_editor.prototype.pointer = function() {

	const stage		= this.stage
	const layer		= this.active_layer

	stage.setMode('select')

	const selected_element	= stage.getSelectedElements()[0]

	// when the pointer is selected check if has some selected
	// to check if the element need to be converted to path
	if(selected_element){
		// get the element name to check if other than a path
		// if yes (rec, ellipse, etc) need to be converted as path
		// IMPORTANT; apple only one, convertToPath() method can disconnect control points if is applied twice
		const element_name = selected_element.nodeName
		if( !['image', 'text', 'path', 'g', 'use'].includes(element_name) ){
			stage.convertToPath()
		}
	}
}//end selector



/**
* CREATE_RECTANGLE
* Activates the SvgCanvas rectangle-drawing mode on the current vector layer.
*
* Clears any current selection, sets the fill colour to the active layer's
* colour with 30 % opacity, and switches the stage to 'rect' mode so the next
* drag gesture draws a new rectangle.
*
* Drawing is blocked on the raster layer (layer_id === 0) because that layer
* is reserved exclusively for the background image. Returns false without
* changing the stage mode when blocked.
*
* @returns {boolean|undefined} false when the raster layer is active; otherwise
*   returns undefined (implicit void — the draw-mode activation is a side effect).
*/
vector_editor.prototype.create_rectangle = function () {

	const stage	= this.stage
	const layer	= this.active_layer

	// deselection any other selected
	stage.clearSelection()

	// control to draw in any other layer than raster
	// raster layer can only content image
	if(layer.layer_id===0){
		return false
	}
	// get the layer color and add transparency
	// set the color to draw new rectangle
	stage.setColor('fill', layer.layer_color)
	stage.setOpacity(0.3)

	stage.setMode('rect')
}//end create_rectangle



/**
* CREATE_CIRCLE
* Activates the SvgCanvas ellipse-drawing mode on the current vector layer.
*
* Clears any current selection, applies the active layer's colour at 30 %
* opacity, and switches the stage to 'ellipse' mode so the next drag gesture
* draws a new circle or ellipse.
*
* Unlike create_rectangle(), this method does not guard against the raster
* layer — callers are responsible for ensuring a vector layer is active before
* invoking this tool.
*
* @returns {void}
*/
vector_editor.prototype.create_circle = function () {

	const stage			= this.stage
	const layer			= this.active_layer

	// deselection any other selected
	stage.clearSelection()

	// get the layer color and add transparency
	// set the color to draw new rectangle
	stage.setColor('fill', layer.layer_color)
	stage.setOpacity(0.3)

	stage.setMode('ellipse')
}//end create_circle



/**
* CREATE_VECTOR
* Activates the SvgCanvas freehand path-drawing mode on the current vector layer.
*
* Clears any current selection, applies the active layer's colour at 30 %
* opacity, and switches the stage to 'path' mode for Bezier/poly-line drawing.
*
* The large block of commented-out code below the mode switch is residual
* exploration of path-editing APIs (getNodePoint, linkControlPoints, segType).
* It is left in place for reference during future path-edit tooling work.
*
* @returns {void}
*/
vector_editor.prototype.create_vector = function () {

	const stage			= this.stage
	const layer			= this.active_layer

	// deselection any other selected
	stage.clearSelection()

	// get the layer color and add transparency
	// set the color to draw new rectangle
	stage.setColor('fill', layer.layer_color)
	stage.setOpacity(0.3)

	stage.setMode('path')


	// path.linkControlPoints(linked)
	// path.getNodePoint()

	// const point = this.selected_element.getNodePoint()

	// this.click()
	// const segType = $id('seg_type')
// console.log("point:",point);
	 // segType.value = point.type
// 	const path = stage.getPathObj()


//       if (path) {

//       }
// console.log("e:----", this.selected_element);
	  // this.click(element, handler) => {
	  // 	console.log("e:----", e);
	  // }
}//end create_vector



/**
* ACTIVATE_ZOOM
* Activates the SvgCanvas zoom mode.
*
* After activation the user can click or drag on the canvas to zoom in;
* double-clicking the zoom button in render_tools_buttons() resets the zoom
* to 1:1 and reflows the canvas via update_canvas().
*
* @returns {void}
*/
vector_editor.prototype.activate_zoom = function () {

	const stage = this.stage
	stage.setMode('zoom');
}//end activate_zoom



/**
* ZOOM_CHANGED
* Handles the SvgCanvas 'zoomed' event and reflows the scroll container.
*
* Computes the new canvas dimensions by asking SvgCanvas to fit the
* selected bounding-box (bbox) into the visible area, then expands
* the image_container element to match the enlarged canvas so the browser
* scrollbar appears correctly. Finally it centres the scroll viewport on
* the zoomed bounding box centre.
*
* The zoomlevel is clamped to 0.1 when setBBoxZoom() returns a value
* below 0.001 to prevent near-zero scale rendering artifacts.
*
* @param {Window} win - Host window reference forwarded by SvgCanvas.
* @param {Object} bbox - Bounding box descriptor forwarded by SvgCanvas
*   (fields: x, y, width, height, zoom — exact shape is library-defined).
* @param {boolean} autoCenter - Whether SvgCanvas requests automatic
*   centring (forwarded; not currently used locally).
* @returns {void}
* @listens module:svgcanvas.SvgCanvas#event:zoomed
*/
vector_editor.prototype.zoom_changed = function(win, bbox, autoCenter) {

	const stage					= this.stage
	const image_container		= this.image_container
	const image_container_size	= this.image_container.getBoundingClientRect()
	const svg_canvas_size		= this.svg_canvas.getBoundingClientRect()

	// const w = parseFloat(getComputedStyle(image_container, null).width.replace('px', ''))
	// const h = parseFloat(getComputedStyle(image_container, null).height.replace('px', ''))

	const w = image_container_size.width // svg_canvas_size.width
	const h = image_container_size.height // svg_canvas_size.height

	const zInfo = stage.setBBoxZoom( bbox, w, h )
	if (!zInfo) {
		return
	}
	const zoomlevel = ( zInfo.zoom < 0.001 ) ? 0.1 : zInfo.zoom;
	const bb = zInfo.bbox

	const zoom = stage.getZoom()
	const new_w = Math.max(w, stage.contentW * zoom )
	const new_h = Math.max(h, stage.contentH * zoom )

	const offset = stage.updateCanvas( new_w, new_h	)


	this.image_container.style.width = new_w + 'px'
	this.image_container.style.height = new_h + 'px'


	const newCtr = {
		x: bb.x * zoomlevel + (bb.width * zoomlevel) / 2,
		y: bb.y * zoomlevel + (bb.height * zoomlevel) / 2
	}

	newCtr.x += offset.x
	newCtr.y += offset.y

	image_container.scrollLeft	= newCtr.x - w / 2
	image_container.scrollTop	= newCtr.y - h / 2
	image_container.scroll()
}//end zoom_changed



/**
* UPDATE_CANVAS
* Fits the SVG canvas and image to the current image_container dimensions.
*
* Recalculates the correct image width by applying the stored aspect ratio
* (image_definition.image_ratio) to the container's current height, then:
*   1. Clears the SvgCanvas selection (selections do not scale correctly and
*      would appear misaligned after resize).
*   2. Calls stage.setBBoxZoom('canvas', ...) to compute the zoom factor that
*      makes the image fill the available space.
*   3. Calls stage.updateCanvas() twice — first for the image area, then for
*      the larger scroll-area (max of container and zoomed content dimensions).
*   4. Centres the scroll offset so the image appears in the middle of the
*      scroll container.
*
* Called on first render (from init_canvas), on save-button click, and
* whenever the 'full_screen_<id>' event fires.
*
* @returns {void}
*/
vector_editor.prototype.update_canvas = function(){

	const stage	= this.stage
	const zoom	= stage.getZoom()

	const image_definition		= this.image_definition
	const image_ratio			= image_definition.image_ratio

	const image_container_size	= this.image_container.getBoundingClientRect()
	const svg_canvas_size		= this.svg_canvas.getBoundingClientRect()

	// re-calculate the image_contanier size
	// const image_container_size	= image_container.getBoundingClientRect()
	// use the image_ratio to calculate the width in relation to new height and update the image definition
	const width = image_container_size.height * image_ratio
	image_definition.width	= width
	image_definition.height	= image_container_size.height
	// clean the selectors, they will not scaled well
	stage.clearSelection()
	// update the stage to new size
	// set the canvas zoom to fit the new image container size
	stage.setBBoxZoom(
		'canvas',
		image_definition.width,
		image_definition.height
	)
	// update the canvas with the new size (it use the previous zoom to set the canvas content)
	const offset = stage.updateCanvas(
		image_definition.width,
		image_definition.height
	)

	const w = Math.max(svg_canvas_size.width, stage.contentW * zoom )
	const h = Math.max(svg_canvas_size.height, stage.contentH * zoom )

	const scroll_X = w / 2 - image_container_size.width / 2
	const scroll_Y = h / 2 - image_container_size.height / 2

	this.image_container.scrollLeft = scroll_X
	this.image_container.scrollTop = scroll_Y

	stage.updateCanvas(w, h)
}//end update_canvas


/**
* RENDER_TOOLS_BUTTONS
* Builds and mounts the vector editor's tool palette DOM inside
* self.vector_editor_tools.
*
* Creates and wires up the following controls in order:
*   - layer_selector_button: opens a floating layer panel (render_layer_selector).
*     Subscribes to 'active_layer_<id>' so the button label tracks the current layer.
*   - pointer: activates select/pointer mode.
*   - rectangle: activates rectangle-drawing mode.
*   - circle: activates ellipse-drawing mode.
*   - vector: activates freehand path-drawing mode.
*   - zoom: activates zoom mode; double-click resets to 1:1.
*   - save: serialises all layers and persists to the server. Before saving
*     it temporarily switches the displayed image to the default-quality file
*     so the SVG image href stored in lib_data points to the canonical URL,
*     then restores the user's chosen quality afterwards.
*   - button_color_picker: toggles the iro.js colour wheel panel. The picker
*     drives both the active-fill state and the fill/opacity of any currently
*     selected SVG element via stage.setColor() / stage.setOpacity().
*
* The local activate_status() helper manages the 'vector_tool_active' CSS
* class across all registered buttons so only one is visually active at a time.
*
* (!) DEDALO_MEDIA_URL is referenced in the save handler but is not declared
* in the file-level /*global*\/ comment — it relies on the global scope at
* runtime. This is an existing inconsistency; do not change the code.
*
* @param {Object} self - The owning component_image instance.
* @returns {boolean} true on success; returns undefined (early) if
*   self.vector_editor_tools is not available.
*/
vector_editor.prototype.render_tools_buttons = function(self) {

	const stage				= this.stage
	const layer				= this.active_layer
	const image_definition	= this.image_definition

	// check vector_editor_tools
		if (!self.vector_editor_tools) {
			console.error('Error: vector_editor_tools is not available:', self.vector_editor_tools);
			return
		}

	// Tool buttons. Show
		const buttons_container	= self.vector_editor_tools
		buttons_container.classList.remove('hide')

	// vector editor tools
		const buttons = []

			// layer_selector_container
				const layer_selector_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'layer_selector_container',
					parent			: buttons_container
				})
				// undo/redo re-renders this panel when the layer set changes
				this.layer_selector_container = layer_selector_container

			// layer selector
				const layer_selector_button = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button open_layer_selector',
					parent			: buttons_container
				})
				layer_selector_button.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					// clean
					while (layer_selector_container.firstChild) {
						layer_selector_container.removeChild(layer_selector_container.firstChild)
					}

					const layer_selector = this.render_layer_selector(self, this.active_layer)
					if (layer_selector) {
						layer_selector_container.appendChild(layer_selector)
					}

					activate_status(layer_selector_button)
				})
				buttons.push(layer_selector_button)

				const active_layer_handler = (active_layer) => {
					// text, never markup: the layer id comes out of the record's layer data
					layer_selector_button.textContent = active_layer.layer_id
				}
				self.events_tokens.push(
					event_manager.subscribe('active_layer_'+self.id, active_layer_handler)
				)

			// pointer
				const pointer = ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'button pointer',
					parent 			: buttons_container
				})
				pointer.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					this.pointer()
					activate_status(pointer)
				})
				buttons.push(pointer)

			// rectangle
				const rectangle = ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'button rectangle',
					parent 			: buttons_container
				})
				rectangle.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					this.create_rectangle()
					activate_status(rectangle)
				})
				buttons.push(rectangle)

			// circle
				const circle = ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'button circle',
					parent 			: buttons_container
				})
				circle.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					this.create_circle()
					activate_status(circle)
				})
				buttons.push(circle)

			// vector
				const vector = ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'button vector',
					parent 			: buttons_container
				})
				vector.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					this.create_vector()
					activate_status(vector)
				})
				buttons.push(vector)

			// zoom
				const zoom = ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'button tool zoom',
					parent 			: buttons_container
				})
				zoom.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					this.activate_zoom()
					activate_status(zoom)
				})
				zoom.addEventListener('dblclick', (e) =>{
					e.stopPropagation()

					// const resolution	= stage.getResolution()
					const multiplier	= 1
					stage.setCurrentZoom(multiplier)
					// this.updateCanvas(true)
					this.update_canvas()
				})

				// zoom.addEventListener('wheel', (e) =>{

				// })
				buttons.push(zoom)

			// move
				// const move = ui.create_dom_element({
				// 	element_type	: 'span',
				// 	class_name		: 'button tool move',
				// 	parent			: buttons_container
				// })
				// move.addEventListener('mouseup', async () =>{
				// 	// stage.mergeAllLayers();
				// 	const svg_data = stage.getSvgContent()  //getSvgString
				// 	console.log("svg_data:",svg_data);

				// 	const imgType = 'JPEG'
				// 	const quality = parseFloat(1)

				// 	const image = await stage.rasterExport(
				// 		imgType,
				// 		quality,
				// 		'export' //'v6 rsc170 imagen'//this.editor.exportWindowName
				// 	)


				// 	// this.move.activate()
				// 	// activate_status(move)
				// })
				// move.addEventListener('dblclick', () =>{

				// 	const svg_data = stage.getSvgContent()  //getSvgString
				// 		console.log("svg_data:",svg_data);

				// 	// const delta_x	= self.canvas_width /2
				// 	// const delta_y	= self.canvas_height /2
				// })
				// buttons.push(move)

			// save
				const save = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button tool save',
					title			: get_label.save || 'Save',
					parent			: buttons_container
				})
				save.addEventListener('mouseup', async (e) =>{
					e.stopPropagation()

					// clone the actual image source (it could be different of the default quality)
					const original_source = clone(image_definition.src)

					// get the default quality file info and set to the image
					const default_file_info = self.get_default_file_info(0);
					const img_src = DEDALO_MEDIA_URL + default_file_info.file_path
					event_manager.publish('image_quality_change_'+self.id, img_src)
					// close the fullscreen to show full component
					self.node.classList.remove('fullscreen')
					event_manager.publish('full_screen_'+self.id, false)
					// save the layers with the default image quality
					await this.save_data(self)
					// restore the original quality selected
					if(original_source !== img_src){

						event_manager.publish('image_quality_change_'+self.id, original_source)
					}
					activate_status(save)
				})
				buttons.push(save)

			// color_picker
				this.button_color_picker = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button tool button_color_picker',
					parent			: buttons_container
				})
				const color_wheel_contaniner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'hide color_wheel_contaniner',
					parent			: buttons_container
				})
				this.color_picker = new iro.ColorPicker(color_wheel_contaniner, {
					// Set the size of the color picker
					width: 160,
					// Set the initial color to project color
					color: '#f00',
					// color wheel will not fade to black when the lightness decreases.
					wheelLightness: false,
					transparency: true,
					layout: [
						{
							component: iro.ui.Wheel, // can be iro.ui.Box
							options: {
								sliderShape: 'circle'
							}
						},
						{
							component: iro.ui.Slider,
							options: {
								sliderType: 'value' // can also be 'saturation', 'value', 'alpha' or 'kelvin'
							}
						},
						{
							component: iro.ui.Slider,
							options: {
								sliderType: 'alpha'
							}
						},
					]
				})
				this.button_color_picker.addEventListener('mouseup', (e) =>{
					e.stopPropagation()

					color_wheel_contaniner.classList.toggle('hide')

					// apply only when show
					if (!color_wheel_contaniner.classList.contains('hide')) {
						this.color_picker.color.hexString	= this.active_fill_color
						this.color_picker.color.alpha		= this.active_opacity
					}
				})
				// color:change event callback
				// color:change callbacks receive the current color and a changes object
				const color_selected = (color, changes) =>{
					if(this.selected_element !== null){
						stage.setColor('fill', color.hexString)
						stage.setOpacity(color.alpha)
						// stage.setPaint('fill', color.hex8String)
					}
					this.button_color_picker.style.backgroundColor	= color.hexString
					this.button_color_picker.style.opacity			= color.alpha
					// (!) The layer is NOT serialised here: the user must click the
					// save button, which runs vector_editor.prototype.save_data.
					// A commented-out `self.update_draw_data()` sat here until
					// 2026-09-04 (P2-25 / DEAD-02); that method read a bare paper.js
					// `project` global and threw, and it is now deleted.
				}

				// listen to a color picker's color:change event
				this.color_picker.on('color:change', color_selected);

		// change the buttons status: active, inactive
			const activate_status = (button) =>{
				const buttons_lenght = buttons.length
				for (let i = 0; i < buttons_lenght; i++) {
					if (buttons[i].classList.contains('vector_tool_active')) {
						buttons[i].classList.remove('vector_tool_active')
					}
				}
				// button ? button.classList.add('vector_tool_active') : null
				button.classList.add('vector_tool_active')
			}

		// first load activate pointer
			// this.pointer.activate()
			// activate_status(pointer)

	return true
}//end render_tools_buttons



/**
* EXPORT_HANDLER
* Handles the SvgCanvas 'exported' event by opening the exported file in a
* new browser window.
*
* SvgCanvas fires this event after a rasterExport() or SVG export call
* completes. The handler opens (or reuses) the named export window and
* navigates it to the blob URL or data URI provided by the library.
*
* @param {Window} win - Host window reference forwarded by SvgCanvas.
* @param {Object} data - Export result object from SvgCanvas. Expected fields:
*   {string} data.WindowName - Target window name for window.open().
*   {string} [data.bloburl] - Blob URL preferred when available.
*   {string} [data.datauri] - Data URI fallback when bloburl is absent.
*   {Array}  [data.issues] - Any export warnings from the library (not used locally).
* @returns {void}
*/
vector_editor.prototype.export_handler = function(win, data){
	const {
		issues,
		WindowName
	} = data;
   const exportWindow = window.open('', WindowName);
   // window.open returns null when blocked by a popup blocker (export is async and may
   // run outside a direct user gesture); bail instead of throwing on a null window.
   if (!exportWindow) {
	   console.warn('export_handler: popup blocked, could not open export window');
	   return;
   }
   exportWindow.location.href = data.bloburl || data.datauri;
}//end export_handler



/**
* SET_COLOR_PICKER
* Synchronises the colour-picker button and iro.js picker state with the
* currently selected SVG element (or the stage defaults when nothing is selected).
*
* Called from selected_changed() whenever the canvas selection changes.
*
* Reads fill colour and opacity from the selected SVG element's attributes
* (getAttribute('fill') / getAttribute('opacity')). Falls back to the stage's
* global colour/opacity when no element is selected.
*
* Skips colour inspection for 'image' and 'use' elements because they do not
* carry a 'fill' attribute, so reading getAttribute('fill') would return null.
*
* Side effects:
*   - Updates this.active_fill_color and this.active_opacity.
*   - Sets the button_color_picker background-color to the new fill colour.
*   - Pushes the new colour and alpha into this.color_picker (iro.js instance).
*
* @returns {void}
*/
vector_editor.prototype.set_color_picker = function() {

	// stage
		const stage	= this.stage

	// check if the selected element is a image
	// image doesn't has the fill attribute
		const element_name = this.selected_element
			? this.selected_element.nodeName
			: ''
		if( ['image','use'].includes(element_name) ){
			return
		}

	// get the item selected color
		this.active_fill_color = (this.selected_element)
			? this.selected_element.getAttribute('fill')
			: stage.getColor('fill')
		this.active_opacity = (this.selected_element)
			? parseFloat(this.selected_element.getAttribute('opacity'))
			: stage.getOpacity()

		if(this.button_color_picker && this.active_fill_color){
			// set the icon of color picker with the selected path color
				this.button_color_picker.style.backgroundColor = this.active_fill_color
			// set the color picker with the selected path color
				this.color_picker.color.hexString	= this.active_fill_color
				this.color_picker.color.alpha		= this.active_opacity
		}
}//end set_color_picker



/**
* LOAD_DATA
* Hydrates the SvgCanvas stage from the layer data stored in the owning
* component_image instance (self.ar_layers / self.get_lib_data()).
*
* Two code paths:
*
* A) Existing data (lib_data is truthy):
*   Iterates self.ar_layers in order. Layer 0 (raster) maps to the default
*   layer that SvgCanvas creates automatically, renamed to 'layer_0'.
*   Subsequent layers are created via drawing.createLayer(). For each layer,
*   every element in layer_data[] is re-added via stage.addSVGElementsFromJson().
*   When a layer_id 0 element is an 'image', its href is captured back
*   into image_definition so the save process records the correct URL.
*
* B) Empty data (lib_data is falsy — first-time use):
*   Renames the default layer to 'layer_0', sets active_layer to the raster
*   layer descriptor, creates an SVG <image> element positioned at the top-left
*   of the canvas, and wires an onload callback to push the src URL into the
*   SVG element via stage.setHref() once the browser has resolved the image.
*
* After load, this.active_layer always points to the last processed layer
* in path A, or the newly created raster layer in path B.
*
* @param {Object} self - The owning component_image instance. Must expose
*   self.get_lib_data() {Function→Array|null} and self.ar_layers {Array}.
* @returns {boolean} true — the stage mutation is the real side effect.
*/
vector_editor.prototype.load_data = function(self) {

	const stage				= this.stage
	const drawing			= stage.getCurrentDrawing()
	const image_definition 	= this.image_definition

	const lib_data = self.get_lib_data()

	if(lib_data){
		self.ar_layers = lib_data

		const len = self.ar_layers.length
		for (let i = 0; i < len; i++) {
			const current_layer = self.ar_layers[i]

			//Check if the layer is the raster layer,
			// raster layer use the main created layer by the svgcanvas
			// but, rename it as layer_0
			// if not, create new layer to import data
			if(current_layer.layer_id > 0){
				const created_layer = drawing.createLayer(current_layer.name)
				created_layer.id = current_layer.name

			}else{
				stage.renameCurrentLayer('layer_0')
				const image_layer = drawing.getCurrentLayer()
				image_layer.id = current_layer.name
			}
			// data is storage without the layer group ('g' node)
			// only transformations and paths will be loaded
			if(!current_layer.layer_data){
				continue;
			}
			const layer_data_len = current_layer.layer_data.length
			for (let i = 0; i < layer_data_len; i++) {
				const layer_data = current_layer.layer_data[i]
				const element = stage.addSVGElementsFromJson(layer_data)

				if(current_layer.layer_id === 0 && layer_data.element=== 'image'){
					// SVG-Edit 7 exports the link as SVG2 `href`; only legacy data carries
					// xlink:href. Reading xlink alone left src null, and the save handler
					// then "restored" that null into the raster (href="null").
					image_definition.src		= element.getAttribute('href') || element.getAttribute('xlink:href')
					image_definition.image_node	= element
					// the authored size of the raster in SVG user units
					const element_width		= Number.parseFloat(element.getAttribute('width'))
					const element_height	= Number.parseFloat(element.getAttribute('height'))
					if (Number.isFinite(element_width) && element_width > 0) {
						image_definition.user_width = element_width
					}
					if (Number.isFinite(element_height) && element_height > 0) {
						image_definition.user_height = element_height
					}
				}
			}

			this.active_layer = current_layer
		}

	}else{
		//empty data, create new image layer node
		// svgcanvas create a Layer 1 by default, rename it to main
		stage.renameCurrentLayer('layer_0')
		const image_layer = drawing.getCurrentLayer()
		image_layer.id = 'layer_0'

		// this.stage.createLayer()
		this.active_layer = {
			layer_id		: 0,
			layer_data		: null,
			layer_color		: '#ffffff',
			layer_opacity	: 1,
			user_layer_name	: 'raster',
			name 			: 'layer_0',
			visible 		: true
		}


		// image
		// create new image node
		const image_node	= new Image();

		// create the img_elem in the top left position of canvas
		const img_elem = stage.addSVGElementsFromJson({
			element : "image",
			attr : {
				x		: 0,
				y		: 0,
				width	: image_definition.width,
				height	: image_definition.height,
				id		: 'main_image',
				opacity	: 1,
				style	: "pointer-events:inherit",
			}
		});

		image_node.onload = () => {

			// this.stage.setBackground( '#ffffff',image_node.src)

			stage.setHref(img_elem, image_node.src);
			// this.stage.moveSelectedToLayer('main')

		};
		image_node.src				= image_definition.src
		image_definition.image_node	= img_elem
	}

	return true
}//end load_data



/**
* GET_LAST_LAYER_ID
* Returns the highest layer_id currently present in self.ar_layers.
*
* Used by add_layer() to compute the next sequential layer_id. Relies on
* Math.max with spread, so an empty ar_layers array would return -Infinity —
* callers should ensure at least the raster layer (layer_id 0) exists before
* calling this method.
*
* @param {Object} self - The owning component_image instance with ar_layers {Array}.
* @returns {number} The maximum layer_id value found in self.ar_layers.
*/
vector_editor.prototype.get_last_layer_id = function(self) {

	const ar_layer_id	= self.ar_layers.map((item) => item.layer_id)
	const last_layer_id	= Math.max(...ar_layer_id)

	return last_layer_id
}//end get_last_layer_id



/**
* ADD_LAYER
* Creates a new vector layer, registers it in the SvgCanvas drawing, and
* appends it to self.ar_layers.
*
* Assigns the next sequential layer_id (get_last_layer_id() + 1, skipping ids
* kept in an undo snapshot) and generates a random hex colour string for use as
* the default drawing colour of shapes on this layer. The new layer is
* immediately set as active_layer. It is created through `stage.createLayer()`
* (not `drawing.createLayer()`), so the creation is recorded in the canvas undo
* history; `sync_layer_descriptors()` keeps its data descriptor aligned.
*
* The colour is generated with Math.random() and padded to 6 hex digits —
* this can occasionally produce very light or low-contrast colours; no
* contrast check is performed.
*
* @param {Object} self - The owning component_image instance. Must expose
*   self.ar_layers {Array} (mutated in place).
* @returns {Object} new_layer - The newly created layer descriptor:
*   { layer_id {number}, layer_data {null}, layer_color {string},
*     layer_opacity {number}, user_layer_name {string}, name {string},
*     visible {boolean} }
*/
vector_editor.prototype.add_layer = function(self) {

	const stage				= this.stage
	const drawing			= stage.getCurrentDrawing()

	// set the layer data. Skip ids kept in an undo snapshot: restoring a deleted
	// layer must not collide with a layer added after the delete.
		const last_layer_id	= this.get_last_layer_id(self)
		const reserved_ids	= new Set(
			[...this._layer_snapshots.keys()]
				.map(name => Number.parseInt(name.replace('layer_', ''), 10))
				.filter(Number.isFinite)
		)
		let layer_id		= last_layer_id + 1
		while (reserved_ids.has(layer_id)) {
			layer_id++
		}

		const layer_name	= 'layer_' + layer_id

	// create a new layer color for selectors and handlers
		const layer_color = Math.floor(Math.random()*16777215).toString(16).padStart(6, "0");

	// create a new layer and add to the ar_layers array and set as active layer
		const new_layer = {
			layer_id		: layer_id,
			layer_data		: null,
			layer_color		: '#'+layer_color,
			layer_opacity 	: 0.3,
			user_layer_name	: layer_name,
			name 			: layer_name,
			visible 		: true
		}
		// the STAGE wrapper (not drawing.createLayer) records a Create Layer
		// command, so the layer add is undoable. It clears the selection itself.
		stage.createLayer(layer_name)
		const created_layer = drawing.getCurrentLayer()
		if (created_layer) {
			created_layer.id = layer_name
		}

		self.ar_layers.push(new_layer)
		this.active_layer = new_layer
		if (self.id) {
			event_manager.publish('active_layer_'+self.id, new_layer)
		}

	return new_layer
}//end add_layer



/**
* SAVE_DATA
* Serialises all SvgCanvas layers to JSON and persists them via
* component_common.change_value().
*
* For each layer in the SvgCanvas drawing:
*   1. Retrieves the underlying SVG <g> element (group_).
*   2. Converts it to a JSON structure via stage.getJsonFromSvgElements().
*   3. Strips <title> children (they are internal SvgCanvas metadata, not
*      user data, and will be regenerated on load).
*   4. Writes the resulting array back to the matching entry in self.ar_layers.
*
* After layer serialisation, builds a changed_data envelope:
*   { action: 'update', id: <entry_id|null>, value: { lib_data, svg_file_data } }
* and calls self.change_value() with refresh: false so the component does not
* re-render (the vector editor stays open after saving).
*
* The SVG string (svg_file_data) is stored alongside lib_data as a convenience
* for diffusion / export pipelines that need raw SVG.
*
* @param {Object} self - The owning component_image instance. Must expose:
*   self.data.entries {Array}, self.ar_layers {Array},
*   self.change_value {Function}.
* @returns {Promise<*>} Resolves with the return value of self.change_value().
*/
vector_editor.prototype.save_data = async function(self) {

	const stage		= this.stage
	const drawing	= stage.getCurrentDrawing();

	const all_layers = drawing.all_layers

	for (let i = 0; i < all_layers.length; i++) {

		// get the group of the layer, it's a 'g' node
		// and get the JSON format of this
		const group = all_layers[i].group_
		const json = stage.getJsonFromSvgElements(group)

		const layer_id = all_layers[i].name_
		const current_layer = self.ar_layers.find(item => item.name===layer_id)
		if (!current_layer) {
			// a drawing layer with no data descriptor (legacy/diverged state):
			// skipping beats crashing the save button on `undefined`
			continue
		}
		// remove the layer definition and all title nodes
		// get only the elements, all layer info will be recreated in load process
		current_layer.layer_data = json.children.filter(el => el.element !== 'title')
	}

	// update the data in the instance previous to save
	const entries =  typeof(self.data.entries[0])!=='undefined'
		? clone(self.data.entries[0])
		: {}
	entries.lib_data		= self.ar_layers
	entries.svg_file_data	= stage.getSvgString()

	// set the changed_data for update the component data and send it to the server for change when save
		const changed_data = {
			action	: 'update',
			id		: entries?.id || null,
			value	: entries
		}

	// set the change_data to the instance
		self.data.changed_data = changed_data

	return self.change_value({
		changed_data	: [changed_data],
		refresh			: false
	})
}//end save_data



/**
* RESET_RASTER
* Empties the raster layer: every annotation drawn on it is removed and the
* base image is kept (recreated when the user had deleted the image too).
* The raster layer cannot be deleted — it IS the image — so this is what the
* layer row's delete button means for layer_id 0.
*
* @param {Object} layer - Raster layer descriptor; `name` resolves the SVG group.
* @returns {boolean} true when the raster group was found.
*/
vector_editor.prototype.reset_raster = function(layer) {

	const stage		= this.stage
	const drawing	= stage.getCurrentDrawing()
	// load_data always names the raster group 'layer_0'; older lib_data may carry
	// a different descriptor name, so fall back to the canonical one.
	const layer_name	= drawing.getLayerByName(layer.name) ? layer.name : 'layer_0'
	const raster_group	= drawing.getLayerByName(layer_name)
	if (!raster_group) {
		return false
	}

	// annotations are everything but SvgCanvas's <title> and the base <image>.
	// deleteSelectedElements records the undo history (a bare remove() would not).
	const annotations = [...raster_group.children].filter(node => node.nodeName!=='image' && node.nodeName!=='title')
	if (annotations.length > 0) {
		stage.selectOnly(annotations)
		stage.deleteSelectedElements()
	}

	// the image element is deletable like any other: put the raster back
	if (!raster_group.querySelector('image')) {

		const image_definition	= this.image_definition
		// Rebuild the raster at its AUTHORED SVG user size: image_definition
		// .width/height are overwritten by update_canvas() with the current
		// container size, and getResolution() (the document's content box) can
		// differ from the saved image's own width/height on legacy data.
		const resolution	= stage.getResolution()
		const image_width	= Number.isFinite(image_definition.user_width) && image_definition.user_width > 0
			? image_definition.user_width
			: resolution.w
		const image_height	= Number.isFinite(image_definition.user_height) && image_definition.user_height > 0
			? image_definition.user_height
			: resolution.h
		// addSVGElementsFromJson writes into the current group or layer, which
		// may be a vector layer/group: leave any editing context, target the
		// raster, then restore the previous target.
		const previous_layer_name = drawing.getCurrentLayerName()
		stage.leaveContext()
		drawing.setCurrentLayer(layer_name)

		const img_elem = stage.addSVGElementsFromJson({
			element : 'image',
			attr : {
				x		: 0,
				y		: 0,
				width	: image_width,
				height	: image_height,
				id		: 'main_image',
				opacity	: 1,
				style	: 'pointer-events:inherit'
			}
		})

		const image_node = new Image()
		image_node.onload = () => {
			stage.setHref(img_elem, image_node.src)
		}
		image_node.src = image_definition.src

		image_definition.image_node = img_elem

		if (previous_layer_name && previous_layer_name!==layer_name) {
			drawing.setCurrentLayer(previous_layer_name)
		}
	}

	return true
}//end reset_raster



/**
* REMOVE_LAYER
* Deletes one vector layer from the SvgCanvas drawing and from the component's
* layer data, and leaves the editor on a valid drawing target.
*
* The data removal is spliced IN PLACE: self.ar_layers is the array persisted
* as data.entries[0].lib_data, so replacing it with a filtered copy left the
* deleted layer in the data and a later load_data resurrected it. The descriptor
* is also kept in `_layer_snapshots`: the SvgCanvas delete is undoable, and undo
* restores the DOM layer while `sync_layer_descriptors()` restores this half.
*
* SvgCanvas' identifyLayers() makes the TOPMOST remaining layer current, not a
* neighbour of the deleted one. The previously active layer is kept when it
* survived the delete; otherwise the editor follows the drawing's current layer
* and falls back to the raster.
*
* @param {Object} self - The owning component_image instance (ar_layers, id).
* @param {Object} layer - Vector layer descriptor to remove.
* @returns {boolean} true when the layer was found and deleted.
*/
vector_editor.prototype.remove_layer = function(self, layer) {

	const stage		= this.stage
	const drawing	= stage.getCurrentDrawing()

	// the SvgCanvas delete acts on the CURRENT layer: fail rather than delete
	// an unrelated layer when the name does not resolve.
	if (drawing.setCurrentLayer(layer.name)===false) {
		return false
	}
	const previous_active = this.active_layer
	// remove the layer in svgcanvas project
	if (stage.deleteCurrentLayer()===false) {
		return false
	}
	// the DOM layer is in the undo history; keep its descriptor so undo can
	// restore both halves (see sync_layer_descriptors)
	this._layer_snapshots.set(layer.name, { ...layer })

	// remove the data in place (see docblock)
	const layer_index = self.ar_layers.findIndex(item => item.layer_id===layer.layer_id)
	if (layer_index!==-1) {
		self.ar_layers.splice(layer_index, 1)
	}

	// keep the previous active layer when it survived; otherwise follow what
	// SvgCanvas left current (topmost) and fall back to the raster
	const current_name	= drawing.getCurrentLayerName()
	const target_layer	= self.ar_layers.find(item => item.layer_id===previous_active?.layer_id)
		|| self.ar_layers.find(item => item.name===current_name)
		|| self.ar_layers[0]
	if (target_layer) {
		drawing.setCurrentLayer(target_layer.name)
		this.active_layer = target_layer
		if (self.id) {
			event_manager.publish('active_layer_'+self.id, target_layer)
		}
	}

	return true
}//end remove_layer



/**
* COMPACT_HISTORY
* Drops the transient commands SvgCanvas records around a NEW shape: drawing a
* rectangle/ellipse records two opacity changes on the element before it records
* its InsertElementCommand, so a single draw would otherwise need three undos.
*
* Only commands BEFORE the insert that target the inserted element are dropped:
* the element did not exist when they were recorded, so they are setup, not
* user history. Later changes/moves of the same element stay undoable.
*
* Runs from the stage 'changed' event, never while undo/redo is applying (the
* pointer would no longer be at the end and the redo stack would be corrupted).
*
* @returns {void}
*/
vector_editor.prototype.compact_history = function() {

	const undoMgr = this.stage?.undoMgr
	if (!undoMgr || this._history_applying) {
		return
	}
	const stack = undoMgr.undoStack
	// only a fresh command: after an undo the pointer sits inside the stack
	if (!Array.isArray(stack) || undoMgr.undoStackPointer !== stack.length) {
		return
	}
	const InsertElementCommand = this.stage.history?.InsertElementCommand
	if (!InsertElementCommand) {
		return
	}

	let removed = false
	for (let i = stack.length - 1; i >= 0; i--) {
		const command = stack[i]
		if (!(command instanceof InsertElementCommand)) {
			continue
		}
		const element = command.elem
		let from = i
		while (from > 0 && this.command_targets_element(stack[from-1], element)) {
			from--
		}
		if (from < i) {
			stack.splice(from, i-from)
			removed = true
			i = from // the insert moved down by the removed commands
		}
	}
	if (removed) {
		undoMgr.undoStackPointer = stack.length
	}
}//end compact_history



/**
* COMMAND_TARGETS_ELEMENT
* Whether a history command only touches `element` (a BatchCommand counts when
* every sub-command targets it). Insert/Remove commands are never treated as
* setup: they are the element's own history.
*
* @param {Object} command - A SvgCanvas history command.
* @param {Element} element - The inserted SVG element.
* @returns {boolean}
*/
vector_editor.prototype.command_targets_element = function(command, element) {

	const history = this.stage?.history
	if (!history) {
		return false
	}
	const { BatchCommand, InsertElementCommand, RemoveElementCommand } = history
	if (command instanceof InsertElementCommand || command instanceof RemoveElementCommand) {
		return false
	}
	if (command instanceof BatchCommand) {
		return command.stack.length > 0
			&& command.stack.every(sub_command => this.command_targets_element(sub_command, element))
	}
	return typeof command.elements === 'function' && command.elements().includes(element)
}//end command_targets_element



/**
* UNDO
* Reverts the last SvgCanvas history command (draw, move, resize, delete,
* colour change, layer add/delete) and re-aligns the editor's layer data.
*
* The SvgCanvas UndoManager is per stage and starts empty: loading saved layers
* is not a history entry, so undo can never reach the pre-open state.
*
* @returns {boolean} true when a command was undone.
*/
vector_editor.prototype.undo = function() {

	const undoMgr = this.stage?.undoMgr
	if (!undoMgr || undoMgr.getUndoStackSize() === 0) {
		return false
	}
	this._history_applying = true
	try {
		undoMgr.undo()
	} finally {
		this._history_applying = false
	}
	this.after_history_change()

	return true
}//end undo



/**
* REDO
* Re-applies the last undone command and re-aligns the layer data.
*
* @returns {boolean} true when a command was redone.
*/
vector_editor.prototype.redo = function() {

	const undoMgr = this.stage?.undoMgr
	if (!undoMgr || undoMgr.getRedoStackSize() === 0) {
		return false
	}
	this._history_applying = true
	try {
		undoMgr.redo()
	} finally {
		this._history_applying = false
	}
	this.after_history_change()

	return true
}//end redo



/**
* AFTER_HISTORY_CHANGE
* Post-undo/redo reconciliation. The canvas history knows nothing about
* `ar_layers`, so a layer add/delete undone by the library must have its
* descriptor restored or removed here, or save_data would persist a different
* layer set than the one on screen.
*
* @returns {boolean} true when the layer set changed.
*/
vector_editor.prototype.after_history_change = function() {

	const self = this.component
	if (!self) {
		return false
	}

	return this.sync_layer_descriptors(self)
}//end after_history_change



/**
* SYNC_LAYER_DESCRIPTORS
* Makes self.ar_layers match the layers SvgCanvas currently holds.
*
* History moves layers in and out of the drawing:
*   - undo of a layer delete / redo of a layer add: the DOM layer is back but
*     the descriptor is gone → restore the snapshot (or derive one).
*   - undo of a layer add / redo of a layer delete: the DOM layer is gone but
*     the descriptor is still there → snapshot it and splice it out.
*
* The data splice is IN PLACE: self.ar_layers is the array persisted as
* data.entries[0].lib_data.
*
* The active layer is kept when it survives; otherwise the editor follows the
* layer SvgCanvas left current and falls back to the raster.
*
* @param {Object} self - The owning component_image instance (ar_layers, id).
* @returns {boolean} true when a layer descriptor was added or removed.
*/
vector_editor.prototype.sync_layer_descriptors = function(self) {

	const stage = this.stage
	if (!stage || !Array.isArray(self.ar_layers)) {
		return false
	}

	const drawing			= stage.getCurrentDrawing()
	// The library's history handler only calls identifyLayers() for direct
	// Insert/RemoveElementCommand types; a layer add/delete is a BatchCommand, so
	// the layer list can be stale. Rebuild it from the DOM before comparing.
	drawing.identifyLayers()
	const drawing_layers	= drawing.all_layers
	const drawing_names		= new Set(drawing_layers.map(layer => layer.getName()))
	let changed				= false

	// layers present in the drawing but missing from the data (restored by undo)
	for (const layer of drawing_layers) {
		const name = layer.getName()
		if (self.ar_layers.some(item => item.name===name)) {
			continue
		}
		const snapshot = this._layer_snapshots.get(name)
		if (snapshot) {
			self.ar_layers.push(snapshot)
		}else{
			// a layer the editor did not create (legacy/foreign): derive a descriptor.
			// Its swatch takes the editor's active fill colour — the same rule the
			// layer swatch itself follows (double-click assigns active_fill_color).
			const parsed_id = Number.parseInt(name.replace('layer_', ''), 10)
			self.ar_layers.push({
				layer_id		: Number.isFinite(parsed_id) ? parsed_id : self.ar_layers.length,
				layer_data		: null,
				layer_color		: this.active_fill_color,
				layer_opacity	: 0.3,
				user_layer_name	: name,
				name			: name,
				visible			: true
			})
		}
		changed = true
	}

	// data descriptors whose layer left the drawing (removed by redo/undo)
	for (let i = self.ar_layers.length - 1; i >= 0; i--) {
		const item = self.ar_layers[i]
		if (drawing_names.has(item.name)) {
			continue
		}
		this._layer_snapshots.set(item.name, { ...item })
		self.ar_layers.splice(i, 1)
		changed = true
	}

	// active layer. Keep it when it survived; otherwise follow the drawing.
	const previous_active = this.active_layer
	let active_layer = self.ar_layers.find(item => item.layer_id===previous_active?.layer_id)
	if (!active_layer) {
		const current_name = drawing.getCurrentLayerName()
		active_layer = self.ar_layers.find(item => item.name===current_name)
			|| self.ar_layers[0]
			|| null
		if (active_layer) {
			this.active_layer = active_layer
			drawing.setCurrentLayer(active_layer.name)
			if (self.id) {
				event_manager.publish('active_layer_'+self.id, active_layer)
			}
		}
	}else if (drawing.getCurrentLayerName() !== active_layer.name) {
		// the history handler may have left another layer current
		drawing.setCurrentLayer(active_layer.name)
	}

	if (changed) {
		this.refresh_layer_selector(self)
	}

	return changed
}//end sync_layer_descriptors



/**
* REFRESH_LAYER_SELECTOR
* Re-renders the floating layer panel when it is open, so a layer restored or
* removed by undo/redo appears/disappears from the list immediately.
*
* @param {Object} self - The owning component_image instance.
* @returns {void}
*/
vector_editor.prototype.refresh_layer_selector = function(self) {

	const container = this.layer_selector_container
	if (!container || !container.querySelector('.layer_selector')) {
		return
	}
	while (container.firstChild) {
		container.removeChild(container.firstChild)
	}
	const layer_selector = this.render_layer_selector(self, this.active_layer)
	if (layer_selector) {
		container.appendChild(layer_selector)
	}
}//end refresh_layer_selector



/**
* ACTIVATE_LAYER
* Makes a specific layer the current drawing target and hides all other
* vector layers by setting their opacity to 0.
*
* Iterates the layer stack in reverse (top to bottom), skipping layer index 0
* (the raster base) which is always visible. Sets opacity 1.0 for the layer
* matching layer_id and 0 for all others.
*
* active_layer is the layer DESCRIPTOR (not a SvgCanvas name string): draw
* tools read layer_color / layer_id from it, and a string left the next shape
* without colour and without a target. The drawing's current layer is moved
* with it, so what is drawn lands in the layer the user activated.
*
* @param {number} layer_id - The layer_id of the layer to activate.
* @param {Object} self - The owning component_image instance (ar_layers, id).
* @returns {void}
*/
vector_editor.prototype.activate_layer = function(layer_id, self) {

	const stage		= this.stage
	const drawing	= stage.getCurrentDrawing()

	const canvas_layers		= stage.getCurrentDrawing().getNumLayers()
	const layer_descriptor	= self?.ar_layers?.find(item => item.layer_id===layer_id) || null
	// layer_id is not a stack index after deletions (0, 2 is legal):
	// match by the SvgCanvas layer name.
	const target_name		= layer_descriptor?.name || ('layer_'+layer_id)

	for (let i = canvas_layers - 1; i >= 0; i--) {

		if(i === 0){
			continue;
		}
		const viewed_layer	= drawing.getLayerName(i)
		const opacity		= (viewed_layer===target_name) ? 1.0 : 0
		drawing.setLayerOpacity(viewed_layer, opacity)
	}

	if (layer_descriptor) {
		this.active_layer = layer_descriptor
		// stage wrapper (not drawing): it clears the selection, which would
		// otherwise survive on a layer that activate_layer just hid.
		stage.setCurrentLayer(layer_descriptor.name)
		if (self?.id) {
			event_manager.publish('active_layer_'+self.id, layer_descriptor)
		}
	}
}//end activate_layer



/**
* RENDER_LAYER_SELECTOR
* Builds and returns a floating layer-management panel as a DOM element.
*
* The panel contains:
*   - An "Add" button that calls add_layer() and prepends the new row via
*     render_layer_row().
*   - A "Close" button that removes the panel from the DOM.
*   - A <ul> list populated with one <li> row per layer (rendered in reverse
*     order so the topmost layer appears first), each row built by
*     render_layer_row().
*
* The returned element is not appended by this method; the caller
* (render_tools_buttons) inserts it into layer_selector_container.
*
* @param {Object} self - The owning component_image instance. Must expose
*   self.ar_layers {Array}.
* @returns {HTMLElement} A div.layer_selector containing the full panel,
*   or undefined if the method returns without building (not currently possible
*   but callers should guard for null/undefined).
*/
vector_editor.prototype.render_layer_selector = function(self) {

	// get the layers loaded in the image instance
	const ar_layers = self.ar_layers

	const fragment = new DocumentFragment()

	// add button
		const add_layer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'button add',
			title			: get_label.new || 'New',
			parent			: fragment
		})
		add_layer.addEventListener('click', (e) =>{
			e.stopPropagation()

			// add the data in the instance
			const new_layer	= this.add_layer(self)
			const layer_li	= this.render_layer_row(self, new_layer)
			// layer_ul.appendChild(layer_li)
			layer_ul.insertBefore(layer_li, layer_ul.firstChild)
		})

	// close button
		const close = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'button close',
			parent			: fragment
		})
		close.addEventListener('click', (e) =>{
			e.stopPropagation()

			e.preventDefault()
			// remove layer
			layer_selector.remove()
		})

	// rows container
		const layer_ul = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'layer_ul',
			parent			: fragment
		})

		// load the layer into the layer box
		for (let i =  ar_layers.length - 1; i >= 0; i--) {
			const layer		= ar_layers[i]
			const layer_li	= this.render_layer_row(self, layer)
			layer_ul.appendChild(layer_li)
		}//end for

	// layer_selector
		const layer_selector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'layer_selector'
		})
		layer_selector.appendChild(fragment)

	return layer_selector
}//end render_layer_selector



/**
* RENDER_LAYER_ROW
* Builds a single <li> row for the layer selector panel representing one layer.
*
* Each row contains the following interactive sub-elements:
*   - layer_icon (eye button): toggles the layer's visibility by setting its
*     opacity via drawing.setLayerOpacity(). The raster layer (layer_id 0)
*     uses 0.5 transparency when hidden rather than 0.
*   - layer_id label: read-only numeric display of the layer's id.
*   - user_layer_name: editable text div; double-click enables contentEditable,
*     blur or Enter commits the new name back to layer.user_layer_name.
*   - layer_delete: opens a confirmation modal via ui.attach_to_modal(). On
*     confirm, deletes a vector layer from both the SvgCanvas drawing and
*     self.ar_layers (in place, so the data entry follows). For the raster
*     layer (layer_id 0) it calls reset_raster(), which empties it and keeps
*     the base image: the raster is the image and cannot be deleted itself.
*   - layer_color swatch: a double-click assigns the current active_fill_color
*     to this layer's layer_color property (does not auto-save).
*
* The row subscribes to 'active_layer_<id>' events to toggle the 'active' CSS
* class and call stage.setCurrentLayer() when the active layer changes from
* another row's click handler.
*
* (!) The layer_delete click handler is a classic function (not an arrow
* function), so 'this' inside the button_delete click handler refers to the
* button element, not the vector_editor instance. The captured `editor` is used
* there instead.
*
* (!) `modal` is referenced inside the button_delete click handler via closure
* before the `const modal = ui.attach_to_modal(...)` declaration at the bottom
* of the outer click handler. This works at runtime because the modal variable
* is in the same function scope and the button_delete click fires after the
* outer handler has completed and modal is assigned.
*
* @param {Object} self - The owning component_image instance.
* @param {Object} layer - Layer descriptor object:
*   { layer_id {number}, layer_color {string}, layer_opacity {number},
*     user_layer_name {string}, name {string}, visible {boolean},
*     layer_icon {*}, layer_delete {*} }
* @returns {HTMLElement} The constructed <li> element ready for insertion into
*   the layer selector <ul>.
*/
vector_editor.prototype.render_layer_row = function(self, layer) {

	const editor			= this // captured for use inside non-arrow event handlers below
	const stage				= this.stage
	const drawing			= stage.getCurrentDrawing()
	// const currentLayerName	= drawing.getCurrentLayerName()
	// const canvas_layers		= stage.getCurrentDrawing().getNumLayers()


	// layer_container
		const layer_li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'li'
		})
		layer_li.addEventListener('click', (e) =>{
			e.stopPropagation()

			stage.clearSelection()

			// get the layer name
			const name	= 'layer_'+layer.layer_id

			// const new_active_layer	= project.layers[name]
			 // if we don't has the layer loaded, we load now
			// if(typeof new_active_layer==='undefined'){
			// 	this.load_layer(self, layer)
			// }else{
				// new_active_layer.activate()

				event_manager.publish('active_layer_'+self.id, layer)
			// }
		})
		// set the raster layer with specific class to remove css behavior (hover...)
			if(layer.layer_id===0){
				layer_li.classList.add('raster_layer')
			}

		// set the active layer, remove the raster layer to the active option
			if(layer.layer_id===this.active_layer.layer_id && layer.layer_id!==0) {
				layer_li.classList.add('active')
			}else{
				if (layer_li.classList.contains('active')) {
					layer_li.classList.remove('active')
				}
			}

		// when we change the active layer, the other layers will be inactive
			const active_layer_handler = (active_layer) => {
				if(layer.layer_id === active_layer.layer_id) {
					layer_li.classList.add('active')
					this.active_layer = active_layer
					stage.setCurrentLayer(active_layer.name)
				}else{
					if (layer_li.classList.contains('active')) {
						layer_li.classList.remove('active')
					}
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('active_layer_'+self.id, active_layer_handler)
			)

		// layer_icon
			const layer_icon = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button eye layer_icon active',
				parent			: layer_li,
				text_node		: layer.layer_icon
			})
			layer_icon.addEventListener('click', (e) =>{
				e.stopPropagation()

				const viewed_layer	= drawing.getLayerName(layer.layer_id)
				// get the transparency
				const transparency	= layer.layer_id === 0 ? 0.5 : 0

				// change the visibility state of the svgcanvas layer and icon
				if(layer.visible === true){
					layer.visible = false
					drawing.setLayerOpacity(viewed_layer, transparency)
					layer_icon.classList.remove('active')

					// a hidden layer cannot stay the drawing target: hand control
					// to the topmost visible layer (or the raster)
					if(this.active_layer?.layer_id === layer.layer_id){
						const fallback = [...self.ar_layers].reverse()
							.find(item => item.layer_id!==layer.layer_id && item.visible!==false)
							|| self.ar_layers[0]
						if (fallback) {
							this.active_layer = fallback
							stage.setCurrentLayer(fallback.name)
							event_manager.publish('active_layer_'+self.id, fallback)
						}
					}
				}else{
					layer.visible = true
					drawing.setLayerOpacity(viewed_layer, 1.0)
					layer_icon.classList.add('active')
					// store the DESCRIPTOR, not the SvgCanvas name
					this.active_layer = layer
					stage.setCurrentLayer(layer.name)
					event_manager.publish('active_layer_'+self.id, layer)
				}
			}) //end click event

		// layer_id
			const layer_id = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'layer_id',
				parent			: layer_li,
				text_node		: layer.layer_id
			})

		// layer_name
			const user_layer_name = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'user_layer_name',
				parent			: layer_li,
				text_node		: layer.user_layer_name
			})
			// when the user has double click in the text we active the edit text box
			user_layer_name.addEventListener('dblclick', (e) =>{
				e.stopPropagation()

				user_layer_name.contentEditable = true
				user_layer_name.focus();
			})
			// when the user blur the text box save the name into the layer structure
			user_layer_name.addEventListener('blur', () =>{
				user_layer_name.contentEditable = false
				// get the name of the layer, if the layer is the raster we change the selector name
				const name = layer.layer_id === 0 ? 'raster': 'layer_'+layer.layer_id
				const viewed_layer		= drawing.getLayerName(layer.layer_id)
				layer.user_layer_name	= user_layer_name.innerText
			})
			// if the user press return key = 13, we blur the text box
			user_layer_name.addEventListener('keydown', (e) =>{
				if(e.keyCode === 13) user_layer_name.blur()
			})

		// layer_delete
			const layer_delete = ui.create_dom_element({
				element_type	: 'span',
				title			: get_label.delete || 'Delete',
				class_name		: 'button remove layer_delete',
				parent			: layer_li,
				text_node		: layer.layer_delete
			})
			// show the alter with the option to select the action to do
			layer_delete.addEventListener('click', function(e){
				e.stopPropagation()

				// header
					const header = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'header label',
						text_content	: (get_label.delete || 'Delete')
					})

				// body
					// (!) user_layer_name is free text typed by ANY editor and stored in the
					// record's layer data: it is rendered as a text node, never parsed as
					// markup (stored XSS between users, CodeQL #7930).
					const body = ui.create_dom_element({
						element_type	: 'h3',
						class_name		: 'content delete_layer'
					})
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'delete_layer_name',
						text_content	: 'Layer: ' + (layer.user_layer_name ?? ''),
						parent			: body
					})
					body.appendChild(document.createElement('br'))
					body.appendChild(document.createElement('br'))
					body.appendChild(document.createTextNode(get_label.sure || 'Sure?'))

				// footer
					const footer = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'content footer'
					})

					// button_delete
						const button_delete = ui.create_dom_element({
							element_type	: 'button',
							class_name		: 'danger remove',
							text_content	: get_label.delete || 'Delete',
							parent			: footer
						})
						button_delete.addEventListener('click', function(e) {
							e.stopPropagation()

							// raster layer: it is the image itself, so 'delete' means
							// empty it (annotations out, base image kept). Deleting the
							// SvgCanvas layer would be a no-op with a single layer and
							// load_data would then duplicate the raster contents.
							if(layer.layer_id==0){
								editor.reset_raster(layer)

							}else{
								// remove the path layer from the drawing and the data,
								// and hand the editor a valid drawing target
								if (editor.remove_layer(self, layer)) {
									//remove the layer node
									layer_li.remove()
								}
							}

							// close modal
								modal.on_close()
						})

				// modal
					const modal = ui.attach_to_modal({
						header	: header,
						body	: body,
						footer	: footer,
						size	: 'small' // string size big|normal
					})

				return	true
			})//end layer_delete.addEventListener("click", function(e)

		// layer_color
			const layer_color = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'layer_color',
				parent			: layer_li
			})
			layer_color.style.backgroundColor = typeof layer.layer_color!=='undefined'
				? layer.layer_color
				: 'black'
			// if the user do a double click into the color icon will be assigned the current color in the color picker
			layer_color.addEventListener('dblclick', (e) =>{
				e.stopPropagation()

				layer_color.style.backgroundColor = this.active_fill_color
				layer.layer_color = this.active_fill_color
			})


	return layer_li
}//end layer_selector



/**
* DESTROY
* Release the document-level listeners (copy/paste/keydown) attached during
* init_canvas/keyboard_shortcuts so they do not accumulate across record navigation.
* @return bool true
*/
vector_editor.prototype.destroy = function() {

	if (Array.isArray(this._document_handlers)) {
		this._document_handlers.forEach(item => {
			document.removeEventListener(item.type, item.handler)
		})
		this._document_handlers = []
	}

	this.extensionsAdded = false

	return true
}//end destroy



// @license-end
