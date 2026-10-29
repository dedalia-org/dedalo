// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_CATALOGING
*
* Client-side render layer for tool_cataloging — the Dédalo cataloging tool
* that lets users group and hierarchize cultural-asset records into a thesaurus
* tree through drag-and-drop.
*
* Layout produced by this module is a two-panel split:
*   - Left panel  (left_container):  mosaic view of the section being catalogued
*     (`section_to_cataloging`), rendered with the custom 'tool_cataloging_mosaic'
*     view.  Each record card is draggable onto the right-side thesaurus tree.
*   - Right panel (right_container): the thesaurus area (`area_thesaurus`) whose
*     tree nodes are the classification targets.  Dropping a record card on a
*     thesaurus node triggers the 'ts_add_child_tool_cataloging' event, which is
*     handled by tool_cataloging.prototype.init (see tool_cataloging.js) and
*     writes a locator into the matching component_portal on the new term section.
*
* The only public surface added to tool_cataloging.prototype by this module is:
*   - render_tool_cataloging.prototype.edit — renders the full tool DOM.
*
* The module also exports the `render_tool_cataloging` constructor itself (used
* by tool_cataloging.js via prototype assignment).
*
* Dependencies:
*   - event_manager  — pub/sub bus used to receive 'save' events for activity-info
*                      feedback and to forward 'ts_add_child_tool_cataloging' events.
*   - ui             — DOM builder helpers (ui.tool.build_wrapper_edit,
*                      ui.tool.build_content_data, ui.create_dom_element).
*   - render_node_info — creates a status-bubble node for save feedback.
*
* Exports: {Function} render_tool_cataloging
*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {render_node_info, prepend_bubble} from '../../../core/common/js/utils/notifications.js'



/**
* RENDER_TOOL_CATALOGING
* Constructor (no-op body; all logic lives on the prototype).
* Instantiated indirectly: tool_cataloging assigns its `edit` prototype method
* from render_tool_cataloging.prototype.edit.
* @returns {boolean} true
*/
export const render_tool_cataloging = function() {

	return true
}//end render_tool_cataloging



/**
* EDIT
* Builds and returns the full tool wrapper DOM for the cataloging tool.
*
* When `render_level` is 'content', the method short-circuits and returns only
* the inner content_data node (used for partial refreshes without rebuilding the
* outer shell).  For the default 'full' level the complete wrapper hierarchy is
* built:
*
*   wrapper (ui.tool.build_wrapper_edit)
*     ├── tool_buttons_container  ← populated by render_header_options
*     ├── activity_info_container ← populated by render_activity_info
*     └── content_data (get_content_data_edit)
*           ├── left_container  ← section_to_cataloging mosaic view
*           └── right_container ← area_thesaurus rendered node
*
* Side effects:
*   - Injects 'tool_cataloging_mosaic' into self.section_to_cataloging.render_views
*     and triggers self.section_to_cataloging.render() asynchronously (result
*     appended to left_container via .then).
*   - Triggers self.area_thesaurus.render() asynchronously (result appended to
*     right_container via .then; right_container.area_thesaurus_node pointer set).
*   - Sets self.node to the returned wrapper.
*   - Subscribes to the 'save' event via render_activity_info (token stored in
*     self.events_tokens for later cleanup).
*
* @param {Object} [options={render_level:'full'}] - Render configuration.
* @param {string} [options.render_level='full'] - 'full' builds the entire wrapper;
*   'content' returns only the content_data node.
* @returns {Promise<HTMLElement>} The tool wrapper element (render_level='full') or
*   the content_data element (render_level='content').
*/
render_tool_cataloging.prototype.edit = async function(options={render_level:'full'}) {

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
		// set pointers
		wrapper.content_data = content_data

	// tool options are the buttons to get access to other tools (buttons in the header)
		const header_options_node = await render_header_options(self, content_data)
		wrapper.tool_buttons_container.appendChild(header_options_node)

	// render_activity_info are the information of the activity as "Save"
		const activity_info = render_activity_info(self)
		wrapper.activity_info_container.appendChild(activity_info)
		self.node = wrapper


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the two-panel content layout (left: mosaic section list, right: thesaurus).
*
* The function creates a DocumentFragment containing two sibling divs:
*   - left_container  — will hold the section_to_cataloging mosaic view once its
*     async render resolves.  Before calling section.render() the custom view
*     descriptor for 'tool_cataloging_mosaic' is pushed into the section's
*     render_views array and self.section_to_cataloging.view is explicitly set so
*     the section picks the correct view at render time.
*   - right_container — will hold the area_thesaurus node once its async render
*     resolves.  A convenience pointer (right_container.area_thesaurus_node) is
*     set on resolution for downstream access.
*
* Both renders are fire-and-forget .then() chains; the returned content_data node
* is ready immediately and the child nodes are appended when available.
*
* Cross-references on the returned node:
*   content_data.left_container  — {HTMLElement} the left panel div
*   content_data.right_container — {HTMLElement} the right panel div
*
* @param {Object} self - The tool_cataloging instance.
* @param {Object} self.section_to_cataloging - Section instance for the items
*   being catalogued; must expose render_views, view, and render().
* @param {Object} self.area_thesaurus - Area/thesaurus instance; must expose render().
* @returns {Promise<HTMLElement>} The content_data wrapper element.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// left_container
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'left_container',
			parent			: fragment
		})

		// section_to_cataloging section. render another node of component caller and append to container
			self.section_to_cataloging.render_views.push(
				{
					view	: 'tool_cataloging_mosaic',
					mode	: 'list',
					render	: 'view_tool_cataloging_mosaic',
					path 	: '../../../tools/tool_cataloging/js/view_tool_cataloging_mosaic.js'
				}
			)
			// view . Note that view is set in properties, but it set again to clarify the code
			self.section_to_cataloging.view = 'tool_cataloging_mosaic'
			self.section_to_cataloging.render()
			.then(function(section_node){
				left_container.appendChild(section_node)
			})

	// right_container
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'right_container',
			parent 			: fragment
		})

		// thesaurus render
			self.area_thesaurus.render()
			.then(function(node){
				right_container.appendChild(node)
				// fix pointer
				right_container.area_thesaurus_node = node
			})


	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)
		// save the pointers of the content_data nodes, to be used by the buttons to access to the components
		content_data.left_container		= left_container
		content_data.right_container	= right_container


	return content_data
}//end get_content_data_edit




/**
* RENDER_HEADER_OPTIONS
* Builds optional action buttons for the tool header's tool_buttons_container.
*
* Currently returns an empty DocumentFragment — the slot is reserved for future
* header buttons (e.g. filter, export, settings).  The async signature is kept
* consistent with other tools that do populate this area.
*
* @param {Object}      self         - The tool_cataloging instance.
* @param {HTMLElement} content_data - The rendered content_data node (may be used
*   by future buttons to access left_container / right_container pointers).
* @returns {Promise<DocumentFragment>} Empty fragment (placeholder).
*/
const render_header_options = async function(self, content_data) {

	const fragment = new DocumentFragment()

	return fragment
}//end render_header_options



/**
* RENDER_ACTIVITY_INFO
* Builds the activity-info feedback area shown in the tool header's
* activity_info_container.
*
* Subscribes to the global 'save' event.  Whenever a save completes (regardless
* of which component triggered it), the received `options` object is merged with
* a `container` reference and passed to render_node_info(), which creates a
* status bubble (success or error) that is prepended to the activity_info_body
* div so the most recent result appears at the top.
*
* The event subscription token is stored in self.events_tokens so that it is
* cleaned up when the tool is destroyed via common.prototype.destroy.
*
* Shape of the 'save' event payload (options):
*   {Object}      options.instance     — the component/section that was saved
*   {Object|null} options.api_response — server response {result, msg, error}
*
* @param {Object}   self - The tool_cataloging instance.
* @param {string[]} self.events_tokens - Token array; the new subscription token
*   is pushed here for lifecycle management.
* @returns {HTMLElement} activity_info_body — a div that accumulates save-event
*   status bubbles as children.
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
		function fn_saved(options) {

			// revived options contains an object with instance and api_response
			const node_info_options = Object.assign(options,{
				container : activity_info_body
			})

			// render notification node
			const node_info = render_node_info(node_info_options)
			prepend_bubble(activity_info_body, node_info)
		}


	return activity_info_body
}//end render_activity_info



// @license-end
