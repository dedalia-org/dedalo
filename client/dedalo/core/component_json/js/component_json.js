// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_ROOT_WEB */
/*eslint no-undef: "error"*/



// imports
	import {common} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_json} from '../../component_json/js/render_edit_component_json.js'
	import {render_list_component_json} from '../../component_json/js/render_list_component_json.js'



/**
* COMPONENT_JSON
* Client-side component for storing and editing arbitrary JSON values.
*
* Each instance wraps a single JSON document (or null) held in
* `data.entries[0].value`. The component delegates rendering to view modules:
*   - edit/list/tm  → render_edit_component_json / render_list_component_json
*   - search        → render_search_component_json
*
* Shared utility functions exported from this module are consumed by all view
* modules to keep change-handling logic in one place:
*   - parse_editor_content  – normalises {json}/{text} editor output
*   - build_changed_data_item – constructs the frozen payload for set_changed_data
*   - handle_json_change    – wires editor onChange to component state
*
* Data shape (component_json.data):
*   {
*     entries : [ { id: number|null, value: * } ],  // always length 0 or 1
*     q_operator : string|null                       // search mode only
*   }
*
* Changed-data shape written by build_changed_data_item:
*   { action: 'update', id: number|null, value: { value: * } }
*
* Prototype methods are mixed in from component_common and common so that only
* JSON-specific behaviour lives here; see the prototype-assign block below.
*
* @exports component_json
* @exports parse_editor_content
* @exports build_changed_data_item
* @exports handle_json_change
*/
export const component_json = function(){

	this.id					= null

	this.model				= null
	this.tipo				= null
	this.section_tipo		= null
	this.section_id			= null
	this.mode				= null
	this.lang				= null
	this.section_lang		= null

	this.context			= null
	this.data				= null

	this.parent				= null
	this.node				= null

	this.tools				= null

	this.editors			= []
	this.change_timers		= {} // pending debounced onChange per editor key

	// save_on_deactivate. Prevent to auto-save value when component is deactivated
	this.save_on_deactivate	= false

	// search config
	this.q_split = true
}//end component_json



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// lifecycle
	component_json.prototype.init				= component_common.prototype.init
	component_json.prototype.build				= component_common.prototype.build
	component_json.prototype.render				= common.prototype.render
	component_json.prototype.refresh			= common.prototype.refresh
	// the generic teardown knows nothing about self.editors: each JSONEditor
	// (a CodeMirror instance) would outlive its record
	component_json.prototype.destroy			= async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		for (const editor of self.editors) {
			if (editor && typeof editor.destroy==='function') {
				try { editor.destroy() } catch (error) { console.error('[component_json] editor teardown failed:', error) }
			}
		}
		self.editors = []
		self.cancel_pending_changes()
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}

	// change data
	component_json.prototype.save				= component_common.prototype.save
	component_json.prototype.update_data_value	= component_common.prototype.update_data_value
	component_json.prototype.update_datum		= component_common.prototype.update_datum
	component_json.prototype.change_value		= component_common.prototype.change_value
	component_json.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_json.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_json.prototype.list				= render_list_component_json.prototype.list
	component_json.prototype.edit				= render_edit_component_json.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_json.prototype.search				= async function(options) {
		const {render_search_component_json} = await import('../../component_json/js/render_search_component_json.js')
		return render_search_component_json.prototype.search.call(this, options)
	}
	component_json.prototype.change_mode		= component_common.prototype.change_mode



/**
* PARSE_EDITOR_CONTENT
* Normalises the content object returned by the JSONEditor library into a
* plain JavaScript value suitable for persistence.
*
* JSONEditor emits one of two shapes depending on the active mode:
*   {json: value}   – structured mode; value is already a JS value (object,
*                     array, primitive, or undefined when the editor is empty).
*   {text: string}  – text mode; value is a raw JSON string that must be
*                     parsed, or an empty string that maps to null.
*
* When `content.json` is present (even if it is null or false) the structured
* value is used directly, avoiding a redundant serialise/parse round-trip.
*
* @param {Object} content - Editor content emitted by JSONEditor onChange/get():
*                           {json: *} (structured) or {text: string} (text mode)
* @returns {*} The resolved JavaScript value, or null when the editor is empty
*/
export const parse_editor_content = function(content) {

	if (content.json !== undefined) {
		return content.json
	}

	if (content.text === '' || content.text === undefined || content.text === null) {
		return null
	}

	try {
		return JSON.parse(content.text)
	} catch (error) {
		console.error('parse_editor_content: invalid JSON text', content.text, error)
		return null
	}
}//end parse_editor_content



/**
* BUILD_CHANGED_DATA_ITEM
* Constructs the frozen changed_data_item payload expected by
* component_common.set_changed_data and ultimately by the server save API.
*
* The returned object is frozen to prevent accidental mutation after it has
* been enqueued. The value is wrapped in an extra `{ value: … }` envelope
* because the server-side component unpacks one level of nesting when
* persisting entries (matching the data.entries[n] shape on read).
*
* Used by:
*   - handle_json_change  (edit views via JSONEditor onChange)
*   - set_value           (programmatic value assignment)
*   - save_sequence       (explicit save with validation)
*   - render_search_component_json (search input onChange)
*
* @param {*} value - The parsed JavaScript value to persist (any JSON-safe type)
* @param {number|null} id - Entry id taken from data.entries[n].id; null for new entries
* @returns {Object} Frozen changed_data_item: { action, id, value: { value } }
*/
export const build_changed_data_item = function(value, id=null) {

	const changed_data_item = Object.freeze({
		action	: 'update',
		id		: id,
		value	: { value : value }
	})

	return changed_data_item
}//end build_changed_data_item



/**
* HANDLE_JSON_CHANGE
* Shared onChange handler wiring the JSONEditor instance to component state.
* Called from the editor's onChange callback inside view_default_edit_json
* whenever the editor content changes without parse errors.
*
* Steps:
*  1. Parses the raw editor content into a JS value via parse_editor_content.
*  2. Deep-clones the value through JSON round-trip to produce an immutable
*     snapshot (prevents aliasing between the editor's internal state and the
*     component's changed_data queue).
*  3. Resolves the entry id from data.entries[key] (optional chaining returns
*     null for new/empty entries).
*  4. Builds a frozen changed_data_item and records it via set_changed_data.
*
* Note: this function marks data as changed but does NOT trigger a save.
* The user must click the Save button, which calls save_sequence explicitly.
*
* @param {Object} self - The component_json instance
* @param {Object} content - Raw editor content: {json: *} or {text: string}
* @param {number} key - Zero-based index of the entry being edited (always 0
*                       for component_json, which stores at most one entry)
* @returns {boolean} Result from set_changed_data (true when state was updated)
*/
export const handle_json_change = function(self, content, key=0) {

	// parse editor content to JSON value
		const json_value = parse_editor_content(content)

	// deep clone to make immutable: only a {json} value aliases the editor's
	// state; a {text} value is a fresh JSON.parse result
		const immutable_value = content.json !== undefined
			? structuredClone(json_value)
			: json_value

	// resolve id dynamically from self.data
		const id = self.data.entries?.[key]?.id || null

	// build changed_data_item
		const changed_data_item = build_changed_data_item(immutable_value, id)

	// fix instance changed_data
		return self.set_changed_data(changed_data_item)
}//end handle_json_change



/**
* SET_VALUE
* Overwrites component_common method
* Programmatically sets the component value, bypassing the JSONEditor widget.
* Useful for tools and automated workflows that need to inject a value without
* user interaction (e.g. sample-data injection, import flows).
*
* Builds a changed_data_item from the supplied value and the current entry id,
* then records it via set_changed_data. Does NOT auto-save; call save() or
* save_sequence() separately if persistence is required.
*
* @param {*} value - Any JSON-serialisable value to set
* @param {number} key - Zero-based entry index (default 0; component_json only
*                       supports a single entry)
* @returns {Promise<boolean>} Resolves to the result of set_changed_data
*/
component_json.prototype.set_value = async function(value, key=0) {

	const self = this

	// resolve id dynamically from self.data
		const id = self.data.entries?.[key]?.id || null

	// build changed_data_item
		const changed_data_item = build_changed_data_item(value, id)

	// fix instance changed_data
		const changed = self.set_changed_data(changed_data_item)

	return changed
}//end set_value



/**
* SAVE_SEQUENCE
* Validates the current JSONEditor state and persists it to the server if
* both the value is valid JSON and the value has actually changed since the
* last server read.
*
* Validation guard: the JSONEditor.validate() method returns undefined when
* the content is valid and a non-undefined value (array of errors) when it
* is not. Only a valid document is allowed to proceed.
*
* Change guard: the current editor value is compared by JSON-stringified
* equality against data.entries[0] (the last server-known value). If they
* match, the save is skipped to avoid unnecessary network round-trips.
*
* Called by the Save button click handler injected into the editor node by
* view_default_edit_json.get_content_value.
*
* @param {Object} editor - Live JSONEditor instance exposing validate() and get()
* @returns {Promise<Object|boolean>} Resolves to the server save_response when
*          a save was performed, or false when validation fails or no change
*          was detected
*/
component_json.prototype.cancel_pending_changes = function() {
	for (const key in this.change_timers) clearTimeout(this.change_timers[key])
	this.change_timers = {}
}//end cancel_pending_changes



component_json.prototype.save_sequence = async function(editor) {

	const self = this

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// a pending debounced onChange must not re-dirty the value after this save
		self.cancel_pending_changes()

	// check if the editor validate the current value
		const validate = editor.validate()

		if(typeof validate!=='undefined'){
			return false;
		}

	// get the current value and parse it using shared function
		const current_value = editor.get();
		const json_value = parse_editor_content(current_value)

	// check data has really changed. If not, stop save
		const db_value 	= typeof entries[0]!=="undefined" ? entries[0] : null
		const changed 	= JSON.stringify(db_value)!==JSON.stringify(json_value)
		if (!changed) {
			console.log('No changes are detected. Stop save');
			return false
		}

	// changed_data
		const changed_data = [build_changed_data_item(json_value, entries[0]?.id || null)]

	// save_response
		const save_response = await self.change_value({
			changed_data : changed_data,
			refresh		 : false
		})


	return save_response
}//end save_sequence



// @license-end
