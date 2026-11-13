// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {same_section_id} from '../../common/js/utils/index.js'



/**
* RENDER_AREA_GRAPH
* Client-side render layer for the area_graph module.
*
* area_graph is the thesaurus/network browser area: it displays a paginated
* tree of hierarchical terms (ts_object nodes) grouped by typology (nexus57
* records). This module supplies the view functions that area_graph.js mixes
* onto its prototype via:
*
*   area_graph.prototype.edit = render_area_graph.prototype.list
*   area_graph.prototype.list = render_area_graph.prototype.list
*
* The public surface is a single prototype method (list / edit) plus two
* private helpers (render_content_data, get_buttons) that build the DOM tree
* inside it.
*
* Data contract (dd100 item from area_graph_json.php):
*   {
*     tipo  : 'dd100',
*     value : Array<{ type: 'typology'|'hierarchy', section_id, section_tipo,
*                     label?, order?,
*                     typology_section_id?, target_section_tipo?,
*                     target_section_name?, children_tipo? }>
*     ts_search? : { result: Array, to_hilite: Array }   // only when a search
*                                                          // was performed on
*                                                          // the server
*   }
*
* Rendered DOM structure (full render_level):
*   <wrapper>
*     [buttons_container]
*     [search_container]    — injected only when self.filter exists
*     <div.content_data>
*       <ul.thesaurus_list_wrapper>
*         <li.thesaurus_type_block>*   (one per typology)
*           <div.typology_name>
*           <div.typology_container>
*             <div.wrap_ts_object.hierarchy_root_node>*   (one per hierarchy)
*               <div.children_container>
*               <div>                  — temporary scaffold element for
*                 <div[data-tipo]>     — ts_object.get_children flow (now
*               </div>                — commented out; kept for future use)
*
* Exports:
*   render_area_graph — constructor (no-op body; used only as prototype carrier)
*/
export const render_area_graph = function() {

	return true
}//end render_area_graph



/**
* LIST
* Renders the area_graph panel for both 'list' and 'edit' render modes (the
* prototype is assigned to both area_graph.prototype.list and
* area_graph.prototype.edit).
*
* Handles two render_level values:
*   'content' — refreshes only the content_data subtree, either by re-running
*               the thesaurus search (data.ts_search path) or by calling
*               render_content_data() from scratch.
*   'full'    — builds the complete wrapper: buttons_container, an optional
*               search_container (when self.filter exists), content_data, and
*               an event subscription for the deferred ts_search parse when
*               data.ts_search is present.
*
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - Render scope: 'full' or 'content'.
* @returns {HTMLElement} The wrapper element (full render) or the content_data
*   element (content render).
*/
render_area_graph.prototype.list = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// ts_object. Is a global page var
		// set mode. Note that ts_object is NOT an instance
		self.ts_object.thesaurus_mode = self.context?.thesaurus_mode || null
		// caller set
		self.ts_object.caller = self
		self.ts_object.linker = self.linker // usually a portal component instance

		// parse data
		// dd100 is the canonical tipo for the area_graph data item produced by
		// area_graph_json.php. The value array holds mixed typology/hierarchy nodes.
		const data = self.data.find(item => item.tipo==='dd100') || {}

	// content_data
		if (render_level==='content') {

			if (data.ts_search) {

				// search result case
				// When the server already ran a thesaurus search (either triggered by
				// hierarchy_terms in properties or by an explicit search action), the
				// result arrives as data.ts_search = { result, to_hilite }.  The
				// existing content_data DOM is reused — only the children_container
				// nodes inside each category are wiped and repopulated.

				// prevent to re-create content_data again
					const content_data = self.node.content_data

				// clean children_container nodes (inside categories)
				// All [data-role="children_container"] subtrees are emptied before
				// re-rendering so stale ts_object child nodes do not accumulate.
					const children_container = content_data.querySelectorAll('[data-role="children_container"]')
					const children_container_length = children_container.length
					for (let i = 0; i < children_container_length; i++) {
						const item = children_container[i]
						while (item.firstChild) {
							item.removeChild(item.firstChild);
						}
					}

				// render. parse_search_result with ts_object
				// Deferred to an idle callback so the main thread can paint the
				// cleared skeleton before the (potentially heavy) tree walk begins.
					dd_request_idle_callback(
						() => {
							self.ts_object.parse_search_result(
								data.ts_search.result, // object data
								data.ts_search.to_hilite,
								null, // HTMLElement main_div
								false // bool is_recursion
							)
						}
					)

				return content_data

			}else{

				// No search result: rebuild the content_data DOM from the raw value array.
				const content_data = render_content_data(self)
				return content_data
			}
		}//end if (render_level==='content')

	const fragment = new DocumentFragment()

	// buttons_container
	// get_buttons returns null when self.context.buttons is absent, so the
	// fragment is only appended when at least one button is defined in context.
		const buttons_container = get_buttons(self);
		if(buttons_container){
			fragment.appendChild(buttons_container)
		}

	// search_container
	// The search UI is loaded lazily (on first toggle) by the toggle_search_panel
	// handler defined in area_graph.prototype.init.  The empty container is
	// created here so the handler has a stable insertion point.
		if (self.filter) {
			const search_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'search_container',
				parent			: fragment
			})
			self.search_container = search_container
		}

	// content_data
		const content_data = render_content_data(self)

	// wrapper. ui build_edit returns component wrapper
		const wrapper =	ui.area.build_wrapper_edit(self, {
			content_data	: content_data,
			label			: null
		})
		wrapper.prepend(fragment)
		// Store content_data on the wrapper node so navigate() can later call
		// wrapper.content_data.classList.add('loading') and self.node.content_data
		// resolves to the correct element after the first render.
		wrapper.content_data = content_data

	// ts_search case
	// When the full-level render already carries a server-side search result,
	// subscribe to the 'render_<filter.id>' event so that ts_object.parse_search_result
	// is called once the wrapper is in the live DOM (the event is published from
	// area_graph.prototype.init's render_handler after toggling search visibility).
		if (data.ts_search) {
			const render_handler = () => {
				self.ts_object.parse_search_result(
					data.ts_search.result,
					data.ts_search.to_hilite,
					null,
					false
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('render_'+self.filter.id, render_handler)
			)
		}


	return wrapper
}//end list



/**
* RENDER_CONTENT_DATA
* Builds the main thesaurus tree DOM fragment from the pre-loaded area_graph
* data item (dd100).
*
* The data value array contains two kinds of nodes (distinguished by .type):
*   - 'typology' — a nexus57 record that groups one or more hierarchies.
*     Fields used: section_id, label, order.
*   - 'hierarchy' — an active nexus40 record describing a single thesaurus
*     tree root.  Fields used: section_id, section_tipo, target_section_tipo,
*     typology_section_id, target_section_name, children_tipo.
*
* Typologies are sorted by their numeric .order field (server value).
* Hierarchies within each typology are sorted alphabetically by
* .target_section_name using the platform-default locale collator.
*
* Each hierarchy root gets a .wrap_ts_object.hierarchy_root_node wrapper that
* carries three data attributes consumed by ts_object internals:
*   data-section-tipo, data-section-id, data-target-section-tipo.
*
* Inside every hierarchy wrapper a temporary scaffold element pair is created
* (hierarchy_elements_container > link_children[data-tipo]) to preserve
* compatibility with the ts_object.get_children flow even though that call is
* currently commented out.  The scaffold is intended to be removed after the
* async get_children resolves (see commented code inside the inner loop).
*
* @param {Object} self - area_graph instance (provides self.data, self.type).
* @returns {HTMLElement} content_data div ready to be attached to the wrapper.
*/
const render_content_data = function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// thesaurus_list_wrapper ul container for list
		const ul = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'thesaurus_list_wrapper',
			parent			: fragment
		})

	// elements
		const data				= self.data.find(item => item.tipo==='dd100') || {}
		const ts_nodes			= data.value || []
		// hierarchy_nodes: all nodes whose .type === 'hierarchy' (nexus40 records)
		const hierarchy_nodes	= ts_nodes.filter(node => node.type==='hierarchy') || []

	// typology_nodes. sort typologies by order field
	// parseFloat is used because .order may arrive as a string from the API.
		const typology_nodes	= ts_nodes.filter(node => node.type==='typology' )
		typology_nodes.sort((a, b) => parseFloat(a.order) - parseFloat(b.order));

	// iterate typology_nodes
	// Each typology becomes a collapsible <li> block containing all hierarchy
	// roots that belong to it (matched via typology_section_id === typology.section_id).
		const typology_length = typology_nodes.length
		for (let i = 0; i < typology_length; i++) {

			const typology_item = typology_nodes[i]

			// thesaurus_type_block li
				const li = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'thesaurus_type_block',
					parent			: ul
				})

			// typology_name
			// The .icon_arrow class drives the CSS collapse indicator.
			// data-section-id is stored so external code can identify the typology
			// record from the DOM node.
				const typology_name = ui.create_dom_element({
					element_type	: 'div',
					class_name		:'typology_name icon_arrow',
					dataset			: {
						section_id	: typology_item.section_id
					},
					text_content		: typology_item.label,
					parent			: li
				})

			// typology_container
			// Receives all hierarchy_root_node elements for this typology.
				const typology_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'typology_container',
					parent			: li
				})

			// collapse typology_name->typology_container children
			// ui.collapse_toggle_track persists the open/closed state in the local
			// IndexedDB ('status' table, key 'collapsed_area_graph_<section_id>') so
			// the user's preference survives page refreshes.
			// The collapse/expose callbacks toggle the 'up' CSS class on the header
			// arrow to indicate the current state.
				ui.collapse_toggle_track({
					toggler				: typology_name,
					container			: typology_container,
					collapsed_id		: 'collapsed_area_graph_'+typology_item.section_id,
					collapse_callback	: collapse,
					expose_callback		: expose,
					default_state		: 'opened'
				})
				function collapse() {
					typology_name.classList.remove('up')
				}
				function expose() {
					typology_name.classList.add('up')
				}

			// hierarchy sections
			// Filter and sort the hierarchy roots that belong to this typology.
			// Sorting uses Intl.Collator with default locale for locale-aware
			// alphabetical ordering of target_section_name (human-readable tree name).
				const hierarchy_sections = hierarchy_nodes.filter(node => same_section_id(node.typology_section_id, typology_item.section_id))
				// sort hierarchy_nodes by alphabetic
				hierarchy_sections.sort((a, b) => new Intl.Collator().compare(a.target_section_name, b.target_section_name));
				const hierarchy_sections_length = hierarchy_sections.length
				for (let j = 0; j < hierarchy_sections_length; j++) {

					const hierarchy_sections_item = hierarchy_sections[j]

					// hierarchy_wrapper (hierarchy_root_node)
					// .wrap_ts_object marks this element as a ts_object anchor node.
					// .hierarchy_root_node distinguishes it from interior nodes.
					// The three data attributes are consumed by ts_object internals:
					//   data-section-tipo / data-section-id  → identify the nexus40 record
					//   data-target-section-tipo             → identifies the thesaurus section
					//                                          whose terms populate this tree
						const hierarchy_wrapper = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'wrap_ts_object hierarchy_root_node',
							dataset			: {
												section_tipo		: hierarchy_sections_item.section_tipo,
												section_id			: hierarchy_sections_item.section_id,
												target_section_tipo	: hierarchy_sections_item.target_section_tipo
											  },
							parent			: typology_container
						})

					// hierarchy children_container
					// Acts as the insertion point for ts_object child nodes rendered
					// after a lazy get_children call.  The data-role attribute is used
					// by the content-level refresh loop to locate and empty this element
					// before re-rendering search results.
						const children_container = ui.create_dom_element({
							element_type	: 'div',
							class_name		:'children_container',
							dataset			: {
												section_id	: hierarchy_sections_item.section_id,
												role		: 'children_container'
											  },
							parent			: hierarchy_wrapper
						})

					// temporal fake items to preserve ts_objec->get_children flow. After finish, remove elements
					// (!) These scaffold nodes are intentionally kept as placeholders so the
					// ts_object.get_children flow can locate its anchor element via
					// link_children[data-tipo].  The actual async call is commented out
					// below; when re-enabled it must remove hierarchy_elements_container
					// on completion (see commented-out .then block).
						// hierarchy_elements_container
						const hierarchy_elements_container = ui.create_dom_element({
							element_type	: 'div',
							parent			: hierarchy_wrapper
						})
						// link_children
						const link_children = ui.create_dom_element({
							element_type	: 'div',
							dataset			: {tipo : hierarchy_sections_item.children_tipo},
							parent			: hierarchy_elements_container
						})

					// ts_object Get from API and render element
						// self.ts_object.get_children(link_children)
						// .then(function(response){
						// 	hierarchy_elements_container.remove()
						// })
				}
		}//end for (let i = 0; i < typology_length; i++)

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.type)
			  content_data.appendChild(fragment)


	return content_data
}//end render_content_data



/**
* GET_BUTTONS
* Builds the action toolbar for the area_graph panel.
*
* Always creates a 'Search' toggle button regardless of context.buttons content.
* Then iterates context.buttons, skipping 'button_delete' entries (graph areas
* do not expose deletion from the toolbar).
*
* Supported button models and their published events:
*   button_new    → 'new_section_<self.id>'
*   button_import → currently a no-op (tool_common.open_tool is commented out)
*   <other>       → 'click_<model>'
*
* Tool buttons are appended last via ui.add_tools(self, buttons_container).
*
* @param {Object} self - area_graph instance. Must expose self.context.buttons
*   (Array of button descriptor objects with .model and .label), self.id, and
*   the tools array consumed by ui.add_tools.
* @returns {DocumentFragment|null} Fragment containing the buttons_container
*   div, or null when self.context.buttons is absent/falsy.
*/
const get_buttons = function(self) {

	// ar_buttons list from context
		const ar_buttons = self.context.buttons
		if(!ar_buttons) {
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
		// Publishes 'toggle_search_panel_<self.id>' which is subscribed in
		// area_graph.prototype.init and lazily builds the filter UI on first open.
			const filter_button	= ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'warning search',
				inner_html		: get_label.find || 'Search',
				parent			: buttons_container
			})
			filter_button.addEventListener('mousedown', function(e) {
				e.stopPropagation()
				event_manager.publish('toggle_search_panel_'+self.id)
			})
			// ui.create_dom_element({
			// 	element_type	: 'span',
			// 	class_name		: 'button white search',
			// 	parent			: filter_button
			// })
			// filter_button.insertAdjacentHTML('beforeend', get_label.find)

		const ar_buttons_length = ar_buttons.length;
		for (let i = 0; i < ar_buttons_length; i++) {

			const current_button = ar_buttons[i]

			// button_delete is intentionally excluded from the graph toolbar.
			if(current_button.model==='button_delete') continue

			// button node
				const class_name	= 'warning ' + current_button.model
				const button_node	= ui.create_dom_element({
					element_type	: 'button',
					class_name		: class_name,
					text_content		: current_button.label,
					parent			: buttons_container
				})
				button_node.addEventListener('click', (e) => {
					e.stopPropagation()

					switch(current_button.model){
						case 'button_new':
							// Delegate to section_new handler registered in the area.
							event_manager.publish('new_section_' + self.id)
							break;
						case 'button_import':
							// (!) tool_common.open_tool is intentionally commented out —
							// import via toolbar is not yet implemented for graph areas.
							// tool_common.open_tool({
							// 	tool_context	: current_button.tools[0],
							// 	caller			: self
							// })
							break;
						default:
							event_manager.publish('click_' + current_button.model)
							break;
					}
				})
		}//end for (let i = 0; i < ar_buttons_length; i++)

	// tools
	// Appends any tool buttons (e.g. tool_export, tool_print) configured in
	// self.tools to the buttons_container via the shared ui.add_tools helper.
		ui.add_tools(self, buttons_container)


	return fragment
}//end get_buttons



// @license-end
