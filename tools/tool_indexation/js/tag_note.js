// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, get_label, SHOW_DEBUG */
/* eslint no-undef: "error"*/



/**
* TAG_NOTE
* Mixin module that adds "indexation note" rendering to tool_indexation.
*
* Purpose
* -------
* Each index tag created inside a transcription (component_text_area) may carry
* an associated note record — a small free-text memo stored as a separate Dédalo
* section (tipo `rsc377`, the DEDALO_INDEXATION_SECTION_TIPO constant). The note
* has two components: a short title (rsc379) and a longer description (rsc380).
*
* When the user clicks an index tag in the text editor the tool fires
* `click_tag_index_<id_base>`, which calls `render_indexation_note`. That function
* inspects the tag's `data` field — a pseudo-stringified locator object — and
* either renders the existing note (via `render_note`) or offers a button to
* create a fresh note record (via `render_empty_note`).
*
* Integration
* -----------
* This file does NOT export a standalone class. Instead `tag_note` is a
* constructor whose prototype methods are copied onto `tool_indexation.prototype`
* in tool_indexation.js:
*
*   tool_indexation.prototype.render_indexation_note = tag_note.prototype.render_indexation_note
*   tool_indexation.prototype.render_empty_note       = tag_note.prototype.render_empty_note
*   tool_indexation.prototype.render_note             = tag_note.prototype.render_note
*
* The `self` inside every method therefore refers to the live `tool_indexation`
* instance, giving access to:
*   self.DEDALO_INDEXATION_SECTION_TIPO / TITLE_TIPO / DESCRIPTION_TIPO
*   self.transcription_component   — the component_text_area being indexed
*   self.indexation_note           — the DOM container managed by render_tool_indexation
*   self.title_instance            — stored so the caller can activate it in-viewport
*
* Tag data format
* ---------------
* A tag object passed from component_text_area looks like:
*   {
*     tag_id : string,           // unique identifier within the text
*     state  : 'n'|'r'|'d',     // normal / to-review / deleted
*     label  : string,           // visible text in the editor
*     data   : string            // pseudo-JSON locator, single-quotes used as delimiters:
*                                //   "{'section_tipo':'rsc377','section_id':42}"
*   }
*
* The `data` field uses single quotes instead of standard JSON double quotes
* because it is stored in an HTML dataset attribute. `render_indexation_note`
* replaces them before parsing.
*
* Exports
* -------
*   tag_note          — constructor (only used for its prototype)
*   (module-private)  new_tag_note — async helper that POSTs a create RQO
*/



// imports
	import {get_instance} from '../../../core/common/js/instances.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {JSON_parse_safely} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {when_in_viewport} from '../../../core/common/js/events.js'



/**
* TAG_NOTE
* Placeholder constructor whose prototype methods are mixed into tool_indexation.
* Constructing a tag_note instance directly serves no purpose; the prototype
* methods are extracted and grafted onto tool_indexation.prototype at module load
* time (see tool_indexation.js).
*/
export const tag_note = function() {

	return true
}//end tag_note



/**
* RENDER_INDEXATION_NOTE
* Entry point called every time the user selects an index tag in the editor.
* Decides whether to render an existing note or an empty-state "create" button.
*
* Flow:
*  1. Guard: if `tag.data` is absent or too short to be a real locator, delegate
*     to `render_empty_note` and return early.
*  2. Normalise the stored pseudo-JSON (single-quote → double-quote) and parse it.
*  3. Validate that the locator carries `section_tipo` and `section_id`.
*  4. If valid, call `render_note({ locator })` to build the title + description nodes.
*
* @param {Object} tag - Tag descriptor from component_text_area's click event.
*   Expected shape: { tag_id, state, label, data }
*   where `data` is a single-quote-delimited JSON locator string
*   e.g. "{'section_tipo':'rsc377','section_id':7}"
* @returns {Promise<DocumentFragment|HTMLElement|null>} Resolves to:
*   - A DocumentFragment containing the title + description nodes (existing note)
*   - An HTMLElement with the "Create note" button (no note yet)
*   - null if the locator was malformed (logged as a warning)
*/
tag_note.prototype.render_indexation_note = async function(tag) {

	const self = this

	// short vars
		const data = tag.data || null

	// debug
		if(SHOW_DEBUG===true) {
			// console.log('tag_note render_indexation_note received tag data:', data);
		}

	// check data is valid
		if (!data || data.length<5) {
			// console.log("Ignored empty data on get_indexation_note_context")
			const tag_note_node = self.render_empty_note(tag)

			return tag_note_node
		}

	// safe_data. replace non standard JSON quotes used to store data into dataset
		const safe_data = data.replaceAll('\'', '"')

	// parse stringified locator
		const locator = JSON_parse_safely(
			safe_data,
			'Error on parse indexation note'
		)

	// check valid locator
		if (!locator.section_tipo || !locator.section_id) {
			console.warn("Error on parse tag data:", data, locator)

			return null
		}

	// render
		const tag_note_node = await self.render_note({
			locator : locator
		})


	return tag_note_node
}//end render_indexation_note



/**
* RENDER_EMPTY_NOTE
* Renders a placeholder container shown when a tag has no associated note yet.
* The container holds a single "Create tag info note" button. Clicking it:
*  1. Asks the user for confirmation with the application modal dialog
*     (`ui.confirm`, same visual language as the inspector's "New record").
*  2. Calls `new_tag_note` to POST a new `rsc377` record.
*  3. Writes the returned `section_id` back into the tag's `data` field via
*     `transcription_component.update_tag`, then immediately saves the editor so
*     the link is persisted even if the user navigates away.
*  4. Clears `self.indexation_note` and re-renders the newly created note in place.
*  5. Uses `when_in_viewport` to activate the title instance only once it enters
*     the visible scroll area (avoids unnecessary DOM work for off-screen content).
*
* Side effects:
*   - Mutates `self.indexation_note` (DOM container held by the tool UI).
*   - Calls `self.transcription_component.save_editor()` immediately after tagging.
*   - Sets `self.title_instance` so the caller can reference the rendered instance.
*
* (!) `alert()` is used on note-creation failure with CLIENT-side text only —
*     never a server message. Server failures are ApiErrors and go through
*     handle_api_error (see new_tag_note).
*
* @param {Object} tag - Tag descriptor from component_text_area.
*   Shape: { tag_id: string, state: string, label: string, data: string }
* @returns {HTMLElement} A div.empty_note containing the create button.
*/
tag_note.prototype.render_empty_note = function(tag) {

	const self = this

	const empty_note_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'empty_note'
	})

	const label = self.get_tool_label('create_tag_info_note') || 'Create tag info note'
	const button_new_note = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'warning new',
		text_content		: label,
		parent			: empty_note_container
	})
	button_new_note.addEventListener('click', async function(e){
		e.stopPropagation()

		// user confirm. Dédalo modal dialog (ui.confirm), never window.confirm
			const confirmed = await ui.confirm({
				header			: (get_label.new || 'New') + ' ' + (get_label.note || 'note'),
				note			: tag.label || null,
				body			: get_label.sure || 'Are you sure?',
				accept_class	: 'brand new'
			})
			if (confirmed!==true) {
				return false
			}

		const section_tipo = self.DEDALO_INDEXATION_SECTION_TIPO

		// create a new tag record
		new_tag_note(tag, section_tipo)  // return promise resolve: int|null
		.then(async function(new_section_id) {

			// check received value
				if(!new_section_id) {
					console.error('Failed to create note. tag, section_tipo, new_section_id:', tag, section_tipo, new_section_id);
					alert("Failed to create note");
					return
				}

			// Created new_section_id. Update tag data into component_text_area

			// new_data_obj
				const new_data_obj = {
					state : tag.state,
					label : tag.label,
					data : {
						section_tipo	: section_tipo,
						section_id		: new_section_id
					}
				}

			// update_tag
				self.transcription_component.update_tag({
					type			: 'indexIn',
					tag_id			: tag.tag_id,
					new_data_obj	: new_data_obj,
					key				: 0
				})
				.then(function(response){
					console.log('update_tag response:', response);
				})

			// save component_text_area to prevent loosing the connection with the tag
				const save = await self.transcription_component.save_editor()
				if (save===false) {
					console.log('Error. Failed to save transcription_component ');
					alert('Failed transcription save');
				}

			// container. Get and clean
				const container	= self.indexation_note
				while (container.lastChild) {
					container.removeChild(container.lastChild)
			}

			// render tag_note info into the container
				self.render_note({
					locator : {
						section_tipo	: section_tipo,
						section_id		: new_section_id
					}
				})
				.then(function(tag_note_node){
					container.appendChild(tag_note_node)

					when_in_viewport(
						self.title_instance.node,
						() => {
							// activate when in DOM
							ui.component.activate(self.title_instance)
						}
					)
				})
		})
	})//end event click


	return empty_note_container
}//end render_empty_note



/**
* RENDER_NOTE
* Instantiates and builds the two note components (title + description) for an
* existing note record and returns them in a DocumentFragment ready to append.
*
* Both components are created with `mode:'edit'` so the user can edit them
* in-line. Their `.show_interface.tools` flag is set to false to suppress the
* component's own toolbar (the tool provides its own UI chrome).
*
* After this call, `self.title_instance` is populated so that
* `render_empty_note`'s `when_in_viewport` callback can reference it.
*
* Component types used:
*   - DEDALO_INDEXATION_TITLE_TIPO       (rsc379) → model: component_input_text
*   - DEDALO_INDEXATION_DESCRIPTION_TIPO (rsc380) → model: component_text_area
*
* @param {Object} options - Options object.
* @param {Object} options.locator - Section locator for the note record.
*   Shape: { section_tipo: string, section_id: number|string }
*   Both fields are required; absence will cause get_instance to fail.
* @returns {Promise<DocumentFragment>} Fragment containing the rendered title
*   node followed by the rendered description node.
*/
tag_note.prototype.render_note = async function(options) {

	const self = this

	// options
		const locator = options.locator

	// short vars
		const section_id	= locator.section_id
		const section_tipo	= locator.section_tipo

	const fragment = new DocumentFragment()

	// title
		const title_instance = await get_instance({
			tipo			: self.DEDALO_INDEXATION_TITLE_TIPO,
			section_tipo	: section_tipo,
			section_id		: section_id,
			mode			: 'edit',
			lang			: page_globals.dedalo_data_lang,
			model			: 'component_input_text'
		})
		await title_instance.build(true)
		// show_interface
		title_instance.show_interface.tools = false
		const title_node = await title_instance.render()
		// set instance
		self.title_instance = title_instance
		fragment.appendChild(title_node)

	// description
		const description_instance = await get_instance({
			tipo			: self.DEDALO_INDEXATION_DESCRIPTION_TIPO,
			section_tipo	: section_tipo,
			section_id		: section_id,
			mode			: 'edit',
			lang			: page_globals.dedalo_data_lang,
			model			: 'component_text_area'
		})
		await description_instance.build(true)
		// show_interface
		description_instance.show_interface.tools = false
		const description_node = await description_instance.render()
		fragment.appendChild(description_node)


	return fragment
}//end render_note



/**
* NEW_TAG_NOTE
* Module-private async function that creates a new note section record via the
* core data API and returns the new section_id on success.
*
* Sends a `create` RQO targeting the indexation-note section tipo. The server
* allocates a new record and returns its integer id in `api_response.result`.
*
* Error handling: a failed call is an ApiError on the envelope — it goes to
* handle_api_error (ONE model, ONE renderer) and the function returns null. A
* successful call with no usable id returns null silently; the caller reports it.
*
* (!) The `tag` parameter is only used for debug logging; it is not sent to the
*     server.
*
* @param {Object} tag - Tag descriptor (used only for logging/error context).
*   Shape: { tag_id: string, ... }
* @param {string} section_tipo - Ontology tipo of the note section (rsc377).
* @returns {Promise<number|null>} Resolves to the new section_id (positive integer)
*   or null if creation failed.
*/
const new_tag_note = async function(tag, section_tipo) {

	// create record
		const rqo = {
			action	: 'create',
			source	: {
				section_tipo : section_tipo
			}
		}
		const api_response = await data_manager.request({
			body : rqo
		})
		if(SHOW_DEBUG===true) {
			console.log("api_response for tag:", tag);
			console.log("api_response:", api_response);
		}

	// error manage. The server's own account of the failure is an ApiError: the
	// dispatcher picks the surface and the renderer emits TEXT (never alert(),
	// which shows raw, unlocalised server strings). A response that succeeded but
	// carries no usable id has no ApiError behind it — the caller reports that one.
		const new_record = response_data(api_response)
		if (request_failed(api_response) || !new_record || new_record<1) {
			console.error('new_tag_note failed. tag, api_response:', tag, api_response);
			if (request_failed(api_response)) {
				await handle_api_error(api_response.error, {})
			}
			return null;
		}

	// OK response
		const new_section_id = new_record // int


	return new_section_id
}//end new_tag_note



// @license-end
