// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_AREA_THESAURUS
*
* Client-side rendering module for the area_thesaurus and area_ontology views.
*
* This module is responsible for the visual layer of the thesaurus area: it
* assembles the full wrapper (buttons, search panel slot, content) for the initial
* page load, and provides the lighter "content only" re-render path used by
* navigate/refresh. It also exports render_root_term for use by other modules
* that need to inject individual root nodes into the tree.
*
* Two important rendering paths coexist:
*
*   1. Normal (browse) path — render_content_data() builds the typology→root-term
*      skeleton synchronously; each root term spawns a ts_object.get_instance()
*      promise whose resolution replaces a loading placeholder in the DOM via
*      requestAnimationFrame (non-blocking).
*
*   2. Search path — the server returns a ts_search result attached to the data
*      item. The area delegates to ts_object.parse_search_result(), which walks
*      the result set, opens matching branches, and highlights found terms. In the
*      full render, this is deferred until the search filter fires its 'render_<id>'
*      event; in the content-only path the call is awaited directly.
*
* Exports:
*   render_area_thesaurus — constructor (assigned as area_thesaurus.prototype.list/edit)
*   render_root_term      — standalone root-term placeholder builder (imported by
*                           render_edit_ts_object for relation-level expansions)
*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {ts_object} from '../../ts_object/js/ts_object.js'
	import {ui} from '../../common/js/ui.js'



/**
* RENDER_AREA_THESAURUS
* Constructor for the render delegate.
* area_thesaurus assigns its list/edit prototype method to
* render_area_thesaurus.prototype.list, so this constructor is never
* called directly with `new`; it acts as the prototype vehicle only.
* @returns {boolean} Always true (no-op constructor body).
*/
export const render_area_thesaurus = function() {

	return true
}//end render_area_thesaurus



/**
* LIST
* Render the area thesaurus in list mode.
*
* This method is assigned to both area_thesaurus.prototype.list and
* area_thesaurus.prototype.edit, so it handles both browse and editor views.
*
* Two render levels are supported:
*
*   'full'    (default) — Builds the complete area wrapper including the
*             buttons toolbar, an optional search_container slot, and the
*             content_data subtree. Attaches keydown listeners and event
*             subscriptions for deferred search rendering.
*
*   'content' — Skips the wrapper build and returns only the content_data
*             subtree. Used by navigate() / refresh() to swap just the inner
*             portion of an already-mounted wrapper.
*
* Data shape expected in self.data (one item matching tipo 'dd100' or 'dd5'):
* ```
*   {
*     tipo        : "dd100",           // area tipo
*     typologies  : [ { section_id, label, order }, ... ],
*     value       : [ { typology_section_id, section_tipo, section_id,
*                       children_tipo, root_terms: [...], order, ... }, ... ],
*     ts_search?  : { result: [...], found: [...] }  // present when a search was executed
*   }
* ```
*
* When ts_search is present the method obtains a root ts_object instance and
* calls parse_search_result() to build, open, and highlight the matching
* branches. In the 'full' path this is deferred into a dd_request_idle_callback
* that is triggered by the 'render_<filter.id>' event so that the search panel
* has already finished rendering before the tree walk begins.
*
* A Ctrl+S keydown listener is installed to toggle .id_info nodes in the tree
* between showing the TLD tipo identifier and the raw section identifier — a
* debug/inspection aid for Ontology mode.
*
* @param {Object} options
* @param {string} [options.render_level='full'] - Render depth: 'full' or 'content'.
* @returns {Promise<HTMLElement>} The assembled wrapper node (full path) or the
*   content_data element (content path).
*/
render_area_thesaurus.prototype.list = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

		// parse data
		// sample data:
		// {
		// 	  tipo: "dd100",
		// 	  typologies: [{},...],
		// 	  value: [{},..]
		// }
		const data = self.data.find(item => item.tipo==='dd100' || item.tipo==='dd5') || {}

	// content_data
		if (render_level === 'content') {

			if (data.ts_search) {

				// search result case

				// prevent to re-create content_data again
					const content_data = self.node.content_data

				// render. Search : parse_search_result with ts_object.
					// parse_search_result() (phase 1: build_search_instances) is what creates and
					// renders the root instances. Do NOT pre-wait here for their 'render_<id>'
					// event before calling it: that wait is circular and deadlocks navigation
					// (the interface freezes on every search).
					const ts_object_instance = await ts_object.get_instance({
						// key options
						section_tipo			: self.section_tipo,
						section_id				: self.section_id,
						thesaurus_mode			: self.context?.thesaurus_mode || 'default',
						// others
						caller					: self,
						linker					: self.linker, // usually a portal component instance
						thesaurus_view_mode		: self.thesaurus_view_mode,
						is_root_node			: true,
						area_model				: self.model,
						is_ontology				: self.model === 'area_ontology'
					})

					self.ar_instances.push(ts_object_instance)
					await ts_object_instance.parse_search_result(
						data.ts_search.result, // object data
						data.ts_search.found // to hilite
					)

				return content_data

			}else{

				const content_data = render_content_data(self)
				return content_data
			}
		}//end if (render_level==='content')

	const fragment = new DocumentFragment()

	// buttons_container
		const buttons_container = get_buttons(self);
		if(buttons_container){
			fragment.appendChild(buttons_container)
		}

	// search_container
		// Only created when a filter instance exists; the container starts empty
		// and is populated lazily when the user opens the search panel.
		if (self.filter) {
			const search_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'search_container',
				parent			: fragment
			})
			// set pointers
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
		// set pointers
		wrapper.content_data = content_data

	// ts_search case
		// When the server already resolved a search (e.g. page loaded with an
		// active filter), defer the tree-walk until the 'render_<filter.id>'
		// event fires, which guarantees the search panel DOM is ready.
		if (data.ts_search) {
			const render_handler = (wrapper_search) => {
				dd_request_idle_callback(
					async () => {

						// render. Search : parse_search_result with ts_object.
						// parse_search_result() (phase 1: build_search_instances) is what creates and
						// renders the root instances. Do NOT pre-wait here for their 'render_<id>'
						// event before calling it: that wait is circular and deadlocks navigation
						// (the interface freezes on every search).
						const ts_object_instance = await ts_object.get_instance({
							section_tipo			: self.section_tipo,
							section_id				: self.section_id,
							thesaurus_mode			: self.context?.thesaurus_mode || 'default',
							// others
							caller					: self,
							linker					: self.linker,
							thesaurus_view_mode		: self.thesaurus_view_mode,
							is_root_node			: true,
							area_model				: self.model,
							is_ontology				: self.model === 'area_ontology'
						})

						await ts_object_instance.parse_search_result(
							data.ts_search.result,
							data.ts_search.found
						)
					}
				)
			}
			self.events_tokens.push(
				event_manager.subscribe('render_'+self.filter.id, render_handler)
			)
			// search_tipos Ontology case
			// force filter render to fire the render event that parse the search result
			if (self.model==='area_ontology' && self.search_tipos) {
				self.filter.render()
			}
		}

	// event keydown
	// swap between title (section info as 'dd0') and title (tld as '[dd222]')
		// id_info_mode tracks the current display state of all .id_info.ontology nodes.
		// 'tld' shows the ontology tipo identifier (e.g. 'rsc14');
		// 'section' shows the raw section_id stored in data-section.
		// Ctrl+S toggles between the two within a requestIdleCallback so it
		// never blocks input on large trees.
		let id_info_mode = 'tld' // tld|section
		const keydown_handler = (e) => {

			if (e.key==='s' && e.ctrlKey===true) {
				dd_request_idle_callback(
					() => {
						const id_infos = document.querySelectorAll('.id_info.ontology')
						const id_infos_length = id_infos.length
						for (let i = 0; i < id_infos_length; i++) {

							const item = id_infos[i]

							if (id_info_mode==='tld') {
								item.innerHTML	= item.dataset.section
								item.title		= item.dataset.term_id
								item.classList.add('show_section')
							}else{
								item.innerHTML	= item.dataset.term_id
								item.title		= item.dataset.section
								item.classList.remove('show_section')
							}
						}
						id_info_mode = (id_info_mode==='tld') ? 'section' : 'tld'
					}
				)
			}
		}
		// Remove any previously registered keydown handler before adding a new one
		// to avoid duplicate listeners when the area is refreshed without a full destroy.
		if (self.keydown_handler) {
			document.removeEventListener('keydown', self.keydown_handler)
		}
		self.keydown_handler = keydown_handler
		document.addEventListener('keydown', self.keydown_handler)


	return wrapper
}//end list



/**
* RENDER_CONTENT_DATA
* Build the scrollable typology+root-term tree subtree.
*
* Creates a content_data <div> containing a <ul class="thesaurus_list_wrapper">
* whose children are typology <li> blocks. Each block has:
*   - A .typology_name header div (acts as the collapse toggler).
*   - A .typology_container div (the collapsible body), populated with
*     placeholder wrappers returned by render_root_term() for each root term
*     belonging to that typology.
*
* Ordering rules:
*   - Typologies are sorted by their 'order' field (ascending, via sort_root_terms).
*   - Within a typology, hierarchy sections with order !== 0 come first (sorted by
*     sort_root_terms), followed by sections with order === 0 (also sorted by name).
*   - Empty typologies (no hierarchy nodes or no root terms after permission
*     filtering) are silently skipped.
*
* The expand/collapse state of each typology is persisted in the client-side
* local DB via ui.collapse_toggle_track (key: 'collapsed_area_thesaurus_<section_id>').
* The default state is 'opened'.
*
* (!) This function is module-private (not exported). It is also called for the
* 'content' render level in non-search cases, so it must remain a fast,
* synchronous operation.
*
* @param {Object} self - The area_thesaurus instance that owns the render.
* @returns {HTMLElement} content_data <div> ready to be appended to the wrapper.
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
		const data				= self.data.find(item => item.tipo==='dd100' || item.tipo==='dd5') || {}
		const hierarchy_nodes	= data.value || []
		const typology_nodes	= data.typologies || []

	// typology_nodes. sort typologies by order field
		typology_nodes.sort((a, b) => parseFloat(a.order) - parseFloat(b.order));

	// iterate typology_nodes
		const typology_length = typology_nodes.length
		for (let i = 0; i < typology_length; i++) {

			const typology_item = typology_nodes[i]

			// check if typology items are empty
				// hierarchy sections
				const hierarchy_sections_full	= hierarchy_nodes.filter(el => parseInt(el.typology_section_id)===parseInt(typology_item.section_id))
				const hierarchy_sections_length	= hierarchy_sections_full.length
				if (hierarchy_sections_length<1) {
					// skip empty typologies (without hierarchy nodes)
					continue
				}
				// skip empty root_terms hierarchies
				const root_terms_length = hierarchy_sections_full.map(el => el.root_terms.length).reduce((a, b) => a + b, 0)
				if (root_terms_length===0) {
					continue;
				}

			// thesaurus_type_block li
				// add the 'model' CSS class when viewing in model mode so that
				// ts_line elements render their model_value column.
				const add_css = self.thesaurus_view_mode==='model'
					? ' model'
					: ''
				const li = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'thesaurus_type_block' + add_css,
					parent			: ul
				})

			// typology_name
				const typology_name = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'typology_name icon_arrow',
					dataset			: {
						section_id	: typology_item.section_id
					},
					inner_html		: typology_item.label,
					parent			: li
				})

			// typology_container
				const typology_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'typology_container hide',
					parent			: li
				})

			// collapse typology_name->typology_container children
				// Collapse/expose callbacks update the arrow icon class on the header.
				const collapse = () => {
					typology_name.classList.remove('up')
				}
				const expose = () => {
					typology_name.classList.add('up')
				}
				ui.collapse_toggle_track({
					toggler				: typology_name,
					container			: typology_container,
					collapsed_id		: 'collapsed_area_thesaurus_'+typology_item.section_id,
					collapse_callback	: collapse,
					expose_callback		: expose,
					default_state		: 'opened'
				})

				// sort hierarchy_nodes by order value and alphabetic. First those with a order value and then the rest.
				const ordered		= hierarchy_sections_full.filter(obj => obj.order !== 0).sort(sort_root_terms)
				const disordered	= hierarchy_sections_full.filter(obj => obj.order === 0).sort(sort_root_terms)
				// concatenate all values, ordered and disordered
				const hierarchy_sections = ordered.concat(disordered)
				for (let j = 0; j < hierarchy_sections_length; j++) {

					const hierarchy_sections_item = hierarchy_sections[j]

					const root_terms = hierarchy_sections_item.root_terms
					if (root_terms.length<1) {
						continue;
					}

					root_terms.forEach((root_term)=>{
						// Render current root term node
						const placeholder_wrapper = render_root_term({
							self,
							root_term,
							hierarchy_sections_item
						})
						typology_container.appendChild(placeholder_wrapper)
					})//end foreach root_terms

					// break;
				}//end iterate hierarchy_sections

			// break;
		}//end for (let i = 0; i < typology_length; i++) typology_nodes

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.type)
			  content_data.appendChild(fragment)


	return content_data
}//end render_content_data



/**
* RENDER_ROOT_TERM
* Create and render a ts_object instance for a single root-level thesaurus term.
*
* This is the non-blocking rendering path for root nodes: a placeholder <div> is
* returned immediately so the caller can append it to the DOM without waiting.
* The actual ts_object is fetched, built, and rendered asynchronously; once the
* node is ready it replaces the placeholder via requestAnimationFrame so the
* browser has time to paint.
*
* This pattern prevents the initial page render from blocking on N concurrent
* server round-trips (one per root term). Each ts_object.get_instance() call
* retrieves a cached instance or creates a new one via init().
*
* The ts_object instance is registered in self.ar_instances so that the area's
* destroy cascade can reclaim it on rebuild (search, refresh, navigate).
*
* Key options forwarded to ts_object.get_instance():
*   - section_tipo / section_id — identify the thesaurus term record.
*   - children_tipo             — the component_relation_children tipo used when
*                                 expanding child branches for this hierarchy.
*   - thesaurus_mode            — 'default' (descriptors) or 'relation', read from
*                                 self.context.thesaurus_mode. The server derives it;
*                                 on a picker read it is granted from the declared
*                                 caller (@see area_thesaurus picker_caller).
*   - ts_parent                 — fixed as 'root' so the instance key is
*                                 distinct from deeper expansions of the same node.
*   - linker                    — propagated from the area (set by the DS/portal
*                                 caller via URL param `initiator`, or replaced by
*                                 thesaurus_picker.js attach_picker with the linker
*                                 component itself). This is also how a tree row
*                                 reaches its picker: attach_picker stamps
*                                 `linker.picker`, and get_picker(node) is that one
*                                 hop — nothing here re-derives it.
*   - is_ontology               — true when model is 'area_ontology'; changes
*                                 display and operation options in ts_object.
*
* @param {Object} options
* @param {Object} options.self                   - The area_thesaurus instance.
* @param {Object} options.root_term              - Root term descriptor from server data.
*   Shape: { section_tipo, section_id, ... }
* @param {Object} options.hierarchy_sections_item - Parent hierarchy section descriptor.
*   Shape: { children_tipo, ... }
* @returns {HTMLElement} placeholder_wrapper — a <div class="wrapper_placeholder"> that
*   will be replaced in-place once the ts_object finishes rendering.
*/
export const render_root_term = function (options) {

	const {
		self,
		root_term,
		hierarchy_sections_item
	} = options

	// short vars
	const section_tipo			= root_term.section_tipo
	const section_id			= root_term.section_id
	const children_tipo			= hierarchy_sections_item.children_tipo
	const thesaurus_view_mode	= self.thesaurus_view_mode // model|default

	// placeholder_wrapper
	const placeholder_wrapper = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'wrapper_placeholder'
	})

	// loading message
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'loading',
		text_content	: `Loading ${section_tipo}`,
		parent			: placeholder_wrapper
	})

	// ts_object_instance
	// Note that we do NOT wait here, we return the placeholder_wrapper
	// and, when the ts_object if fully rendered, the placeholder is replaced.
	ts_object.get_instance({
		// key_parts
		section_tipo		: section_tipo,
		section_id			: section_id,
		children_tipo		: children_tipo,
		thesaurus_mode		: self.context?.thesaurus_mode || null,
		ts_parent			: 'root',
		// others
		thesaurus_view_mode	: thesaurus_view_mode,
		caller				: self,
		linker				: self.linker, // usually a portal component instance
		is_root_node		: true,
		area_model			: self.model,
		is_ontology			: self.model === 'area_ontology'
	})
	.then(async (ts_object_instance)=>{

		// register in the area destroy cascade: every rebuild (search, refresh)
		// already destroys dependencies, so the previous tree is reclaimed
		if (self.ar_instances && !self.ar_instances.includes(ts_object_instance)) {
			self.ar_instances.push(ts_object_instance)
		}

		await ts_object_instance.build()

		const node_wrapper = await ts_object_instance.render()

		// hierarchy wrapper node
		requestAnimationFrame(
			() => {
				placeholder_wrapper.replaceWith(node_wrapper);
			}
		);
	})


	return placeholder_wrapper
}//end render_root_term



/**
* SORT_ROOT_TERMS
* Comparator for sorting hierarchy section objects by their numeric 'order'
* field, with a locale-aware alphabetical fallback on 'target_section_name'
* when the order values are equal.
*
* Used with Array.prototype.sort() by render_content_data to place ordered
* hierarchy sections before unordered ones, and to sort within each group.
*
* (!) Uses loose equality (==) for the order comparison so that numeric 0
* and string '0' are treated as equal — this is intentional and must not
* be changed to strict equality without verifying server output shapes.
*
* @param {Object} a - First hierarchy section object.
* @param {Object} b - Second hierarchy section object.
* @returns {number} Negative, zero, or positive integer per sort contract.
*/
const sort_root_terms = function (a, b) {
	// If first value is same
	if (a.order == b.order) {
		// sort by target_section_name like 'Onomastic' ascending
		return new Intl.Collator().compare(a.target_section_name, b.target_section_name)
	} else {
		// order by order value from lowest to highest
		return a.order - b.order
	}
}//end sort_root_terms



/**
* GET_BUTTONS
* Build the toolbar DocumentFragment for the thesaurus area.
*
* Assembles two fixed buttons (Search toggler, Show All) and a dynamic block of
* context buttons defined in self.context.buttons (from the server context).
* All buttons except 'button_delete' are rendered; button_new publishes a
* 'new_section_<id>' event; button_import is currently a no-op (the tool_common
* call is commented out pending the tool infrastructure refactor).
*
* Returns null early when no buttons are defined in the context, so the caller
* can skip appending an empty fragment.
*
* The Search button publishes 'toggle_search_panel_<self.id>', which the
* area_thesaurus init() handler picks up to lazily build and mount the filter.
*
* The Show All button calls self.filter.show_all() directly, which triggers
* the filter to reset its SQO and re-request data without any active constraint.
*
* Additional tools are appended by ui.add_tools(), which reads self.tools[]
* populated from the context during build().
*
* @param {Object} self - The area_thesaurus instance.
* @returns {DocumentFragment|null} Fragment containing the buttons_container div,
*   or null if self.context.buttons is absent.
*/
const get_buttons = function(self) {

	// ar_buttons list from context
		const ar_buttons = self.context?.buttons
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
		const filter_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning search',
			inner_html		: get_label.find || 'Search',
			parent			: buttons_container
		})
		const mousedown_handler = (e) => {
			e.stopPropagation()
			event_manager.publish('toggle_search_panel_'+self.id)
		}
		filter_button.addEventListener('mousedown', mousedown_handler)
		// ui.create_dom_element({
		// 	element_type	: 'span',
		// 	class_name		: 'button white search',
		// 	parent			: filter_button
		// })
		// filter_button.insertAdjacentHTML('beforeend', get_label.find)

	// show_all_button. Show all records button
		const show_all_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning show_all',
			inner_html		: get_label.show_all || 'Show all',
			parent			: buttons_container
		})
		// mousedown event
		const show_all_mousedown_handler = (e) => {
			e.stopPropagation()
			// Trigger section filter (search.js instance) method 'show_all' like search form do.
			self.filter.show_all(show_all_button)
		}
		show_all_button.addEventListener('mousedown', show_all_mousedown_handler)

	// other_buttons_block
		const other_buttons_block = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'other_buttons_block',
			parent			: buttons_container
		})

	// other buttons
		// Iterate context-defined buttons, rendering each as a <button> element.
		// 'button_delete' is excluded — deletion in the thesaurus uses a
		// context-menu / ts_line action, not a toolbar button.
		const ar_buttons_length = ar_buttons.length;
		for (let i = 0; i < ar_buttons_length; i++) {

			const current_button = ar_buttons[i]

			if(current_button.model==='button_delete') continue

			// button node
				const class_name	= 'warning ' + current_button.model
				const button_node	= ui.create_dom_element({
					element_type	: 'button',
					class_name		: class_name,
					inner_html		: current_button.label,
					parent			: other_buttons_block
				})
				const click_handler = (e) => {
					e.stopPropagation()

					switch(current_button.model){
						case 'button_new':
							event_manager.publish('new_section_' + self.id)
							break;
						case 'button_import':
							// (!) button_import handler is intentionally a no-op:
							// the tool_common.open_tool() call is commented out pending
							// the tool infrastructure refactor. Do not remove this case.
							// tool_common.open_tool({
							// 	tool_context	: current_button.tools[0],
							// 	caller			: self
							// })
							break;
						default:
							event_manager.publish('click_' + current_button.model)
							break;
					}
				}
				button_node.addEventListener('click', click_handler)
		}//end for (let i = 0; i < ar_buttons_length; i++)

	// tools
		ui.add_tools(self, other_buttons_block)


	return fragment
}//end get_buttons



// @license-end
