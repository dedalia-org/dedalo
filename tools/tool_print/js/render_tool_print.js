// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, confirm, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_PRINT
*
* Top-level view layer for the tool_print visual report designer.
*
* Responsibilities
* ─────────────────
* 1. Build the four-panel editor shell (toolbar, palette, canvas, inspector)
*    and wire the initial template auto-load.
* 2. Drive all template CRUD (New / Save / Save as… / Delete / load picker)
*    by delegating persistence to print_layout_presets.js.
* 3. Manage the inspector panel: two-way sync between the selected {row, cell}
*    and the numeric/style inputs; render the per-box column manager for
*    relation/portal cells.
* 4. Manage the palette panel: drill-down navigation through related sections
*    (replacing the core Miller-column side-by-side with a single-column
*    breadcrumb drill-down so the palette stays narrow).
* 5. Own the complete PRINT path: gather record ids → render_print_document
*    (layout_flow in mm via make_print_ctx) → set @page size → window.print()
*    → restore editor.
*
* Depends on
* ───────────
* - canvas_tool_print.js   model mutations, render_canvas, serialisation
* - flow_engine.js         layout_flow / make_print_ctx (shared engine)
* - render_box_tool_print.js  component value rendering + relation-table helpers
* - print_layout_presets.js   dd25/dd625 CRUD
*
* Panel layout (CSS class handles placement)
* ────────────────────────────────────────────
*  .print_layout_editor
*  ├─ .print_toolbar   (.no_print)   – template picker + CRUD + zoom/snap/fill
*  ├─ .palette_panel   (.no_print)   – component drag-source list (left)
*  ├─ .pages_viewport               – editable canvas (centre, IS printed)
*  └─ .inspector_panel (.no_print)  – geometry + style + column manager (right)
*
* The only subtree WITHOUT .no_print is the canvas (.pages_viewport / .print_root).
* Everything else disappears at window.print() time.
*
* @module render_tool_print
*/

	import {ui} from '../../../core/common/js/ui.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {render_components_list} from '../../../core/common/js/render_common.js'
	import {
		new_layout,
		render_canvas,
		set_zoom,
		serialize_layout,
		page_dims,
		PAGE_FORMATS,
		remove_table_column,
		add_default_column,
		reorder_table_column,
		set_column_width,
		set_column_header,
		set_column_style,
		add_row,
		add_spacer,
		add_cell,
		remove_cell,
		remove_row,
		select_cell,
		find_row,
		find_cell,
		reseat_ids
	} from './canvas_tool_print.js'
	import {make_print_ctx, layout_flow} from './flow_engine.js'
	import {render_box_content, is_relation_model, column_key, ensure_portal_meta} from './render_box_tool_print.js'
	import {
		query_layouts,
		load_layout,
		create_new_layout,
		save_layout,
		delete_layout
	} from './print_layout_presets.js'



// Hard cap on records printed in one browser pass. Above this, do_print refuses
// and asks the user to narrow the filter (server-side batch PDF is Phase 2).
// Sized for the confirmed use case ("dozens of records"); the browser print path
// degrades past a few hundred (frozen tab / memory). Imported by tool_print.js
// get_record_ids to bound the id fetch.
export const PRINT_MAX = 100



// helpers -------------------------------------------------------------------

	/**
	* round1
	* Rounds a number to one decimal place.
	* Used to avoid floating-point noise in inspector display values (mm).
	* @param {number} n - value to round
	* @returns {number} value rounded to 1 decimal place
	*/
	const round1 = (n) => Math.round(n * 10) / 10

	/**
	* to_num
	* Parses a value as a finite float, falling back to `fallback` on failure.
	* Handles empty strings and non-numeric inspector input values safely.
	* @param {*} v - raw value from an input element's .value
	* @param {number} fallback - returned when v is not a finite number
	* @returns {number} parsed finite float or fallback
	*/
	const to_num = (v, fallback) => {
		const n = parseFloat(v)
		return Number.isFinite(n) ? n : fallback
	}



/**
* RENDER_TOOL_PRINT
* Render constructor (prototype host for edit()).
*/
export const render_tool_print = function() {
}//end render_tool_print



/**
* EDIT
* Entry point called by the tool framework. Builds the full editor UI or
* returns just the content_data node for embedded ('content') render levels.
*
* render_level === 'content' skips the outer ui.tool.build_wrapper_edit chrome,
* returning the raw content_data node (used when the tool is inlined rather than
* opened as a floating panel).
* @param {Object} options - render options; currently { render_level }
* @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} wrapper or content_data node
*/
render_tool_print.prototype.edit = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, { content_data })
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Assembles the toolbar + palette + canvas + inspector grid and initialises the
* working layout (default template, or the default-flagged one when available).
*
* State initialised on `self`
* ───────────────────────────
* self.layout               – active v2 flow blob (new_layout default or loaded)
* self.current_template_id  – dd25 section_id of the loaded template, or null
* self.dirty                – true when layout has unsaved changes
* self.zoom                 – canvas zoom factor (preserved across re-renders)
* self.fill_mode            – true to render real record data in the canvas
* self.sync_inspector       – hook called by canvas_tool_print after drag/drop
* self.palette_stack        – drill-down stack; empty = root section
* self.canvas_container     – the .pages_viewport element
*
* The template picker auto-load is intentionally fire-and-forget (Promise .then
* without await) so the panel renders immediately and the async fetch populates
* the picker in the background.
* @param {Object} self - tool_print instance
* @returns {Promise<HTMLElement>} content_data node
*/
const get_content_data_edit = async function(self) {

	// initialise the working layout
		self.layout				= new_layout(self)
		self.current_template_id= null
		self.dirty				= false
		self.zoom				= self.zoom || 1
		// show real record data by default (placeholder only when no preview record)
		self.fill_mode			= !!self.preview_section_id

	// expose the inspector sync hook to the canvas module
		self.sync_inspector = (box) => sync_inspector(self, box)

	// content_data (grid container)
		const content_data = ui.tool.build_content_data(self)
		content_data.classList.add('print_layout_editor')

	// toolbar (top, chrome)
		const toolbar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'print_toolbar no_print',
			parent			: content_data
		})
		await render_toolbar(self, toolbar)

	// palette (left, chrome). Single-column drill-down: clicking a relation
	// REPLACES the list with that related section's components and pushes a
	// breadcrumb (with back), instead of the core side-by-side Miller columns.
		const palette_panel = ui.create_dom_element({
			element_type	: 'aside',
			class_name		: 'palette_panel no_print',
			parent			: content_data
		})
		ui.create_dom_element({
			element_type	: 'h2',
			class_name		: 'panel_title',
			inner_html		: (get_label.components || 'Components'),
			parent			: palette_panel
		})
		add_collapse_toggle(palette_panel, content_data, 'palette')
		self.palette_breadcrumb = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'palette_breadcrumb hide',
			parent			: palette_panel
		})
		self.palette_scroll = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'palette_scroll',
			parent			: palette_panel
		})
		self.palette_stack = []
		// intercept relation (has_subquery) clicks in CAPTURE so the core
		// side-by-side handler never runs; drill down by replacing the list.
		self.palette_scroll.addEventListener('click', (e) => {
			const item = e.target.closest('.component_label.has_subquery')
			if (!item || !self.palette_scroll.contains(item)) return
			e.stopPropagation()
			e.preventDefault()
			const ddo = item.ddo
			if (!ddo || !ddo.target_section_tipo) return
			self.palette_stack.push({
				section_tipo	: Array.isArray(ddo.target_section_tipo) ? ddo.target_section_tipo[0] : ddo.target_section_tipo,
				path			: item.path,
				label			: ddo.label || ddo.tipo
			})
			render_palette(self)
		}, true)
		render_palette(self)

	// canvas (centre, PRINTABLE — not .no_print)
		const pages_viewport = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'pages_viewport',
			parent			: content_data
		})
		self.canvas_container = pages_viewport
		render_canvas(self, pages_viewport)

	// inspector (right, chrome)
		const inspector_panel = ui.create_dom_element({
			element_type	: 'aside',
			class_name		: 'inspector_panel no_print',
			parent			: content_data
		})
		render_inspector(self, inspector_panel)
		add_collapse_toggle(inspector_panel, content_data, 'inspector')

	// try to auto-load the default / first template for this section
		refresh_template_picker(self).then(() => {
			if (self.default_template_id) {
				load_template(self, self.default_template_id)
			}
		})


	return content_data
}//end get_content_data_edit



/**
* RENDER_PALETTE
* Renders the current drill-down level into the palette scroll area, replacing
* whatever was there. Level 0 = the target section; deeper levels = related
* sections pushed onto self.palette_stack by clicking a relation component.
*
* The async section element fetch is done BEFORE swapping the DOM so the panel
* never flashes visibly empty mid-load — the old list stays visible until the
* new one is ready, then a single replaceChildren() replaces it atomically.
*
* Error handling: if get_section_elements_context fails (e.g. network or
* permission error), section_elements falls back to [] so render_components_list
* renders an empty container rather than throwing.
* @param {Object} self - tool_print instance (reads self.palette_stack, self.palette_scroll)
* @returns {Promise<void>}
*/
const render_palette = async function(self) {

	const scroll = self.palette_scroll
	if (!scroll) return

	render_palette_breadcrumb(self)

	const stack	= self.palette_stack
	const level	= stack.length
		? stack[stack.length-1]
		: { section_tipo: self.target_section_tipo, path: [], label: null }

	const container = ui.create_dom_element({ element_type:'div', class_name:'components_list_container' })

	// section elements for this level (root reuses the prebuilt set)
	let section_elements
	if (stack.length===0) {
		section_elements = self.section_elements
	} else {
		try {
			section_elements = await self.get_section_elements_context({
				section_tipo			: level.section_tipo,
				ar_components_exclude	: self.section_elements_components_exclude
			})
		} catch (e) {
			console.error('render_palette: get_section_elements_context failed', e)
			section_elements = []
		}
	}

	render_components_list({
		self					: self,
		section_tipo			: level.section_tipo,
		target_div				: container,
		path					: level.path,
		section_elements		: section_elements,
		ar_components_exclude	: self.section_elements_components_exclude
	})

	// swap in only after the (async) build so the panel never flashes empty mid-load
	scroll.replaceChildren(container)
}//end render_palette



/**
* RENDER_PALETTE_BREADCRUMB
* Back button + clickable crumb trail for the relation drill-down. Hidden at the
* root level. Clicking a crumb truncates the stack to that depth.
*
* Stack depth 0 = root section → breadcrumb hidden.
* Stack depth N > 0 → shows "‹ Back" + root crumb + N-1 intermediate crumbs +
* the current (non-clickable) leaf crumb.
*
* The root label is taken from the section element with model==='section' in
* self.section_elements; if none exists the generic 'Components' label is used.
* @param {Object} self - tool_print instance (reads self.palette_stack, self.palette_breadcrumb)
*/
const render_palette_breadcrumb = function(self) {

	const bc = self.palette_breadcrumb
	if (!bc) return
	bc.replaceChildren()

	const stack = self.palette_stack
	if (!stack.length) { bc.classList.add('hide'); return }
	bc.classList.remove('hide')

	// back one level
	const back = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'palette_back',
		inner_html		: '‹ ' + (get_label.back || 'Back'),
		parent			: bc
	})
	back.addEventListener('click', () => { self.palette_stack.pop(); render_palette(self) })

	// crumb trail (root + each pushed level)
	const trail = ui.create_dom_element({ element_type:'span', class_name:'palette_crumbs', parent:bc })
	const root_label = (Array.isArray(self.section_elements)
		? (self.section_elements.find(e => e && e.model==='section')?.label)
		: null) || (get_label.components || 'Components')

	/**
	* make_crumb
	* Appends a single breadcrumb segment. Crumbs at depth < stack.length are
	* clickable (they navigate up); the last crumb is the current level (not clickable).
	* @param {string} label - display text
	* @param {number} depth - stack depth this crumb represents (0 = root)
	*/
	const make_crumb = (label, depth) => {
		const c = ui.create_dom_element({ element_type:'span', class_name:'crumb', inner_html:(label || '…'), parent:trail })
		if (depth < stack.length) {
			c.classList.add('clickable')
			c.addEventListener('click', () => { self.palette_stack.length = depth; render_palette(self) })
		}
	}
	make_crumb(root_label, 0)
	for (let i = 0; i < stack.length; i++) {
		ui.create_dom_element({ element_type:'span', class_name:'crumb_sep', inner_html:'›', parent:trail })
		make_crumb(stack[i].label, i+1)
	}
}//end render_palette_breadcrumb



/**
* RENDER_TOOLBAR
* Builds the top .print_toolbar with four groups:
*
* 1. Template picker  – <select> of saved templates + inline name <input>
*    (inline field because native prompt() is silently blocked in the tool
*    window on some browsers; see save-bug pattern in the skill docs).
* 2. Actions         – New / Save / Save as… / Delete buttons.
* 3. Layout          – Add row / Add text / Add spacer / Snap checkbox /
*                      Preview-with-record checkbox / Zoom <select>.
* 4. Print           – Print button.
*
* The `fill_check` is disabled when self.preview_section_id is falsy (nothing
* to preview), so preview toggling is only available in a record context.
* @param {Object} self - tool_print instance
* @param {HTMLElement} container - the .print_toolbar element to populate
* @returns {Promise<void>}
*/
const render_toolbar = async function(self, container) {

	const L = (name, fallback) => (self.get_tool_label?.(name)) || fallback

	const add_group_label = (parent, text) => {
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'toolbar_group_label',
			inner_html		: text,
			parent			: parent
		})
	}

	// template picker
		const picker_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_group template_picker_group',
			parent			: container
		})
		add_group_label(picker_wrap, L('templates','Templates'))
		const picker = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'template_picker',
			parent			: picker_wrap
		})
		self.template_picker = picker
		picker.addEventListener('change', () => {
			const id = picker.value
			if (id) load_template(self, id)
		})
		// inline template-name field (replaces the native prompt on save)
		const name_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'template_name_input',
			parent			: picker_wrap
		})
		name_input.type = 'text'
		name_input.placeholder = L('template_name','Template name')
		name_input.value = self.layout.name && self.layout.name!=='Untitled' ? self.layout.name : ''
		name_input.addEventListener('change', () => {
			self.layout.name = name_input.value.trim() || 'Untitled'
			self.mark_dirty?.()
		})
		self.name_input = name_input

	// actions group
		const actions = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_group actions_group',
			parent			: container
		})
		add_group_label(actions, L('actions','Actions'))
		make_button(actions, L('new_template','New'), 'btn_new', () => do_new(self))
		self.button_save = make_button(actions, L('save_template','Save'), 'btn_save', () => do_save(self))
		make_button(actions, L('save_as_template','Save as…'), 'btn_save_as', () => do_save_as(self))
		make_button(actions, L('delete_template','Delete'), 'btn_delete delete_light', () => do_delete(self))

	// page / view group
		const view_group = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_group view_group',
			parent			: container
		})
		add_group_label(view_group, L('layout','Layout'))
		make_button(view_group, L('add_row','Add row'), 'btn_add_row', () => add_row(self))
		make_button(view_group, L('add_text','Add text'), 'btn_add_text', () => add_row(self, { type:'static_text', static:{ text:'Text…' }, style:{} }))
		make_button(view_group, L('add_spacer','Add spacer'), 'btn_add_spacer', () => add_spacer(self))

		// snap toggle
		const snap_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'toolbar_check',
			parent			: view_group
		})
		ui.create_dom_element({ element_type : 'span', text_content : L('snap_to_grid','Snap to grid'), parent : snap_label })
		const snap_check = ui.create_dom_element({
			element_type	: 'input',
			parent			: snap_label
		})
		snap_check.type		= 'checkbox'
		snap_check.checked	= !!(self.layout.grid && self.layout.grid.snap)
		snap_check.addEventListener('change', () => {
			self.layout.grid.snap = snap_check.checked
		})

		// fill / preview toggle
		const fill_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'toolbar_check',
			parent			: view_group
		})
		ui.create_dom_element({ element_type : 'span', text_content : L('fill_with_record','Preview with record data'), parent : fill_label })
		const fill_check = ui.create_dom_element({
			element_type	: 'input',
			parent			: fill_label
		})
		fill_check.type = 'checkbox'
		fill_check.disabled = !self.preview_section_id
		fill_check.checked = !!self.fill_mode
		fill_check.addEventListener('change', () => toggle_fill_mode(self, fill_check.checked))

		// zoom
		const zoom_select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'zoom_select',
			parent			: view_group
		})
		;[['0.5','50%'],['0.75','75%'],['1','100%'],['1.25','125%'],['1.5','150%']].forEach(([v,label]) => {
			ui.create_dom_element({ element_type:'option', value:v, inner_html:label, parent:zoom_select })
		})
		zoom_select.value = '' + (self.zoom || 1)
		zoom_select.addEventListener('change', () => set_zoom(self, parseFloat(zoom_select.value)))

	// print group
		const print_group = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'toolbar_group print_group',
			parent			: container
		})
		add_group_label(print_group, L('print','Print'))
		make_button(print_group, L('print','Print'), 'btn_print', () => do_print(self))
}//end render_toolbar



/**
* MAKE_BUTTON
* Creates a <button class="tool_button …"> with a click handler, appends it to
* parent, and returns it. e.preventDefault() is called on every click so the
* button does not accidentally submit a parent <form>.
* @param {HTMLElement} parent - element to append the button to
* @param {string} label - button text (innerHTML)
* @param {string} extra_class - additional CSS classes appended after 'tool_button'
* @param {Function} on_click - called with no arguments on click
* @returns {HTMLElement} the created <button> element
*/
const make_button = function(parent, label, extra_class, on_click) {
	const btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'tool_button ' + (extra_class || ''),
		inner_html		: label,
		parent			: parent
	})
	btn.addEventListener('click', (e) => { e.preventDefault(); on_click() })
	return btn
}//end make_button



/**
* ADD_COLLAPSE_TOGGLE
* Adds a collapse/expand chevron button to a panel header.
*
* The toggle button is prepended to (or wraps) the existing .panel_title child.
* Toggling adds/removes `${side}_collapsed` on the grid container, which CSS
* uses to collapse the panel column to a narrow strip.
*
* The chevron direction flips to give a consistent "push towards the panel"
* affordance: palette (left side) points left when open (◀) and right when
* collapsed (▶); inspector (right side) is the mirror image.
* @param {HTMLElement} panel - the panel <aside> element
* @param {HTMLElement} container - the .print_layout_editor grid container
* @param {string} side - 'palette' or 'inspector'
* @returns {HTMLElement} the created .panel_header_row element
*/
const add_collapse_toggle = function(panel, container, side) {
	const header_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'panel_header_row',
		parent			: panel
	})
	// move the panel title into the header row
	const title = panel.querySelector(':scope > .panel_title')
	if (title) header_row.appendChild(title)
	const toggle = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'panel_collapse_toggle',
		inner_html		: side==='palette' ? '◀' : '▶',
		parent			: header_row
	})
	toggle.addEventListener('click', () => {
		const cls = side + '_collapsed'
		container.classList.toggle(cls)
		toggle.innerHTML = container.classList.contains(cls)
			? (side==='palette' ? '▶' : '◀')
			: (side==='palette' ? '◀' : '▶')
	})
	return header_row
}//end add_collapse_toggle



/**
* RENDER_INSPECTOR
* Builds the static inspector panel DOM: geometry inputs, style inputs,
* row/cell action buttons, table column manager placeholder, and page settings.
*
* The inspector is two-way bound:
* - canvas → inspector: sync_inspector() is called by canvas_tool_print after
*   any drag/selection change; it pushes the selected box's current values
*   into the inputs.
* - inspector → canvas: on_inspector_change() reads the inputs back and
*   applies them to the model, then triggers a full canvas re-render.
*
* Inputs that only make sense for certain box types are shown/hidden by
* sync_inspector:
* - .show_label_row        visible only for component cells
* - .table_header_row      visible only for relation/portal cells
* - .inspector_columns     visible only for relation/portal cells with columns
*
* Stored references on self
* ──────────────────────────
* self.inspector_body         – the .inspector_body container
* self.inspector_box_fields   – the collapsible group (hidden until selection)
* self.inspector_inputs       – map of key → input element
*   Keys: cell_width, space_after, font_size_pt, align, font_family,
*         text_color, border_show, border_color, show_label, show_table_header
* self.inspector_columns      – the .inspector_columns column manager div
* self.inspector_hint         – the "select an element" placeholder <p>
* @param {Object} self - tool_print instance
* @param {HTMLElement} container - the .inspector_panel <aside> element
*/
const render_inspector = function(self, container) {

	ui.create_dom_element({
		element_type	: 'h2',
		class_name		: 'panel_title',
		inner_html		: (get_label.properties || 'Properties'),
		parent			: container
	})

	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'inspector_body',
		parent			: container
	})
	self.inspector_body = body

	// box fields (hidden until a box is selected)
		const box_fields = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_box_fields hide',
			parent			: body
		})
		self.inspector_box_fields = box_fields

		// --- Layout section ---
		const layout_section = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_section',
			parent			: box_fields
		})
		ui.create_dom_element({
			element_type	: 'h3',
			class_name		: 'panel_subtitle',
			inner_html		: (get_label.layout || 'Layout'),
			parent			: layout_section
		})

		self.inspector_inputs = {}
		/**
		* num
		* Creates a numeric <input> row labelled `label` and registers it in
		* self.inspector_inputs under `key`. Fires on_inspector_change on every
		* `change` event (not `input` — avoids continuous re-renders while typing).
		* @param {string} key - self.inspector_inputs key
		* @param {string} label - display label text
		* @returns {HTMLInputElement} the created number input
		*/
		const num = (key, label) => {
			const row = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'inspector_row',
				parent			: layout_section
			})
			ui.create_dom_element({ element_type : 'span', text_content : label, parent : row })
			const input = ui.create_dom_element({ element_type:'input', parent:row })
			input.type = 'number'
			input.step = '0.5'
			input.addEventListener('change', () => on_inspector_change(self))
			self.inspector_inputs[key] = input
			return input
		}
		// cell width (% of the row) + row gap below
		num('cell_width', 'Cell width (%)')
		num('space_after', 'Row gap (mm)')

		// row / cell structure actions
		const row_actions = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_row row_actions',
			parent			: layout_section
		})
		ui.create_dom_element({ element_type:'button', class_name:'tool_button', inner_html:'+ cell', parent: row_actions })
			.addEventListener('click', () => { if (self.sel) add_cell(self, self.sel.row_id) })
		ui.create_dom_element({ element_type:'button', class_name:'tool_button', inner_html:'− cell', parent: row_actions })
			.addEventListener('click', () => { if (self.sel && self.sel.cell_id) remove_cell(self, self.sel.row_id, self.sel.cell_id) })
		ui.create_dom_element({ element_type:'button', class_name:'tool_button btn_delete', inner_html:'Remove row', parent: row_actions })
			.addEventListener('click', () => { if (self.sel) remove_row(self, self.sel.row_id) })

		// --- Style section ---
		const style_section = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_section',
			parent			: box_fields
		})
		ui.create_dom_element({
			element_type	: 'h3',
			class_name		: 'panel_subtitle',
			inner_html		: (get_label.style || 'Style'),
			parent			: style_section
		})

		// font size
		const fs_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Font (pt)</span>',
			parent			: style_section
		})
		const fs_input = ui.create_dom_element({ element_type:'input', parent:fs_row })
		fs_input.type = 'number'; fs_input.min = '4'
		fs_input.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.font_size_pt = fs_input

		// align
		const align_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Align</span>',
			parent			: style_section
		})
		const align_sel = ui.create_dom_element({ element_type:'select', parent:align_row })
		;['left','center','right','justify'].forEach(v => ui.create_dom_element({ element_type:'option', value:v, inner_html:v, parent:align_sel }))
		align_sel.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.align = align_sel

		// font family (default sans-serif / Helvetica)
		const ff_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Font</span>',
			parent			: style_section
		})
		const ff_sel = ui.create_dom_element({ element_type:'select', parent:ff_row })
		;[['sans','Sans-serif'],['serif','Serif'],['mono','Monospace']].forEach(([v,t]) =>
			ui.create_dom_element({ element_type:'option', value:v, inner_html:t, parent:ff_sel }))
		ff_sel.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.font_family = ff_sel

		// text color
		const tc_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Text color</span>',
			parent			: style_section
		})
		const tc_input = ui.create_dom_element({ element_type:'input', class_name:'inspector_color', parent:tc_row })
		tc_input.type = 'color'
		tc_input.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.text_color = tc_input

		// border: show/hide lines
		const bd_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row inspector_check_row',
			inner_html		: '<span>Border</span>',
			parent			: style_section
		})
		const bd_check = ui.create_dom_element({ element_type:'input', parent:bd_row })
		bd_check.type = 'checkbox'
		bd_check.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.border_show = bd_check

		// border color
		const bc_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Border color</span>',
			parent			: style_section
		})
		const bc_input = ui.create_dom_element({ element_type:'input', class_name:'inspector_color', parent:bc_row })
		bc_input.type = 'color'
		bc_input.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.border_color = bc_input

		// show label (component boxes only)
		const lbl_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row inspector_check_row show_label_row',
			inner_html		: '<span>Show label</span>',
			parent			: style_section
		})
		const lbl_check = ui.create_dom_element({ element_type:'input', parent:lbl_row })
		lbl_check.type = 'checkbox'
		lbl_check.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.show_label = lbl_check

		// show table header row (relation/portal boxes only)
		const th_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row inspector_check_row table_header_row hide',
			inner_html		: '<span>Show table header</span>',
			parent			: style_section
		})
		const th_check = ui.create_dom_element({ element_type:'input', parent:th_row })
		th_check.type = 'checkbox'
		th_check.addEventListener('change', () => on_inspector_change(self))
		self.inspector_inputs.show_table_header = th_check

		// table columns picker (relation/portal boxes only)
		self.inspector_columns = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_columns hide',
			parent			: style_section
		})

	// empty hint
		self.inspector_hint = ui.create_dom_element({
			element_type	: 'p',
			class_name		: 'inspector_hint',
			inner_html		: (get_label.select_an_element || 'Select an element to edit its properties, or drag a component onto a page.'),
			parent			: body
		})

	// page settings
		const page_section = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_section',
			parent			: body
		})
		ui.create_dom_element({
			element_type	: 'h3',
			class_name		: 'panel_subtitle',
			inner_html		: (get_label.page || 'Page'),
			parent			: page_section
		})
		const page_settings = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_page_settings',
			parent			: page_section
		})
		// format
		const fmt_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Format</span>',
			parent			: page_settings
		})
		const fmt_sel = ui.create_dom_element({ element_type:'select', parent:fmt_row })
		Object.keys(PAGE_FORMATS).forEach(k => ui.create_dom_element({ element_type:'option', value:k, inner_html:k, parent:fmt_sel }))
		fmt_sel.value = self.layout.page_defaults.size
		fmt_sel.addEventListener('change', () => {
			self.layout.page_defaults.size = fmt_sel.value
			self.layout.page_defaults.width_mm = PAGE_FORMATS[fmt_sel.value].width_mm
			self.layout.page_defaults.height_mm = PAGE_FORMATS[fmt_sel.value].height_mm
			render_canvas(self, self.canvas_container)
			self.mark_dirty()
		})
		// orientation
		const or_row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'inspector_row',
			inner_html		: '<span>Orientation</span>',
			parent			: page_settings
		})
		const or_sel = ui.create_dom_element({ element_type:'select', parent:or_row })
		;['portrait','landscape'].forEach(v => ui.create_dom_element({ element_type:'option', value:v, inner_html:v, parent:or_sel }))
		or_sel.value = self.layout.page_defaults.orientation
		or_sel.addEventListener('change', () => {
			self.layout.page_defaults.orientation = or_sel.value
			render_canvas(self, self.canvas_container)
			self.mark_dirty()
		})
		// margins (per side, mm) — kept clear of content; the flow engine positions
		// the column inside them and subtracts them from the usable page height, so
		// pagination respects them. Default 20 mm (2 cm). A "Link" toggle (default on)
		// keeps all four sides equal; turn it off to set each side independently.
		const mg_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_row margins_head',
			parent			: page_settings
		})
		ui.create_dom_element({ element_type:'span', inner_html:(get_label.margins || 'Margins (mm)'), parent:mg_head })
		if (typeof self._margins_linked==='undefined') {
			const m0 = self.layout.page_defaults.margins_mm || {}
			self._margins_linked = (m0.top===m0.right && m0.right===m0.bottom && m0.bottom===m0.left)
		}
		const link_lbl = ui.create_dom_element({ element_type:'label', class_name:'margins_link', title:'Link all sides', parent:mg_head })
		const link_chk = ui.create_dom_element({ element_type:'input', parent:link_lbl })
		link_chk.type = 'checkbox'; link_chk.checked = self._margins_linked
		ui.create_dom_element({ element_type:'span', inner_html:(get_label.link || 'Link'), parent:link_lbl })

		const mg_grid = ui.create_dom_element({ element_type:'div', class_name:'margins_grid', parent:page_settings })
		const cur_m   = Object.assign({ top:20, right:20, bottom:20, left:20 }, self.layout.page_defaults.margins_mm || {})
		const sides   = [['top','T'],['right','R'],['bottom','B'],['left','L']]
		const inputs  = {}
		const clampv  = (x) => { let v = parseFloat(x); if (!isFinite(v)||v<0) v=0; if (v>60) v=60; return v }
		sides.forEach(([side, lbl]) => {
			const f = ui.create_dom_element({ element_type:'label', class_name:'margin_field', parent:mg_grid })
			ui.create_dom_element({ element_type:'span', text_content:lbl, parent:f })
			const inp = ui.create_dom_element({ element_type:'input', parent:f })
			inp.type='number'; inp.min='0'; inp.max='60'; inp.step='1'; inp.value = cur_m[side]
			inputs[side] = inp
			inp.addEventListener('change', () => {
				const v = clampv(inp.value)
				inp.value = v
				if (!self.layout.page_defaults.margins_mm) self.layout.page_defaults.margins_mm = {}
				if (self._margins_linked) {
					self.layout.page_defaults.margins_mm = { top:v, right:v, bottom:v, left:v }
					sides.forEach(([s]) => { inputs[s].value = v })
				} else {
					self.layout.page_defaults.margins_mm[side] = v
				}
				render_canvas(self, self.canvas_container)
				self.mark_dirty()
			})
		})
		link_chk.addEventListener('change', () => {
			self._margins_linked = link_chk.checked
			if (self._margins_linked) {   // re-link: level all sides to Top
				const v = clampv(inputs.top.value)
				self.layout.page_defaults.margins_mm = { top:v, right:v, bottom:v, left:v }
				sides.forEach(([s]) => { inputs[s].value = v })
				render_canvas(self, self.canvas_container)
				self.mark_dirty()
			}
		})
}//end render_inspector



/**
* SYNC_INSPECTOR
* Pushes the selected {row, cell}'s current values into the inspector inputs
* (or hides the box fields and shows the hint when nothing is selected).
*
* Called by canvas_tool_print after every selection change (drag, drop, click)
* via self.sync_inspector = (box) => sync_inspector(self, box).
*
* The `sel` object shape is { row, cell } where:
*   row  – the row descriptor from layout.flow.rows
*   cell – the cell descriptor from row.cells (may be null for a spacer row
*          that has no individual cells)
*
* Cell-width display: fractional width (0…1) is converted to percent (0…100).
* Row-gap display: for spacer rows the field shows the spacer height; for
* regular rows it shows the gap below the row — the label text is swapped
* accordingly via replaceChildren on the <span>.
*
* Style resolution: block.style overrides self.layout.style_defaults overrides
* hard-coded fallbacks. Inputs always reflect the resolved value so the user
* sees what will be printed, not just what is explicitly set on this block.
* @param {Object} self - tool_print instance
* @param {Object|null} sel - { row, cell } or null when deselecting
*/
const sync_inspector = function(self, sel) {

	const fields = self.inspector_box_fields
	const hint	= self.inspector_hint
	if (!fields) return

	// sel = { row, cell } | null
	const row	= sel && sel.row
	const cell	= sel && sel.cell
	if (!row) {
		fields.classList.add('hide')
		if (hint) hint.classList.remove('hide')
		return
	}

	fields.classList.remove('hide')
	if (hint) hint.classList.add('hide')

	const I		= self.inspector_inputs
	const defs	= self.layout.style_defaults || {}
	const block	= (cell && cell.block) ? cell.block : null
	const is_component	= !!(block && block.type==='component')
	const is_table		= !!(is_component && block.component_ref && is_relation_model(block.component_ref.model))

	// cell width (%) + row gap (or spacer height for a spacer row)
	const is_spacer = row.kind==='spacer'
	I.cell_width.value		= cell ? Math.round((cell.width || 1) * 100) : ''
	I.cell_width.disabled	= !cell
	I.space_after.value		= round1(is_spacer ? (row.height_mm || 8) : (row.space_after_mm || 0))
	// relabel the mm field depending on whether this is a spacer height or a row gap
	I.space_after.closest('.inspector_row')?.querySelector('span')?.replaceChildren(document.createTextNode(is_spacer ? 'Spacer height (mm)' : 'Row gap (mm)'))

	// component typography/border (target the selected cell's block)
	const st = (block && block.style) ? block.style : {}
	I.font_size_pt.value	= st.font_size_pt || defs.font_size_pt || 11
	I.align.value			= st.align || defs.align || 'left'
	I.font_family.value		= st.font_family || defs.font_family || 'sans'
	I.text_color.value		= st.text_color || defs.text_color || '#111111'
	I.border_show.checked	= (st.border_show!==undefined) ? st.border_show : (defs.border_show!==false)
	I.border_color.value	= st.border_color || defs.border_color || '#cccccc'

	// show label / show table header — only for component cells
	I.show_label.checked = block ? block.show_label!==false : true
	self.inspector_box_fields.querySelector('.show_label_row')?.classList.toggle('hide', !is_component)
	I.show_table_header.checked = block ? block.show_table_header!==false : true
	self.inspector_box_fields.querySelector('.table_header_row')?.classList.toggle('hide', !is_table)

	// table column manager (relation cells only); the block acts as the "box"
	if (is_table) {
		render_table_columns_ui(self, block)
		// the fast datum render path doesn't resolve a portal's full column set
		// (box.available_columns); resolve it lazily on selection, then re-render the
		// manager. Keeps print/render fast — the build only runs when a portal is
		// actually selected for column editing.
		if (!Array.isArray(block.available_columns)) {
			ensure_portal_meta(self, block).then(ok => {
				if (ok && self.sel && self.sel.cell_id===block.id) render_table_columns_ui(self, block)
			})
		}
	} else if (self.inspector_columns) {
		self.inspector_columns.classList.add('hide')
		self.inspector_columns.replaceChildren()
	}
}//end sync_inspector



/**
* RENDER_TABLE_COLUMNS_UI
* Per-box column manager for portal/relation boxes: lists the active table
* columns (each removable), the default columns not currently shown (re-addable),
* and a hint to drag a related component onto the table to add a column. Hidden
* until the columns are resolved (after the first render).
*
* Column data shape on block
* ───────────────────────────
* block.available_columns   {Array}  – full column list resolved during first
*                                       render_relation_table call (set by
*                                       render_box_tool_print). Null/absent until
*                                       that first render; the UI stays hidden.
* block.table_columns       {Array}  – currently active ordered subset (may be
*                                       a full copy of available_columns).
*
* Each column descriptor: { tipo, path, label, header, width }
*   tipo    – component tipo (e.g. 'dd123')
*   label   – default header text from the component definition
*   header  – user-overridden header text (null → fall back to label)
*   width   – explicit column width in mm (null → auto)
*
* Active column rows are draggable to reorder. Drag is blocked on input elements
* (stopPropagation on mousedown) so typing in header/width fields does not start
* a drag. The drag protocol uses text/plain 'col:<key>' to identify columns.
*
* (!) available_columns is only populated AFTER the first paint of a relation
* cell. Before that the UI renders nothing (hidden). Trigger a canvas re-render
* if you need the columns to be available immediately.
* @param {Object} self - tool_print instance
* @param {Object} box - the cell's block descriptor (type === 'component')
*/
const render_table_columns_ui = function(self, box) {

	const container = self.inspector_columns
	if (!container) return

	const available = Array.isArray(box.available_columns) ? box.available_columns : null
	if (box.type!=='component' || !available) {
		container.classList.add('hide')
		container.replaceChildren()
		return
	}

	container.classList.remove('hide')
	container.replaceChildren()

	const current = Array.isArray(box.table_columns) ? box.table_columns : available.slice()

	ui.create_dom_element({
		element_type	: 'h3',
		class_name		: 'panel_subtitle',
		inner_html		: (get_label.columns || 'Table columns'),
		parent			: container
	})

	// active columns: drag-handle (reorder) + width + remove
	for (let i = 0; i < current.length; i++) {
		const key	= column_key(current[i])
		const row	= ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_row column_row',
			parent			: container
		})
		row.dataset.key = key
		row.draggable = true

		// drag handle (visual affordance)
		ui.create_dom_element({ element_type:'span', class_name:'button column_grip', title:'Drag to reorder', parent:row })
		// editable header: type to rename, clear to revert to the component label
		const hdr_input = ui.create_dom_element({ element_type:'input', class_name:'column_header_input', parent:row })
		hdr_input.type = 'text'
		hdr_input.value = (current[i].header !== undefined && current[i].header !== null) ? current[i].header : ''
		hdr_input.placeholder = current[i].label || ''
		hdr_input.title = 'Header label (blank = default name)'
		hdr_input.draggable = false
		// (!) prevent typing in header input from triggering drag on the parent row
		hdr_input.addEventListener('mousedown', (e) => e.stopPropagation())
		hdr_input.addEventListener('change', () => set_column_header(self, box, key, hdr_input.value))

		const ctrls = ui.create_dom_element({ element_type:'span', class_name:'column_ctrls', parent:row })
		// width (mm, blank = auto)
		const w_input = ui.create_dom_element({ element_type:'input', class_name:'column_width', parent:ctrls })
		w_input.type = 'number'; w_input.min = '0'; w_input.placeholder = 'mm'; w_input.draggable = false
		w_input.value = current[i].width != null ? current[i].width : ''
		w_input.title = 'Column width (mm)'
		// (!) prevent clicking/dragging in the width input from starting a column reorder drag
		w_input.addEventListener('mousedown', (e) => e.stopPropagation())
		w_input.addEventListener('change', () => {
			const v = parseFloat(w_input.value)
			set_column_width(self, box, key, Number.isFinite(v) ? v : null)
		})
		ui.create_dom_element({ element_type:'span', class_name:'button column_remove', title:'Remove column', parent:ctrls })
			.addEventListener('click', () => remove_table_column(self, box, key))

		// drag-and-drop reorder
		row.addEventListener('dragstart', (e) => {
			e.dataTransfer.effectAllowed = 'move'
			e.dataTransfer.setData('text/plain', 'col:' + key)
			row.classList.add('dragging')
		})
		row.addEventListener('dragend', () => {
			row.classList.remove('dragging')
			container.querySelectorAll('.column_row.drop_target').forEach(el => el.classList.remove('drop_target'))
		})
		row.addEventListener('dragover', (e) => {
			const data = e.dataTransfer.getData('text/plain')
			// allow during drag even when getData is empty (some browsers)
			e.preventDefault()
			e.dataTransfer.dropEffect = 'move'
			row.classList.add('drop_target')
		})
		row.addEventListener('dragleave', () => row.classList.remove('drop_target'))
		row.addEventListener('drop', (e) => {
			e.preventDefault()
			e.stopPropagation()
			row.classList.remove('drop_target')
			const raw = e.dataTransfer.getData('text/plain') || ''
			if (!raw.startsWith('col:')) return
			const from_key = raw.slice(4)
			reorder_table_column(self, box, from_key, key)
		})

		// second line: per-column style — text align, text colour, background colour
		const style_row = ui.create_dom_element({ element_type:'div', class_name:'inspector_row column_style_row', parent:container })
		style_row.dataset.key = key
		// align (blank = inherit)
		const al = ui.create_dom_element({ element_type:'select', class_name:'column_align', parent:style_row })
		al.title = 'Text align'
		;[['','—'],['left','L'],['center','C'],['right','R']].forEach(([v,t]) => ui.create_dom_element({ element_type:'option', value:v, inner_html:t, parent:al }))
		al.value = current[i].align || ''
		al.addEventListener('change', () => set_column_style(self, box, key, { align: al.value }))
		// text colour
		const tc_lbl = ui.create_dom_element({ element_type:'label', class_name:'column_color', inner_html:'<span>A</span>', parent:style_row })
		tc_lbl.title = 'Text colour'
		const tc = ui.create_dom_element({ element_type:'input', parent:tc_lbl })
		tc.type = 'color'
		tc.value = current[i].text_color || (box.style && box.style.text_color) || '#111111'
		tc.addEventListener('change', () => set_column_style(self, box, key, { text_color: tc.value }))
		// background colour
		const bg_lbl = ui.create_dom_element({ element_type:'label', class_name:'column_color', inner_html:'<span class="bg_swatch">▦</span>', parent:style_row })
		bg_lbl.title = 'Background colour'
		const bg = ui.create_dom_element({ element_type:'input', parent:bg_lbl })
		bg.type = 'color'
		bg.value = current[i].bg_color || '#ffffff'
		bg.addEventListener('change', () => set_column_style(self, box, key, { bg_color: bg.value }))
		// clear column style
		ui.create_dom_element({ element_type:'span', class_name:'column_style_clear', inner_html:'✕', title:'Clear column style', parent:style_row })
			.addEventListener('click', () => set_column_style(self, box, key, { align:undefined, text_color:undefined, bg_color:undefined }))
	}

	// default columns not currently shown (re-addable)
	const present	= new Set(current.map(column_key))
	const addable	= available.filter(c => !present.has(column_key(c)))
	for (let i = 0; i < addable.length; i++) {
		const key	= column_key(addable[i])
		const row	= ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inspector_row column_row column_addable',
			parent			: container
		})
		// the column label is the component's: text, never spliced into markup
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'column_name',
			text_content	: addable[i].label || '',
			parent			: row
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button column_add',
			title			: 'Add column',
			parent			: row
		}).addEventListener('click', () => add_default_column(self, box, key))
	}

	// drag hint
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'inspector_hint column_drag_hint',
		inner_html		: (get_label.drag_component_column || 'Drag a related component onto the table to add a column.'),
		parent			: container
	})
}//end render_table_columns_ui



/**
* ON_INSPECTOR_CHANGE
* Reads the inspector inputs back into the selected box and re-applies geometry
* and style, then triggers a full canvas re-render and re-selects the cell.
*
* Write path:
*   cell.width      ← cell_width % input / 100, clamped to [0.05, 1]
*   row.height_mm   ← space_after for spacer rows, min 1
*   row.space_after_mm ← space_after for regular rows, min 0
*   block.style.*   ← font/color/border inputs (if a block is selected)
*   block.show_label / block.show_table_header ← checkbox inputs
*
* After writing, select_cell is called in a requestAnimationFrame so it runs
* after the synchronous render_canvas has redrawn the DOM — without that delay
* the selection highlight would be applied to old nodes that get discarded.
* @param {Object} self - tool_print instance
*/
const on_inspector_change = function(self) {

	const sel = self.sel
	if (!sel) return
	const row	= find_row(self, sel.row_id)
	if (!row) return
	const cell	= sel.cell_id ? find_cell(self, sel.row_id, sel.cell_id) : null
	const block	= (cell && cell.block) ? cell.block : null

	const I = self.inspector_inputs

	// cell width (% → fraction); the mm field = spacer height for a spacer, else row gap
	if (cell) {
		const pct = to_num(I.cell_width.value, (cell.width || 1) * 100)
		cell.width = Math.max(0.05, Math.min(1, pct / 100))
	}
	if (row.kind==='spacer') {
		row.height_mm = Math.max(1, to_num(I.space_after.value, row.height_mm || 8))
	} else {
		row.space_after_mm = Math.max(0, to_num(I.space_after.value, row.space_after_mm || 0))
	}

	// component style/flags (target the selected cell's block)
	if (block) {
		block.style = block.style || {}
		block.style.font_size_pt	= to_num(I.font_size_pt.value, block.style.font_size_pt)
		block.style.align			= I.align.value
		block.style.font_family		= I.font_family.value
		block.style.text_color		= I.text_color.value
		block.style.border_show		= I.border_show.checked
		block.style.border_color	= I.border_color.value
		block.show_label			= I.show_label.checked
		block.show_table_header		= I.show_table_header.checked
	}

	self.mark_dirty?.()
	render_canvas(self, self.canvas_container)
	requestAnimationFrame(() => select_cell(self, sel.row_id, sel.cell_id))
}//end on_inspector_change



// template actions ----------------------------------------------------------

/**
* DO_NEW
* Starts a fresh unsaved layout (warns on unsaved changes).
*
* Resets the layout model, clears the template picker selection and name field,
* redraws the canvas with the empty new layout, and deselects any inspector
* selection. Does nothing if the user cancels the discard-changes confirmation.
* @param {Object} self - tool_print instance
*/
const do_new = function(self) {
	if (self.dirty && !confirm(get_label.sure || 'Discard unsaved changes?')) return
	self.layout = new_layout(self)
	self.current_template_id = null
	self.sel = null
	self.dirty = false
	if (self.template_picker) self.template_picker.value = ''
	if (self.name_input) self.name_input.value = ''
	render_canvas(self, self.canvas_container)
	sync_inspector(self, null)
}//end do_new



/**
* DO_SAVE
* Saves to the loaded template, or falls back to Save as… when unsaved.
*
* The template name is always taken from the inline name field (self.name_input)
* rather than a native prompt(), because prompt() is silently blocked in the
* tool window context on some browsers.
*
* Save result detection: envelope v2 — the save succeeded unless the call
* answered with an ApiError (`request_failed`); `save_layout` answers `false`
* when it refused before the request left the browser.
* @param {Object} self - tool_print instance
* @returns {Promise<void>}
*/
const do_save = async function(self) {

	// name comes from the inline field (no blocking native prompt)
	self.layout.name = (self.name_input && self.name_input.value.trim()) || self.layout.name || 'Untitled'

	let ok = false
	if (self.current_template_id) {
		const res = await save_layout({ section_id: self.current_template_id, layout: serialize_layout(self) })
		ok = !!(res && !request_failed(res))
	} else {
		const new_id = await create_new_layout({ self, name: self.layout.name, layout: serialize_layout(self) })
		if (new_id) {
			self.current_template_id = new_id
			await refresh_template_picker(self)
			if (self.template_picker) self.template_picker.value = '' + new_id
			ok = true
		}
	}

	if (ok) {
		self.dirty = false
		flash_saved(self)
	} else {
		flash_saved(self, true)
	}
}//end do_save



/**
* DO_SAVE_AS
* Forks the current layout into a NEW template record (new name, no prompt).
*
* The new name is derived by appending ' copy' to the current name field value.
* After the new record is created, self.current_template_id is updated and the
* template picker is refreshed and pointed to the new entry.
*
* (!) Does NOT ask for confirmation — it always creates a new record. If the
* user saves a fork they did not intend, they can Delete it immediately.
* @param {Object} self - tool_print instance
* @returns {Promise<void>}
*/
const do_save_as = async function(self) {
	const base = (self.name_input && self.name_input.value.trim()) || self.layout.name || 'Untitled'
	self.layout.name = base + ' copy'
	if (self.name_input) self.name_input.value = self.layout.name
	const new_id = await create_new_layout({ self, name: self.layout.name, layout: serialize_layout(self) })
	if (new_id) {
		self.current_template_id = new_id
		self.dirty = false
		await refresh_template_picker(self)
		if (self.template_picker) self.template_picker.value = '' + new_id
		flash_saved(self)
	} else {
		flash_saved(self, true)
	}
}//end do_save_as



/**
* FLASH_SAVED
* Brief visible feedback on the Save button (ui.notify is unavailable).
*
* Temporarily replaces the button text with '✓ Saved' or '✕ Error', adds the
* corresponding CSS class, then restores the original text after 1.4 s.
* Using the button itself as the feedback target avoids a floating notification
* which would require ui.notify (not available in the tool context).
* @param {Object} self - tool_print instance
* @param {boolean} [failed] - true for error state; omit or false for success
*/
const flash_saved = function(self, failed) {
	const btn = self.button_save
	if (!btn) return
	const prev = btn.textContent
	btn.textContent = failed ? '✕ Error' : '✓ Saved'
	btn.classList.toggle('flash_error', !!failed)
	btn.classList.toggle('flash_ok', !failed)
	setTimeout(() => {
		btn.textContent = prev
		btn.classList.remove('flash_ok', 'flash_error')
	}, 1400)
}//end flash_saved



/**
* DO_DELETE
* Deletes the loaded template (owner only), then resets to a new layout.
*
* On success, clears self.current_template_id, replaces the layout with a
* fresh blank, refreshes the picker, and resets the canvas and inspector.
* On failure (delete_layout returns falsy), does nothing silently — the
* template picker retains its previous state.
* @param {Object} self - tool_print instance
* @returns {Promise<void>}
*/
const do_delete = async function(self) {
	if (!self.current_template_id) return
	if (!confirm(get_label.sure || 'Delete this template?')) return
	const res = await delete_layout(self.current_template_id)
	if (res) {
		self.current_template_id = null
		self.layout = new_layout(self)
		self.dirty = false
		await refresh_template_picker(self)
		render_canvas(self, self.canvas_container)
		sync_inspector(self, null)
	}
}//end do_delete



/**
* LOAD_TEMPLATE
* Loads a saved template blob into the canvas.
*
* On confirmation (if dirty), fetches the blob by section_id from
* print_layout_presets, normalises it to v2 via normalize_blob, reseats all
* row/cell ids via reseat_ids (prevents id collisions between templates loaded
* in different sessions), and repaints the canvas + inspector.
*
* If the user declines to discard changes, the template picker is reset to
* the previously loaded template so the UI is not left pointing at an unloaded
* entry.
*
* (!) reseat_ids is mandatory after load: a saved template carries ids from the
* session in which it was saved. Loading without reseating would collide with
* the current session's id counter and cause select_cell to pick the wrong row.
* @param {Object} self - tool_print instance
* @param {string|number} section_id - dd25 section id of the template to load
* @returns {Promise<void>}
*/
const load_template = async function(self, section_id) {

	if (self.dirty && !confirm(get_label.sure || 'Discard unsaved changes?')) {
		// restore picker selection
		if (self.template_picker) self.template_picker.value = self.current_template_id || ''
		return
	}

	const blob = await load_layout({ section_id })
	if (!blob) {
		console.warn('tool_print: empty/invalid layout blob for', section_id, blob)
		return
	}

	// normalize to v2 (v1 blobs become an empty flow — not migrated)
		self.layout = normalize_blob(self, blob)
		// re-assign unique row/cell ids: a saved template carries ids from another
		// session that would collide with this session's counter (duplicate ids →
		// select_cell picks the wrong row). Reseat de-duplicates and seeds the counter.
		reseat_ids(self)
		self.current_template_id = section_id
		self.sel = null
		self.dirty = false
		if (self.name_input) self.name_input.value = (self.layout.name && self.layout.name!=='Untitled') ? self.layout.name : ''

	render_canvas(self, self.canvas_container)
	sync_inspector(self, null)

	// refresh box contents in the current fill mode
		refresh_all_box_content(self)

	if (self.template_picker) self.template_picker.value = '' + section_id
}//end load_template



/**
* NORMALIZE_BLOB
* Fills missing top-level fields of a loaded blob with sane defaults so the
* editor/renderer never hit undefined.
*
* v2 detection: blob.schema_version === 2 AND blob.flow.rows is a real Array.
* v1 blobs (absolute-position pages/boxes from the original prototype — now test
* data only) are NOT migrated; the flow is replaced with an empty row set so
* the editor opens without crashing. The user will see an empty canvas.
*
* The spread merge is intentionally shallow for the top-level keys, but deep
* for page_defaults, grid, style_defaults, and flow — those sub-objects are
* always fully merged against their defaults so optional keys are never missing.
* @param {Object} self - tool_print instance (used to build the defaults via new_layout)
* @param {Object} blob - raw blob loaded from dd625 storage
* @returns {Object} normalised layout blob at schema_version 2
*/
const normalize_blob = function(self, blob) {
	const def = new_layout(self)
	// v2 document-flow only. v1 blobs (absolute pages/boxes — test data) are not
	// migrated: start from an empty flow so the editor never sees the old shape.
	const is_v2 = blob && blob.schema_version===2 && blob.flow && Array.isArray(blob.flow.rows)
	return {
		...def,
		...blob,
		schema_version	: 2,
		page_defaults	: { ...def.page_defaults, ...(blob.page_defaults || {}) },
		grid			: { ...def.grid, ...(blob.grid || {}) },
		style_defaults	: { ...def.style_defaults, ...(blob.style_defaults || {}) },
		flow			: is_v2 ? { rows: blob.flow.rows } : def.flow
	}
}//end normalize_blob



/**
* REFRESH_TEMPLATE_PICKER
* Re-queries the available templates and rebuilds the picker options. Records
* the default template id (first one in the list) in self.default_template_id
* for the auto-load on initial open.
*
* The query may fail (network, permission) — errors are caught and logged,
* falling back to an empty list so the picker shows only the placeholder option.
*
* If self.current_template_id is already set (e.g. after a save), the picker
* is scrolled to that entry so the active template remains highlighted.
* @param {Object} self - tool_print instance
* @returns {Promise<void>}
*/
const refresh_template_picker = async function(self) {

	const picker = self.template_picker
	if (!picker) return

	let list = []
	try {
		list = await query_layouts(self)
	} catch (error) {
		console.error('tool_print refresh_template_picker error:', error)
	}

	picker.replaceChildren()
	ui.create_dom_element({
		element_type	: 'option',
		value			: '',
		inner_html		: '— ' + (get_label.select || 'Select template') + ' —',
		parent			: picker
	})
	for (let i = 0; i < list.length; i++) {
		ui.create_dom_element({
			element_type	: 'option',
			value			: '' + list[i].section_id,
			inner_html		: list[i].name,
			parent			: picker
		})
	}

	self.default_template_id = list.length ? list[0].section_id : null
	if (self.current_template_id) picker.value = '' + self.current_template_id
}//end refresh_template_picker



// fill / print --------------------------------------------------------------

/**
* TOGGLE_FILL_MODE
* Switches between placeholder and record-filled rendering and repaints boxes.
*
* fill_mode = false: each box displays a visual placeholder (component name +
* tipo), no server fetch. fill_mode = true: each box fetches and renders the
* component's actual value for self.preview_section_id.
* @param {Object} self - tool_print instance
* @param {boolean} checked - true to enable record data fill; false for placeholders
*/
const toggle_fill_mode = function(self, checked) {
	self.fill_mode = checked
	refresh_all_box_content(self)
}//end toggle_fill_mode



/**
* REFRESH_ALL_BOX_CONTENT
* Re-renders every box's content (placeholder or filled).
*
* Iterates the v2 document-flow model: rows → cells → cell.block. Only
* blocks that already have a content_node (attached by the flow engine during
* layout_flow) are re-rendered; blocks whose nodes have been destroyed (e.g.
* after a full canvas re-render) are silently skipped.
*
* This is a lightweight re-fill that does NOT trigger a full canvas layout
* pass — it replaces cell content in-place. Call render_canvas instead if
* geometry or pagination may change.
* @param {Object} self - tool_print instance
*/
const refresh_all_box_content = function(self) {
	// v2 document-flow model: rows of cells, the cell.block is the "box" and
	// content_node is attached during render_row_node. Layout has no `pages`.
	const rows = (self.layout.flow && Array.isArray(self.layout.flow.rows)) ? self.layout.flow.rows : []
	for (let r = 0; r < rows.length; r++) {
		const cells = Array.isArray(rows[r].cells) ? rows[r].cells : []
		for (let c = 0; c < cells.length; c++) {
			const block = cells[c].block
			if (block && block.content_node) {
				render_box_content(self, block)
			}
		}
	}
}//end refresh_all_box_content



/**
* DO_PRINT
* The solid print path: always builds a fresh print document laid out in
* millimetres (zoom-independent), one page-sequence per record (edit = 1 record,
* list = every record of the filter). Prints the document and restores the
* editor.
*
* Record id resolution
* ─────────────────────
* 1. self.get_record_ids() — async method supplied by the tool framework; in
*    edit mode returns a 1-element array, in list mode all filtered record ids.
* 2. Falls back to [self.preview_section_id] when get_record_ids is absent or
*    returns nothing.
* 3. Falls back to window.print() on the bare canvas when no ids are available
*    at all (template-only context with no active record).
*
* Print / restore cycle
* ──────────────────────
* The rendered .print_document is appended to self.canvas_container alongside
* the editor's .print_root (which is hidden). After window.print() the document
* is removed either on the `afterprint` event or after a 2.5 s safety timeout
* (some browsers fire afterprint late or not at all).
* @param {Object} self - tool_print instance
* @returns {Promise<void>}
*/
const do_print = async function(self) {

	let ids = []
	try {
		ids = await self.get_record_ids()
	} catch (error) {
		console.error('tool_print do_print get_record_ids error:', error)
	}
	if (!ids || !ids.length) {
		ids = self.preview_section_id ? [ self.preview_section_id ] : []
	}
	if (!ids.length) { window.print(); return } // nothing to fill; print as-is

	// bound the batch: above the cap, refuse and ask the user to narrow the filter
	// (the browser path can't safely render hundreds; server-side batch is Phase 2)
		if (ids.length > PRINT_MAX) {
			const total = self._last_record_total || ids.length
			window.alert(
				(get_label.tool_print_too_many || 'This filter matches {n} records. Printing is limited to {max} at a time — narrow the filter and try again.')
					.replace('{n}', total).replace('{max}', PRINT_MAX)
			)
			return
		}
	// confirm a multi-record run so a click can't silently launch a long render
		if (ids.length > 1) {
			const ok = window.confirm(
				(get_label.tool_print_confirm_n || 'Print {n} records as a single PDF?').replace('{n}', ids.length)
			)
			if (!ok) return
		}

	// progress overlay + cancellation
		const ac = new AbortController()
		const progress = show_print_progress(self, () => ac.abort())

	let doc
	try {
		doc = await render_print_document(self, ids, { signal: ac.signal, on_progress: (k, n) => progress.update(k, n) })
	} catch (error) {
		progress.remove()
		if (self.print_root) self.print_root.style.display = ''
		if (error && error.name === 'AbortError') return            // user cancelled — silent
		console.error('tool_print do_print render error:', error)
		return
	}
	progress.remove()

	try {
		// @page size from the first page
			set_page_style(self)
		// attach the document (already paginated by the flow engine, in mm) + hide editor
			if (self.print_root) self.print_root.style.display = 'none'
			self.canvas_container.appendChild(doc)
		window.print()
	} catch (error) {
		console.error('tool_print do_print error:', error)
		if (doc && doc.parentNode) doc.remove()
		if (self.print_root) self.print_root.style.display = ''
		return
	}

	// restore the editor after printing
		const cleanup = () => {
			if (doc && doc.parentNode) doc.remove()
			if (self.print_root) self.print_root.style.display = ''
		}
		const on_after = () => { window.removeEventListener('afterprint', on_after); cleanup() }
		window.addEventListener('afterprint', on_after)
		setTimeout(() => { window.removeEventListener('afterprint', on_after); cleanup() }, 2500)
}//end do_print



/**
* SHOW_PRINT_PROGRESS
* Lightweight overlay shown while the multi-record document renders off-screen
* (before the print dialog). Reports "Rendering k / N" and offers Cancel, which
* fires on_cancel() (wired to an AbortController in do_print).
* @param {Object} self - tool_print instance
* @param {Function} on_cancel - called when the user clicks Cancel
* @returns {{update:Function, remove:Function}}
*/
const show_print_progress = function(self, on_cancel) {
	const overlay = ui.create_dom_element({ element_type:'div', class_name:'print_progress no_print', parent: (self.node || document.body) })
	const label   = ui.create_dom_element({ element_type:'div', class_name:'print_progress_label',
		inner_html:(get_label.loading || 'Preparing…'), parent: overlay })
	const cancel  = ui.create_dom_element({ element_type:'button', class_name:'print_progress_cancel',
		inner_html:(get_label.cancel || 'Cancel'), parent: overlay })
	cancel.addEventListener('click', () => { cancel.disabled = true; label.textContent = (get_label.processing || 'Cancelling…'); on_cancel() })
	return {
		update : (k, n) => { label.textContent = (get_label.tool_print_rendering || 'Rendering {k} / {n}…').replace('{k}', k).replace('{n}', n) },
		remove : () => { if (overlay.parentNode) overlay.remove() }
	}
}//end show_print_progress



/**
* SET_PAGE_STYLE
* Injects a <style id="tool_print_page_style"> @page rule with the current
* page format's physical dimensions so the browser prints at the correct size.
*
* Uses page_dims(self, null) which reads self.layout.page_defaults and
* applies the current orientation to swap width/height as needed. Creating the
* style element once and reusing it (via getElementById) avoids accumulating
* stale rules in <head> across multiple print calls.
* @param {Object} self - tool_print instance
*/
const set_page_style = function(self) {
	const dims = page_dims(self, null)
	let style_el = document.getElementById('tool_print_page_style')
	if (!style_el) {
		style_el = document.createElement('style')
		style_el.id = 'tool_print_page_style'
		document.head.appendChild(style_el)
	}
	style_el.textContent = `@media print { @page { size: ${dims.width_mm}mm ${dims.height_mm}mm; margin: 0; } }`
}//end set_page_style



/**
* RENDER_PRINT_DOCUMENT
* Builds a detached .print_root with the chosen template rendered once per
* record id, in millimetres (zoom-independent, print-ready). Read-only: no
* editor chrome, no handles.
*
* The root is temporarily attached off-screen during the layout pass so the flow
* engine can measure row heights (offsetHeight returns 0 on detached nodes —
* without this, every row appears 0px tall, everything "fits" on one page, and
* the PDF has only the first page).
*
* Off-screen attachment strategy
* ────────────────────────────────
* The root is attached inside self.node (the .wrapper_tool.tool_print element)
* at position: absolute; left: -99999px; visibility: hidden (not display:none
* — hidden keeps layout geometry accessible). Attaching inside self.node is
* critical: tool_print.css scopes its height-overriding rules
* (.cell_content .wrapper_component { display:block; height:auto; max-height:none })
* to .tool_print descendants. Attaching to document.body instead would leave
* components rendered at their default max-heights (e.g. CKEditor ~180px
* scrollable), causing the flow engine to measure rows too short and split them
* at the wrong positions — producing too few pages.
*
* Per-record pass
* ─────────────────
* self.preview_section_id is temporarily overridden for each record_id so
* render_box_content fetches that record's data. The per-block table cache
* auto-invalidates because its key includes the record id. A CSS .print_page
* boundary between records is handled by the .print_page CSS (page-break-before).
*
* State saved/restored via try/finally (preview_section_id, fill_mode), so an
* error in layout_flow cannot leave the tool in fill mode on the wrong record.
*
* (!) Exported: also called by the list-print button or external print triggers
* that bypass do_print and want the fully-laid-out DOM directly.
* @param {Object} self - tool_print instance
* @param {Array} record_ids - array of section_id values to render
* @returns {Promise<HTMLElement>} the detached .print_root element, ready to attach
*/
export const render_print_document = async function(self, record_ids, options={}) {

    const signal      = options.signal || null
    const on_progress = options.on_progress || null

    const root = ui.create_dom_element({
        element_type    : 'div',
        class_name        : 'print_root print_document'
    })

    // Attach off-screen so offsetHeight/getBoundingClientRect work during layout.
    // visibility:hidden (not display:none) keeps layout geometry intact.
    // CRITICAL: attach inside self.node (the .wrapper_tool.tool_print element) so
    // the tool_print CSS rules that force component wrappers to natural height
    // (max-height:none, overflow:visible) apply during the measurement pass.
    // Attaching to document.body instead leaves those rules unscoped and
    // components render with their default max-heights/scrollable containers,
    // causing the flow engine to measure them as too short and produce too few
    // pages (only first and last).
        root.style.position        = 'absolute'
        root.style.left            = '-99999px'
        root.style.top            = '0'
        root.style.visibility    = 'hidden'
        ;(self.node || document.body).appendChild(root)

    // v2: run the SAME flow engine as the editor, but in physical mm (zoom-
    // independent). One pass per record; cells render that record's data
    // (render_box_content reads self.preview_section_id; the per-block table
    // cache auto-invalidates because its key includes the record id). A page
    // break between records is handled by the .print_page CSS.
    const saved_preview    = self.preview_section_id
    const saved_fill    = self.fill_mode
    self.fill_mode = true

    // Wait for web fonts before the first measure: a font that loads AFTER layout
    // changes every text row's height and silently shifts every page break.
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready } catch (e) { /* noop */ }

    // PERFORMANCE: one bulk read hydrates every template component for all records
    // (self._print_datum), so each cell builds with build(false) — no per-cell API
    // call. Best-effort: if it fails, cells fall back to per-cell build(true).
        try { if (typeof self.fetch_print_datum==='function') await self.fetch_print_datum(record_ids) } catch (e) { console.warn('tool_print: bulk datum fetch failed, falling back to per-cell', e) }

    try {
        for (let r = 0; r < record_ids.length; r++) {
            if (signal && signal.aborted) { const e = new Error('print cancelled'); e.name = 'AbortError'; throw e }
            self.preview_section_id = record_ids[r]
            const ctx = make_print_ctx(self, root)
            await layout_flow(self, ctx)
            // decode any freshly-rendered images so their real height is settled
            const imgs = [...root.querySelectorAll('img')].filter(i => !i.complete && i.decode)
            if (imgs.length) await Promise.all(imgs.map(i => i.decode().catch(() => {})))
            if (on_progress) on_progress(r + 1, record_ids.length)
            // yield to the event loop so the tab stays responsive, the progress
            // overlay paints, and a Cancel click is processed between records
            await new Promise(res => requestAnimationFrame(res))
        }
        // drop blank pages: a record that produced no rows (e.g. all components
        // empty for that record) leaves a .print_page with an empty .flow_column,
        // which would print as a blank sheet
        root.querySelectorAll('.print_page').forEach(pg => {
            const col = pg.querySelector('.flow_column')
            if (col && col.childElementCount === 0) pg.remove()
        })
    } finally {
        self.preview_section_id    = saved_preview
        self.fill_mode            = saved_fill
        self._print_datum        = null   // clear the bulk datum (editor preview rebuilds per-record)
        // detach the off-screen root so do_print can reattach it in the canvas
            root.remove()
            root.style.position        = ''
            root.style.left            = ''
            root.style.top            = ''
            root.style.visibility    = ''
    }


    return root
}//end render_print_document






// @license-end
