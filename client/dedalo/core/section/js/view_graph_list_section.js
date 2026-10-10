// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise, page_globals, DEDALO_CORE_URL, SHOW_DEBUG, confirm */
/*eslint no-undef: "error"*/



/**
* VIEW_GRAPH_LIST_SECTION
* Renders a section in 'list' mode with the 'graph' view variant.
*
* This view presents records grouped by a configurable ontology-key (defaulting to
* 'nexus46') instead of a flat paginated list.  Each group is rendered as a labelled
* block containing the matching section_record instances.  An additional "graph"
* action column is prepended to every row; clicking it navigates the entire page
* to the 'graph' (force-directed) view for the target section linked from that row.
*
* Entry point: view_graph_list_section.render(self, options)
*   Called by render_list_section.list() when self.context.view === 'graph'.
*
* Exported symbol: view_graph_list_section (namespace constructor, never instantiated)
*
* Private helpers (module-scoped):
*   get_content_data(self)                            – groups records and builds DOM
*   render_grouper_block(self, group_label, records)  – renders one labelled group block
*   rebuild_columns_map(self)                         – injects section_id + graph columns
*   get_buttons(self)                                 – action bar (search toggle, new, delete, tools)
*   render_column_graph(options)                      – graph-navigation button per row
*
* Key data shapes consumed from `self` (a fully built section instance):
*   self.datum     – { data: Array<{tipo, section_id, section_tipo, value, ...}>,
*                      context: Array }
*                    Flat array of all component values across all records in the page.
*   self.data      – { entries: Array<{section_id, section_tipo, ...}> }
*                    Ordered list of record locators for the current page.
*   self.context   – server-provided context including:
*                      .buttons               – button descriptor array
*                      .properties.view_config.group_by            – tipo used to group rows
*                      .properties.view_config.target_section_value – tipo whose value
*                                                                      carries the graph
*                                                                      section tipo to open
*                      .properties.view_config.remove_columns      – tipos to exclude from
*                                                                      the columns_map
*   self.columns_map – initially set by section.build(); rebuilt here to prepend
*                      section_id and graph control columns (memoised via
*                      self.fixed_columns_map flag).
*   self.ar_instances – accumulator for all section_record instances built this render;
*                       mutated in place by get_content_data.
*/



// imports
	import {get_section_records} from '../../section/js/section.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_instance} from '../../common/js/instances.js'
	import {clone, object_to_url_vars, group_objects_by, same_section_id} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {create_source, push_browser_history} from '../../common/js/common.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {
		render_column_id
	} from './render_list_section.js'
	import {is_non_tools_section} from './render_common_section.js'



/**
* VIEW_GRAPH_LIST_SECTION
* Namespace constructor – never instantiated; all functionality lives on static-style
* function properties (.render).
*/
export const view_graph_list_section = function() {

	return true
}//end view_graph_list_section



/**
* RENDER
* Main entry point.  Builds the full DOM tree for a section in list/graph view:
*   1. Rebuilds the columns_map (section_id + graph column prepended).
*   2. Builds the grouped content_data node (grouped by the configured ontology key).
*   3. Optionally prepends an action buttons bar and a search container.
*   4. Wraps everything in a <section> element and returns it.
*
* When options.render_level === 'content', only the inner content_data element is
* returned (used by refresh cycles that replace the body without touching the chrome).
*
* @param {Object} self    - Fully initialised and built section instance.
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - 'full' returns the whole wrapper;
*     'content' returns only the inner content_data div (used on paginator refresh).
*   @param {string} [options.render_mode]         - Informational; not used internally.
* @returns {Promise<HTMLElement>} The rendered wrapper <section> element, or the raw
*   content_data <div> when render_level === 'content'.
*/
view_graph_list_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map	= await rebuild_columns_map(self)
		self.columns_map	= columns_map

	// DocumentFragment
		const fragment = new DocumentFragment()

	// content_data
		const content_data = await get_content_data(self)

		if (render_level === 'content') {
			return content_data
		}

	// buttons add
		if (self.buttons) {
			const buttons_node = get_buttons(self);
			if (buttons_node) {
				fragment.appendChild(buttons_node)
			}
		}

	// search filter node
		if (self.filter) {
			const search_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'search_container',
				parent			: fragment
			})
			// set pointers
			self.search_container = search_container
		}

	// content_data append at end
		fragment.appendChild(content_data)

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'section',
			id				: self.id,
			class_name		: `wrapper_${self.type} ${self.model} ${self.section_tipo}_${self.tipo} ${self.tipo} ${self.mode} view_${self.view}`
		})
		wrapper.appendChild(fragment)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Groups the section's flat record list by the configured ontology key and renders a
* labelled grouper block for each group.
*
* Grouping algorithm:
*   1. Reads `group_by` from self.context.properties.view_config (defaults to 'nexus46').
*   2. Filters self.datum.data to items whose `tipo` matches that key.
*   3. Uses group_objects_by() to bucket those items by their `value` string.
*   4. For each group value, collects the matching data.entries locators
*      (matched by section_id), then calls get_section_records() to build instances.
*   5. Accumulates all instances into self.ar_instances.
*   6. Renders each group as a block via render_grouper_block().
*
* Note: entries whose section_id is not represented in self.data.entries are silently
* skipped because Array.find() returns undefined and that value is pushed into the
* grouped_value array, causing get_section_records to receive an undefined locator.
* (!) Potential source of quiet rendering gaps if datum.data and data.entries diverge.
*
* @param {Object} self - Fully built section instance; self.ar_instances is mutated.
* @returns {Promise<HTMLElement>} A <div class="content_data"> containing one grouper
*   block per group value.
*/
const get_content_data = async function(self) {

	// content_data
		const content_data = document.createElement('div')
		content_data.classList.add('content_data', self.mode, self.type)

	// get values by typologies
		const order_key = self.context?.properties?.view_config?.group_by || 'nexus46'
		const data_to_be_grouped = self.datum.data.filter(el => el.tipo === order_key)

		// Produces { "<group_label>": [ {tipo, section_id, value, ...}, ... ], ... }
		const order_value = group_objects_by(data_to_be_grouped, 'value')

		for (const group_label in order_value) {

			const current_group = order_value[group_label]

			const grouped_value = []

			const current_group_length = current_group.length
			for (let i = 0; i < current_group_length; i++) {
				const item = current_group[i]

				// Match each datum item back to the ordered entry locator by section_id.
				const current_entry = self.data.entries.find(el => same_section_id(el.section_id, item.section_id))

				grouped_value.push(current_entry)
			}

			// ar_section_record. section_record instances (initialized and built)
			const current_instances = await get_section_records({
				caller	: self,
				view	: self.view,
				value	: grouped_value
			})
			self.ar_instances.push(...current_instances)

			const current_block = await render_grouper_block(self, group_label, current_instances)
			if (current_block) {
				content_data.appendChild(current_block)
			}
		}//end for (const group_label in order_value)


	return content_data
}//end get_content_data



/**
* RENDER_GROUPER_BLOCK
* Renders a single group block containing a label and the rows for all section_record
* instances belonging to that group.
*
* Layout produced:
*   <DocumentFragment>
*     <div class="grouper_block">
*       <span class="group_label">{group_label}</span>
*       <div class="group_content">
*         {section_record rendered node} × N
*       </div>
*     </div>
*   </DocumentFragment>
*
* All section_record render() calls run in parallel via Promise.all for performance.
*
* @param {Object}           self              - Section instance (passed through to child renders).
* @param {string}           group_label       - Display string for the group heading.  Empty
*                                               string is rendered as an empty <span>.
* @param {Array}            ar_section_record - Array of already-built section_record instances
*                                               to render into this block.
* @returns {Promise<DocumentFragment>} A DocumentFragment containing the fully rendered
*   grouper_block div.
*/
const render_grouper_block = async function(self, group_label, ar_section_record) {

	const fragment = new DocumentFragment()

	const grouper_block = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'grouper_block',
		parent			: fragment
	})

	const group_label_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'group_label',
		inner_html 		: group_label || '',
		parent			: grouper_block
	})

	const group_content = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'group_content',
		parent			: grouper_block
	})

	// rows. parallel mode
	const ar_section_record_length = ar_section_record.length
	const ar_promises = []
	for (let i = 0; i < ar_section_record_length; i++) {
		const render_promise_node = ar_section_record[i].render()
		ar_promises.push(render_promise_node)
	}

	const values = await Promise.all(ar_promises)
	for (let i = 0; i < ar_section_record_length; i++) {
		const section_record_node = values[i]
		group_content.appendChild(section_record_node)
	}


	return fragment
}//end render_grouper_block



/**
* REBUILD_COLUMNS_MAP
* Extends the section's base columns_map (as built by common.get_columns_map) with
* two prepended control columns specific to the graph-list view:
*
*   1. 'section_id' column – renders the record id using render_column_id from
*      render_list_section.js (shared with the default list view).
*   2. 'graph' column – renders a per-row navigation button that opens the force-directed
*      graph view for the linked target section (see render_column_graph).
*
* Columns listed in self.context.properties.view_config.remove_columns (array of tipos)
* are excluded from the base columns.
*
* Memoisation: once rebuilt, self.fixed_columns_map is set to true and subsequent calls
* return self.columns_map directly without reprocessing.  This avoids redundant work on
* content-level refresh cycles.
*
* Adding control columns to the columns_map that will processed by section_records
* @param {Object} self - Section instance whose columns_map and fixed_columns_map
*   properties are read and potentially updated.
* @returns {Promise<Array>} The final columns_map array.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map === true) {
			return self.columns_map
		}

	const columns_map = []

	// column section_id check
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			tipo		: 'section_id', // used to sort only
			sortable	: true,
			width		: 'minmax(auto, 6rem)',
			path		: [{
				// note that component_tipo=section_id is valid here
				// because section_id is a direct column in search
				component_tipo	: 'section_id',
				// optional. Just added for aesthetics
				model			: 'component_section_id',
				name			: 'ID',
				section_tipo	: self.section_tipo
			}],
			callback	: render_column_id
		})

	// graph column
		columns_map.push({
			id			: 'graph',
			label		: '', // get_label.delete || 'Delete',
			width 		: 'auto',
			callback	: render_column_graph
		})

	// columns base
		const base_columns_map = await self.columns_map

		const remove_columns = self.context?.properties?.view_config?.remove_columns || []
		const base_columns_map_length = base_columns_map.length

		for (let i = 0; i < base_columns_map_length; i++) {
			const column = base_columns_map[i]

			// Skip any column whose tipo is listed in the ontology-configured exclusion list.
			const found = remove_columns.includes(column.tipo)
			if (found) {
				continue
			}
			columns_map.push(column)
		}

	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* GET_BUTTONS
* Builds and returns the action buttons bar for the section.
*
* The bar always includes a "Search" toggle button (publishes the
* 'toggle_search_panel_{self.id}' event to show/hide the search panel).
*
* For non-activity / non-registered-tools sections it also adds a collapsible
* "other buttons" drawer containing buttons defined in self.context.buttons:
*   - button_new    → publishes 'new_section_{self.id}'
*   - button_delete → opens the multi-delete confirmation dialog with a clone of the
*                     current SQO (limit cleared, offset removed) so all filtered records
*                     are targeted rather than just the current page.
*   - button_import / button_trigger → delegates to open_tool() with the first configured tool.
*   - any other model → publishes 'click_{button.model}'.
*
* Guard: button_delete is suppressed unless page_globals.is_global_admin === true.
*
* Non-editable section tipos that stop processing after the search button:
*   'dd542'  – activity section
*   'dd15'   – time machine section
*   'dd1324' – registered tools section
*
* @param {Object} self - Section instance.  Reads self.context.buttons, self.tipo,
*   self.id, self.section_tipo, self.rqo.sqo, page_globals.is_global_admin.
* @returns {DocumentFragment|null} DocumentFragment containing the entire buttons chrome,
*   or null if self.context.buttons is absent.
*/
const get_buttons = function(self) {

	// ar_buttons list from context
		const ar_buttons = self.context.buttons
		if (!ar_buttons) {
			return null;
		}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

	// filter button (search) . Show and hide all search elements
		const filter_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning search',
			inner_html		: get_label.find || 'Search',
			parent			: buttons_container
		})
		filter_button.addEventListener('mousedown', function(e) {
			e.stopPropagation()
			// Note that self section is who is observing this event (init)
			event_manager.publish('toggle_search_panel_'+self.id)
		})

	// non_editable_sections. Read-only log sections + registered tools + every
	// section_tool "process" page (oh81 …): they carry no action buttons and no
	// section tools (consultation-only, WC-010 + WC-2026-10-06-consultation-only-no-section-tools;
	// section_tool pages drive their content through config.tool_context, not the
	// target section's toolbar), so only the search controls render — no
	// other-buttons drawer, no toggle. Activity (dd542) and Time machine (dd15)
	// MUST behave identically; the rule is shared with view_default_list_section
	// (render_common_section.is_non_tools_section).
		if (is_non_tools_section(self)) {
			return fragment
		}

	// other_buttons_block
		const other_buttons_block = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'other_buttons_block hide',
			parent			: buttons_container
		})

	// other buttons
		const ar_buttons_length = ar_buttons.length;
		for (let i = 0; i < ar_buttons_length; i++) {

			const current_button = ar_buttons[i]

			// button_delete multiple
			// check if user is global admin to activate the button delete (avoid users to delete multiple sections)
				if (current_button.model==='button_delete' && page_globals.is_global_admin===false){
					continue
				}

			// button node
				const class_name	= 'warning ' + current_button.model.replace('button_', '')
				const button_node	= ui.create_dom_element({
					element_type	: 'button',
					class_name		: class_name,
					inner_html		: current_button.label,
					parent			: other_buttons_block
				})
				button_node.addEventListener('click', (e) => {
					e.stopPropagation()

					switch(current_button.model){
						case 'button_new':
							event_manager.publish('new_section_' + self.id)
							break;

						case 'button_delete': {
							// sqo conform
							// Clone to avoid mutating the live rqo.sqo; clear pagination
							// limits so the delete targets all filtered records, not just
							// the current page.
							const delete_sqo = clone(self.rqo.sqo)
							delete_sqo.limit = null
							delete delete_sqo.offset

							// delete_record
							self.render_delete_record_dialog({
								section			: self,
								section_id		: null,
								section_tipo	: self.section_tipo,
								sqo				: delete_sqo
							})
							break;
						}
						// button_import and button_trigger cases for compatibility with v5 ontology
						// in future version will be merge both with new model button_tool
						// in the mid-time use button_trigger for general cases to dispatch tools.
						case 'button_import':
						case 'button_trigger':
							// open_tool (tool_common)
							open_tool({
								tool_context	: current_button.tools[0],
								caller			: self
							})
							break;

						default:
							event_manager.publish('click_' + current_button.model)
							break;
					}
				})
		}//end for (let i = 0; i < ar_buttons_length; i++)

	// tools buttons
		ui.add_tools_menu(self, other_buttons_block)

	// show_other_buttons_button
		const show_other_buttons_label	= get_label.show_buttons || 'Show buttons'
		const show_other_buttons_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'icon_arrow show_other_buttons_button',
			title			: show_other_buttons_label,
			dataset			: {
				label : show_other_buttons_label
			},
			parent			: buttons_container
		})
		show_other_buttons_button.addEventListener('click', function(e) {
			e.stopPropagation()
		})

		// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: show_other_buttons_button,
			container			: other_buttons_block,
			collapsed_id		: 'section_other_buttons_block',
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'closed'
		})
		function collapse() {
			show_other_buttons_button.classList.remove('up')
		}
		function expose() {
			show_other_buttons_button.classList.add('up')
		}


	return fragment
}//end get_buttons



/**
* RENDER_COLUMN_GRAPH
* Column callback that renders a "graph" navigation button for a single row.
*
* When clicked the button:
*   1. Resolves the target section tipo from self.datum.data by looking up the item
*      with matching (section_id, section_tipo) whose `tipo` equals the configured
*      target_section_value ontology key (defaults to 'nexus53').
*   2. Instantiates and builds that section in 'solved' mode via get_instance().
*   3. Switches the section's view to 'graph'.
*   4. Renders the section and inserts it after the current list node using
*      Element.after().
*   5. Destroys the current list section instance to free memory and remove its node.
*   6. Updates the browser URL and history via push_browser_history().
*
* A boolean flag (is_processing) prevents overlapping clicks while the async handler
* is in flight.
*
* The URL produced encodes: tipo, mode, view='graph', fst (from-section-tipo),
* fsi (from-section-id), enabling back-navigation to restore the graph context.
*
* (!) This function is registered as a callback in the columns_map (not called directly).
*     options.caller must be the parent section instance, not the section_record.
*
* @param {Object} options              - Column callback options (provided by section_record renderer).
*   @param {Object} options.caller     - The parent section instance (list view).
*   @param {string} options.section_id - The record's section_id.
*   @param {string} options.section_tipo - The record's section_tipo.
* @returns {DocumentFragment} A DocumentFragment containing the graph <button>.
*   The button's event handler is async; the DocumentFragment itself is returned
*   synchronously.
*/
const render_column_graph = function(options) {

	// options
		const self			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	// DocumentFragment
		const fragment = new DocumentFragment()

	// graph_button
	const graph_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'button graph',
		parent			: fragment
	})
	// mouseup event
	let is_processing = false
	const mouseup_handler = async (e) => {
		e.stopPropagation()

		// Prevent multiple simultaneous executions
		if (is_processing) {
			return;
		}
		is_processing = true

		try {

			const target_section_value	= self.context?.properties?.view_config?.target_section_value || 'nexus53'

			// Validate self.datum.data exists
			if (!self.datum?.data || !Array.isArray(self.datum.data)) {
				console.error('render_column_graph: self.datum.data is not available or not an array');
				return;
			}

			// Find target section data
			const target_section_data	= self.datum.data.find(el =>
				same_section_id(el.section_id, section_id) &&
				el.section_tipo	=== section_tipo &&
				el.tipo			=== target_section_value
			)

			// Extract target section type
			// value is an array; take first element as the section tipo string.
			const target_section_tipo = target_section_data?.value?.[0];

			if (!target_section_tipo) {
				console.warn('render_column_graph: Empty target_section_data value:', target_section_data);
				return;
			}

			// target section
			const section = await get_instance({
				model 			: 'section',
				tipo			: target_section_tipo,
				section_tipo	: target_section_tipo,
				mode 			: 'solved',
				inspector 		: false
			})

			if (!section) {
                throw new Error('render_column_graph: Failed to create section instance');
            }

			await section.build(true)

			// Configure section
			section.view = 'graph'
			section.caller = self.caller // injected caller (page), needed because to render new menu label

			// Render section
			const section_node = await section.render()

			// Add to DOM
            if (self.node?.after) {
                self.node.after(section_node);
            } else {
                console.error('render_column_graph: self.node.after is not available');
                return;
            }

			// remove current section instance and nodes
			self.destroy(true, true, true)

			// navigation (update browser URL and history)
			const source	= create_source(section, null)
			const sqo		= section.request_config_object?.sqo
			const title		= section.id

			// url search. Append section_id if exists
			// fst/fsi params encode the originating section record for back-navigation.
			const url = '?' + object_to_url_vars({
				tipo	: section.tipo,
				mode	: section.mode,
				view	: section.view,
				fst		: section_tipo,
				fsi		: section_id
			})

			// browser navigation update
			push_browser_history({
				source	: source,
				sqo		: sqo,
				title	: title,
				url		: url
			})
		} catch (error) {
			console.error('render_column_graph: Error in mouseup handler:', error);
		} finally {
			is_processing = false;
		}
	}
	graph_button.addEventListener('mouseup', mouseup_handler)


	return fragment
}//end render_column_graph



// @license-end
