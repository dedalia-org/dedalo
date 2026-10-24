// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {render_node_info} from '../../../core/common/js/utils/notifications.js'



/**
* RENDER_TOOL_NUMISDATA_EPIGRAPHY
* Client-side view layer for the tool_numisdata_epigraphy tool.
*
* This module provides the DOM-building logic for the numismatic epigraphy tool,
* a specialist interface for transcribing legends, designs, symbols, marks, and
* edge descriptions on coins and other numismatic objects.
*
* Layout overview:
*   The edit view is divided into two columns:
*     - left_container  : renders the epigraphy thesaurus component, used to pick
*                         glyphs and Unicode characters for epigraphic transcription.
*     - right_container : renders up to ten portal/autocomplete sub-components
*                         (coins, obverse/reverse legend, design, symbol, mark, and
*                         edge design/legend) together with read-only text containers
*                         that mirror each autocomplete's current saved value.
*
* The text containers are kept in sync via `update_text_nodes`, which is called on
* the initial render and re-called each time a portal component fires a 'save_*'
* event through event_manager.
*
* Prototype methods mixed into tool_numisdata_epigraphy:
*   edit — builds and returns the full wrapper HTMLElement (or content_data only
*           when render_level === 'content').
*
* Private helpers (module-scope, not exported):
*   get_content_data_edit  — builds the two-column content area.
*   render_activity_info   — builds the save-notification bar in the tool header.
*/



/**
* RENDER_TOOL_NUMISDATA_EPIGRAPHY
* Constructor stub for the render prototype chain.
* The real instance state lives in tool_numisdata_epigraphy; this constructor
* is only used to hang prototype methods that are then mixed in via:
*   tool_numisdata_epigraphy.prototype.edit = render_tool_numisdata_epigraphy.prototype.edit
*/
export const render_tool_numisdata_epigraphy = function() {

	return true
}//end render_tool_numisdata_epigraphy



/**
* EDIT
* Builds the full edit-mode DOM node for the tool.
*
* When render_level is 'content', only the inner content_data fragment is returned
* (used by framework refresh cycles that swap content without rebuilding the outer
* wrapper). For 'full' (the default), a complete wrapper is built via
* ui.tool.build_wrapper_edit and the activity-info bar is attached.
*
* @param {Object} [options={render_level:'full'}] - Render options.
*   @param {string} [options.render_level='full'] - 'full' returns the outer wrapper;
*                                                   'content' returns only content_data.
* @returns {Promise<HTMLElement>} The wrapper element (full mode) or content_data element
*                                  (content mode), both ready to be inserted into the DOM.
*/
render_tool_numisdata_epigraphy.prototype.edit = async function(options={render_level:'full'}) {

	const self = this

	// render level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})

	// render_activity_info are the information of the activity as "Save"
		const activity_info = render_activity_info(self)
		wrapper.activity_info_container.appendChild(activity_info)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the two-column interior of the tool's edit view.
*
* Structure produced (appended to a DocumentFragment, then wrapped by
* ui.tool.build_content_data):
*
*   fragment
*   ├── left_container
*   │   └── epigraphy component node (thesaurus for picking glyphs)
*   └── right_container
*       ├── coins_container          (coins portal)
*       ├── legends_container        (obverse_legend + reverse_legend portals)
*       ├── legends_text_container   (mirrored text read-outs for each legend)
*       ├── desings_container        (obverse_desing + reverse_desing portals)
*       ├── desings_text_container   (mirrored text read-outs for each design)
*       ├── symbols_container        (obverse_symbol + reverse_symbol portals)
*       ├── symbols_text_container   (mirrored text read-outs for each symbol)
*       ├── marks_container          (obverse_mark + reverse_mark portals)
*       ├── marks_text_container     (mirrored text read-outs for each mark)
*       ├── edges_container          (edge_desing + edge_legend portals)
*       └── edges_text_container     (mirrored text read-outs for edge fields)
*
* Each portal sub-component subscribes to its own 'save_<id_base>' event so that
* the accompanying text container refreshes automatically after the user saves.
*
* Pointers for external consumers are stored directly on the returned content_data:
*   content_data.left_container  {HTMLElement}
*   content_data.right_container {HTMLElement}
*
* @param {Object} self - The tool_numisdata_epigraphy instance. Sub-components are read
*                        from self.epigraphy, self.coins, self.obverse_legend, etc.
* @returns {Promise<HTMLElement>} The fully populated content_data element.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// left_container
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'left_container',
			parent			: fragment
		})

	// component_epigraphy. render another node of component caller and append to container
		if (self.epigraphy) {
			const epigraphy_node = await self.epigraphy.render()
			left_container.appendChild(epigraphy_node)
		}

	// common update nodes function, use for autocompletes to generate the target text_areas
		/**
		* UPDATE_TEXT_NODES
		* Clears and repopulates a read-only text container to reflect the current saved
		* value of a portal (autocomplete) sub-component.
		*
		* Called on initial render and on every 'save_<id_base>' event emitted by the
		* matching portal. For each item in caller.data.value the function:
		*   1. Calls self.get_component() to load (or reuse) a text component instance
		*      for that specific section_tipo/section_id pair.
		*   2. Renders the component and appends the resulting node to `node`.
		*   3. Issues a related_search 'count' request and appends a <span class="count">
		*      that reads "Used in: N" so editors know how widely used the epigraphy is.
		*
		* @param {Object} options
		*   @param {Object} options.caller - The portal sub-component whose data is being mirrored
		*                                    (e.g. self.obverse_legend). Must have .data.value array.
		*   @param {HTMLElement} options.node   - The container element to repopulate.
		*   @param {string}      options.role   - ddo_map role key used to look up the text
		*                                         component descriptor (e.g. 'legend_text').
		*   @param {string}      options.name   - Property name on self to store the loaded
		*                                         component instance (e.g. 'obverse_legend_text').
		* @returns {Promise<void>}
		*/
		const update_text_nodes = async function (options){
			// options
			const caller		= options.caller
			const node			= options.node
			const role			= options.role
			const name			= options.name

			// clean the text container
			while (node.firstChild) {
				node.removeChild(node.firstChild);
			}
			// create and render new nodes and add to text container
			if(caller.data && caller.data.value){
				const value = caller.data.value
				const value_len = value.length
				for (let i = 0; i < value_len; i++) {
					const current_value = value[i]
					// load or reuse a component instance that represents this locator's text field
					const new_component = await self.get_component({
						data : current_value,
						role : role,
						name : name
					})
					const new_text_node = await new_component.render()
					node.appendChild(new_text_node)

					// append a usage-count badge so editors can judge how often this glyph/legend is used
					const result_relations = await self.get_relations({
						data : current_value,
						role : role,
						name : name,
						count: true
					})
					const count_node = ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'count',
						text_content	: self.get_tool_label('used_in') +': '+result_relations.total,
						parent 			: new_text_node
					})
				}
			}// end if(data)
		}// end update_text_nodes()


	// right_container
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'right_container',
			parent 			: fragment
		})

		// Coins
			const coins_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'coins_container',
				parent 			: right_container
			})

			// await self.coins.build(true)
			if (self.coins) {
				const coins_node = await self.coins.render()
				coins_container.appendChild(coins_node)
			}

		// legends nodes
			const legends_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'portal_container legends_container',
				parent 			: right_container
			})

				if (self.obverse_legend) {
					const obverse_legend_node = await self.obverse_legend.render()
					legends_container.appendChild(obverse_legend_node)
					// subscribe so text mirrors refresh whenever the obverse legend portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.obverse_legend.id_base, update_obverse_legend)
					)
				}
				/**
				* UPDATE_OBVERSE_LEGEND
				* Event handler that refreshes the obverse-legend text container after a save.
				* Hoisted via function declaration so it is available before subscription setup.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_obverse_legend(options) {
					update_text_nodes({
						caller		: self.obverse_legend,
						node		: obverse_legend_text_container,
						role		: 'legend_text',
						name		: 'obverse_legend_text',
					})
				}

				if (self.reverse_legend) {
					const reverse_legend_node = await self.reverse_legend.render()
					legends_container.appendChild(reverse_legend_node)
					// subscribe so text mirrors refresh whenever the reverse legend portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.reverse_legend.id_base, update_reverse_legend)
					)
				}
				/**
				* UPDATE_REVERSE_LEGEND
				* Event handler that refreshes the reverse-legend text container after a save.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_reverse_legend(options) {
					update_text_nodes({
						caller	: self.reverse_legend,
						node	: reverse_legend_text_container,
						role	: 'legend_text',
						name	: 'reverse_legend_text'
					})
				}
				const legends_text_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'portal_container legends_container',
					parent 			: right_container
				})
					const obverse_legend_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container obverse_legend_text_container',
						parent 			: legends_text_container
					})

					const reverse_legend_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container reverse_legend_text_container',
						parent 			: legends_text_container
					})

				// first load of the text data
					if (self.obverse_legend) update_obverse_legend()
					if (self.reverse_legend) update_reverse_legend()

		// Designs nodes
			const desings_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'portal_container desings_container',
				parent 			: right_container
			})

				if (self.obverse_desing) {
					const obverse_desing_node = await self.obverse_desing.render()
					desings_container.appendChild(obverse_desing_node)
					// subscribe so text mirrors refresh whenever the obverse design portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.obverse_desing.id_base, update_obverse_desing)
					)
				}
				/**
				* UPDATE_OBVERSE_DESING
				* Event handler that refreshes the obverse-design text container after a save.
				* Note: 'desing' is the identifier used throughout the ontology (not a typo to fix here).
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_obverse_desing(options) {
					update_text_nodes({
						caller	: self.obverse_desing,
						node	: obverse_desing_text_container,
						role	: 'desing_text',
						name	: 'obverse_desing_text'
					})
				}

				if (self.reverse_desing) {
					const reverse_desing_node = await self.reverse_desing.render()
					desings_container.appendChild(reverse_desing_node)
					// subscribe so text mirrors refresh whenever the reverse design portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.reverse_desing.id_base, update_reverse_desing)
					)
				}
				/**
				* UPDATE_REVERSE_DESING
				* Event handler that refreshes the reverse-design text container after a save.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_reverse_desing(options) {
					update_text_nodes({
						caller	: self.reverse_desing,
						node	: reverse_desing_text_container,
						role	: 'desing_text',
						name	: 'reverse_desing_text'
					})
				}
				const desings_text_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'portal_container desings_container',
					parent 			: right_container
				})
					const obverse_desing_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container obverse_desing_text_container',
						parent 			: desings_text_container
					})
					const reverse_desing_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container reverse_desing_text_container',
						parent 			: desings_text_container
					})
				// first load of the text data
					if (self.obverse_desing) update_obverse_desing()
					if (self.reverse_desing) update_reverse_desing()

		// symbols nodes
			const symbols_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'portal_container symbols_container',
				parent 			: right_container
			})

				if (self.obverse_symbol) {
					const obverse_symbol_node = await self.obverse_symbol.render()
					symbols_container.appendChild(obverse_symbol_node)
					// subscribe so text mirrors refresh whenever the obverse symbol portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.obverse_symbol.id_base, update_obverse_symbol)
					)
				}
				/**
				* UPDATE_OBVERSE_SYMBOL
				* Event handler that refreshes the obverse-symbol text container after a save.
				* Note: symbols use the 'desing_text' role (shared with design fields in the ddo_map).
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_obverse_symbol(options) {
					update_text_nodes({
						caller	: self.obverse_symbol,
						node	: obverse_symbol_text_container,
						role	: 'desing_text',
						name	: 'obverse_symbol_text'
					})
				}

				if (self.reverse_symbol) {
					const reverse_symbol_node = await self.reverse_symbol.render()
					symbols_container.appendChild(reverse_symbol_node)
					// subscribe so text mirrors refresh whenever the reverse symbol portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.reverse_symbol.id_base, update_reverse_symbol)
					)
				}
				/**
				* UPDATE_REVERSE_SYMBOL
				* Event handler that refreshes the reverse-symbol text container after a save.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_reverse_symbol(options) {
					update_text_nodes({
						caller	: self.reverse_symbol,
						node	: reverse_symbol_text_container,
						role	: 'desing_text',
						name	: 'reverse_symbol_text'
					})
				}
				const symbols_text_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'portal_container symbols_container',
					parent 			: right_container
				})
					const obverse_symbol_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container obverse_symbol_text_container',
						parent 			: symbols_text_container
					})
					const reverse_symbol_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container reverse_symbol_text_container',
						parent 			: symbols_text_container
					})
				// first load of the text data
					if (self.obverse_symbol) update_obverse_symbol()
					if (self.reverse_symbol) update_reverse_symbol()

		// marks nodes
			const marks_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'portal_container marks_container',
				parent 			: right_container
			})

				if (self.obverse_mark) {
					const obverse_mark_node = await self.obverse_mark.render()
					marks_container.appendChild(obverse_mark_node)
					// subscribe so text mirrors refresh whenever the obverse mark portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.obverse_mark.id_base, update_obverse_mark)
					)
				}
				/**
				* UPDATE_OBVERSE_MARK
				* Event handler that refreshes the obverse-mark text container after a save.
				* Marks (countermarks/control marks) use the dedicated 'mark_text' role.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_obverse_mark(options) {
					update_text_nodes({
						caller	: self.obverse_mark,
						node	: obverse_mark_text_container,
						role	: 'mark_text',
						name	: 'obverse_mark_text'
					})
				}

				if (self.reverse_mark) {
					const reverse_mark_node = await self.reverse_mark.render()
					marks_container.appendChild(reverse_mark_node)
					// subscribe so text mirrors refresh whenever the reverse mark portal is saved
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.reverse_mark.id_base, update_reverse_mark)
					)
				}
				/**
				* UPDATE_REVERSE_MARK
				* Event handler that refreshes the reverse-mark text container after a save.
				* @param {Object} options - Event payload from event_manager (unused but forwarded).
				* @returns {void}
				*/
				function update_reverse_mark(options) {
					update_text_nodes({
						caller	: self.reverse_mark,
						node	: reverse_mark_text_container,
						role	: 'mark_text',
						name	: 'reverse_mark_text'
					})
				}
				const marks_text_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'portal_container marks_container',
					parent 			: right_container
				})
					const obverse_mark_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container obverse_mark_text_container',
						parent 			: marks_text_container
					})
					const reverse_mark_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container reverse_mark_text_container',
						parent 			: marks_text_container
					})
				// first load of the text data
					if (self.obverse_mark) update_obverse_mark()
					if (self.reverse_mark) update_reverse_mark()

 		// edges nodes
			const edges_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'portal_container edges_container',
				parent 			: right_container
			})

				if (self.edge_desing) {
					const edge_desing_node = await self.edge_desing.render()
					edges_container.appendChild(edge_desing_node)
					// subscribe so text mirrors refresh whenever the edge design portal is saved
					// (!) handler is named update_obverse_edge despite being for the edge (not obverse);
					//     name is retained from original code to avoid renaming identifiers.
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.edge_desing.id_base, update_obverse_edge)
					)
				}
				/**
				* UPDATE_OBVERSE_EDGE
				* Event handler that refreshes the edge-design text container after a save.
				* Despite the 'obverse' prefix in the name, this handles the coin edge (not the obverse
				* face); the naming follows the original pattern used across this module.
				* @returns {void}
				*/
				function update_obverse_edge() {
					update_text_nodes({
						caller	: self.edge_desing,
						node	: edge_desing_text_container,
						role	: 'desing_text',
						name	: 'edge_desing_text'
					})
				}

				if (self.edge_legend) {
					const edge_legend_node = await self.edge_legend.render()
					edges_container.appendChild(edge_legend_node)
					// subscribe so text mirrors refresh whenever the edge legend portal is saved
					// (!) handler is named update_reverse_edge despite being for the edge (not reverse)
					self.events_tokens.push(
						event_manager.subscribe('save_'+ self.edge_legend.id_base, update_reverse_edge)
					)
				}
				/**
				* UPDATE_REVERSE_EDGE
				* Event handler that refreshes the edge-legend text container after a save.
				* Despite the 'reverse' prefix in the name, this handles the coin edge legend;
				* the naming follows the original pattern used across this module.
				* @returns {void}
				*/
				function update_reverse_edge() {
					update_text_nodes({
						caller	: self.edge_legend,
						node	: edge_legend_text_container,
						role	: 'legend_text',
						name	: 'edge_legend_text'
					})
				}
				const edges_text_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'portal_container edges_container',
					parent 			: right_container
				})
					const edge_desing_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container edge_desing_text_container',
						parent 			: edges_text_container
					})
					const edge_legend_text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name 		: 'text_container edge_legend_text_container',
						parent 			: edges_text_container
					})
					if (self.edge_desing) update_obverse_edge()
					if (self.edge_legend) update_reverse_edge()

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)
		// save the pointers of the content_data nodes, to used by the buttons to access to the components
		content_data.left_container		= left_container
		content_data.right_container	= right_container


	return content_data
}//end get_content_data_edit



/**
* RENDER_ACTIVITY_INFO
* Builds the activity-info bar that is mounted in the tool wrapper's header area.
*
* The bar subscribes to the global 'save' event. Each time the tool (or any
* child component) triggers a save, fn_saved renders a transient notification node
* via render_node_info and prepends it inside the bar so the most recent status
* appears at the top.
*
* The subscription token is pushed onto self.events_tokens so it is cleaned up by
* the tool's destroy() lifecycle method alongside all other subscriptions.
*
* @param {Object} self - The tool_numisdata_epigraphy instance. Must expose .events_tokens {Array}.
* @returns {HTMLElement} activity_info_body — a div.activity_info_body ready to be appended
*                        to wrapper.activity_info_container.
*/
const render_activity_info = function(self) {

	// activity alert
		const activity_info_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'activity_info_body'
		})

	// event save
		self.events_tokens.push(
			event_manager.subscribe('save', fn_saved)
		)
		/**
		* FN_SAVED
		* Handles the global 'save' event by prepending a notification node into
		* the activity_info_body bar.
		* @param {Object} options - Event payload; must include .instance and .api_response
		*                           (as required by render_node_info). A container pointer
		*                           is injected before being forwarded.
		*/
		function fn_saved(options) {

			// recived options contains an object with instance and api_response
			const node_info_options = Object.assign(options,{
				container : activity_info_body
			})

			// render notification node
			const node_info = render_node_info(node_info_options)
			activity_info_body.prepend(node_info)
		}


	return activity_info_body
}//end render_activity_info



// @license-end
