// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* RENDER_TS_LINE
* Builds the interactive row content for a single thesaurus/ontology node (ts_object).
*
* This module owns the "ts line" — the flat horizontal strip rendered inside every
* ts_object wrapper that contains the term label, action buttons, and auxiliary
* indicators.  It is imported by view_default_edit_ts_object.js, which calls it
* from get_content_data() during each render cycle.
*
* ELEMENT DISPATCH MODEL
* The server delivers `self.data.ar_elements` — an ordered array of element
* descriptors.  Each descriptor carries at minimum:
*   { type, tipo, model, value, [count_result], [show_data], [model_value] }
*
* render_ts_line() walks this array and dispatches on `element_case`, which is:
*   - 'component_relation_index' when element.model === 'component_relation_index'
*     (regardless of `type`, which is often 'icon' in ddo_map — see inline note)
*   - element.type  for every other element
*
* Known `element_case` values and their DOM output:
*   'term'                   → term label node (render_term or render_ontology_term)
*   'link_children_nd'       → ND (non-descriptor) toggle button
*   'link_children'          → arrow that expands/collapses descriptor children
*   'component_relation_index' → "U:N" indexation count badge / recursive variant
*   'img'                    → thumbnail that opens the component editor
*   default                  → generic button_show_component for all other types
*
* After the switch, any element with a `model_value` property appends a small
* model-name badge (hidden unless page_globals.show_models is true).
*
* TERM RENDERING
* Two render paths exist for the 'term' case:
*   • render_term          — standard thesaurus view (area_thesaurus caller)
*   • render_ontology_term — ontology view (area_ontology caller); parses an
*     encoded value string "label tipo id" to separate term text from tipo/id.
*
* SIDE EFFECTS
* - Sets self.term_node and self.term_text pointers on the ts_object instance.
* - Attaches live DOM event listeners (mousedown / click) on each rendered element.
* - Does NOT touch self.indexations_container (built after this function returns).
*
* @module render_ts_line
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {get_instance, get_all_instances} from '../../common/js/instances.js'
	import {get_caller_by_model} from '../../common/js/utils/util.js'
	import {render_link_children} from './view_default_edit_ts_object.js'
	import {bound_sqo_limit} from '../../common/js/sqo_limit.js'
	import {a11y} from '../../common/js/a11y.js'



/**
* RENDER_TS_LINE
* Assembles the full interactive ts line (term + buttons) as a DocumentFragment.
*
* The function iterates self.data.ar_elements and maps each server-supplied
* element descriptor to a DOM node via a switch on element_case (see module
* header).  The resulting fragment is appended into the ts_object content_data
* node by get_content_data() in view_default_edit_ts_object.js.
*
* Guard: if ar_elements is empty (hierarchy not installed) a placeholder span
* is returned immediately so the tree row is never left blank.
*
* @param {Object} self - ts_object instance. Must have self.data.ar_elements,
*   self.section_tipo, self.section_id, self.is_descriptor, self.thesaurus_mode,
*   self.has_descriptor_children, and self.element_to_hilite populated by init().
* @returns {DocumentFragment} fragment containing all element nodes for the row.
*/
export const render_ts_line = function(self) {

	// short vars
		const ar_elements	= self.data?.ar_elements || []
		const is_descriptor	= self.is_descriptor
		// note: self.indexations_container is created AFTER this function runs
		// (get_content_data builds the ts_line first); always read it from the
		// instance at click time, never capture it here

	// DocumentFragment
		const fragment = new DocumentFragment()

	// Empty ar_elements case
	if (ar_elements.length === 0) {
		const id_info = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'id_info ontology',
			text_content	: '['+ self.section_tipo +'] non-installed hierarchy',
			parent			: fragment
		})
		return fragment
	}

	// LIST_THESAURUS_ELEMENTS
	// Iterate child data switch between custom  render elements (buttons, etc)
	const ar_elements_len = ar_elements.length
	for (let j = 0; j < ar_elements_len; j++) {

		const current_element = ar_elements[j]

		// children_dataset — data-* attributes applied to most element nodes so
		// that CSS selectors and event handlers can read the ontology tipo/type.
		const children_dataset	= {
			tipo	: current_element.tipo,
			type	: current_element.type
		}

		// element_case. component_relation_index elements dispatch by MODEL:
		// their ddo_map type is 'icon' (see section_list_thesaurus properties),
		// so matching by type made the indexations case unreachable and the U
		// button fell into the default show_component path (view 'line')
		const element_case = current_element.model==='component_relation_index'
			? 'component_relation_index'
			: current_element.type

		switch(element_case) {

			// TERM
			// Renders the clickable term label.  In area_ontology context the
			// value string encodes "label tipo id" and needs separate parsing;
			// an additional [tipo_id] badge and a Duplicate button are also added.
			case ('term'): {
				// Choose the appropriate term renderer based on whether the
				// immediate caller chain contains an area_ontology instance.
				const area_ontology_caller = get_caller_by_model(self, 'area_ontology')
				const render_handler = area_ontology_caller
					? render_ontology_term
					: render_term

				const term_node = render_handler({
					self			: self,
					ar_elements		: ar_elements,
					is_descriptor	: is_descriptor,
					key				: j
				})
				fragment.appendChild(term_node)
				// set pointer
				self.term_node = term_node

				// id_info (show_section)
				// Builds the bracketed identifier badge shown after the term,
				// e.g. "[hierarchy1_246]" (standard) or "[dd246]" (ontology).
				// In ontology mode the value string is "label tipo id", so a
				// regex extracts the tipo+id pair to build a compact badge like
				// "[dd1]".  Falls back to section_tipo+section_id if the regex
				// fails (malformed value).
				const term_id = (area_ontology_caller)
					? (()=>{
						// id_info. Like '[hierarchy1_246]' (Term tipo)
						// parse parts
						const regex				= /^(.*) ([a-z]{2,}) ([0-9]+)$/gm;
						const term_regex_result	= regex.exec(current_element.value)
						// term_id . like 'dd_1'
						const result = term_regex_result
							? term_regex_result[2] + term_regex_result[3]
							: self.section_tipo + self.section_id
						return result
					  })()
					: self.section_tipo +'_'+ self.section_id

				const section = self.section_tipo + ' - ' + self.section_id

				// The id_info span is read-only debug information; stopPropagation
				// on mousedown prevents the thesaurus row from reacting to clicks
				// on the badge (which would otherwise trigger term selection).
				const id_info = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'id_info ontology',
					text_content	: '['+ term_id +']',
					title			: section,
					data_set		: {
						section : section,
						term_id : '['+ term_id +']'
					},
					parent			: fragment
				})
				const mousedown_handler_id_info = (e) => {
					e.stopPropagation()
				}
				id_info.addEventListener('mousedown', mousedown_handler_id_info)
				// click on id_info badge:
				// • metaKey+altKey while SHOW_DEBUG → force-refresh the ts_object instance
				// • altKey alone while SHOW_DEBUG  → log the instance to console
				// • otherwise                      → no-op (stopPropagation only)
				const click_handler_id_info = (e) => {
					e.stopPropagation()
					if(SHOW_DEBUG===true) {
						if (e.metaKey && e.altKey) {
							e.preventDefault()
							console.log('/// refreshing instance (build_autoload=true, render_level=content):', self);
							self.refresh({
								build_autoload	: true,
								render_level	: 'content'
							})
							return
						}
						if (e.altKey) {
							e.preventDefault()
							console.log(`/// selected instance ${self.model}:`, self);
							return
						}
					}
				}
				// a11y: the badge is read-only debug information, not a control — it
				// takes no tab stop and no role, only the click guard it always had.
				id_info.addEventListener('click', click_handler_id_info)

				// button_duplicate
				// Only shown in the ontology area (area_ontology_caller is truthy).
				// Duplicates the current section, then refreshes the parent's children
				// list and scrolls/highlights the newly created term.
				if (area_ontology_caller) {
					const button_duplicate = ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'duplicate',
						title			: 'Duplicate',
						parent			: fragment
					})
					// click event
					const click_handler_duplicate = async (e) => {
						e.stopPropagation()

						const section_tipo	= self.section_tipo
						const section_id	= self.section_id

						// (!) The term text is record data and travels through the `note`
						// slot, which renders as text — never through `header`, which is HTML.
						const confirmed = await ui.confirm({
							header			: (get_label.duplicate || 'Duplicate') + ` ID: ${section_id}`,
							note			: self.term_text?.textContent || null,
							body			: get_label.sure || 'Are you sure?',
							accept_class	: 'brand duplicate'
						})
						if (confirmed!==true) {
							return false
						}

						// Retrieve (or create) the section instance to call duplicate_section().
						const section = await get_instance({
							model			: 'section',
							section_tipo	: section_tipo,
							section_id		: section_id
						})
						const new_section_id = await section.duplicate_section( section_id )
						if (!new_section_id) {
							return false
						}

						// parent instance
						const parent_instance = self.caller
						if (!parent_instance) {
							console.error('Unable to get parent instance from caller:', self);
							return false
						}

						// pagination. Built by value: never mutate the cached
						// parent_instance.children_data.pagination object. The parent's
						// OWN page size is re-sent from offset 0 (audit P2-31 / CLI-30:
						// this sent `limit: 0` — "the whole branch" — exactly when the
						// parent was known to be paginated); the bound is the server's
						// client ceiling, never 0.
						const pagination = parent_instance.children_data?.pagination
							? { limit: bound_sqo_limit(parent_instance.children_data.pagination.limit), offset: 0 }
							: null

						// children_data - render_children_data from API
						// cache:false forces a fresh server call so the duplicated
						// record appears immediately in the children list.
						const children_data = await parent_instance.get_children_data({
							pagination	: pagination,
							children	: null,
							cache		: false // Forces call API again
						})
						if (!children_data) {
							// error case
							console.warn("[ts_object.render_children] Error, children_data is null");
							return false
						}

						// refresh children container
						parent_instance.render_children({
							clean_children_container	: true,
							children_data				: children_data
						})
						.then(function(result){
							// Open editor in new window
							if (result) {
								dd_request_idle_callback(()=>{
									// hilite the new term
									const target_instance = get_all_instances().find(el => parseInt(el.section_id)===parseInt(new_section_id) && el.section_tipo===section_tipo && el.model==='ts_object')
									if (target_instance) {
										self.hilite_element( target_instance.term_node )
									}else{
										console.error('Unable to get the target instance');
									}
									// open a edit window with the new record
									self.open_record(new_section_id, section_tipo)
								})

							}
						})
					}
					button_duplicate.addEventListener('click', click_handler_duplicate)
				}

				break;
			}

			// ND BUTTON
			// Renders a clickable label for a non-descriptor (ND) term — i.e. an
			// entry that exists in the hierarchy but is not a preferred descriptor.
			// Clicking toggles the nd_container below the row via self.toggle_nd().
			case ('link_children_nd'): {
				// Button for non descriptor [nd]
				const element_children_nd = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'link_children_nd default term nd unselectable',
					data_set		: children_dataset,
					text_node		: current_element.value,
					parent			: fragment
				})
				// mousedown event
				const mousedown_handler = (e) => {
					e.stopPropagation()

					element_children_nd.classList.add('loading_spinner')

					// toggle_nd
					self.toggle_nd(element_children_nd, e)
					.then(function(){
						element_children_nd.classList.remove('loading_spinner')
					})
				}
				// a11y (CLI-11): one callback, pointer AND Enter/Space. The node's own
				// term text is its accessible name.
				a11y.make_activable(element_children_nd, {
					pointer_event	: 'mousedown',
					on_activate		: mousedown_handler
				})
				break;
			}

			// ARROW ICON (link_children)
			// Renders the expand/collapse arrow for descriptor children.
			// Skipped (self.link_children_element set to null) when the node has
			// no descriptor children so the arrow never appears on leaf nodes.
			case ('link_children'): {
				if (self.has_descriptor_children) {
					// button arrow link children.
					// To access it, use the pointer to self.link_children_element
					const link_children_element = render_link_children(self)
					fragment.appendChild(link_children_element)
				}else{
					self.link_children_element = null
				}
				break;
			}

			// INDEXATIONS
			// Renders the indexation count badge ("U:N") for component_relation_index
			// elements.  Two sub-modes:
			//   !show_data  → direct indexations of this node only; badge shows total
			//                 and calls self.show_indexations() with a single locator.
			//   show_data==='children' → recursive indexations; fetches all descendant
			//                 locators first via self.get_children_recursive(), then
			//                 passes the full list to self.show_indexations().
			// If total is 0 in the direct case, no button is rendered at all.
			case ('component_relation_index'): {
				if (!current_element.show_data) {
					const total = parseInt(current_element.count_result?.total || 0)
					if(total > 0){
						// button_show_indexations. Build button
						// text_node produces a <span> child like "<span>U:37</span>"
						const button_show_indexations = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'button_show_indexations',
							data_set		: children_dataset,
							text_node		: current_element.value, // generates a span with the value like '<span>U:37</span>'
							parent			: fragment
						})
						// mousedown event
						const mousedown_handler = (e) => {
							e.stopPropagation()

							button_show_indexations.classList.add('loading_spinner')
							// uid: unique identifier for this indexation panel so that
							// show_indexations() can recycle or close the same panel.
							const uid = current_element.tipo +'_'+ self.section_tipo +'_'+ self.section_id

							// Re-read total at click time in case the badge was rendered
							// before the count_result was updated by a background refresh.
							const current_total = parseInt(current_element.count_result?.total || 0)

							self.show_indexations({
								uid 				: uid,
								button_obj			: button_show_indexations,
								event				: e,
								section_tipo		: self.section_tipo,
								section_id			: self.section_id,
								component_tipo		: current_element.tipo,
								target_div			: self.indexations_container,
								value				: null,
								total				: current_total,
								totals_group		: current_element.count_result?.totals_group,
								filter_by_locators	: [{
									section_tipo	: self.section_tipo,
									section_id		: self.section_id,
									tipo			: current_element.tipo
								}]
							})
							.then(function(){
								button_show_indexations.classList.remove('loading_spinner')
							})
						}
						a11y.make_activable(button_show_indexations, {
							pointer_event	: 'mousedown',
							on_activate		: mousedown_handler,
							label			: (typeof get_label!=='undefined' ? (get_label.indexations || 'Indexations') : 'Indexations')
						})
					}

				}else if(current_element.show_data === 'children') {
					// recursive indexations
					// The "⇣" prefix visually distinguishes the recursive badge from
					// the direct-indexations badge when both appear in the same row.
					const button_recursive_indexations = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'button_show_indexations',
						data_set		: children_dataset,
						text_node		: `⇣${current_element.value}`, // generates a span with the value like '<span>U:37</span>', // generates a span with the value like '<span>U:37</span>'
						parent			: fragment
					})
					// mousedown event
					const mousedown_handler = (e) => {
						e.stopPropagation()

						button_recursive_indexations.classList.add('loading_spinner')

						// First resolve all descendant locators, then pass them as
						// filter_by_locators so show_indexations() searches across the
						// full subtree rather than just this node.
						self.get_children_recursive({
							section_tipo	: self.section_tipo,
							section_id		: self.section_id
						})
						.then(function(children_recursive){

							self.show_indexations({
								uid 				: `${current_element.tipo}_recursive`,
								button_obj			: button_recursive_indexations,
								event				: e,
								section_tipo		: self.section_tipo,
								section_id			: self.section_id,
								component_tipo		: current_element.tipo,
								target_div			: self.indexations_container,
								value				: null,
								total				: null,
								totals_group		: current_element.count_result.totals_group,
								filter_by_locators	: children_recursive
							})
							.then(function(){
								button_recursive_indexations.classList.remove('loading_spinner')
							})
						})
					}
					a11y.make_activable(button_recursive_indexations, {
						pointer_event	: 'mousedown',
						on_activate		: mousedown_handler,
						label			: (typeof get_label!=='undefined' ? (get_label.indexations || 'Indexations') : 'Indexations') + ' (+)'
					})
				}
				break;
			}

			// IMG
			// Renders a thumbnail image for the current term (e.g. a linked media
			// component).  Only rendered when current_element.value is non-empty
			// (i.e. the server resolved an image URL for this element).
			// Clicking the thumbnail opens the component editor via
			// self.show_component_in_ts_object().
			case ('img'): {
				if(current_element.value) {

					const element_img = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'term_img',
						data_set		: children_dataset,
						parent			: fragment
					})
					// mousedown handler
					const mousedown_handler = (e) => {
						e.stopPropagation()

						element_img.classList.add('loading_spinner')

						self.show_component_in_ts_object({
							tipo	: current_element.tipo,
							type	: current_element.type,
							model	: current_element.model
						})
						.then(function(){
							element_img.classList.remove('loading_spinner')
						})
					}
					// a11y (CLI-11): a thumbnail with a listener is a control and needs a
					// NAME — the image alone announces nothing.
					a11y.make_activable(element_img, {
						pointer_event	: 'mousedown',
						on_activate		: mousedown_handler,
						label			: (typeof get_label!=='undefined' ? (get_label.image || 'Image') : 'Image')
					})
					// image
					ui.create_dom_element({
						element_type	: 'img',
						src				: current_element.value,
						parent			: element_img
					})
				}
				break;
			}

			// OTHERS. Buttons for show component to edit, etc.
			// Generic fallback for any element type not matched above
			// (e.g. custom icon buttons, extra component links).  Creates a
			// clickable div that opens the element's component in the editor
			// panel via self.show_component_in_ts_object().
			default: {
				const current_value = current_element.value

				// Case common buttons and links
				const button_show_component = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'default button_show_component ' + current_element.tipo,
					data_set		: children_dataset,
					text_node		: current_value, // creates a span node with the value inside
					parent 			: fragment
				})
				// mousedown event
				const mousedown_handler = (e) => {
					e.stopPropagation()

					button_show_component.classList.add('loading_spinner')

					self.show_component_in_ts_object({
						tipo	: current_element.tipo,
						type	: current_element.type,
						model	: current_element.model
					})
					.then(()=>{
						button_show_component.classList.remove('loading_spinner')
					})
				}
				a11y.make_activable(button_show_component, {
					pointer_event	: 'mousedown',
					on_activate		: mousedown_handler
				})
				break;
			}
		}//end switch(true)

		// ontology model case
		// When the server attaches a model_value (the raw ontology model name of
		// the element's component), append a small badge div so developers can
		// inspect it.  Visibility is gated on window.page_globals.show_models.
		if (current_element.model_value) {
			const show_models_class = window.page_globals.show_models===true ? '' : ' hide';
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'model_value' + show_models_class,
				text_content	: current_element.model_value,
				parent			: fragment
			})
		}
	}//end for (var j = 0; j < ch_len; j++)


	return fragment
}//end render_ts_line



/**
* RENDER_TERM
* Creates the term label node for a standard thesaurus row (area_thesaurus context).
*
* Produces a structure like:
*   <div class="term">
*     <span class="term_text [no_descriptor]">Social Anthropology</span>
*   </div>
*
* The term value may arrive as a string or an array of strings; arrays are
* joined with a space before rendering.  The tipo field may also be an array
* (multi-component terms); only the first entry is used when calling
* show_component_in_ts_object().
*
* Side effects:
* - Sets self.term_node to the returned div.
* - Sets self.term_text to the inner span.
* - Schedules a hilite via dd_request_idle_callback if self.element_to_hilite
*   matches this node's section_tipo/section_id (compares DOM dataset which is
*   set by the caller, NOT by this function — the dataset is absent here so
*   the hilite check always evaluates to false in practice).
*
* @param {Object} options
* @param {Object} options.self          - ts_object instance.
* @param {Array}  options.ar_elements   - Full ar_elements array from self.data.
* @param {boolean} options.is_descriptor - Whether this node is a descriptor term.
* @param {number}  options.key          - Index j into ar_elements for this element.
* @returns {HTMLElement} term_node div element.
*/
const render_term = function(options) {

	// options
		const self			= options.self
		const ar_elements	= options.ar_elements
		const is_descriptor	= options.is_descriptor
		const key			= options.key // int j

	// short vars
		const item	= ar_elements[key]
		// tipo may be an array when multiple component tipos map to one term slot;
		// use the first entry as the canonical tipo for UI operations.
		const tipo	= Array.isArray(item?.tipo) ? item.tipo[0] : item.tipo

	// term_node
		const term_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'term'
		})
		// fix term pointer
		self.term_node = term_node

		// term_text
		// value may be a plain string or an array of partial strings (multi-lang or
		// multi-component concatenation); join with space when array.
		const term_text_value = Array.isArray( ar_elements[key].value )
			? item.value.join(' ')
			: item.value
		const term_text = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'term_text unselectable' + (is_descriptor ? '' : ' no_descriptor'),
			inner_html		: term_text_value,
			parent			: term_node
		})
		self.term_text = term_text
		// click on term text → open component editor in the ts_object panel,
		// except when thesaurus_mode==='relation' (indexation tool context)
		// where clicks are intentionally ignored to avoid accidental navigation.
		const click_handler = (e) => {
			e.stopPropagation()

			if(self.thesaurus_mode==='relation'){
				return // ignore relation click
			}

			term_node.classList.add('loading_spinner')

			// show_component_in_ts_object
			self.show_component_in_ts_object({
				tipo	: item.tipo,
				type	: item.type,
				model	: item.model
			})
			.then(function(){
				term_node.classList.remove('loading_spinner')
			})
		}
		// a11y (CLI-11): the term IS the thesaurus surface. Its text is its name.
		a11y.make_activable(term_text, {
			on_activate : click_handler
		})

	// element_to_hilite
	// (!) Note: term_node has no data-set assigned here, so dataset.section_id
	// and dataset.section_tipo are both undefined.  The equality check below
	// will never match and the hilite scheduled via dd_request_idle_callback
	// is never triggered from this render path.  Hiliting in the standard
	// view happens instead via the caller passing element_to_hilite and the
	// ts_object re-render cycle.
		if (self.element_to_hilite) {
			if(		term_node.dataset.section_id == self.element_to_hilite.section_id
				&& 	term_node.dataset.section_tipo===self.element_to_hilite.section_tipo) {
				// hilite element
				dd_request_idle_callback(
					() => {
						self.hilite_element(term_node)
					}
				)
			}
		}


	return term_node
}//end render_term



/**
* RENDER_ONTOLOGY_TERM
* Creates the term label node for an ontology row (area_ontology caller context).
*
* Unlike render_term, this variant:
* 1. Parses the encoded value string — the server encodes it as
*    "label tipo id" (e.g. "Social Anthropology aa1 246") and this function
*    extracts the label part via regex for display; tipo+id are used for the
*    id_info badge built in render_ts_line.
* 2. Attaches a full data-set (section_tipo, section_id, tipo, type) to term_node
*    so that element_to_hilite matching works correctly.
* 3. Uses item.tipo[0] (always an array here) when calling
*    show_component_in_ts_object().
*
* Produces the same DOM shape as render_term:
*   <div class="term" data-section_tipo="..." data-section_id="..." ...>
*     <span class="term_text [no_descriptor]">Social Anthropology</span>
*   </div>
*
* Side effects:
* - Sets self.term_node to the returned div.
* - Sets self.term_text to the inner span.
* - Schedules a hilite via dd_request_idle_callback if self.element_to_hilite
*   matches (comparison works here because the data-set is applied to term_node).
*
* @param {Object} options
* @param {Object} options.self          - ts_object instance.
* @param {Array}  options.ar_elements   - Full ar_elements array from self.data.
* @param {boolean} options.is_descriptor - Whether this node is a descriptor term.
* @param {number}  options.key          - Index j into ar_elements for this element.
* @returns {HTMLElement} term_node div element.
*/
const render_ontology_term = function(options) {

	// options
		const self			= options.self
		const ar_elements	= options.ar_elements
		const is_descriptor	= options.is_descriptor
		const key			= options.key // int j

	// short vars
		const section_tipo	= self.section_tipo
		const section_id	= self.section_id
		const ts_id			= self.ts_id
		const item			= ar_elements[key]

	// children_dataset
		const children_dataset	= {
			section_tipo	: section_tipo,
			section_id		: section_id,
			tipo			: item.tipo[0],
			type			: item.type
		}

	// parse parts
	// The ontology value encodes "label tipo id" (e.g. "Social Anthropology aa1 246").
	// Capture groups: [1]=label, [2]=tipo, [3]=id.
	// Falls back to the raw value (or ts_id) when the pattern does not match.
		const regex				= /^(.*) ([a-z]{2,}) ([0-9]+)$/gm;
		const term_regex_result	= regex.exec(item.value)
		// term_text
		const term_text = term_regex_result
			? term_regex_result[1]
			: item.value || ts_id

	// term_node
		const term_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'term',
			data_set		: children_dataset
		})
		// fix term pointer
		self.term_node = term_node

	// term_text
		const term_text_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'term_text' + (is_descriptor ? '' : ' no_descriptor'),
			inner_html		: term_text,
			parent			: term_node
		})
		// click on term text → open component editor.
		// Guard: ignore clicks when thesaurus_mode==='relation' (indexation tool).
		const click_handler = (e) => {
			e.stopPropagation()

			if(self.thesaurus_mode==='relation'){
				return // ignore relation click
			}

			term_node.classList.add('loading_spinner')

			// Only first item (term) is used
			const tipo = Array.isArray(item.tipo) ? item.tipo[0] : item.tipo

			// show_component_in_ts_object
			self.show_component_in_ts_object({
				tipo	: tipo,
				type	: item.type,
				model	: item.model
			})
			.then(function(){
				term_node.classList.remove('loading_spinner')
			})
		}
		a11y.make_activable(term_text_node, {
			on_activate : click_handler
		})
		// fix term pointer
		self.term_text = term_text_node

	// element_to_hilite
	// The data-set on term_node provides section_id and section_tipo so that
	// the equality check here is effective (unlike render_term which lacks a data-set).
		if (self.element_to_hilite) {
			if(		term_node.dataset.section_id == self.element_to_hilite.section_id
				&& 	term_node.dataset.section_tipo===self.element_to_hilite.section_tipo) {
				// hilite element
				dd_request_idle_callback(
					() => {
						self.hilite_element(term_node)
					}
				)
			}
		}


	return term_node
}//end render_ontology_term



// @license-end
