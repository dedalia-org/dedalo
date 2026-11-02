// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEVELOPER, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/
// (!) DEDALO_API_URL is used at line ~710 but is NOT listed in the /*global*/ declaration above.
// It is injected at page load as a global constant from the PHP template. If eslint runs in
// strict mode this will produce a no-undef error. Flagged for a future /*global*/ addition.



/**
* RENDER_INSPECTOR
* Client-side rendering module for the Dédalo v7 inspector panel.
*
* The inspector is a collapsible sidebar that floats to the right of a section's
* edit view and provides developers and power users with:
*   - section / component metadata (tipo, model, matrix_table, audit trail)
*   - quick-action buttons (search, new, duplicate, delete, graph view, diffusion, tools)
*   - project filter widget (component_project_filter, injected via event)
*   - relations list (lazy-loaded, paginated)
*   - time-machine list  — recent changes across all components of the section
*   - component history  — full value history for the currently selected component
*   - activity feed      — live save-notification bubbles
*   - ontology navigation links (documentation, local ontology, master ontology)
*
* Layout / state persistence:
*   The panel width and rail-collapsed state are saved globally in IndexedDB
*   (table 'status', keys 'inspector_rail_state' / 'inspector_width').  The state
*   is loaded before first paint so that layout is stable with no flicker.
*   On viewports ≤ 1024 px (is_narrow_viewport) the panel is inline full-width
*   and rail/resize controls are inert.
*
* Relationship with inspector.js:
*   inspector.js holds the lifecycle prototype (init / build / destroy) and all
*   event subscriptions.  This module holds the DOM construction functions that
*   inspector.js delegates to, plus a small set of exported helpers consumed by
*   view_default_edit_section.js (apply_inspector_state, init_inspector_resize,
*   toggle_inspector_rail).
*
* Exports (public API of this module):
*   render_inspector            — constructor stub (prototype.edit defined here)
*   toggle_inspector_rail       — collapse / expand the panel
*   apply_inspector_state       — pre-paint state application
*   init_inspector_resize       — wires the drag-resize handle
*   update_project_container_body
*   render_section_info
*   render_component_info
*   render_time_machine_list
*   load_record_info            — fills the created / modified / published rows (own request)
*   load_time_machine_list
*   render_component_history (private, consumed via inspector.js init)
*   load_component_history
*   render_activity_info (private)
*   load_activity_info
*   open_ontology_window
*/

// import
	import { ui } from '../../common/js/ui.js'
	import { create_source } from '../../common/js/common.js'
	import { event_manager } from '../../common/js/event_manager.js'
	import { get_instance } from '../../common/js/instances.js'
	import { render_node_info } from '../../common/js/utils/notifications.js'
	import { get_ontology_url } from '../../inspector/js/inspector.js'
	import { open_tool } from '../../../core/tools_common/js/tool_common.js'
	import { render_open_list_with_direct_relations } from '../../section/js/render_open_list_with_direct_relations.js'
	import {
		data_manager,
		download_data
	} from '../../common/js/data_manager.js'
	import { response_data } from '../../common/js/api_error.js'
	import { error_text } from '../../common/js/render_api_error.js'
	import {
		when_in_viewport,
		dd_request_idle_callback,
		set_tool_event
	} from '../../common/js/events.js'
	import {
		open_window,
		object_to_url_vars,
		get_tld_from_tipo,
		get_section_id_from_tipo,
		clone,
		load_style,
		tool_base_url
	} from '../../common/js/utils/index.js'




/**
* RENDER_INSPECTOR
* Constructor stub for the inspector instance.
* All prototype methods are assigned in inspector.js (lifecycle) and below
* (render_inspector.prototype.edit).  The actual work is done by get_content_data
* and the render_* / load_* helpers in this file.
*/
export const render_inspector = function() {

	return true
}//end render_inspector



// Persisted UI state (IndexedDB table 'status', global keys shared across sections)
// These constants are intentionally global across all section instances so that the
// inspector always opens at the same width/collapsed state regardless of which record
// the user navigates to.
	const RAIL_STATE_KEY	= 'inspector_rail_state' // {value:true} => collapsed to rail
	const WIDTH_KEY			= 'inspector_width'      // {value:'24rem'} user chosen width
	const DEFAULT_WIDTH		= '19rem'                // matches --inspector_width CSS default
	const RAIL_WIDTH_VAR	= 'var(--inspector_rail_width)' // narrow strip that shows only icons
	const DATA_HEIGHT_KEY	= 'inspector_data_height' // {value:'180px'} user dragged height of the component Data box
	const DATA_MAX_ENTRIES	= 25                      // above this the Data box shows a notice instead of the JSON



/**
* IS_INSPECTOR_RAILED
* True when the panel is collapsed to the icon rail (labels hidden).
* @returns {boolean}
*/
	const is_inspector_railed = () => {
		const container = document.getElementById('inspector_container')
		return !!container && container.classList.contains('inspector_rail')
	}

/**
* TOOLTIP_SELECTOR
* Every hoverable icon of the panel, so the whole set behaves the same in rail mode
* (where the labels are hidden and the tooltip is the ONLY affordance):
*   - '.button'                — toolbar / tool / inline action icons
*   - '.block_icon[title]'     — collapsible block headers (title set by decorate_block_header)
*   - '.inspector_rail_toggle' — the rail collapse/expand toggle (not a '.button')
*/
	const TOOLTIP_SELECTOR = '.button, .block_icon[title], .inspector_rail_toggle'

/**
* ACTIVATE_INSPECTOR_TOOLTIPS
* Registers tooltips for every icon of the panel with placement 'left'.
* The panel is docked to the RIGHT viewport edge, and codex-tooltip does not clamp
* to the viewport: a 'top' tooltip is centred over its icon and gets cut off by the
* edge (worst in rail mode, where the icons are ~24px from the edge). Drawing to the
* left opens into the section content, which always has room.
* @param {HTMLElement} node
* @returns {void}
*/
	const activate_inspector_tooltips = (node) => {
		ui.activate_tooltips(node, TOOLTIP_SELECTOR, false, 'left')
	}



/**
* SET_INSPECTOR_WIDTH
* Writes --inspector_width on :root. The section content width and the panel
* position are calc() consumers of this CSS variable, so the layout reflows
* automatically whenever this value changes — no manual DOM repositioning required.
* @param {string} value - Any CSS length value: '19rem', '320px', or
*   'var(--inspector_rail_width)' when collapsing to the icon rail.
* @returns {void}
*/
const set_inspector_width = (value) => {
	document.documentElement.style.setProperty('--inspector_width', value)
}//end set_inspector_width



/**
* IS_NARROW_VIEWPORT
* Returns true when the viewport is at most 1024 px wide (the CSS
* @width_break_point_0 breakpoint). Below this threshold the inspector renders
* as an inline full-width block and rail collapse + drag-resize are both
* disabled so they do not interfere with the stacked layout.
* @returns {boolean} true when viewport width ≤ 1024 px
*/
const is_narrow_viewport = () => window.matchMedia('(max-width: 1024px)').matches



/**
* TOGGLE_INSPECTOR_RAIL
* Collapses the inspector panel to a narrow icon-only rail, or expands it back
* to its last saved width.  The transition is purely CSS-driven via
* --inspector_width, so the section content area reflows automatically.
*
* The new state is written to IndexedDB ('status' table, key 'inspector_rail_state')
* so it survives page reloads.
*
* No-ops silently when:
*   - the viewport is narrow (≤ 1024 px) — inline layout, no rail concept
*   - #inspector_container is absent from the DOM
*
* @param {Object} self - Inspector instance. Reads self._saved_width (the last
*   explicit pixel/rem width chosen by the user) and updates self._rail_collapsed.
* @returns {boolean} false when the toggle was suppressed; true on success.
*/
export const toggle_inspector_rail = (self) => {

	if (is_narrow_viewport()) {
		return false
	}

	const container = document.getElementById('inspector_container')
	if (!container) {
		return false
	}

	// Determine direction from current DOM state, not from self._rail_collapsed,
	// so the UI and the flag stay in sync even after a hot reload or external toggle.
	const collapsing = !container.classList.contains('inspector_rail')
	container.classList.toggle('inspector_rail', collapsing)
	self._rail_collapsed = collapsing

	set_inspector_width(
		collapsing
			? RAIL_WIDTH_VAR
			: (self._saved_width || DEFAULT_WIDTH)
	)

	// persist
	data_manager.set_local_db_data(
		{ id: RAIL_STATE_KEY, value: collapsing },
		'status'
	)

	return true
}//end toggle_inspector_rail



/**
* APPLY_INSPECTOR_STATE
* Applies the persisted rail/width state to the freshly created #inspector_container
* BEFORE it is attached to the DOM, so the very first paint is already at the right
* dimensions and no layout shift occurs.
*
* Called by view_default_edit_section.js immediately after the container element is
* created and before it is appended to the section fragment.
*
* @param {Object} inspector - Inspector instance. Must have _rail_collapsed (boolean)
*   and _saved_width (string | falsy) already populated by edit() awaiting IndexedDB.
* @param {HTMLElement} container - The #inspector_container element to configure.
* @returns {boolean} false when container is falsy (nothing to do); true otherwise.
*/
export const apply_inspector_state = (inspector, container) => {

	if (!container) {
		return false
	}

	const railed = inspector?._rail_collapsed===true && !is_narrow_viewport()
	if (railed) {
		container.classList.add('inspector_rail')
		set_inspector_width(RAIL_WIDTH_VAR)
	} else {
		container.classList.remove('inspector_rail')
		set_inspector_width(inspector?._saved_width || DEFAULT_WIDTH)
	}

	return true
}//end apply_inspector_state



/**
* INIT_INSPECTOR_RESIZE
* Wires a left-edge drag handle to allow the user to resize the inspector panel live.
*
* Resize behaviour:
*   - Uses the Pointer Events API with pointer capture so the drag continues even when
*     the pointer leaves the handle element.
*   - Width updates are batched through requestAnimationFrame (rAF-coalesced) to avoid
*     forced-layout thrashing on every pointermove event.
*   - Width is clamped between MIN (14 rem) and get_max() (60 % of viewport or 40 rem,
*     whichever is smaller) to prevent the panel from covering the entire content area.
*   - The handle is on the LEFT edge of the panel, so dragging left (lower clientX)
*     makes the panel wider: dx = start_x − current_x > 0 means growth.
*   - On pointerup the resolved value is read back from the CSS variable (post-clamp)
*     and written to IndexedDB so subsequent page loads restore the same width.
*   - The body class 'inspector_resizing' suppresses pointer-events on content while
*     dragging to prevent accidental text selections or hover effects.
*
* No-ops silently when:
*   - handle is falsy
*   - pointerdown fires while the panel is in rail mode (inspector_rail class present)
*   - pointerdown fires on a narrow viewport (≤ 1024 px)
*
* @param {HTMLElement} handle - The drag-resize strip element on the panel's left edge.
* @param {Object} inspector - Inspector instance. Updated: inspector._saved_width is
*   set to the final CSS string (e.g. '320px') when the user releases the pointer.
* @returns {boolean} false when handle is falsy; true after the listener is attached.
*/
export const init_inspector_resize = (handle, inspector) => {

	if (!handle) {
		return false
	}

	const REM		= parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
	const MIN		= 14 * REM
	const get_max	= () => Math.min(window.innerWidth * 0.6, 40 * REM)

	let start_x		= 0
	let start_w		= 0
	let raf_id		= null
	let pending_w	= null

	const apply_pending = () => {
		raf_id = null
		if (pending_w!==null) {
			set_inspector_width(pending_w + 'px')
		}
	}

	const on_move = (e) => {
		// handle is on the LEFT edge: dragging left (smaller clientX) grows the panel
		const dx = start_x - e.clientX
		let w = start_w + dx
		w = Math.max(MIN, Math.min(get_max(), w))
		pending_w = w
		if (raf_id===null) {
			raf_id = requestAnimationFrame(apply_pending)
		}
	}

	const on_up = (e) => {
		window.removeEventListener('pointermove', on_move)
		window.removeEventListener('pointerup', on_up)
		// flush the last pending frame before persisting
		if (raf_id!==null) {
			cancelAnimationFrame(raf_id)
			apply_pending()
		}
		document.body.classList.remove('inspector_resizing')
		try { handle.releasePointerCapture(e.pointerId) } catch(err) {}

		// persist the resolved width
		const w = getComputedStyle(document.documentElement)
			.getPropertyValue('--inspector_width').trim()
		if (w) {
			inspector._saved_width = w
			data_manager.set_local_db_data({ id: WIDTH_KEY, value: w }, 'status')
		}
	}

	handle.addEventListener('pointerdown', (e) => {
		const container = document.getElementById('inspector_container')
		// disabled while railed or on the inline narrow layout
		if (!container || container.classList.contains('inspector_rail') || is_narrow_viewport()) {
			return
		}
		e.preventDefault()
		e.stopPropagation()
		start_x = e.clientX
		start_w = parseFloat(getComputedStyle(container).width) || MIN
		document.body.classList.add('inspector_resizing')
		try { handle.setPointerCapture(e.pointerId) } catch(err) {}
		window.addEventListener('pointermove', on_move)
		window.addEventListener('pointerup', on_up)
	})

	return true
}//end init_inspector_resize



/**
* DECORATE_BLOCK_HEADER
* Adds a CSS-mask icon span and a text-label span to a collapsible block header.
* This two-node structure lets CSS hide only the label text in rail mode while
* the icon span remains visible as the sole visual indicator.
*
* Must be called once per header; calling it a second time would duplicate the
* icon and label inside the same header element.
*
* @param {HTMLElement} header - The block header element to decorate (mutated in place).
* @param {string} icon_class - BEM modifier used as the mask icon source.
*   Known values: 'info' | 'gear' | 'link' | 'history' | 'note' | 'activity' | 'panel'
* @param {string} label_html - Inner HTML of the label span (may contain HTML entities).
* @returns {HTMLElement} The same header element, for optional chaining.
*/
const decorate_block_header = (header, icon_class, label_html) => {

	// plain-text label for the icon tooltip. In rail mode the label span is
	// hidden, so this title is the only way to know what the icon opens.
	const label_node	= document.createElement('span')
	label_node.innerHTML = label_html
	const label_text	= (label_node.textContent || '').trim()

	const icon = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'block_icon ' + icon_class,
		title			: label_text,
		parent			: header
	})
	// rail-only tooltip. Expanded, the label sits right next to the icon and a
	// tooltip repeating it is pure noise; railed, it is the only clue.
	// (!) This listener MUST be registered BEFORE activate_inspector_tooltips
	// registers the library's own 'mouseenter' handler on the same element:
	// at-target listeners fire in registration order, so only a first-registered
	// one can stopImmediatePropagation() the library's handler.
	icon.addEventListener('mouseenter', (e) => {
		if (!is_inspector_railed()) {
			e.stopImmediatePropagation()
		}
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'block_label',
		inner_html		: label_html,
		parent			: header
	})

	return header
}//end decorate_block_header



/**
* LOAD_BLOCK
* The ONE lazy-load path for every inspector block whose body comes from the
* server (relations, latest changes, component history).
*
* Why it exists: these blocks used to empty or dim an EMPTY body and then wait
* for the round trip, so on a slow network or a busy server the click looked
* dead. Here the shared 'Loading …' placeholder + spinner is installed
* SYNCHRONOUSLY (first call, before any await) and ui.load_item_with_spinner
* swaps in the result — or the engine's own error panel when the task throws,
* so a failing server never leaves a blank card.
*
* Serialized per container: a trigger arriving while a load is in flight
* (section pagination while the block is open) joins the chain instead of
* racing the in-flight task — the same protection load_time_machine_list used
* to own privately, now the shared behaviour.
*
* NOT LOADING TWICE is the other half of the contract, and the `key` carries it:
* a block whose key is unchanged is already displayed, so re-opening it reuses
* that content and asks the server nothing. Only `reload:true` (a save changed
* the data, the section re-rendered, the list turned a page) goes back to the
* server. A FAILED load is not remembered as loaded, and any caller that clears
* its own container clears the key with it.
*
* @param {Object} options
* @param {HTMLElement} options.container - the block body to fill
* @param {string} options.label - block label, appended to 'Loading'
* @param {string|null} [options.key=null] - identity of the content the body
*   shows; null means 'never reusable'. A repeat of the same key reuses the DOM
*   (or joins the load already in flight).
* @param {boolean} [options.reload=false] - force a fresh load even when the key
*   is unchanged (a save, a section re-render, a page turn)
* @param {Function} options.task - async () => HTMLElement|DocumentFragment
* @returns {Promise<HTMLElement|DocumentFragment|null>}
*/
export const load_block = async function(options) {

	const { container, label, task, key = null, reload = false } = options

	// ALREADY LOADED — or already loading: the SAME identity is never asked for
	// twice. `key` names the content the body shows (the record locator, plus the
	// component for the component-history block). `reload:true` is the forced path
	// — a save just changed the data, or the section re-rendered — and bypasses it.
	// shortcut: a re-open therefore serves the content as of the last load, so a
	// relation added by ANOTHER user while the block sat collapsed is unseen until
	// a forced path fires; upgrade by folding the record's modified_date into key.
	if (!reload && key !== null && container._block_key === key) {
		// a load for this key is already in flight: join it, never duplicate it
		return container._block_load || container
	}

	const start = () => {
		container.setAttribute('aria-busy', 'true')
		let failed = false
		return ui.load_item_with_spinner({
			container,
			label,
			callback	: async () => {
				try {
					return await task()
				} catch (error) {
					failed = true
					throw error
				}
			}
		})
		.then((node) => {
			// a FAILED load is not 'loaded': the next open must ask again
			if (failed===true && container._block_key===key) {
				container._block_key = null
			}
			return node
		})
	}

	// claim the identity NOW, so a trigger arriving while this one loads joins it
	container._block_key = key

	// one load at a time per container: a queued trigger waits for the current
	const previous = container._block_load
	const chain = previous
		? previous.catch(() => null).then(start)
		: start()
	container._block_load = chain

	try {
		return await chain
	} finally {
		// release only if no newer load took the slot
		if (container._block_load===chain) {
			container._block_load = null
			container.removeAttribute('aria-busy')
		}
	}
}//end load_block



/**
* BLOCK_KEY
* Identity of a RECORD-scoped inspector block's content. A block reloads only
* when this changes or when a forced reload is asked for (save, section
* re-render, a page turn inside the list).
* @param {Object} self - Inspector instance.
* @returns {string}
*/
const block_key = function(self) {
	return self.caller.section_tipo + '_' + self.caller.section_id
}//end block_key



/**
* EDIT
* Builds the full inspector DOM tree and returns the outermost wrapper element.
* This is the prototype method assigned to render_inspector.prototype.edit and
* called by common.prototype.render() during the section edit lifecycle.
*
* Render-level semantics:
*   'content' — return only the content_data node (inner body, used by refresh).
*   'full'    — return the complete wrapper including the sticky header label.
*
* Persisted state is loaded from IndexedDB BEFORE constructing the DOM so that
* apply_inspector_state (called by view_default_edit_section.js immediately after)
* receives the correct _rail_collapsed and _saved_width values, avoiding any
* visible layout jump on first render.
*
* The sticky label uses an IntersectionObserver to toggle the 'is_pinned' class
* when the header is obscured at the top of its scroll container, allowing CSS to
* add a shadow/border to indicate the pinned state.
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' or 'content'
* @returns {Promise<HTMLElement>} wrapper (#inspector element) or content_data node
*   when render_level === 'content'
*/
render_inspector.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// persisted rail / width state (global keys). Read before first paint so the
	// container can be sized correctly in view_default_edit_section (no flicker)
		const [rail_rec, width_rec, data_height_rec] = await Promise.all([
			data_manager.get_local_db_data(RAIL_STATE_KEY, 'status', true),
			data_manager.get_local_db_data(WIDTH_KEY, 'status', true),
			data_manager.get_local_db_data(DATA_HEIGHT_KEY, 'status', true)
		])
		self._rail_collapsed	= rail_rec?.value===true
		self._saved_width		= width_rec?.value || DEFAULT_WIDTH
		self._data_height		= data_height_rec?.value || null // null = CSS default (10rem)

	// content data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// label
		const label = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label icon_arrow up'
		})
		// leading inspector icon + text wrapper (text hides in rail mode).
		// modifier is 'panel' (not 'inspector') to avoid colliding with the
		// .inspector wrapper class on the same span.
		decorate_block_header(label, 'panel', get_label.inspector || 'Inspector')
		// rail collapse / expand toggle
		const rail_toggle = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'inspector_rail_toggle',
			title			: get_label.collapse || 'Collapse / expand',
			parent			: label
		})
		rail_toggle.addEventListener('click', (e) => {
			e.stopPropagation() // do not trigger the label's collapse-content toggle
			toggle_inspector_rail(self)
		})
		// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: label,
			container			: content_data,
			collapsed_id		: 'inspector_main_block',
			collapse_callback	: collapse,
			expose_callback		: expose
		})
		function collapse() {
			label.classList.remove('up')
		}
		function expose() {
			label.classList.add('up')
		}
		// IntersectionObserver: adds 'is_pinned' class when the sticky header is
		// scrolled out of view (intersectionRatio < 1), enabling a CSS drop-shadow.
		const observer = new IntersectionObserver(
			([e]) => e.target.classList.toggle('is_pinned', e.intersectionRatio < 1),
			{ threshold: [1] }
		);
		when_in_viewport(label, () => {
			observer.observe(label);
		})

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			id				: 'inspector',
			class_name		: 'wrapper_inspector inspector'
		})
		// set pointers
		wrapper.content_data = content_data

	// add elements
		wrapper.appendChild(label)
		wrapper.appendChild(content_data)

	// tooltip
		dd_request_idle_callback(
			() => {
				activate_inspector_tooltips(wrapper)
			}
		)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the complete body of the inspector panel: paginator, all action buttons,
* tool shortcut buttons, project filter, info blocks, time-machine list, component
* history, and the activity feed.
*
* This function owns the full content_data subtree.  The outer label/wrapper is
* assembled by render_inspector.prototype.edit().  When render_level === 'content'
* edit() returns this node directly (used by refresh cycles to replace only the body).
*
* Block rendering order:
*   1. paginator_container (holds the paginator; section_id shown via the
*      paginator's .placeholder_section_id)
*   2. buttons_container top (search / new / duplicate / delete / target-section /
*      graph / diffusion / tool shortcuts)
*   3. tools_container (any NON-print inspector tool, each on its own row; tool_print
*      always goes into buttons_container instead)
*   4. selection_info block
*   5. element_info block (info panel, lazily populated by render_section_info /
*      render_component_info via event subscriptions in inspector.js)
*   6. project block (only when component_filter_node is already available)
*   7. relation_list block (only when context.config.relation_list_tipo is set)
*   8. time_machine_list block (only when context.config.time_machine_list is set —
*      the server's per-principal history grant; render_time_machine_blocks)
*   9. component_history block (same guard as time_machine_list)
*  10. activity_info block
*  11. buttons_bottom_container (data link, register download for dd1340)
*
* @param {Object} self - Inspector instance. section = self.caller must already have
*   context.buttons and context.tools populated from the server response.
* @returns {HTMLElement} content_data - The populated inspector body element.
*/
const get_content_data = function(self) {

	// short vars
		const section			= self.caller
		const section_buttons	= section.context.buttons || []

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data inspector_content_data hide'
		})
		// Stop mousedown from bubbling to the section, which would deactivate the
		// currently selected component (section listens for mousedown on document
		// and deactivates the active component unless the click is inside it).
		content_data.addEventListener('mousedown', function(e) {
			e.stopPropagation();
		})
		// rail: clicking a block header while collapsed expands the panel and opens
		// that block. Capture phase + stopPropagation pre-empts the per-block
		// collapse_toggle_track handler; the programmatic re-click then runs normally
		// (the container is no longer railed) and opens the body.
		content_data.addEventListener('click', function(e) {
			const container = document.getElementById('inspector_container')
			if (!container || !container.classList.contains('inspector_rail')) {
				return
			}
			const header = e.target.closest('[class*="_head"]')
			if (!header || !content_data.contains(header)) {
				return
			}
			e.stopPropagation()
			// expand the panel
			toggle_inspector_rail(self)
			// open the clicked block if its body is collapsed. Defer one frame so the
			// re-click is not suppressed by the click-in-progress flag when the original
			// event was itself produced by HTMLElement.click() (re-entrancy guard).
			const body = header.nextElementSibling
			if (body && body.classList.contains('hide')) {
				requestAnimationFrame(() => header.click())
			}
		}, true)

	// paginator container
		const paginator_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'paginator_container',
			parent			: content_data
		})
		// fix pointer to node placeholder
		self.paginator_container = paginator_container

	// buttons container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container top',
			parent			: content_data
		})

		// button_search. Show and hide all search elements
			const button_search = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button block_icon light search',
				title			: get_label.find || "Search",
				parent			: buttons_container
			})
			const button_search_mousedown_handler = (e) => {
				e.stopPropagation()
				event_manager.publish('toggle_search_panel_' + self.caller.id)
			}
			button_search.addEventListener('mousedown', button_search_mousedown_handler)
			// warm up on intent: build requests start before the click
			const warm_handler = () => self.caller.warm_search_panel?.()
			button_search.addEventListener('pointerenter', warm_handler)
			button_search.addEventListener('focus', warm_handler)

		// button_new . Call API to create new section and navigate to the new record
			const section_button_new = section_buttons.find(el => el.model==='button_new')
			if (section_button_new) {
				const button_new = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button block_icon light add_light',
					title			: section_button_new.label || 'New',
					parent			: buttons_container
				})
				const button_new_click_handler = (e) => {
					e.stopPropagation()
					event_manager.publish('new_section_' + self.caller.id)
				}
				button_new.addEventListener('click', button_new_click_handler)
			}

		// button_duplicate . Call API to duplicate current record
		// use the section_button_new, if it's defined user can create or duplicate the section
			if (section_button_new && has_inspected_record(self)) {
				const button_duplicate = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button block_icon light duplicate',
					title			: get_label.duplicate || "Duplicate",
					parent			: buttons_container
				})
				const button_duplicate_click_handler = (e) => {
					e.stopPropagation()
					event_manager.publish('duplicate_section_' + self.caller.id, {
						section_tipo	: self.caller.section_tipo,
						section_id		: self.caller.section_id,
						caller			: self.caller // section
					})
				}
				button_duplicate.addEventListener('click', button_duplicate_click_handler)
			}

		// button_delete . Call API to delete current record
			const section_button_delete = section_buttons.find(el => el.model==='button_delete')
			if (section_button_delete && has_inspected_record(self)) {
				const button_delete = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button block_icon light remove',
					title			: section_button_delete.label || 'Delete',
					parent			: buttons_container
				})
				const button_delete_click_handler = (e) => {
					e.stopPropagation()
					event_manager.publish('delete_section_' + self.caller.id, {
						section_tipo	: self.caller.section_tipo,
						section_id		: self.caller.section_id,
						caller			: self.caller // section
					})
				}
				button_delete.addEventListener('click', button_delete_click_handler)
			}

		// button_target_section
			// Opens the list of all sections that have a direct relation to the current
			// one, rendered via render_open_list_with_direct_relations.
			const button_target_section = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button block_icon light list',
				title			: get_label.open_relationships || 'Open relationships',
				parent			: buttons_container
			})
			const button_target_section_mousedown_handler = (e) => {
				e.stopPropagation()

				// The target sections and their counts come from the server
				// (relation_targets), per scope, inside the dialog: no client-side
				// guess from the portals present in the loaded context.
				const options ={
					sqo			: clone(self.caller.rqo?.sqo) || {},
					label		: self.caller.label,
					total		: self.caller.total,
					// the section instance: names the open record ('current'),
					// computes the found-records total, and is the caller of the
					// short-lived section that pins each window's filter.
					self_caller : self.caller
				}
				render_open_list_with_direct_relations( options )

			}
			button_target_section.addEventListener('mousedown', button_target_section_mousedown_handler)


		// button_graph . Switch the section to the interactive relations graph view
			const button_graph = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button block_icon light graph',
				title			: get_label.graph || 'Graph',
				parent			: buttons_container
			})
			const button_graph_click_handler = async (e) => {
				e.stopPropagation()

				const section = self.caller
				if (!section || !section.section_id) {
					return
				}

				// set graph view (both flags: render_edit_section reads context.view, create_source reads view)
				// Both section.view and section.context.view must be updated because different
				// render paths read from different sources (context is the server-side shape;
				// view is the live client override).
				section.view = 'graph'
				if (section.context) {
					section.context.view = 'graph'
				}

				// re-render reusing already-loaded client data (no extra API call)
				// build_autoload:false prevents re-fetching the section record from the API;
				// the graph renderer only needs the relation map, not the full record data.
				await section.refresh({
					build_autoload	: false,
					render_level	: 'full'
				})
			}
			button_graph.addEventListener('click', button_graph_click_handler)


		// button_diffusion
			const tool_diffusion = self.caller.tools.find(el => el.name==='tool_diffusion')
			if (tool_diffusion) {
				const button_diffusion = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button block_icon light diffusion',
					title			: get_label.diffusion || 'Diffusion',
					parent			: buttons_container
				})
				const button_diffusion_mousedown_handler = (e) => {
					e.stopPropagation()
					// open_tool (tool_common)
					open_tool({
						tool_context	: tool_diffusion, // tool context
						caller			: self.caller // section instance
					})
				}
				button_diffusion.addEventListener('mousedown', button_diffusion_mousedown_handler)
			}

	// tools_container. Section tools buttons
	// Tools marked show_in_inspector:true in the ontology appear here.
	// tool_print is special-cased: it ALWAYS renders alongside the core action
	// buttons (buttons_container), never inside tools_container — so the print
	// icon sits in the SAME place across every section. In most sections print
	// is the only inspector tool; in sections that expose extra inspector tools
	// (e.g. ontology/hierarchy, dd0/section_id 1) it would otherwise slip into
	// tools_container, moving the icon to a different place than everywhere else.
	// Every OTHER inspector tool (e.g. tool_ontology) is a separate tool and keeps
	// its own tools_container row — created whenever at least one non-print tool
	// is present, so a lone ontology tool still gets its own line.
		// tool_identify is offered only when the AI identify capability is enabled
		// (page_globals.ai_capabilities.identify === true). Otherwise the tool is
		// hidden from the inspector entirely, whatever its ontology flag says.
		const identify_enabled			= page_globals.ai_capabilities?.identify === true
		const inspector_tools			= self.caller.context.tools.filter( el =>
			el.show_in_inspector && (el.name !== 'tool_identify' || identify_enabled)
		)
		const inspector_tools_length	= inspector_tools.length
		const grouped_tools_length		= inspector_tools.filter( el => el.name !== 'tool_print' ).length
		let tools_container				= null
		if (inspector_tools_length>0) {
			if(grouped_tools_length > 0) {
				tools_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'tools_container top',
					parent			: content_data
				})
			}
			for (let i = 0; i < inspector_tools_length; i++) {
				const tool_context = inspector_tools[i]
				// tool_print stays with the core buttons; every other tool goes into
				// its own tools_container row.
				const tool_parent = tool_context.name === 'tool_print'
					? buttons_container
					: tools_container
				// load tool CSS lazily (no duplicate injection — load_style is idempotent)
				const tool_css_url = tool_base_url(tool_context.model) + '/css/' + tool_context.model + '.css' + `?v=${page_globals.dedalo_version}`
				load_style(tool_css_url)
				// tool_button
					const tool_button = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button block_icon light blank',
						style			: {
							'mask-image' : `url('${tool_context.icon}')`,
						},
						title  : tool_context.label,
						parent : tool_parent
					})
					const click_handler = (e) => {
						e.stopPropagation()
						// open_tool (tool_common)
						open_tool({
							tool_context	: tool_context,
							caller			: self.caller
						})
					}
					tool_button.addEventListener('mousedown', click_handler)

				// button events. Configured in tool properties. See tool_ontology definition
					// sample:
					// "events": [
					// 	{
					// 	  "type": "keyup",
					// 	  "action": "click",
					// 	  "validate": [
					// 		{
					// 		  "key": "ctrlKey",
					// 		  "value": true
					// 		},
					// 		{
					// 		  "key": "key",
					// 		  "value": "s"
					// 		}
					// 	  ]
					// 	}
					// ]
					if (tool_context.properties?.events) {
						const tool_events_length = tool_context.properties.events.length
						for (let i = 0; i < tool_events_length; i++) {

							const tool_event = tool_context.properties.events[i]

							set_tool_event({
								tool_event	: tool_event,
								tool_button	: tool_button
							})
						}
					}
			}
		}

	// selection info
		const selection_info = render_selection_info(self)
		content_data.appendChild(selection_info)

	// element_info. Selected element information
		const element_info = render_element_info(self)
		content_data.appendChild(element_info)

	// project container
		// The filter node (component_project_filter rendered DOM) is delivered
		// asynchronously via the event 'render_component_filter_<section_tipo>'
		// that is subscribed in inspector.prototype.init().  On the very first render
		// it may not yet be available (self.component_filter_node is undefined), in
		// which case the project block is omitted entirely.  On subsequent refreshes
		// (pagination) the event fires again and update_project_container_body() is
		// called to refresh the content without re-building the block structure.
		// (!) Note that the filter node is collected from a subscribed
		// event 'render_component_filter_xx' from self inspector init event
		if (self.component_filter_node) {
			const project_block = render_project_block(self)
			content_data.appendChild(project_block)
		}

	// relation_list container (only when granted and a record is inspected)
		if (has_relation_list_access(self)) {
			const relation_list = render_relation_list(self)
			content_data.appendChild(relation_list)
		}

	// time machine blocks (Latest changes + Component history)
	// The server stamps config.time_machine_list PER PRINCIPAL: the section's
	// time_machine_list tipo when this user may read its history (SECTION_SPEC
	// §7.4 — the same decision the dd15 read gate takes), null otherwise
	// (WC-2026-10-22-tm-scope-whole-request). No grant: no block, and therefore
	// no dd15 request the server would refuse.
		render_time_machine_blocks(self, content_data)

	// activity_info
		const activity_info = render_activity_info(self)
		content_data.appendChild(activity_info)

	// buttons_bottom_container
		const buttons_bottom_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container bottom',
			parent			: content_data
		})

		// data_link . Open window to full section JSON data
		// Builds the full RQO for the current record and opens the raw API response
		// in a new tab so developers can inspect the JSON structure without leaving the
		// edit view.  Uses DEDALO_API_URL which is injected globally by the PHP template.
			const data_link = ui.create_dom_element({
				element_type	: 'button', // button block_icon light search
				class_name		: 'light eye data_link',
				text_content	: get_label.record || 'View record data',
				parent			: buttons_bottom_container
			})
			const data_link_click_handler = function(e) {
				e.stopPropagation()
				e.preventDefault()

				const url = DEDALO_API_URL.replace('json/', 'raw') + '?' + object_to_url_vars({ section_tipo : self.caller.section_tipo, section_id : self.caller.section_id })

				open_window({
					url			: url,
					features	: 'new_tab'
				})

			}
			data_link.addEventListener('mousedown', data_link_click_handler)

		// tool register files.	dd1340
		// dd1340 is the ontology tipo for 'Tool register' sections (tool scaffolding records).
		// This button downloads the raw section record as a register.json file, which is the
		// canonical serialization format for tool registration in the v7 tools architecture.
			if (self.section_tipo==='dd1340') {
				// Tag 'button' is required: the shared icon rules in buttons.less attach the
				// download.svg glyph through `button.download:before` (a bare span matches
				// neither `button&` nor `.button&`, so it rendered as flat unstyled text).
				const register_download = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'warning download register_download',
					text_content	: get_label.download_register_file || 'Download register file',
					parent			: buttons_bottom_container
				})
				const register_click_handler = async (e) => {
					e.stopPropagation()
					e.preventDefault()

					const file_name = 'register.json'

					// confirm action by user
					if (!confirm(`Download file: ${file_name} ${self.caller.section_id} ?`)) {
						return false
					}

					const data = await self.get_raw_record()

					if(data) {
						// Download record as JSON file
						download_data(data, file_name)
					}
				}
				register_download.addEventListener('mousedown', register_click_handler)
			}//end if (self.section_tipo==='dd1340')


	return content_data
}//end get_content_data



/**
* RENDER_SELECTION_INFO
* Displays the name of the currently selected element (e.g., 'Description' or 'Section Name') in the inspector header.
* Adds a 'List' navigation button when a section is selected.
* @param {Object} self - Inspector instance.
* @returns {HTMLElement} selection_info_node - The rendered selection info container.
*/
const render_selection_info = function(self) {

	// selection_info_node
		const selection_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'selection_info'
		})

		/**
		 * update_label
		 * Updates the label display and optional actions based on the new selection.
		 * Triggered on activation or rendering of sections/components.
		 * @param {Object} caller - The section or component instance selected.
		 */
		selection_info_node.update_label = function(caller) {

			if (!caller) return

			// Store reference
			self.selection_info_node.caller = caller

			const fragment = new DocumentFragment()

			// add label text
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'selection_info_label',
				text_content	: caller.label || '',
				parent			: fragment
			})

			// add button list when info is about section
			add_list_button(caller, fragment)

			// Update container content efficiently
			selection_info_node.replaceChildren(fragment)
		}

		// fix pointer
		self.selection_info_node = selection_info_node

		/**
		 * add_list_button
		 * Appends a 'Go to list' button if the caller is a section.
		 * @param {Object} caller
		 * @param {DocumentFragment|HTMLElement} parent
		 */
		const add_list_button = function(caller, parent) {
			if (caller && caller.model === 'section' && caller.session_save === true) {
				const button_list = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button light list',
					title			: get_label.list || 'List',
					parent			: parent
				})
				button_list.addEventListener('mousedown', (e) => {
					e.stopPropagation()
					// go to section in list mode
					self.caller.goto_list()
				})
			}
		}

	// exec once
		selection_info_node.update_label(self.caller)


	return selection_info_node
}//end render_selection_info



/**
* RENDER_SECTION_INFO
* Renders the technical and administrative metadata of the current section into the inspector.
* This includes typology, model, database table, record ID, and audit trail (creation, modification, publication).
* Triggered via event manager subscription 'render_' + self.caller.id.
* @param {Object} self - Inspector instance.
* @param {Object} self.caller - Section instance providing the data.
* @param {HTMLElement} self.element_info_container - Target container for the rendered info.
* @returns {DocumentFragment} fragment - The rendered metadata structure.
*/
export const render_section_info = function(self) {

	// short vars
		const container		= self.element_info_container
		const section		= self.caller

	// unsubscribe previous component value update event if exists
		if (container.update_value_event_token) {
			event_manager.unsubscribe(container.update_value_event_token)
			delete container.update_value_event_token
		}

	// values from caller (section)
		const section_tipo				= section.section_tipo
		const label						= section.label
		const mode						= section.mode
		const view						= section.view || 'default'
		const matrix_table				= section.context.matrix_table

	// DocumentFragment
		const fragment = new DocumentFragment();

	// tipo
		// label
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: get_label.tipo || 'tipo',
				parent			: fragment
			})
		// value
			const tipo_info = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value bold',
				text_content	: section_tipo,
				title			: 'Click to copy',
				parent			: fragment
			})
			tipo_info.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				if (navigator?.clipboard) {
					navigator.clipboard.writeText( section_tipo )
				}
			})

	// info
		// label
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: 'info',
				parent			: fragment
			})
		// value
			const info_container = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				parent			: fragment
			})
			// render_docu_links
			const docu_links = render_docu_links(self, section_tipo)
			info_container.appendChild(docu_links)

	// model
		// label
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: get_label.model || 'Model',
				parent			: fragment
			})
		// value
			const model_info = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: section.model,
				title			: 'Click to copy',
				parent			: fragment
			})
			model_info.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				if (navigator?.clipboard) {
					navigator.clipboard.writeText( section.model )
				}
			})

	// matrix_table
		// label
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: get_label.table || 'table',
				parent			: fragment
			})
		// value
			const matrix_table_info = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: matrix_table,
				title			: 'Click to copy',
				parent			: fragment
			})
			matrix_table_info.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				if (navigator?.clipboard) {
					navigator.clipboard.writeText( matrix_table )
				}
			})

	// section_id
		// label
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'key',
			text_content	: 'section_id',
			parent			: fragment
		})
		// value
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: section.section_id,
			parent			: fragment
		})

	// view
		// label
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'key',
			text_content	: 'View',
			parent			: fragment
		})
		// value
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: view + ' - ' + mode,
			parent			: fragment
		})

	// record info: created / modified / published
		// The values are NOT in the section read (it stays lean): load_record_info
		// fills them from their own request (dd_utils_api::get_record_info),
		// scheduled by inspector.update_section_info. NO JUMP: a cached record
		// fills here, synchronously; otherwise each row keeps the height the
		// previous render measured (or the CSS reservation on first paint) until
		// fill_record_info_nodes releases it.
		const previous_nodes	= container.record_info_nodes
		const previous_heights	= previous_nodes && previous_nodes.created?.isConnected
			? {
				created		: previous_nodes.created.offsetHeight,
				modified	: previous_nodes.modified.offsetHeight,
				published	: previous_nodes.published.offsetHeight
			  }
			: null
		const record_info_row = (name, label_text) => {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: label_text,
				parent			: fragment
			})
			const node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value record_info_value ' + name + ' loading',
				parent			: fragment
			})
			if (previous_heights?.[name] > 0) {
				node.style.minHeight = previous_heights[name] + 'px'
			}
			return node
		}
		const record_info_nodes = {
			created		: record_info_row('created', get_label.created || 'Created'),
			modified	: record_info_row('modified', get_label.modified || 'Modified'),
			published	: record_info_row('published', (get_label.published || 'Published') + ' (first/last)')
		}
		container.record_info_nodes = record_info_nodes
		const cache_key = section_tipo + '_' + parseInt(section.section_id)
		if (self.record_info_cache?.key===cache_key) {
			fill_record_info_nodes(record_info_nodes, self.record_info_cache.value)
		}

	// clean and set the section panel; the component panel keeps its nodes
		container.section_panel.replaceChildren(fragment)
		container.component_panel.classList.add('hide')
		container.section_panel.classList.remove('hide')

	// re-activate tooltips
	activate_inspector_tooltips(container.section_panel)

	return fragment
}//end render_section_info



/**
* LOAD_RECORD_INFO
* Fills the Created / Modified / Published rows rendered by render_section_info.
* The values come from their OWN request (dd_utils_api::get_record_info), sent
* after the section has rendered, so the section read never pays for them.
* A response that arrives after the inspector moved to another record (or after
* the panel re-rendered) is dropped: the nodes it was asked for are gone.
* The result is cached per record on the inspector; the 'save' and section
* render handlers clear it (inspector.js) so a change is re-read.
* @param {Object} self - Inspector instance.
* @returns {Promise<Object|null>} record_info, or null when nothing was loaded
*/
export const load_record_info = async function(self) {

	const section	= self.caller
	const nodes		= self.element_info_container?.record_info_nodes
	const id		= parseInt(section?.section_id)
	if (!nodes || section?.mode!=='edit' || !(id > 0)) {
		return null
	}
	const key = section.section_tipo + '_' + id

	let record_info = self.record_info_cache?.key===key
		? self.record_info_cache.value
		: undefined
	if (record_info===undefined) {
		try {
			const response = await data_manager.request({
				body : {
					dd_api	: 'dd_utils_api',
					action	: 'get_record_info',
					options	: {
						section_tipo	: section.section_tipo,
						section_id		: id
					}
				}
			})
			if (!response || response_data(response)!==true) {
				release_record_info_nodes(self, nodes)
				return null
			}
			record_info = response.record_info || null
			self.record_info_cache = { key, value: record_info }
		} catch (error) {
			console.warn('load_record_info failed:', error)
			release_record_info_nodes(self, nodes)
			return null
		}
	}

	// stale: the panel was re-rendered or the record changed meanwhile
	if (self.element_info_container?.record_info_nodes!==nodes
		|| section.section_tipo + '_' + parseInt(section.section_id)!==key) {
		return null
	}

	fill_record_info_nodes(nodes, record_info)

	return record_info
}//end load_record_info



/**
* RELEASE_RECORD_INFO_NODES
* A load that failed must not leave the rows reserved and blank forever: they
* fall back to the empty values ('-' / Never) — only while they are still the
* panel's current nodes.
* @param {Object} self - Inspector instance.
* @param {Object} nodes - { created, modified, published } value nodes
* @returns {void}
*/
const release_record_info_nodes = function(self, nodes) {
	if (self.element_info_container?.record_info_nodes===nodes) {
		fill_record_info_nodes(nodes, null)
	}
}//end release_record_info_nodes



/**
* FORMAT_RECORD_INFO_DATE
* 'YYYY-MM-DD HH:MM:SS' (Dédalo wall-clock, as the server stamps it) →
* 'DD-MM-YYYY HH:MM:SS', the form the inspector has always shown.
* @param {string|null} date
* @returns {string|null}
*/
export const format_record_info_date = function(date) {
	if (typeof date!=='string' || date==='') {
		return null
	}
	const match = date.match(/^(-?\d{1,})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/)
	if (!match) {
		return date
	}
	return match[3] + '-' + match[2] + '-' + match[1] + (match[4] ? ' ' + match[4] : '')
}//end format_record_info_date



/**
* FILL_RECORD_INFO_NODES
* Writes record_info into the three value nodes. Text nodes only — user names
* are data, never markup. A row that was waiting on screen gets 'fade_in'.
* @param {Object} nodes - { created, modified, published } value nodes
* @param {Object|null} record_info - get_record_info payload
* @returns {void}
*/
export const fill_record_info_nodes = function(nodes, record_info) {

	const lines_of = (event) => event
		? [format_record_info_date(event.date), event.user_name || (event.user_id ? '#' + event.user_id : null)]
		: []
	const set_lines = (node, lines, fallback) => {
		const values = lines.filter(Boolean)
		node.replaceChildren()
		if (values.length===0) {
			node.textContent = fallback
			return
		}
		values.forEach((value, index) => {
			if (index > 0) {
				node.appendChild(document.createElement('br'))
			}
			node.appendChild(document.createTextNode(value))
		})
	}

	// a row that waited on screen fades its values in; one filled before attach
	// (the cache path of render_section_info) shows at once
	for (const node of [nodes.created, nodes.modified, nodes.published]) {
		const fade = node.classList.contains('loading') && node.isConnected
		node.classList.remove('loading')
		node.classList.toggle('fade_in', fade)
		node.style.minHeight = ''
	}

	set_lines(nodes.created, lines_of(record_info?.created), '-')
	set_lines(nodes.modified, lines_of(record_info?.modified), '-')

	const publication = record_info?.publication || {}
	const state_label = publication.state==='unpublished'
		? (get_label.unpublished || 'Unpublished')
		: publication.state==='pending'
			? (get_label.publication_withdrawal_pending || 'Withdrawal pending')
			: null
	set_lines(
		nodes.published,
		[
			...lines_of(publication.first),
			...lines_of(publication.last),
			state_label
		],
		get_label.never || 'Never'
	)
}//end fill_record_info_nodes



/**
* BUILD_COMPONENT_PANEL
* Creates the component info rows (tipo, info, model, translatable, view, data)
* ONCE per inspector render, inside container.component_panel. Selecting another
* component only patches these nodes (render_component_info) — no row, no Data box
* and no collapse state is rebuilt, so the blocks below the panel do not move.
* Handlers read self.actived_component at event time, never a captured component.
* The Data box has a fixed, user-resizable height (resize: vertical) persisted
* under DATA_HEIGHT_KEY ('status' table); self._data_height was read in edit()
* before first paint.
* @param {Object} self - Inspector instance.
* @param {HTMLElement} container - self.element_info_container
* @returns {Object} nodes - stored as container.component_info_nodes
*/
const build_component_panel = function(self, container) {

	const panel = container.component_panel

	// copy-on-click value row
		const copy_on_click = (node, get_value) => {
			node.title = 'Click to copy'
			node.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				const value = get_value()
				if (value && navigator?.clipboard) {
					navigator.clipboard.writeText( value )
				}
			})
		}

	// key/value row builder
		const add_row = (key_text, value_class='value') => {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'key',
				text_content	: key_text,
				parent			: panel
			})
			return ui.create_dom_element({
				element_type	: 'span',
				class_name		: value_class,
				parent			: panel
			})
		}

	const nodes = {}

	// tipo
		nodes.tipo = add_row('tipo', 'value bold')
		copy_on_click(nodes.tipo, () => self.actived_component?.tipo)

	// info (docu links, the only part rebuilt per selection)
		nodes.info = add_row('info')

	// model
		nodes.model = add_row(get_label.model || 'Model')
		copy_on_click(nodes.model, () => self.actived_component?.model)

	// translatable
		nodes.translatable = add_row(get_label.translatable || 'Translatable')

	// view
		nodes.view = add_row('View')

	// data label (toggler + copy button)
		nodes.data_label = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'key wide icon_arrow data_label',
			parent			: panel
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'data_label_text',
			text_content	: get_label.data || 'Data',
			parent			: nodes.data_label
		})
		// icon-only copy button (label in title / aria-label); flashes .copied
		nodes.copy_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_value_copy hide',
			title			: get_label.copy || 'Copy',
			parent			: nodes.data_label
		})
		nodes.copy_button.setAttribute('aria-label', get_label.copy || 'Copy')
		let copied_timer = null
		nodes.copy_button.addEventListener('click', (e) => {
			// do not toggle the Data block
			e.stopPropagation()
			if (navigator?.clipboard) {
				const entries = self.actived_component?.data?.entries || []
				navigator.clipboard.writeText( JSON.stringify(entries) )
				nodes.copy_button.classList.add('copied')
				clearTimeout(copied_timer)
				copied_timer = setTimeout(() => nodes.copy_button.classList.remove('copied'), 1200)
			}
		})

	// data box. Fixed height (CSS default 10rem), resizable, persisted
		nodes.data_box = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value wide code monospace hide',
			parent			: panel
		})
		if (self._data_height) {
			nodes.data_box.style.height = self._data_height
		}
		nodes.data_text = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value_text',
			parent			: nodes.data_box
		})
		// dblclick: fit content / back to the user height (not persisted)
		nodes.data_box.addEventListener('dblclick', (e) => {
			e.stopPropagation()
			nodes.data_box.classList.toggle('auto_height')
		})
		// persist the dragged height. `resize: vertical` fires no event of its own;
		// the ResizeObserver is the one signal there is (it also fires on layout,
		// hide and auto_height — those are skipped).
		if (typeof ResizeObserver!=='undefined') {
			let save_timer = null
			container.data_resize_observer = new ResizeObserver(() => {
				clearTimeout(save_timer)
				save_timer = setTimeout(() => {
					const box = nodes.data_box
					if (!box.isConnected || box.classList.contains('hide') || box.classList.contains('auto_height')) {
						return
					}
					const h = box.offsetHeight
					if (h<=0) {
						return
					}
					const value = h + 'px'
					// first layout at the CSS default: nothing chosen yet, nothing to save
					if (value===self._data_height || (!self._data_height && !box.style.height)) {
						return
					}
					self._data_height = value
					data_manager.set_local_db_data({ id: DATA_HEIGHT_KEY, value }, 'status')
				}, 300)
			})
			container.data_resize_observer.observe(nodes.data_box)
		}

	// track collapse toggle state of the Data box (once per inspector render)
		ui.collapse_toggle_track({
			toggler				: nodes.data_label,
			container			: nodes.data_box,
			collapsed_id		: 'inspector_component_value',
			collapse_callback	: () => nodes.data_label.classList.remove('up'),
			expose_callback		: () => nodes.data_label.classList.add('up'),
			default_state		: 'closed'
		})

	container.component_info_nodes = nodes

	return nodes
}//end build_component_panel



/**
* FILL_COMPONENT_DATA
* Writes the selected component entries into the Data box (JSON, monospace).
* Empty data shows a muted 'Empty' notice; more than DATA_MAX_ENTRIES shows a
* size notice (e.g. component_security_access) but keeps the copy button.
* @param {Object} nodes - container.component_info_nodes
* @param {Object} component - Component instance.
* @returns {void}
*/
const fill_component_data = function(nodes, component) {

	const entries = component.data?.entries || []

	if (entries.length > DATA_MAX_ENTRIES) {
		nodes.data_text.textContent = `Data is too big for display (${entries.length} entries)`
		nodes.data_box.classList.add('notice')
		nodes.copy_button.classList.remove('hide')
		return
	}

	if (entries.length===0) {
		nodes.data_text.textContent = get_label.empty || 'Empty'
		nodes.data_box.classList.add('notice')
		nodes.copy_button.classList.add('hide')
		return
	}

	// one block per JSON line with a hanging indent (padding = own indent + 2ch,
	// text-indent -2ch): a long value that wraps continues under its key, not at
	// column 0. Copy reads the entries, never this text.
	const fragment = new DocumentFragment()
	const lines = JSON.stringify(entries, null, 1).split('\n')
	for (const line of lines) {
		const indent = line.length - line.trimStart().length
		const line_node = document.createElement('span')
		line_node.className = 'json_line'
		line_node.style.paddingLeft = (indent + 2) + 'ch'
		line_node.textContent = line.slice(indent)
		fragment.appendChild(line_node)
	}
	nodes.data_text.replaceChildren(fragment)
	nodes.data_box.classList.remove('notice')
	nodes.copy_button.classList.remove('hide')
}//end fill_component_data



/**
* RENDER_COMPONENT_INFO
* Shows metadata and current data of the selected component in the inspector.
* The panel is built once (build_component_panel) and PATCHED here on every
* selection, so the Data box keeps its node, height and collapse state and the
* blocks below it do not jump. Subscribes to the component value updates.
* @param {Object} self - Inspector instance.
* @param {Object} component - Component instance to display.
* @returns {HTMLElement} container.component_panel
*/
export const render_component_info = function(self, component) {

	const container	= self.element_info_container
	const nodes		= container.component_info_nodes || build_component_panel(self, container)

	// values from caller (section)
		const tipo			= component.tipo
		const view			= component.view || 'default'
		const translatable	= component.context?.translatable
			? JSON.stringify(component.context.translatable)
			: 'no'

	// patch values
		nodes.tipo.textContent			= tipo
		nodes.model.textContent			= component.model
		nodes.translatable.textContent	= translatable
		nodes.view.textContent			= view + ' - ' + component.mode
		nodes.info.replaceChildren( render_docu_links(self, tipo) )

	// data. Synchronous on selection (capped at DATA_MAX_ENTRIES, cheap) so no
	// placeholder pass; value updates refresh it on idle.
		fill_component_data(nodes, component)
		nodes.data_box.scrollTop = 0

	// event subscribe
		if (container.update_value_event_token) {
			// unsubscribe previous component subscription
			event_manager.unsubscribe(container.update_value_event_token)
		}
		// store subscription token on container to allow clean it when section info is rendered or new component selected
		container.update_value_event_token = event_manager.subscribe(
			'update_value_'+ component.id_base,
			() => dd_request_idle_callback(() => fill_component_data(nodes, component))
		)

	// show component panel
		container.section_panel.classList.add('hide')
		container.component_panel.classList.remove('hide')

	// activate tooltips (new docu links only; active ones are skipped)
	activate_inspector_tooltips(nodes.info)


	return container.component_panel
}//end render_component_info




/**
* RENDER_ELEMENT_INFO
* Builds the collapsible "Info" block in the inspector.  The block header is
* rendered immediately; the body (element_info_body) starts empty and is
* populated on demand by render_section_info() or render_component_info() when
* the user focuses a component or the section re-renders.
*
* A pointer to the body element is stored as self.element_info_container so
* that inspector.js event handlers (activate_component, render_) can locate
* the target node without searching the DOM.
*
* (!) Note: the comment in the original source contains a typo:
* 'self.element_info_containe' — the actual property name is
* 'self.element_info_container'.  Flagged but not fixed (doc-only rule).
*
* @param {Object} self - Inspector instance. self.element_info_container is set
*   to the body element as a side effect.
* @returns {HTMLElement} element_info_wrap - The block wrapper containing the
*   collapsible head and the (initially empty) body.
*/
const render_element_info = function(self) {

	// wrapper
	const element_info_wrap = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'element_info_wrap'
	})
	element_info_wrap.addEventListener('mousedown', function(e) {
		// prevents deactivate selected component when user clicks the inspector
		e.stopPropagation()
	})

	// element_info_head
		const element_info_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'element_info_head label icon_arrow up',
			parent			: element_info_wrap
		})
		decorate_block_header(element_info_head, 'info', get_label.information || "Info")

	// element_info_container (body)
		const element_info_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'element_info hide',
			parent			: element_info_wrap
		})
		// fix pointer to node placeholder
		self.element_info_container = element_info_body

	// two persistent panels (display: contents — rows stay on the body grid):
	// render_section_info fills section_panel, render_component_info patches
	// component_panel (built once on the first selection). Switching between
	// them only toggles 'hide'.
		element_info_body.section_panel = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_panel section_panel',
			parent			: element_info_body
		})
		element_info_body.component_panel = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_panel component_panel hide',
			parent			: element_info_body
		})

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: element_info_head,
			container			: element_info_body,
			collapsed_id		: 'inspector_element_info_block',
			collapse_callback	: collapse,
			expose_callback		: expose
		})
		function collapse() {
			element_info_head.classList.remove('up')
		}
		function expose() {
			element_info_head.classList.add('up')
		}


	return element_info_wrap
}//end render_element_info



/**
* RENDER_PROJECT_BLOCK
* Builds the collapsible "Project" block in the inspector.  The block body hosts
* the component_project_filter widget, which lets the user select which projects
* the current record belongs to.
*
* The filter node itself (self.component_filter_node) is delivered asynchronously
* via the 'render_component_filter_<section_tipo>' event subscribed in
* inspector.prototype.init().  This function calls update_project_container_body()
* immediately (in case the node is already available) and stores the body element
* pointer as self.project_container_body so that subsequent event firings can
* refresh the content via update_project_container_body().
*
* @param {Object} self - Inspector instance. Must have self.component_filter_node
*   available (may be undefined on first call).  self.project_container_body is
*   set as a side effect.
* @returns {HTMLElement} project_wrap - The block wrapper element.
*/
const render_project_block = function(self) {

	// wrap
		const project_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'project_wrap'
		})

	// project_head
		const project_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'project_head icon_arrow up',
			parent			: project_wrap
		})
		decorate_block_header(project_head, 'gear', get_label.project || "Project")

	// project container
		const project_container_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'project_container hide',
			parent			: project_wrap
		})
		// fix project_container_body
		self.project_container_body = project_container_body
		// component_filter_node (collected in inspector init event 'render_component_filter_xx')
		update_project_container_body(self)

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: project_head,
			container			: project_container_body,
			collapsed_id		: 'inspector_project_block',
			collapse_callback	: collapse,
			expose_callback		: expose
		})
		function collapse() {
			project_head.classList.remove('up')
		}
		function expose() {
			project_head.classList.add('up')
		}


	return project_wrap
}//end render_project_block



/**
* UPDATE_PROJECT_CONTAINER_BODY
* Updates the project filter container by replacing its content with the current filter node.
* This is typically called after the component filter has been initialized or updated.
* @param {Object} self - Inspector instance.
* @param {HTMLElement} self.project_container_body - Target body container for the project filter.
* @param {HTMLElement} self.component_filter_node - The filter DOM node to display.
* @returns {boolean} Success status.
*/
export const update_project_container_body = function(self) {

	if (!self.project_container_body || !self.component_filter_node) {
		return false
	}

	// Replace all children with the new filter node (modern and efficient)
	self.project_container_body.replaceChildren(self.component_filter_node)

	return true
}//end update_project_container_body



/**
* HAS_RELATION_LIST_ACCESS
* Whether the inspector offers the Relations block: the server stamps
* config.relation_list_tipo per principal (WC-2026-10-27-relation-list-grant-stamp,
* null = not granted), and a record-less edit view has nothing to list.
* @param {Object} self - Inspector instance.
* @returns {boolean}
*/
export const has_relation_list_access = function(self) {
	const tipo = self.caller?.context?.config?.relation_list_tipo
	return typeof tipo==='string' && tipo.length>0 && has_inspected_record(self)
}//end has_relation_list_access



/**
* HAS_INSPECTED_RECORD
* True when the inspector's caller resolved a record. An edit view on a missing
* id has none: every record-bound block (Relations, Latest changes, Component
* history, duplicate / delete) would query or act on a null record.
* 0 is a legitimate id, so the test is explicit.
* @param {Object} self - Inspector instance.
* @returns {boolean}
*/
export const has_inspected_record = function(self) {
	const section_id = self.caller?.section_id
	return section_id!==null && section_id!==undefined && section_id!==''
}//end has_inspected_record



/**
* RENDER_RELATION_LIST
* Builds the relations section for the inspector.
* Handles lazy loading and collapsing of the relation list.
* @param {Object} self - Inspector instance.
* @returns {HTMLElement} relation_list_container - The rendered relation list structure.
*/
export const render_relation_list = function(self) {

	// wrapper
		const relation_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_container'
		})

	// relation_list_head
		const relation_list_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_head icon_arrow',
			parent			: relation_list_container
		})
		decorate_block_header(relation_list_head, 'link', get_label.relations || "Relations")

	// relation_list_body
		const relation_list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_body hide',
			parent			: relation_list_container
		})

	// relation_list events
	// panel_instance. The paginator channel is keyed by section_tipo, not by
	// instance: a delete dialog (or any other panel for the same section) hears
	// this panel's page turns too. Only the instance rendered HERE may be
	// refreshed here.
		let panel_instance = null

	// Page turns ride the container's own load slot (`load_block` uses the same
	// one): a save/re-render reload and a turn therefore cannot swap the same
	// content_data node concurrently.

		/**
		 * fn_relation_list_paginator
		 * Callback for relation list pagination events.
		 */
		const fn_relation_list_paginator = function(relation_list) {

			if (relation_list !== panel_instance) {
				return
			}

			// A page turn refreshes IN PLACE (content only): the wrapper — and the
			// paginator strip inside it — stays mounted, the strip repaints its
			// range, and the rows swap under paginator.paginate's height FLIP
			// (smooth_page_swap), the same motion Latest changes has. load_block
			// would clear the body and rebuild the whole wrapper (strip included),
			// which is what made the block jump.
				relation_list_body.setAttribute('aria-busy', 'true')
				relation_list_body.classList.add('loading')
				const previous = relation_list_body._block_load
				const turn = (previous ? previous.catch(() => null) : Promise.resolve())
					.then(async () => {
						// a refused/failed read (build false) takes the recovery path below
						if (await relation_list.build()===false) {
							throw relation_list.build_error || new Error('relation_list build failed')
						}
						await relation_list.render({ render_level: 'content' })
						if (relation_list.paginator) {
							await relation_list.paginator.render({ render_level: 'content' })
						}
					})
					.catch((error) => {
						console.error('[render_inspector] relation page turn failed:', error)
						// A failed turn must not leave the strip locked with the page
						// already advanced: release the container slot (the fallback
						// load_block would otherwise wait on THIS turn, which is
						// waiting on the fallback) and hand back to the full loader —
						// it retries, or paints the engine's error panel.
						if (relation_list_body._block_load === turn) {
							relation_list_body._block_load = null
						}
						return load_relation_list({ reload: true })
					})
					.finally(() => {
						relation_list_body.classList.remove('loading')
						relation_list_body.removeAttribute('aria-busy')
					})
					.catch(() => null) // a failed recovery is already painted, not rethrown
				relation_list_body._block_load = turn
				turn.finally(() => {
					if (relation_list_body._block_load === turn) {
						relation_list_body._block_load = null
					}
				})
		}
		self.events_tokens.push(
			event_manager.subscribe('relation_list_paginator_'+self.section_tipo, fn_relation_list_paginator)
		)

		/**
		 * fn_updated_section
		 * Triggered after section pagination to force relation list update if open.
		 */
		const fn_updated_section = function() {
			const is_open = !relation_list_body.classList.contains('hide')
			if (is_open) {
				// the section re-rendered (pagination / record change): refresh
				load_relation_list({ reload: true })
			}
		}
		self.events_tokens.push(
			event_manager.subscribe('render_' + self.caller.id, fn_updated_section)
		)

	// track collapse toggle state of content
		/**
		 * load_relation_list
		 * Asynchronously loads and renders the list of relations (first open, or a
		 * save/section reload). A page turn refreshes in place and never comes here.
		 * @param {Object} [options]
		 * @param {boolean} [options.reload=false] - force a fresh read
		 */
		const load_relation_list = async function(options = {}) {

			relation_list_head.classList.add('up')

			const relation_list_tipo = self.caller.context?.config?.relation_list_tipo

			// the placeholder covers the whole load. `key` is the record: a
			// re-open of the SAME record reuses what is displayed. A PAGE TURN never
			// comes through here — fn_relation_list_paginator refreshes in place.
			return load_block({
				container	: relation_list_body,
				label		: get_label.relations || 'Relations',
				key			: block_key(self),
				reload		: options.reload===true,
				task		: async () => {

					const relation_list = await get_instance({
						model			: 'relation_list',
						tipo			: relation_list_tipo,
						section_tipo	: self.caller.section_tipo,
						section_id		: self.caller.section_id,
						mode			: self.mode
					})

					const built = await relation_list.build()

					// a refused/failed read paints the quiet block line, never an empty panel
					if (built===false) {
						return render_block_failure(get_label.relations || 'Relations', relation_list.build_error || null)
					}

					// the rendered node replaces the placeholder
					panel_instance = relation_list
					return relation_list.render()
				}
			})
		}

		/**
		 * collapse
		 * Resets the disclosure state only. The rendered list is KEPT so a re-open
		 * reuses it (load_block's key); the forced paths — a section re-render —
		 * still reload it. A page turn refreshes the mounted content in place.
		 */
		const collapse = function() {
			relation_list_head.classList.remove('up')
		}

		ui.collapse_toggle_track({
			toggler				: relation_list_head,
			container			: relation_list_body,
			collapsed_id		: 'inspector_relation_list',
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'closed'
		})

		function expose() {
			// no idle deferral: the loading placeholder must land on the click tick
			load_relation_list()
		}

	return relation_list_container
}//end render_relation_list



/**
* HAS_TIME_MACHINE_ACCESS
* Whether the inspected section's context grants this user the inspector
* history (config.time_machine_list, stamped per principal by the server).
* @param {Object} self - Inspector instance.
* @returns {boolean}
*/
export const has_time_machine_access = function(self) {
	const value = self.caller?.context?.config?.time_machine_list
	return typeof value==='string' && value.length>0
}//end has_time_machine_access



/**
* RENDER_TIME_MACHINE_BLOCKS
* Appends the Latest changes + Component history blocks to the inspector body
* ONLY when the server granted this user the section's history
* (has_time_machine_access) and the caller resolved a record
* (has_inspected_record). Otherwise nothing is appended, so neither loader
* ever finds a container and no dd15 request is sent.
* @param {Object} self - Inspector instance.
* @param {HTMLElement} content_data - the inspector body
* @returns {boolean} whether the blocks were rendered
*/
export const render_time_machine_blocks = function(self, content_data) {

	if (!has_time_machine_access(self) || !has_inspected_record(self)) {
		return false
	}

	// time_machine_list container
		content_data.appendChild( render_time_machine_list(self) )

	// component_history container
		content_data.appendChild( render_component_history(self) )

	return true
}//end render_time_machine_blocks



/**
* RENDER_BLOCK_FAILURE
* The QUIET panel-local answer for a time machine block whose dd15 instance
* failed to build: one small muted line inside the block. Never the page-level
* no-access panel and never a Home link — a side panel that cannot load must
* not look like the page failed. The request_id rides in the tooltip only (the
* join key with the server log).
* @param {string} label - the block label ('Latest changes', ...)
* @param {Object|null} api_error - the instance's build_error, when known
* @returns {HTMLElement}
*/
export const render_block_failure = function(label, api_error) {

	const reason	= api_error ? error_text(api_error) : ''
	const node		= ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'inspector_block_failure',
		text_content	: reason ? label + ': ' + reason : label
	})
	if (api_error?.request_id) {
		node.title = 'request_id: ' + api_error.request_id
	}

	return node
}//end render_block_failure



/**
* RENDER_TIME_MACHINE_LIST
* Builds the collapsible "Latest changes" block in the inspector.  When the user
* opens (exposes) the block, load_time_machine_list() runs immediately (the
* loading placeholder lands on the click tick) to lazily load the tm_list
* instance that renders a mini grid of recent component-value changes across
* the whole section.
*
* The time_machine_list_body element pointer is stored as
* self.time_machine_list_container so that load_time_machine_list() can locate
* it without searching the DOM and can guard against loading when the block is
* collapsed (is_open check).
*
* Note: the commented-out event subscription block below the head would have
* refreshed the list on every section pagination ('render_' + self.caller.id).
* It was disabled in favour of the lazy expose approach.
*
* @param {Object} self - Inspector instance. self.time_machine_list_container is
*   set to the body element as a side effect.
* @returns {HTMLElement} time_machine_list_wrap - The block wrapper element.
*/
export const render_time_machine_list = function(self) {

	// wrapper
		const time_machine_list_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'time_machine_list'
		})

	// time_machine_list_head
		const time_machine_list_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'time_machine_list_head icon_arrow',
			parent			: time_machine_list_wrap
		})
		decorate_block_header(time_machine_list_head, 'history', get_label.latest_changes || 'Latest changes')

	// time_machine_list_body
		const time_machine_list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'time_machine_list_body hide',
			parent			: time_machine_list_wrap
		})
		// fix pointer to node placeholder
		self.time_machine_list_container = time_machine_list_body

	// time_machine_list events subscription
		// self.events_tokens.push(
		// 	event_manager.subscribe('render_' + self.caller.id, fn_updated_section)
		// )
		// function fn_updated_section(){
		// 	// triggered after section pagination, it forces relation list update
		// 	const is_open = !time_machine_list_body.classList.contains('hide')
		// 	if (is_open) {
		// 		load_time_machine_list()
		// 	}
		// }

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: time_machine_list_head,
			container			: time_machine_list_body,
			collapsed_id		: 'inspector_time_machine_list',
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'closed'
		})
		function collapse() {
			time_machine_list_head.classList.remove('up')
		}
		function expose() {
			// no idle deferral: the loading placeholder must land on the click tick
			load_time_machine_list(self)
			time_machine_list_head.classList.add('up')
		}


	return time_machine_list_wrap
}//end render_time_machine_list



/**
* LOAD_TIME_MACHINE_LIST
* Lazily instantiates and renders the tm_list for the entire
* section (all components, all users) in a compact 'mini' view.
*
* Render contract:
*   - Returns null immediately when the container is collapsed ('hide' class present)
*     to avoid redundant API calls on background refreshes.
*   - Destroys the previous tm_list instance (if any) before creating a
*     new one, to avoid accumulating orphaned instances across pagination.
*   - Guards against inspector destruction during the await: if self.status becomes
*     'destroyed' while the get_instance promise resolves, the freshly-created
*     service is destroyed and null is returned.
*
* Called from:
*   - render_time_machine_list expose_callback (user opens the block)
*   - inspector.prototype.init save_handler (after any component save)
*   - inspector.js update_section_info (after section pagination)
*
* ddo_map note: dd1574 is the generic time-machine value ontology item.
*   model is set to 'dd_grid' (rather than the real component model) to allow
*   identification and special rendering by tm_list.
*
* @param {Object} self - Inspector instance. Must have self.time_machine_list_container,
*   self.caller (section), and self.section_tipo populated.
* @returns {Promise<HTMLElement|null>} The rendered list node on success, or null
*   when loading was skipped (collapsed container).
*/
export const load_time_machine_list = async function(self, options = {}) {

	// container. Prevent to load data when the viewer is collapsed
	// (!) merged with LOAD_TIME_MACHINE_LIST_RUN: the guard, then the shared
	// block-loading contract (placeholder + spinner + serialization).
		const container	= self.time_machine_list_container
		const is_open	= container && !container.classList.contains('hide')
		if (!is_open) {
			return null
		}

	// SERIALIZED by load_block on this container. Two independent triggers (the
	// expose callback and the 'save' / update_section_info callbacks) can fire in
	// the same frame; running them in parallel means the second load destroys
	// self.tm_list — nullifying the caller of every section_record it owns — while
	// the first call's row render is still awaiting its columns.
	// `reload` is how the save / section-render callers say the data moved; a bare
	// re-open of the block passes nothing and reuses what is displayed.
	return load_block({
		container	: container,
		label		: get_label.latest_changes || 'Latest changes',
		key			: block_key(self),
		reload		: options.reload===true,
		task		: () => load_time_machine_list_instance(self)
	})
}//end load_time_machine_list



/**
* LOAD_TIME_MACHINE_LIST_INSTANCE
* The actual list build/render, behind the loading placeholder installed by
* load_time_machine_list.
* @param {Object} self - Inspector instance.
* @returns {Promise<HTMLElement>} the rendered list node
*/
const load_time_machine_list_instance = async function(self) {

	// (!) Note that expose is called on each section pagination, whereby must be generated
	// even if user close and re-open the time_machine_list inspector tab

	// destroy previous service to avoid instance leaks across pagination events
		if (self.tm_list) {
			await self.tm_list.destroy(
				true, // delete_self
				true // delete_dependencies
			)
		}

	// The record-history list is an ordinary dd15 `section` instance — the same
	// machinery the section list uses everywhere else
	// (WC-2026-08-14-tm-scope-server-owned). It sends NO ddo_map: the SERVER
	// derives the columns from the named surface, so this panel cannot widen its
	// own list and cannot drift from what the tool shows.
		const tm_list = await get_instance({
			model			: 'section',
			tipo			: 'dd15',
			section_tipo	: 'dd15',
			mode			: 'list',
			// (!) the RECORD IDENTITY is part of the key: get_instance returns a
			// cached instance IGNORING fresh options, so a key without the
			// section_id would keep serving the PREVIOUS record's history after
			// paginating the section (the old service carried section_id in its
			// options for exactly this reason).
			id_variant		: self.caller.section_tipo + '_' + self.caller.section_id + '_tm_list',
			caller			: self,
			caller_tipo		: self.caller.section_tipo,
			// An embedded side panel: no toolbar, no search, and no synthetic Id
			// column — this block never had one.
			buttons			: false,
			filter			: false,
			// EMBEDDED reads never touch the dd15 SESSION SQO. All four TM surfaces
			// share callerTipo 'dd15', so a saving read here would persist its
			// one-record filter into the session and the standalone dd15 browse
			// would merge it back — showing "only a few records" with no error.
			session_save	: false,
			request_config	: [{
				api_engine	: 'dedalo',
				type		: 'main',
				// (!) sqo.mode 'tm' is the ROW SOURCE — it routes the read to
				// matrix_time_machine. Never 'list': that returns the section's LIVE
				// records instead of its history, silently.
				sqo			: {
					id			: 'section_history',
					mode		: 'tm',
					section_tipo: [self.caller.section_tipo],
					limit		: 10,
					offset		: 0,
					order		: [{ direction : 'DESC', path : [{ component_tipo : 'id' }] }],
					skip_projects_filter : true,
					filter_by_locators : [{
						section_tipo	: self.caller.section_tipo,
						section_id		: self.caller.section_id
					}]
				},
				show		: {}
			}],
		})
		// names WHICH block this is; the server maps it to columns. `source_add` is
		// the sanctioned way to extend the request source (common.js create_source);
		// a bare instance option is never forwarded onto the wire.
		tm_list.source_add		= { tm_surface : 'inspector_record' }
		tm_list.tm_no_id_column	= true
		// the compact inspector shape (orange date line over the value), not the
		// full-width section grid — see section/css/view_tm_list_section.less
		tm_list.tm_view				= 'mini'
		tm_list.tm_template_columns	= '1fr 1.5fr 2fr'

		const built = await tm_list.build(true)

	// set new tm_list (kept even when failed: the next load destroys it)
		self.tm_list = tm_list

	// a failed build is never rendered: render() of a failed dd15 instance
	// paints the page-level error surface inside this side panel
		if (built===false) {
			return render_block_failure(get_label.latest_changes || 'Latest changes', tm_list.build_error || null)
		}

	// the rendered node replaces the placeholder (load_block contract)
	return tm_list.render()
}//end load_time_machine_list_instance



/**
* RENDER_COMPONENT_HISTORY
* Renders the structure for the component history section in the inspector.
* This container will hold the time machine service list for the active component.
* Note that self.element_info_container is fixed to allow inspector init event
* to locate the target node when is invoked.
* @param {Object} self - Inspector instance.
* @returns {HTMLElement} component_history_wrap - The rendered history structure.
*/
const render_component_history = function(self) {

	// wrapper
		const component_history_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'component_history'
		})
		component_history_wrap.addEventListener('mousedown', function(e) {
			// prevents deactivate selected component when user clicks the inspector
			e.stopPropagation()
		})

	// component_history_head
		const component_history_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'component_history_head icon_arrow',
			parent			: component_history_wrap
		})
		decorate_block_header(component_history_head, 'note', get_label.component_history || 'Component history')

	// component_history_body
		const component_history_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'component_history_body hide',
			parent			: component_history_wrap
		})
		// fix pointer to node placeholder
		self.component_history_container = component_history_body

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: component_history_head,
			container			: component_history_body,
			collapsed_id		: 'inspector_component_history_block',
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'closed'
		})
		function collapse() {
			component_history_head.classList.remove('up')
		}
		function expose() {
			// no idle deferral: the loading placeholder must land on the click tick
			load_component_history(self, self.actived_component)
			component_history_head.classList.add('up')
		}


	return component_history_wrap
}//end render_component_history



/**
* LOAD_COMPONENT_HISTORY
* Asynchronously initializes and renders the time machine history and annotation
* notes for a specific component.  Combines two ddo_map entries:
*   1. The selected component itself (a LIST cell of dd15) — its value at each
*      historical record.
*   2. An annotation component (rsc329 in section_tipo rsc832) — a text_area that
*      stores user notes attached to each time-machine entry.
*
* Guard conditions (returns null and clears the container):
*   - component is null/falsy: clears the container (called when section re-renders
*     with no active component).
*   - component.section_tipo !== self.section_tipo: skips update for components
*     belonging to modal/nested sections that share the event bus.
*   - Container is collapsed ('hide' class): skips the API call until the user opens
*     the block.
*   - Inspector is destroyed after the await: cleans up the fresh instance.
*
* Called from:
*   - render_component_history expose_callback (user opens the block)
*   - inspector.prototype.init activate_component_handler (user clicks a component)
*   - inspector.prototype.init save_handler (after saving the active component)
*
* @param {Object} self - Inspector instance with self.component_history_container
*   and self.section_tipo set.
* @param {Object|null} component - The component instance to show history for,
*   or null to clear the container.
* @returns {Promise<HTMLElement|null>} The rendered history node on success, or null.
*/
export const load_component_history = async function(self, component, options = {}) {

	// container
		const container	= self.component_history_container

	// prevent load the component data when component is not selected
		if(!component) {
			// remove previous node if exists pointer
			if (container) {
				container.replaceChildren()
				delete container.component_history_wrap
				// the container is empty again: its cached identity must go with the
				// content, or the next activation of that component would 'reuse'
				// nothing
				container._block_key = null
			}
			// destroy the previous list too: record navigation lands here first
			// (update_section_info resets actived_component), and the stale
			// instance would otherwise stay registered until the next activation
			if (self.component_history_list) {
				await self.component_history_list.destroy(true, true)
				self.component_history_list = null
			}
			return null
		}

	// prevent to affect modals: components in nested/modal sections fire the same
	// 'activate_component' event on the shared event bus, but should not update
	// the inspector of a different section.
		if (component.section_tipo!==self.section_tipo) {
			return null
		}

	// container. Prevent to load data when the viewer is collapsed
		const is_open = container && !container.classList.contains('hide')
		if (!is_open) {
			return null
		}

	// the shared block-loading contract: placeholder + spinner + serialization.
	// Serialized per container: this loader is keyed by COMPONENT, so a fast
	// A→B activation must run A then B in order — no concurrent builds of the
	// shared dd15 instance, and self.component_history_list ends on B.
	// `key` is record + component + lang: re-activating what is already displayed
	// reuses it; `reload:true` (a save of this component) asks for it again.
	return load_block({
		container	: container,
		label		: get_label.component_history || 'Component history',
		key			: block_key(self) + '_' + component.tipo + '_' + component.lang,
		reload		: options.reload===true,
		task		: () => load_component_history_instance(self, component)
	})
}//end load_component_history



/**
* LOAD_COMPONENT_HISTORY_INSTANCE
* The actual list build/render, behind the loading placeholder installed by
* load_component_history. Never call directly.
* @param {Object} self - Inspector instance.
* @param {Object} component - the component to show history for.
* @returns {Promise<HTMLElement>} the rendered history node
*/
const load_component_history_instance = async function(self, component) {

	// destroy previous list to avoid instance leaks across navigation events
		if (self.component_history_list) {
			await self.component_history_list.destroy(
				true, // delete_self
				true // delete_dependencies
			)
			self.component_history_list = null
		}

	// The component-history list is an ordinary dd15 `section` instance
	// (WC-2026-08-14-tm-scope-server-owned) — same machinery as the tool's list
	// and the section list, no private list service.
	// (!) load_component_history is called on each section pagination, so it must
	// be generated even if the user closed and re-opened the inspector tab.
		const tm_list	= await get_instance({
			model			: 'section',
			tipo			: 'dd15',
			section_tipo	: 'dd15',
			mode			: 'list',
			// record identity in the key — see the record-history note above
			id_variant		: component.tipo +'_'+ self.caller.section_tipo +'_'+ self.caller.section_id + '_tm_list',
			caller			: self,
			caller_tipo		: component.tipo,
			buttons			: false,
			filter			: false,
			session_save	: false,
			request_config	: [{
				api_engine	: 'dedalo',
				type		: 'main',
				sqo			: {
					id			: 'component_history_' + component.tipo,
					mode		: 'tm',
					// (!) the RECORD being inspected — self.caller, not self: the
					// inspector's own section_tipo/section_id are its panel identity,
					// not the row whose history this is. The deleted service read the
					// same two values off its caller.
					section_tipo: [self.caller.section_tipo],
					limit		: 10,
					offset		: 0,
					order		: [{ direction : 'DESC', path : [{ component_tipo : 'id' }] }],
					skip_projects_filter : true,
					filter_by_locators : [{
						section_tipo	: self.caller.section_tipo,
						section_id		: self.caller.section_id,
						tipo			: component.tipo,
						lang			: component.lang
					}]
				},
				show		: {}
			}],
		})
		tm_list.source_add		= { tm_surface : 'inspector_component' }
		tm_list.tm_no_id_column	= true
		// no header row: every row here is the SAME component, so a repeated
		// column header is noise in a 300px panel
		tm_list.tm_view				= 'history'

		const built = await tm_list.build(true)

	// keep the pointer so the next load can destroy this instance
		self.component_history_list = tm_list

	// a failed build is never rendered (see load_time_machine_list_instance)
		if (built===false) {
			return render_block_failure(get_label.component_history || 'Component history', tm_list.build_error || null)
		}

	// the rendered node replaces the placeholder (load_block contract)
	return tm_list.render()
}//end load_component_history_instance



/**
* RENDER_ACTIVITY_INFO
* Builds the collapsible "Activity" block in the inspector.  The block body is a
* bubbles_notification_container that accumulates save confirmations and error
* notifications in real time via load_activity_info().
*
* Unlike the time-machine and component-history blocks, the activity feed does NOT
* clear on collapse: bubbles remain in the DOM so the user can review past
* notifications after reopening the block.
*
* A pointer to the body element is stored as self.activity_info_container so
* that load_activity_info() can prepend new notification nodes without a DOM search.
*
* @param {Object} self - Inspector instance. self.activity_info_container is set
*   to the body element as a side effect.
* @returns {HTMLElement} wrapper - The block wrapper element.
*/
const render_activity_info = function(self) {

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'activity_info'
		})

	// activity_info_head
		const activity_info_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'activity_info_head icon_arrow',
			parent			: wrapper
		})
		decorate_block_header(activity_info_head, 'activity', get_label.activity || 'Activity')

	// activity_info_body (bubbles_notification_container)
		const activity_info_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'bubbles_notification_container activity_info_body hide',
			parent			: wrapper
		})
		// fix pointer to node placeholder
		self.activity_info_container = activity_info_body

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: activity_info_head,
			container			: activity_info_body,
			collapsed_id		: 'inspector_activity_info',
			collapse_callback	: collapse,
			expose_callback		: expose
		})
		function collapse() {
			activity_info_head.classList.remove('up')
		}
		function expose() {
			activity_info_head.classList.add('up')
		}


	return wrapper
}//end render_activity_info



/**
* LOAD_ACTIVITY_INFO
* Renders a new save/error notification bubble and prepends it to the activity
* feed container.  Called by inspector.js save_handler on every component save,
* regardless of whether the activity block is currently open (so the badge count
* stays accurate even when collapsed).
*
* @param {Object} self - Inspector instance with self.activity_info_container set.
* @param {Object} options - The options object received from the 'save' event.
*   Shape mirrors the save event payload (instance, result, etc.) passed through
*   to render_node_info() for display.
* @returns {Promise<HTMLElement>} The activity container element (always non-null).
*/
export const load_activity_info = async function(self, options) {

	// container
		const container	= self.activity_info_container

	// render notification bubble
		const node_info = render_node_info(options)

	// prepend node (at top of the list)
		container.prepend(node_info)


	return container
}//end load_activity_info



/**
* OPEN_ONTOLOGY_WINDOW
* Opens or reuses a single dedicated ontology window (window.docu_window) to show
* the given URL.
*
* Window reuse policy: if a window with target name 'docu_window' is already open
* (window.docu_window not null and not closed), its location is updated in-place
* rather than opening a second tab.  This provides a coherent single-window
* navigation experience when the user activates multiple components in sequence.
*
* The self.last_docu_type property is updated so that inspector.js activate_component_handler
* can re-navigate the window to the correct documentation type when the user switches
* component focus while the ontology window is already open.
*
* Position: the window is placed at the right edge of the primary screen
* (left = screen_width − window_width) so it does not overlap the Dédalo edit view.
*
* @param {Object} self - Inspector instance. self.last_docu_type is updated as a
*   side effect.
* @param {string} url - Full URL to navigate to (built by get_ontology_url).
* @param {string} docu_type - One of 'docu_link' | 'local_ontology' |
*   'local_ontology_search' | 'master_ontology'. Stored on self for subsequent calls.
* @param {boolean} [focus=false] - Whether to bring the ontology window to the
*   foreground after navigation. Defaults to false to avoid focus-stealing when
*   called automatically on component activation.
* @returns {boolean} Always true.
*/
export const open_ontology_window = function(self, url, docu_type, focus=false) {

	// fix docu_type (used in inspector.init event 'fn_activate_component')
	self.last_docu_type = docu_type

	// docu_window
	window.docu_window = window.docu_window || null

	if (window.docu_window && !window.docu_window.closed) {
		// recycle current already existing window
		window.docu_window.location = url
		if (focus===true) {
			window.docu_window.focus()
		}
	}else{
		// create a window from scratch; position to the right edge of the screen
		const window_width	= 1310
		const screen_width	= window.screen.width
		const screen_height	= window.screen.height
		const left = screen_width - window_width
		window.docu_window	= window.open(
			url,
			'docu_window',
			`left=${left},top=0,width=${window_width},height=${screen_height}`
		)
	}


	return true
}//end open_ontology_window



/**
* RENDER_DOCU_LINKS
* Builds a DocumentFragment containing icon-link buttons for navigating to
* ontology documentation related to a given tipo.  Always renders the public
* 'Documentation' link; adds three developer-only links when SHOW_DEVELOPER===true.
*
* Button set (always visible):
*   - docu_link  ('button link') — opens https://dedalo.dev/ontology/<tipo>
*
* Button set (SHOW_DEVELOPER only):
*   - local_ontology  ('button pen')  — opens the local instance's ontology page
*     for this tipo (e.g. https://localhost/dedalo/core/page/?tipo=dd0&section_id=1)
*   - local_ontology_search ('button tree') — opens the thesaurus tree (dd5) with a
*     pre-filled search_tipos parameter so the user lands directly on this tipo's node
*   - master_ontology ('button edit') — opens master.dedalo.dev for the canonical
*     source ontology record
*
* All buttons call open_ontology_window(), which reuses a single 'docu_window' popup
* so that clicking multiple links does not spawn multiple windows.
*
* Note: the local_ontology_search handler assigns the result of open_window() to
* const tree_window but never uses tree_window after that.  Flagged as unused
* variable (not fixed per doc-only rule).
*
* @param {Object} self - Inspector instance passed through to open_ontology_window().
* @param {string} tipo - Ontology tipo identifier (e.g. 'dd345', 'tch38').
* @returns {DocumentFragment} fragment containing the rendered link buttons.
*/
const render_docu_links = function(self, tipo) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// docu_link — always visible; opens the public Dédalo ontology documentation site
		const docu_link = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'button link',
			title			: 'Documentation',
			parent			: fragment
		})
		// mousedown event
		const mousedown_docu_handler = async (e) => {
			e.stopPropagation()

			const docu_type	= 'docu_link'
			const url		= await get_ontology_url(tipo, docu_type)
			open_ontology_window(
				self,
				url,
				docu_type
			)
		}
		docu_link.addEventListener('mousedown', mousedown_docu_handler)

	if (SHOW_DEVELOPER===true) {

		// local_ontology — opens the running instance's ontology section for this tipo
			const local_ontology = ui.create_dom_element({
				element_type	: 'a',
				class_name		: 'button pen',
				title			: 'Local Ontology',
				parent			: fragment
			})
			// mousedown event
			const mousedown_handler_local = async (e) => {
				e.stopPropagation()

				const docu_type	= 'local_ontology'
				const url		= await get_ontology_url(tipo, docu_type)
				if (!url) {
					console.error('Error. Invalid ontology info for tipo:', tipo);
					return
				}
				// open window like https://localhost/dedalo/core/page/?tipo=dd0&section_id=1
				open_ontology_window(
					self,
					url,
					docu_type
				)
			}
			local_ontology.addEventListener('mousedown', mousedown_handler_local)

		// local ontology tree search — opens the thesaurus (dd5) pre-filtered for this tipo
			const local_ontology_search = ui.create_dom_element({
				element_type	: 'a',
				class_name		: 'button tree',
				title			: 'Local Ontology tree search',
				parent			: fragment
			})
			// mousedown event
			const mousedown_handler_tree = async (e) => {
				e.stopPropagation()
				// url vars: extract tld prefix and numeric section_id from tipo
				// e.g. tipo 'tch38' → tld='tch', section_id='38'
				const tld			= get_tld_from_tipo(tipo)
				const section_id	= get_section_id_from_tipo(tipo)
				const url_vars = {
					tipo			: 'dd5',
					menu			: false,
					search_tipos	: tld + section_id
				}
				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars(url_vars)
				// open window
				// (!) tree_window is declared but never used after this point — flagged.
				const tree_window = open_window({
					url		: url,
					name	: 'tree_window',
					width	: 1000,
					height	: 800
				})
			}
			local_ontology_search.addEventListener('mousedown', mousedown_handler_tree)

		// master_ontology — opens master.dedalo.dev for the canonical source ontology record
			const master_ontology = ui.create_dom_element({
				element_type	: 'a',
				class_name		: 'button edit',
				title			: 'Master Ontology',
				parent			: fragment
			})
			// mousedown event
			const mousedown_handler_master = async (e) => {
				e.stopPropagation()
				// open master.dedalo.dev section edit window
				const docu_type	= 'master_ontology'
				const url		= await get_ontology_url(tipo, docu_type)
				open_ontology_window(
					self,
					url,
					docu_type
				)
			}
			master_ontology.addEventListener('mousedown', mousedown_handler_master)

	}//end if (SHOW_DEVELOPER===true)


	return fragment
}//end render_docu_links



// @license-end
