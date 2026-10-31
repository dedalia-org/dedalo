// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global  SHOW_DEBUG*/
/*eslint no-undef: "error"*/



// imports
	import {when_in_dom} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'



/**
* VIEW_DEFAULT_LIST_SECTION_RECORD
* Default list-view renderer for a section_record row.
*
* This module implements the full-column grid layout used whenever
* `section_record.context.view` is 'default' (or any unrecognised view token).
* It is selected and called by `render_list_section_record.prototype.list`
* (see render_list_section_record.js) and never invoked directly.
*
* Main responsibilities:
*   - Build the outer wrapper <div> for the row with CSS classes derived from
*     the record's model, tipo, mode, and view.
*   - Attach mouse-enter/leave row-highlight behaviour for desktop viewports
*     when the immediate caller is a section (not a nested portal).
*   - Delegate column layout to `get_content_data`, which renders every
*     `columns_map` entry concurrently (callback columns included) and then
*     assembles the resulting nodes into a DocumentFragment in columns_map
*     order.
*
* Exports:
*   - `view_default_list_section_record`  — stub constructor / namespace carrier
*   - `view_default_list_section_record.render` — main entry point (async)
*   - `render_column_node_callback` — named export used by other view renderers
*     that need to create a callback-based column node with the same markup/class
*     conventions as this view.
*
* Rendering pipeline (per row):
*   render()
*     └─ get_content_data(self)
*           └─ render_column() — one per columns_map entry, all concurrent
*                 ├─ render_callback()          — for columns whose definition carries `.callback`
*                 └─ [instance.render() | column.render_callback(instance)] in parallel
*                       └─ render_column_node() — creates the per-column <div>
*/



/**
* VIEW_DEFAULT_LIST_SECTION_RECORD
* Stub constructor — never instantiated.
* Exists only as a namespace carrier so that the static `render` method
* can be attached following Dédalo's module convention.
* @returns {boolean} Always true.
*/
export const view_default_list_section_record = function() {

	return true
}//end view_default_list_section_record



/**
* RENDER
* Build and return the root DOM wrapper for one section_record row in default
* list view mode.
*
* The wrapper receives CSS classes: `[model] [tipo] [mode] view_[view]`.
* It is registered in the DOM by the caller (section.js), not by this function.
*
* Conditional row-hilite:
*   Row-highlight (mouse-enter/leave) is attached only when BOTH conditions hold:
*     1. `options.add_hilite_row` is true (default).
*     2. The immediate caller model is 'section' (a time-machine list is one).
*   This guards against activating highlights inside deeply nested portal rows,
*   which would interfere with the outer section's own highlight.
*
* (!) The `hilite_row` call is deferred via `when_in_dom` so it runs only after
*   the wrapper is actually inserted into the live document, ensuring that
*   `getBoundingClientRect()` measurements inside `hilite_row` are valid.
*
* Debug mode (SHOW_DEBUG === true):
*   Alt-clicking the wrapper logs the full section_record instance to the console,
*   which is the canonical way to inspect a row during development.
*
* @param {Object} self - The section_record instance being rendered.
*   Accessed: self.id, self.model, self.tipo, self.mode, self.context.view,
*             self.caller.model, self.columns_map, self.get_ar_columns_instances_list().
* @param {Object} options - Rendering options.
* @param {boolean} [options.add_hilite_row=true] - Whether to attach the
*   mouse-enter/leave row-highlight handler.  Pass false to suppress highlighting
*   (e.g. inside print views or when the outer layout manages hover styling itself).
* @param {boolean} [options.mark_empty_columns=false] - Stamp `empty_column` on
*   this row's value-less cells (the Time Machine tool list). A row option, not a
*   pass over the list: a row window builds rows later (placeholder swaps,
*   WC-2026-10-30-section-record-row-box) and those must be marked too.
* @returns {Promise<HTMLElement>} The populated wrapper <div> for this row.
*/
view_default_list_section_record.render = async function(self, options) {

	// options
		const add_hilite_row = options.add_hilite_row!==undefined
			? options.add_hilite_row
			: true // default

	// wrapper.  section_record wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			id				: self.id
		})
		const ar_css = [
			self.model,
			self.tipo,
			self.mode,
			'view_'+self.context.view
		]
		wrapper.classList.add(...ar_css)

		// hilite_row. User mouse enter/mouseleave creates an DOM node to hilite current row
		// Note that only is activated when self.caller is a section to prevent deep portals issues
			if (add_hilite_row===true && self.caller.model==='section') {
				when_in_dom(wrapper, function(){
					hilite_row(wrapper)
				})
			}

	// content_data render_columns
		const fragment = await get_content_data(self)
		// destroyed during the await case: a concurrent reload (e.g. two overlapping
		// inspector time_machine_list loads) can destroy this instance while its columns
		// are still rendering. destroy() nullifies self.caller, so anything downstream
		// reading self.caller.model would throw. Return the bare wrapper instead: the
		// node is already orphaned and the winning render owns the DOM.
		if (self.caller===null) {
			return wrapper
		}
		wrapper.appendChild(fragment)

	// mark_empty_columns. Per row (see options.mark_empty_columns)
		if (options.mark_empty_columns===true) {
			mark_empty_columns(wrapper)
		}

	// debug
		if(SHOW_DEBUG===true) {
			wrapper.addEventListener('click', function(e){
				if (e.altKey) {
					e.stopPropagation()
					e.preventDefault()
					console.log('/// selected instance:', self);
				}
			})
		}


	return wrapper
}//end render



/**
* MARK_EMPTY_COLUMNS
* Stamps `empty_column` on every value-less cell of one row.
*
* WHY: on small screens the Time Machine tool list stacks ALL columns of a
* snapshot vertically under its Id header, and a section carries ~15 fields
* while a snapshot touches a handful — the empty cells drown the data. The
* class is only a MARKER: the hiding is CSS, scoped to the phone breakpoint
* (tool_time_machine.less), so the desktop table keeps every column aligned.
*
* A column counts as empty when it has no text AND no media/control inside —
* image-only values (thumbnails) must survive. Idempotent.
* @param {HTMLElement} row - The section_record row node
* @returns {void}
*/
const mark_empty_columns = function(row) {

	const columns = row.querySelectorAll(':scope > .column')
	for (const column of columns) {
		const has_content = column.querySelector('img, svg, iframe, video, canvas, button, input, textarea')
		if (!has_content && column.textContent.trim()==='') {
			column.classList.add('empty_column')
		}
	}
}//end mark_empty_columns



/**
* HILITE_ROW
* Attach mouseenter / mouseleave handlers to the row wrapper that visually
* highlight the full row spanning all its columns.
*
* Implementation detail — CSS custom properties approach:
*   Dédalo's list grid renders each column as a separate <div> child of the
*   section <ul>/<div>; there is no single "row" DOM element that can be styled
*   directly.  The highlight is therefore painted via the `::after` pseudo-element
*   of the **first column** node, whose width is stretched to cover all columns
*   using the CSS custom property `--box_width`.
*
*   On mouseenter:
*     1. Any pre-existing highlight is cleared first (so stale state from rapid
*        mouse movement cannot persist).
*     2. The total row width is measured via `getBoundingClientRect()` on the
*        first and last column nodes.
*     3. `--box_display: block` and `--box_width: <N>px` are set on the first
*        column, making the `::after` pseudo-element appear.
*
*   On mouseleave:
*     `--box_display` is set back to `'none'`, hiding the pseudo-element.
*
* Small-screen guard:
*   When the viewport is narrower than 960 px the highlight is skipped because
*   columns stack vertically in the responsive layout and the computed width
*   would be incorrect.  The check is performed inside `fn_hilite` (not once at
*   attach time) so that resizing the window is automatically handled.
*
* @param {HTMLElement} wrapper - The section_record root wrapper node (already in
*   the live DOM when this function is called, because it is invoked via
*   `when_in_dom`).
* @returns {boolean} Always true.
*/
const hilite_row = function(wrapper) {

	// fn_hilite. Add hilite
		const fn_hilite = function() {

			// remove previous hilite if exist
				fn_remove_hilite()

			// small screen case. Do not add hilite. (Place here because user can resize the window)
				const width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
				if (width<960) {
					return
				}

			// row_style
				const wrapper_first_column	= wrapper.firstChild
				const wrapper_last_column	= wrapper.lastChild
				const firstChild_el_rect	= wrapper_first_column.getBoundingClientRect();
				const lastChild_el_rect		= wrapper_last_column.getBoundingClientRect();
				const row_style				= {
					width : parseFloat(lastChild_el_rect.x + lastChild_el_rect.width - firstChild_el_rect.x) + 'px'
				}

			// hilite_row_node. First column set vars. This affect ::after pseudo element
				wrapper_first_column.style.setProperty('--box_display', 'block');
				wrapper_first_column.style.setProperty('--box_width', row_style.width);
		}

	// fn_remove_hilite (if is set)
		const fn_remove_hilite = () => {
			// first column set vars. This affect ::after pseudo element
			wrapper.firstChild.style.setProperty('--box_display', 'none');
		}

	// events
		wrapper.addEventListener('mouseenter', fn_hilite);
		wrapper.addEventListener('mouseleave', fn_remove_hilite);


	return true
}//end hilite_row



/**
* GET_CONTENT_DATA
* Render all columns defined in `self.columns_map` and collect the resulting
* DOM nodes into a single DocumentFragment.
*
* Every `columns_map` entry is rendered CONCURRENTLY via `render_column` (a
* row's latency is the max of its columns, not the sum).  `Promise.allSettled`
* is used rather than `Promise.all` so that a single failing column does not
* abort the rest of the row's RENDER phase; a rejected column falls back to an
* empty placeholder node.
* (!) That isolation covers RENDER only.  The child-instance BUILD happens
* earlier, in the awaited `self.get_ar_columns_instances_list()` below, OUTSIDE
* the allSettled: a rejecting child build still rejects this row — and, through
* the section-level `Promise.all` over rows in view_default_list_section.js,
* the whole list page.  That is the pinned contract (see the reject-then-retry
* gate in test/client/js/test_section_record.js), not an oversight here.
* Fragment order is enforced structurally: each column's
* nodes resolve into `settled[i]` and are appended in a second pass that walks
* the results in `columns_map` index order.
*
* Column types (handled inside `render_column`, in order of priority):
*
*   1. Callback columns (`column.callback` is a Function):
*      The column definition carries a fully custom render function (e.g. a
*      tool_time_machine "id" column or a delete button column).  The function
*      is invoked via `render_callback`, which supplies it with a context object
*      built from the current section_record instance; non-Node return values
*      fall back to an empty column placeholder and log an error.
*
*   2. Zero-instance columns (user has no access or no data):
*      When `ar_columns_instances` contains no instances for the current column
*      id, an empty placeholder column node is inserted to keep the grid
*      structure intact.
*
*   3. Normal component columns:
*      All instances that belong to the column are rendered in parallel via
*      `Promise.allSettled`, using either `column.render_callback(instance)` (if
*      defined) or `instance.render()` (the standard path).  `Promise.allSettled`
*      is used rather than `Promise.all` so that a single failing render does not
*      abort the entire row.
*
*      After all renders complete, instances are grouped into their column <div>
*      nodes.  If multiple instances share the same `column_id` (portal case),
*      they are placed into the same column node; otherwise a new node is created
*      via `render_column_node`.
*
* Performance note:
*   In debug mode (`SHOW_DEBUG === true`), column render times exceeding 25 ms
*   are logged as warnings.  Because columns now overlap, the measured time is
*   the column's own start-to-settle wall clock, which includes time spent
*   yielded to sibling columns — treat it as an upper bound, not exclusive cost.
*
* @param {Object} self - The section_record instance.
*   Accessed: self.columns_map, self.get_ar_columns_instances_list().
* @returns {Promise<DocumentFragment>} A fragment containing one column <div> per
*   entry in `self.columns_map`, in order.
*/
const get_content_data = async function(self) {

	// ar_columns_instances
		const ar_columns_instances	= await self.get_ar_columns_instances_list() // around 10 - 20 instances
		const columns_map			= self.columns_map

	// fragment
		const fragment = new DocumentFragment()

	// render all columns concurrently. Each promise resolves to the ordered
	// array of column nodes for its columns_map entry; results are indexed by
	// columns_map position, which is what guarantees the fragment order below
		const column_promises = columns_map.map(
			(current_column) => render_column(self, current_column, ar_columns_instances)
		)
		const settled = await Promise.allSettled(column_promises)

	// assemble the fragment in columns_map order (explicit second pass)
		const columns_map_length = columns_map.length
		for (let i = 0; i < columns_map_length; i++) {

			const result = settled[i]
			if (result.status==='fulfilled') {
				const ar_nodes			= result.value
				const ar_nodes_length	= ar_nodes.length
				for (let j = 0; j < ar_nodes_length; j++) {
					fragment.appendChild(ar_nodes[j])
				}
			}else{
				// one failing column must not abort the row; keep the grid structure
				console.error('Error rendering column:', columns_map[i], result.reason);
				fragment.appendChild( render_empty_column_node(columns_map[i], self) )
			}
		}//end for (let i = 0; i < columns_map_length; i++)


	return fragment
}//end get_content_data



/**
* RENDER_COLUMN
* Render ONE columns_map entry and return its column node(s) as an ordered
* array, without touching the shared fragment (get_content_data appends them
* in columns_map order).  All mutable state here is column-local, so multiple
* render_column calls run safely in parallel.
*
* @param {Object} self - The section_record instance.
* @param {Object} current_column - The columns_map entry to render.
* @param {Array} ar_columns_instances - All row instances; filtered here by column id.
* @returns {Promise<Array>} Ordered array of column <div> nodes for this entry
*   (normally exactly one).
*/
const render_column = async function(self, current_column, ar_columns_instances) {

	const t = performance.now()

	// ar_result_nodes. Ordered nodes to be appended to the fragment by the caller
		const ar_result_nodes = []

	// callback column case
	// (!) Note that many colum_id are callbacks (like tool_time_machine id column)
		if(current_column.callback && typeof current_column.callback==='function'){
			const column_node = await render_callback(self, current_column)
			if (column_node instanceof Node || column_node instanceof DocumentFragment) {
				ar_result_nodes.push(column_node)
			}else{
				console.error('Ignored non valid DOM node on render callback: ', column_node);
				ar_result_nodes.push( render_empty_column_node(current_column, self) )
			}
			return ar_result_nodes;
		}

	// get the specific instances for the current column
		const column_instances			= ar_columns_instances.filter(el => el.column_id === current_column.id)
		const column_instances_length	= column_instances.length

	// case zero (user don't have enough privileges cases)
		if (column_instances_length===0) {
			// empty column case
			ar_result_nodes.push( render_empty_column_node(current_column, self) )
			return ar_result_nodes;
		}

	// loop the instances for select the parent node

	// render all instances in parallel before create the columns nodes (to get the internal nodes)
		const promises = column_instances.map(async (instance, index) => {

			// Already rendered case
			if (instance.node !== null) {
				return { success: true, index };
			}

			// render the instance
			// if the column has defined a render_callback use it to render the instance
			// else use the common render
			// render_callback allow to add event listeners to the instance nodes
			const instance_node = (current_column.render_callback && typeof current_column.render_callback==='function')
				? await current_column.render_callback(instance)
				: await instance.render()

			// Validate the returned node
			if (!instance_node) {
				console.error('Invalid instance_node at index', index, 'model:', instance.model, 'tipo:', instance.tipo, 'node pointer:', instance.node);
				return { success: false, index, error: 'Invalid instance node' };
			}

			return { success: true, index, node: instance_node };
		});

		// nodes. Await all instances are parallel rendered
		await Promise.allSettled(promises)// render work done safely

	// create the column nodes and assign the instances nodes to it.
		const ar_column_nodes = []
		for (let j = 0; j < column_instances_length; j++) {

			const current_instance = column_instances[j]

			// check instance
				if (!current_instance) {
					console.error("Undefined current_instance:", current_instance, j, column_instances);
					continue;
				}
				// check if the current_instance has column_id. If not, an error was occur on common creating the columns.
				if (!current_instance.column_id) {
					console.error("current_instance column_id not found:",current_instance);
					continue;
				}

			// ar_sub_columns_map
				const ar_sub_columns_map = current_instance.columns_map || column_instances

			// column_node. If column already exists, place the component node into the column.
			// Else, creates a new column and place it into the result list
				const found_node	= ar_column_nodes.find(el => el.column_id === current_instance.column_id)
				const column_node	= found_node
					? found_node
					: (()=>{
						const new_column_node = render_column_node(current_instance, self, ar_sub_columns_map)
						// push column in ar_column_nodes
						ar_column_nodes.push(new_column_node)
						// add node to result list (the caller appends it to the fragment)
						ar_result_nodes.push(new_column_node)

						return new_column_node
					  })()
				// append current_instance wrapper node
				if (current_instance.node) column_node.appendChild( current_instance.node );
		}//end for (let j = 0; j < column_instances_length; j++)

	// debug
		if(SHOW_DEBUG===true) {
			// wall clock from this column's start to settle; columns overlap, so
			// this includes time yielded to sibling columns (upper bound, not exclusive cost)
			const time = performance.now() - t
			if (time > 25) {
				console.warn('current_column render time is big: ', time, current_column);
			}
		}


	return ar_result_nodes
}//end render_column



/**
* RENDER_CALLBACK
* Create the column DOM node for a columns_map entry whose definition supplies a
* custom `callback` function (e.g. a tool_time_machine "id" column, a row-delete
* button, or any caller-supplied column renderer).
*
* The callback is called with a context object extracted from the current
* section_record instance, allowing it to access section-level identifiers
* without holding a reference to the full `self` object:
*   { section_tipo, section_id, row_key, paginated_key, caller, locator, ar_instances }
*
* The return value of the callback (normally a DocumentFragment) is appended to
* a standard column wrapper produced by `render_column_node_callback`.
*
* Error handling: if the callback throws, the error is caught and logged; the
* column node is still returned (empty) so the surrounding grid is not broken.
*
* @param {Object} self - The section_record instance providing context values.
* @param {Object} column - A columns_map entry whose `.callback` is a Function.
*   Shape: { id, label, callback: Function, [render_callback]: Function, … }
* @returns {Promise<HTMLElement>} The column wrapper node, populated with the
*   callback's returned content (or empty on error).
*/
const render_callback = async function (self, column) {

	// column_node (standard section_record empty column to be filled with content_node)
	const column_node = render_column_node_callback(column, self)

	try {
        // content_node. Normally a DocumentFragment
        const content_node = await column.callback({
			section_tipo		: self.section_tipo,
			section_id			: self.section_id,
			row_key				: self.row_key,
			paginated_key		: self.paginated_key,
			caller				: self.caller,
			locator				: self.locator,
			ar_instances		: self.ar_instances
		})

        if (content_node) {
            column_node.appendChild(content_node)
        }
    } catch (error) {
        console.error('Error in render_callback:', error)
    }


	return column_node
}//end render_callback



/**
* RENDER_COLUMN_NODE
* Create the column wrapper <div> for a normal (non-callback) component column.
*
* The resulting node carries:
*   - CSS classes: `column column_<column_id> column_<caller_model>`.
*   - DOM id: `col_<column_id>` (used by the header-sorter and responsive helper).
*   - Expando properties: `.column_id` and `.component_instance`, used by the
*     caller to locate and reuse the node across multiple instances.
*
* Responsive mobile add-ons:
*   When the immediate caller is a plain 'section' (not a portal or TM),
*   `ui.make_column_responsive` injects a CSS `::before` label so the field name
*   is visible on small screens where columns stack vertically.
*
* Portal multi-instance grid:
*   When the caller model is 'component_portal' and there are multiple instances
*   sharing this column, the column's `grid-template-columns` inline style is set
*   to distribute them evenly using `1fr` per instance.  The instance count comes
*   from `ar_instances.length` rather than the current DOM child count because the
*   children have not been appended yet at the time this node is created.
*
* @param {Object} component_instance - One of the column's component instances;
*   its `.column_id` and `.label` are used to configure the node.
* @param {Object} self - The parent section_record instance.
*   Accessed: self.caller.model.
* @param {Array} ar_instances - Array of all instances that share this column
*   (used to compute the portal grid fraction count).
* @returns {HTMLElement} The newly created column wrapper <div>.
*/
const render_column_node = function(component_instance, self, ar_instances){

	const column_id	= component_instance.column_id
	const model		= self.caller?.model || 'section'

	const column_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'column column_' + column_id + ' column_' + model,
		id				: `col_${column_id}`
	})
	// set the id to the node, it used to be selected to mach column and instances.
	column_node.column_id			= column_id
	column_node.component_instance	= component_instance

	// column_responsive mobile add-ons
		if (self.caller?.model==='section') {
			ui.make_column_responsive({
				selector	: `#col_${column_id}`,
				label		: component_instance.label
			})
		}//end mobile add-ons

	if (model==='component_portal') {

		const children_length = ar_instances.length // column_node.children.length
		if (children_length>1) {

			const grid_template_columns_ar_value = []
			for (let i = 0; i < children_length; i++) {
				const width = '1fr'
				// get the grid column spaces
				grid_template_columns_ar_value.push(width)
			}

			Object.assign(
				column_node.style,
				{
					"grid-template-columns": grid_template_columns_ar_value.join(' ')
				}
			)
		}
	}


	return column_node
}//end render_column_node



/**
* RENDER_COLUMN_NODE_CALLBACK
* Create the column wrapper <div> for a callback-based column.
*
* Produces the same markup structure as `render_column_node` but uses the
* fixed class name `'callback'` as the model token instead of the caller's
* model string.  This distinguishes callback columns from component-backed ones
* in CSS selectors.
*
* This function is a **named export** because other view modules
* (view_mini_section_record, view_text_section_record, etc.) that also support
* callback columns reuse it to ensure visual consistency across views.
*
* @param {Object} column_obj - A columns_map entry with a `.callback` function.
*   Shape: { id, label, callback: Function, … }
* @param {Object} self - The section_record instance.
*   Accessed: self.caller.model (to decide whether to attach responsive label).
* @returns {HTMLElement} The newly created callback column wrapper <div>.
*/
export const render_column_node_callback = function(column_obj, self){

	const column_id	= column_obj.id
	const model		= 'callback'

	const column_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'column column_' + column_id + ' ' + model,
		id				: `col_${column_id}`
	})

	// column_responsive mobile add-ons
		if (self.caller?.model==='section') {
			ui.make_column_responsive({
				selector	: `#col_${column_id}`,
				label		: column_obj.label
			})
		}//end mobile add-ons


	return column_node
}//end render_column_node_callback



/**
* RENDER_EMPTY_COLUMN_NODE
* Create a placeholder column <div> for a columns_map entry that has no
* component instances (typically because the current user lacks the required
* privilege level, or because the section returned no matching data for that
* column type in this row).
*
* The placeholder preserves the grid slot so that the header columns and data
* columns remain visually aligned.  It carries the class `'empty'` so that CSS
* can target it (e.g. to suppress borders or padding on blank cells).
*
* Responsive labels are still attached when the caller is a plain section because
* the header must remain consistent regardless of whether a cell has content.
*
* @param {Object} column_obj - The columns_map entry with no matching instances.
*   Shape: { id, label, … }
* @param {Object} self - The section_record instance.
*   Accessed: self.caller.model.
* @returns {HTMLElement} The empty placeholder column <div>.
*/
const render_empty_column_node = function(column_obj, self){

	const column_id	= column_obj.id
	const model		= 'empty'

	const column_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'column column_' + column_id + ' ' + model,
		id				: `col_${column_id}`
	})

	// column_responsive mobile add-ons
		if (self.caller?.model==='section') {
			ui.make_column_responsive({
				selector	: `#col_${column_id}`,
				label		: column_obj.label
			})
		}//end mobile add-ons


	return column_node
}//end render_empty_column_node



// @license-end
