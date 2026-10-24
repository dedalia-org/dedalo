// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {set_before_unload} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {printf} from '../../common/js/utils/index.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {dd_request_idle_callback, when_in_viewport} from '../../common/js/events.js'
	import {filter_tree, MATCH_LIMIT} from './security_access_filter.js'



/**
* VIEW_DEFAULT_EDIT_SECURITY_ACCESS
*
* Edit-mode view for the component_security_access component.
*
* Renders a hierarchical permission tree that lets administrators grant or
* revoke access to every ontology element (areas, sections, components,
* section_groups, buttons…) for a given user profile.
*
* The tree distinguishes two node types:
*   - Area/section nodes  (tipo === section_tipo): rendered with a tri-state
*     checkbox (checked = rw, indeterminate = r, unchecked = no access) and a
*     "global" radio-button group that bulk-sets all child components at once.
*   - Permission nodes (tipo !== section_tipo, i.e. actual components or
*     buttons): rendered with a three-option radio group (x / r / rw).
*
* Permission values used throughout this module:
*   0 → no access (x)
*   1 → read-only  (r--)
*   2 → read-write (rw-)
*
* Key data sources on `self` (the component_security_access instance):
*   self.data.datalist      – flat ontology tree fetched from the server cache,
*                             each entry: {tipo, section_tipo, parent, label, model}
*   self.data.changes_files – chronological list of JSON change-log file names
*   self.filled_value       – datalist mirrored with a resolved permission value
*                             for every node (value 0 for nodes absent from DDBB)
*   self.permissions        – numeric permission level of the current *viewer*
*                             (1 = read-only → read-only tree, >1 → editable)
*
* Lazy rendering: branch children are built on first expand using
* `requestAnimationFrame`, keeping initial paint cost low for large trees.
*
* Tree filter: a search box (`build_tree_filter`) above the tree narrows it to the
* nodes whose LABEL or TIPO match, rebuilt from that subset — matches plus their
* ancestor chain, every branch open — because the ~13k-node tree is lazy and the
* matches are not in the DOM to hide. It is VISUAL ONLY: permission values and the
* propagation walks always read the full datalist. See `security_access_filter.js`.
*
* Exports a single named factory function `view_default_edit_security_access`
* plus a static `.render` method consumed by the component render dispatch.
*/



/**
* VIEW_DEFAULT_EDIT_SECURITY_ACCESS
* Manages the component's logic and appearance in client side
*/
export const view_default_edit_security_access = function() {

	return true
}//end view_default_edit_security_access



/**
* RENDER
* Entry point called by the component render dispatch for the 'edit' mode.
*
* Builds either a full wrapper (with toolbar buttons) or a bare content_data
* node depending on `options.render_level`.
*
* When `self.permissions === 1` the tree is rendered read-only (no checkboxes,
* no save button).  When permissions > 1 the editable tree is shown together
* with a Save button that is initially disabled and becomes enabled whenever
* any permission value is mutated (via the `show_save_button_<id>` event).
*
* @param {Object} self - component_security_access instance
* @param {Object} options - render configuration
* @param {string} [options.render_level='full'] - 'full' builds a complete
*   wrapper node; 'content' returns only the inner content_data element
* @returns {Promise<HTMLElement>} the wrapper element (render_level='full') or
*   the content_data element (render_level='content')
*/
view_default_edit_security_access.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons
		}
		if (self.view==='line') {
			wrapper_options.label = null // prevent to create label node
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the main content area containing the permission tree, its filter box and
* the change-history selector.
*
* Branches on `self.permissions`:
*   - 1 (read-only viewer): renders the static read tree via the filter's paint
*     and returns immediately without adding the Save button or its associated
*     event subscriptions.
*   - >1 (editor): subscribes to `show_save_button_<id>` events and attaches a
*     Save button that calls `self.save_changes()` on click.
*
* The `content_data` element carries a `.content_data` pointer on the returned
* `wrapper` node so callers can reach the inner DOM without querying.
*
* Note: `value` here is `self.filled_value`, NOT `data.value`. The
* server-side `data.value` omits entries with permission 0; `filled_value` is
* the expanded mirror that includes a zero-valued entry for every datalist
* node, making client-side propagation safe.
*
* @param {Object} self - component_security_access instance
* @returns {Promise<HTMLElement>} content_data element containing the full
*   permission tree and (when editable) the Save button
*/
const get_content_data = async function(self) {

	// short vars
		const data		= self.data || {}
		// array of objects with all elements from Ontology
		const datalist	= data.datalist || []
		// NOTE: value here is not data.value!!!!
		// Used filled_value because the data.value do not have values with 0 (no access)
		// filled_value is the full value that will not save in DDBB
		// the name value of const is used to maintain the content_data uniformity between components
		const value		= self.filled_value || [] // data.value || []
		// file list of changes done, ordered by date last change file is the first into the array
		const changes_files = data.changes_files || []

	// debug
		if(SHOW_DEBUG===true) {
			// console.log("component_security_access value:", value);
			// console.log("datalist:",datalist);
			// console.log("datalist_object:",datalist_object);
		}

	// content_data
		const content_data = ui.component.build_content_data(self)
			  content_data.classList.add('nowrap')

	// Tree
		// ul tree_root
		const ul = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'ul_item content_value tree_root' // former 'inputs_container'
			})

	// get changes selector
		const changes_files_selector = render_changes_files_selector({
			self			: self,
			changes_files	: changes_files,
			ul 				: ul
		})

		content_data.appendChild(changes_files_selector)
		content_data.appendChild(ul)

	// tree filter. It is the FIRST child of the tree ul (so a tree repaint keeps it)
	// and the only owner of the tree paint: initial render, filter, and the
	// changes-panel jump all go through it.
		const tree_filter = build_tree_filter(self, datalist, value, ul)
		ul.appendChild(tree_filter.node)
		ul.paint = tree_filter.paint


	// Read only
		 if(self.permissions === 1){
			tree_filter.paint('')

			return content_data
		 }

	// Read and write
		// button_save
			const button_save = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'primary save button_save folding disable',
				inner_html		: get_label.save || 'Save',
				parent			: content_data
			})
			// click event
			const save_handler = async (e) => {
				e.stopPropagation()

				// loading
				content_data.classList.add('loading')

				await self.save_changes()
				button_save.classList.add('disable')
				const warning_label_text = self.node.querySelector('.warning_label_text')
				if (warning_label_text) {
					warning_label_text.remove()
				}

				// loading
				content_data.classList.remove('loading')
			}
			button_save.addEventListener('click', save_handler)

			// subscribe event show_save_button_
			const show_save_button_handler = () => {
				button_save.classList.remove('disable')
				const label = self.node.querySelector('.label')
				if (label && !label.querySelector('.warning_label_text')) {
					// warning_label_text
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'warning_label_text blink',
						inner_html		: get_label.unsaved_changes || 'Unsaved changes!',
						parent			: label
					})
				}
				// page unload event
				// set_before_unload (bool) add
				set_before_unload(true)
			}
			self.events_tokens.push(
				event_manager.subscribe('show_save_button_'+self.id, show_save_button_handler)
			)

			// debug
				// value.push({
				// 	tipo			: 'numisdata1017',
				// 	section_tipo	: 'numisdata1016',
				// 	value			: 1
				// })
				//
				// console.log('numisdata1016 section item:', datalist.filter(el => el.tipo==='numisdata1016'));
				// const found = datalist.find(el => el.tipo==='numisdata1017')
				// found.section_tipo = 'numisdata3'
				// console.log('numisdata1017 item:', datalist.filter(el => el.tipo==='numisdata1017'));
				// console.log('numisdata1017 value:', value.filter(el => el.tipo==='numisdata1017'));

			// initial tree (unfiltered)
				tree_filter.paint('')


	return content_data
}//end get_content_data



/**
* BUILD_TREE_FILTER
* Builds the tree search box and returns it with the one function that paints the
* tree: `paint(query)`.
*
* The bar is a `li` inside the tree `ul` (not a sibling of it): the tree column is
* already laid out, and the bar repeats the left column's rhythm (one label row,
* then the control row) so the search box and the "Latest changes" selector sit on
* the same visual line. It paints no surface of its own — see the .less.
*
* `paint` is the ONLY place that renders the tree, and it is shared by three
* callers — the initial render, the search box, and the "Latest changes" panel's
* jump to a section (through the `ul.paint` expando, which passes no query and so
* RESETS the filter: the jump's whole point is to reveal one section, and an
* active query would hide it). The box is cleared with it, so input and tree agree.
* None of the callers can wipe the filter box or paint a different tree.
*
* A filtered paint clears the tree back to the filter `li`, renders the subset
* (`filter_tree`: matches + their ancestor path) with the OFF-SCREEN branches open
* and eager, and updates the counter / dead-end copy. The empty query restores the
* normal lazy tree — no collapse state is written while filtering, so the user's
* open/closed branches come back untouched.
*
* Subscription hygiene: each paint subscribes per-node handlers through
* `event_manager` (inside the renderers), so the previous paint's tokens are
* released here — its DOM nodes are gone, and without this every keystroke would
* leave the whole previous tree subscribed forever. See `release_painted`.
*
* @param {Object} self - component_security_access instance
* @param {Array} datalist - complete flat ontology list (self.data.datalist)
* @param {Array} value - self.filled_value
* @param {HTMLElement} ul - the tree `ul` (ul.paint is set by the caller)
* @returns {Object} {node, paint} - the filter `li` and the tree painter
*/
const build_tree_filter = function(self, datalist, value, ul) {

	// filter li
		const filter_node = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'tree_filter'
		})

	// label. A bare <label>, the same box as the "Latest changes" header opposite:
	// that shared rhythm is what puts this box and the changes <select> on one line
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'tree_filter_label',
			text_content	: get_label.search || 'Search',
			parent			: filter_node
		})

		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'search',
			class_name		: 'tree_filter_input',
			placeholder		: get_label.filter_by_name_or_tipo || 'Filter by name or tipo…',
			aria			: {label: get_label.filter_by_name_or_tipo || 'Filter by name or tipo'},
			parent			: filter_node
		})

		const clear_button = ui.create_dom_element({
			element_type	: 'button',
			type			: 'button',
			class_name		: 'tree_filter_clear hide',
			text_content	: '×',
			aria			: {label: get_label.remove_filter || 'Remove filter'},
			parent			: filter_node
		})

		const count_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'tree_filter_count hide',
			parent			: filter_node
		})

	// status: dead end, or the truncated-list notice. role=status announces it,
	// so a filtered-to-nothing tree is not a silent empty panel for a screen reader
		const status_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'tree_filter_status hide',
			role			: 'status',
			parent			: filter_node
		})

	// tokens of the subscriptions created by the last paint (see release_painted).
	// `painted_tokens` keeps the ARRAY IDENTITY: destroy() replaces self.events_tokens,
	// and an index alone would then point into somebody else's list.
		let painted_from	= null
		let painted_tokens	= null

	/**
	* RELEASE_PAINTED
	* Unsubscribes every handler the last paint created and drops its tokens from
	* `self.events_tokens`: the nodes they served are being replaced, and without
	* this every keystroke would leave the whole previous tree subscribed forever.
	* Tokens pushed AFTER a paint belong to it too (the global radio groups are
	* built in an idle callback), which is why the range runs to the end.
	*/
	const release_painted = function() {

		if (painted_from===null || painted_tokens!==self.events_tokens) {
			// nothing painted yet, or the instance was destroyed/rebuilt meanwhile
			painted_from	= null
			painted_tokens	= null
			return
		}

		const stale = self.events_tokens.splice(painted_from)
		for (const token of stale) {
			event_manager.unsubscribe(token)
		}

		painted_from	= null
		painted_tokens	= null
	}//end release_painted

	/**
	* PAINT
	* @param {string} [query] - raw search box value. OMITTED (undefined) means
	*   "reset": the "Latest changes" jump calls `ul.paint()` because it paints the
	*   tree to reveal one section, and a stale query would hide that section. The
	*   box is cleared with it, so the input and the tree never disagree.
	*/
	const paint = function(query) {

		// undefined = external repaint (changes-panel jump): drop the filter, not just
		// its effect. The box is cleared with it, so input and tree never disagree.
			const external	= query===undefined
			const effective	= external ? '' : query
			if (external) {
				input.value = ''
			}

		// release the previous paint's subscriptions (its nodes are replaced)
			release_painted()

		// subset. null means no filter → normal lazy tree
			const filtered = filter_tree(datalist, effective)
			// the renderers read these to render branches open/eager and to mark matches
			self.filter_query	= filtered ? String(effective) : ''
			self.filter_matches	= filtered ? filtered.matches : null

		// tree items. Root level is filtered from the effective list
			const items			= filtered ? filtered.items : datalist
			const root_items	= items.filter(el => el.parent==='dd1')

		// clear the tree, keep the filter li (always the first child)
			while (ul.lastChild && ul.lastChild!==filter_node) {
				ul.removeChild(ul.lastChild)
			}

		// tree
			painted_from		= self.events_tokens.length
			painted_tokens		= self.events_tokens
			const tree_nodes	= (self.permissions===1)
				? render_tree_items_read(root_items, items, value, self)
				: render_tree_items(root_items, items, value, self)
			ul.appendChild(tree_nodes)

		// counters
			count_node.classList.toggle('hide', !filtered)
			if (filtered) {
				count_node.replaceChildren(document.createTextNode(
					filtered.match_count + ' / ' + datalist.length
				)) // SEC-031: text node
			}

			const status_text = !filtered
				? ''
				: filtered.match_count===0
					? (get_label.no_items_match || 'No items match your search')
					: filtered.truncated
						? printf(
							get_label.filter_showing_first || 'Showing the first {0} matches — type more to narrow the list.',
							MATCH_LIMIT
						)
						: ''
			status_node.textContent = status_text // SEC-031: text content
			status_node.classList.toggle('hide', status_text==='')

			clear_button.classList.toggle('hide', input.value==='')
	}//end paint

	// events
		input.addEventListener('input', () => paint(input.value))
		input.addEventListener('keydown', (e) => {
			if (e.key==='Escape' && input.value!=='') {
				e.stopPropagation() // do not let Escape close the page while it still clears a query
				input.value = ''
				paint('')
			}
		})
		clear_button.addEventListener('click', (e) => {
			e.stopPropagation()
			input.value = ''
			paint('')
			input.focus()
		})


	return {
		node	: filter_node,
		paint	: paint
	}
}//end build_tree_filter



/**
* RENDER_TREE_ITEMS
* Renders a flat list of datalist items into a hierarchical DOM tree and
* returns them as a DocumentFragment ready to be appended to any `ul`.
*
* Two-pass algorithm:
*   Pass 1 – render every item in the `items` array into a `li` node (via
*             `render_tree_item`) and index it by `tipo` in `tree_object`.
*   Pass 2 – for each node, look up its `item.parent` in `tree_object`; if
*             found, move the node into the parent's `.branch` sub-list;
*             otherwise add it to the root-level DocumentFragment.
*
* This approach avoids recursion while correctly building arbitrarily deep
* trees as long as every ancestor also appears in `items`.
*
* (!) `tree_item_node.item` and `tree_item_node.branch` are DOM expando
* properties set by `render_tree_item` / `render_area_item`. They must be
* present before the hierarchisation pass runs.
*
* @param {Array} items - datalist entries to render (may be a root-level
*   subset or a full datalist for a branch)
* @param {Array} datalist - list to build the tree FROM: the complete flat
*   ontology list, or the filtered subset (matches + ancestors) while the tree
*   filter is active. It resolves children for lazy branch expansion.
* @param {Array} value - self.filled_value array; each entry:
*   {section_tipo: string, tipo: string, value: number}
* @param {Object} self - component_security_access instance
* @returns {DocumentFragment} fragment whose direct children are the
*   root-level `li` nodes of the rendered sub-tree
*/
const render_tree_items = function(items, datalist, value, self) {

	// tree_object . Object with all li nodes rendered sequentially
		const tree_object = {}

	// render nodes. Every area/section node
		const items_length = items.length
		for (let i = 0; i < items_length; i++) {

			const current_item = items[i]

			// render_tree_item (with pointer to their item)
				const tree_node	= render_tree_item(
					current_item,
					datalist,
					value,
					self
				)// li node

			// store in the tree_object
				const key = current_item.tipo
				tree_object[key] = tree_node
		}

	// hierarchize nodes
		const fragment = new DocumentFragment()
		for(const key in tree_object) {

			const tree_node	= tree_object[key]
			const item		= tree_node.item

			const parent_key = item.parent

			if(tree_object[parent_key]) {
				// move node to parent branch
				tree_object[parent_key].branch.appendChild(tree_node)
			}else{
				// add to root level
				fragment.appendChild(tree_node)
			}
		}


	return fragment
}//end render_tree_items



/**
* RENDER_TREE_ITEM
* Dispatches a single datalist entry to the appropriate renderer based on
* whether the item represents a structural node (area/section) or a
* permission leaf (component, button, section_group, etc.).
*
* The distinguishing rule: when `item.tipo === item.section_tipo` the item
* IS the section root and is rendered as an area/section node with a
* tri-state checkbox and a collapsible branch.  Otherwise it is a
* permission leaf rendered with a radio group.
*
* After rendering, the expando property `tree_item_node.item` is set so
* the two-pass hierarchisation in `render_tree_items` can read the parent
* key without keeping a separate map.
*
* @param {Object} item - single datalist entry
* @param {Array} datalist - full flat ontology list
* @param {Array} value - self.filled_value
* @param {Object} self - component_security_access instance
* @returns {HTMLElement} `li` element with `.item` expando set
*/
const render_tree_item = function(item, datalist, value, self) {

	// single item case.
		const fn_render = (item.tipo===item.section_tipo)
			? render_area_item
			: render_permissions_item

	// create node and add to tree_object
		const tree_item_node = fn_render(
			item,
			datalist,
			value,
			self
		)
		// attach item object as pointer
		tree_item_node.item = item
		// the entry IS a match (not an ancestor kept for the path): mark it for highlight
		if (self.filter_matches?.has(item)) {
			tree_item_node.classList.add('match')
		}


	return tree_item_node
}//end render_tree_item



/**
* RENDER_AREA_ITEM
* Create default tree item node (section, area)
*
* Builds a `li` for an area or section node — i.e. an ontology element whose
* `tipo === section_tipo`.  The node contains:
*   - A tri-state checkbox (`checked` = rw, `indeterminate` = r, unchecked = x)
*   - A label with an expand/collapse arrow when the node has children
*   - An `[info_text]` span showing tipo / model / current permission (debug aid)
*   - A collapsible `ul.branch` whose children are built lazily on first expand
*   - A "global" radio group (x / r / rw) that bulk-applies a value to all
*     permission-leaf children of this area
*
* Checkbox change propagation logic:
*   When the user ticks/unticks the checkbox, `dd_request_idle_callback` is
*   used to defer the expensive propagation off the main thread:
*     1. All *area* children receive the same value (sections cascade down).
*     2. All parents up the hierarchy are updated.  If the new value is >= 2
*        every parent is set to 2 (give read-write access up the chain).
*        If the value is 1 or 0, each parent is only cleared when none of its
*        direct children still hold value >= 2 (the `parents_loop` label
*        implements an early-exit scan).
*     3. The item itself is updated last.
*     4. The `show_save_button_<id>` event is published to reveal the Save button.
*
* Change-of-value from sibling interactions is received via the
* `update_item_value_<id>_<tipo>_<section_tipo>` event, which updates the
* checkbox visual state without triggering further propagation.
*
* Expand / collapse state is persisted through `ui.collapse_toggle_track`
* using the key `security_acccess_<tipo>` (note: double-c typo in the key is
* intentional and must remain stable to avoid breaking stored states).
*
* FILTERED TREE: when `self.filter_query` is set (see `build_tree_filter`), the
* branch renders EAGER and open instead of lazily, because a match is usually
* several collapsed levels down. No collapse state is read or written then, so
* clearing the query restores the user's own open/closed branches. The children
* resolved here come from the `datalist` passed in — the filtered subset in that
* case — while the VALUE walks below always use the full `self.data.datalist`:
* filtering may hide nodes, never narrow what a checkbox or a global radio grants.
*
* @param {Object} item - datalist current item
* @param {Array} datalist - list to build the tree FROM: the full ontology list, or
*   the filtered subset (matches + ancestors) while a filter is active
* @param {Array} value - full list of elements in self.data (DB) at key zero
*   (this component has only one value but format is array)
* @param {Object} self - self component instance
* @returns {HTMLElement} li element with expando `.branch` for child nodes
*/
const render_area_item = function(item, datalist, value, self) {

	// direct_children check and set
		const tipo					= item.tipo
		const section_tipo			= item.section_tipo
		const direct_children		= item.model==='section'
			? datalist.filter(el => el.section_tipo===tipo && el.tipo!==tipo)
			: datalist.filter(el => el.parent===tipo)
		const direct_children_length = direct_children.length
		const has_child_section		 = direct_children.find(el => el.tipo===el.section_tipo)

	// full ontology list. `datalist` may be the filtered subset; value propagation
	// must always see every node or a parent would be cleared over hidden children
		const full_datalist = self.data?.datalist || datalist

	// item_value. get the current item value
		const item_value	= value.find(el => el.section_tipo===section_tipo && el.tipo===tipo)
		const permissions	= item_value && item_value.value
			? parseInt(item_value.value)
			: 0

	// li HTMLElement
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'li_item'
		})

	// left input_checkbox
		const input_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'input_value',
			name			: tipo + '_' + section_tipo,
			parent			: li
		})
		input_checkbox.item = item
		// checked option set on match
		if (typeof item_value!=='undefined') {
			// console.log("item_value.value:", item_value.value, item.tipo);
			if (permissions>=2) {
				input_checkbox.checked = true
			}else if(permissions===1) {
				input_checkbox.indeterminate = true
			}else{
				// nothing to do
			}
		}
		// update value, subscription to the changes: if the DOM input value was changed, observers DOM elements will be changed own value with the observable value
			const update_item_value_handler = (changed_data) => {
				// change the value of the current DOM element
				if (changed_data>=2) {
					input_checkbox.checked			= true
					input_checkbox.indeterminate	= false
				}else if(changed_data===1) {
					input_checkbox.checked			= false
					input_checkbox.indeterminate	= true
				}else if(changed_data===0) {
					input_checkbox.checked			= false
					input_checkbox.indeterminate	= false
				}
			}//end update_item_value_handler
			self.events_tokens.push(
				event_manager.subscribe('update_item_value_' + self.id + '_' + tipo + '_' + section_tipo, update_item_value_handler)
			)

		// change event
			const change_handler = async (e) => {
				e.preventDefault()

				// add main node loading style
				self.node.classList.add('loading')

				// execute decoupled
				dd_request_idle_callback(
				() => {

					// input_value
						const input_value = input_checkbox.checked
								? 2
								: input_checkbox.indeterminate
									? 1
									: 0

					// parents. propagate value to parents
						const parents = self.get_parents(input_checkbox.item);
						const parents_length = parents.length;

						// children
						const children = self.get_children(input_checkbox.item);
						const children_length = children.length;

						for (let i = children_length - 1; i >= 0; i--) {
							const child = children[i]
							if( child.tipo === child.section_tipo){
								self.update_value(child, input_value)
							}
						}

						// Parents
						// if the value is >= 2 set all parents with the value (give access to all parent chain)
						if (input_value>=2) {

							for (let i = 0; i < parents_length; i++) {

								const current_parent = parents[i]

								// update parent item data
									self.update_value(current_parent, 2)
							}

						}else{
							// if the value is 1 or 0
							// check all direct children or all the parents chain
							// if any child has set 2 as value stop because its necessary give access to it by its parents chain.
							parents_loop : for (let i = 0; i < parents_length; i++) {

								const current_parent = parents[i]
								// children
								// only direct children are necessary
								// because the children of the children give the access of its parent (the sibling of the node)
								const current_children			= full_datalist.filter(el => el.parent===current_parent.tipo)
								const current_children_length	= current_children.length
								for (let j = 0; j < current_children_length; j++) {

									const child = current_children[j]

									// exclude self
									// its value has changed to 0 so it doesn't need give access by the parent chain
										if (child.tipo===input_checkbox.item.tipo) {
											continue;
										}
									// find every value of the direct children
									// if any child has value set to 2, stop the propagation because it need give access from its parents.
									// break the parent loop
									const found = self.filled_value.find(el => el.tipo===child.tipo)
									if (found && found.value>=2) {
										break parents_loop;
									}
								}
								// only when the all direct child of the parent chain has not value
								// update parent item data
								self.update_value(current_parent, input_value)
							}
						}

					// update self item data
						self.update_value(item, input_value)

					// show_save_button_
						event_manager.publish( 'show_save_button_' + self.id )

					// remove main node loading style
					self.node.classList.remove('loading')
				})
			}//end change_handler
			input_checkbox.addEventListener('change', change_handler)

	// label
			const css_selectors = ['area_label']
			// add icon arrow when element has children. NOT while filtering: filtered
			// branches are always open and carry no toggle, so an arrow would be a
			// pointer-cursor control that does nothing.
			if (direct_children_length>0 && !self.filter_query) {
				css_selectors.push('icon_arrow')
			}
			// add selected when item matches a search (self.selected_tipo)
			if (item.tipo===self.selected_tipo) {
				css_selectors.push('selected')
			}
			// add when item has a child_section level
			if (has_child_section) {
				css_selectors.push('has_child_section')
			}
		const label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: css_selectors.join(' '),
			inner_html		: render_value(item.label, 'text'),
			parent			: li
		})
		// info_text
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'info_text',
			inner_html		: render_value(`[${item.tipo} ${item.model} ${permissions}]`, 'text'),
			parent			: label
		})

	// with children case
		if (direct_children_length>0) {
			// branch (ul container for children)
				const branch = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'ul_item branch hide'
				})
				li.branch = branch

			// tree filter: branches render open and EAGER. A filtered match is usually
			// several collapsed levels down, so lazy expansion would hide exactly what
			// the user is looking for. collapse_toggle_track is skipped on purpose: it
			// would persist filtered-view state over the user's own open/closed branches.
				if (self.filter_query) {
					branch.classList.remove('hide')
					branch.appendChild(render_tree_items(
						direct_children,
						datalist,
						value,
						self
					))
				}else{
					// track collapse toggle state of content
						const collapse = function() {
							label.classList.remove('up')
								// clean container
								// while (branch.firstChild) {
								// 	branch.removeChild(branch.firstChild);
								// }
						}
						const expose = function() {
							label.classList.add('up')
							if (!branch.hasChildNodes()) {
								const callback = () => {
									// direct_children render (return hierarchized children nodes)
									const tree_node = render_tree_items(
										direct_children,
										datalist,
										value,
										self
									) // return li node
									branch.appendChild(tree_node)
								}
								window.requestAnimationFrame(callback);
							}
						}
						ui.collapse_toggle_track({
							toggler				: label,
							container			: branch,
							collapsed_id		: 'security_acccess_' + item.tipo,
							collapse_callback	: collapse,
							expose_callback		: expose,
							default_state		: 'closed'
						})
				}

			// permissions_global container (radio buttons)
				const permissions_global = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'permissions_global',
					parent			: li
				})

				// loading_node. Display an text 'Checking...' while radio group is preparing
				const loading_node = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'loading',
					inner_html		: 'Checking...',
					parent			: li
				})

				// children create radio_group for permissions_global
					dd_request_idle_callback(
						() => {

							// full datalist (not the filtered subset): the global radio
							// speaks for EVERY child, visible or not
							const children = self.get_children(item, full_datalist)

							const radio_group = create_global_radio_group(
								self,
								item,
								permissions,
								datalist,
								branch, // HTMLElement components_container
								children // array of nodes
							)

							loading_node.remove()

							permissions_global.appendChild(radio_group)
						}
					)

			// add branch at last position
			li.appendChild(branch)
		}//end direct_children


	return li
}//end render_area_item



/**
* RENDER_PERMISSIONS_ITEM
* Create tree item node to check permissions (components, section_groups, buttons, etc.)
*
* Builds a `li` for a permission-leaf item — i.e. an ontology element whose
* `tipo !== section_tipo`.  These nodes represent concrete components, buttons,
* or section groups that carry individual access settings.
*
* The node contains:
*   - A three-option radio group (x / r / rw) created by
*     `create_permissions_radio_group`, which handles its own change propagation
*     up to parent checkboxes.
*   - A label displaying the item's human-readable ontology label.
*   - An `[info_text]` span with debug details (tipo / model / current value).
*   - An empty `.branch` `ul` expando when the item has further children in the
*     datalist (child nodes are appended later by the hierarchisation pass in
*     `render_tree_items`).
*
* (!) `direct_children` here uses `datalist.find` (returns one element or
* undefined) only to test for the *presence* of child nodes.  The actual child
* nodes are built and added by the two-pass loop in `render_tree_items`.
*
* @param {Object} item - datalist current item
* @param {Array} datalist - full list of section elements from ontology
* @param {Array} value - full list of elements in self.data (DB) at key zero
*   (this component has only one value but format is array)
* @param {Object} self - self component instance
* @returns {HTMLElement} li element with optional expando `.branch`
*/
const render_permissions_item = function(item, datalist, value, self) {

	// short vars
		const section_tipo			= item.section_tipo
		const tipo					= item.tipo
		const direct_children		= datalist.find(el => el.parent===tipo)

	// item_value (permissions). get the item value
		const item_value	= value.find(el => el.section_tipo===section_tipo && el.tipo===item.tipo)
		const permissions	= item_value && item_value.value
			? parseInt(item_value.value)
			: 0

	// li DOM node
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'li_item permissions'
		})

	// radio_buttons_container
		const radio_buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'radio_buttons_container',
			parent			: li
		})
		const radio_group = create_permissions_radio_group(self, item, permissions)
		radio_buttons_container.appendChild(radio_group)

	// label
		const label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'area_label',
			inner_html		: render_value(item.label, 'text'),
			parent			: li
		})
		// info_text
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'info_text',
			inner_html		: render_value(`[${item.tipo} ${item.model} ${permissions}]`, 'text'),
			parent			: label
		})

	// with children case
		if (direct_children) {
			// branch (ul container for children)
				const branch = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'ul_item branch',
					parent			: li
				})
				li.branch = branch
		}//end direct_children


	return li
}//end render_permissions_item



/**
* CREATE_PERMISSIONS_RADIO_GROUP
* Creates a triple radio group options (x,r,rw)
*
* Builds a DocumentFragment with three labelled radio inputs representing
* the three permission levels (0=x, 1=r, 2=rw) for a single permission-leaf
* item.
*
* Each radio input:
*   - Shares a `name` attribute keyed to `section_tipo + '_' + tipo` so only
*     one can be selected at a time for the same item.
*   - Subscribes to `update_item_value_<id>_<tipo>_<section_tipo>` to receive
*     reactive updates when a parent-level global radio or area checkbox changes
*     the value programmatically.
*   - On change, defers the propagation work via `dd_request_idle_callback`:
*       1. Sets all recursive children to the new value.
*       2. Calls `self.update_parents_radio_butons` to recalculate and update
*          the parent area checkboxes and global radio groups.
*       3. Publishes `show_save_button_<id>` to enable the Save button.
*
* A temporary "Propagating…" span is inserted into the grandparent node while
* the idle-callback runs, giving visual feedback during the propagation.
*
* @param {Object} self - component_security_access instance
* @param {Object} item - ontology item: {tipo, section_tipo, label, model, parent}
* @param {number} permissions - current permission value (0, 1, or 2)
* @returns {DocumentFragment} fragment with three `label > input[type=radio]`
*   elements for 'x', 'r', and 'rw'
*/
const create_permissions_radio_group = function(self, item, permissions) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// create_radio function
		const create_radio = (radio_value, title) => {

			// radio_input
				const radio_input = ui.create_dom_element({
					element_type	: 'input',
					type			: 'radio',
					class_name		: 'radio_value val_'+radio_value,
					value			: radio_value,
					name			: item.section_tipo +'_'+ item.tipo
				})
				// radio_input.item = item

			// checked value match
				if(permissions===radio_value) {
					radio_input.checked = true
				}

			// update value subscription
			// If the DOM input value was changed, observers DOM elements will change self value with the observable value
				const update_item_value_handler = (changed_data) => {
					// change the value of the current DOM element
					if (changed_data===radio_value) {
						radio_input.checked = true
					}
				}
				self.events_tokens.push(
					event_manager.subscribe('update_item_value_' + self.id +'_'+ item.tipo +'_'+ item.section_tipo, update_item_value_handler)
				)

			// change event
				const change_handler = async () => {

					const input_value = parseInt(radio_input.value)

					self.node.classList.add('loading')
					const loading_node = ui.create_dom_element({
						element_type	: 'span',
						inner_html		: '&nbsp;Propagating...',
						parent			: radio_input.parentNode.parentNode.parentNode
					})

					// Update all parents of the item
					// parents_radio_butons. update the state of all parents, checking his children state
						dd_request_idle_callback(
							async () => {

								// set the data of the parents and change the DOM node with update_value event
								const children			= self.get_children(item)
								const children_length	= children.length
								for (let i = children_length - 1; i >= 0; i--) {
									const current_child = children[i]
									self.update_value(current_child, input_value)
								}

								// update self item data
								self.update_value(item, input_value)

								// update parents
								self.update_parents_radio_butons(item, input_value)

								// remove
								self.node.classList.remove('loading')
								loading_node.remove()
							}
						)

					// show_save_button
						event_manager.publish('show_save_button_'+self.id)
				}
				radio_input.addEventListener('change', change_handler)

			// radio_input_label
				const radio_input_label = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'radio_label',
					inner_html		: render_value(title, 'text')
				})
				radio_input_label.prepend(radio_input)

			return radio_input_label
		}//end create_radio

	// render 3 radio button nodes
		fragment.appendChild( create_radio(0, 'x') )
		fragment.appendChild( create_radio(1, 'r') )
		fragment.appendChild( create_radio(2, 'rw') )


	return fragment
}//end create_permissions_radio_group



/**
* CREATE_GLOBAL_RADIO_GROUP
* Creates a triple radio group options (x,r,rw) that appears in areas / sections
*
* Builds a DocumentFragment with three labelled radio inputs that control the
* permission value for ALL permission-leaf children of an area/section at once.
* This "global" radio group sits beside the area label in `render_area_item`.
*
* Initial checked state is derived from `self.filled_value`:
*   - If every permission-leaf child has the same value (0, 1, or 2), that
*     radio is pre-selected (`child_value` equals the common value).
*   - If children have mixed values, no radio is pre-selected (`child_value`
*     is null).
*
* Child identification uses a Set of `tipo_section_tipo` keys (`children_key`)
* built from the `children` array.  Only items where `tipo !== section_tipo`
* (i.e. actual permission leaves, not area nodes) are considered.
*
* On change (`change_handler`):
*   1. Iterates `self.filled_value` in reverse; for each item whose composite
*      key is in `children_key`:
*        - Area sub-items publish `update_area_radio_<id>_<tipo>_<section_tipo>`
*          so any nested global radio group in a child area is also updated.
*        - Permission leaves update their `.value` in-place and publish
*          `update_item_value_<id>_<tipo>_<section_tipo>` to sync radio buttons.
*   2. Calls `self.update_parents_radio_butons` to re-evaluate the area's own
*      parent chain.
*   3. Publishes `show_save_button_<id>`.
*
* The `update_area_radio_<id>_<tipo>_<section_tipo>` subscription keeps this
* radio group in sync when a child changes and the common value is resolved
* again:
*   - `changed_data` equals the new uniform value → check the matching radio.
*   - `changed_data === null` (mixed values) and the radio was checked → uncheck
*     it to reflect ambiguity.
*
* (!) The `components_container` parameter (`branch`) is declared but not used
* inside the body.  It is kept for potential future use or historical reasons.
*
* @param {Object} self - component_security_access instance
* @param {Object} item - area/section datalist entry: {tipo, section_tipo, …}
* @param {number} permissions - current permission value of the area node itself
* @param {Array} datalist - full flat ontology list
* @param {HTMLElement} components_container - the branch `ul` element (unused
*   inside this function; kept for API symmetry)
* @param {Array} children - all recursive descendant datalist entries for this
*   area, as returned by `self.get_children(item)`
* @returns {DocumentFragment} fragment with three `label > input[type=radio]`
*   elements for 'x', 'r', and 'rw'
*/
const create_global_radio_group = function(self, item, permissions, datalist, components_container, children) {

	const fragment = new DocumentFragment()

	// child_value
		// by default the child_value is 0 (without any permission)
		// if all children has the same value (0,1 or 2) child_value will be the this common value
		// else (if any child has a different value) the value has to be null, because is not possible represent all values in the node
		const children_length = children.length

		const children_keys = children.map(el =>{
			return el.tipo+'_'+el.section_tipo
		})

		const children_key = new Set(children_keys);

		const children_data = self.filled_value.filter(el => {
			const child_key = el.tipo+'_'+el.section_tipo
			return  el.tipo !== el.section_tipo && children_key.has(child_key);
		})

		const data_values = children_data.map(el =>{
			return el.value
		})
		const child_value = data_values.every(val => val === data_values[0])
			? data_values[0]
			: null;


	const create_radio = (radio_value, title) => {

		// radio_input
			const radio_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'radio',
				class_name		: 'radio_value global val_' + radio_value,
				value			: radio_value,
				name			: item.section_tipo + '_' + item.tipo
			})

		// checked status of the child_value
		// child_value could be:
		// null: the children has different values between then
		// 0 or 1 or 2: all children has the same value 0 or 1 or 2
			if (child_value!==null && radio_value===child_value) {
				radio_input.checked = true
			}

		// update_area_radio event. Update value, subscription to the changes: if the DOM input value was changed, observers DOM elements will be changed own value with the observable value
			const update_area_radio_handler = (changed_data) => {
				// change the value of the current DOM element
				if (changed_data===radio_value && !radio_input.checked) {
					radio_input.checked = true
				}
				else if(radio_input.checked && changed_data===null){
					radio_input.checked = false
				}
			}
			self.events_tokens.push(
				event_manager.subscribe('update_area_radio_' + self.id +'_'+ item.tipo +'_'+ item.section_tipo, update_area_radio_handler)
			)

		// change event
			const change_handler = () => {

				const input_value = parseInt(radio_input.value)

				// set style as loading to lock the component while the value is propagated
				self.node.classList.add('loading')
				const loading_node = ui.create_dom_element({
					element_type	: 'span',
					inner_html		: '&nbsp;Propagating...',
					parent			: radio_input.parentNode.parentNode
				})

				// update_parents_radio_butons
					dd_request_idle_callback(
						() => {

							const filled_length = self.filled_value.length
							for (let i = filled_length - 1; i >= 0; i--) {
								const item = self.filled_value[i];
								const child_key = item.tipo+'_'+item.section_tipo;
								if(children_key.has(child_key)){

									if(item.tipo===item.section_tipo){
										// areas case
										event_manager.publish(
											'update_area_radio_' + self.id + '_' + item.tipo + '_' + item.section_tipo,
											input_value
										)
									}else{
										// components case
										item.value = parseInt(input_value)

										event_manager.publish(
											'update_item_value_' + self.id + '_' + item.tipo + '_' + item.section_tipo,
											input_value
										);
									};
								};
							};

							// update parents
							self.update_parents_radio_butons(item, input_value)

							// remove loading style. The value is propagated
							self.node.classList.remove('loading')
							loading_node.remove()
						}
					)

				// show_save_button
					event_manager.publish('show_save_button_'+self.id)
			}
			radio_input.addEventListener('change', change_handler)

		// radio_input_label
			const radio_input_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'radio_label',
				inner_html		: render_value(title, 'text')
			})
			radio_input_label.prepend(radio_input)

		return radio_input_label
	}

	// render 3 radio button nodes
		fragment.appendChild( create_radio(0, 'x') )
		fragment.appendChild( create_radio(1, 'r') )
		fragment.appendChild( create_radio(2, 'rw') )



	return fragment
}//end create_global_radio_group



/**
* GET_BUTTONS
* Builds the component's toolbar buttons container for the edit view.
*
* Creates an outer buttons_container (via `ui.component.build_buttons_container`)
* and, when `self.show_interface.tools` is true, prepends the standard tool
* buttons (e.g. history, info) via `ui.add_tools`.
*
* The inner `buttons_fold` div enables the sticky-position layout that keeps
* action buttons visible while the user scrolls through a large permission tree.
*
* This function is only called when `self.permissions > 1`; callers with
* read-only permission receive `null` instead.
*
* @param {Object} self - component_security_access instance; must expose
*   `.show_interface.tools` and compatible state for `ui.add_tools`
* @returns {HTMLElement} buttons_container element ready to be passed to
*   `ui.component.build_wrapper_edit`
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



/**
* RENDER_TREE_ITEMS_READ
* Render given tree items hierarchically
*
* Read-only counterpart of `render_tree_items`.  Uses the same two-pass
* algorithm (render → index in `tree_object` → hierarchise by parent key)
* but delegates to `render_tree_item_read` which produces static nodes with
* no interactive controls.
*
* Called when `self.permissions === 1`.
*
* @param {Array} items - datalist entries to render (root-level subset or a
*   full datalist for a branch)
* @param {Array} datalist - list to build the tree FROM: the full ontology list, or
*   the filtered subset (matches + ancestors) while a filter is active
* @param {Array} value - self.filled_value; each entry:
*   {section_tipo: string, tipo: string, value: number}
* @param {Object} self - component_security_access instance
* @returns {DocumentFragment} fragment whose direct children are the
*   root-level `li` nodes of the read-only sub-tree
*/
const render_tree_items_read = function(items, datalist, value, self) {

	// tree_object . Object with all li nodes rendered sequentially
		const tree_object = {}

	// render nodes. Every area/section node
		const items_length = items.length
		for (let i = 0; i < items_length; i++) {

			const current_item = items[i]

			// render_tree_item_read (with pointer to their item)
				const tree_node	= render_tree_item_read(
					current_item,
					datalist,
					value,
					self
				)// li node

			// store in the tree_object
				const key = current_item.tipo
				tree_object[key] = tree_node
		}

	// hierarchize nodes
		const fragment = new DocumentFragment()
		for(const key in tree_object) {

			const tree_node	= tree_object[key]
			const item		= tree_node.item

			const parent_key = item.parent

			if(tree_object[parent_key]) {
				// move node to parent branch
				tree_object[parent_key].branch.appendChild(tree_node)
			}else{
				// add to root level
				fragment.appendChild(tree_node)
			}
		}


	return fragment
}//end render_tree_items_read



/**
* RENDER_TREE_ITEM_READ
* Recursive function to render tree items
*
* Read-only dispatcher: mirrors `render_tree_item` but routes to the
* `*_read` renderers (`render_area_item_read` / `render_permissions_item_read`)
* which produce static, non-interactive DOM nodes.
*
* Sets the `tree_item_node.item` expando for the hierarchisation pass.
*
* @param {Object} item - single datalist entry
* @param {Array} datalist - list to build the tree FROM (full, or the filtered subset)
* @param {Array} value - self.filled_value
* @param {Object} self - component_security_access instance
* @returns {HTMLElement} `li` element with `.item` expando set
*/
const render_tree_item_read = function(item, datalist, value, self) {

	// single item case.
		const fn_render = (item.tipo===item.section_tipo)
			? render_area_item_read
			: render_permissions_item_read

	// create node and add to tree_object
		const tree_item_node = fn_render(
			item,
			datalist,
			value,
			self
		)
		// attach item object as pointer
		tree_item_node.item = item
		// the entry IS a match (not an ancestor kept for the path): mark it for highlight
		if (self.filter_matches?.has(item)) {
			tree_item_node.classList.add('match')
		}


	return tree_item_node
}//end render_tree_item_read



/**
* RENDER_AREA_ITEM_READ
* Create default tree item node (section, area)
*
* Read-only counterpart of `render_area_item`.  Builds a `li` node that
* displays the permission level as a Unix-style permission string prefix
* on the label (`---`, `r--`, or `rw-`) with no interactive controls.
*
* Children are still revealed lazily: the branch `ul` starts hidden and
* is populated on first expand using `window.requestAnimationFrame` to
* avoid blocking the main thread.  Collapse/expand state is persisted
* through the same `security_acccess_<tipo>` key used by the editable tree.
*
* FILTERED TREE: same rule as `render_area_item` — when `self.filter_query` is
* set the branch renders eager and open, and no collapse state is touched.
*
* @param {Object} item - datalist current item
* @param {Array} datalist - list to build the tree FROM: the full ontology list, or
*   the filtered subset (matches + ancestors) while a filter is active
* @param {Array} value - full list of elements in self.data (DB) at key zero
*   (this component has only one value but format is array)
* @param {Object} self - component_security_access instance (also the source of
*   `selected_tipo`, the highlighted node, which the read view used to read from
*   the global scope)
* @returns {HTMLElement} li element with optional expando `.branch`
*/
const render_area_item_read = function(item, datalist, value, self) {

	// direct_children check and set
		const tipo					= item.tipo
		const section_tipo			= item.section_tipo
		const direct_children		= item.model==='section'
			? datalist.filter(el => el.section_tipo===tipo && el.tipo!==tipo)
			: datalist.filter(el => el.parent===tipo)
		const direct_children_length = direct_children.length
		const has_child_section		 = direct_children.find(el => el.tipo===el.section_tipo)

	// item_value. get the current item value
		const item_value	= value.find(el => el.section_tipo===section_tipo && el.tipo===tipo)
		const permissions	= item_value && item_value.value
			? parseInt(item_value.value)
			: 0

		const permissions_label = (permissions>=2)
			? 'rw-'
			: (permissions===1)
				? 'r--'
				: '---'

	// li DOM node
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'li_item'
		})

	// label
		const css_selectors = ['area_label']
			// add icon arrow when element has children. Not while filtering (no toggle)
			if (direct_children_length>0 && !self.filter_query) {
				css_selectors.push('icon_arrow')
			}
			// add selected when item matches a search (self.selected_tipo)
			if (item.tipo===self.selected_tipo) {
				css_selectors.push('selected')
			}
			// add when item has a child_section level
			if (has_child_section) {
				css_selectors.push('has_child_section')
			}
		const label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: css_selectors.join(' '),
			inner_html		: render_value(permissions_label + ' ' + item.label, 'text'),
			parent			: li
		})

	// with children case
		if (direct_children_length>0) {
			// branch (ul container for children)
				const branch = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'ul_item branch hide'
				})
				li.branch = branch

			// tree filter: branches open and EAGER (see the editable renderer)
				if (self.filter_query) {
					branch.classList.remove('hide')
					branch.appendChild(render_tree_items_read(
						direct_children,
						datalist,
						value,
						self
					)) // return li node
				}else{
					// track collapse toggle state of content
						const collapse = function() {
							label.classList.remove('up')
						}
						const expose = function() {
							label.classList.add('up')
							if (!branch.hasChildNodes()) {
								// direct_children render (return hierarchized children nodes)
								const callback = () => {
									const tree_node = render_tree_items_read(
										direct_children,
										datalist,
										value,
										self
									) // return li node
									branch.appendChild(tree_node)
								}
								window.requestAnimationFrame(callback);
							}
						}
						ui.collapse_toggle_track({
							toggler				: label,
							container			: branch,
							collapsed_id		: 'security_acccess_' + item.tipo,
							collapse_callback	: collapse,
							expose_callback		: expose,
							default_state		: 'closed'
						})
				}

			// add branch at last position
			li.appendChild(branch)
		}//end direct_children


	return li
}//end render_area_item_read



/**
* RENDER_PERMISSIONS_ITEM_READ
* Create tree item node to check permissions (components, section_groups, buttons, etc.)
*
* Read-only counterpart of `render_permissions_item`.  Produces a static `li`
* whose label carries the Unix-style permission prefix (`---`, `r--`, `rw-`)
* followed by the item's ontology label.  No radio buttons or event listeners
* are attached.
*
* An empty `.branch` expando is added when `datalist` contains a child node,
* ensuring the two-pass hierarchisation in `render_tree_items_read` can still
* relocate child nodes into this item correctly.
*
* @param {Object} item - datalist current item
* @param {Array} datalist - full list of section elements from ontology
* @param {Array} value - full list of elements in self.data (DB) at key zero
*   (this component has only one value but format is array)
* @returns {HTMLElement} li element with optional expando `.branch`
*/
const render_permissions_item_read = function(item, datalist, value) {

	// short vars
		const section_tipo			= item.section_tipo
		const tipo					= item.tipo
		const direct_children		= datalist.find(el => el.parent===tipo)

	// item_value (permissions). get the item value
		const item_value	= value.find(el => el.section_tipo===section_tipo && el.tipo===item.tipo)
		const permissions	= item_value && item_value.value
			? parseInt(item_value.value)
			: 0

	// li DOM node
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'li_item permissions'
		})

		const permissions_label = (permissions>=2)
			? 'rw-'
			: (permissions===1)
				? 'r--'
				: '---'

	// label
		const label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'area_label',
			inner_html		: render_value(permissions_label + ' ' + item.label, 'text'),
			parent			: li
		})

	// with children case
		if (direct_children) {
			// branch (ul container for children)
				const branch = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'ul_item branch',
					parent			: li
				})
				li.branch = branch
		}//end direct_children


	return li
}//end render_permissions_item_read



/**
* RENDER_CHANGES_FILES_SELECTOR
* Creates a select node with all changes files
*
* Builds the "Latest changes" section that appears above the permission tree.
* It contains:
*   - A `<label>` heading (localised via `get_label.latest_changes`).
*   - A `<select>` populated with one `<option>` per JSON change-log file on
*     disk, formatted as "DD/MM/YYYY HH:MM:SS" by `parse_filename`.
*   - A `changes_data_container` div that receives the rendered diff result
*     when the user picks a file from the selector.
*
* File name format expected: `simple_schema_changes_YYYY-MM-DD_HH-MM-SS.json`
* (the internal `parse_filename` closure strips the prefix and extension and
* reformats to `DD/MM/YYYY HH:MM:SS`).
*
* On `<select>` change:
*   1. Validates that a filename was selected; clears the container and logs
*      an error if none.
*   2. Shows a spinner inside `changes_data_container` via `ui.load_item_with_spinner`
*      while the API call `self.get_changes_data(filename)` is in-flight.
*   3. Renders the returned change data with `render_changes_data` and inserts
*      the result into `changes_data_container`.
*
* @param {Object} options - configuration bag
* @param {Object} options.self - component_security_access instance
* @param {Array} options.changes_files - ordered array of change-log file names
*   (most recent first); each entry is a string filename
* @param {HTMLElement} options.ul - the main tree `ul` element; passed through
*   to `render_changes_data` for tree re-rendering on section click
* @returns {HTMLElement} changes_container div encompassing the label, selector,
*   and the response container
*/
const render_changes_files_selector = function (options) {

	// simple_schema_changes_2024-03-26_20-44-22

	const self			= options.self
	const changes_files	= options.changes_files
	const ul			= options.ul

	// remove the extension and the fixed name and show the date and time in human way.
		const parse_filename = (filename) => {

			const file_base		= filename.replace('.json', '')
			const file_date		= file_base.replace('simple_schema_changes_', '')
			const ar_part		= file_date.split('_')
			const date			= ar_part[0].split('-')
			const time			= ar_part[1].replaceAll('-', ':')
			const name			= `${date[2]}/${date[1]}/${date[0]} ${time}`

			return name
		}

	// changes_container
		const changes_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'changes_container'
		})

		// changes_files_label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'changes_files_label',
			inner_html		: get_label.latest_changes || 'Latest changes',
			parent			: changes_container
		})

		// selector
		const changes_files_selector = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'changes_files_selector',
			parent			: changes_container
		})
		// event change
		const change_handler = (e) => {
			// filename check
				const filename = e.target.value
				if(!filename || filename===''){
					while (changes_data_container.firstChild) {
						changes_data_container.removeChild(changes_data_container.firstChild)
					}
					console.error('No file name provided:', e.target.value);
					return
				}

			ui.load_item_with_spinner({
				container	: changes_data_container,
				label		: get_label.changes || 'changes',
				callback	: async () => {
					// api call to read selected JSON file
					const changes_data = await self.get_changes_data(filename)
					// render result resulting a DocumentFragment
					const changes_data_node = render_changes_data({
						changes_data	: changes_data,
						self			: self,
						ul				: ul
					})

					return changes_data_node
				}
			})
		}
		changes_files_selector.addEventListener('change', change_handler)

		// empty option
		ui.create_dom_element({
			element_type	: 'option',
			inner_html		: '',
			value			: '',
			parent			: changes_files_selector
		})

		// options
		const changes_length = changes_files.length
		for (let i = 0; i < changes_length; i++) {

			const current_file	= changes_files[i]
			const name			= parse_filename(current_file)

			// option
			ui.create_dom_element({
				element_type	: 'option',
				inner_html		: render_value(name, 'text'),
				value			: current_file,
				parent			: changes_files_selector
			})
		}

	// api response container
		const changes_data_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'changes_data_container',
			parent			: changes_container
		})


	return changes_container
}//end render_changes_files_selector



/**
* RENDER_CHANGES_DATA
* Creates a data fragment node with all changes by section
* changes_data has:
* - parents: array with all parents. Used to show the path to the section, and open the nodes path into the tree
* - section: Object. main section that changed and need to review his permissions, it will be open to show all components
* - children: array with new children. Only informative nodes, no active, only show the additions of the section.
*
* Iterates over the `changes_data` array (one entry per modified section) and
* builds a visual change-log panel.  Each change entry renders:
*   - A breadcrumb path (`parents_labels`) showing the ancestry chain, with
*     the root `dd1` entry filtered out for readability.
*   - A clickable `section_label` div.  When clicked (`mouseup`):
*       1. Writes `false` to `data_manager.set_local_db_data` for every parent
*          and the section itself under the key `security_acccess_<tipo>`.
*          Setting these keys to `false` instructs `ui.collapse_toggle_track`
*          to restore the nodes as open on the next render.
*       2. Repaints the permission tree through `ul.paint` (owned by the tree
*          filter), which honours the stored open-state, shows the targeted
*          section with all its parent nodes expanded, and keeps an active
*          filter query and the filter box untouched.
*       3. Preserves the tree container height during the re-render to prevent
*          layout jump; clears `minHeight` after ~1.5 s via `setTimeout`.
*   - A `children_container` `ul` listing the newly added child ontology
*     elements (informational only — not interactive).
*
* (!) The `mouseup` event is used instead of `click` to ensure the handler
* fires even when the pointer moves slightly between press and release —
* intentional behaviour in the original code.
*
* @param {Object} options - configuration bag
* @param {Array} options.changes_data - array of change objects, each:
*   {parents: Array<{tipo, label}>, section: {tipo, label}, children: Array<{label}>}
* @param {Object} options.self - component_security_access instance
* @param {HTMLElement} options.ul - main `ul` node housing the permission tree;
*   its `.paint` clears and repopulates it when a section label is clicked
* @returns {DocumentFragment} fragment containing one `.change` div per entry
*   in `changes_data`
*/
const render_changes_data = function (options) {

	const changes_data	= options.changes_data
	const self			= options.self
	const ul			= options.ul

	const fragment = new DocumentFragment();

	const data_len = changes_data.length
	for (let i = 0; i < data_len; i++) {

		const current_section = changes_data[i]

		const change_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'change',
			parent			: fragment
		})

		// parents
		// remove the main ontology node 'dd1'
			const parents			= current_section.parents.filter(el => el.tipo !== 'dd1')
			const parents_labels	= parents.map(el => el.label).join(' > ')

			// parents_labels_container
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'parents_labels',
				inner_html		: render_value(parents_labels, 'text'),
				parent			: change_container
			})

		// section
			const section_label = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'section_label',
				inner_html		: render_value(current_section.section.label, 'text'),
				parent			: change_container
			})
			// when the user click into the section label active all parent nodes and the section
			// open all nodes and load the section to show all components.
			// this event show the tree as if the user had clicked on the path items (open the tree nodes)
			const mouseup_handler = async (e) => {
				e.stopPropagation()

				const section_tipo = current_section.section.tipo

				// fix
				self.selected_tipo = section_tipo

				change_container.classList.add('selected')

				// set the parents into local_db to mark it to be open
				for (let i = 0; i < parents.length; i++) {

					const current_parent = parents[i].tipo
					// add record to local DB
						const data = {
							id		: 'security_acccess_'+current_parent,
							value	: false
						}
						await data_manager.set_local_db_data(
							data,
							'status'
						)
				}
				// set the section tipo into local_db to mark it to be open
					await data_manager.set_local_db_data(
						{
							id		: 'security_acccess_'+section_tipo,
							value	: false
						},
						'status'
					)

				// get the size of the tree container and set as min height to maintain the changes container with his height
					const ul_size	= ul.getBoundingClientRect()
					const ul_height	= ul_size.height

					ul.style.minHeight = ul_height+'px'

				// repaint the tree. The filter owns the paint (it keeps the filter box
				// and honours an active query); when the render checks the nodes will be
				// open the parents and the section to show it
					ul.paint()

				// remove the min_heigth when the component was rendered (+/- 1.5seg)
					setTimeout(function() {
						ul.style.minHeight = ''
					}, 1500);
			}
			section_label.addEventListener('mouseup', mouseup_handler)

		// children
		// show the children additions
			const children_container = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'children_container',
				parent			: change_container
			})

			const children			= current_section.children
			const children_length	= children.length
			for (let i = 0; i < children_length; i++) {

				const current_child = children[i]

				// child_label
				ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'child_label',
					inner_html		: render_value(current_child.label, 'text'),
					parent			: children_container
				})
			}
	}//end for (let i = 0; i < data_len; i++)


	return fragment;
}//end render_changes_data



// @license-end
