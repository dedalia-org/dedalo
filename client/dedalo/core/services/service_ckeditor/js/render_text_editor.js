// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_TEXT_EDITOR
* DOM-rendering helpers for the Dédalo CKEditor service.
*
* Exports two factory functions consumed exclusively by service_ckeditor:
*   - render_button          — builds a single custom toolbar button node
*   - render_find_and_replace — builds a full Find-and-Replace modal backed by
*                               CKEditor's FindAndReplaceEditing plugin
*
* These helpers are intentionally kept separate from service_ckeditor.js so
* that rendering concerns (DOM construction, event binding) stay isolated from
* the editor lifecycle and plugin wiring that lives in the service.
*
* NOTE: The commented-out render_toolbar export below is a retained stub
* (not yet in use). Do not remove — it is a tracked dead-code block.
*/
	import {ui} from '../../../common/js/ui.js'



/**
* RENDER_TOOLBAR
* Called from services to render generic toolbar.
* NOTE: This export is commented out and retained as a tracked dead-code stub.
* @param {Object} options
* @returns {HTMLElement} fragment
*/
	// export const render_toolbar = function() {

	// 	const toolbar_container = ui.create_dom_element({
	// 		element_type	: 'div',
	// 		class_name		: 'toolbar'
	// 	})

	// 	return toolbar_container
	// }//end render_toolbar



/**
* RENDER_BUTTON
* Builds a single <span>-based toolbar button for the Dédalo CKEditor toolbar.
*
* The button is a <span class="toolbar_button [name] [class_name]"> element
* that optionally contains either an <img> icon (when no text label is supplied)
* or raw innerHTML text.
*
* When manager_editor is true the click handler is intentionally NOT attached,
* leaving event control entirely to the editor manager (read-only / reviewer
* mode). This prevents duplicate or conflicting handler registrations.
*
* @param {Object} button_config - Configuration object for the button.
* @param {string} button_config.name - Identifier; also appended as a CSS class
*   unless the value is '|' (separator token), in which case no extra class is added.
* @param {Object} button_config.options - Display and behaviour options.
* @param {string} [button_config.options.image] - URL of the SVG/PNG icon to show
*   when no text label is provided.
* @param {string} [button_config.options.text=''] - Inner HTML label text. When
*   non-empty the icon <img> is omitted.
* @param {string} [button_config.options.class_name] - Additional CSS class(es)
*   to append to the button element.
* @param {string} [button_config.options.tooltip] - Tooltip text (declared but
*   not yet applied to the DOM — reserved for future use).
* @param {Function} [button_config.options.onclick] - Click handler to attach via
*   addEventListener. Ignored when manager_editor is true.
* @param {boolean} [button_config.manager_editor] - When true, suppresses the
*   click handler to allow the editor manager to control the button externally.
* @returns {HTMLElement} The fully constructed button <span> element.
*/
export const render_button = function(button_config) {

	// button_config
		const name				= button_config.name
		const image				= button_config.options.image
		const text				= button_config.options.text || ''
		const class_name		= button_config.options.class_name
			? ' ' + button_config.options.class_name
			: ''
		const tooltip			= button_config.options.tooltip
		const onclick			= button_config.options.onclick
		const manager_editor	= button_config.manager_editor

	// button_node
		// Separators (name === '|') must not get a name-derived class or they
		// will appear visually identical to labelled buttons.
		const name_to_class = name !== '|'
			? ' ' + name
			: ''

		const button_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'toolbar_button' + name_to_class + class_name,
			inner_html		: text
		})

	// icon svg
	 	if(text==='') {
	 		// button_icon
		 	// Only render the icon image when there is no text label; both modes
		 	// are mutually exclusive — text takes precedence over image.
		 	ui.create_dom_element({
				element_type	: 'img',
				src				: image,
				// a11y: icon-only toolbar button — the icon carries its name
				alt				: tooltip || name || '',
				parent			: button_node
			})
	 	}

	// events
		// Skip event binding when manager_editor is true so that the caller
		// (the editor manager) retains full control over button behaviour.
		if(manager_editor!==true && typeof onclick==='function'){
			button_node.addEventListener("click", onclick)
		}


	return button_node
}//end render_button



/**
* RENDER_FIND_AND_REPLACE
* Builds and opens a Find-and-Replace modal dialog backed by CKEditor's
* FindAndReplaceEditing plugin.
*
* The modal contains:
*   - A search input + "Search" button that calls editor.execute('find', ...)
*   - Previous / Next navigation buttons (findPrevious / findNext commands)
*   - A result counter <span> updated after each search
*   - A replace input + individual "Replace" button (replaces the highlighted
*     match via the 'replace' command) and a "Replace All" button
*   - Match-case and Whole-words checkbox toggles that feed into the options
*     object passed to the 'find' command on the next invocation
*
* State management:
*   find_options — mutable local object; updated synchronously by the checkbox
*     click handlers; read at the moment the user clicks "Search". Not reactive.
*   self.results — CKEditor ResultsView collection returned by editor.execute('find');
*     its .length is displayed in result_label. Updated only on "Search" click.
*
* The modal is created via ui.attach_to_modal and returned; service_ckeditor
* is responsible for positioning / showing it. The on_close callback clears the
* FindAndReplace plugin state so highlights are removed when the user dismisses
* the modal.
*
* (!) Typing in the search field triggers state.clear() + findAndReplaceEditing.stop()
*     on every keyup, resetting any active search. This is intentional — it prevents
*     stale highlights while the user is still typing the new query.
*
* (!) result_label starts empty (no search has run at construction time)
*     at mount and is only updated to the real count after the first "Search" click.
*
* @param {Object} editor - A live CKEditor 5 editor instance. Must have the
*   FindAndReplaceEditing plugin loaded.
* @returns {Object} modal - The dd-modal Web Component instance returned by
*   ui.attach_to_modal. Exposes an on_close callback property.
*/
export const render_find_and_replace = function(editor) {

	const self = {}

	// Retrieve the FindAndReplaceEditing plugin instance and its shared state
	// object so we can drive find/clear/stop operations without going through
	// the command layer for every interaction.
	const findAndReplaceEditing	= editor.plugins.get( 'FindAndReplaceEditing' );
	const state					= findAndReplaceEditing.state;
	// find_options is mutated in place by the checkbox handlers below; it is
	// passed to editor.execute('find', ...) on each Search click.
	const find_options			= {
		match_case	: false,
		whole_words	: false
	}

	self.results = 0

	// title (modal)
		const title_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'title_container'
		})
		const title_label = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'title_label',
			inner_html		: get_label.find_and_replace || 'Find and replace',
			parent			: title_container
		})

	// body (modal)
		const body_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body content find_and_replace'
		})

		// search
		const input_search = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'input_search',
			placeholder		: get_label.search || 'Search',
			parent			: body_container
		})
		// Each keystroke resets the active search so old highlights are cleared
		// before a new query is executed with the Search button.
		input_search.addEventListener('keyup',function(){
			state.clear( editor.model );
			findAndReplaceEditing.stop();
		})

		const button_search = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning button_search',
			inner_html		: get_label.search || 'Search',
			parent			: body_container
		})
		button_search.addEventListener('click',() => {
			if(!input_search.value){
				return
			}
			// editor.execute('find') returns { findCallback, results } where
			// results is a CKEditor ResultsView live-collection. We capture it
			// on self.results and update the counter label immediately.
			const { findCallback, results } = editor.execute( 'find', input_search.value,
				{
					matchCase	: find_options.match_case,
					wholeWords	: find_options.whole_words
				}
			);
			self.results  = results
			result_label.innerHTML = self.results.length
		})

		const button_previous = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_previous',
			inner_html		: get_label.previous || 'Previous',
			parent			: body_container
		})
		button_previous.addEventListener('click',() => {
			editor.execute( 'findPrevious' );
		})

		const button_next = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_next',
			inner_html		: get_label.next || 'Next',
			parent			: body_container
		})
		button_next.addEventListener('click',() => {
			editor.execute( 'findNext' );
		})

		// result_label displays the number of matches found by the last Search.
		// It starts EMPTY — there is no search yet — and every "Search" click writes
		// `self.results.length` into it below.
		const result_label = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'result_label',
			text_content	: '',
			parent			: body_container
		})

	// replace
		const replace_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'replace_container',
			parent			: body_container
		})
		const input_replace = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'input_replace',
			placeholder		: get_label.replace || 'Replace',
			parent			: replace_container
		})
		const button_replace = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_replace',
			inner_html		: get_label.replace || 'Replace',
			parent			: replace_container
		})
		button_replace.addEventListener('click',() => {
			// Only replace when there is an active highlighted match. Calling
			// 'replace' with a null result is a no-op but we guard anyway to
			// avoid unnecessary command dispatch.
			const high_lighted_result = state.highlightedResult;
			if ( high_lighted_result ) {
				editor.execute( 'replace', input_replace.value, high_lighted_result );
			}
		})
		const button_replace_all = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_replace_all',
			inner_html		: get_label.replace_all || 'Replace All',
			parent			: replace_container
		})
		button_replace_all.addEventListener('click',() => {
			editor.execute( 'replaceAll', input_replace.value, input_search.value );
		})

	// options_container
		const options_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'options_container',
			parent			: replace_container
		})

		// match_case
			// Custom checkbox pair: a hidden <input type="checkbox"> controlled by
			// a sibling <label class="check"> acting as a visual toggle. Clicking
			// the label flips the checked state and mirrors it onto find_options
			// so the next Search call picks it up.
			const label_match_case = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'label_match_case',
				inner_html		: get_label.match_case  || 'Match case',
				parent			: options_container
			})
			const match_case = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'check',
				parent			: options_container
			})
			const button_match_case = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'check_match_case',
				name			: 'match_case',
				parent			: match_case
			})
			const selector_match_case = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'check',
				parent			: match_case
			})
			selector_match_case.addEventListener('click',function(){
				// Toggle the underlying checkbox and sync find_options in one step.
				button_match_case.checked = button_match_case.checked
					? false
					: true

				find_options.match_case = button_match_case.checked
					? true
					: false
			})

		// whole_words
			// Same custom-checkbox pattern as match_case above; targets the
			// wholeWords flag of the CKEditor 'find' command.
			const label_whole_words = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'label_whole_words',
				inner_html		: get_label.whole_words  || 'Whole words',
				parent			: options_container
			})
			const whole_words = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'check',
				parent			: options_container
			})
			const button_whole_words = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'check_whole_words',
				name			: 'whole_words',
				parent			: whole_words
			})
			const selector_whole_words = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'check',
				parent			: whole_words
			})
			selector_whole_words.addEventListener('click',function(){

				button_whole_words.checked = button_whole_words.checked
					? false
					: true

				find_options.whole_words = button_whole_words.checked
					? true
					: false
			})

	// modal
		// remove_overlay:true lets the user continue interacting with the editor
		// while the Find-and-Replace dialog is open (non-blocking overlay).
		const modal = ui.attach_to_modal({
			header			: title_container,
			body			: body_container,
			size			: 'small',
			remove_overlay	: true
		})
		// Clear all CKEditor search highlights when the modal is closed so the
		// document does not retain stale match decorations.
		modal.on_close = ()=>{
			state.clear( editor.model );
			findAndReplaceEditing.stop();
		}


	return modal
}//end render_find_and_replace



// @license-end

