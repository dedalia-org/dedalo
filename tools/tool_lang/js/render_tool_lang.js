// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEBUG, DEDALO_CORE_URL, get_label */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_LANG
* Client-side view layer for the tool_lang translation tool.
*
* Responsibilities
* ----------------
* 1. Build the two-panel edit layout: left panel shows the source-language
*    component (read-only); right panel shows the target-language component
*    (editable, or read-only when source and target languages coincide to avoid
*    simultaneous CKEditor instantiation conflicts).
* 2. Render language selectors (dropdowns) above each panel, wired to
*    change_component_lang() so the user can switch language context live.
* 3. Render the action buttons row: "Copy to target" and, when an engine is
*    configured, the "Automatic translation" widget (engine selector, device
*    checkbox, configuration gear panel).
* 4. Render the status bar (user and admin status components) as in-toolbar
*    mini views.
* 5. Attach the streaming overlay to the right panel so browser-side
*    translation can show incremental output while the worker is running.
*
* Key instance properties consumed/written here
* ----------------------------------------------
* self.main_element       {Object}  — source component instance (id_variant='tool_lang')
* self.target_component   {Object}  — target component instance (id_variant='target_component')
* self.source_lang        {string}  — current source language code (e.g. 'lg-eng')
* self.target_lang        {string}  — current target language code (e.g. 'lg-spa')
* self.langs              {Array}   — list of available language objects {label, value, tld2}
* self.context.config     {Object}  — tool config; holds translator_engine definitions
* self.target_translator  {string}  — last-used engine name (persisted via local DB)
* self.translator_engine_select  {HTMLElement}  — engine <select> kept on self for
*                                    read access by automatic_translation_browser()
* self.translator_device_checkbox {HTMLElement} — WASM/WebGPU toggle checkbox kept on self
* self.streaming_overlay          {HTMLElement} — overlay div shown during browser translation
* self.streaming_overlay_content  {HTMLElement} — inner div for streaming text accumulation
*
* Exports
* -------
* render_tool_lang      — constructor; mixed into tool_lang.prototype.edit
* change_component_lang — swaps the language context of a source or target component
*
* Related files
* -------------
* tool_lang.js           — constructor, init, build, automatic_translation_browser/server
* browser_translation.js — Web Worker + transformers.js client-side engine
* class.tool_lang.php    — PHP server-side tool controller
*/

// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {when_in_viewport} from '../../../core/common/js/events.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {clone, get_json_langs} from '../../../core/common/js/utils/index.js'
	import Split from '../../../lib/split/dist/split.es.js'



/**
* SPLIT_SIZES_ID
* Local-db (IndexedDB, 'status' table) key holding the last gutter position as
* the [left, right] percentage pair Split.js reports. Persisted because a
* translator picks a comfortable split ONCE and then reopens the tool per record;
* re-dragging it every time is the whole friction this replaces.
*/
const SPLIT_SIZES_ID = 'tool_lang_split_sizes'

/** Below this viewport width the panes stack and the split is skipped. */
const SPLIT_MIN_VIEWPORT = 800

/** Fallback split when nothing is persisted yet: even halves. */
const SPLIT_DEFAULT_SIZES = [50, 50]



/**
* RENDER_TOOL_LANG
* Prototype namespace for the tool_lang view layer.
* Constructed empty; the edit method is assigned below and mixed into
* tool_lang.prototype.edit in tool_lang.js.
*/
export const render_tool_lang = function() {

	return true
}//end render_tool_lang



/**
* EDIT
* Build and return the full edit DOM for the translation tool.
*
* When render_level is 'content', returns only the inner content_data fragment
* (used for partial refreshes). Otherwise returns the full wrapper including
* the tool button bar with status components.
*
* Delegates the heavy layout work to get_content_data_edit() and
* render_status(). The wrapper is produced by ui.tool.build_wrapper_edit(),
* which owns the outer chrome (title bar, button toolbar).
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' for complete wrapper;
*   'content' to return only the content_data node (skip wrapper/status bar)
* @returns {Promise<HTMLElement>} wrapper element (full) or content_data element (content)
*/
render_tool_lang.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. UI build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data

	// status, render the status components for users and admins to control the process of the tool
		const status_container = await render_status(self)
		wrapper.tool_buttons_container.appendChild(status_container)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build the inner content node for the translation UI.
*
* Layout produced:
*   content_data
*     └─ fragment
*          ├─ components_container
*          │    ├─ left_block  (source panel: lang selector + read-only component)
*          │    ├─ [Split.js gutter — injected by activate_split, drag to resize]
*          │    └─ right_block (target panel: lang selector + editable component
*          │                    + streaming overlay for browser translation)
*          └─ buttons_container
*               ├─ automatic_translation_container (only when translator_engine configured)
*               └─ copy_to_target button
*
* Side effects:
* - Sets self.streaming_overlay and self.streaming_overlay_content on the tool
*   instance so that automatic_translation_browser() can display incremental output.
* - Marks self.main_element as read-only (show_interface.read_only = true) to
*   prevent accidental edits to the source while translating.
* - Marks self.target_component as read-only when its language equals source_lang,
*   preventing dual CKEditor instantiation on the same underlying component.
*
* Early return: when self.main_element is missing (e.g. the tool was opened
* without a calling component), returns a content_data node with an error message
* instead of building the full layout.
*
* @param {Object} self - tool_lang instance
* @returns {Promise<HTMLElement>} content_data node containing the full edit UI
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// main_element unavailable case
		if (!self.main_element) {
			const content_data = ui.tool.build_content_data(self)
			content_data.innerHTML = 'Error loosed caller. main_element is not available. Please, try to reopen this tool again.'

			return content_data
		}

	// components container
	// hosts both left (source) and right (target) panels side by side
		const components_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_container',
			parent			: fragment
		})

	// left_block
	// source panel: the component being translated from, always read-only here
		const left_block = ui.create_dom_element({
			element_type	: 'div',
			id				: 'tool_lang_left_block',
			class_name		: 'left_block',
			parent			: components_container
		})

		// top_left
		// header row for the source panel: language select + label
			const top_left = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'top left',
				parent			: left_block
			})

			// source lang select
			// changing this select calls change_component_lang(), which re-renders
			// the source component in the newly selected language (read-only)
				const source_select_lang = ui.build_select_lang({
					langs		: self.langs,
					selected	: self.source_lang,
					class_name	: 'source_lang'
				})
				source_select_lang.addEventListener("change", function(e){
					const lang = e.target.value
					change_component_lang({
						self		: self,
						component	: self.main_element,
						lang		: lang
					})
				})
				top_left.appendChild(source_select_lang)

			// source_lang_label
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'lang_label source_lang_label',
					inner_html		: self.get_tool_label('source_lang') || 'Source lang',
					parent			: top_left
				})

		// source component
		// force read-only so the translator cannot accidentally modify the source text;
		// rendered asynchronously and appended via .then() so it does not block the rest
		// of the layout being built
			const source_component_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'source_component_container',
				parent			: left_block
			})
			// show_interface
			self.main_element.show_interface.read_only = true
			self.main_element.show_interface.tools = false
			self.main_element.render()
			.then(function(node){
				source_component_container.appendChild(node)
			})

	// right_block
	// target panel: the same component in a different language, editable unless
	// the user has chosen the same language as the source (see guard below)
		const right_block = ui.create_dom_element({
			element_type	: 'div',
			id				: 'tool_lang_right_block',
			class_name		: 'right_block',
			parent			: components_container
		})

		// top_right
		// header row for the target panel: language select + label
			const top_right = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'top right',
				parent			: right_block
			})

			// target lang select
			// persists the chosen target language to IndexedDB ('tool_lang_target_lang'
			// in the 'status' table) so the same language is pre-selected on next open
				const target_select_lang = ui.build_select_lang({
					langs		: self.langs,
					selected	: self.target_lang,
					class_name	: 'target_lang'
				})
				target_select_lang.addEventListener("change", async function(e){
					const lang = e.target.value
					change_component_lang({
						self		: self,
						component	: self.target_component,
						lang		: lang
					})

					const data = {
						id		: 'tool_lang_target_lang',
						value	: lang
					}
					data_manager.set_local_db_data(
						data,
						'status'
					)
				})
				top_right.appendChild(target_select_lang)

			// target_lang_label
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'lang_label target_lang_label',
					inner_html		: self.get_tool_label('target_lang') || 'Target lang',
					parent			: top_right
				})

		// target component
		// (!) if the target component has the same lang as the source component, block edition
		// to avoid errors: CKEditor cannot manage 2 instances of the same component in edit mode.
		// The read_only flag is compared against the component's current lang, not self.target_lang,
		// because change_component_lang() updates component.lang before re-render.
			if (self.target_component) {
				// show_interface
				self.target_component.show_interface.read_only = (self.target_component.lang===self.source_lang)
				// only the time machine (honoured by component_text_area; other models render no tools)
				self.target_component.show_interface.tools = ['tool_time_machine']
				const target_component_node = await self.target_component.render()
				const target_component_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'target_component_container',
					parent			: right_block
				})
				target_component_container.appendChild(target_component_node)

				// streaming overlay
				// invisible by default ('hide' class); browser_translation.js removes 'hide'
				// when a translation worker starts and adds it back when the stream ends.
				// self.streaming_overlay and self.streaming_overlay_content are pointers kept
				// on the instance so that automatic_translation_browser() in tool_lang.js can
				// update them after this function returns.
				self.streaming_overlay = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'streaming_overlay hide',
					parent			: target_component_container
				})
				self.streaming_overlay_content = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'streaming_overlay_content',
					parent			: self.streaming_overlay
				})
			}

	// buttons container
	// sits below the two panels; holds translation action buttons
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

		// automatic_translation
		// only rendered when the tool config declares at least one translator_engine entry;
		// the value is an array of engine descriptors {name, label, type ('browser'|'server')}
			const translator_engine = (self.context.config)
				? self.context.config.translator_engine.value
				: false

			if (translator_engine) {
				const automatic_tranlation_node = build_automatic_translation(self, translator_engine, source_select_lang, target_select_lang, components_container)
				buttons_container.appendChild(automatic_tranlation_node)
			}//end if (translator_engine)

		// copy_to_target button
		// manual shortcut: copies the entire source value array to the target component
		// and saves each item individually (one save call per array entry), then refreshes
		// the target component UI. Requires user confirmation when the target already has data.
			const copy_to_target = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'secondary copy_to_target',
				inner_html		: self.get_tool_label('copy_to_target') || 'Copy to target',
				parent			: buttons_container
			})
			copy_to_target.addEventListener('click', async function(e){
				e.stopPropagation()

				// user confirmation to overwrite content
				// guards against accidentally discarding existing target text
					if (self.target_component.data.value && self.target_component.data.value.length>0) {
						if (!confirm( get_label.sure || 'Sure?' )) {
							return false
						}
					}

				// source value
					const source_component	= self.main_element
					const source_value		= source_component.data.value

				// debug
					if(SHOW_DEBUG===true) {
						console.log("--> copy_to_target source_value:", clone(source_value));
						console.log("--> copy_to_target target_value:", clone(self.target_component.data.value));
					}

				// guard: source_value must be an array
				// component data.value is always an array of item objects; if it is
				// something else the component state is invalid and we bail early
					if (!Array.isArray(source_value)) {
						console.error('copy_to_target: source_value is not an array', source_value);
						return;
					}

				// copy value
				// mutate the target component's in-memory data before saving so the UI
				// stays consistent with what was actually persisted
					self.target_component.data.value = source_value

				// save value. (Expected only one value in the array)
				// iterates to match the generic save() API, though in practice text
				// components carry exactly one value item
					for (let i = 0; i < source_value.length; i++) {
						self.target_component.save([{
							action	: 'update',
							id		: source_value[i]?.id || null,
							value	: source_value[i]
						}])
					}

				// refresh the target component
				// build_autoload:false skips re-fetching server data so the just-written
				// value is displayed immediately without a round-trip
					self.target_component.refresh({
						build_autoload : false
					})
			})

		// propagate_marks
		// (!) WORKING HERE. Note that this functionality it's not finished in v5
			// const propagate_marks_block = render_propagate_marks_block(self)
			// buttons_container.appendChild(propagate_marks_block)

	// split. Drag handle between the source and target panes.
		activate_split(left_block)

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* ACTIVATE_SPLIT
* Turn the source/target pane pair into a Split.js drag-resizable pair.
*
* Deferred through when_in_viewport for the same reason tool_indexation defers
* it: Split.js reads the panes' COMPUTED widths when it initialises, and while
* the fragment is still detached (or the tool window is not painted yet) those
* are zero, which pins the gutter to one edge.
*
* Skipped under SPLIT_MIN_VIEWPORT px, where the panes stack vertically and a
* horizontal gutter would be meaningless (the CSS forces width:100% there).
*
* The chosen position is written back to IndexedDB on drag end and restored on
* the next open. A stored value that is not a sane two-number pair (an older
* shape, a hand-edited row) is IGNORED rather than fed to Split.js, which would
* throw and leave the tool with no split at all.
*
* @param {HTMLElement} left_block - the source pane; the node observed for
*   viewport entry. Both panes are addressed by id, as Split.js expects.
* @returns {void}
*/
const activate_split = function(left_block) {

	when_in_viewport(
		left_block, // node to observe
		async () => { // callback

			// don't split on small windows
				if (window.innerWidth < SPLIT_MIN_VIEWPORT) {
					return
				}

			// stored sizes
				let sizes = SPLIT_DEFAULT_SIZES
				try {
					const stored = await data_manager.get_local_db_data(
						SPLIT_SIZES_ID,
						'status'
					)
					const stored_value = stored?.value
					if (Array.isArray(stored_value)
						&& stored_value.length===2
						&& stored_value.every(el => typeof el==='number' && isFinite(el))
					) {
						sizes = stored_value
					}
				} catch (error) {
					console.error('tool_lang activate_split: could not read stored sizes', error)
				}

			// split
			// @see https://github.com/nathancahill/split/tree/master/packages/splitjs
				Split(['#tool_lang_left_block', '#tool_lang_right_block'], {
					sizes		: sizes,
					minSize		: 200,
					gutterSize	: 8,
					onDragEnd	: (new_sizes) => {
						data_manager.set_local_db_data(
							{
								id		: SPLIT_SIZES_ID,
								value	: new_sizes
							},
							'status'
						)
					}
				})
		}
	)
}//end activate_split



/**
* RENDER_PROPAGATE_MARKS_BLOCK
* Build the "Propagate marks" control block: two radio buttons (New only / Recreate all)
* and a "Propagate marks" action button.
*
* (!) WORKING HERE. This functionality is not finished. The click handler contains
* the source value extraction logic but does not yet implement the actual propagation
* operation. The function is currently commented out at its call site in
* get_content_data_edit() and is not reachable from the live UI.
*
* @param {Object} self - tool_lang instance
* @returns {HTMLElement} propagate_marks_container div with the radio controls and button
*/
const render_propagate_marks_block = function(self) {

	const propagate_marks_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'propagate_marks_container'
	})

	// new
		// new_only_label
		const new_only_label = ui.create_dom_element({
			element_type	: 'label',
			inner_html		: self.get_tool_label('new_only') || 'New only',
			parent			: propagate_marks_container
		})
		// input radio button
		const new_only_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'radio',
			name			: 'propagate_marks',
			value			: 'new_only'
		})
		new_only_input.checked = true // default value is New only
		new_only_label.prepend(new_only_input)

	// recreate all
		// all_label
		const all_label = ui.create_dom_element({
			element_type	: 'label',
			inner_html		: self.get_tool_label('all') || 'Recreate all',
			parent			: propagate_marks_container
		})
		// input radio button
		const all_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'radio',
			name			: 'propagate_marks',
			value			: 'all'
		})
		all_label.prepend(all_input)

	// propagate_marks button
		const propagate_marks = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light propagate_marks',
			inner_html		: self.get_tool_label('propagate_marks') || 'Propagate marks',
			parent			: propagate_marks_container
		})
		propagate_marks.addEventListener('click', async function(e){
			e.stopPropagation()

			// user confirmation to overwrite content
				if (self.target_component.data.value && self.target_component.data.value.length>0) {
					if (!confirm( get_label.sure || 'Sure?' )) {
						return false
					}
				}

			// source value
				const source_component	= self.main_element
				const source_value		= source_component.data.value

			// (!) WORKING HERE. Note that this functionality it's not finished in v5
		})

	return propagate_marks_container
}//end render_propagate_marks_block



/**
* BUILD_AUTOMATIC_TRANSLATION
* Build the automatic-translation widget DOM subtree and return its container.
*
* The widget contains:
* - A status_container div (hidden by default) for loading/success/error messages.
* - A "Automatic translation" button that reads the selected engine and dispatches
*   to either automatic_translation_browser() (client-side, WebGPU/WASM) or
*   automatic_translation_server() (server-side API call) depending on engine.type.
* - An engine <select> that lists all configured translator engines. Changing the
*   selection persists the choice to IndexedDB ('translator_engine_select' / 'status')
*   and toggles the configuration panel visibility (shown only for browser engines).
* - A gear icon that toggles the configuration_container open/close.
* - A configuration_container with a "More compatible, slower" CPU/WASM checkbox.
*   Its state is persisted to IndexedDB ('translator_device_checkbox' / 'status')
*   and restored on build. Choosing WASM forces wasm device instead of webgpu.
*
* Side effects:
* - Writes self.translator_engine_select (the <select> element) on the tool instance
*   so that the click handler can read the currently selected engine name at invocation time.
* - Writes self.translator_device_checkbox similarly for device selection.
* - Adds/removes the 'loading' CSS class on components_container during translation.
*
* @param {Object} self - tool_lang instance
* @param {Array} translator_engine - array of engine descriptors from tool config,
*   each with {name: string, label: string, type: 'browser'|'server'}
* @param {HTMLElement} source_select_lang - the source language <select> element
* @param {HTMLElement} target_select_lang - the target language <select> element
* @param {HTMLElement} components_container - the two-panel wrapper div; receives
*   the 'loading' CSS class while a translation is in progress
* @returns {HTMLElement} automatic_translation_container div with the full widget
*/
const build_automatic_translation = (self, translator_engine, source_select_lang, target_select_lang, components_container) => {

	// container
		const automatic_translation_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'automatic_translation_container'
		})

	// status container
		const status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_container hide',
			parent			: automatic_translation_container
		})

	// button
		const button_automatic_translation = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning button_automatic_translation',
			inner_html		: self.get_tool_label('automatic_translation') || "Automatic translation",
			parent			: automatic_translation_container
		})

		const click_handler = (e) => {
			e.stopPropagation()

			// mark the two-panel container as busy; CSS dims/disables interaction
			components_container.classList.add('loading')

			// read live values from the selects rather than from self.* to capture any
			// mid-session changes the user made before clicking the button
			const translator_name	= self.translator_engine_select.value
			const source_lang		= source_select_lang.value
			const target_lang		= target_select_lang.value

			const engine = translator_engine.find(el => el.name===translator_name)
			if (engine && engine.type==='browser') {

				// browser engine: run entirely client-side via Web Worker.
				// device falls back to 'webgpu' (GPU-accelerated) unless the user
				// has checked the compatibility checkbox which selects 'wasm' (CPU)
				const device = self.translator_device_checkbox && self.translator_device_checkbox.checked
					? 'wasm'
					: 'webgpu'

				self.automatic_translation_browser({
					source_lang		: source_lang,
					target_lang		: target_lang,
					device			: device,
					status_container: status_container
				})
				.then(()=>{
					components_container.classList.remove('loading')
					const msg = self.get_tool_label('translation_completed') || 'Translation completed.'
					status_container.classList.remove('loading_status')
					// build the node, set the message as TEXT (never an HTML sink, DS-1)
					status_container.replaceChildren()
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'success_text',
						text_content	: msg,
						parent			: status_container
					})
				})
				.catch((error)=>{
					components_container.classList.remove('loading')
					console.error('automatic_translation_browser error:', error)
				})
			}else{
				// server engine: dispatch to the PHP API (e.g. babel, Google Translate);
				// the status message is injected into automatic_translation_container by
				// automatic_translation_server() → ui.show_message()
				self.automatic_translation_server(translator_name, source_lang, target_lang, automatic_translation_container)
				.then(()=>{
					components_container.classList.remove('loading')
				})
				.catch((error)=>{
					components_container.classList.remove('loading')
					console.error('automatic_translation_server error:', error)
				})
			}
		}
		button_automatic_translation.addEventListener('click', click_handler)

	// select
		self.translator_engine_select = ui.create_dom_element({
			element_type	: 'select',
			parent 			: automatic_translation_container
		})
		for (let i = 0; i < translator_engine.length; i++) {

			const engine = translator_engine[i]

			const option = ui.create_dom_element({
				element_type	: 'option',
				value			: engine.name,
				inner_html		: engine.label,
				parent			: self.translator_engine_select
			})
			if (self.target_translator===engine.name) {
				option.selected = true
			}
		}
		const change_handler = (e) => {
			// persist the last-selected engine so it is pre-selected on the next tool open
			data_manager.set_local_db_data({
				id		: 'translator_engine_select',
				value	: self.translator_engine_select.value
			}, 'status')

			// show/hide configuration based on engine type
			// the configuration_container (WASM/WebGPU checkbox) is only relevant for
			// browser engines; server engines have no client-side device choice
			const selected_engine = translator_engine.find(el => el.name===self.translator_engine_select.value)
			if (selected_engine && selected_engine.type==='browser') {
				configuration_container.classList.remove('hide')
			}else{
				configuration_container.classList.add('hide')
			}
		}
		self.translator_engine_select.addEventListener('change', change_handler)

	// configuration
	// open/close the configuration options
		const show_configuration = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'icon gear',
			parent			: automatic_translation_container
		})
		const show_configuration_click_handler = function (e) {
			configuration_container.classList.toggle('hide')
		}
		show_configuration.addEventListener('click', show_configuration_click_handler)

		const configuration_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'configuration_container hide',
			parent			: automatic_translation_container
		})

		// device checkbox
		const device_container = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'device_container',
			parent 			: configuration_container
		})

		const option_label = ui.create_dom_element({
			element_type	: 'label',
			inner_html		: self.get_tool_label('cpu_device') || 'More compatible, slower.',
			parent			: device_container
		})

		const translator_device_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox'
		})

		self.translator_device_checkbox = translator_device_checkbox

		option_label.prepend(translator_device_checkbox)

		const device_id = 'translator_device_checkbox'
		translator_device_checkbox.addEventListener('change', function(){
			data_manager.set_local_db_data({
				id		: device_id,
				value	: translator_device_checkbox.checked
			}, 'status')
		})

		// restore the persisted device preference from IndexedDB on build
		data_manager.get_local_db_data(
			device_id,
			'status'
		).then(function( device_saved ){
			if(device_saved){
				translator_device_checkbox.checked = device_saved.value
			}
		})

		// initial visibility: show config if the default engine is browser type
		// mirrors the change_handler logic applied once at build time so the UI
		// reflects the pre-selected engine without requiring a 'change' event
		const initial_engine = translator_engine.find(el => el.name===self.target_translator)
		if (initial_engine && initial_engine.type==='browser') {
			configuration_container.classList.remove('hide')
		}

	return automatic_translation_container
}//end build_automatic_translation



/**
* CHANGE_COMPONENT_LANG
* Switch the display language of a source or target component and re-render it in place.
*
* The component's lang property is updated and then component.refresh() is awaited,
* which triggers a full server round-trip to fetch data in the new language.
*
* Read-only logic:
* - The source component (id_variant === 'tool_lang') is always read-only regardless
*   of the language chosen; the translator must not alter the source text.
* - The target component is read-only only when the chosen language equals source_lang,
*   preventing two editable CKEditor instances on the same underlying component.
*
* auto_init_editor is set to true before refresh() so that rich-text editors (CKEditor)
* initialize automatically when the component re-renders in the new language.
*
* @param {Object} options
* @param {Object} options.self      - tool_lang instance (provides source_lang for comparison)
* @param {Object} options.component - component instance to update; may be source or target
* @param {string} options.lang      - new language code to switch to (e.g. 'lg-spa')
* @returns {Promise<boolean>} resolves true when the component has finished refreshing
*/
export const change_component_lang = async (options) => {

	// options
		const self		= options.self
		const component	= options.component
		const lang		= options.lang

	// id_variant: tool_lang / target_component
	// 'tool_lang' is the id_variant assigned to the source (main_element) in tool_lang.js build();
	// any other value (e.g. 'target_component') indicates the target side
		const is_main = component.id_variant==='tool_lang'

	// read_only
	// source is always read-only; target is read-only only when its language would match
	// the source language (to avoid dual-editor conflicts)
		component.show_interface.read_only = is_main || (lang===self.source_lang)

	// render component
		component.lang = lang
		// set auto_init_editor for convenience
		component.auto_init_editor = true

		await component.refresh()


	return true
}//end change_component_lang



/**
* RENDER_STATUS
* Render the status components to get control of the process of the tool.
*
* Produces a DocumentFragment containing up to two rendered components:
* - status_user_component  — visible to regular users; controls the translation
*   workflow state (e.g. pending, in-progress, done).
* - status_admin_component — visible to administrators; may expose additional
*   workflow transitions or override capabilities.
*
* Both components are rendered in 'mini' view with tools and save animations
* disabled so they act as compact inline indicators rather than full edit widgets.
*
* The components themselves are resolved by tool_lang.build() from the tool's
* ddo_map (ontology config): roles 'status_user_component' and 'status_admin_component'.
* If either role is absent from the config, the corresponding component will be
* undefined on self and the block is silently skipped here.
*
* @param {Object} self - tool_lang instance; may carry status_user_component
*   and/or status_admin_component as component instances
* @returns {Promise<DocumentFragment>} fragment with zero, one, or two component nodes
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
