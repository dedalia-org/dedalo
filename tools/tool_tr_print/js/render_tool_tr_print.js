// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {tr} from '../../../core/common/js/tr.js'



/**
* RENDER_TOOL_TR_PRINT
*
* Client-side renderer for the tool_tr_print tool — a printable-view generator
* for Dédalo interview transcriptions (component_text_area records).
*
* The tool opens as a panel next to a transcription component and renders the
* raw Dédalo tag markup (timecodes, index markers, speaker tags, notes, lang
* changes, references) into human-readable HTML arranged in a two-column layout:
*   - left_container  : interactive display-option controls (checkboxes, selects)
*   - right_container : the formatted transcript text
*
* Three view modes are available through a <select> widget:
*   - "Original" (default) : tag markup converted to inline HTML via tags_to_html()
*   - "Default"            : structured table layout with index cross-links via
*                            render_default() — each timecoded paragraph becomes a
*                            table row; index in/out anchors link to a sidebar list
*   - "Source"             : raw Dédalo tag string shown as plain text (innerText)
*
* Display toggles (checkboxes) control visibility of individual element classes
* (.tc, .person, .index, .note, .lang, .left_block) by toggling inline styles or
* CSS class names. Toggling "Lines" adds a border_top CSS class to right_block rows.
*
* Language switching refreshes the underlying transcription_component (forcing a
* render + refresh cycle) and rebuilds the right_container_text area in place.
*
* Dependency on `self` context
* ----------------------------
* All module-level functions receive `self` (the tool_tr_print instance) as their
* first argument. The caller (tool_tr_print.js) assigns this module's .edit method
* to tool_tr_print.prototype.edit, so `this` inside .edit is the live instance.
* Key instance properties consumed here:
*   self.ar_raw_data               — Array of {id, lang, value} data items (the
*                                    component's `data.entries`; kept in sync by
*                                    tool_tr_print.sync_raw_data) from the active
*                                    component_text_area data value array (may change
*                                    on lang switch)
*   self.lang                      — BCP-47 language tag ('lg-spa', 'lg-eng', …)
*   self.transcription_component   — The component_text_area instance being printed
*   self.tags_info                 — Object returned by component_text_area's
*                                    get_tags_info(['index','note','reference']):
*                                      .tags_index  — Array of index-tag resolution objects
*                                                     each: {data:{tag_id,…}, label:string}
*                                      .tags_notes  — Array of annotation objects (nullable),
*                                                     each: {data:{section_tipo,section_id,
*                                                     component_tipo}, title:string[],
*                                                     body:string}
*                                    (tags_persons comes from transcription_component.data)
*
* Tag-markup patterns are consumed from tr.get_mark_pattern() (core/common/js/tr.js),
* the canonical regex factory shared with the PHP TR class. Supported patterns used
* here: 'p', 'tc', 'indexIn', 'indexOut', 'reference', 'person', 'note', 'lang'.
*
* @module render_tool_tr_print
*/
export const render_tool_tr_print = function() {

	return true
}//end render_tool_tr_print



/**
* EDIT
* Builds the complete tool panel for the print-transcription tool.
*
* Orchestrates the three main layout regions:
*   1. A two-column content_data area (left controls / right transcript)
*      built by get_content_data_edit().
*   2. Optional header action buttons injected into wrapper.tool_buttons_container
*      via render_head_options() — currently returns an empty fragment (placeholder
*      for future per-instance buttons such as Print or Export PDF).
*   3. A sidebar of display-toggle controls (lang selector, visibility checkboxes,
*      view-mode selector) appended to content_data.left_container via
*      render_text_process_options().
*
* If render_level === 'content', returns content_data directly (no outer wrapper).
* This branch is used when refreshing only the inner area without rebuilding the
* full tool shell (e.g. after a lang change that originates outside this method).
*
* @param {Object} options - Render configuration
* @param {string} [options.render_level='full'] - 'full' builds wrapper + content;
*   'content' returns only the inner content_data node
* @returns {Promise<HTMLElement>} wrapper element (render_level 'full'), or the
*   raw content_data node (render_level 'content')
*/
render_tool_tr_print.prototype.edit = async function(options) {

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

	// transcription_options are the buttons to get access to other tools (buttons in the header)
		const tanscription_options = await render_head_options(self, content_data)
		wrapper.tool_buttons_container.appendChild(tanscription_options)

	// render the text process options to interact with user
		const process_options = render_text_process_options(self, content_data)
		content_data.left_container.appendChild(process_options)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the two-column layout container that holds all tool content and returns
* it as an augmented content_data HTMLElement.
*
* Layout produced:
*   content_data
*     ├── left_container    (controls injected by render_text_process_options)
*     └── right_container
*           ├── right_container_head  (transcript header rendered by render_header)
*           └── right_container_text  (the transcript body rendered here)
*
* The transcript text is produced by iterating self.ar_raw_data and passing each
* item's raw Dédalo tag string through self.tags_to_html() (which delegates to
* tr.add_tag_img_on_the_fly). The result is injected with insertAdjacentHTML
* rather than createElement so that the server-produced HTML markup is preserved
* verbatim, including inline <img> timecode thumbnails.
*
* Pointer properties are attached to content_data so that downstream callers
* (render_text_process_options, render_head_options, and the lang-switch handler)
* can navigate to specific sub-nodes without re-querying the DOM:
*   content_data.left_container          — {HTMLElement}
*   content_data.right_container         — {HTMLElement}
*   content_data.right_container_text    — {HTMLElement}
*
* @param {Object} self - tool_tr_print instance
* @returns {Promise<HTMLElement>} Augmented content_data element
*/
const get_content_data_edit = async function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// left_container
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'left_container',
			parent			: fragment
		})

	// right_container
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'right_container',
			parent			: fragment
		})
		// right_container_head
		const right_container_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'right_container_head',
			parent			: right_container
		})
		const header_node = render_header(self)
		if(header_node){
			right_container_head.appendChild(header_node)
		}
		// right_container_text
		const right_container_text = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'right_container_text',
			parent			: right_container
		})

		// value is a raw html without parse into nodes (txt format)
		const node_len 	= self.ar_raw_data.length
		for (let i = 0; i < node_len; i++) {
			const raw_data	= self.ar_raw_data[i].value || ''
			const text_node	= self.tags_to_html(raw_data)
			right_container_text.insertAdjacentHTML('beforeend', text_node);
		}

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)

		// save the pointers of the content_data nodes, to be used by the buttons to access to the components
		content_data.left_container			= left_container
		content_data.right_container		= right_container
		content_data.right_container_text	= right_container_text


	return content_data
}//end get_content_data_edit



/**
* RENDER_HEAD_OPTIONS
* Builds optional action-button nodes to be inserted into the tool's header bar
* (wrapper.tool_buttons_container). Currently returns an empty DocumentFragment
* and serves as a reserved extension point for future header-level controls
* such as a Print button or a PDF export trigger.
*
* The fragment is appended by the caller (render_tool_tr_print.prototype.edit)
* to wrapper.tool_buttons_container immediately after the content_data is built.
*
* @param {Object} self - tool_tr_print instance
* @param {HTMLElement} content_data - Augmented content element (with pointer props)
* @returns {Promise<DocumentFragment>} Empty fragment (no buttons defined yet)
*/
const render_head_options = async function(self, content_data) {

	const fragment = new DocumentFragment()

	return fragment
}//end render_head_options



/**
* RENDER_TEXT_PROCESS_OPTIONS
* Builds the left-panel controls that let the user customise the printed view.
* All controls operate directly on the DOM of content_data.right_container_text
* (and its children) without triggering a full re-render — changes are immediate.
*
* Controls produced (in order):
*
*   lang_container        — Language selector (<select>) built by ui.build_select_lang.
*                           On change: updates self.lang, forces a render+refresh
*                           cycle on the underlying transcription_component, reads
*                           the updated self.ar_raw_data, wipes right_container_text,
*                           and re-inserts the HTML via insertAdjacentHTML.
*                           (!) The lang selector updates self.lang directly and
*                           re-renders transcription_component in-place without
*                           rebuilding the tool panel — callers of this tool must
*                           not assume self.lang is immutable after open.
*
*   header_option         — Checkbox (default: checked). Toggles style.display of
*                           .right_container_head to show/hide the transcript header.
*
*   timecodes_option      — Checkbox (default: checked). Attaches its 'change' listener
*                           on timecodes_option_container (the wrapper div), not the
*                           checkbox itself. Toggles style.display on all .tc elements.
*                           (!) Event delegation: listener is on the container, so
*                           any click inside the container fires it — intentional.
*
*   persons_option        — Checkbox (default: checked). Toggles style.display on
*                           all .person elements in content_data.
*
*   indexations_option    — Checkbox (default: checked). Toggles style.display on
*                           all .index elements in content_data.
*
*   indexations_info_opt  — Checkbox (default: checked). Toggles visibility of the
*                           left-column index info panel: adds/removes .hidden_column_index
*                           on .data_block and individually hides/shows .left_block nodes.
*
*   annotations_option    — Checkbox (default: checked). Attaches its 'change' listener
*                           on annotations_option_container (the wrapper div), not the
*                           checkbox itself — same delegation pattern as timecodes_option.
*                           Toggles style.display on all .note elements.
*
*   lang_option           — Checkbox (default: checked). Toggles style.display on
*                           all .lang elements (language-change markers in text).
*
*   lines_option          — Checkbox (default: unchecked). Walks all .tc elements,
*                           climbs the DOM to find the enclosing .right_block via the
*                           recursive helper get_parent_block(), then adds/removes the
*                           CSS class 'border_top' to draw separator lines between
*                           timecoded paragraphs.
*
*   text_selector         — <select> offering "Default" / "Original" / "Source" modes.
*                           Switching resets all option checkboxes to their defaults
*                           and rebuilds right_container_text:
*                             - "Default"  : calls render_default() and appends nodes
*                             - "Original" : calls self.tags_to_html() per ar_raw_data item
*                                            and inserts via insertAdjacentHTML
*                             - "Source"   : sets right_container_text.innerText to the
*                                            raw tag string (last item wins if multiple)
*
* All controls are appended to a DocumentFragment returned to the caller, which
* appends it to content_data.left_container.
*
* @param {Object} self - tool_tr_print instance
* @param {HTMLElement} content_data - Augmented content element (with pointer props
*   .left_container, .right_container, .right_container_text)
* @returns {DocumentFragment} Fragment containing all control nodes
*/
const render_text_process_options = function(self, content_data) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// lang selector
		const lang_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'lang_container',
			parent			: fragment
		})
		// lang_label
			ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'lang_label',
				inner_html 		: get_label.language || 'Language',
				parent 			: lang_container
			})
		// the lang selector use the content_data pointer .right_container to remove the transcription text_area and rebuild the new node
			const lang_selector = ui.build_select_lang({
				selected	: self.lang,
				class_name	: 'dd_input selector',
				action		: async function(e){

					// user selected lang
						self.lang = e.target.value

					// loading
						content_data.right_container_text.classList.add('loading')

					// change lang and refresh the component
						self.transcription_component.lang = self.lang
						// The transcription_component is not rendered inside this tool panel,
						// so it has no live DOM node whose content could simply be refreshed.
						// We must call render() first (which sets up internal state) and
						// then refresh() with build_autoload:true to trigger a server round-trip
						// that fetches the data for the newly selected language.
						await self.transcription_component.render()
						await self.transcription_component.refresh({
							build_autoload : true
						})

					// fix vars — sync self.ar_raw_data after the refresh populates new lang data
						self.sync_raw_data()

					// remove previous nodes
						while (content_data.right_container_text.lastChild) {//} && content_data.left_container.lastChild.id!==lang_selector.id) {
							content_data.right_container_text.removeChild(content_data.right_container_text.lastChild)
						}

					// re-create nodes
						const node_len 	= self.ar_raw_data.length
						for (let i = 0; i < node_len; i++) {
							const raw_data	= self.ar_raw_data[i].value || ''
							const text_node	= self.tags_to_html(raw_data)
							// add the new one
							content_data.right_container_text.insertAdjacentHTML('beforeend', text_node);
						}

					// loading
						content_data.right_container_text.classList.remove('loading')
				}
			})
			lang_container.appendChild(lang_selector)

	// OPTIONS

	// header_option_container
		const header_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// header option
		const header_option = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox'
		})
		header_option.checked = true // default checked
		header_option.addEventListener('change', async function(){
			const header_elements = content_data.querySelector('.right_container_head')
			if(!header_elements){
				return
			}
			header_elements.style.display = header_option.checked===true
				? ''
				: 'none'
		})
		const header_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'option_label header_option_label',
			inner_html		: get_label.head || 'Header',
			parent			: header_option_container
		})
		header_option_label.insertAdjacentElement('afterbegin', header_option)

	// timecodes_option_container
		const timecodes_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// timecodes_option
		const timecodes_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox'
		})
		timecodes_option.checked = true // default checked
		timecodes_option_container.addEventListener('change',function(){
			const tc_elements = content_data.querySelectorAll('.tc')
			const len = tc_elements.length
			if (timecodes_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					tc_elements[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					tc_elements[i].style.display = 'none'
				}
			}
		})
		const timecodes_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'option_label timecodes_option_label',
			inner_html 		: get_label.timecodes || 'Time Codes',
			parent 			: timecodes_option_container
		})
		timecodes_option_label.insertAdjacentElement('afterbegin', timecodes_option)

	// persons_option_container
		const persons_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// persons_option
		const persons_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox'
		})
		persons_option.checked = true // default checked
		persons_option.addEventListener('change',function(){
			const person_elements = content_data.querySelectorAll('.person')
			const len = person_elements.length
			//console.log(tc_elements);

			if (persons_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					person_elements[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					person_elements[i].style.display = 'none'
				}
			}
		})
		const persons_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'persons_option_label',
			inner_html 		: get_label.persons || 'Persons',
			parent 			: persons_option_container
		})
		persons_option_label.insertAdjacentElement('afterbegin', persons_option)

	// indexations_option_container
		const indexations_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// indexations_option
		const indexations_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox'
		})
		indexations_option.checked = true // default checked
		indexations_option.addEventListener('change',function(){
			const index_elements = content_data.querySelectorAll('.index')
			const len = index_elements.length
			//console.log(tc_elements);

			if (indexations_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					index_elements[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					index_elements[i].style.display = 'none'
				}
			}
		})
		const indexations_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'indexations_option_label',
			inner_html 		: get_label.indexations || 'Indexations',
			parent 			: indexations_option_container
		})
		indexations_option_label.insertAdjacentElement('afterbegin', indexations_option)


	// indexations_info_option_container
		const indexations_info_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// indexations_info_option
		const indexations_info_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox',
		})
		indexations_info_option.checked = true // default checked
		indexations_info_option.addEventListener('change',function(){

			const data_block = content_data.querySelector('.data_block')
			if (!data_block){
				return
			}
			if (indexations_info_option.checked===true) {
				data_block.classList.remove('hidden_column_index')
			}else{
				data_block.classList.add('hidden_column_index')
			}

			const indexations_block = content_data.querySelectorAll('.left_block')
			const len = indexations_block.length

			// (!) querySelectorAll always returns a NodeList (never null/undefined),
			// so this guard is effectively dead code — do not remove per doc-only rule.
			if (!indexations_block){
				return
			}
			if (indexations_info_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					indexations_block[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					indexations_block[i].style.display = 'none'
				}
			}
		})
		const indexations_info_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'indexations_info_option_label',
			inner_html 		: get_label.indexations_info || 'Indexations info',
			parent 			: indexations_info_option_container
		})
		indexations_info_option_label.insertAdjacentElement('afterbegin', indexations_info_option)


	// annotations_option_container
		const annotations_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		// annotations_option
		const annotations_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox'
		})
		annotations_option.checked = true // default checked
		annotations_option_container.addEventListener('change', function(){

			const note_elements = content_data.querySelectorAll('.note')
			const len = note_elements.length
			//console.log(tc_elements);

			if (annotations_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					note_elements[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					note_elements[i].style.display = 'none'
				}
			}
		})
		const annotations_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'annotations_option_label',
			inner_html 		: get_label.annotations || 'Annotations',
			parent 			: annotations_option_container
		})
		annotations_option_label.insertAdjacentElement('afterbegin', annotations_option)


	// Lang_option_container
		const lang_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		const lang_option = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'checkbox'
		})
		lang_option.checked = true // default checked
		lang_option.addEventListener('change',function(){

			const lang_elements	= content_data.querySelectorAll('.lang')
			const len			= lang_elements.length

			if (lang_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					lang_elements[i].style.display = ''
				}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					lang_elements[i].style.display = 'none'
				}
			}
		})
		const lang_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'lang_option_label',
			inner_html 		: get_label.languages || 'Languages',
			parent 			: lang_option_container
		})
		lang_option_label.insertAdjacentElement('afterbegin', lang_option)


	// lines_option_container
		const lines_option_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'option_container',
			parent			: fragment
		})
		const lines_option = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox'
		})
		lines_option.checked = false // default non checked
		lines_option.addEventListener('change', function(){

			function get_parent_block(current_node) {
				if(current_node.classList.contains('right_container_text')){
					return null
				}
				if(current_node.classList.contains('right_block')){
					return current_node
				}
				return get_parent_block(current_node.parentNode)
			}

			const fragment_elements = content_data.querySelectorAll('.tc')
			const len = fragment_elements.length

			// (!) querySelectorAll never returns null/undefined, so this guard is
			// always false (dead code). When no .tc elements exist len is 0 and
			// the loops below are no-ops anyway — do not remove per doc-only rule.
			if(!fragment_elements){
				return
			}

			if (lines_option.checked===true) {
				for (let i = len - 1; i >= 0; i--) {
					const right_block = get_parent_block(fragment_elements[i].parentNode)
					// i > 0 skips the very first .tc element (index 0) so that the
					// topmost transcript paragraph does not receive a border at the top.
					if(right_block && i > 0){
						right_block.classList.add('border_top')}
					}
			}else{
				for (let i = len - 1; i >= 0; i--) {
					const right_block = get_parent_block(fragment_elements[i].parentNode)
					if(right_block){
						right_block.classList.remove('border_top')
					}
				}
			}
		})
		const lines_option_label = ui.create_dom_element({
			element_type	: 'label',
			class_name 		: 'lines_option_label',
			inner_html 		: get_label.lines || 'Lines',
			parent 			: lines_option_container
		})
		lines_option_label.insertAdjacentElement('afterbegin', lines_option)

	// text options container
		const text_selector = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'text_selector',
			parent			: fragment
		})
		const default_view_option = ui.create_dom_element({
			element_type	: 'option',
			inner_html		: get_label.default || 'Default',
			parent			: text_selector
		})
		const original_view_option = ui.create_dom_element({
			element_type	: 'option',
			inner_html		: get_label.original || 'Original',
			parent			: text_selector
		})
		// default checked
		original_view_option.selected = true
		const source_view_option = ui.create_dom_element({
			element_type	: 'option',
			inner_html 		: get_label.source || 'Source',
			parent 			: text_selector
		})
		// change event
		text_selector.addEventListener('change', function(event) {
			// reset all options to default
				header_option.checked			= true
				timecodes_option.checked		= true
				persons_option.checked			= true
				indexations_option.checked		= true
				indexations_info_option.checked	= true
				annotations_option.checked		= true
				lang_option.checked				= true
				lines_option.checked			= false

			if (default_view_option.selected===true) {
				const ar_default_render = render_default(self)
				// remove previous nodes
					while (content_data.right_container_text.lastChild) {//} && content_data.left_container.lastChild.id!==lang_selector.id) {
						content_data.right_container_text.removeChild(content_data.right_container_text.lastChild)
					}
				const ar_render_len = ar_default_render.length
				for (let i = 0; i < ar_render_len; i++) {
					content_data.right_container_text.appendChild(ar_default_render[i]);
				}
			}

			if (original_view_option.selected===true) {

				// remove previous nodes
					while (content_data.right_container_text.lastChild) {//} && content_data.left_container.lastChild.id!==lang_selector.id) {
						content_data.right_container_text.removeChild(content_data.right_container_text.lastChild)
					}

				const node_len 	= self.ar_raw_data.length
				for (let i = 0; i < node_len; i++) {
					const raw_data = self.ar_raw_data[i].value || ''
					const text_node = self.tags_to_html(raw_data)
					// add the new one
					content_data.right_container_text.insertAdjacentHTML("beforeend", text_node);
				}
			}

			if (source_view_option.selected===true) {

				// remove previous nodes
					while (content_data.right_container_text.lastChild) {//} && content_data.left_container.lastChild.id!==lang_selector.id) {
						content_data.right_container_text.removeChild(content_data.right_container_text.lastChild)
					}

				const node_len 	= self.ar_raw_data.length
				const ar_raw_text = []
				for (let i = 0; i < node_len; i++) {
					const raw_data = self.ar_raw_data[i].value || ''
					ar_raw_text.push(raw_data)
				}
				// assign once so every ar_raw_data item is shown (avoid overwriting
				// on each iteration, which previously left only the last item visible)
				content_data.right_container_text.innerText = ar_raw_text.join('\n');
			}
		})


	return fragment
}//end render_text_process_options



/**
* RENDER_DEFAULT
* Converts self.ar_raw_data into a structured two-column <table> layout suitable
* for printing. Unlike the "Original" view (which simply converts all tags to
* inline <img> nodes), this mode parses each tag type individually, producing
* navigable cross-links between index anchors in the text and their descriptor
* labels in the left-hand sidebar.
*
* Processing pipeline for each ar_raw_data item:
*
*   1. Split the raw text on <p>/<\/p> HTML paragraph markers (pattern 'p') into
*      an array of paragraph fragments (ar_fragment_data). Each fragment becomes
*      an HTML string that is further processed in order.
*
*   2. For each fragment (inner loop), apply tag-replacement functions sequentially:
*
*      TC replacement (get_tc)
*        Pattern: 'tc'  — captures p2 = time string, e.g. '00:01:25.627'
*        Output: <span class="tc">TIME</span>
*
*      INDEX IN replacement (get_index_in)
*        Pattern: 'indexIn'  — p4 = numeric tag_id (string)
*        Looks up tag_id in self.tags_info.tags_index (Array from get_tags_info API).
*        If matched terms exist, creates a .left_block sidebar entry with a numeric
*        label badge and an <a class="index terms"> linking down to the in-text anchor.
*        Also inserts a new right_block row before processing the replace, so that
*        each indexation boundary starts a new table row.
*        Output in text: <a id="tagindex_N" href="#index_N" class="index in">N{</a>
*        (!) left_block is reassigned as a DOM element only when an indexIn is found;
*        if no indexIn exists in a fragment, left_block remains '' (empty string),
*        meaning get_index_in's attempt to append to left_block is a no-op (parent
*        value '') — which is intentional for the non-index case.
*
*      INDEX OUT replacement (get_index_out)
*        Pattern: 'indexOut' — p4 = tag_id
*        Output: <a id="out_tagindex_N" href="#index_N" class="index out">}N</a>
*
*      REFERENCE replacement (get_reference)
*        Pattern: 'reference'
*        Output: '' — references are stripped entirely; inline links have no meaning
*        in a static print layout.
*
*      PERSON replacement (get_person)
*        Pattern: 'person' — p6 = JSON-like data string (single-quoted keys)
*        Single quotes in the embedded JSON payload are replaced with double quotes
*        before parsing, because the Dédalo tag wire format uses single quotes to
*        avoid conflicts with the surrounding attribute quote character.
*        Looks up the person in self.transcription_component.data.tags_persons
*        (Array populated by component_text_area_json.php) by matching {section_tipo,
*        section_id, component_tipo} triple.
*        Output: <div class="person">FULL_NAME: </div>  (or '' if no match)
*
*      NOTE replacement (get_note)
*        Pattern: 'note' — p7 = JSON-like data string (single-quoted keys)
*        Same single-quote replacement as person before JSON.parse.
*        Looks up in self.tags_info.tags_notes (filtered for null items — server may
*        return sparse arrays with null placeholders for unresolved notes).
*        Matches by {section_tipo, section_id, component_tipo}.
*        Output: <span class="note"> [TITLE. BODY] </span>
*        note_title is built by joining note.title[] with ' | '.
*        note_text is "title. body" when both are present, or just body.
*        (!) The final ternary `note ? … : ''` after the early `if(!note) return ''`
*        is unreachable dead code — note is always truthy at that point.
*
*      LANG replacement
*        Pattern: 'lang' — $6 in the replacement string = language label
*        Output: <span class="lang">LANG: </span>
*        Applied via a plain string template replacement (no callback needed).
*
*   3. After all tag replacements the processed HTML string is appended to
*      right_block via insertAdjacentHTML("beforeend", …).
*
*   4. The final data_block <table> for each ar_raw_data item is pushed onto
*      ar_default_render and returned as an Array of DOM nodes.
*
* Column layout (CSS grid / table)
* ---------------------------------
* Each fragment that contains an indexIn tag triggers a new row:
*   row 1 (implicit): right_block [td.right_block] — text before first index
*   row N:            right_block [td.right_block] — text segment
*                     left_block  [td.left_block]  — index label sidebar
* left_block.style is set to `grid-row: N` so CSS grid can place it beside
* the matching right_block row even though both are siblings in the flat <table>.
*
* @param {Object} self - tool_tr_print instance
* @returns {Array<HTMLElement>} Array of <table class="data_block"> nodes,
*   one per item in self.ar_raw_data
*/
const render_default = function(self) {

	const fragment = new DocumentFragment()

	const node_len			= self.ar_raw_data.length
	const ar_default_render	= []

	for (let i = 0; i < node_len; i++) {

		const raw_data = self.ar_raw_data[i].value || ''

		// BR
		// break into fragments with br tag
		const pattern_br = tr.get_mark_pattern('p');
		const ar_fragment_data = raw_data.split(pattern_br);
		const ar_fragment_data_len = ar_fragment_data.length

		// create the data block for as global container
		const data_block = ui.create_dom_element({
			element_type	: 'table',
			class_name		: 'data_block',
			parent			: fragment
		})

		function get_new_text_node() {

			return ui.create_dom_element({
				element_type	: 'td',
				class_name		: 'right_block',
				parent			: data_block
			})
		}
		// right_block is the active <td class="right_block"> receiving text;
		// left_block starts as '' (empty string) — a falsy no-op parent for
		// ui.create_dom_element until the first indexIn is encountered and it
		// is replaced with a real DOM element. row tracks the CSS grid-row counter.
		let right_block =  get_new_text_node()
		let left_block = ''
		let row = 1
		for (let j = 0; j < ar_fragment_data_len; j++) {
			let current_fragment = ar_fragment_data[j]
			// TC
				function get_tc(match, p1,p2, offset) {

					// the tc is inside the p2 of the match
					const tc = p2

					const tag_node	= '<span class="tc">'+p2+'</span>'

					return tag_node
				}
				const pattern_tc = tr.get_mark_pattern('tc');
				current_fragment = current_fragment.replace(pattern_tc, get_tc);

			// INDEX IN
				function get_index_in(match, p1,p2,p3,p4,p5,p6,p7, offset){

					// the tag_id is inside the p4 of the match
					const tag_id = p4
					// get all indexation terms of the current tag with match tag_id inside the locator
					// const tags_index	= self.transcription_component.data.tags_index || []
					const tags_index	= self.tags_info.tags_index || []

					const ar_indexation	= tags_index.filter(el =>
						el.data.tag_id	=== tag_id
					)
					const ar_indexation_len = ar_indexation.length

					if(ar_indexation_len>0){

						const indexations = ui.create_dom_element({
								id 				: 'index_'+tag_id,
								element_type	: 'div',
								class_name 		: 'indexations',
								parent 			: left_block
							})
							const indexations_tag = ui.create_dom_element({
								element_type	: 'span',
								class_name 		: 'index tag',
								text_content	: tag_id,
								parent 			: indexations
							})

						const ar_labels = []
						for (let i = 0; i < ar_indexation_len; i++) {
							ar_labels.push(ar_indexation[i].label)
						}
						ui.create_dom_element({
								element_type	: 'a',
								class_name 		: 'index terms',
								href 			: '#tagindex_'+tag_id,
								text_content	: ar_labels.join(', '),
								parent 			: indexations
							})
					}

					const tag_node	= '<a id="tagindex_'+tag_id+'" href="#index_'+tag_id+'" class="index in">'+tag_id+'{</a>'

					return tag_node
				}
				const pattern_index_in = tr.get_mark_pattern('indexIn');
				// Pre-scan for indexIn: if this fragment contains an opening index
				// marker, create a new right_block row and a matching left_block
				// sidebar cell BEFORE calling replace(), so that the get_index_in
				// callback can immediately append its label nodes to the real
				// left_block element. Without the pre-scan the callback would fire
				// while left_block is still '' (the empty-string sentinel).
				const find_indexing = current_fragment.search(pattern_index_in)

				if(find_indexing !== -1){
						right_block = get_new_text_node()
						row++

						left_block = ui.create_dom_element({
							element_type	: 'td',
							class_name		: 'left_block',
							parent			: data_block
						})
						// grid-row pins this sidebar cell to the same visual row as its
						// right_block counterpart in the CSS grid layout
						left_block.style = `grid-row: ${row}`
				}
				current_fragment = current_fragment.replace(pattern_index_in, get_index_in);

			// INDEX OUT
				function get_index_out(match, p1,p2,p3,p4,p5,p6,p7, offset){
					// the tag_id is inside the p4 of the match
					const tag_id	= p4
					const tag_node	= '<a id="out_tagindex_'+tag_id+'" href="#index_'+tag_id+'" class="index out">}'+tag_id+'</a>'
					return tag_node
				}
				const pattern_indexOut = tr.get_mark_pattern('indexOut');
				current_fragment = current_fragment.replace(pattern_indexOut, get_index_out);
				// current_fragment = current_fragment.replace(pattern_indexOut, `<a href=#index_'+tag_id+' class="index out">}$4</a>`);

			// REFERENCE
				function get_reference(match, p1,p2,p3,p4,p5,p6, offset){
					// reference are removed from the text, links are not useful in print
					const tag_node = ''

					return tag_node
				}
				const pattern_reference = tr.get_mark_pattern('reference');
				current_fragment = current_fragment.replace(pattern_reference, get_reference);

			// PERSON
				function get_person(match, p1,p2,p3,p4,p5,p6, offset){
					// the locator is inside the p6 of the match
					const data_string	= p6
					// rebuild the correct locator witht the " instead '
					const data			= data_string.replace(/\'/g, '"')
					// parse the string to object or create new one
					const locator		= JSON.parse(data) || {}
					// get the match of the locator with the tag_persons array inside the instance
					// console.log("self.data:",self.data);
					const tags_persons = self.transcription_component.data.tags_persons || []
					const person = tags_persons.find(el =>
						el.data.section_tipo			=== locator.section_tipo &&
						parseInt(el.data.section_id)	=== parseInt(locator.section_id) &&
						el.data.component_tipo			=== locator.component_tipo
					)
					const tag_node	= person
						? '<div class="person">'+ person.full_name +': </div>'
						: ''
					return tag_node
				}
				const pattern_person = tr.get_mark_pattern('person');
				current_fragment = current_fragment.replace(pattern_person, get_person);

			// NOTE
				function get_note(match, p1,p2,p3,p4,p5,p6,p7, offset){
					// the locator is inside the p7 of the match
					const data_string	= p7
					// rebuild the correct locator witht the " instead '
					const data			= data_string.replace(/\'/g, '"')
					// parse the string to object or create new one
					const locator		= JSON.parse(data) || {}
					// get the match of the locator with the tag_persons array inside the instance
					// console.log("self.data:",self.data);
					// const tags_notes = self.transcription_component.data.tags_notes || []
					const tags_notes	= (self.tags_info.tags_notes || []).filter(item => item != null)

					const note = tags_notes.find(el =>
						el.data.section_tipo			=== locator.section_tipo &&
						parseInt(el.data.section_id)	=== parseInt(locator.section_id) &&
						el.data.component_tipo			=== locator.component_tipo
					)

					if(!note){
						return ''
					}

					const note_title = (note.title)
						? note.title.join(' | ')
						: null

					const note_text = (note.body && note_title)
						? note_title +'. '+ note.body
						: note.body

					// (!) The ternary below is unreachable dead code: the early
					// `if(!note) return ''` guard above already handles the falsy case,
					// so `note` is always truthy here. The else branch ('') can never
					// execute. Do not remove — left as-is per doc-only rule.
					const tag_node	= note
						? '<span class="note"> ['+note_text+'] </span>'
						: ''

					return tag_node
				}
				const pattern_note = tr.get_mark_pattern('note');
				current_fragment = current_fragment.replace(pattern_note, get_note);

			// LANG
				const pattern_lang = tr.get_mark_pattern('lang');
				current_fragment = current_fragment.replace(pattern_lang, `<span class="lang">$6: </span>`);

				right_block.insertAdjacentHTML("beforeend", current_fragment)
		}
		ar_default_render.push(data_block)
	}// end for (let i = 0; i < node_len; i++)


	return ar_default_render
}//end render_default



/**
* RENDER_HEADER
* Builds the metadata header panel shown above the transcript text, displaying
* contextual information about all sections referenced by the transcription
* (e.g. the interview record, the interviewed person, the event) plus participant
* name/role badges for each.
*
* Data sources:
*   self.transcription_component.data.related_sections — the 'related_sections'
*     object returned by the component_text_area JSON controller; has two top-level
*     keys mirroring the API envelope:
*       .context — Array of {model, section_tipo, tipo, label} descriptor objects
*       .data    — Array of {typo, value, …} data items; the item with typo='sections'
*                  holds the Array of related-section locators {section_tipo, section_id}
*   self.transcription_component.data.tags_persons — Array of person objects
*     each: {section_tipo, section_id, role, full_name, …}
*
* Layout produced (one .head block per related section + the component's own section):
*   .head
*     .section_label   — Human-readable ontology label for the section tipo
*     .components
*       .component_container  (one per non-empty component value)
*         <span.component_label>  label + ': '
*         <span.component_value>  joined values (' | ')
*     .components.person_container  (one per person in this section)
*       <span.label.person_role>
*       <span.label.person_name>
*
* The component's own section (transcription_component.section_tipo) is appended
* last in the locator array via spread; its .head block is person-only (no
* section_label / component metadata), because the condition
* `current_locator.section_tipo !== transcription_component.section_tipo` is false.
*
* Component values are derived by filtering data items that match section_tipo,
* component tipo, and section_id, then joining each value array's .value strings.
* Empty or null component values are skipped (continue).
*
* Returns null (not a fragment) when related_sections data is missing or contains
* no 'sections' entry — callers must guard against a null return value.
*
* @param {Object} self - tool_tr_print instance
* @returns {DocumentFragment|null} Fragment containing all .head nodes,
*   or null if related_sections data is unavailable
*/
const render_header = function(self) {

	const transcription_component	= self.transcription_component
	const related_sections			= transcription_component.data.related_sections || null
	const ar_persons				= transcription_component.data.tags_persons || null

	const fragment = new DocumentFragment()

	const datum		= related_sections || {}
	const context	= datum.context
	const data		= datum.data
	// The server emits related_sections only for a text_area whose ontology
	// declares properties.tags_persons; without this guard a component that has
	// none reached `undefined.find(…)` and took the whole tool down on open,
	// despite this function documenting a null return for exactly that case.
	if(!Array.isArray(data)){
		return null
	}
	const sections	= data.find(el => el.typo==='sections')
	if(!sections){
		return null
	}

	// get the value of related sections (the locator of his data)
	const value_ref_sections = sections.value
	// add the self section, the section of the component_text_area, to be processed as common section (for interviewed, camera, etc.)
	// The component's own section is appended last so it always receives a .head
	// block for person badges even when it has no extra context metadata to display.
	const self_transcription_component_section = [{
		section_tipo	: transcription_component.section_tipo,
		section_id		: transcription_component.section_id
	}]
	// create unique array with all locators
	const value			= [...value_ref_sections, ...self_transcription_component_section]
	const value_length	= value.length
	for (let i = 0; i < value_length; i++) {

		const head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'head',
			parent			: fragment
		})

		const current_locator = {
			section_tipo	: value[i].section_tipo,
			section_id		: value[i].section_id
		}
		// Only render the full section metadata block for related sections, not for
		// the component's own section (which is appended to the locator array solely
		// to collect its person badges below).
		if(current_locator.section_tipo !== transcription_component.section_tipo){

			// Find the section-level label from context (model === 'section')
			// and all component-level metadata entries for this section tipo.
			const section_label			= context.find(el => el.model === 'section' && el.section_tipo===current_locator.section_tipo).label
			const ar_component_context	= context.filter(el => el.model !== 'section' && el.section_tipo===current_locator.section_tipo)

			// section label DOM element
			const section_label_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'section_label',
				inner_html		: section_label,
				parent			: head
			})

			const components = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'components',
				parent			: head
			})

			// section_id
				const section_id_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'component_container',
					parent			: components
				})
					ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'component_label',
						inner_html		: 'Id: ',
						parent			: section_id_container
					})
					ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'component_value',
						inner_html		: value[i].section_id || '',
						parent			: section_id_container
					})

			for (let j = 0; j < ar_component_context.length; j++) {

				const current_component			= ar_component_context[j] // toString(ar_component_data[j].value)
				const label						= current_component.label
				const current_component_data	= data.find(el =>
					el.model!=='section' &&
					el.tipo===current_component.tipo &&
					el.section_tipo===current_locator.section_tipo &&
					parseInt(el.section_id)===parseInt(current_locator.section_id)
				)
				// Flatten the component's value array into a single display string;
			// ' | ' separates multi-value fields. Entries are flat strings on the
			// v7 wire (WC-065) or {id, value, …} objects on legacy payloads.
			const current_component_value = current_component_data && current_component_data.value
					? current_component_data.value.map(item => item?.value ?? item).join(' | ')
					: null

				// Skip empty values
				if( !current_component_value || current_component_value.length === 0) {
					continue;
				}

				const component_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'component_container',
					parent			: components
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'component_label',
					text_content	: label + ': ',
					parent			: component_container
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name 		: 'component_value',
					inner_html		: current_component_value,
					parent			: component_container
				})
			}
		}
		const ar_persons_for_this_section = ar_persons.filter(el =>
			el.section_tipo===current_locator.section_tipo &&
			parseInt(el.section_id)===parseInt(current_locator.section_id)
		)
		for (let j = 0; j < ar_persons_for_this_section.length; j++) {

			const current_person = ar_persons_for_this_section[j] // toString(ar_component_data[j].value)

			const person_container = ui.create_dom_element({
				element_type	: 'div',
				class_name 		: 'components person_container',
				parent			: head
			})
				const person_role = ui.create_dom_element({
					element_type	: 'span',
					text_node		: current_person.role + ': ',
					class_name 		: 'label person_role',
					parent			: person_container
				})
				const person_name = ui.create_dom_element({
					element_type	: 'span',
					text_node		: current_person.full_name || '',
					class_name 		: 'label person_name',
					parent			: person_container
				})
		}//end for (let j = 0; j < ar_persons_for_this_section.length; j++)
	}//end for (let i = 0; i < value_length; i++)


	return fragment
}//end render_header



// @license-end
