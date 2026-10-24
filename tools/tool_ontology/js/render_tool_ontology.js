// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {when_in_dom} from '../../../core/common/js/events.js'
	import {append_text_lines} from '../../../core/common/js/utils/index.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'



/**
* RENDER_TOOL_ONTOLOGY
* Client-side render module for tool_ontology.
*
* Provides the `edit` prototype method that tool_ontology delegates to for
* DOM construction. The constructor is a no-op stub; all rendering logic lives
* in the module-private `get_content_data` factory.
*
* Responsibilities:
* - Build the tool's wrapper and content DOM tree via `ui.tool` helpers.
* - Render a user-info header that identifies the ontology node (TLD + section_id
*   in edit mode, or the caller's tipo in list/read mode).
* - Display the total number of records that will be processed.
* - Wire the "Process" button to `self.set_records_in_dd_ontology()` (defined in
*   tool_ontology.js) and relay success/error messages to the UI.
*
* Caller types:
* - **Component** (Tool button on a record): `caller.type === 'component'`.
*   TLD is derived by stripping trailing digits from `caller.section_tipo`
*   (e.g. 'dmm0' → 'dmm').
* - **Section** (Inspector panel button): TLD comes from a `hierarchy6` or
*   `ontology7` datum entry on `caller.datum.data`.
*
* This module is consumed exclusively by tool_ontology.js:
*   `tool_ontology.prototype.edit = render_tool_ontology.prototype.edit`
*/
export const render_tool_ontology = function() {

	return true
}//end render_tool_ontology



/**
* EDIT
* Render tool DOM nodes.
* Called by `tool_common.prototype.render` which is assigned to
* `tool_ontology.prototype.render` in tool_ontology.js.
*
* When `render_level` is 'content', returns the bare content_data element
* without the outer wrapper (used for partial re-renders and embedded views).
* Otherwise returns a full wrapper produced by `ui.tool.build_wrapper_edit`.
*
* @param {Object} options - Render options passed by tool_common.
* @param {string} [options.render_level='full'] - 'full' builds wrapper + content;
*        'content' returns only the inner content_data element.
* @returns {Promise<HTMLElement>} The wrapper element (full) or content_data (content).
*/
render_tool_ontology.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Build and return the tool body element (`content_data`) populated with:
*   1. A user-info header showing the ontology label (from tool labels).
*   2. A term-id header showing either `<TLD><section_id>` (edit mode) or
*      `caller.tipo` (list/read mode).
*   3. A total-records indicator.
*   4. A components container (populated by tool_common's build phase).
*   5. A buttons container holding the "Process" action button.
*   6. A messages container that receives API response text and error classes.
*
* TLD / section_id extraction differs by caller type:
*   - Component caller (`caller.type === 'component'`): TLD is derived by
*     removing trailing digits from `caller.section_tipo` (e.g. 'dmm0' → 'dmm');
*     section_id comes from `caller.section_id`.
*   - Section caller (inspector panel): TLD is read from the first entry of a
*     `hierarchy6` or `ontology7` datum item in `caller.datum.data`; section_id
*     comes from `caller.data.entries[0].section_id`.
*
* If caller hierarchy data cannot be resolved, an inline error element is
* rendered and the function still returns a valid (partially built) content_data.
*
* (!) Throws synchronously before the try/catch if `self` or `self.caller` is
* falsy — those errors propagate to the caller (the `edit` method above).
*
* @param {Object} self - The tool_ontology instance.
* @param {Object} self.caller - The component or section that opened the tool.
* @returns {Promise<HTMLElement>} The assembled content_data element.
* @throws {Error} When `self` or `self.caller` is missing/falsy (guard before try/catch).
*/
const get_content_data = async function(self) {

	// Input validation
	if (!self || !self.caller) {
		throw new Error('Invalid self parameter: missing caller property');
	}

	// Create content_data (moved up for closure access)
	const content_data = ui.tool.build_content_data(self);

	const fragment = new DocumentFragment()

	// Create user_info header
	const tool_label = self.get_tool_label('export_to_jer_dd') || 'Export to jer_dd';
	ui.create_dom_element({
		element_type	: 'h3',
		class_name		: 'user_info',
		text_content	: `${tool_label}: `,
		parent			: fragment
	})

	/**
	* Extract TLD and section_id from caller based on type.
	* For components: TLD is derived from section_tipo (removing trailing digits).
	* For sections: TLD comes from hierarchy6 or ontology7 data in datum.
	*
	* Wrapped in try/catch so that a missing or malformed hierarchy datum renders
	* a fallback error element rather than aborting the whole content build.
	*/
	try {

		let tld, section_id

		const caller = self.caller

		// Caller could be a section or a component
		if (caller.type === 'component') {
			// Component caller case (Tool buttons)
			// Extract TLD by removing trailing digits: dmm0 => dmm
			tld = caller.section_tipo.replace(/\d+$/, '')
			section_id = caller.section_id
		} else {
			// Section caller case (Inspector button)
			const data = caller.datum?.data || []
			const hierarchy_data = data.find(el =>
				el.tipo === 'hierarchy6' || el.tipo === 'ontology7'
			)

			if (!hierarchy_data || !hierarchy_data.entries || !hierarchy_data.entries[0] || !hierarchy_data.entries[0].value) {
				throw new Error('No valid hierarchy data found');
			}

			tld = hierarchy_data.entries[0].value
			section_id = caller.data?.entries?.[0]?.section_id
		}

		// Calculate display info based on caller mode
		// In edit mode: show TLD + section_id (e.g., "dmm123")
		// In other modes: show the caller's tipo
		const info = caller.mode === 'edit'
			? `${tld}${section_id || ''}`
			: caller.tipo

		ui.create_dom_element({
			element_type	: 'h3',
			class_name		: 'user_info term_id',
			text_content	: info,
			parent			: fragment
		})

		// Calculate total records to process.
		// Edit mode always processes exactly 1 record (the currently open item).
		// List/read mode uses caller.total, which reflects the current SQO result count.
		const total = caller.mode === 'edit'
			? 1
			: (caller.total || 0)

		ui.create_dom_element({
			element_type	: 'h3',
			class_name		: 'user_info total',
			text_content	: `${get_label.total}: ${total}`,
			parent			: fragment
		})

	} catch (error) {
		console.error('Error processing hierarchy data:', error);
		ui.create_dom_element({
			element_type	: 'h2',
			class_name		: 'user_info',
			text_content	: 'Invalid source (hierarchy6|ontology7)',
			parent			: fragment
		})
	}

	// components container
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'components_container',
		parent			: fragment
	})

	// buttons container
	const buttons_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'buttons_container',
		parent			: fragment
	})

	// Create messages container (moved up for closure access)
	const messages_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'messages_container',
		parent			: fragment
	})

	// button_generate
	const button_generate = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'warning gear button_generate',
		inner_html		: self.get_tool_label('process') || 'Process',
		parent			: buttons_container
	})
	/**
	* CLICK_HANDLER
	* Handles the process button click event.
	* Manages UI state (spinner, loading class), calls the API method,
	* and displays success/error messages in the messages container.
	*
	* Uses `button_generate.generating` as a re-entrancy guard to prevent
	* duplicate API calls if the user clicks the button while a request is
	* already in flight. The flag is always cleared in the `finally` block.
	*
	* @param {Event} e - Click event
	* @returns {Promise<void>}
	*/
	const click_handler = async (e) => {
		e.stopPropagation()

		// Generating control to avoid duplicate calls
		if (button_generate.generating) {
			return
		}
		button_generate.generating = true

		let spinner = null

		try {
			// Reset UI state
			// Messages clean
			[messages_container].forEach(el => el.classList.remove('error'))
			// Loading
			content_data.classList.add('loading')
			messages_container.replaceChildren()

			// Add spinner to the button
			button_generate.classList.add('button_spinner')

			// Call API to process records in dd_ontology
			const api_response = await self.set_records_in_dd_ontology()

			// Failure: the ONE error surface. The policy decides what to show and
			// renders the server text as TEXT (DS-1) — no HTML sink here.
			if (request_failed(api_response)) {
				messages_container.classList.add('error')
				await handle_api_error(api_response.error, {wrapper: messages_container})
				return
			}

			// User messages. Envelope v2 has NO prose on a success: the run sentence
			// is the payload's `summary` and the non-fatal per-record notes are its
			// `errors` (tools/tool_ontology/server/tool_ontology.ts
			// ontologyWriteResponse). Server text (labels, tipos, file paths):
			// appended as TEXT nodes separated by real <br> elements, never parsed
			// as HTML.
			const ontology_data	= response_data(api_response) || {}
			const summary		= ontology_data.summary
			const msg_lines		= Array.isArray(summary)
				? summary
				: [summary || 'Unknown error']
			append_text_lines(
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg',
					parent			: messages_container
				}),
				msg_lines
			)

			// A SUCCESS can still carry warnings in the payload's `errors` (per-record
			// notes, not a wire failure) — same TEXT treatment.
			const ontology_notes = ontology_data.errors
			if (Array.isArray(ontology_notes) && ontology_notes.length > 0) {
				append_text_lines(
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						parent			: messages_container
					}),
					ontology_notes
				)
			}

		} catch (error) {
			console.error('Error in click_handler:', error)
			// exception text: TEXT only (DS-1)
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error',
				text_content	: 'Error: ' + (error.message || 'Unknown error'),
				parent			: messages_container
			})
			messages_container.classList.add('error')
		} finally {
			// Clean up UI state
			content_data.classList.remove('loading')
			button_generate.classList.remove('button_spinner')
			button_generate.generating = false
		}
	}
	button_generate.addEventListener('click', click_handler)

	// focus buttons
	when_in_dom(button_generate, () => {
		// Keep focus on the process button once it enters the DOM.
		// The tool opens in a modal whose own focus management may steal focus;
		// this restores it with a 1 ms setTimeout re-focus on every blur event.
		// (!) The blur listener is never removed, which may cause repeated re-focus
		// attempts after the button is detached — a known minor side-effect.
		function keep_focus(target) {
		  target.focus({ preventScroll: true });
		  target.addEventListener('blur', () => {
		    // Re-focus if something else tries to steal it
		    setTimeout(() => target.focus({ preventScroll: true }), 1);
		  });
		}
		keep_focus(button_generate);
	})

	// Assemble final content
	content_data.appendChild(fragment);


	return content_data
}//end get_content_data



// @license-end
