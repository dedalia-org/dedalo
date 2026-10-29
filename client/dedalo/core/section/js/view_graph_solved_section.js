// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise, SHOW_DEVELOPER, SHOW_DEBUG, page_globals, DEDALO_CORE_URL, confirm */
/*eslint no-undef: "error"*/



/**
* VIEW_GRAPH_SOLVED_SECTION
* Client-side view renderer for sections displayed in 'solved' mode with a D3 force-directed
* graph layout. This module is the sole rendering backend for `render_solved_section.solved()`
* when the active view is 'graph' or 'default'.
*
* Layout overview:
*   The rendered wrapper (`<section>`) has two child regions:
*   - left_node  : a browseable list of records (source sections) that the user can drag onto
*                  graph nodes to create new nexus connections.
*   - right_node : the D3 SVG graph canvas, a caller-section label, search controls, and
*                  the record content panel (content_data / node_body).
*
* Key interactions:
*   - Clicking a graph node opens that entity's section record in a new browser window.
*   - Clicking a graph link (path) opens the nexus section record in a new window.
*   - Hovering a link temporarily annotates the connected node labels with role names.
*   - Dragging a list record onto a graph node creates a new nexus section via `data_manager`
*     and immediately refreshes the view.
*   - Dragging a graph node repositions it; D3's force simulation updates all connected links.
*
* graph_map (read from `self.properties.graph_map` or the default):
*   Maps semantic role names to ontology tipo identifiers so the renderer knows which
*   component within a nexus section holds source/target/role/typology/connection data.
*   Default: { source: 'nexus10', target: 'nexus11', source_role: 'nexus12',
*              target_role: 'nexus13', typology: 'nexus7', connection: 'nexus29' }
*
* from_map (read from `self.properties.from_map` or the default):
*   Identifies the ontology tipo of the name component in the calling (parent) section.
*   Used to resolve a human-readable label for the caller section header.
*   Default: { name: 'nexus48' }
*
* Exports:
*   view_graph_solved_section  — namespace/constructor; static methods are the real API
*   on_dragstart               — drag-start handler (also used by external callers)
*/



// imports
	import {dd_request_idle_callback, when_in_dom} from '../../common/js/events.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {get_instance} from '../../common/js/instances.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {create_source} from '../../common/js/common.js'
	import {open_window, url_vars_to_object, object_to_url_vars} from '../../common/js/utils/index.js'
	import {response_data} from '../../common/js/api_error.js'
	// import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm' //'../../../lib/d3/dist/d3.v7.min.js'
	// D3. Note that to compile d3 using rollup, proceed as follows from the terminal:
	// - cd '/mylocalpath/v7/master_dedalo/lib/d3'
	// - rollup -c
	// import * as d3 from '../../../lib/d3/dist/d3.min.js'
	import {
		get_d3_data
	} from './render_solved_section.js'



/**
* VIEW_GRAPH_SOLVED_SECTION
* Namespace constructor for the graph-view renderer.
* Always returns true; all rendering logic is attached as static properties.
* Instantiation is not intended — use the static methods directly.
* @returns {boolean} true
*/
export const view_graph_solved_section = function() {

	return true
}//end view_graph_solved_section



/**
* RENDER
* Entry point called by render_solved_section.solved() to build the full DOM subtree
* for a section displayed in solved/graph mode.
*
* Builds the two-panel layout:
*   left  — browseable list of source-section records (drag sources)
*   right — D3 force-graph SVG canvas, caller label, search-panel toggle, content_data
*
* `self.graph_map` and `self.from_map` are resolved here from section properties
* (or defaults) and written onto `self` for downstream use.
* `self.node_body` is set to `content_data` so that pagination can update the content
* panel without re-rendering the whole view.
*
* When `render_level === 'content'`, only the content_data panel is returned
* (used by pagination to refresh the graph without rebuilding the surrounding chrome).
*
* @param {Object} self    - Section instance; must have `.datum`, `.properties`,
*                           `.section_tipo`, `.tipo`, `.mode`, `.view`, `.id`,
*                           `.type`, `.model`, `.inspector`, `.label`,
*                           and `.request_config_object`.
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'full' builds the entire layout;
*                           'content' returns only the inner content_data element.
* @returns {Promise<HTMLElement>} The `<section>` wrapper (full) or `<div.content_data>` (content).
*/
view_graph_solved_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// graph_map
	// set graph_map if it is defined in the properties of the section
	// else use default configuration
		self.graph_map = (self.properties?.graph_map)
			? self.properties.graph_map
			: {
				source		: 'nexus10',
				target		: 'nexus11',
				source_role	: 'nexus12',
				target_role	: 'nexus13',
				typology	: 'nexus7',
				connection	: 'nexus29'
			}

	// from_map
	// Used to show the name of the section caller
	// name component is defined in ontology from_map property of the current section
		self.from_map = (self.properties?.from_map)
			? self.properties.from_map
			: {
				name : 'nexus48'
			  }

	// right side
		const right_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'right_node'
		})

		// content_data
			const content_data = await get_content_data(self)

			// fix last content_data (for pagination selection)
			self.node_body = content_data
			if (render_level==='content') {
				return content_data
			}

		// label of the caller section
			const label_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'label_container',
				text_content	: 'Loading..',
				parent			: right_node
			})

			// Resolve the caller label asynchronously so it does not block initial paint.
			// URL vars `fst` (from section tipo) and `fsi` (from section id) are set by the
			// page that opened this section view (e.g. via open_window with session_save:false).
			dd_request_idle_callback(
				async () => {
					const url_vars = url_vars_to_object()
					if (url_vars.fst && url_vars.fsi) {

						const section_tipo	= url_vars.fst
						const section_id	= url_vars.fsi
						const tipo			= self.from_map.name

						// component_name
						const component_name = await get_instance({
							tipo			: tipo,
							section_tipo	: section_tipo,
							section_id		: section_id,
							mode			: 'solved',
							inspector		: false
						})

						await component_name.build(true)

						label_container.textContent = component_name.data?.literal || self.label || component_name.tipo
					}
				}
			)

		// buttons
			const buttons_node = get_buttons(self);
			if (buttons_node) {
				right_node.appendChild(buttons_node)
			}

		// search filter
			// if (self.filter) {
				const search_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'search_container',
					parent			: right_node
				})
				self.search_container = search_container
			// }

		// content_data add to fragment
			right_node.appendChild(content_data)

	// left side
		// left node with the d3 visualization
			const left_node = await render_left(self)

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'section',
			id				: self.id,
			class_name		: `wrapper_${self.type} ${self.model} ${self.section_tipo}_${self.tipo} ${self.tipo} ${self.mode} view_${self.view}`
		})
		if (self.inspector === false) {
			wrapper.classList.add('no_inspector')
		}
		wrapper.appendChild(left_node)
		// append fragment
		wrapper.appendChild(right_node)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Creates the content_data container div that hosts the D3 graph SVG.
*
* The D3 graph is built asynchronously — rendering is deferred via `when_in_dom` +
* `dd_request_idle_callback` so the DOM element is attached before `getBoundingClientRect()`
* is called (which requires a laid-out element to return non-zero dimensions).
*
* Side effect: appends the rendered SVG node as a child of the returned element
* once it is in the DOM and the browser is idle.
*
* @param {Object} self - Section instance with `.graph_map` and `.datum` already populated.
* @returns {Promise<HTMLElement>} The `<div.content_data>` element (initially empty;
*                                 the SVG graph is appended once in the DOM).
*/
const get_content_data = async function(self) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode)

	// d3 data and graph
	// Deferred to when_in_dom because get_graph calls getBoundingClientRect() on content_data
	// to derive the SVG viewBox; that requires the element to have been inserted into the DOM
	// and laid out. dd_request_idle_callback further defers to a browser idle slot.
		when_in_dom(content_data, ()=>{

			dd_request_idle_callback(
				async () => {

					// get d3 data
					const d3_data = get_d3_data({
						graph_map	: self.graph_map,
						datum		: self.datum
					})

					// get d3 node
					const d3_node = await get_graph({
						self			: self,
						content_data	: content_data,
						data			: d3_data
					})
					// append node
					content_data.appendChild(d3_node)
				}
			)
		})


	return content_data
}//end get_content_data



/**
* GET_GRAPH
* Builds the full D3 v7 force-directed SVG graph and wires all interaction handlers.
*
* Responsibilities:
*   - Lazy-loads the D3 library via dynamic import (avoids bundling it at build time;
*     a rollup-compiled local copy is used — see the commented import lines above).
*   - Builds the SVG canvas with a viewBox that matches the container's rendered size
*     and a resize listener to keep them in sync.
*   - Defines an SVG `<marker id="arrow">` for directional path arrows.
*   - Renders link paths with directional arrowheads that stop at the circle's edge
*     (two-pass layout: first draw to center, then shorten to the circle boundary).
*   - Renders nodes as `<g>` elements containing a `<circle>` and a `<text>` label
*     with a white-outline shadow clone for readability.
*   - Handles duplicate edges (same source→target or target→source pairs) by drawing
*     them as arcs with varying radii (`r = 75 / link_number`) rather than overlapping
*     straight lines. Self-loops (source === target) use a fixed `link_number = 3`.
*   - Attaches drag-to-reposition behavior to nodes (D3 drag, updates fx/fy on the
*     simulation subject).
*   - Attaches HTML5 drag-and-drop handlers to the SVG and to each node circle so that
*     list records from the left panel can be dropped to create new nexus sections.
*   - Attaches click handlers: node opens the entity section; link opens the nexus section.
*   - Attaches hover handlers to links: temporarily overlays role annotations on the
*     connected node labels, then removes them on mouseleave.
*
* Arrow positioning algorithm (two-pass `.attr("d", …)` on the simulation tick):
*   Pass 1 draws the path to the node center (d.target.x / d.target.y).
*   Pass 2 reads the path's total length via `getTotalLength()`, subtracts the circle
*   radius (10 px * 2) plus the arrow marker hypotenuse (√(3²+3²) ≈ 4.24 px), and
*   calls `getPointAtLength(pl - r)` to find the adjusted endpoint. This keeps the
*   arrowhead flush with the circle boundary regardless of path length or curvature.
*
* @param {Object} options
* @param {Object} options.self         - Section instance (used for event handlers and data).
* @param {HTMLElement} options.content_data - Container element; must be in the DOM
*                                             so getBoundingClientRect() returns real dimensions.
* @param {Object} options.data         - D3 graph data: `{ nodes: Array, links: Array }`
*                                        as produced by get_d3_data().
* @returns {Promise<SVGElement>} The D3-created SVG DOM node ready to be appended.
*/
const get_graph = async function(options) {

	// options
	const content_data	= options.content_data
	const data			= options.data
	const self			= options.self

	// Specify the dimensions of the graph.
	const size		= content_data.getBoundingClientRect()
	const width		= size.width;
	const height	= size.height;

	const default_fill_color = 'var(--color_grey_13)';

	// load lib files
	// load files only when is really necessary
		const load_lib_files = () => {
			return new Promise(function(resolve){

				if(self.node) {
					self.node.classList.add('loading')
				}

				// D3. Note that to compile d3 using rollup, proceed as follows from the terminal:
				// - cd '/mylocalpath/v7/master_dedalo/lib/d3'
				// - rollup -c

				import('../../../lib/d3/dist/d3.min.js')
				.then(async function(module){

					if(self.node) {
						self.node.classList.remove('loading')
					}

					resolve(module)
				})
			})
		}
		const d3 = await load_lib_files()

	// Specify the color scale.
	const color = d3.scaleOrdinal(d3.schemeCategory10);

	// The force simulation mutates links and nodes, so create a copy
	// so that re-evaluating this cell produces the same result.
	const links	= data.links.map(d => ({...d}));
	const nodes	= data.nodes.map(d => ({...d}));

	// Duplicate nodes
	// - Some nodes can be connected with the same target multiple times (duplicate the connection with different contexts),
	// for represent duplicate connections will use an arc path, unique or first duplicate will represent as a line.
	// - Every duplicate path will has a different radius of the arc, to show as different path
	// so, any links with duplicate source and target get an incremented 'link_number',
	// 'link_number' will use to calculate the final radius of the path into 'link_form' function (r=75/link_number).
	// - nodes connected with himself need to be identified as 'self_linked'
	for (let i = links.length - 1; i >= 0; i--) {

		const link = links[i]

		// check the the link is calling to himself
		// if yes, set it as self_linked and use 3 as link_number (small radius)
		if (link.source === link.target) {
			link.link_number	= 3
			link.self_linked	= true
		}
		// the the node has link_number assigned by previous link don't touch
		if (link.link_number >= 1) {
			continue
		}
		// found the links with the same source connected with the same target
		const found_source = links.filter(el => el.source === link.source && el.target === link.target)
		const found_target = links.filter(el => el.source === link.target && el.target === link.source)

		// join all duplicates to count the total
		const duplicates = [...found_source, ...found_target]
		// if the link has a duplicate add link_number, but leave the original without touch
		if (duplicates.length > 1) {
			let link_number = 1
			// don't change the original link (i≠0)
			for (let i = 1; i < found_source.length; i++) {
				const current_source		= found_source[i]
				current_source.link_number	= link_number
				link_number++
			}
			//reset the link_number because the duplicate in other direction will represent in the other side of the connection
			link_number = 1
			// in this case add link_number to all nodes (the original has avoided it in previous step)
			for (let i = 0; i < found_target.length; i++) {
				const current_target		= found_target[i]
				current_target.link_number	= link_number
				link_number++
			}
		}
	}

	// Create a simulation with several forces.
	const simulation = d3.forceSimulation(nodes)
		.force("link", d3.forceLink(links).id(d	=> d.id))
		.force("charge", d3.forceManyBody().strength(-4000))
		.force("x", d3.forceX())
		.force("y", d3.forceY());

	// Create the SVG container.
	const svg = d3.create("svg")
		// .attr("width", width)
		// .attr("height", height)
		.attr("viewBox", [-width / 2, -height / 2, width, height])
		// .attr("preserveAspectRatio", "xMinYMin meet")
		// .attr("style", "max-width: 100%; height: auto;")
		.classed("svg_content", true)
		.on("dragenter", on_dragenter) // show active the node
		.on("dragover", on_dragover) // show active the node and remove the default behavior to allow drop
		.on("drop", on_drop ) // create new nexus section with the source and target
		.on("dragleave", on_dragleave) // deactivate the node

		// recalculate the size of the view-box every time that window has resized.
		// NAMED and stored: `window` is a permanent root, so an anonymous listener
		// here keeps this graph — and its live force simulation — alive for the whole
		// session, and every graph the user ever opened re-runs on each resize.
		const on_resize = () => {
			const new_size 		= content_data.getBoundingClientRect()
			const new_width		= new_size.width;
			const new_height	= new_size.height;
			svg.attr("viewBox", [-new_width / 2, -new_height / 2, new_width, new_height])
		}
		window.addEventListener("resize", on_resize);

		// hand the release to the instance, which is what gets destroyed.
		// Releasing the previous graph first, so a rebuild replaces it, never stacks.
		if (typeof self.release_graph==='function') {
			self.release_graph()
		}
		self.release_graph = () => {
			window.removeEventListener("resize", on_resize)
			simulation.stop()
			self.release_graph = null
		}

 	// Per-type markers
	// Arrow pointer: It will store into the svg and will use in the path as "marker-end" with URL pointed to id
	svg.append("defs")
		.append('marker')
		.attr("id", "arrow")
		.attr("viewBox", "0 -5 10 10")
		.attr("refX", 0)
		.attr("refY", 0)
		.attr("markerWidth", 3)
		.attr("markerHeight", 3)
		.attr("orient", "auto-start-reverse")
		.append("path")
			.attr("fill", color)
			.attr("d", "M0,-5L10,0L0,5");

	// links
	// path between nodes
	// the path will have a arrow pointing to the target
	// use .data array to create all links
	const link = svg.append("g")
		.attr("fill", "none")
		.attr("stroke-opacity", 0.6)
		.selectAll("path")
		.data(links)
		.join("path")
			.attr("stroke", d => color(d.type))
			.attr("marker-end", 'url(#arrow)')
			.attr("stroke-width", d => Math.sqrt(d.weight))
			.on("click", link_clicked)
			.on("mouseenter", link_mouse_enter)
			.on("mouseleave", link_mouse_leave);

	// nodes
	// a circle representing the connected thing
	// nodes will open his section (people will open rsc197, entity will open rsc106, etc.)
	// nodes of different sections will use different colors to identify it
	const node = svg.append("g")
		.attr("fill", "currentColor")
		.attr("stroke-linecap", "round")
		.attr("stroke-linejoin", "round")
		.selectAll("g")
			.data(nodes)
			.join("g");

		// add id to the node
		node
			.attr("id", d => d.id)

		// circle
		// the node representation of the thing
		// the user can drop new thing (people, entity, mint,...) in the node
		// when user drop a thing, create new nexus section, the node will be source and the dropped thing will be the target
		node.append("circle")
			.attr("stroke", "var(--color_white)") // a stroke around the circle, white as background
			.attr("stroke-width", 1.5) // a tiny stroke use to "cut" the link path
			.attr("r", 10) // fixed radius, if it change, change the r in the "tick" function
			.attr("fill", d => (d.value) ? d.color : default_fill_color) // use different color for every section, if the value is empty, use gray
			.on("click", node_clicked) // open the main section of the thing
			.on("dragenter", on_dragenter) // show active the node
			.on("dragover", on_dragover) // show active the node and remove the default behavior to allow drop
			.on("drop", on_drop ) // create new nexus section with the source and target
			.on("dragleave", on_dragleave) // deactivate the node

		// node.append("title")
		// 	.text(d => d.id);

		// text
		// the text of the thing
		node.append("text")
			.attr("x", 14) // move the x position to left of the center of the node, a small offset to show it
			.attr("y", "0.31em")// move the y position to center in the middle of the circle
			.text(d => d.name) // the name
			.clone(true).lower() // duplicate it to create a white version around the text, it help to read when the text is in the top of circles or paths
				.attr("fill", "none")// remove the text
				.attr("stroke", "white") // create a border around the text
				.attr("stroke-width", 3);

		// Add a drag behavior for the node
		// nodes can move at any position and all connected will be re-calculated his position
			node.call(d3.drag()
				.on("start", dragstarted)
				.on("drag", dragged)
				.on("end", dragended));

	// Set the position attributes of links and nodes each time the simulation ticks.
	simulation.on("tick", () => {
		// links
		// target point will need to be calculated twice;
		// - first the path need a target in the center of the node (d.target)
		// - second when first is done, is possible calculate the path length, the node size (circle) and arrow size
		// with all sizes, creates new point that will be the target point.
		link
			.attr("d", function(d){
				// first, use the target point to create the path
				const x_target	= d.target.x
				const y_target	= d.target.y

				return link_form({
					d: d,
					x_target : x_target,
					y_target : y_target
				})
			})
			.attr("d", function(d){
				// second, with the previous path, calculate his length
				const pl = this.getTotalLength()
				// use the radius of the circle (10) a offset it (*2) and calculate the arrow size √3**2+3**2)
				const r = 10 * 2 + Math.sqrt(3**2 + 3 **2)
				// create new point in the path
				const m = this.getPointAtLength(pl - r);
				const x_target	= m.x
				const y_target	= m.y

				return link_form({
					d: d,
					x_target : x_target,
					y_target : y_target
				})
			});

		node
			.attr("transform", d => `translate(${d.x},${d.y})`);
	});

	// calculate the svg parameters for the paths
	// if the path is duplicated, an arc will created, it will has 'link_number' parameter with an int of the number of the duplicate 1,2,3
	// if the path is not duplicate, it will be a line
	function link_form(options) {

		const d			= options.d
		const x_target	= options.x_target
		const y_target	= options.y_target

		// the path is duplicate; create a arc
		if(d.link_number){
			// the radius of the arc will be different for every duplicate
			const r = 75/d.link_number;
			// if the path point to same node, self_linked, the large of the path need to be 1 else 0
			const large_arc	= (d.self_linked) ? 1 : 0
			// if the path point to same node, self_linked, the source point and target point need to be different
			// if the path has the same source point as target point the path collapse and don't show it.
			const x_source	= (d.self_linked) ? d.source.x + 1 : d.source.x
			const y_source	= (d.self_linked) ? d.source.y + 1 : d.source.y

			return `M${x_source},${y_source} A${r},${r} 0 ${large_arc},1 ${x_target},${y_target}`;
		}else{
			return `M${d.source.x},${d.source.y} L ${x_target},${y_target}`
		}
	}

	// Drag and Drop new connections
	// user drag a section_record of the left section list into a node

		// when mouse enter with a drag move, change the node style to show it as activate
		function on_dragenter(event){
			d3.select(this).classed("dragover", true);
		}
		// remove default behavior to allow drop
		function on_dragover(event){
			event.preventDefault(); // allow drop
		}
		// when mouse leave the node, remove the style to show as normal
		function on_dragleave(event){
			d3.select(this).classed("dragover", false);
		}
		// drop
		// when user drop new section_record into a node, create new nexus section and assign the source (node) and target (section_record dragged)
		async function on_drop(event, p){

			event.preventDefault() // Necessary. Allows us to drop.
			event.stopPropagation()

			// remove the style of the node to show it as normal
			d3.select(this).classed("dragover", false);
			// self is the component_portat that call and it has the sort_order function
			const data	= event.dataTransfer.getData('text/plain');// element that's move
			// the drag element will sent the data of the original position, the source_key
			const data_parse = JSON.parse(data)

			// values for source / target components
			// if the user drop into a node the p will exist and p.value will be the source
			// when drop is a empty space (svg viewbox) the p and p.value will not defined
			// in this case the source will be the dragged value
			// and the target will null
			const source_value = (p && p.value)
				? p.value
				: data_parse.value
			const target_value = (p && p.value)
				? data_parse.value
				: null

				const bool = (p && p.value)

			// if the user drop into empty node or the node has value:
			// create new nexus section and assign the dragged value
			// else (the node has not value) assign the dragged value into the empty node
			if (!p || p.value) {
				// data_manager. create new section
					const rqo = {
						action	: 'create',
						source	: {
							section_tipo : self.section_tipo
						}
					}
					const api_response = await data_manager.request({
						body : rqo
					})
					// if the server response is ok, it will send the new section_id
					const section_id = response_data(api_response)
					if (section_id && section_id>0) {

						// source
						// assign the source data for the source component with the node value
						await set_component_data({
							tipo			: self.graph_map.source,
							value			: source_value,
							section_tipo	: self.section_tipo,
							section_id		: section_id
						})

						// target
						// assign the target data for the target component with the section_record dragged
						// when the user drop into empty space, the target will be not defined and it will be not assigned
						if (target_value) {
							await set_component_data({
								tipo			: self.graph_map.target,
								value			: target_value,
								section_tipo	: self.section_tipo,
								section_id		: section_id
							})
						}

						self.request_config_object.sqo.limit = self.request_config_object.sqo.limit+1
						self.refresh()
					}
			}else{
				// empty node case
				// assign the source data for the source component with the node value
				// source value will be the dragged value
				await set_component_data({
					tipo			: p.tipo,
					value			: source_value,
					section_tipo	: p.from.section_tipo,
					section_id		: p.from.section_id
				})

				self.request_config_object.sqo.limit = self.request_config_object.sqo.limit+1
				self.refresh()

			}
			/**
			* SET_COMPONENT_DATA
			* Assigns and saves data into a specific component (source or target component
			* of a newly-created nexus section).
			* @param {Object} options
			* @param {string} options.tipo          - Component tipo to update.
			* @param {Object} options.value         - Locator `{ section_tipo, section_id }` of the entity to assign.
			* @param {string} options.section_tipo  - Section tipo of the nexus record being updated.
			* @param {number} options.section_id    - Section id of the nexus record being updated.
			* @returns {Promise<void>}
			*/
			async function set_component_data(options){

				const tipo				= options.tipo
				const component_value	= options.value
				const section_tipo		= options.section_tipo
				const section_id		= options.section_id

				// create the component source instance
					const source_component = await get_instance({
						section_tipo	: section_tipo,
						section_id		: section_id,
						tipo			: tipo,
						type 			: 'component'
					})

				// create the source (instance source of the component)
					const source = create_source(source_component, null)
					// set the current view and mode to get the new data in the same model than current data
					source.view = 'graph'
					source.mode = 'solved'
				// set the changed_data for replace it in the instance data
				// update_data_value. key is the position in the data array, the value is the new value
					const value = {
						section_id			: component_value.section_id,
						section_tipo		: component_value.section_tipo,
						from_component_tipo	: tipo
					}
				// set the changed_data for update the component data and send it to the server for change when save
					const data = {}
					data.changed_data = [{
						action	: 'insert',
						id		: null,
						value	: value
					}]
				// rqo
					const rqo = {
						action	: 'save',
						source	: source,
						data	: data
					}

				// data_manager. create new record
					const api_response = await data_manager.request({
						body : rqo
					})
					if (SHOW_DEBUG === true) {
						console.log('create new record api_response:', api_response);
					}
			}
		}

	// Drag the nodes into new position
	// user move a node to other position, recalculate all sizes and positions of the links and nodes

		// Reheat the simulation when drag starts, and fix the subject position.
		function dragstarted(event) {
			if (!event.active) simulation.alphaTarget(0.3).restart();
			event.subject.fx = event.subject.x;
			event.subject.fy = event.subject.y;
		}

		// Update the subject (dragged node) position during drag.
		function dragged(event) {
			event.subject.fx = event.x;
			event.subject.fy = event.y;
		}

		// Restore the target alpha so the simulation cools after dragging ends.
		// Unfix the subject position now that it's no longer being dragged.
		function dragended(event) {
			if (!event.active) simulation.alphaTarget(0);
			event.subject.fx = null;
			event.subject.fy = null;
		}

	// When this cell is re-run, stop the previous simulation. (This doesn't
	// really matter since the target alpha is zero and the simulation will
	// stop naturally, but it's a good practice.)
	// invalidation.then(() => simulation.stop());

	// node behavior
		// when user click into the node, open the main section of the thing
		function node_clicked(event, p) {
			// if node has not a value (empty component) is not possible open the main section
			if (!p.value) {
				return null
			}
			// sort vars
			const section_tipo	= p.value.section_tipo
			const section_id	= p.value.section_id

			// open a new window of the node section
				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo			: section_tipo,
					section_tipo	: section_tipo,
					id				: section_id,
					mode			: 'edit',
					session_save	: false, // prevent to overwrite current section session
					menu			: true
				})
				open_window({
					url			: url,
					name		: 'record_view_' + section_id
				})
		}

	// link behavior
		// when user click in the link path open the nexus section of the connection
		function link_clicked(event, p) {

			// short vars
			const section_tipo	= p.value.section_tipo
			const section_id	= p.value.section_id

			// open a new window of the section
				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo			: section_tipo,
					section_tipo	: section_tipo,
					id				: section_id,
					mode			: 'edit',
					session_save	: false, // prevent to overwrite current section session
					menu			: true
				})
				open_window({
					url			: url,
					name		: 'record_view_' + section_id
				})
		}

		// when user move mouse over path, show the role of the source and the target
		function link_mouse_enter(event, p) {

			// get the text of the source and target node
			const source_text_node = d3.select("#" + p.source.id);
			const target_text_node = d3.select("#" + p.target.id);

			// if the link is to same node, the text will be only 1 in the node with both roles
			// (source -> target)
			// if the link point two different nodes, every node will has his own role
			// (source)
			if (p.source.id === p.target.id) {
				// add source and target text node with role enclosed by "()"
				const source_text = (p.source_role) ? `${p.source_role}` : '';
				const target_text = (p.target_role) ? `${p.target_role}`: '';

				const text = `${source_text} -> ${target_text}`

				source_text_node.append("text")
				.attr("x", 14)
				.attr("y", 20)
				.attr("dy", "0em")
				.attr("id", "role")
				.text(text);

			}else{
				// add source and target text node with role enclosed by "()"
				source_text_node.append("text")
					.attr("x", 14)
					.attr("y", 20)
					.attr("dy", "0em")
					.attr("id", "role")
					.text((p.source_role) ? `(${p.source_role})` : '');

				target_text_node.append("text")
					.attr("x", 14)
					.attr("y", 20)
					.attr("dy", "0em")
					.attr("id", "role")
					.text((p.target_role) ? `(${p.target_role})`: '');
			}
		}

		// when user move the mouse out of the path remove all text role nodes
		function link_mouse_leave(event, p) {
			d3.selectAll("#role").remove();
		}


	return svg.node();
}//end get_graph



/**
* GET_BUTTONS
* Builds the action buttons toolbar for the right panel.
*
* Currently renders a single "Search" toggle button that publishes the
* `toggle_search_panel_<self.id>` event via event_manager. The search subsystem
* (init in the section lifecycle) listens for this event to show/hide the
* search_container panel.
*
* Returns a DocumentFragment so the caller can append it conditionally
* without forcing unnecessary reflows.
*
* @param {Object} self - Section instance; `self.id` is used to scope the event.
* @returns {DocumentFragment} Fragment containing a `<div.buttons_container>` with the search button.
*/
const get_buttons = function(self) {

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
		// warm up on intent: build requests start before the click
		const warm_handler = () => self.warm_search_panel?.()
		filter_button.addEventListener('pointerenter', warm_handler)
		filter_button.addEventListener('focus', warm_handler)


	return fragment
}//end get_buttons



/**
* RENDER_LEFT
* Builds the left panel: a `<select>` for choosing which source section type to browse,
* and a scrollable list of records from that section type that the user can drag onto
* graph nodes to create new nexus connections.
*
* The set of available section types is read from the source component's context
* `request_config` → SQO `section_tipo[]` entries. Each entry carries a `.tipo` and
* a `.label` used to populate the `<option>` elements.
*
* On initial render the first available section type is selected automatically.
* Changing the `<select>` clears the section_container and renders a fresh record list
* for the newly selected type.
*
* Source component context resolution:
*   The source component tipo (from `self.graph_map.source`) is looked up in
*   `self.datum.context`. If not found there (e.g. section has no records yet), a
*   temporary component instance is created with `section_id: 1` (a fake sentinel
*   value — the real data is not needed, only the static context object).
*
* @param {Object} self - Section instance with `.graph_map`, `.datum`, and `.section_tipo`.
* @returns {Promise<HTMLElement>} The `<div.left_node>` element.
*/
const render_left = async (self) => {

	const left_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'left_node'
	})

	const source					= self.graph_map.source
	const source_component_context	= (self.datum.context.find(el => el.tipo === source))
		? self.datum.context.find(el => el.tipo === source)
		: await get_source_component_context(source)

	// Fallback: retrieve context from a temporary component instance when the datum
	// carries no context entry for the source tipo (e.g. zero records in the section).
	// section_id:1 is a sentinel — only the static context is needed, not real data.
	async function get_source_component_context(source){

		const component = await get_instance({
			tipo			: source,
			section_tipo	: self.section_tipo,
			section_id		: 1, // Fake section_id for temporal component
			is_temporal		: true,
			mode			: 'list'
		})
		return component.context
	}

	const request_config = source_component_context.request_config

	const rqo = request_config.find(el => el.api_engine === 'dedalo')

	const sqo = rqo.sqo

	// section_selector_container
		const section_selector_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_selector_container',
			parent			: left_node
		})
		const section_select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'section_select',
			parent			: section_selector_container
		})

		// Populate one <option> per section_tipo entry in the SQO.
		// The section_tipo is stored as a DOM property (not an HTML attribute) on the option
		// element so it survives selection without URL-encoding.
		const section_tipo_length = sqo.section_tipo.length
		for (let i = 0; i < section_tipo_length; i++) {
			const section = sqo.section_tipo[i]

			const section_option = ui.create_dom_element({
				element_type	: 'option',
				class_name		: 'section_option',
				inner_html 		: section.label,
				parent			: section_select
			})
			section_option.section_tipo = section.tipo
		}// end for

		// Re-render the section list whenever the user picks a different section type.
		section_select.addEventListener('change', async function(e) {

			while (section_container.hasChildNodes()) {
				section_container.removeChild(section_container.lastChild);
			}
			const selected = e.target.options[e.target.selectedIndex]
			const section_tipo = selected.section_tipo;
			const new_section_node = await render_source_section({
				section_tipo	: section_tipo,
				rqo				: rqo
			})

			section_container.appendChild(new_section_node)
		})

	// section_container
		const section_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_container',
			parent			: left_node
		})
		// render first selection
		const selected_section = section_select[section_select.selectedIndex].section_tipo
		render_source_section({
			section_tipo	: selected_section,
			rqo				: rqo
		})
		.then(function(section_node){
			section_container.appendChild(section_node)
		})

	return left_node
}//end render_left



/**
* RENDER_SOURCE_SECTION
* Renders a scrollable record list for one source section type inside the left panel.
*
* Builds a scoped `request_config` from the parent source component's `rqo`, filtering
* `ddo_map` entries to only those belonging to `section_tipo`, and overriding the SQO
* to a simple paged query (limit 10, offset 0) restricted to that section type.
* The `parent` field is added to each ddo_map entry so that the section list renderer
* knows the owning section for relative component lookups.
*
* After building the section instance, `rebuild_columns_map` is injected onto it so that
* the column layout produced by section_records includes the custom ID-edit and drag
* columns defined in this module.
*
* The `view` is forced to 'base' before render so that the section uses its standard
* list presentation rather than the graph view.
*
* `id_variant: 'into_graph_solved'` scopes the instance cache key so the left-panel
* section instances do not collide with identically-typed sections elsewhere in the page.
*
* @param {Object} options
* @param {string} options.section_tipo - Ontology tipo of the source section to list.
* @param {Object} options.rqo          - The parent request query object (from the source
*                                        component's request_config); provides the full
*                                        ddo_map to filter from.
* @returns {Promise<HTMLElement>} Rendered section node ready to be inserted into the DOM.
* @throws {Error} If get_instance returns null, render returns null, or rebuild_columns_map
*                 is somehow not a function (defensive guard — it is module-scoped here).
*/
const render_source_section = async function(options) {

	// options
	const {
		section_tipo,
		rqo
	} = options

	// Create a new ddo_map based on given rqo
	const old_ddo_map = rqo.show.ddo_map.filter(el => el.section_tipo === section_tipo)
	const ddo_map = old_ddo_map.map(el => ({
		...el, // Spread all existing properties
		parent : section_tipo // Add new property parent
	}));

	// request_config
	const request_config = [{
		api_engine	: 'dedalo',
		type		: 'main',
		sqo			: {
			section_tipo	: [{tipo:section_tipo}],
			limit			: 10,
			offset			: 0
		},
		show		: {
			ddo_map : ddo_map
		}
	}]

	// Section instance options
	const section_options = {
		model			: 'section',
		tipo			: section_tipo,
		section_tipo	: section_tipo,
		mode			: 'list',
		request_config	: request_config,
		id_variant		: 'into_graph_solved',
		add_show		: true
	}

	try {
		const section = await get_instance(section_options)

		if (!section) {
			throw new Error('Failed to get section instance');
		}

		await section.build(true)

		// rebuild_columns_map
		// (!) This guard is defensive — rebuild_columns_map is always defined as a const
		// in this module's scope. The typeof check would only fail if the module were somehow
		// partially evaluated or if the code were restructured to remove the function.
		if (typeof rebuild_columns_map !== 'function') {
			throw new Error('rebuild_columns_map function is not available');
		}
		section.rebuild_columns_map = rebuild_columns_map;

		// view set before render
		section.view = 'base'

		// render
		const section_node = await section.render()

		if (!section_node) {
			throw new Error('Failed to render section');
		}

		return section_node;

	} catch (error) {
		console.error('Error in render_source_section:', error);
		throw error; // Re-throw or handle appropriately
	}
}//end render_source_section



/**
* REBUILD_COLUMNS_MAP
* Injected onto left-panel section instances to override their default column layout.
* Called by section_records during render to obtain the final ordered columns list.
*
* Adds two custom columns around the base columns_map produced by the section:
*   1. 'section_id' column (prepended) — renders an edit button that opens the record
*      in a new window via view_graph_solved_section.render_column_id.
*   2. 'drag' column (appended) — renders a draggable handle that the user can drag
*      onto graph nodes; uses view_graph_solved_section.render_column_drag.
*
* Once computed, `self.fixed_columns_map = true` is set as a guard so that subsequent
* calls from pagination or re-render return the cached result immediately.
*
* @param {Object} self - Section instance; must have `.columns_map` (Promise or Array)
*                        and `.section_tipo`.
* @returns {Promise<Array>} The augmented columns_map array with id + base + drag columns.
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
			callback	: view_graph_solved_section.render_column_id
		})

	// columns base
		const base_columns_map = await self.columns_map
		columns_map.push(...base_columns_map)

	// columns_map
		columns_map.push({
			id			: 'drag',
			label		: '',
			tipo		: '', // used to sort only
			sortable	: false,
			width		: '3rem',
			callback	: view_graph_solved_section.render_column_drag
		})

	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_ID
* Column callback invoked by section_records to render the leftmost ID column cell.
* Produces an edit-pencil button that opens the record in a new browser window.
*
* On window blur (user closes/leaves the edit window), triggers a `self.refresh()` with
* `build_autoload: true` so the left-panel list picks up any changes made in the edit window.
*
* The `session_save: false` URL parameter prevents the opened window from overwriting
* the current session's section navigation state.
*
* @param {Object} options
* @param {Object} options.caller       - The section_record instance (`self` in caller scope).
* @param {number} options.section_id   - ID of the record being rendered.
* @param {string} options.section_tipo - Tipo of the record's section.
* @returns {DocumentFragment} Fragment containing the edit button with a pen icon span.
*/
view_graph_solved_section.render_column_id = function(options) {

	// options
		const self			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	const fragment = new DocumentFragment()

	// button_edit
		const button_edit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_edit button_view_' + self.context.view,
			parent			: fragment
		})
		button_edit.addEventListener('click', function(e) {
			e.stopPropagation()
			e.preventDefault();

			// open a new window
			const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
				tipo			: section_tipo,
				section_tipo	: section_tipo,
				id				: section_id,
				mode			: 'edit',
				session_save	: false, // prevent to overwrite current section session
				menu			: true
			})
			open_window({
				url			: url,
				name		: 'record_view_' + section_id,
				on_blur : () => {
					// refresh current instance
					self.refresh({
						build_autoload : true
					})
				}
			})
		})

	// edit icon
		ui.create_dom_element({
			element_type	: 'span',
			// class_name	: 'button pen icon grey',
			class_name		: 'button pen icon grey',
			parent			: button_edit
		})


	return fragment
}//end render_column_id


/**
* RENDER_COLUMN_DRAG
* Column callback invoked by section_records to render the drag-handle column cell.
* Produces a draggable `<span>` that, when dragged over the SVG graph and dropped on a
* node, triggers the `on_drop` handler in get_graph() to create a new nexus connection.
*
* The drag image is built from cloned render nodes of all component instances for this
* record, giving the user a visual preview of what they are dragging.
*
* Data transferred: JSON-stringified `{ value: locator, paginated_key: number }` via
* `dataTransfer.setData('text/plain', …)`, consumed by `on_dragstart` → `on_drop`.
*
* (!) `drag_node` is declared AFTER the `dragstart` listener closure that references it.
*     This works because `drag_node` is captured by the closure via the variable binding,
*     not its value at the time of addEventListener. By the time 'dragstart' fires,
*     `drag_node` has been assigned. This is a forward-reference via closure — intentional
*     but non-obvious.
*
* @param {Object} options
* @param {Object} options.caller        - The section_record instance.
* @param {number} options.section_id    - Record ID (not used directly but kept for API parity).
* @param {string} options.section_tipo  - Section tipo (not used directly).
* @param {Object} options.locator       - Locator object `{ section_tipo, section_id }` for this record.
* @param {number} options.paginated_key - Position index of this record in the paginated data array.
* @param {Array}  options.ar_instances  - Array of rendered component instances; each has a `.node` property.
* @returns {DocumentFragment} Fragment with a move-icon span and a draggable container.
*/
view_graph_solved_section.render_column_drag = function(options) {

	// options
		const self			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo
		const locator		= options.locator
		const paginated_key	= options.paginated_key
		const ar_instances	= options.ar_instances

	const fragment = new DocumentFragment()

	// button_drag
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button move icon grey',
			parent			: fragment
		})

	// drag_container
		const drag_container = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'drag_container',
			parent 			: fragment
		})
		drag_container.draggable = true
		drag_container.addEventListener('dragstart', function(e){
			on_dragstart(this, e, {
				section_record_node	: drag_container,
				paginated_key		: paginated_key,
				total_records		: self.total,
				value 				: locator,
				caller 				: self,
				drag_node 			: drag_node
			})
		})

		const drag_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'drag_node draggable',
			parent 			: drag_container
		})

		const ar_instances_length = ar_instances.length
		for (let i = 0; i < ar_instances_length; i++) {
			const instance_node = ar_instances[i].node.cloneNode(true)
			drag_node.appendChild(instance_node)
		}


	return fragment
}//end render_column_drag



/**
* ON_DRAGSTART
* Initializes an HTML5 drag operation for a list-record drag handle.
* Serializes the record locator and its paginated position into
* `dataTransfer` as JSON text so that the SVG drop handlers in get_graph()
* can reconstruct the record identity without accessing any shared state.
*
* Sets the drag image to the `drag_node` visual preview built in render_column_drag.
* Adds a 'dragging' CSS class to `node` for visual feedback during the drag.
*
* Called from the 'dragstart' listener in render_column_drag; also exported for
* potential reuse by other view modules.
*
* @param {HTMLElement} node    - The drag-handle element that the 'dragstart' event fired on.
* @param {DragEvent}   event   - The native browser dragstart event.
* @param {Object}      options
* @param {HTMLElement} options.section_record_node - The containing section record row element.
* @param {number}      options.paginated_key       - 0-based index of the record in the paginated results.
* @param {number}      options.total_records       - Total record count (available for drop handlers).
* @param {Object}      options.value               - Locator: `{ section_tipo, section_id }`.
* @param {Object}      options.caller              - The section instance that owns this record.
* @param {HTMLElement} options.drag_node           - Element used as the custom drag image.
* @returns {boolean} Always true.
*/
export const on_dragstart = function(node, event, options) {
	event.stopPropagation();

	// will be necessary the original locator (send as value) of the section_record and the paginated_key (the position in the array of data)
	const transfer_data = {
		value			: options.value,
		paginated_key	: options.paginated_key
	}

	// the data will be transfer to drop in text format
	const data = JSON.stringify(transfer_data)

	// event.dataTransfer.effectAllowed = 'c';
	event.dataTransfer.setData('text/plain', data);

	// style the drag element to be showed in drag mode
	node.classList.add('dragging')

	event.dataTransfer.setDragImage(options.drag_node, 0, 20);


	return true
}//end ondrag_start



// @license-end
