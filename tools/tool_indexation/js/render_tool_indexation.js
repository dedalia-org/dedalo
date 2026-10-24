// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {when_in_viewport, set_before_unload} from '../../../core/common/js/events.js'
	import {ui} from '../../../core/common/js/ui.js'
	import Split from '../../../lib/split/dist/split.es.js'



/**
* RENDER_TOOL_INDEXATION
* Client-side render module for tool_indexation.
*
* This module provides the prototype methods that build the tool_indexation
* DOM tree. It is mixed into tool_indexation via the prototype-assignment
* pattern (tool_indexation.prototype.edit = render_tool_indexation.prototype.edit).
*
* Layout overview
* ───────────────
* The tool splits the viewport into two resizable panes using the Split.js
* library (see https://github.com/nathancahill/split/tree/master/packages/splitjs):
*
*   left_container  — the selected viewer: thesaurus, media or people. Swapped
*                     by the toolbar's "Show" select, which never touches
*                     right_container.
*   right_container — stacked panels:
*     1. transcription_component  : component_text_area where the user edits
*                                   the transcription and creates index tags.
*     2. info_container           : tabbed panel with three tabs:
*          • Indexation  – the indexing_component (component_portal) that stores
*                          locators linking tag ranges to thesaurus terms.
*          • Info        – the indexation_note panel (tag annotation text).
*          • References  – the references_component (inverse relations).
*     3. tag_info_container       : floating panel that appears when the user
*                                   clicks an existing index tag; shows the tag
*                                   id, state selector, and delete button.
*
* Toolbar controls (appended to wrapper.tool_buttons_container):
*   • render_related_list   — "Approach" <select> for choosing the top-section
*                             locator (section_tipo + section_id) that scopes
*                             the current indexation session.
*   • render_viewer_selector — "Show" <select> that swaps the LEFT pane viewer.
*   • render_status         — status components for users and admins.
*
* All functions in this module are module-private except the constructor and
* the edit prototype method, which is the sole export surface.
*
* @module render_tool_indexation
*/
export const render_tool_indexation = function() {

	return true
}//end render_tool_indexation



/**
* EDIT
* Builds and returns the full tool wrapper node for edit mode.
*
* Orchestrates the high-level DOM assembly:
*   1. Calls get_content_data_edit to build the split-pane content area.
*   2. Wraps it with ui.tool.build_wrapper_edit (standard tool chrome).
*   3. Appends toolbar controls (related_list, viewer_selector, status).
*   4. Fires get_tag_info to wire up the tag-click info panel.
*
* When options.render_level is 'content', the raw content_data element is
* returned directly (skipping the wrapper), which is used by the framework
* for partial refreshes.
*
* @param {Object} [options={render_level:'full'}] - Render options.
*   @param {string} [options.render_level='full'] - 'full' returns the complete
*     wrapper; 'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} The assembled wrapper (or content_data if
*   render_level is 'content').
*/
render_tool_indexation.prototype.edit = async function (options={render_level:'full'}) {

	const self = this

	// render level
		const render_level = options.render_level || 'full'

	// mount_lang_field
	// The transcription lang field is BUILT with the pane (it closes over the
	// component it swaps) but LIVES in the tool's controls band. A 'content'
	// render rebuilds the pane and not the band, so the fresh field replaces the
	// stale one in place — left alone, the band would keep a select still
	// addressing a detached component container.
		const mount_lang_field = function(node) {
			if (!node) return
			if (self.lang_selector_container && self.lang_selector_container.isConnected) {
				self.lang_selector_container.replaceWith(node)
			}
			self.lang_selector_container = node
		}

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			mount_lang_field(content_data.lang_selector_container)
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})

		// fix pointers
		wrapper.content_data = content_data

		// viewer_selector. Swaps the LEFT pane between thesaurus / people / media.
		// It sits in the toolbar beside Approach: both are captioned controls of the
		// same shape in the same row, and the caption ("Show") plus its tooltip carry
		// the scope that the position used to have to explain.
		const viewer_selector = render_viewer_selector(self, content_data.left_container)
		wrapper.tool_buttons_container.appendChild(viewer_selector.node)

		// transcription lang. Built in get_content_data_edit (it closes over the
		// transcription component it swaps) but mounted HERE: in the pane it used
		// to sit in, the editor toolbar covers its row while editing — which is
		// precisely when the user wants to change the transcription language.
		wrapper.tool_buttons_container.appendChild(content_data.lang_selector_container)
		self.lang_selector_container = content_data.lang_selector_container

	// related_list. This is used to build a select element to allow user select the top_section_tipo and top_section_id of current indexation
		const related_list_node = render_related_list(self)
		wrapper.tool_buttons_container.appendChild(related_list_node)

		// (!) restore the stored viewer only once the eagerly rendered thesaurus
		// node exists — the 'area_thesaurus' branch of the change handler needs
		// it, and this toolbar is built while that render is still in flight.
		content_data.left_container.area_thesaurus_ready
			.then(() => viewer_selector.apply_stored_viewer())

	// status, render the status components for users and admins to control the process of the tool
		const status_container = await render_status(self)
		wrapper.tool_buttons_container.appendChild(status_container)

	// get_tag_info. Fires build tag info panel nodes at begin
		get_tag_info(self)

	// caller_options.tag_id. The tool can be opened already positioned on one
	// tag — the indexation grid's tag buttons (dd_grid view_indexation) send the
	// clicked fragment's tag_id through caller_options. select_tag republishes
	// the normal click event, so the editor selects and scrolls to the tag and
	// every panel here lights up exactly as on a user click. It self-defers
	// until the CKEditor service is ready (it is not, at this point).
		const caller_tag_id = self.caller_options?.tag_id ?? null
		if (caller_tag_id!==null && self.transcription_component) {
			self.transcription_component.select_tag(caller_tag_id)
		}


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the split-pane content area that forms the body of the tool.
*
* Creates the left_container / right_container pair, populates them, then
* activates the Split.js resizer once the left_container enters the viewport
* (to avoid layout thrash before the DOM is visible, and to skip the split on
* small/mobile screens where innerWidth < 800 px).
*
* Left pane:
*   • area_thesaurus rendered asynchronously; its node reference is kept as
*     left_container.area_thesaurus_node so the viewer selector can show/hide
*     it without re-rendering.  The render promise is kept as
*     left_container.area_thesaurus_ready so edit() can defer the stored-viewer
*     restore until that node exists.
*
* Right pane (top to bottom):
*   • transcription_component_container
*       – lang_selector  : <select> that lets the user switch the display
*         language of the transcription.  If the component has unsaved changes
*         (is_data_changed === true) the user is prompted before switching.
*         After confirmation a new component instance is fetched via
*         self.get_component(lang) and rendered in its place.
*       – transcription_component : the actual component_text_area.  An "(Original)"
*         suffix is appended to the matching option if the component's current lang
*         differs from the session lang (self.lang), signalling that the original
*         language was auto-selected.
*   • info_container
*       – tag_info        : hosts tag_info_container (the floating tag-detail
*                           panel, hidden by default via CSS class 'hide').
*       – Three tab labels (Indexation / Info / References) that toggle the
*         active CSS class on themselves and on their linked component_node
*         through the local activate_tab closure.
*   • indexation_container
*       – component_indexing_container  : wraps indexing_component (component_portal).
*       – indexation_note               : container for the tag annotation note view.
*   • references_container
*       – component_references_container : wraps references_component. The
*         instance is normally DEFERRED (built by the References tab click via
*         _ensure_lazy_instance), so an absent instance here is the expected
*         state, not an error. When the role is missing from the ddo_map
*         entirely, the References tab is not created at all.
*
* Side effects:
*   • self.info_container, self.indexation_note, self.tag_info_container are
*     set as direct properties on self for later access by get_tag_info and
*     the event handlers in tool_indexation.js.
*   • content_data.left_container is set so edit() can hand the left pane to
*     render_viewer_selector, and left_container.area_thesaurus_ready is the
*     render promise it waits on.
*
* @param {Object} self - The tool_indexation instance.
* @returns {Promise<HTMLElement>} The content_data wrapper element, ready to be
*   inserted into the tool's wrapper node.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// left_container (viewer selector + the selected viewer)
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			id				: 'left_container',
			class_name		: 'left_container',
			parent			: fragment
		})

		// thesaurus render.
		// The promise is kept ON the pane: the viewer selector is built later (in
		// edit(), for the toolbar) and has to wait for area_thesaurus_node before
		// it can restore the stored viewer.
			left_container.area_thesaurus_ready = self.area_thesaurus.render()
			.then(function(node){
				left_container.appendChild(node)
				// fix pointer
				left_container.area_thesaurus_node = node
			})

	// right_container (component_text_area && component_portal)
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			id				: 'right_container',
			class_name		: 'right_container',
			parent			: fragment
		})

		// top_right
		// Pane header for the transcription: it names the pane, and while the
		// editor is focused the ck toolbar takes this row over (see
		// @transcription_chrome_height in the tool css) so the text keeps every
		// line. That takeover is WHY the lang select is not here any more: a
		// control the toolbar hides is a control the user cannot reach exactly
		// when they are working. It lives in the tool's controls band instead,
		// beside Show / Approach, reachable in both states.
			const top_right = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'top transcription_top',
				parent			: right_container
			})

			// lang_selector_container. A band field: caption + control inline, the
			// same shape as .viewer_selector_container. It is appended to
			// wrapper.tool_buttons_container by edit() — the pointer below is how
			// it gets there, since this function builds the content, not the header.
				const lang_selector_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'lang_selector_container'
				})

			// lang_selector
				const lang_selector = ui.build_select_lang({
					selected	: self.transcription_component.lang,
					// alphabetical: the transcription lang is picked by NAME here, and
					// the project order buries a lang in a long list
					sort		: true,
					class_name	: 'dd_input selector'
				})
				lang_selector.addEventListener('change', async function(e){

					// unsaved data confirm on true
						if (self.transcription_component.is_data_changed===true) {
							if (!confirm(get_label.discard_changes || 'Discard changes?')) {
								// restore previous value lang and stop
								this.value = self.transcription_component.lang
								return
							}
						}

					// create new one
						const component = await self.get_component(e.target.value)
						// set auto_init_editor for convenience
						component.auto_init_editor = true
						// show_interface
						component.show_interface.tools = false
						component.render()
						.then(function(node){
							// remove previous node. (!) the lang select lives in the
							// tool controls band now, so nothing is preserved here.
							transcription_component_container.replaceChildren()
							// add the new component to the container
							transcription_component_container.appendChild(node)
							// console.log("self.transcription_component.is_data_changed:",self.transcription_component.is_data_changed);
						})
				})
				// caption of the band field. The band's other fields are captioned
				// (Show, Approach…) — an uncaptioned select among them would be the
				// only control there without a name.
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'top_label',
						inner_html		: (get_label.language || 'Language'),
						parent			: lang_selector_container
					})
					lang_selector_container.appendChild(lang_selector)

			// caption. Named by the component itself, so an install that renames
			// the transcription field sees its own wording. It is the whole content
			// of the pane header now — the row the ck toolbar borrows while the
			// editor is focused.
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'top_label',
					inner_html		: self.transcription_component.label || '',
					parent			: top_right
				})

		// transcription_component (component_text_area)
			const transcription_component_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'transcription_component_container',
				parent			: right_container
			})

			// transcription_component. render another node of component caller and append to container
				const transcription_component = self.transcription_component || await self.get_component(self.lang)
				// set auto_init_editor = true to force init editor instead use user click to activate it
				transcription_component.auto_init_editor = true
				// show_interface
				transcription_component.show_interface.tools = false

				const transcription_component_node = await transcription_component.render()
				transcription_component_container.appendChild(transcription_component_node)

			// Original lang set label
				if (transcription_component.lang!==self.lang) {
					const label					= get_label.original || 'Original'
					const lang_selector_options	= Array.from(lang_selector.options);
					const option_to_select		= lang_selector_options.find(item => item.value===transcription_component.lang);
					if (option_to_select) {
						option_to_select.text = option_to_select.text + ' ('+label+')'
					}
				}

		// info container
			const info_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_container',
				parent			: right_container
			})
			// fix
			self.info_container = info_container

		// tag_info
			const tag_info = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'tag_info',
				parent			: info_container
			})

		// indexation_container
			const indexation_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'indexation_container',
				parent			: right_container
			})

			// indexing_component (component_portal)
				const component_indexing_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'component_indexing_container tab active',
					parent			: indexation_container
				})
				self.indexing_component.render()
				.then(function(indexing_component_node){
					component_indexing_container.appendChild(indexing_component_node)
				})

		// info (indexation note)
			const indexation_note = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'indexation_note tab',
				parent			: indexation_container
			})
			// fix
			self.indexation_note = indexation_note

		// references component
		// configured = built already, or deferred and buildable on tab click.
		// Anything else means the ontology does not declare the role at all.
			const has_references = !!(self.references_component || self._lazy_ddos?.references_component)

			const references_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'indexation_container',
				parent			: right_container
			})

			const component_references_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'component_indexing_container tab',
				parent			: references_container
			})
			// fix pointer so the tab click handler can lazily render into it
			self.component_references_container = component_references_container

			// (!) three states, not two: an ALREADY BUILT instance renders here and
			// now; a DEFERRED one (the normal case — build() sets autoload:false and
			// the References tab click calls _ensure_lazy_instance) is silent, its
			// render belongs to that click; only a role absent from the ddo_map is
			// worth a line, and it is a warn — references is an optional role.
			const references_component = self.references_component
			if (references_component) {
				references_component.render()
				.then(function(references_component_node){
					component_references_container.appendChild(references_component_node)
				})
			}else if (!self._lazy_ddos?.references_component) {
				console.warn('Ignored references_component: role not defined in tool_config.ddo_map')
			}

		// tag_info_container. line info about tag
			const tag_info_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'tag_info_container hide',
				parent			: tag_info
			})
			// fix node
			self.tag_info_container = tag_info_container

			const tab_nodes = []

			// activate_tab
			// Switches the active CSS class between tab label nodes and their
			// corresponding component_node panels.  Only the tab matching `name`
			// receives the 'active' class; all others lose it.
			const activate_tab = function( name ){

				const tab_nodes_len = tab_nodes.length

				for (let i = tab_nodes_len - 1; i >= 0; i--) {
					const current_tab = tab_nodes[i]

					if(current_tab.name === name){
						current_tab.node.classList.add('active')
						current_tab.component_node.classList.add('active')
					}else{
						current_tab.node.classList.remove('active')
						current_tab.component_node.classList.remove('active')
					}
				}
			}

			// tab_indexation
				const tab_indexation = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'tab_label active',
					inner_html		: 'Indexation',
					parent			: info_container
				})
				tab_indexation.addEventListener('click', function(e){
					e.stopPropagation()
					activate_tab('indexation')
				})

				tab_nodes.push({
					name: 'indexation',
					node: tab_indexation,
					component_node: component_indexing_container
				})

			// tab_info
				const tab_info = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'tab_label',
					inner_html		: 'Info',
					parent			: info_container
				})
				tab_info.addEventListener('click', function(e){
					e.stopPropagation()
					activate_tab('info')
				})

				tab_nodes.push({
					name: 'info',
					node: tab_info,
					component_node: indexation_note
				})

			// tab_references
			// (!) only when the role is configured: a tab that can never show
			// anything is a dead affordance, and the empty panel it opens reads
			// as a data loss rather than as an install choice.
				if (has_references) {
					const tab_references = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'tab_label',
						inner_html		: 'References',
						parent			: info_container
					})
					tab_references.addEventListener('click', async function(e){
						e.stopPropagation()
						// lazy-create the deferred instance on first activation
						if (!self.references_component && self._lazy_ddos?.references_component) {
							self.references_component = await self._ensure_lazy_instance('references_component')
							self.references_component.render()
							.then(function(ref_node){
								self.component_references_container.appendChild(ref_node)
							})
						}
						activate_tab('references')
					})
					tab_nodes.push({
						name: 'references',
						node: tab_references,
						component_node: component_references_container
					})
				}



	// split
	// @see https://github.com/nathancahill/split/tree/master/packages/splitjs
	// The IntersectionObserver callback fires once the left_container is actually
	// in the viewport, ensuring Split.js can read computed sizes correctly.
	// On narrow viewports (< 800 px) the split is skipped to avoid a poor UX.
		when_in_viewport(
			left_container, // node to observe
			() => { // callback
				// don't add on small windows
				if (window.innerWidth<800) {
					return
				}
				Split(['#left_container', '#right_container'], {
					sizes: [45, 55],
					minSize: '40%'
				});
				// console.log("activated Split:", Split);
			}
		)

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)

		// fix pointers
		content_data.left_container = left_container
		// the transcription lang field, built with the pane it belongs to but
		// mounted in the tool's controls band by edit()
		content_data.lang_selector_container = lang_selector_container


	return content_data
}//end get_content_data_edit



/**
* GET_TAG_INFO
* Wires up the tag-detail panel that appears when the user clicks an index tag
* in the transcription text area.
*
* This function is called once during edit() to build and attach the static
* DOM structure of the tag_info_container panel. It then subscribes to two
* reactive values via self.active_value() so the panel stays in sync as the
* user navigates between tags:
*
*   • 'tag_id' callback — unhides the panel, updates the displayed tag ID, and
*     refreshes the delete button label.
*   • 'state' callback  — syncs the state <select> and updates the panel's CSS
*     class to match the current tag state colour (e.g. 'n', 'd', 'r').
*
* Panel contents:
*   • fragment_id_info   : a read-only label showing the current tag_id.
*   • tag_state_selector : a <select> populated from self.label_states
*     (built in tool_indexation.prototype.init).  On change it calls
*     self.transcription_component.update_tag() with type 'indexIn', which the
*     text area expands to update both the indexIn and indexOut markers.
*     After success it calls set_before_unload(true) to signal pending edits
*     (window.unsaved_data is derived state — see the events.js registry).
*   • button_delete      : triggers self.delete_tag(tag_id).  On success the
*     panel is hidden again (class 'hide' added).
*
* (!) tag_id is captured as a mutable let variable that is closed over by all
* event handlers.  The 'tag_id' active_value callback is the sole writer;
* all handlers read the same binding, so there is no stale-closure risk as
* long as update_active_values is always called before the handlers fire.
*
* @param {Object} self - The tool_indexation instance (must have tag_info_container,
*   label_states, transcription_component, delete_tag, and active_value set up
*   before this function is called).
* @returns {boolean} Always returns true.
*/
const get_tag_info = function(self) {

	// tag_id. Set on every user tag item click
		let tag_id	= ''

	// short vars
		const tag_info_container = self.tag_info_container

	// tag id info
		const fragment_id_info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'fragment_id_info',
			parent			: tag_info_container
		})
		// fragment_id_label
		ui.create_dom_element({
			element_type	: 'span',
			inner_html		: get_label.tag || 'Tag',
			parent			: fragment_id_info
		})
		const fragment_id_tag_id = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'fragment_id_tag_id',
			inner_html		: tag_id,
			parent			: fragment_id_info
		})

	// state
		// wrap_tag_state_selector selector
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'wrap_tag_state_selector',
				inner_html		: get_label.state || 'State',
				parent			: tag_info_container
			})
		// state selector
			const tag_state_selector = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'selector tag_state_selector',
				parent			: tag_info_container
			})

			// Populate state options from self.label_states (set in tool_indexation.prototype.init).
			// Values are short codes: 'n' (normal), 'd' (deleted), 'r' (to review).
			for (let k = 0; k < self.label_states.length; k++) {
				ui.create_dom_element({
					element_type	: 'option',
					inner_html		: self.label_states[k].label,
					value			: self.label_states[k].value,
					parent			: tag_state_selector
				})
			}
			tag_state_selector.addEventListener('change', function(){

				const state	= this.value

				self.transcription_component.update_tag({
					type			: 'indexIn', // will be split into ['indexIn','indexOut']
					tag_id			: tag_id,
					new_data_obj	: {
						state : state
					}
				})
				.then(function(){
					// update tag_info_container color matching tag state
					self.label_states.map((el)=>{
						if (el.value===state) {
							tag_info_container.classList.add(el.value)
						}else{
							if (tag_info_container.classList.contains(el.value)) {
								tag_info_container.classList.remove(el.value)
							}
						}
					})
					// self.transcription_component
					// (!) Assert through set_before_unload, never by assigning
					// window.unsaved_data: that flag is DERIVED from the events.js
					// unsaved registry, so a direct write is silently overwritten by
					// the next recompute (any component register/deregister/save on
					// the page). This tool has no component instance to register —
					// the edit lives in the transcription text area — so the coarse
					// instance-less assertion is the right channel.
					set_before_unload(true)
				})
			})

	// delete_tag
		// wrap_delete_tag
		const wrap_delete_tag = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrap_delete_tag',
			parent			: tag_info_container
		})
		// button delete tag
			const button_delete = ui.create_dom_element({
				element_type	: 'span',
				title			: get_label.delete || 'Delete',
				class_name		: 'button remove',
				parent			: wrap_delete_tag
			})
			button_delete.addEventListener('click', function(e) {
				e.stopPropagation()

				// delete_tag
				self.delete_tag(tag_id)
				.then(function(response){

					// show/hide tag_info
					// Hide the panel only when BOTH the tag deletion and locator
					// deletion succeeded; partial failures leave the panel visible
					// so the user can see the error state.
					if (response && !request_failed(response.delete_tag) && !request_failed(response.delete_locator)) {
						const toggle_node = self.tag_info_container // self.info_container
						if (!toggle_node.classList.contains('hide')) {
							toggle_node.classList.add('hide')
						}
					}
				})
			})

	// active values
		// Subscribe to reactive tag_id changes; fired by update_active_values
		// when the user clicks a different index tag in the transcription.
		self.active_value('tag_id', function(value) {

			tag_id							= value // update current tag_id var (let)
			fragment_id_tag_id.textContent	= value // update fragment label

			// show/hide info_container
				if (self.tag_info_container.classList.contains('hide')) {
					self.tag_info_container.classList.remove('hide')
				}
		})
		// Subscribe to reactive state changes; keeps the selector and panel
		// colour class in sync when the tag state is updated externally.
		self.active_value('state', function(value) {

			// fix selector value
				tag_state_selector.value = value

			// update tag_info_container color matching tag state
				self.label_states.map((el)=>{
					if (el.value==value) {
						self.tag_info_container.classList.add(el.value)
					}else{
						if (self.tag_info_container.classList.contains(el.value)) {
							self.tag_info_container.classList.remove(el.value)
						}
					}
				})
		})


	return true;
}//end get_tag_info




/**
* RENDER_RELATED_LIST
* Builds the "Approach" toolbar control — a <select> that lets the user choose
* which top-level section (section_tipo + section_id) scopes the current
* indexation session.
*
* Data source
* ───────────
* self.related_sections_list is the datum returned by
* tool_indexation.prototype.load_related_sections_list().  Its shape is:
*   {
*     context : [ { section_tipo, label, … }, … ],
*     data    : [
*       { typo: 'sections', value: [ { section_tipo, section_id }, … ] },
*       { section_tipo, section_id, value: <display_value> },   // per component
*       …
*     ]
*   }
*
* Each option in the <select> is labelled as:
*   "<section label> | <section_id> | <component values joined by ' | '>"
* The option's value attribute is the composite key
* "<section_tipo>_<section_id>"; the real locator object is attached directly
* as option.locator for easy retrieval on change.
*
* Persistence
* ───────────
* The last-selected option key is stored/retrieved via data_manager's local
* IndexedDB table 'status' under the key 'tool_indexation_approach'.  On load
* the stored value is restored; the visible class 'hidden' is removed only
* after the async read completes to avoid flicker.  When only one option is
* available (value_length === 1) it is auto-selected.
*
* Side effects:
*   • self.top_locator is set to the first option's locator on build, and
*     updated to the selected option's locator on every change event.
*
* Error handling:
*   • If the 'sections' entry is missing from datum.data, an error message div
*     is shown, console.error is logged, and an empty fragment is returned
*     immediately (the select is not created).
*
* @param {Object} self - The tool_indexation instance. Must have
*   self.related_sections_list already populated (set in build_custom).
* @returns {DocumentFragment} Fragment containing the approach selector widget.
*/
const render_related_list = function(self){

	const datum		= self.related_sections_list
	const context	= datum.context
	const data		= datum.data

	const fragment = new DocumentFragment();

	// related list
		const related_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'related_list_container',
			parent			: fragment
		})

	// label. Inline with its select (see the .top pattern in the css) instead of
	// stacked above it — the caption and the control it names read as one field.
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'top_label',
			inner_html		: (self.get_tool_label('approach') || 'Approach'),
			parent			: related_list_container
		})

	// select -> options
		// sections
			const sections = data.find(el => el.typo==='sections')
			if (!sections) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'error msg',
					inner_html		: 'Empty top sections to index!',
					parent			: related_list_container
				})
				console.error('Empty top sections to index!')
				return fragment
			}

	// select node
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'hidden selector related_list_selector',
			parent			: related_list_container
		})

		// Build one <option> per related section.  The locator object is
		// stored on the option DOM node itself so the change handler can set
		// self.top_locator without re-parsing the value string.
		const value			= sections.value || []
		const value_length	= value.length
		for (let i = 0; i < value_length; i++) {

			const current_locator = {
				section_top_tipo	: value[i].section_tipo,
				section_top_id		: value[i].section_id
			}
			// fix the first locator when tool is loaded (without user interaction)
				if(i===0){
					self.top_locator = current_locator
				}

			const section_label = context.find(el => el.section_tipo===current_locator.section_top_tipo)?.label || ''
			const ar_component_data	= data.filter(el =>
				el.section_tipo === current_locator.section_top_tipo &&
				el.section_id === current_locator.section_top_id
			)

			// ar_component_value
				const ar_component_value = []
				for (let j = 0; j < ar_component_data.length; j++) {
					const current_value = ar_component_data[j].value // toString(ar_component_data[j].value)
					ar_component_value.push(current_value)
				}

			// label
				const label = 	section_label + ' | ' +
								current_locator.section_top_id +' | ' +
								ar_component_value.join(' | ')

			// option DOM element
				const current_value = current_locator.section_top_tipo + '_' + current_locator.section_top_id
				const option = ui.create_dom_element({
					element_type	: 'option',
					text_content	: label,
					value			: current_value,
					parent			: select
				})
				option.locator = current_locator
		}//end for

	// local_db
		const status_id			= 'tool_indexation_approach'
		const local_db_table	= 'status'

	// change event
		select.addEventListener('change', async function(e){

			self.top_locator = this.options[this.selectedIndex].locator

			// fix value in local DDBB table status
				const data = {
					id		: status_id,
					value	: e.target.value
				}
				data_manager.set_local_db_data(
					data,
					local_db_table
				)
		})

	// select initial value. local DDBB table status
	// Hides the selector while the async read is in flight (class 'hidden' was
	// applied on creation); removes 'hidden' once the value is restored or
	// confirmed absent, to prevent the select flashing at index 0.
		data_manager.get_local_db_data(
			status_id,
			local_db_table,
			true
		)
		.then(async function(db_data){
			if (db_data) {
				select.value = db_data.value
				// select.dispatchEvent(new Event('change'))
			}

			// select first options if no value
				if (!select.value && value_length===1) {
					select.selectedIndex = 0
				}

			select.classList.remove('hidden')
		})


	return fragment
}//end render_related_list



/**
* RENDER_VIEWER_SELECTOR
* Builds the left pane's own "Show" control — a <select> that switches the
* content rendered in that pane between thesaurus, people, and media viewers.
*
* Placement is the feature
* ────────────────────────
* This used to live in the tool header next to the "Approach" select, where the
* two read as peers. They are not: Approach scopes the whole indexation session,
* this one only swaps the left pane and never touches right_container. The
* control is therefore mounted as the first child of left_container so the pane
* it acts on is unmistakable.
*
* Available viewer options (in order):
*   • area_thesaurus  — hierarchical thesaurus browser (default).
*   • people_section  — people/persons section browser linked as a relation linker.
*   • media_component — AV player / media component.
*
* Labels are taken from the role's ddo_map entry (.label, stamped server-side
* by enrichToolConfig) so they reflect the ontology-configured display name
* WITHOUT requiring the instance — media_component and people_section are
* deferred and are still null when this runs.  A live instance's own .label
* wins when it happens to exist.  A role that is absent from the ddo_map
* altogether yields no option at all (no throw, no diagnostic string in the UI).
*
* Lazy rendering
* ──────────────
* area_thesaurus is rendered eagerly in get_content_data_edit.  The other two
* viewers (media_component, people_section) are rendered lazily on first
* selection: the rendered node is stored as left_container.media_component_node
* / left_container.people_section_node so that subsequent switches only toggle
* the CSS class 'hide', avoiding redundant renders.
*
* Persistence
* ───────────
* The selected viewer key is stored to localStorage under
* 'tool_indexation_viewer'.  Restoring it is NOT done here: the caller must
* invoke the returned apply_stored_viewer() once left_container.area_thesaurus_node
* exists, because the 'area_thesaurus' branch of the change handler needs that
* node.  apply_stored_viewer is a no-op when nothing is stored or the stored
* value is already the current one.
*
* Side effects:
*   • self.viewer is initialised to 'area_thesaurus' and updated on every
*     change event.
*   • left_container.media_component_node / .people_section_node are set on
*     first lazy render.
*
* @param {Object} self    - The tool_indexation instance. Needs area_thesaurus
*   (eager) plus self.tool_config.ddo_map / self._lazy_ddos for the deferred
*   viewers; the deferred instances themselves are NOT required here.
* @param {HTMLElement} left_container - The left pane node the selector acts on;
*   the change handler reads/writes its *_node pointers and appends lazily
*   rendered viewers to it.
* @returns {Object} { node, apply_stored_viewer } - node is the selector
*   container element (ready to append); apply_stored_viewer is the deferred
*   localStorage restore described above.
*/
const render_viewer_selector = function(self, left_container){

	// items. Each carries a glyph prefix so the three viewers are told apart at
	// a glance — the labels are ontology data ("Tesauro", "Audiovisual", a
	// people section named whatever the install calls it) and read as three
	// interchangeable words otherwise.
	// (!) a <select> renders its options as TEXT: no <img>, no css mask, no
	// icon element survives in there. A unicode glyph in the option label is
	// the only mark that shows both in the open list AND in the closed
	// control, which is where identification actually matters.
	// Keyed by VALUE, never by label: the label is install-defined.
	// (!) the label comes from the DDO, not from the instance: media_component
	// and people_section are DEFERRED (build sets autoload:false and only
	// instantiates them on first selection), so self[role] is null exactly when
	// this toolbar is built. Reading the instance made a not-yet-built viewer
	// look like an unconfigured role and printed the diagnostic string as the
	// option label. The server stamps `label` on every ddo_map entry
	// (enrichToolConfig), so it is available with or without an instance.
		const icons = {
			area_thesaurus	: '🌳', // the tree the thesaurus panel actually renders
			people_section	: '👤',
			media_component	: '🎬'
		}
		const build_item = function(role){

			const instance	= self[role] || null
			const ddo		= self._lazy_ddos?.[role]
				|| self.tool_config?.ddo_map?.find(el => el.role===role)
				|| null

			// role genuinely absent from the ontology ddo_map: no viewer to offer.
			// (an option that cannot resolve to anything is worse than no option)
			if (!instance && !ddo) {
				return null
			}

			return {
				label	: instance?.label || ddo?.label || role,
				value	: role,
				icon	: icons[role]
			}
		}
		const items = ['area_thesaurus', 'people_section', 'media_component']
			.map(build_item)
			.filter(Boolean)

	// fix initial viewer name (Thesaurus)
		self.viewer = items[0]?.value || 'area_thesaurus'

	// description. Used as tooltip on both the caption and the select, so the
	// scope is spelled out for anyone who hovers rather than infers it.
		const description = self.get_tool_label('viewer_description') || 'Choose what this left panel shows'

	// viewer_selector_container. A toolbar field: caption + control inline, the
	// same shape as .related_list_container beside it.
		const viewer_selector_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'viewer_selector_container'
		})

	// label
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'top_label',
			inner_html		: (self.get_tool_label('viewer') || 'Show'),
			title			: description,
			parent			: viewer_selector_container
		})

	// select viewer
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'selector viewer_selector',
			title			: description,
			parent			: viewer_selector_container
		})
		select.setAttribute('aria-label', description)
		// change event
		// (!) hide_all must be called before the switch so that
		// no two viewers are visible simultaneously.
		const change_handler = async (e) => {
			// fix the new viewer name
			self.viewer = e.target.value

			const area_thesaurus_node	= left_container.area_thesaurus_node || null
			const media_component_node	= left_container.media_component_node || null
			const people_section_node	= left_container.people_section_node || null

			const hide_all = () => {

				// hide area_thesaurus_node
				if (area_thesaurus_node) {
					area_thesaurus_node.classList.add('hide')
				}
				// hide media_component_node
				if (media_component_node) {
					media_component_node.classList.add('hide')
				}
				// hide people_section_node
				if (people_section_node) {
					people_section_node.classList.add('hide')
				}
			}
			hide_all();

			switch (self.viewer) {
				case 'media_component':

					// show media_component_node
					if (media_component_node) {
						media_component_node.classList.remove('hide')
					}else{
						// first call, ensure the deferred instance exists
						const component = await self._ensure_lazy_instance('media_component')
						component.render()
						.then(function(node){
							left_container.appendChild(node)
							// fix pointer
							left_container.media_component_node = node
						})
					}
					break;

				case 'people_section':

					// show people_section_node
					if (people_section_node) {
						people_section_node.classList.remove('hide')
					}else{
						// first call, ensure the deferred instance exists
						const section = await self._ensure_lazy_instance('people_section')
						section.render()
						.then(function(node){
							left_container.appendChild(node)
							// fix pointer
							left_container.people_section_node = node
						})
					}
					break;

				case 'area_thesaurus':
				default:

					// show area_thesaurus_node.
					// Guarded like the other branches: the node is assigned from
					// an async render callback, so it can legitimately be absent
					// when this runs early.
					if (area_thesaurus_node) {
						area_thesaurus_node.classList.remove('hide')
					}
					break;
			}

			// store selected viewer
			localStorage.setItem('tool_indexation_viewer', self.viewer)
		}
		select.addEventListener('change', change_handler)

	// (!) no disabled placeholder option here. The caption sits right beside the
	// select now, so repeating it as a decoy first option only added noise.

	// options
		const items_length = items.length
		for (let i = 0; i < items_length; i++) {

			const item = items[i]

			// option
			const option = ui.create_dom_element({
				element_type	: 'option',
				text_content	: item.icon
					? (item.icon + ' ' + item.label)
					: item.label,
				value			: item.value,
				parent			: select
			})
			if (item.value==='area_thesaurus') {
				option.selected = true // select default (Thesaurus)
			}
		}

	// apply_stored_viewer
	// Restores the last selection from localStorage by setting the select value
	// and dispatching a synthetic 'change'.
	// (!) The caller must run this only once left_container.area_thesaurus_node
	// exists (i.e. from the area_thesaurus render callback). Running it earlier
	// would leave the eagerly rendered thesaurus visible underneath the restored
	// viewer, because hide_all() cannot hide a node it cannot see yet.
	const apply_stored_viewer = function(){

		const last_viewer = localStorage.getItem('tool_indexation_viewer')
		if (!last_viewer || last_viewer===self.viewer) {
			// nothing stored, or the default is already applied
			return
		}

		// ignore a stale/unknown stored key (e.g. a role removed from the ontology)
		if (!items.some(item => item.value===last_viewer)) {
			return
		}

		select.value = last_viewer
		select.dispatchEvent(new Event('change'))
	}


	return {
		node				: viewer_selector_container,
		apply_stored_viewer	: apply_stored_viewer
	}
}//end render_viewer_selector



/**
* RENDER_STATUS
* Renders the status control components defined in the tool's ontology
* ddo_map under the roles 'status_user_component' and 'status_admin_component'.
*
* Each status component (if present on self) is rendered in 'mini' view with
* both the tools toolbar and the save animation suppressed, so they appear as
* compact inline indicators rather than full edit widgets.
*
* Called once during edit() and its result is appended to the toolbar.
*
* @param {Object} self - The tool_indexation instance.  Must have
*   self.status_user_component and self.status_admin_component set (may be
*   null/undefined if the respective ddo_map role is absent; those are silently
*   skipped).
* @returns {Promise<DocumentFragment>} Fragment containing the rendered status
*   component nodes (may be empty if both status components are absent).
*/
const render_status = async function(self) {

	const fragment = new DocumentFragment()

	// status_user_component
		if (self.status_user_component) {
			self.status_user_component.context.view	= 'mini'
			self.status_user_component.show_interface.tools = false
			self.status_user_component.show_interface.save_animation = false
			const status_user_node = await self.status_user_component.render()
			fragment.appendChild(status_user_node)
		}

	// status_admin_component
		if (self.status_admin_component) {
			self.status_admin_component.context.view = 'mini'
			self.status_admin_component.show_interface.tools = false
			self.status_admin_component.show_interface.save_animation = false
			const status_admin_node	= await self.status_admin_component.render()
			fragment.appendChild(status_admin_node)
		}


	return fragment
}//end render_status


// @license-end
