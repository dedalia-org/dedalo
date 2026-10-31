// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, DEDALO_CORE_URL, SHOW_DEBUG, SHOW_DEVELOPER */
/*eslint no-undef: "error"*/



// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {
		clone
	} from '../../common/js/utils/index.js'



/**
 * RENDER_MENU_TREE
 * Builds and manages the hierarchical horizontal/vertical dropdown menu tree
 * rendered in the Dédalo application header.
 *
 * The menu data arrives from the server as a flat array (tree_datalist) where
 * each item carries a `parent` tipo reference. This module:
 *  - Pre-processes that flat list into a parent→children Map for O(1) child lookup.
 *  - Renders levels lazily: the first level is built eagerly; deeper levels are
 *    built on first hover/click so that large menus remain performant.
 *  - Manages three document-level event listeners (click, mousedown, keydown)
 *    that control the open/close state of the dropdown panels.
 *
 * Exports:
 *  - render_tree  — main entry point, called by view_default_edit_menu
 *  - navigate_to_menu_item — menu-click navigation, shared with the command palette
 *
 * Internal helpers (not exported):
 *  - render_level_hierarchy  — renders one UL level of the tree
 *  - render_item_hierarchy   — renders one LI+A item within a level
 *  - close_all_drop_menu     — collapses the entire menu to its initial state
 *  - close_all_children      — recursively collapses a subtree rooted at a given tipo
 *
 * The `self` object throughout is a `menu` instance (core/menu/js/menu.js).
 * Key properties written by this module:
 *  - self.items_by_parent {Map}  — parent tipo → Array of child item objects
 *  - self.rendered_levels {Set}  — set of tipo values whose UL has been built
 *  - self.base_menu_url   {string} — pathname snapshot used for URL construction
 *  - self.menu_active     {boolean} — true while any dropdown is open
 *  - self.li_nodes        {Array}  — flat registry of all created LI elements
 *  - self.ul_nodes        {Array}  — flat registry of all created UL elements
 */

// Token injected by the server into a label's HTML when the term is not
// available in the current language and a fallback language was used instead.
// The presence of this token causes the label to be styled in italic (class 'mark').
const LABEL_FALLBACK_TOKEN = '<mark>'

// Regex used to strip all HTML tags from a label string before inserting it
// as text content. The server may send labels that contain markup (e.g. <mark>).
const HTML_TAGS_REGEXP = /(<([^>]+)>)/ig



/**
 * RENDER_TREE
 * Main entry point for rendering the horizontal navigation menu tree.
 * Builds the parent→children lookup index, eagerly renders the first level,
 * and registers the three document-level event listeners that drive the
 * open/close/keyboard behaviour of all dropdown panels.
 *
 * This function writes several state properties directly onto `self` so that
 * the helper functions rendered later can share them without extra arguments:
 *  - self.items_by_parent {Map}   — pre-computed parent-tipo → children index
 *  - self.rendered_levels {Set}   — tracks which levels have been built (dedup guard)
 *  - self.base_menu_url   {string} — URL pathname captured at render time
 *  - self.menu_active     {boolean} — toggled by click/close handlers
 *
 * @param {Object}      options           - Configuration bag
 * @param {Object}      options.self      - The live `menu` instance (see menu.js).
 *                                          Must have self.li_nodes {Array} and
 *                                          self.ul_nodes {Array} already initialised.
 * @param {HTMLElement} options.container - Root wrapper element; the first-level UL
 *                                          is appended here and click events bubble to it.
 * @param {string}      options.tipo      - Ontology tipo of the menu root node (e.g. 'dd1').
 *                                          Children of this tipo form the top-level bar items.
 * @returns {boolean} Always true on success.
 */
export const render_tree = (options) => {

	// options
		const self		= options.self
		const container	= options.container
		const tipo		= options.tipo

	// datalist
		const data		= self.data || []
		const datalist	= data.tree_datalist || []

	// pre-process datalist for O(1) lookup
	// Building a Map here avoids O(n) linear scans every time a level is rendered.
	// The key is the parent tipo string; the value is the array of direct children.
		const items_by_parent = new Map()
		datalist.forEach(item => {
			if (!items_by_parent.has(item.parent)) {
				items_by_parent.set(item.parent, [])
			}
			items_by_parent.get(item.parent).push(item)
		})
		self.items_by_parent = items_by_parent
		self.rendered_levels = new Set()
		// Snapshot the pathname so all item hrefs are consistent even if the
		// URL changes via pushState before the user clicks an item.
		self.base_menu_url = window.location.pathname

	// render
	// Eagerly build only the first (top) level; deeper levels are built lazily
	// on first hover inside render_item_hierarchy's mouseenter handler.
		render_level_hierarchy({
			self			: self,
			datalist		: datalist,
			root_ul			: container,
			current_tipo	: tipo,
			parent_tipo		: tipo
		})

	// click . Manages global click action on the menu items
	// This handler lives on the container (event delegation) rather than on each LI
	// so that lazily-added items are captured without re-binding.
		const click_handler = (e) => {

			// first menu items only (when the UL is the main menu)

			// close all menu items when the menu change to inactive
			if (self.menu_active===true) {

				close_all_drop_menu(self);
				self.menu_active = false

			}else{
				// close_all_drop_menu(self);
				// get the main li nodes
				const main_li	= e.target.parentNode
				// get the main ul nodes
				const open_id =  main_li.dataset.children
				if (open_id) {
					// Lazy-build the children UL if it hasn't been rendered yet
					// (can happen on touch/click devices that skip mouseenter).
					let open_ul = document.getElementById(open_id)
					if (!open_ul) {
						render_level_hierarchy({
							self			: self,
							datalist	: datalist,
							root_ul		: container,
							current_tipo	: open_id,
							parent_tipo	: tipo
						})
						open_ul = document.getElementById(open_id)
					}
					// set the css visibility for the ul
					if (open_ul) {
						open_ul.classList.remove('menu_ul_hidden');
						open_ul.classList.add('menu_ul_displayed');
						// moves the ul to the left position of the parent li
						open_ul.style.left = (main_li.getBoundingClientRect().left+'px')
					}
				}

				// Walk the full li_nodes registry in reverse so large menus still
				// process in roughly display order while avoiding splice costs.
				const nodes_li	= self.li_nodes
				const nodes_li_length	= nodes_li.length
				for (let i = nodes_li_length - 1; i >= 0; i--) {
					// inactive all li nodes
					nodes_li[i].classList.add('menu_li_inactive');
					nodes_li[i].classList.remove('menu_li_active');

					// active only the selected li node
					if(nodes_li[i] == main_li) {
						nodes_li[i].classList.add('menu_li_active');
						nodes_li[i].classList.remove('menu_li_inactive');
					}
				}
				self.menu_active = true
			}// end if (self.menu_active===true)
		}
		container.addEventListener('click', click_handler)

	// mousedown. document. do global click action on the document body
	// Attached to `document` (not the container) so clicks anywhere outside
	// the menu — including the page body — trigger a full collapse.
		const mousedown_handler = (e) => {
			e.stopPropagation()
			// if the menu is inactive nothing to do
			if(self.menu_active===false) {
				return false
			}
			// if the user do click in other node than 'a' node, close all nodes, no other action to do
			// Clicks on <a> elements are handled by click_handler and navigate;
			// any other node (div, body, etc.) should close the menu.
			if (e.target.tagName.toLowerCase()!=='a') {
				close_all_drop_menu(self)
			}
		}
		document.addEventListener('mousedown', mousedown_handler)

	// keydown. set the escape key to close al menu nodes
		const keydown_event = (e) => {
			if(self.menu_active===false) {
				return false
			}
			if (e.key==='Escape') {
				close_all_drop_menu(self);
			}
		}
		document.addEventListener('keydown', keydown_event)

	// `document` is a PERMANENT root: a listener it holds keeps `self` and the whole
	// menu tree alive for the life of the page, and every rebuilt menu adds another
	// one that still runs. Hand the removers to the instance, which is what gets
	// destroyed. Re-rendering releases the previous pair first, so a rebuild
	// replaces the listeners instead of stacking them.
		if (typeof self.release_document_events==='function') {
			self.release_document_events()
		}
		self.release_document_events = () => {
			document.removeEventListener('mousedown', mousedown_handler)
			document.removeEventListener('keydown', keydown_event)
			self.release_document_events = null
		}


	return true
}//end render_tree



/**
 * RENDER_LEVEL_HIERARCHY
 * Builds one UL element containing all direct children of `current_tipo` and
 * appends it to `root_ul`. Items within the level are batched through a
 * DocumentFragment so only a single DOM reflow is needed per level.
 *
 * This function is idempotent: if the level has already been rendered
 * (tracked via self.rendered_levels) it returns immediately without rebuilding,
 * which prevents duplicate UL/LI nodes when hover and click handlers both
 * attempt lazy rendering of the same level concurrently.
 *
 * The UL is given `id === current_tipo` so that event handlers can retrieve
 * it with document.getElementById(tipo) without keeping extra references.
 *
 * @param {Object}      options                  - Configuration bag
 * @param {Object}      options.self             - The live `menu` instance.
 * @param {Array}       options.datalist         - Full flat list of all menu items
 *                                                 (passed through to render_item_hierarchy).
 * @param {HTMLElement} options.root_ul          - Container element to which the new UL
 *                                                 is appended (the menu wrapper div for the
 *                                                 top level, or the same container for sub-levels).
 * @param {string}      options.current_tipo     - Tipo of the node whose children should be
 *                                                 rendered (becomes the UL's DOM id).
 * @param {string}      [options.parent_tipo]    - Tipo of the grandparent level; used by
 *                                                 callers for context but not consumed here.
 * @returns {boolean} Always true (even when the level was already rendered).
 */
const render_level_hierarchy = (options) => {

	// options
		const self			= options.self
		const datalist		= options.datalist
		const root_ul		= options.root_ul
		const current_tipo	= options.current_tipo
		// Initialise the Set defensively in case render_tree hasn't run yet
		// (e.g. unit tests or direct calls to this helper).
		const rendered_levels = self.rendered_levels || (self.rendered_levels = new Set())

	// Idempotency guard: skip if already rendered to avoid duplicate DOM nodes.
	if (rendered_levels.has(current_tipo)) {
		return true
	}

	// ul container
	// The UL id equals current_tipo so event handlers can look it up via getElementById.
		const ul = ui.create_dom_element({
			element_type	: 'ul',
			id				: current_tipo
		})

	// store in the instance the new ul node
		self.ul_nodes.push(ul)

	// values (li nodes dependents of the ul)
	// Use the pre-built Map for O(1) child lookup instead of filtering datalist.
		const root_areas		= self.items_by_parent.get(current_tipo) || []
		const root_areas_length	= root_areas.length
		const level_fragment		= document.createDocumentFragment()
		for (let i = 0; i < root_areas_length; i++) {
			// create the li and a nodes inside the current ul
			const li = render_item_hierarchy({
				self			: self,
				datalist		: datalist,
				root_ul			: root_ul,
				ul_container	: ul,
				item			: root_areas[i],
				current_tipo	: current_tipo
			})
			if (li) {
				level_fragment.appendChild(li)
			}
		}

	// Flush the fragment in one shot before appending to root_ul so that
	// sub-level ULs (which are appended to root_ul too) don't interleave.
	ul.appendChild(level_fragment)
	root_ul.appendChild(ul)
	rendered_levels.add(current_tipo)

	return true
}//end render_level_hierarchy



/**
 * RENDER_ITEM_HIERARCHY
 * Renders a single menu item as an LI element containing an A anchor and wires
 * up all interaction events (mouseenter for submenu reveal, mouseleave for
 * collapse, click for SPA navigation or new-tab opening).
 *
 * Label handling:
 *  - The server may wrap a fallback-language label in `<mark>…</mark>` tags.
 *    These are stripped before DOM insertion and the CSS class 'mark' is added
 *    to the anchor so the label is italicised to signal the fallback.
 *
 * Navigation:
 *  - Normal click  → publishes 'user_navigation' via event_manager (SPA navigation).
 *  - Alt+click     → opens the URL in a new browser tab.
 *  - page_error     → falls back to a full page reload to clear stale state.
 *  - swap_tipo     → items may carry config.swap_tipo to redirect to a different
 *                    ontology node than the one listed (e.g. a proxy area).
 *
 * Submenu reveal:
 *  - On mouseenter, if the item has children and those children have not yet been
 *    rendered (dataset.childrenLoaded !== '1'), render_level_hierarchy is called
 *    lazily before positioning and showing the child UL.
 *  - Positioning is viewport-aware: if the child UL would extend below the visible
 *    area it is shifted upward by the overflow amount.
 *  - First-level items (whose parent UL id === 'dd1') open their submenu directly
 *    below; deeper items open to the right.
 *
 * @param {Object}      options                  - Configuration bag
 * @param {Object}      options.self             - The live `menu` instance.
 * @param {Array}       options.datalist         - Full flat datalist (forwarded to lazy
 *                                                 render_level_hierarchy calls).
 * @param {HTMLElement} options.ul_container     - The UL that will be the direct parent
 *                                                 of the new LI (used to query siblings).
 * @param {HTMLElement} options.root_ul          - The outermost menu wrapper; used for
 *                                                 viewport-relative positioning of sub-ULs.
 * @param {Object}      options.item             - Server-supplied menu item descriptor.
 * @param {string}      options.item.tipo        - Ontology tipo of this item.
 * @param {string}      options.item.label       - Display label (may contain HTML tags).
 * @param {string}      options.item.model       - Component model name (e.g. 'menu').
 * @param {Object}      [options.item.config]    - Optional config; may carry swap_tipo.
 * @param {string}      options.current_tipo     - Tipo of the parent UL (used when
 *                                                 lazily rendering the child level).
 * @returns {HTMLElement} The newly created LI element.
 */
const render_item_hierarchy = (options) => {

	// options
		const self			= options.self
		const datalist		= options.datalist
		const ul_container	= options.ul_container
		const root_ul		= options.root_ul
		const item			= options.item
		const current_tipo	= options.current_tipo

	// item label check
	// Guard against malformed server data; fall back to tipo so the item is
	// still visible rather than silently invisible.
		if (!item.label) {
			console.error('item without label:', item);
			item.label = item.tipo || 'Unknown'
		}

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'menu_li_inactive'
		})
		// append to li_nodes
		self.li_nodes.push(li)

	// events
		// mouseenter
			const mouseenter_handler = (e) => {

				if(self.menu_active===false) {
					return false
				}

				// get current node mouse is over (the li itself)
				const active_li = e.currentTarget
				// get immediate siblings inside ul
				const siblings = ul_container.children
				for (let i = 0, len = siblings.length; i < len; i++) {
					const node_li = siblings[i]
					if (node_li === active_li) {
						node_li.classList.add('menu_li_active')
						node_li.classList.remove('menu_li_inactive')
						continue
					}

					// inactive sibling nodes
					node_li.classList.add('menu_li_inactive')
					node_li.classList.remove('menu_li_active')

					// close all ul nodes dependent of this sibling li
					// This ensures that when the user moves horizontally across
					// top-level items, any previously-open subtrees collapse.
					const close_id = node_li.dataset.children
					if (close_id) {
						close_all_children(close_id)
					}
				}

				const open_id = active_li.dataset.children
				if (!open_id) {
					// Leaf item — no submenu to open.
					return true
				}

				// Lazy-render the child level on first hover.
				// dataset.childrenLoaded is a string '0'/'1' (HTML data attributes are always strings).
				if (active_li.dataset.childrenLoaded !== '1') {
					render_level_hierarchy({
						self			: self,
						datalist	: datalist,
						root_ul		: root_ul,
						current_tipo	: open_id,
						parent_tipo	: current_tipo
					})
					active_li.dataset.childrenLoaded = '1'
				}

				const open_ul = document.getElementById(open_id)
				if (!open_ul) {
					return true
				}

				const active_rect = active_li.getBoundingClientRect()
				// Detect whether this is a top-level (horizontal bar) item.
				// Top-level items live in a UL whose id is the menu root tipo ('dd1').
				const is_first_level = active_li.parentNode.id === 'dd1'

				open_ul.classList.remove('menu_ul_hidden')
				open_ul.classList.add('menu_ul_displayed')

				if (is_first_level) {
					// Drop-down: align the left edge of the submenu with the LI.
					// The -1px compensates for the LI border so panels line up precisely.
					open_ul.style.left = (active_rect.left - 1) + 'px'
					return true
				}

				// Fly-out (nested level): position the submenu to the right of the LI
				// and vertically aligned with it, clamped to the viewport bottom.
				const root_rect = root_ul.getBoundingClientRect()
				const top_position = Math.ceil(active_rect.top - root_rect.top)
				let final_top = top_position
				const ul_rect = open_ul.getBoundingClientRect()
				// Positive ul_bottom_dif means the panel overflows the viewport bottom.
				const ul_bottom_dif = ul_rect.bottom - window.innerHeight
				if (ul_bottom_dif>0) {
					// Shift upward by the overflow amount so no item is clipped.
					final_top = top_position - ul_bottom_dif
				}

				open_ul.style.top = final_top + 'px'
				open_ul.style.left = active_rect.right + 'px'
			}
			li.addEventListener('mouseenter', mouseenter_handler)

		// mouseleave
		// Only collapse when the pointer leaves toward the page body (clientY < 0 means
		// the cursor exited the viewport top) or returns to the menu_wrapper element,
		// which means the user has abandoned the menu entirely.
			const mouseleave_handler = (e) => {
				const related_target = e.relatedTarget
				if (e.clientY<0 || related_target?.id==='menu_wrapper') {
					close_all_drop_menu(self);
				}
			}
			li.addEventListener('mouseleave', mouseleave_handler)

		// remove the html <mark> sent by the server
		// when the label is not in the current language
		// and get the label with fallback
		// and replace it for italic style
		// If the server wrapped the label in <mark> tags, strip the HTML for safe
		// DOM insertion and set text_fallback='mark' to apply the fallback CSS class.
			const has_html		= item.label.indexOf('<')!==-1
			const is_fallback	= item.label.indexOf(LABEL_FALLBACK_TOKEN)!==-1
			const text_fallback	= is_fallback ? 'mark' : ''
			const label_text	= has_html ? item.label.replace(HTML_TAGS_REGEXP,"") : item.label

		// url
		// Build the canonical href for this item. base_menu_url is captured at
		// render_tree time to avoid reading window.location on every click.
			const base_url	= self.base_menu_url || window.location.pathname
			const url		= `${base_url}?tipo=${item.tipo}&mode=list`

		// a element with the link to the area or section to go
			const link = ui.create_dom_element({
				element_type	: 'a',
				href			: url,
				class_name		: 'area_label ' + text_fallback,
				inner_html		: label_text,
				parent			: li
			})

		// click
		// when the user do click publish the tipo to go and set the mode in list
		// the action can be executed mainly in page, but it can be used for any instance.
			const click_handler = async (e) => {
				e.preventDefault()

				// nonactive menu case
					if (self.menu_active===false) {
						return false
					}

				navigate_to_menu_item(item, url, e.altKey===true)
			}
			link.addEventListener('click', click_handler)

	// children_item. recursive generation of children nodes of the current li node.
	// Mark LI nodes that have children with 'has-sub' and a data attribute so that
	// event handlers can find and lazily build their child ULs on demand.
		const has_children = self.items_by_parent.has(item.tipo)
		if (has_children) {

			li.classList.add ('has-sub')
			li.dataset.children	= item.tipo
			li.dataset.childrenLoaded = '0'
		}//end has_children

	return li
}//end render_item_hierarchy



/**
 * NAVIGATE_TO_MENU_ITEM
 * Goes to a menu datalist item exactly as a menu click does. Shared by the menu
 * tree and the command palette (core/common/js/command_palette.js).
 *
 * @param {Object}  item - tree_datalist entry ({tipo, model, config?})
 * @param {string}  url - canonical href (used for new tab / page_error reload)
 * @param {boolean} [new_tab=false]
 * @returns {void}
 */
export const navigate_to_menu_item = (item, url, new_tab=false) => {

	// safe_item. Clone menu item before use it
	// (!) Clone item to prevent the swap_tipo mutation below from
	// permanently altering the shared datalist entry across navigations.
		const safe_item = clone(item)

	// swap_tipo
	// Some menu items are proxies: they appear under one tipo but
	// should navigate to a different section defined by swap_tipo.
		if (safe_item.config && safe_item.config.swap_tipo) {
			safe_item.tipo = safe_item.config.swap_tipo
		}

	// page error case. On an existing page-level failure, force a reload
	// to refresh the page instance: a hard reload is safer than SPA
	// navigation over a broken page state.
		if (page_globals.page_error) {
			window.location.href = url
			return
		}

	if (new_tab) {
		// open in new tab
		const win = window.open(url, '_blank');
			  win.focus();
	}else{

		// navigate
		// Publish 'user_navigation' so that the page instance (and any
		// other subscribers) can load the target section without a full reload.
		event_manager.publish('user_navigation', {
			source : {
				tipo	: safe_item.tipo,
				model	: safe_item.model,
				mode	: 'list',
				// this config comes from properties (used by section_tool to define the config of the section that its called)
				config	: safe_item.config || null
			}
		})
	}
}//end navigate_to_menu_item



/**
 * CLOSE_ALL_DROP_MENU
 * Resets the entire menu tree to its initial collapsed state by hiding every
 * UL panel and deactivating every LI node registered on `self`.
 *
 * This is the authoritative full-collapse path. It is called:
 *  - When the user clicks while a menu is already open (toggle close).
 *  - When a mousedown event fires on any non-anchor element outside the menu.
 *  - When the Escape key is pressed.
 *  - When a LI's mouseleave fires toward the page body or the menu_wrapper.
 *
 * Both loops iterate in reverse so that in potential future scenarios where
 * nodes are spliced from the arrays during iteration the indices remain stable.
 *
 * @param {Object}  self           - The live `menu` instance.
 * @param {Array}   self.ul_nodes  - All UL elements created by render_level_hierarchy.
 * @param {Array}   self.li_nodes  - All LI elements created by render_item_hierarchy.
 * @returns {void}
 */
const close_all_drop_menu = function(self) {

	self.menu_active = false

	// close all ul nodes stored in the menu instance
	if (typeof self.ul_nodes!=='undefined') {

		const len = self.ul_nodes.length
		for (let i = len - 1; i >= 0; i--) {
			const ul = self.ul_nodes[i]
				  ul.classList.add('menu_ul_hidden');
				  ul.classList.remove('menu_ul_displayed');
		}
	}
	// close all li nodes stored in the menu instance
	if (typeof self.li_nodes!=='undefined') {

		const len = self.li_nodes.length
		for (let i = len - 1; i >= 0; i--) {
			const li = self.li_nodes[i]
				  li.classList.add('menu_li_inactive');
				  li.classList.remove('menu_li_active');
		}
	}
}//end close_all_drop_menu



/**
 * CLOSE_ALL_CHILDREN
 * Recursively hides the UL panel rooted at `tipo` and then walks its LI
 * children to collapse any further nested submenus.
 *
 * Unlike close_all_drop_menu (which iterates flat registries), this function
 * traverses the live DOM tree from a given starting tipo downward. It is used
 * by the mouseenter handler to collapse sibling subtrees when the user moves
 * the pointer to a different item within the same level.
 *
 * The function is safe to call with a tipo that has no rendered UL: it returns
 * early without side effects if getElementById returns null, which happens for
 * levels that were never lazily built.
 *
 * @param {string} tipo - Ontology tipo of the menu item whose subtree should be
 *                        collapsed. Must equal the DOM id of the target UL.
 * @returns {void}
 */
const close_all_children = function(tipo) {

	// get the children nodes of the sent tipo and add/remove the css
	// The UL may not exist yet if the subtree was never hovered (lazy rendering).
	const close_ul = document.getElementById(tipo)
	if (!close_ul) {
		return
	}
	close_ul.classList.remove('menu_ul_displayed');
	close_ul.classList.add('menu_ul_hidden');

	// get the child nodes of the current ul
	const ar_children_nodes	= Array.from(close_ul.children)
	ar_children_nodes.forEach(child => {
		// get the children link node of the current li
		const new_tipo = child.dataset.children
		// recursive action of the current children ul tipo
		// Each LI that has a data-children attribute is itself the root of a
		// sub-level; recurse to ensure deeply nested panels are collapsed too.
		if (new_tipo) {
			close_all_children(new_tipo)
		}
	})
}//end close_all_children



// @license-end
