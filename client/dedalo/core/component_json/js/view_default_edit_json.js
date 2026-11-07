// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, JSONEditor */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {dd_request_idle_callback, lazy_in_viewport, fade_in_on_reveal} from '../../common/js/events.js'
	import {handle_json_change} from './component_json.js'



/**
* VIEW_DEFAULT_EDIT_JSON
* Default edit-mode view for component_json.
*
* Renders the full interactive edit wrapper for a component_json instance.
* This module is not a class — it is a plain function used as a namespace
* for its static methods (following the Dédalo prototype-module pattern).
*
* Responsibilities:
*   - Build the outer wrapper node (label + content + buttons) via ui.component
*     helpers, delegating layout to `view_default_edit_json.render`.
*   - Lazy-load the svelte-jsoneditor library (JSONEditor / CodeMirror 6)
*     only when the component scrolls into the visible viewport, so the heavy
*     editor bundle does not block the page render.
*   - Pre-load that same bundle on idle time (via dd_request_idle_callback)
*     to reduce perceived latency when the user does scroll to the component.
*   - Inject the editor's CSS once per page (one dummy editor → destroy pattern)
*     because CodeMirror 6 inserts its styles as a side-effect of the first
*     editor instantiation.
*   - Render a read-only `<pre>` fallback for permission level 1 (read-only mode).
*   - Provide action buttons: download-as-JSON, sample-data injection, and
*     optional full-screen toggle.
*
* View entry point: `view_default_edit_json.render(self, options)`
*   Called by render_edit_component_json.prototype.edit for the 'default' and
*   'line' views (and for 'print' after permissions is forced to 1).
*
* Data contract — `self.data.entries`:
*   An Array of entry objects: `[{ id: number|null, lang: string, value: Object|null }]`.
*   Only index 0 is used. If more than one entry is present, a console.warn is emitted
*   and subsequent entries are ignored (multi-value JSON is not supported).
*
* Module-level state:
*   `editor_module_cache`   — cached JSONEditor module after first load.
*   `editor_module_loading` — guard flag to prevent concurrent dynamic imports.
*   `css_injected`          — guard flag to prevent duplicate CSS injection.
*
* Exports: `view_default_edit_json` (the constructor/namespace function).
*/
export const view_default_edit_json = function() {

	return true
}//end view_default_edit_json



/**
* RENDER
* Build and return the full edit-mode DOM wrapper for a component_json instance.
*
* Delegates content construction to `get_content_data` and button construction
* to `get_buttons`. Wraps both with `ui.component.build_wrapper_edit`, which
* adds the outer component node, the label row (suppressed when `self.view='line'`),
* and the standard component CSS classes.
*
* When `options.render_level === 'content'`, only the content_data node is returned
* (no outer wrapper or buttons), which is the pattern used by partial refreshes.
*
* Side effects:
*   - Sets `wrapper.content_data` pointer so callers can traverse into the content
*     subtree without re-querying the DOM.
*
* @param {Object} self - component_json instance (`this` inside the edit method)
* @param {Object} options - Render options passed through from the section/portal renderer
*   @param {string} [options.render_level='full'] - 'full' builds the whole wrapper;
*     'content' returns only the content_data node
* @returns {Promise<HTMLElement>} The wrapper element (or content_data for 'content' level)
*/
view_default_edit_json.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			content_data	: content_data,
			buttons			: buttons
		}
		if (self.view==='line') {
			wrapper_options.label = null // prevent to create label
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the content_data container and populate it with the appropriate
* content_value node for the single JSON entry at index 0.
*
* Reads `self.data.entries` (the server-side data array). Only one value
* is supported; if the array has more than one element a warning is logged
* and the loop breaks after the first iteration.
*
* Delegates rendering to:
*   - `get_content_value`      when `self.permissions > 1` (editable)
*   - `get_content_value_read` when `self.permissions === 1` (read-only)
*
* Side effects:
*   - Appends the content_value node to `content_data`.
*   - Sets `content_data[0]` as a numeric index pointer to the node, for
*     downstream code that uses index-based traversal.
*
* @param {Object} self - component_json instance
* @returns {HTMLElement} content_data node containing the value widget
*/
const get_content_data = function(self) {

	const value = self.data.entries || {}

	// content_data
		const content_data = ui.component.build_content_data(self)

	// values (inputs)
		const inputs_value	= value || []
		const value_length	= inputs_value.length || 1
		if (value_length>1) {
			console.warn('More than one value in component_json is not allowed at now. Ignored next values. N values: ', value_length);
		}
		for (let i = 0; i < value_length; i++) {
			// Gets value from inputs_value (note that inputs_value is an array of objects with the property 'value')
			const current_value = inputs_value[i]?.value || null
			const content_value_node = (self.permissions===1)
				? get_content_value_read(i, current_value, self)
				: get_content_value(i, current_value, self)
			content_data.appendChild(content_value_node)
			// set pointers
			content_data[i] = content_value_node
			break; // only one is used for the time being
		}


	return content_data
}//end get_content_data



// editor onChange → changed_data debounce (ms)
const CHANGE_DEBOUNCE_MS = 250

// Module-level cache for JSONEditor to avoid repeated dynamic import overhead
let editor_module_cache = null;
let editor_module_loading = false;
let css_injected = false;


/**
* PRELOAD_EDITOR_MODULE
* Speculatively load the JSONEditor bundle during browser idle time, before
* the component scrolls into the viewport.
*
* By starting the dynamic import early (triggered from `get_content_value` via
* `dd_request_idle_callback`), the module is typically ready in
* `editor_module_cache` by the time the IntersectionObserver fires for the
* component, eliminating the visible delay of a cold import.
*
* Guards:
*   - `editor_module_cache` — skip if a previous instance already loaded the module.
*   - `editor_module_loading` — skip if a concurrent preload is already in flight.
*
* On failure the flag is reset silently; the actual load inside `get_content_value`
* will retry and surface the error to the UI if it also fails.
*
* @returns {void}
*/
const preload_editor_module = () => {

	if (editor_module_cache || editor_module_loading) return;

	editor_module_loading = true;
	import('../../../lib/jsoneditor/standalone.js')
		.then(module => {
			if (module && typeof module.createJSONEditor === 'function') {
				editor_module_cache = module;
			}
			editor_module_loading = false;
		})
		.catch(() => {
			editor_module_loading = false;
		});
};//end preload_editor_module


/**
* INJECT_EDITOR_CSS
* Trigger the one-time CSS injection that CodeMirror 6 (inside svelte-jsoneditor)
* performs as a side-effect of the first editor creation.
*
* Because the editor's CSS is added to the document via CSSStyleSheet insertions
* that occur in `createJSONEditor`, the first real editor instance would flash
* unstyled for a frame. This function creates a throwaway editor, immediately
* destroys it, and sets the `css_injected` guard flag so no subsequent instance
* repeats the work.
*
* (!) The dummy editor is created on a detached `<div>` and destroyed
* synchronously — it is never appended to the document.
*
* @param {Object} module - The resolved JSONEditor ES module (must expose `createJSONEditor`)
* @returns {void}
*/
const inject_editor_css = (module) => {

	if (css_injected) return;

	const dummy_node = document.createElement('div');
	try {
		const dummy_editor = module.createJSONEditor({ target: dummy_node, props: { mode: 'text', content: { text: '' } } });
		dummy_editor.destroy();
	} catch (e) {}

	css_injected = true;
};//end inject_editor_css


/**
* GET_CONTENT_VALUE
* Build the interactive edit widget for a single JSON entry.
*
* Returns a `<div class="content_value">` immediately and defers the actual
* editor initialisation to `load_editor`, which is called by `when_in_viewport`
* once the node enters the browser's visible area. This avoids instantiating
* expensive CodeMirror 6 instances for off-screen components.
*
* Initialization flow:
*   1. `dd_request_idle_callback(preload_editor_module)` — start loading the
*      JSONEditor bundle in idle time before the node is visible.
*   2. `when_in_viewport(content_value, load_editor)` — when the node becomes
*      visible, `load_editor` runs.
*   3. Inside `load_editor`:
*      a. Uses `editor_module_cache` if available, otherwise awaits a fresh
*         dynamic import.
*      b. Calls `inject_editor_css` once per page.
*      c. Awaits `document.fonts.ready` and one `requestAnimationFrame` so the
*         CSS layout is fully settled before the editor measures its container.
*      d. Aborts if `content_value` has been removed from the DOM while waiting
*         (e.g. the user navigated away or the modal closed).
*      e. Destroys any previous editor instance on `self.editors[key]` to prevent
*         zombie instances when the component re-renders while the page view jumps.
*      f. Creates the editor via `module.createJSONEditor` with `mode: 'text'`
*         and wires the `onChange` callback to `handle_json_change`, but only
*         when the editor reports no `contentErrors` (i.e. the JSON is valid).
*      g. Appends a "Save" button that calls `self.save_sequence(editor)` on click.
*
* Double-init guards (dataset flags):
*   `content_value.dataset.editor_loading` — set to 'true' at start of `load_editor`;
*     reset on both success and failure.
*   `content_value.dataset.editor_loaded`  — set to 'true' after the editor is
*     successfully created; prevents re-entry on a second viewport trigger.
*
* Side effects:
*   - Sets `self.editors[key]` to the live JSONEditor instance after creation.
*   - Adds a `button_save` item to the editor menu (onRenderMenu).
*   - On error: replaces `content_value.textContent` with the error message
*     and applies inline danger-color styling.
*
* @param {number} key - Index of the entry being rendered (always 0 for now)
* @param {*} current_value - Parsed JSON value from `self.data.entries[key].value`,
*   or null when no value has been stored yet
* @param {Object} self - component_json instance
* @returns {HTMLElement} The `content_value` div (editor is populated asynchronously)
*/
const get_content_value = (key, current_value, self) => {

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})
		// start invisible for a smooth fade-in once the editor is ready (shared contract)
		const reveal = fade_in_on_reveal(content_value)

	// load_editor and init
		const load_editor = async () => {
			// Prevent double initialization
			if (content_value.dataset.editor_loading === 'true' || content_value.dataset.editor_loaded === 'true') {
				return;
			}
			content_value.dataset.editor_loading = 'true';

			try {
				// Use cached module or load on demand
				const module = editor_module_cache || await import('../../../lib/jsoneditor/standalone.js');
				if (!module || typeof module.createJSONEditor !== 'function') {
					throw new Error('createJSONEditor not found in module');
				}
				// Cache for subsequent instances
				if (!editor_module_cache) {
					editor_module_cache = module;
				}

				// One-time CSS injection (skipped if already done by a previous instance)
				inject_editor_css(module);

				// Wait for fonts and one paint frame to ensure CSS OM is settled
				if (document.fonts && typeof document.fonts.ready !== 'undefined') {
					await document.fonts.ready;
				}
				await new Promise(resolve => requestAnimationFrame(resolve));

				// Abort if the modal was closed while we were waiting
				if (!content_value.isConnected) return;

				// value for editor
				const content = current_value !== null
					? {json : current_value}
					: {text : ''};

				// Destroy previous instance to avoid conflicts on jump
				if (self.editors[key] && typeof self.editors[key].destroy === 'function') {
					try { self.editors[key].destroy(); } catch (e) {}
					self.editors[key] = null;
				}

				// Create editor with error handling
				let editor;
				try {
					editor = module.createJSONEditor({
						target	: content_value,
						props	: {
							content		: content,
							mode		: 'text',
							// Save lives IN the editor's menu (pushed right by a space item), not
							// floated over it: an absolute button covered undo/redo on narrow widths
							onRenderMenu : (items) => [
								...items,
								{ type : 'space' },
								{
									type		: 'button',
									text		: get_label.save || 'Save',
									title		: get_label.save || 'Save',
									className	: 'warning save button_save',
									onClick		: (e) => {
										e?.stopPropagation?.()
										self.save_sequence(editor)
									}
								}
							],
							onChange	: (updatedContent, previousContent, { contentErrors, patchResult }) => {
								// debounced: parsing + cloning a large value on every keystroke lags typing
								clearTimeout(self.change_timers[key])
								// typed while active and deactivated (click-out) before the debounce
								// fired: deactivate found no change to save, so save it here, as it would have
								const was_active = self.active===true
								const apply_change = (content) => {
									const changed = handle_json_change(self, content, key)
									if (changed && was_active && self.active!==true && self.save_on_deactivate===true) {
										self.change_value({
											changed_data	: self.data.changed_data,
											refresh			: false
										})
									}
								}
								// an emptied editor is a parse error, but it means "no value" (null)
								if (updatedContent.text !== undefined && updatedContent.text.trim() === '') {
									self.change_timers[key] = setTimeout(() => apply_change({ json : null }), CHANGE_DEBOUNCE_MS)
								}
								else if (typeof contentErrors === 'undefined') {
									self.change_timers[key] = setTimeout(() => apply_change(updatedContent), CHANGE_DEBOUNCE_MS)
								}
							}
						}
					});
				} catch (create_err) {
					throw new Error(`Failed to create JSONEditor: ${create_err.message}`);
				}

				// Validate editor was created
				if (!editor) {
					throw new Error('JSONEditor returned null/undefined');
				}

				// Mark as loaded
				content_value.dataset.editor_loaded = 'true';
				content_value.dataset.editor_loading = 'false';

				// set pointer
				self.editors[key] = editor;

				// Save tooltip, same codex-tooltip as the pill tool buttons. Bound on
				// first hover: the editor re-renders its menu (mode switch) and the
				// button is a fresh node each time (activate_tooltips skips bound ones)
				content_value.addEventListener('mouseover', (e) => {
					const button_save = e.target.closest?.('.button_save')
					if (button_save) {
						ui.activate_tooltips(button_save, null)
					}
				})

				// smooth appearance: fade the editor in now that it is mounted
				reveal();

			} catch (error) {
				content_value.dataset.editor_loading = 'false';
				console.error('component_json: load_editor failed:', error);
				// Show error in UI
				content_value.textContent = `Error loading JSON editor: ${error.message}`;
				content_value.style.padding = '1rem';
				content_value.style.color = 'var(--color_danger)';
				// error also reveals so the message is visible
				reveal();
			}
		}//end load_editor

	// Preload editor module on idle (before viewport entry) to reduce perceived latency
		dd_request_idle_callback(preload_editor_module);

	// observe in viewport (shared lazy helper, 200px preload)
		lazy_in_viewport(content_value, load_editor);


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build the read-only view for a single JSON entry.
*
* Used when `self.permissions === 1` (read-only), and also for the 'print'
* view (render_edit_component_json forces `self.permissions = 1` before calling
* the 'default' path). No editor is created; the value is pretty-printed inside
* a `<pre>` element using `JSON.stringify` with 2-space indentation.
*
* @param {number} key - Index of the entry being rendered (always 0 for now;
*   parameter kept for signature parity with `get_content_value`)
* @param {*} current_value - Parsed JSON value from `self.data.entries[key].value`,
*   or null when no value is stored
* @param {Object} self - component_json instance
* @returns {HTMLElement} A `<div class="content_value read_only">` containing a `<pre>` with the formatted JSON
*/
const get_content_value_read = (key, current_value, self) => {

	const parsed_value = current_value
		? JSON.stringify(current_value, null, 2)
		: ''

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only'
		})

	// value
		ui.create_dom_element({
			element_type	: 'pre',
			class_name		: 'value',
			text_content		: parsed_value,
			parent			: content_value
		})


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Build the buttons container for a component_json edit widget.
*
* Conditionally adds the following controls based on `self.show_interface`
* and component context:
*
*   tools button(s)     — if `show_interface.tools === true`, delegates to
*                         `ui.add_tools(self, fragment)` which appends tool
*                         trigger buttons from `self.tools[]`.
*   download button     — always present (permissions > 1 is enforced by the caller).
*                         Calls `download_object_as_json` with `self.data.entries[0]`
*                         and `self.id` as the filename stem.
*   sample data button  — only if `self.context.properties.sample_data` is defined.
*                         Loads the sample JSON directly into the live editor at
*                         index 0 via `self.editors[0].set(sample_data)`.
*                         Prompts for confirmation if the entry already has a value.
*   full-screen button  — if `show_interface.button_fullscreen === true`.
*                         Calls `ui.enter_fullscreen(self.node)`.
*
* Layout: buttons are appended to a `buttons_fold` div inside `buttons_container`
* to support sticky positioning on large components (where the editor may be taller
* than the viewport).
*
* (!) The sample data button uses `console.log('self:', self)` — this is a
* development-time debug trace left in production code (see flags).
*
* @param {Object} self - component_json instance
* @returns {HTMLElement} The `buttons_container` node ready to be appended to the wrapper
*/
const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// button_download. Force automatic download of component data value
		const button_download = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button download',
			title			: get_label.download || 'Download data',
			parent			: fragment
		})
		button_download.addEventListener('click', function(e) {
			e.stopPropagation()
			const export_obj  = self.data.entries[0]
			const export_name = self.id
			download_object_as_json(export_obj, export_name)
		})

	// button sample data
		if (self.context?.properties?.sample_data) {
			const button_sample_data = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button code',
				title			: get_label.add_sample_data || 'Add sample data',
				parent			: fragment
			})
			button_sample_data.addEventListener('click', function(e) {
				e.stopPropagation()
				// const export_obj  = self.data.value[0]
				if (self.data.entries && self.data.entries[0] && self.data.entries[0].length) {
					if(!confirm("Current value is not empty. \nOverwrite actual value?")) {
						return
					}
				}
				const key = 0
				const sample_data = self.context.properties.sample_data
				self.editors[key].set(sample_data);
				console.log('self:', self);
			})
		}

	// button_fullscreen
		if(show_interface.button_fullscreen === true){

			const button_fullscreen = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button full_screen',
				title			: get_label.full_screen || 'Full screen',
				parent			: fragment
			})
			// click event
			const click_handler = (e) => {
				e.stopPropagation()
				ui.enter_fullscreen(self.node)
			}
			button_fullscreen.addEventListener('click', click_handler)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



/**
* DOWNLOAD_OBJECT_AS_JSON
* Programmatically trigger a browser file download of the given object
* serialised as pretty-printed JSON (2-space indentation).
*
* Technique: creates a Blob object URL, attaches it to a temporary
* `<a>` element, appends the element to `document.body` (required for
* Firefox compatibility), fires `.click()`, then immediately removes the node.
*
* (!) This mutates `document.body` transiently. The element is removed
* synchronously after the click event dispatches; no cleanup race is expected
* in practice, but the approach relies on the click dispatching synchronously.
*
* @param {Object} export_obj - The data to serialise and download
*   (typically `self.data.entries[0]` — the raw entry object, not just its `.value`)
* @param {string} export_name - Base name for the downloaded file (without extension);
*   the `.json` extension is appended automatically
* @returns {void}
*/
const download_object_as_json = function(export_obj, export_name) {

    // Blob URL: no percent-encoded copy of the whole value in memory, no URL-length limit
    const blob_url = URL.createObjectURL(new Blob([JSON.stringify(export_obj,undefined,2)], {type: 'application/json'}));

    const download_anchor_node = document.createElement('a');
    	  download_anchor_node.setAttribute("href",     blob_url);
    	  download_anchor_node.setAttribute("download", export_name + ".json");

    document.body.appendChild(download_anchor_node); // required for firefox

    download_anchor_node.click();
    download_anchor_node.remove();
    // revoke after the click has handed the URL to the download
    setTimeout(() => URL.revokeObjectURL(blob_url), 0);
}//end download_object_as_json



// @license-end
