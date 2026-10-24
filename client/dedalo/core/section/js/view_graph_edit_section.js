// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* VIEW_GRAPH_EDIT_SECTION
* Interactive D3 force-directed graph view for a section record in edit mode.
*
* Responsibilities:
* - Renders the graph canvas (SVG) and a side-by-side node detail panel.
* - Builds an initial graph from the datum already present on the client (no
*   extra API call) via `datum_to_graph`, then lazily expands each node's
*   outgoing relations on first click via `fetch_node_relations`.
* - Supports reverse-relation discovery (records that *point to* the current
*   record) through an optional `relation_list_tipo` configured on the section;
*   batch-loaded in pages of INVERSE_BATCH via `fetch_inverse_relations`.
* - Uses D3 v7 (UMD bundle at `lib/d3`). The bundle populates
*   `globalThis.d3` rather than named ESM exports, so it is loaded via a
*   dynamic `import()` and read from `globalThis.d3` immediately after.
* - Provides a toolbar with a hint label and a close button (back to the form).
* - All label text is resolved through `get_label` i18n lookups with hard-coded
*   English fallbacks so the UI is functional even when translation data is absent.
*
* Main export:
*   view_graph_edit_section        — inert constructor (namespace only)
*   view_graph_edit_section.render — async entry-point called by the section renderer
*
* Internal helpers (module-private):
*   get_toolbar               — builds the toolbar DOM, wires the close button
*   switch_view               — programmatic view transition (graph ↔ default)
*   get_content_data          — creates graph canvas + detail panel; defers D3 mount until in DOM
*   render_detail_placeholder — the panel's empty state (invitation + graph legend)
*   build_graph               — creates the full D3 simulation and all interaction handlers
*
* Detail panel states (see `.node_detail` in view_graph_section.less):
*   placeholder — nothing selected: invitation + legend decoding the visual grammar
*   detail      — a node is selected: sticky identity header + scrolling field list
*   hidden      — the user closed the panel (`content_data.detail_hidden`); the canvas
*                 takes the full width and clicking any node brings the panel back
*/



// imports
	import {dd_request_idle_callback, when_in_dom} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {open_window, object_to_url_vars} from '../../common/js/utils/index.js'
	import {
		datum_to_graph,
		fetch_node_relations,
		fetch_section_datum,
		fetch_inverse_relations,
		fetch_section_terms,
		apply_section_terms,
		build_model_map,
		build_section_maps,
		extract_node_fields,
		upgrade_fallback_labels,
		resolve_label
	} from './build_graph_data.js'



/**
* VIEW_GRAPH_EDIT_SECTION
* Namespace / constructor for the graph edit-mode view.
* Holds only static method properties; the function itself is inert.
*/
export const view_graph_edit_section = function() {

	return true
}//end view_graph_edit_section



/**
* RENDER
* Entry-point called by the section render pipeline.
* Builds the full wrapper (toolbar + graph canvas) for 'full' render_level, or
* returns only the graph canvas for 'content' render_level (used by the pagination
* and filter refresh paths that reuse the outer chrome).
*
* Side effects:
* - Attaches `wrapper.content_data` as a direct property so callers can reach the
*   canvas without querying the DOM.
* - Stores `self.inverse_controls` so `build_graph` (which runs asynchronously
*   later, once the canvas is in the DOM) can wire the inverse-relations checkbox
*   and "load more" button after they are created here.
*
* @param {Object} self    - Section instance. Must supply at minimum `self.id`,
*   `self.type`, `self.model`, `self.section_tipo`, `self.tipo`, `self.mode`,
*   `self.view`, and optionally `self.context.config.relation_list_tipo`.
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - 'full' (outer chrome + canvas)
*   or 'content' (canvas only).
* @returns {Promise<HTMLElement>} The wrapper `<section>` element for 'full', or
*   the `content_data` `<div>` for 'content'.
*/
view_graph_edit_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data (graph canvas)
		const content_data = get_content_data(self)

		if (render_level === 'content') {
			return content_data
		}

	// fragment
		const fragment = new DocumentFragment()

	// toolbar
		const { toolbar, inverse_controls } = get_toolbar(self)
		fragment.appendChild(toolbar)

	// content_data append
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

	// store inverse_controls on self for build_graph to access
		self.inverse_controls = inverse_controls


	return wrapper
}//end render



/**
* GET_TOOLBAR
* Build the graph toolbar DOM and create the inverse-relation UI controls.
*
* The toolbar contains, in DOM (= tab) order:
* - A hint label explaining click / Ctrl+click behavior.
* - Optionally, a checkbox and "load more" button for inverse relations; these are
*   only rendered when `self.context.config.relation_list_tipo` is set (i.e. the
*   section has a relation_list component configured to resolve callers).
* - A close button, pushed to the far right, that leaves the graph and switches
*   the section view back to 'default' (the form).
*
* The returned `inverse_controls` object is a shared mutable reference holder
* whose `.checkbox` and `.more_button` properties are set during this call and
* later read by `build_graph` to wire their event listeners. Returning it as a
* plain object (rather than accessing DOM by id) avoids repeated querySelector
* calls and keeps the wiring self-contained in `build_graph`.
*
* @param {Object} self - Section instance. Reads `self.id` for the checkbox id
*   and `self.context.config.relation_list_tipo` to decide whether to render
*   the inverse-relations controls.
* @returns {{toolbar: HTMLElement, inverse_controls: Object}} The toolbar element
*   and a reference holder `{ checkbox?: HTMLElement, more_button?: HTMLElement }`.
*/
const get_toolbar = function(self) {

	const toolbar = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'graph_toolbar'
	})

	// hint
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'graph_hint',
			inner_html		: get_label.graph_hint || 'Click a node to expand or collapse its relations. Ctrl/Cmd + click opens the record.',
			parent			: toolbar
		})

	// inverse relations toggle
		const has_relation_list_tipo = !!self?.context?.config?.relation_list_tipo

		const inverse_controls = {}

		if (has_relation_list_tipo) {
			const checkbox_id = 'inverse_relations_' + self.id

			const checkbox_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'graph_inverse_label',
				parent			: toolbar
			})
			inverse_controls.checkbox = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				id				: checkbox_id,
				class_name		: 'graph_inverse_checkbox',
				parent			: checkbox_label
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'graph_inverse_label_text',
				inner_html		: get_label.reverse_relations || 'Reverse relations',
				parent			: checkbox_label
			})

			inverse_controls.more_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light graph_inverse_more',
				inner_html		: '',
				style			: { display: 'none' },
				parent			: toolbar
			})
		}

	// close the graph (back to the form). Last in the DOM so tab order matches
	// the visual order; CSS pushes it to the far right of the toolbar
		const close_button = get_close_button(get_label.close || 'Close')
		toolbar.appendChild(close_button)
		close_button.addEventListener('click', async (e) => {
			e.stopPropagation()
			await switch_view(self, 'default')
		})

	return { toolbar, inverse_controls }
}//end get_toolbar



/**
* GET_CLOSE_BUTTON
* Build a close control: a padded `<button>` hit target wrapping the icon glyph.
*
* Two reasons it is not the bare `<span class="button close">` used elsewhere:
* - **Hit area.** `.button` masks the icon onto the element itself, so the element
*   IS the glyph — padding would only scale the drawing. Wrapping it in a real
*   button gives a comfortable target around a small icon (the inner span is
*   `pointer-events: none` in CSS, so the padded button owns every click).
* - **Keyboard.** A real `<button>` is focusable and fires on Enter/Space for free.
*
* The tooltip is registered here with `placement: 'left'` because both call sites
* pin the button to a top-right corner, where the default top tooltip is drawn over
* the app chrome above and clipped by the viewport on the right. Registering now
* also claims the element: the section's blanket `activate_tooltips(wrapper)` pass
* skips it later, since `active_tooltip` is already set.
*
* @param {string} title - Tooltip text, also used as the accessible name.
* @returns {HTMLElement} The `<button>`; the caller wires the click handler.
*/
const get_close_button = function(title) {

	const close_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'graph_close_button'
	})
	close_button.title = title
	close_button.setAttribute('aria-label', title)

	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button close',
		parent			: close_button
	})

	ui.activate_tooltips(close_button, null, false, 'left')


	return close_button
}//end get_close_button



/**
* SWITCH_VIEW
* Transition the section to a different view without an extra data fetch.
*
* Updates `self.view` (and `self.context.view` if context is present) before
* calling `self.refresh`. Passing `build_autoload: false` tells the section
* refresh pipeline to reuse the already-loaded datum instead of issuing a new
* server read — critical for an instantaneous feel when the user clicks "back
* to form" from the graph.
*
* @param {Object} self - Section instance with a `refresh()` method.
* @param {string} view - Target view identifier, e.g. `'default'` or `'graph'`.
* @returns {Promise<*>} Result of `self.refresh(...)`.
*/
const switch_view = async function(self, view) {

	self.view = view
	if (self.context) {
		self.context.view = view
	}

	return self.refresh({
		build_autoload	: false,
		render_level	: 'full'
	})
}//end switch_view



/**
* GET_CONTENT_DATA
* Create the graph canvas container and the node detail panel, and schedule
* D3 initialization once the canvas element reaches the DOM.
*
* The D3 graph is not mounted synchronously here because the wrapper element is
* not yet attached to the document at this point. Instead, `when_in_dom` installs
* a MutationObserver/IntersectionObserver callback; once the element is visible,
* `dd_request_idle_callback` defers `build_graph` to the next idle period so the
* page paint is not blocked.
*
* When `self.section_id` is falsy (new/unsaved record), a placeholder message is
* returned immediately and no graph is attempted.
*
* @param {Object} self - Section instance. Reads `self.section_id` and `self.mode`.
* @returns {HTMLElement} The `content_data` container div. In the non-empty case it
*   also carries a `node_detail` property pointing to the detail panel child.
*/
const get_content_data = function(self) {

	const content_data = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'content_data ' + self.mode
	})

	// empty record case (new / unsaved)
		if (!self.section_id) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'graph_empty',
				inner_html		: get_label.no_data || 'No record to display',
				parent			: content_data
			})
			return content_data
		}

	// graph canvas (left)
		const graph_canvas = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'graph_canvas',
			parent			: content_data
		})

	// node detail panel (right)
		const node_detail = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'node_detail',
			parent			: content_data
		})
		content_data.node_detail = node_detail
		// empty state from the first paint: the panel is never a blank slab
		render_detail_placeholder(node_detail)

	// mount d3 when in DOM
		when_in_dom(graph_canvas, () => {
			dd_request_idle_callback(async () => {
				try {
					await build_graph(self, graph_canvas, node_detail)
				} catch (error) {
					console.error('[view_graph_edit_section] build_graph error:', error)
				}
			})
		})


	return content_data
}//end get_content_data



/**
* RENDER_DETAIL_PLACEHOLDER
* Fill the detail panel with its empty state.
*
* Two jobs, in this order:
* 1. An invitation — the panel says what to do to fill it instead of sitting blank.
* 2. A legend that decodes the graph's visual grammar (ring colour = expand state,
*    line style = relation direction). The graph encodes all of this and never
*    explains it, so the legend lives exactly where the user has nothing else to
*    read, and is replaced by the record data as soon as a node is selected.
*
* The legend marks are pure CSS (`.graph_legend_mark`), so they always match the
* SVG rules defined next to them in `view_graph_section.less`.
*
* @param {HTMLElement} node_detail - The detail panel container (emptied first).
*/
const render_detail_placeholder = function(node_detail) {

	node_detail.innerHTML = ''

	const placeholder = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'node_detail_placeholder',
		parent			: node_detail
	})

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'node_detail_placeholder_title',
		inner_html		: get_label.graph_no_selection || 'Click a node to see its record',
		parent			: placeholder
	})

	// legend (node states first, then link styles)
		const legend = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'graph_legend',
			parent			: placeholder
		})

		const legend_items = [
			{ mark : 'node is_root',	text : get_label.current_record || 'Current record' },
			{ mark : 'node expandable',	text : get_label.graph_legend_expand || 'Click to expand' },
			{ mark : 'node expanded',	text : get_label.graph_legend_expanded || 'Expanded · click to collapse' },
			{ mark : 'link',			text : get_label.graph_legend_relation || 'Relation' },
			{ mark : 'link inverse',	text : get_label.graph_legend_reverse || 'Reverse relation' }
		]

		const legend_items_len = legend_items.length
		for (let i = 0; i < legend_items_len; i++) {
			const item = legend_items[i]
			const row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'graph_legend_item',
				parent			: legend
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'graph_legend_mark ' + item.mark,
				parent			: row
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'graph_legend_text',
				text_content	: item.text,
				parent			: row
			})
		}
}//end render_detail_placeholder



/**
* BUILD_GRAPH
* Initialize the D3 force simulation, populate the initial graph from the
* client datum, and wire all user interactions.
*
* This function is the core of the graph view and runs once, asynchronously,
* after the canvas element is in the DOM. It is responsible for:
*
* 1. Lazy-loading the D3 UMD bundle (only on first graph view activation).
*    The bundle populates `globalThis.d3`; the local `d3` variable is a
*    direct reference to that global immediately after `import()` resolves.
*    Adding/removing the CSS class `loading` on `self.node` (if present)
*    gives the user visual feedback during the bundle download.
*
* 2. Building the initial `graph = { nodes, links }` data structure from
*    `datum_to_graph(self)`. The accumulator `section_maps` is seeded at the
*    same time and grows as more datums are fetched during expansion.
*
* 3. Label resolution strategy (executed once and then after each expansion):
*    a. `fetch_section_terms` sends a single batch API request for all nodes
*       and updates labels that the section_map can authoratively resolve.
*    b. `upgrade_fallback_labels` covers nodes whose sections have no map —
*       it fetches their datum individually but only when a label is still a
*       placeholder (`section_tipo · section_id`).
*    Both steps run in `.then()` so they don't block the first paint.
*
* 4. Creating the SVG with a zoom layer, two rendering layers (links and
*    nodes), the force simulation, and the drag behavior.
*
* 5. Wiring event handlers:
*    - `node_clicked` — single click selects + shows detail; second click on
*      same node expands (lazy fetch) or collapses. Ctrl/Cmd+click opens the
*      record in a new browser window.
*    - Inverse-relation checkbox / "load more" button (forwarded from
*      `self.inverse_controls`).
*    - Canvas background click deselects the current node.
*    - Window resize updates the SVG viewBox and re-centers the simulation.
*
* Graph node shape: `{ id, section_tipo, section_id, label, is_root, expanded, loaded }`
* Graph link shape: `{ source, target, parent_id, relation_tipo, relation_label [, is_inverse] }`
* See `build_graph_data.js` for the authoritative schema and factory functions.
*
* Re-entrancy / concurrency:
* - `processing` is a `Set` of node ids (or the string `'inverse'`) that are
*   currently being fetched. Any click on a node in `processing` is dropped
*   silently to prevent duplicate expansion requests.
*
* Inverse-relation pagination:
* - `INVERSE_BATCH` is the page size (50). `inverse_loaded` tracks how many
*   have been fetched so far; `inverse_total` is the server-side count.
*   When `inverse_loaded < inverse_total` the "load more" button is visible.
*
* @param {Object}      self         - Section instance in edit mode.
* @param {HTMLElement} graph_canvas - Container div for the SVG.
* @param {HTMLElement} node_detail  - Container div for the node detail panel.
* @returns {Promise<void>}
*/
const build_graph = async function(self, graph_canvas, node_detail) {

	const inverse_controls = self.inverse_controls || {}

	// load d3 lib only when needed
	// Note: d3.min.js is a UMD bundle that populates globalThis.d3
	// rather than providing named ESM exports, so import() returns
	// an empty namespace and the actual API lives on globalThis.d3
		if (self.node) {
			self.node.classList.add('loading')
		}
		await import('../../../lib/d3/dist/d3.min.js')
		const d3 = globalThis.d3
		if (self.node) {
			self.node.classList.remove('loading')
		}

	// initial graph data (central record + direct relations) from client datum
		const { nodes: initial_nodes, links: initial_links, section_maps: initial_section_maps } = datum_to_graph(self)
		const graph = { nodes: initial_nodes, links: initial_links }

	// section_maps accumulator (grows as datums are fetched)
		const section_maps = initial_section_maps || {}

	// label nodes: authoritative section_map terms via the batch get_section_terms
	// API first, then the per-node heuristic upgrade only for nodes that still
	// show a fallback label (no-map sections); mapped nodes are already labeled
	// so upgrade_fallback_labels' is_fallback gate skips them (no per-node read)
		const refresh_labels = (nodes) => {
			fetch_section_terms(self, nodes).then(terms => {
				if (apply_section_terms(nodes, terms)) {
					update()
				}
				upgrade_fallback_labels(self, nodes, () => {
					update()
				}, section_maps)
			})
		}

	// lazily upgrade fallback labels ("tipo · id" → readable label)
		refresh_labels(graph.nodes)

	// dimensions
		const get_size = () => {
			const size = graph_canvas.getBoundingClientRect()
			return {
				width	: size.width || 800,
				height	: size.height || 600
			}
		}
		let { width, height } = get_size()

	// color scale per section_tipo
		const color = d3.scaleOrdinal(d3.schemeCategory10)

	// svg + zoom container
		const svg = d3.create('svg')
			.attr('viewBox', [0, 0, width, height])
			.classed('svg_content', true)

		const container = svg.append('g').classed('zoom_container', true)

		const zoom = d3.zoom()
			.scaleExtent([0.2, 4])
			.on('zoom', (event) => {
				container.attr('transform', event.transform)
			})
		svg.call(zoom)

	// layers
		const link_layer = container.append('g').classed('links_layer', true)
		const node_layer = container.append('g').classed('nodes_layer', true)

	// d3 selections (rebound on every update)
		let link_sel = link_layer.selectAll('line.graph_link')
		let link_label_sel = link_layer.selectAll('text.graph_link_label')
		let node_sel = node_layer.selectAll('g.graph_node')

	// simulation
		const simulation = d3.forceSimulation(graph.nodes)
			.force('link', d3.forceLink(graph.links).id(d => d.id).distance(140).strength(0.4))
			.force('charge', d3.forceManyBody().strength(-700))
			.force('center', d3.forceCenter(width / 2, height / 2))
			.force('collide', d3.forceCollide().radius(40))
			.on('tick', ticked)

	// helpers to read link endpoint ids regardless of resolved state
		// D3 resolves source/target from id strings to node objects during simulation init.
		// After that, link.source / link.target are node objects, not strings.
		// endpoint_id normalises both cases so link_key can be computed at any time.
		const endpoint_id = (endpoint) => (typeof endpoint === 'object' && endpoint !== null) ? endpoint.id : endpoint
		const link_key = (l) => endpoint_id(l.source) + '__' + endpoint_id(l.target) + '__' + l.relation_tipo

	// re-entrancy guard for async expansion per node
		// Keyed by node.id (string) or the sentinel string 'inverse' for inverse-relation loads.
		const processing = new Set()

	// selected node for detail panel
		let selected_node = null

	// detail panel visibility (the grid parent owns the column track)
		const content_data_el = node_detail.parentElement

		/**
		* SET_DETAIL_VISIBLE
		* Show or collapse the detail column. Collapsing gives the canvas the full
		* width, so the simulation is re-centered on the new size once the browser
		* has applied the layout change (the class swap fires no resize event).
		*
		* @param {boolean} visible - true = detail column shown, false = collapsed.
		*/
		const set_detail_visible = (visible) => {
			if (!content_data_el || content_data_el.classList.contains('detail_hidden')===!visible) {
				return
			}
			content_data_el.classList.toggle('detail_hidden', !visible)
			requestAnimationFrame(() => on_resize())
		}

		/**
		* CLOSE_NODE_DETAIL
		* Panel close button: deselect the node and collapse the column.
		* Clicking any node reopens it, so the action is fully reversible.
		*/
		const close_node_detail = () => {
			selected_node = null
			render_detail_placeholder(node_detail)
			set_detail_visible(false)
			update()
		}

		/**
		* GET_NODE_RELATION_INFO
		* Resolve how a node hangs off the graph: the relation it arrived through
		* and the record on the other end. Answers "why is this node here?", which
		* the edge labels alone cannot when they overlap.
		*
		* Prefers the incoming edge (parent → node); falls back to an outgoing one
		* for inverse links, where the referencing record is the source.
		*
		* @param {Object} node - Graph node being displayed.
		* @returns {Object|null} `{ relation_label, other_label, is_inverse }`, or
		*   null for the root node or a node with no edge yet.
		*/
		const get_node_relation_info = (node) => {

			if (node.is_root) {
				return null
			}

			const link = graph.links.find(l => endpoint_id(l.target)===node.id)
				|| graph.links.find(l => endpoint_id(l.source)===node.id)
			if (!link) {
				return null
			}

			const other_id	= endpoint_id(link.target)===node.id ? endpoint_id(link.source) : endpoint_id(link.target)
			const other		= graph.nodes.find(n => n.id===other_id)

			return {
				relation_label	: link.relation_label || '',
				other_label		: other ? other.label : '',
				is_inverse		: link.is_inverse===true
			}
		}

	// inverse relations state
		const root_tipo		= self.section_tipo
		const root_id_value	= String(self.section_id)
		const root_id		= root_tipo + '_' + root_id_value
		let inverse_loaded	= 0   // cumulative count of inverse nodes already in the graph
		let inverse_total	= 0   // server-side total (from the count request)
		const INVERSE_BATCH	= 50  // page size for each paginated inverse load

	/**
	* TOGGLE_INVERSE_RELATIONS
	* Load or unload reverse relation nodes/links based on checkbox state.
	*
	* When `show` is true, calls `fetch_inverse_relations` for the first page
	* of records that reference the root node. On success the fetched nodes/links
	* are merged into the graph and labels are lazily upgraded.
	* When `show` is false, all links marked `is_inverse` and any nodes that
	* become orphaned after their removal are pruned from the graph arrays.
	*
	* The checkbox is disabled for the duration of the async load to prevent
	* double submissions. The `processing` set is keyed with `'inverse'` to block
	* concurrent `load_more_inverse` calls during the initial load.
	*
	* @param {boolean} show - true = load inverse relations; false = remove them.
	* @returns {Promise<void>}
	*/
	async function toggle_inverse_relations(show) {

		if (show) {
			processing.add('inverse')
			if (inverse_controls.checkbox) {
				inverse_controls.checkbox.disabled = true
			}
			try {
				const result = await fetch_inverse_relations(self, root_tipo, root_id_value, {
					limit	: INVERSE_BATCH,
					offset	: 0
				})
				inverse_total	= result.total
				inverse_loaded	= result.loaded

// (!) Indentation is deliberately kept as-is (not a bug in this documentation pass).
const root_node = graph.nodes.find(n => n.id === root_id) || { id: root_id, x: width / 2, y: height / 2 }

				add_children(root_node, result)

				refresh_labels(result.nodes)

				update_more_button()
				update()
			} catch (error) {
				console.error('[view_graph_edit_section] toggle_inverse_relations error:', error)
			} finally {
				processing.delete('inverse')
				if (inverse_controls.checkbox) {
					inverse_controls.checkbox.disabled = false
				}
			}
		} else {
			// remove all inverse links and their orphaned nodes
			graph.links = graph.links.filter(l => !l.is_inverse)
			const remaining_node_ids = new Set(graph.links.flatMap(l => [
				(typeof l.source === 'object' && l.source !== null) ? l.source.id : l.source,
				(typeof l.target === 'object' && l.target !== null) ? l.target.id : l.target
			]))
			remaining_node_ids.add(root_id)
			graph.nodes = graph.nodes.filter(n => remaining_node_ids.has(n.id) || n.is_root)

			inverse_loaded	= 0
			inverse_total	= 0
			update_more_button()
			update()
		}
	}//end toggle_inverse_relations

	/**
	* LOAD_MORE_INVERSE
	* Fetch the next batch of inverse relations and merge into the graph.
	*
	* Uses `inverse_loaded` as the offset so each successive call retrieves the
	* next page without overlapping already-fetched records. The guard
	* `processing.has('inverse')` prevents re-entrant loads when the user clicks
	* "load more" faster than the previous batch resolves.
	*
	* @returns {Promise<void>}
	*/
	async function load_more_inverse() {

		if (processing.has('inverse')) return

		processing.add('inverse')
		if (inverse_controls.more_button) {
			inverse_controls.more_button.disabled = true
		}
		try {
			const result = await fetch_inverse_relations(self, root_tipo, root_id_value, {
				limit	: INVERSE_BATCH,
				offset	: inverse_loaded
			})
			inverse_total	= result.total
			inverse_loaded	+= result.loaded

			const root_node = graph.nodes.find(n => n.id === root_id) || { id: root_id, x: width / 2, y: height / 2 }

add_children(root_node, result)

		refresh_labels(result.nodes)

		update_more_button()
		update()
	} catch (error) {
			console.error('[view_graph_edit_section] load_more_inverse error:', error)
		} finally {
			processing.delete('inverse')
			if (inverse_controls.more_button) {
				inverse_controls.more_button.disabled = false
			}
		}
	}//end load_more_inverse

	/**
	* UPDATE_MORE_BUTTON
	* Show/hide and update the text of the "load more" button for inverse relations.
	*
	* The button text shows the count that the next click will fetch
	* (`Math.min(INVERSE_BATCH, remaining)`) and the total remaining, so the user
	* knows how many records are still to be loaded. The button is hidden when all
	* inverse records have been loaded (`remaining === 0`).
	*/
	function update_more_button() {

		const btn = inverse_controls.more_button
		if (!btn) return

		const remaining = inverse_total - inverse_loaded
		if (remaining > 0) {
			const show_count = Math.min(INVERSE_BATCH, remaining)
			btn.style.display = ''
			btn.textContent = (get_label.show_more || 'Show') + ' ' + show_count + ' ' + (get_label.more || 'more') + ' (' + remaining + ' ' + (get_label.remaining || 'remaining') + ')'
		} else {
			btn.style.display = 'none'
			btn.textContent = ''
		}
	}//end update_more_button

	// wire checkbox
		if (inverse_controls.checkbox) {
			inverse_controls.checkbox.addEventListener('change', (e) => {
				e.stopPropagation()
				toggle_inverse_relations(e.target.checked)
			})
		}

	// wire "load more" button
		if (inverse_controls.more_button) {
			inverse_controls.more_button.addEventListener('click', (e) => {
				e.stopPropagation()
				load_more_inverse()
			})
		}

	/**
	* UPDATE
	* Rebind D3 selections to the current `graph.nodes` / `graph.links` arrays
	* and restart the force simulation.
	*
	* Called after every mutation of `graph` (expand, collapse, label upgrade,
	* inverse load). Performs a D3 enter/update/exit join for:
	* - Lines (`.graph_link`) representing directed edges.
	* - Text labels (`.graph_link_label`) centered on each edge.
	* - `<g>` groups (`.graph_node`) each containing a circle and two text
	*   elements (foreground label + white-stroke background clone for legibility).
	*
	* Visual state classes applied on the merged node selection on every call:
	* - `is_root`    — the central record (larger circle, fixed color).
	* - `expandable` — a non-root, non-expanded node that can be clicked to load.
	* - `expanded`   — a non-root node whose children are currently visible.
	* - `selected`   — the node currently shown in the detail panel.
	* - `inverse`    — links and link labels whose `is_inverse` flag is true.
	*
	* Simulation alpha is set to 0.6 on each update so freshly added nodes
	* settle visually before the simulation cools.
	*/
	function update() {

		// links
			link_sel = link_sel.data(graph.links, link_key)
			link_sel.exit().remove()
			link_sel = link_sel.enter()
				.append('line')
				.classed('graph_link', true)
				.classed('inverse', d => d.is_inverse === true)
				.merge(link_sel)

		// link labels
			link_label_sel = link_label_sel.data(graph.links, link_key)
			link_label_sel.exit().remove()
			link_label_sel = link_label_sel.enter()
				.append('text')
				.classed('graph_link_label', true)
				.classed('inverse', d => d.is_inverse === true)
				.attr('text-anchor', 'middle')
				.text(d => d.relation_label || '')
				.merge(link_label_sel)

		// nodes
			node_sel = node_sel.data(graph.nodes, d => d.id)
			node_sel.exit().remove()

			const node_enter = node_sel.enter()
				.append('g')
				.classed('graph_node', true)
				.call(drag(simulation))
				.on('click', node_clicked)

			node_enter.append('circle')
				.attr('r', d => d.is_root ? 16 : 11)

			node_enter.append('text')
				.attr('x', 16)
				.attr('y', '0.31em')
				.text(d => d.label)
				.clone(true).lower()
					.attr('class', 'graph_node_label_bg')
					.attr('fill', 'none')
					.attr('stroke', 'var(--color_white, #fff)')
					.attr('stroke-width', 3)

			node_sel = node_enter.merge(node_sel)

		// refresh visual state (classes, colors, labels) on the merged selection
			node_sel.classed('is_root', d => d.is_root)
				.classed('expandable', d => !d.is_root && !d.expanded)
				.classed('expanded', d => d.expanded && !d.is_root)
				.classed('selected', d => selected_node && d.id===selected_node.id)
			node_sel.select('circle')
				.attr('fill', d => d.is_root ? 'var(--color_orange_dedalo, #f78a1c)' : color(d.section_tipo))
			node_sel.selectAll('text')
				.text(d => d.label)

		// restart simulation
			simulation.nodes(graph.nodes)
			simulation.force('link').links(graph.links)
			simulation.alpha(0.6).restart()
	}//end update

	/**
	* TICKED
	* D3 simulation tick handler. Positions all SVG elements to match the
	* simulation's current node coordinates.
	*
	* Called on every simulation frame (up to 300 iterations after each
	* `simulation.restart()`). At this point D3 has resolved `link.source`
	* and `link.target` from id strings to node objects, so `.x` / `.y` are
	* always available on both endpoints.
	*
	* Link label positions are computed as the midpoint of the edge so the
	* label text floats at the center of the line.
	*/
	function ticked() {
		link_sel
			.attr('x1', d => d.source.x)
			.attr('y1', d => d.source.y)
			.attr('x2', d => d.target.x)
			.attr('y2', d => d.target.y)

		link_label_sel
			.attr('x', d => (d.source.x + d.target.x) / 2)
			.attr('y', d => (d.source.y + d.target.y) / 2)

		node_sel
			.attr('transform', d => `translate(${d.x},${d.y})`)
	}//end ticked

	/**
	* DRAG
	* Standard D3 drag behavior factory for simulation nodes.
	*
	* Temporarily pins a node's position (`fx`/`fy`) while dragging so the
	* simulation does not fight the user's pointer. On drag start, `alphaTarget`
	* is raised to 0.3 so the layout reacts to the movement in real time.
	* On drag end, `fx`/`fy` are cleared and `alphaTarget` is reset to 0 so
	* the layout cools down naturally.
	*
	* @param {Object} simulation - D3 force simulation instance.
	* @returns {Object} A D3 drag behavior bound to the simulation.
	*/
	function drag(simulation) {
		return d3.drag()
			.on('start', (event) => {
				if (!event.active) simulation.alphaTarget(0.3).restart()
				event.subject.fx = event.subject.x
				event.subject.fy = event.subject.y
			})
			.on('drag', (event) => {
				event.subject.fx = event.x
				event.subject.fy = event.y
			})
			.on('end', (event) => {
				if (!event.active) simulation.alphaTarget(0)
				event.subject.fx = null
				event.subject.fy = null
			})
	}//end drag

	/**
	* NODE_CLICKED
	* D3 click handler for graph node elements.
	*
	* Interaction contract:
	* - **Ctrl/Cmd + click**: opens the record in a new window immediately;
	*   no selection or expand/collapse side effects.
	* - **First click on an unselected node**: selects it and populates the
	*   node detail panel; does NOT expand/collapse (avoids triggering an API
	*   call just to see the record metadata).
	* - **Second click on the already-selected node**: toggles expand/collapse.
	*   If the node is expanded, `collapse_node` prunes its subtree. If the node
	*   has been loaded before (`node.loaded`) and its children are still in the
	*   graph (`has_children`), the expansion is instant (no API call). Otherwise,
	*   `fetch_node_relations` is called and the result is merged via `add_children`.
	*
	* Re-entrancy: the `processing` set blocks concurrent expansions for the same
	* node. The `loading_node` CSS class on the `<g>` element gives visual feedback
	* while the fetch is in flight.
	*
	* `d3.select(this)` requires the handler to be a regular function (not an arrow)
	* so that `this` is the clicked DOM element. This is already the case here.
	*
	* @param {MouseEvent} event - Native D3 click event.
	* @param {Object}     node  - Graph node datum bound to the clicked element.
	* @returns {Promise<void>}
	*/
	async function node_clicked(event, node) {

		event.stopPropagation()

		// open record in a new window
			if (event.ctrlKey || event.metaKey) {
				open_record_window(node)
				return
			}

		// if clicking a different node → select + show detail (no expand/collapse)
		// if clicking the already-selected node → toggle expand/collapse
			const was_selected = selected_node && selected_node.id===node.id

			selected_node = node
			show_node_detail(node)
			update()

		// toggle expand/collapse only when clicking the already-selected node
			if (!was_selected) {
				return
			}

		// re-entrancy guard
			if (processing.has(node.id)) {
				return
			}

		if (node.expanded) {
			collapse_node(node)
			node.expanded = false
			update()
			return
		}

		// expand
			if (node.loaded) {
				// cached children are re-attached by re-fetch only if missing; mark expanded
				node.expanded = true
				if (has_children(node)) {
					update()
					return
				}
			}

			processing.add(node.id)
			d3.select(this).classed('loading_node', true)
			try {
				const result = await fetch_node_relations(self, node, section_maps)
				add_children(node, result)
				// upgrade fallback labels on new child nodes
				refresh_labels(result.nodes)
				node.loaded = true
				node.expanded = true
				update()
			} catch (error) {
				console.error('[view_graph_edit_section] expand error:', error)
			} finally {
				processing.delete(node.id)
				d3.select(this).classed('loading_node', false)
			}
	}//end node_clicked

	/**
	* HAS_CHILDREN
	* Check whether the graph already contains at least one outgoing link owned
	* by the given node.
	*
	* A link is "owned by" a node when `link.parent_id === node.id`.
	* This is set by `add_children` / `datum_to_graph` and is stable even after
	* D3 resolves `source`/`target` from strings to objects.
	*
	* @param {Object} node - Graph node to check.
	* @returns {boolean} true when at least one child link exists in `graph.links`.
	*/
	function has_children(node) {
		return graph.links.some(l => endpoint_id(l.source)===node.id && l.parent_id===node.id)
	}//end has_children

	/**
	* ADD_CHILDREN
	* Merge a fetched result set (nodes + links) into the live `graph` arrays,
	* deduplicating by node id and link key.
	*
	* New nodes are spawned near their parent node with a small random jitter
	* so they do not stack on top of each other before the simulation settles.
	* The jitter range (±40 px) is intentionally modest to keep them visually
	* adjacent to their parent while giving the force layout something to work with.
	*
	* Links are keyed by `source + '__' + target + '__' + relation_tipo` (using
	* the original string ids, not the post-resolution objects) to match the key
	* computed by `link_key` before D3 resolves endpoints.
	*
	* @param {Object} node   - Parent graph node (provides x/y for spawn position).
	* @param {Object} result - Fetch result with `{ nodes: Array, links: Array }`.
	*/
	function add_children(node, result) {

		const existing_link_keys = new Set(graph.links.map(link_key))

		// nodes (dedupe by id)
			const result_nodes_len = result.nodes.length
			for (let i = 0; i < result_nodes_len; i++) {
				const child = result.nodes[i]
				if (!graph.nodes.find(n => n.id===child.id)) {
					// spawn near parent for a nicer layout
					child.x = (node.x || width / 2) + (Math.random() - 0.5) * 80
					child.y = (node.y || height / 2) + (Math.random() - 0.5) * 80
					graph.nodes.push(child)
				}
			}

		// links (dedupe by key)
			const result_links_len = result.links.length
			for (let i = 0; i < result_links_len; i++) {
				const link = result.links[i]
				const key = link.source + '__' + link.target + '__' + link.relation_tipo
				if (!existing_link_keys.has(key)) {
					graph.links.push(link)
					existing_link_keys.add(key)
				}
			}
	}//end add_children

	/**
	* COLLAPSE_NODE
	* Remove all direct child links owned by a node and recursively prune any
	* descendant nodes/links that become orphaned as a result.
	*
	* A link is "owned by" a node when `link.parent_id === node.id` (set by
	* `add_children`). Removing only owned links — rather than all links that
	* mention the node — is safe in graphs with shared nodes: a node that is
	* referenced by another path stays in the graph.
	*
	* Cycles are handled by `prune_if_orphan`'s reference check: if removing a
	* child's own links would leave the child still referenced by another remaining
	* link (including links from a sibling path), `prune_if_orphan` keeps it.
	*
	* After collapsing, `node.expanded` must be set to `false` by the caller
	* (done in `node_clicked`).
	*
	* @param {Object} node - Graph node whose direct subtree should be removed.
	*/
	function collapse_node(node) {

		// child links owned by this node
			const child_links = graph.links.filter(l => l.parent_id===node.id)
			if (child_links.length===0) {
				return
			}

			const child_target_ids = child_links.map(l => endpoint_id(l.target))

		// remove the owned links
			graph.links = graph.links.filter(l => l.parent_id!==node.id)

		// remove now-orphan descendants recursively
			const child_ids_len = child_target_ids.length
			for (let i = 0; i < child_ids_len; i++) {
				const tid = child_target_ids[i]
				prune_if_orphan(tid)
			}
	}//end collapse_node

	/**
	* PRUNE_IF_ORPHAN
	* Remove a node (and its own subtree) from the graph when no remaining
	* link references it — either as a source or as a target.
	*
	* The root node is never pruned (`is_root` guard). A node is kept whenever
	* any remaining link has it as either endpoint, even if it is the source of
	* that link (possible in inverse-relation edges where the referencing record
	* is the source).
	*
	* Recursion: before removing the node itself, its own child links are
	* removed and its child targets are recursively probed, ensuring the entire
	* subtree is cleaned up even in deep trees.
	*
	* @param {string} node_id - The graph node id (`section_tipo + '_' + section_id`)
	*   to evaluate for removal.
	*/
	function prune_if_orphan(node_id) {

		const target_node = graph.nodes.find(n => n.id===node_id)
		if (!target_node || target_node.is_root) {
			return
		}

		// still referenced by any remaining link ? keep it
			const referenced = graph.links.some(l =>
				endpoint_id(l.source)===node_id || endpoint_id(l.target)===node_id
			)
			if (referenced) {
				return
			}

		// collapse its own children first
			const own_child_links = graph.links.filter(l => l.parent_id===node_id)
			const own_child_ids = own_child_links.map(l => endpoint_id(l.target))
			graph.links = graph.links.filter(l => l.parent_id!==node_id)

		// remove the node
			graph.nodes = graph.nodes.filter(n => n.id!==node_id)

		// recurse
			const own_child_ids_len = own_child_ids.length
			for (let i = 0; i < own_child_ids_len; i++) {
				prune_if_orphan(own_child_ids[i])
			}
	}//end prune_if_orphan

	/**
	* SHOW_NODE_DETAIL
	* Populate the right-hand detail panel with information about the clicked node.
	*
	* Layout: a sticky identity header (section name, colour dot + label, locator,
	* how the node is related, "Open") over a scrolling field list. The colour dot
	* repeats the node's circle colour, so the panel visibly IS the clicked node.
	*
	* Renders immediately in two phases:
	* 1. **Synchronous / instant**: header (label, locator, relation context) and
	*    the "Open" button are created before any fetch. A loading indicator is
	*    shown in the fields area.
	* 2. **Async / lazy**: the record datum is fetched (or, for the root node,
	*    taken directly from `self.datum`) and `extract_node_fields` converts it
	*    into a list of `{ label, value, tipo }` rows rendered in `fields_container`.
	*    The datum's own section context also resolves the header eyebrow from the
	*    raw tipo to the section name. Any new section_maps from the fetched datum
	*    are merged into the shared accumulator so they are available for future
	*    label resolutions.
	*
	* On error the fields area shows a generic error message instead of throwing.
	*
	* @param {Object} node - Graph node whose detail should be displayed.
	* @returns {Promise<void>}
	*/
	async function show_node_detail(node) {

		// a previous close collapsed the panel: selecting a node brings it back
			set_detail_visible(true)

		// clear panel
			node_detail.innerHTML = ''

		// header (sticky over the scrolling field list)
			const header = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_detail_header',
				parent			: node_detail
			})

		// close (collapses the panel; clicking any node reopens it)
			const close_button = get_close_button(get_label.close || 'Close')
			close_button.classList.add('node_detail_close')
			header.appendChild(close_button)
			close_button.addEventListener('click', (e) => {
				e.stopPropagation()
				close_node_detail()
			})

		// section name (eyebrow). Resolved from the datum below; the reserved
		// height keeps the header from jumping when it arrives
			const section_name = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_section_name',
				parent			: header
			})

		// title: colour dot (mirrors the node circle) + record label
			const title_row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_detail_title_row',
				parent			: header
			})
			const color_dot = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'node_color_dot',
				parent			: title_row
			})
			color_dot.style.backgroundColor = node.is_root
				? 'var(--color_orange_dedalo, #f78a1c)'
				: color(node.section_tipo)
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_label',
				// (!) record terms (get_section_terms / strip_html) are TEXT: never parsed
				// as markup — a stored term like <img onerror> would run (CodeQL alert 7941)
				text_content	: node.label,
				parent			: title_row
			})

		// meta: locator + root badge
			const meta = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_meta',
				parent			: header
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'node_meta_item',
				text_content	: node.section_tipo + ' · ' + node.section_id,
				parent			: meta
			})
			if (node.is_root) {
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'node_meta_badge',
					inner_html		: get_label.current_record || 'Current record',
					parent			: meta
				})
			}

		// relation context: the edge this node arrived through
			const relation_info = get_node_relation_info(node)
			if (relation_info && (relation_info.relation_label || relation_info.other_label)) {
				const relation_row = ui.create_dom_element({
					element_type	: 'div',
					class_name		: relation_info.is_inverse ? 'node_relation inverse' : 'node_relation',
					parent			: header
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'node_relation_label',
					text_content	: relation_info.relation_label,
					parent			: relation_row
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'node_relation_parent',
					text_content	: relation_info.other_label,
					parent			: relation_row
				})
			}

		// open record link
			const open_link = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light link node_open_link',
				inner_html		: get_label.open || 'Open',
				parent			: header
			})
			open_link.addEventListener('click', (e) => {
				e.stopPropagation()
				open_record_window(node)
			})

		// body (scrolls under the header)
			const body = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_detail_body',
				parent			: node_detail
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_fields_title',
				inner_html		: get_label.fields || 'Fields',
				parent			: body
			})

		// fields container (lazy)
			const fields_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_fields',
				parent			: body
			})

		// loading indicator. The header above is already painted from the graph
		// node, so this covers the only part that waits on the network — and on a
		// slow link it is the difference between "loading" and "this node is empty"
			const loading = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'node_fields_loading',
				parent			: fields_container
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'spinner',
				parent			: loading
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'node_fields_loading_text',
				inner_html		: get_label.loading || 'Loading...',
				parent			: loading
			})

		// resolve fields
			try {
				let datum = null
				if (node.is_root) {
					// root node: datum is already in self
					datum = self.datum
				} else {
					// non-root: fetch via API
					datum = await fetch_section_datum(self, node.section_tipo, node.section_id)
				}
				if (datum) {
					const model_map = build_model_map(datum)
					// header eyebrow: raw tipo → section name, when the context carries it
					const section_ctx = (datum.context || []).find(ctx =>
						ctx && ctx.model==='section' && (ctx.tipo===node.section_tipo || ctx.section_tipo===node.section_tipo)
					)
					if (section_ctx && section_ctx.label) {
						section_name.textContent = section_ctx.label
					}
					// merge section_maps from fetched datum
					const new_maps = build_section_maps(datum)
					const new_map_keys = Object.keys(new_maps)
					const new_map_keys_len = new_map_keys.length
					for (let k = 0; k < new_map_keys_len; k++) {
						const key = new_map_keys[k]
						if (!section_maps[key]) {
							section_maps[key] = new_maps[key]
						}
					}
					const fields = extract_node_fields(datum, node.section_tipo, node.section_id, model_map)
					// clear loading
						fields_container.innerHTML = ''
					const fields_len = fields.length
					for (let i = 0; i < fields_len; i++) {
						const field = fields[i]
						const row = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'node_field',
							parent			: fields_container
						})
						// label line carries the tipo (revealed on hover, no reflow)
						const label_row = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'node_field_label_row',
							parent			: row
						})
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'node_field_label',
							text_content	: field.label,
							parent			: label_row
						})
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'node_field_tipo',
							text_content	: field.tipo,
							parent			: label_row
						})
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'node_field_value',
							text_content	: field.value,
							parent			: row
						})
					}
					if (fields_len===0) {
						ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'node_fields_empty',
							inner_html		: get_label.no_data || 'No data',
							parent			: fields_container
						})
					}
				} else {
					fields_container.innerHTML = ''
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'node_fields_empty',
						inner_html		: get_label.no_data || 'No data',
						parent			: fields_container
					})
				}
			} catch (error) {
				console.error('[view_graph_edit_section] show_node_detail error:', error)
				fields_container.innerHTML = ''
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'node_fields_empty',
					inner_html		: 'Error loading data',
					parent			: fields_container
				})
			}
	}//end show_node_detail

	/**
	* OPEN_RECORD_WINDOW
	* Open the full edit form of a graph node's record in a new browser window.
	*
	* Constructs the URL from `DEDALO_CORE_URL` (global constant injected by the
	* page bootstrap) with `tipo`, `section_tipo`, `id`, `mode: 'edit'`,
	* `session_save: false`, and `menu: true`.
	* `session_save: false` prevents the new window from overwriting the central
	* session navigation SQO that drives the originating edit window.
	*
	* The window `name` is unique per record type + id so re-clicking the same
	* node focuses the existing window instead of opening a second one.
	*
	* @param {Object} node - Graph node whose record should be opened.
	*/
	function open_record_window(node) {
		const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
			tipo			: node.section_tipo,
			section_tipo	: node.section_tipo,
			id				: node.section_id,
			mode			: 'edit',
			session_save	: false,
			menu			: true
		})
		open_window({
			url		: url,
			name	: 'record_view_' + node.section_tipo + '_' + node.section_id
		})
	}//end open_record_window

	// resize handling
		// Recalculates canvas dimensions and re-centers the force simulation
		// whenever the browser window is resized. Alpha 0.3 is enough to
		// gently reposition nodes without a jarring full-energy restart.
		const on_resize = () => {
			const size = get_size()
			width	= size.width
			height	= size.height
			svg.attr('viewBox', [0, 0, width, height])
			simulation.force('center', d3.forceCenter(width / 2, height / 2))
			simulation.alpha(0.3).restart()
		}
		window.addEventListener('resize', on_resize)

	// `window` never dies, so neither does `on_resize` — and it captures the live
	// d3 force simulation. Left attached, every graph a user ever opened keeps
	// ticking and RESTARTS on every window resize: not just retained memory but
	// live CPU work on invisible graphs. Hand the release to the instance.
		if (typeof self.release_graph==='function') {
			self.release_graph()
		}
		self.release_graph = () => {
			window.removeEventListener('resize', on_resize)
			simulation.stop()
			self.release_graph = null
		}

	// first paint
		update()
		graph_canvas.appendChild(svg.node())

	// click on canvas background deselects node (panel returns to its empty state,
	// it is NOT collapsed — only the close button hides the column)
		svg.on('click', (event) => {
			if (event.target===svg.node()) {
				selected_node = null
				render_detail_placeholder(node_detail)
				update()
			}
		})

	if (SHOW_DEBUG===true) {
		console.log('[view_graph_edit_section] graph built:', graph)
	}
}//end build_graph



// @license-end
