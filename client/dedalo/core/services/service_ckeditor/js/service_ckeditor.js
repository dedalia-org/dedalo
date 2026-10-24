// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, ddEditor, ckeditor, DEDALO_ROOT_WEB, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../../common/js/events.js'
	import {common} from '../../../common/js/common.js'
	import {clone, get_json_langs, load_script} from '../../../common/js/utils/index.js'
	import {render_button, render_find_and_replace} from './render_text_editor.js'



// ckeditor_load_promise: module-level memo for the ONE shared engine load per page.
let ckeditor_load_promise = null

/**
* PRELOAD_CKEDITOR
* Load the shared CKEditor bundle (~1.5 MB JS, ≈360 KB gzipped) and the language
* data ONCE per page, ahead of the first activation.
*
* Why: the bundle + its parse used to be paid inside the first mousedown, which
* is what the user read as "the editor is slow". It is per PAGE, not per
* component, so warming it costs one download on pages that show an editable
* text area and nothing per field — editor INSTANCES stay created on demand,
* which is the deferral that avoids one editor per text area.
*
* The memo collapses concurrent first clicks (and a preload already in flight)
* onto a single load; a rejected load clears it so the next activation retries.
* @returns {Promise<void>}
*/
export const preload_ckeditor = function() {

	if (typeof ckeditor !== 'undefined') {
		return Promise.resolve()
	}
	if (ckeditor_load_promise) {
		return ckeditor_load_promise
	}

	const ckeditor_file = DEDALO_ROOT_WEB + '/lib/ckeditor/build/ckeditor.js'
	ckeditor_load_promise = Promise.all([
		load_script(ckeditor_file),
		get_json_langs()
	])
	.then(() => {})
	.catch((error) => {
		ckeditor_load_promise = null
		throw error
	})

	return ckeditor_load_promise
}//end preload_ckeditor



// preload_scheduled: one idle warm-up per page (reset only if that attempt fails).
let preload_scheduled = false

/**
* SCHEDULE_CKEDITOR_PRELOAD
* Start the shared engine load during browser idle time, once per page, as soon
* as an editable text area renders. Metered connections (`saveData`) skip it:
* the user may never open the editor, and the deferred design exists for that.
* @returns {void}
*/
export const schedule_ckeditor_preload = function() {

	if (preload_scheduled) {
		return
	}
	if (navigator.connection && navigator.connection.saveData === true) {
		return
	}
	preload_scheduled = true
	dd_request_idle_callback(
		() => {
			preload_ckeditor()
			.catch(() => {
				// let a later render schedule another attempt
				preload_scheduled = false
			})
		}
	)
}//end schedule_ckeditor_preload



/**
* SERVICE_CKEDITOR
*
* Constructor-based service adapter that wraps CKEditor 5 for use inside
* Dédalo's component_text_area (ddEditor mode) and component_html_text
* (InlineEditor mode).
*
* Architecture overview
* ─────────────────────
* CKEditor 5 does not ship a built-in toolbar UI when used in headless
* ("ddEditor") mode.  This service creates and manages:
*   • The CKEditor instance (ddEditor or InlineEditor variant)
*   • A custom Dédalo toolbar rendered by build_toolbar() / render_button()
*   • Dédalo-specific tag model: inline <img> nodes carrying data-type,
*     data-tag_id, data-state, data-label and data-data attributes, plus
*     inline text runs with a 'reference' model attribute.
*   • Dirty-tracking via is_dirty / set_dirty() / init_status_changes()
*   • Round-trip tag operations: set_content, delete_tag, update_tag,
*     get_last_tag_id, wrap_selection_with_tags, get_view_tag, etc.
*
* Tag flavours managed by this service
* ──────────────────────────────────────
*   imageInline tags (CKEditor model element 'imageInline', rendered as
*   <span><img></span> in the view): draw, geo, tc, indexIn, indexOut, svg,
*   page, person, note, lang.
*
*   reference tags: inline text marked with the 'reference' attribute in the
*   CKEditor model (not an imageInline node); handled separately throughout.
*
* Lifecycle
* ─────────
*   new service_ckeditor() → init(options) → create_ddEditor|create_InlineEditor
*   → [user edits] → save() / destroy()
*
* Dependencies
* ─────────────
*   • ckeditor global (loaded on demand from DEDALO_ROOT_WEB/lib/ckeditor/build)
*   • plug-ins/reference/src — custom CKEditor plugin bundled into ckeditor.js
*   • render_text_editor.js  — render_button, render_find_and_replace helpers
*
* @todo Unify service model using prototypes (all methods currently assigned
*       directly on `this` inside the constructor function)
*/
export const service_ckeditor = function() {



	// self vars
		this.caller
		this.value_container
		this.toolbar_container
		this.options
		this.key
		this.editor
		this.fallback_value



	/**
	* INIT
	* Get the options of the caller that do the initialization and set the instance
	* the caller is a component_text_area and the editor is a instance of the ckeditor
	* CkEditor is compiled with custom plug-in: dedalo_tags to upcast and downcast the Dédalo tags into the ckeditor model
	* 	See the ckeditor.js file in ../libs_dev/ckeditor to change the conversion tags
	* Editor load the core and common commands and plugins from ckEditor but Dédalo will not use the ckEditor user interface
	* the interface is created inside the toolbar_container with custom icons and functionalities
	*
	* Initialization sequence:
	*   1. Awaits preload_ckeditor() — the shared ckeditor.js + JSON language
	*      data, normally already warming/loaded at page idle (see
	*      schedule_ckeditor_preload), so the click pays for the instance only.
	*   2. Waits (50 ms polling, only when needed) for `ckeditor` to become
	*      available in the global scope (webpack async chunk may not be
	*      synchronous even after the script tag loads).
	*   3. Delegates to create_ddEditor or create_InlineEditor depending on
	*      options.editor_class.
	*
	* @param {Object} options
	* @param {Object}      options.caller          - component_text_area instance owning this service
	* @param {HTMLElement} options.value_container  - editable DOM node passed to CKEditor as the source element
	* @param {HTMLElement} options.toolbar_container - DOM node where Dédalo's custom toolbar is rendered
	* @param {string}      options.fallback_value   - HTML placeholder shown when the editor is empty
	* @param {number|string} options.key            - Array index into the caller's data array for the text value
	* @param {Object}      options.editor_config    - Toolbar definition and custom event callbacks (see build_toolbar/setup_events)
	* @param {string}      [options.editor_class='ddEditor'] - 'ddEditor' (default) or 'InlineEditor'
	* @returns {Promise<Object>} Resolves to the created CKEditor editor instance
	*/
	this.init = async function(options) {

		const self = this

		// options vars
			const caller			= options.caller // compnent_text_area that create the instance
			const value_container	= options.value_container // dom node to be used as value container (empty when is set by the caller)
			const toolbar_container	= options.toolbar_container // dom node for the toolbar
			const fallback_value	= options.fallback_value // the html data to be showed as placeholder when value is empty
			const key				= options.key // array key of the value of the caller data
			const editor_config		= options.editor_config // options for build custom buttons in the toolbar or custom events
			const editor_class		= options.editor_class || 'ddEditor'

		// fix vars
			self.caller				= caller
			self.value_container	= value_container
			self.toolbar_container	= toolbar_container
			self.options			= options
			self.key				= key
			self.fallback_value		= fallback_value

		// load ckeditor files if not already loaded (shared, memoized, warm)
			await preload_ckeditor()

		// set json_langs (loaded once and set to global var)
			self.json_langs = await get_json_langs()

		// create editor (ddEditor|InlineEditor)
			const create = async function (){
				// init ckeditor (InlineEditor|ddEditor)
				switch(editor_class) {
					case 'InlineEditor':
						await self.create_InlineEditor(editor_config)
						break;

					case 'ddEditor':
					default:
						await self.create_ddEditor(editor_config)
						break;
				}
			}

		return new Promise(function(resolve, reject){
			let wait_ckeditor = null
			const create_editor = function() {
				clearInterval(wait_ckeditor)
				create().then(resolve, reject)
			}
			// fast path: a script's load event fires after it ran, so after the
			// preload the global is normally already defined — no 50 ms tick lost
			if ( typeof ckeditor !=='undefined' ) {
				create_editor()
				return
			}
			// slow path: the webpack async chunk may expose the global later
			wait_ckeditor = setInterval(function() {
				if ( typeof ckeditor !=='undefined' ) {
					create_editor()
				}
			}, 50);
		})
	}//end init



	/**
	* CREATE_INLINEEDITOR
	* Builds a ckeditor InlineEditor instance
	* This instance uses full featured ckeditor toolbar and is used
	* by component_html_text
	*
	* Key responsibilities beyond a plain InlineEditor.create():
	*   • Loads the CKEditor translation file for the current Dédalo data
	*     language (page_globals.dedalo_data_lang) when it is not English.
	*   • Optionally removes the 'reference' button from the toolbar by
	*     inspecting editor_config.toolbar (the caller opts in by including
	*     the string 'reference' in that array).
	*   • Configures the simple-upload plugin to POST images to the Dédalo
	*     API endpoint (/core/api/v1/json/index.php), which constructs the
	*     RQO from the URI query-string variables.
	*   • Moves the CKEditor balloon toolbar panel into self.toolbar_container
	*     so that Dédalo controls its visibility and sizing.
	*   • Attaches a ResizeObserver so the toolbar width tracks the editable
	*     area width automatically.
	*   • Delegates to init_status_changes(), setup_button_reference(), and
	*     setup_events() after the editor promise resolves.
	*
	* @param {Object} editor_config - same shape accepted by build_toolbar; must
	*        contain at least {toolbar: string[], read_only: boolean}
	* @returns {Promise<Object>} Resolves to the InlineEditor instance
	*/
	this.create_InlineEditor = async function(editor_config) {

		const self = this

		// set the lang of the tool
			const json_langs	= self.json_langs || []
			if (json_langs.length<1) {
				console.error('Error. Expected array of json_langs but empty result is obtained:', json_langs);
			}
			const dedalo_lang	= page_globals.dedalo_data_lang
			const lang_obj		= json_langs.find(item => item.dd_lang===dedalo_lang)
			let lang			= lang_obj
				? lang_obj.tld2
				: 'en'

			if(lang !== 'en'){
				const ck_translation_file = DEDALO_ROOT_WEB + '/lib/ckeditor/build/translations/'+lang+'.js'
				try {
					await load_script(ck_translation_file)
				} catch (error) {
					// Most tld2 codes (76 of 138) ship no CKEditor translation. Fall
					// back to English: a missing UI language must not make the field
					// impossible to open.
					console.error('service_ckeditor: no CKEditor translation for "'+lang+'". Falling back to English.', error)
					lang = 'en'
				}
			}

		// remove loading class of value_container before is changed by ckeditor
			self.value_container.classList.remove('loading')

		// Remove reference toolbar
		// when is defined don't touch the toolbar, reference isset by default
		// else remove the reference button in the tool bar.
			const remove_reference = editor_config.toolbar.find(el => el === 'reference')
				? [null]
				: ['reference']

		return new Promise(function(resolve, reject){

			// editor.
			// InlineEditor is created from lib ckeditor source using webpack.
			// See source and webpack config files
			// InlineEditor is initialized with user interface
			ckeditor.InlineEditor.create( self.value_container, {
				// initialData: value
				// toolbar: {
					// 	items : [
					// 		"heading",
					// 		// "|",
					// 		"bold",
					// 		"italic",
					// 		"underline",
					// 		"strikethrough",
					// 		"alignment",
					// 		"|",
					// 		"undo",
					// 		"redo",
					// 		"|",
					// 		"findAndReplace",
					// 		"sourceEditing",
					// 		"|",
					// 		"imageUpload",
					// 		"blockQuote",
					// 		"insertTable",
					// 		"htmlEmbed",
					// 		"link",
					// 		// "-",
					// 		"style",
					// 		"|",
					// 		"fontColor",
					// 		"fontBackgroundColor",
					// 		"fontSize",
					// 		"fontFamily",
					// 		"superscript",
					// 		"subscript",
					// 		"|",
					// 		"numberedList",
					// 		"bulletedList",
					// 		"horizontalLine",
					// 		"|",
					// 		"outdent",
					// 		"indent",
					// 		"|",
					// 		"specialCharacters",
					// 		"pageBreak"
					// 	],
					// 	shouldNotGroupWhenFull: false
					// }
				toolbar:{
					removeItems: remove_reference
				},
				// Set the lang of the DEDALO_DATA_LANG.
				language: lang,
				simpleUpload: {
					// The URL that the images are uploaded to.
					// It call to in index.php of API (../core/api/v1/json/index.php)
					// the rqo will created as to use the 'upload' by default
					// the main rqo vars needed as rqo.options will be created with the URI variables.
					// rqo.upload property will created with the name of the file
					uploadUrl: DEDALO_API_URL + '?resource_type=web&key_dir=web'
				},
				placeholder: self.fallback_value
			})
			.then( editor => {

				// fix the instance
					self.editor = editor

			// init editor status changes to track isDirty value
					self.init_status_changes()

				// setup_events
					self.setup_button_reference();

				// setup_events
					self.setup_events(editor_config);

				// read_only
					if(editor_config.read_only) {
						editor.enableReadOnlyMode( 'read_only_ mode' );
					}

				// set toolbar width
					(()=>{
						// elements
							const toolbar			= editor.ui.view.toolbar
							const ck_toolbar		= toolbar.element
							const ck_balloon_panel	= ck_toolbar.parentNode
							// move ck_balloon_panel inside component toolbar_container
							self.toolbar_container.appendChild(ck_balloon_panel)

						// adjust_size function
							const adjust_size = () => {
								const width = self.value_container.offsetWidth // add corrective factor of 47 px
								// fix maxWidth
								// toolbar.maxWidth = width
								// set styles
								Object.assign(ck_toolbar.style, {
									width : width + 'px'
								});
							}

						// sync toolbar container. Focus/blur editor show/hide the toolbar container
							editor.ui.focusTracker.on( 'change:isFocused', ( evt, name, isFocused ) => {
								if ( isFocused===true ) {
									self.toolbar_container.classList.remove('hide')
								}else{
									self.toolbar_container.classList.add('hide')
								}
							} );

						// resize value_container observer
							const resizeObserver = new ResizeObserver((entries) => {
								for (const entry of entries) {
									if (entry.contentBoxSize) {
										window.requestAnimationFrame(adjust_size)
									}
								}
							});
							resizeObserver.observe(self.value_container);
					})()

				resolve(editor)
			})
			.catch( error => {
				console.error( 'Oops, something went wrong!' );
				console.error( error );
				// reject, don't leave the caller awaiting forever: init() now
				// propagates failures and the view re-arms the click
				reject(error)
			});
		})
	}//end create_InlineEditor



	/**
	* CREATE_DDEDITOR
	* Builds a ckeditor ddEditor instance
	* This instance uses custom limited toolbar and is used
	* by component_text_area
	*
	* ddEditor is the headless CKEditor 5 variant bundled in
	* /lib/ckeditor/build/ckeditor.js (compiled with webpack, including the
	* custom dedalo_tags and reference plug-ins).  It has no built-in toolbar
	* UI; instead Dédalo's build_toolbar() creates a fully custom toolbar inside
	* self.toolbar_container.
	*
	* Additional wiring performed here:
	*   • clipboardInput handler — prevents a drag-and-drop from placing the
	*     caret *inside* an existing imageInline tag (img node) by forcing the
	*     drop position to be *after* the img's parent span.
	*   • toolbar toggle — mousedown on the parent node reveals the toolbar;
	*     a delegated mouseup on document.body hides it when focus leaves the
	*     component area.
	*   • Adds 'editor_container' CSS class to the view root for styling.
	*   • Removes self.value_container from the DOM after CKEditor has
	*     consumed its initial HTML content (CKEditor injects its own editable).
	*
	* @param {Object} editor_config - same structure as accepted by build_toolbar/setup_events
	* @returns {Promise<Object>} Resolves to the ddEditor instance
	*/
	this.create_ddEditor = async function(editor_config) {

		const self = this

		// editor
		// ddEditor is created from lib ckeditor source using webpack.
		// See source and webpack config files
		// ckEditor is initialized without user interface
			const editor = await ckeditor.ddEditor.create( self.value_container, {
				// initialData: value
				placeholder: self.fallback_value
			})

		// fix the instance
			self.editor = editor

		// focus
			// editor.ui.focusTracker.on( 'change:isFocused', ( evt, data, isFocused ) => {
			//     console.log( `The editor is focused: ${ isFocused }.` );
			// } );

		// build toolbar
			self.build_toolbar(editor_config);

		// setup_events
			self.setup_events(editor_config);

		// read_only
			if(editor_config.read_only) {
				editor.enableReadOnlyMode( 'read_only_ mode' );
			}

		// setup_button_reference
			self.setup_button_reference();

		// drag and drop control
			// Control the drop action to move the caret outside of the img node when the target is a img node (dd_tag)
			// the drop event doesn't has any effect in the final position of the drop,
			// the final check position is fired in the clipboardInput event.
			editor.editing.view.document.on( 'clipboardInput', ( evt, data ) => {

				// target is undefined unless a existing element is focus on paste or drop
				// In this cases, no more check area necessary. Stop here
					if (!data.target) {
						return
					}

				// check the target name of the element (expected a image)
				if(data.target.name==='img'){
					editor.editing.view.change((writer) => {
						// create new position at start and end of the target
						// use the target parent because the img is wrapped inside a span
						// the parent span has other position of the image and it's necessary avoid the parent position
						const start = writer.createPositionAt(
							data.target.parent,
							"after"
						);
						const end = writer.createPositionAt(
							data.target.parent,
							"after"
						);
						// create the range of the new position
						const range = writer.createRange(start, end);

						// it's not necessary change the range to model range
						// comment this code
							// writer.setSelection( range );
							// transform to the model_range
							// const model_range = editor.editing.mapper.toModelRange( range )
							// editor.model.change( writer => writer.setSelection( model_range ) );
							// data.targetRanges = [ editor.editing.mapper.toViewRange( model_range ) ];
						// set new range to the targetRanges of the data
						// it will use to calculate the drop position when will insertContect()
						data.targetRanges = [ range ];
					});
				}
			}, { priority: 'high' } );

		// Active this drop event listeners to change the visual effect, but any of them will change the result
			// editor.editing.view.document.on( 'drop', ( evt, data ) => {
			// }, { priority: 'high' } );

			// editor.editing.view.document.on( 'dragover', ( evt, data ) => {

			// 	if(data.target.name === 'img'){
			// 		evt.stop();
			// 		//Stop the default event action.
			// 		data.preventDefault();
			// 	}
			// }, { priority: 'high' } );

			// editor.editing.view.document.on( 'dragenter', ( evt, data ) => {

			// 	if(data.target.name === 'img'){

			// 		evt.stop();
			// 		//Stop the default event action.
			// 		data.preventDefault();
			// 	}
			// }, { priority: 'high' } );

		// init editor status changes to track isDirty value
			self.init_status_changes()

		// remove original value container
			if (self.value_container) {
				self.value_container.remove()
			}

		// click event
			self.click = function(e) {
				e.stopPropagation()
				e.preventDefault()

				self.toolbar_container.classList.remove('hide')
				editor.editing.view.focus()

				document.body.addEventListener('mouseup', fn_remove)
			}

		// add custom class to the root element of the editor
			editor.editing.view.change( writer => {
				writer.addClass( 'editor_container', editor.editing.view.document.getRoot() );
			});

		// toolbar toggle event
			// show toolbar_container on user mousedown
			// removes the toolbar_container when user click outside
			const node = self.toolbar_container.parentNode
			node.addEventListener('mousedown', function() {
				// remove the class 'hide' to show the toolbar
				self.toolbar_container.classList.remove('hide')
				document.body.addEventListener('mouseup', fn_remove)
			})
			function fn_remove(e) {
				if (e.target!==node) {
					const path	= e.composedPath()
					const found	= path.find(el => el===node)
					if (!found) {
						self.toolbar_container.classList.add('hide')
						document.body.removeEventListener('mouseup', fn_remove)
					}
				}
			}


		return editor
	}//end create_ddEditor



	/**
	* SAVE
	* Trigger save_value against caller sending key and value
	*
	* Only performs the save when self.is_dirty is true (the editor content
	* has been modified since the last save or init).  Delegates the actual
	* persistence to self.caller.save_value(key, value), which is the
	* component_text_area method responsible for writing back to the Dédalo
	* data matrix.  Resets is_dirty to false on success.
	*
	* @returns {Promise<boolean>} false when the editor was clean (no save needed),
	*   true after a successful save
	*/
	this.save = async function() {

		const self = this

		const editor	= self.editor
		const key		= self.key

		// // no user interactions case
		if (self.is_dirty!==true) {
			return false
		}

		const value = editor.getData();

		await self.caller.save_value(key, value)

		// set_set_dirty after save is finish
		self.is_dirty = false;


		return true
	}//end save



	/**
	* INIT_STATUS_CHANGES
	* Listen to new changes (to enable the "Save" button) and to pending actions.
	*
	* Attaches a debounced listener on the CKEditor model's 'change:data' event.
	* The debounce delay (waitTime = 500 ms) prevents marking the editor dirty
	* on every individual keystroke; set_dirty() is only called after the user
	* pauses typing for half a second.  This avoids excessive save triggers and
	* UI thrashing in component_text_area.
	*
	* @returns {void}
	*/
	this.init_status_changes = function() {

		const self		= this
		const editor	= self.editor

		// set a timer to wait until user is writing
		// when user stop set the dirty and change data
		let timer;              // Timer identifier
		const waitTime = 500;   // Wait time in milliseconds
		// the editor send a event when the data is changed and change the is_dirty state
		editor.model.document.on( 'change:data', () => {

			// Clear timer every time than keyup
				clearTimeout(timer);

			// Wait for X ms and then process data and setup dirty
				timer = setTimeout(() => {
					self.set_dirty(true);
				}, waitTime);

		});
	}//end init_status_changes



	/**
	* GET_VALUE
	* Get editor value as raw html string
	*
	* Calls CKEditor's getData(), which serialises the current model back to
	* the HTML string representation (using the downcast pipeline, including
	* the custom dedalo_tags downcast that converts imageInline model nodes
	* back to <img> elements with data-* attributes).
	*
	* @returns {string} The current HTML content of the editor
	*/
	this.get_value = function() {

		const self = this

		const editor = self.editor
		const value = editor.getData();

		return value
	}//end get_value



	/**
	* SETUP_EVENTS
	* callback when ckeditor is ready
	* Capture the event fired in the editor and callback to the caller to be processed. See render_edit_component_text_area.js
	*
	* Wires CKEditor view/model events to the caller's custom_events callbacks
	* so that component_text_area can respond to user interactions without
	* holding a direct reference to CKEditor internals.
	*
	* Event mapping:
	*   focus          → custom_events.focus(domEvent, {})
	*   blur           → custom_events.blur(domEvent, {})
	*   click          → resolves the clicked element (img tag or reference text
	*                    run) and invokes custom_events.click / custom_events.MouseUp
	*                    with a tag_obj payload.
	*   selectionChangeDone → custom_events.MouseUp(null, {selection}) with the
	*                    serialised HTML selection string; skipped for one cycle
	*                    after a click on a tag (prevent_selectionChangeDone flag).
	*   change:data    → collects changed imageInline entries and fires
	*                    custom_events.changeData(evt, ar_changes) where each
	*                    entry is {action, tag_id, type}.
	*   keydown        → custom_events.KeyUp(domEvent, {})
	*
	* tag_obj shape (for click/MouseUp payloads):
	*   { type, tag_id, state, label, data, node_name }
	*   — for references: sourced from the CKEditor selection attribute 'reference'
	*   — for imageInline: sourced from data-* attributes on the parent span
	*
	* @param {Object} editor_config - must contain {custom_events: Object}
	* @returns {boolean} true always
	*/
	this.setup_events = function(editor_config) {

		const self		= this
		const editor	= self.editor
		// used to pass the the events in the editor to the custom_events in the caller
		// defined in the render of the component_text_area with the events that it could process
		// when the event in the editor is fired, it call to the event in the caller and do the process of data
		const custom_events = editor_config.custom_events || {}

		// prevent
			custom_events.prevent_selectionChangeDone = false

		// focus event
			editor.editing.view.document.on('focus', function(evt, data ) {
				if (custom_events.focus) {
					custom_events.focus(data.domEvent, {})
				}
			});//end focus event

		// blur event
			editor.editing.view.document.on('blur', function(evt, data ) {
				if (custom_events.blur) {
					custom_events.blur(data.domEvent, {})
				}
			});//end blur event

		// click event
			editor.editing.view.document.on('click', function(evt, data ) {
				// data.stopPropagation()
				// data.preventDefault()

				// 1 get the reference by the selection
				// references are different of the other tags
				// references has a text property as bold, italics, etc
				// therefore is necessary get his attributes by the selection
				// sometime the reference is in the middle of a bold text and the node click is the bold
				// to avoid search into the DOM use the selection to text if has the reference attributes
				const selection = editor.editing.model.document.selection;
				const has_reference = selection.hasAttribute( 'reference' )

				// get the node_name clicked
				const click_element = has_reference
					? 'reference'
					: data.target.name // get the name of the node clicked, 'img' 'p' 'div', etc

				// check if the click element was inside a empty editor. div is the main node and it doesn't has parent, parent=undefined
				if(click_element==='div' || ( click_element!=='img' && has_reference!==true)){
					return
				}
				// get the parent node for the common tag (instead the references)
				const item = data.target.parent

				// get the parent of the img, it will be a span with the data of the tag in attributes
				// const item = data.target.parent._attrs
				const tag_obj =  has_reference
					? selection.getAttribute( 'reference' )
					: {
						type		: item.getAttribute('data-type'),
						tag_id		: item.getAttribute('data-tag_id'),
						state		: item.getAttribute('data-state'),
						label		: item.getAttribute('data-label'),
						data		: item.getAttribute('data-data')
					 }

				// add node_name to the tag object to identify the origin
				tag_obj.node_name = click_element

				if (custom_events.click) {
					custom_events.click(data.domEvent, tag_obj)
				}

				if (custom_events.MouseUp && (click_element==='img' || click_element==='reference')) {
					custom_events.prevent_selectionChangeDone = click_element==='reference' ? true : false;
					// if the element clicked is not a img (any text or other elements in the editor) get the selection and fire mouseup
					const options = {
						selection	: '',
						node_name	: click_element
					}
					custom_events.MouseUp(data.domEvent, options)
				}
			});//end click event

			// editor.editing.view.document.on('mouseup', async function(evt, data ){
			// 	// get the name of the node clicked, 'img' 'p' 'div', etc
			// 	const click_element = data.target.name

			// 	if (custom_events.MouseUp && click_element==='img') {
			// 		// if the element clicked is not a img (any text or other elements in the editor) get the selection and fire mouseup
			// 		const options = {
			// 			selection : ''
			// 		}
			// 			// console.log("click_element:",click_element);
			// 			// console.log("options:",options);
			// 		custom_events.MouseUp(data.domEvent, options)
			// 	}
			// })
			editor.editing.view.document.on('selectionChangeDone', function(evt, data) {

				if(custom_events.prevent_selectionChangeDone === true){
					custom_events.prevent_selectionChangeDone = false
					return
				}

				if (custom_events.MouseUp) {
					// if the element clicked is not a img (any text or other elements in the editor) get the selection and fire mouseup
					const options = {
						selection : self.get_selection()
					}
					custom_events.MouseUp(
						null, // event (no DOM event in this case)
						options // object with selection info
					)
				}
			});//end click event

			// change data is used to observe changes in editor as insert or remove
			// select the image changes (tag changes) to fire event to other components
			// see the render_edit_component_text_area to see the event dispatched
			editor.editing.model.document.on('change:data', (evt, batch) => {
				const changes = editor.editing.model.document.differ.getChanges(); //{ includeChangesInGraveyard: true }
				const ar_changes =[]
				for (const entry of changes) {
					if (entry.name == 'imageInline' ) {
						const attributes = entry.attributes
						const type = attributes.get('type')
						const tag_id = attributes.get('tag_id')
						ar_changes.push({
							action	: entry.type, // insert || remove
							tag_id	: tag_id,
							type	: type // draw, geo, tc, indexIn, indexOut, svg. page, person, note, lang, reference
						})
					}
				}
				if (custom_events.changeData) {
					custom_events.changeData(evt, ar_changes)
				}
			});//end change:data event

		// keyup event
			editor.editing.view.document.on('keydown', function(evt, data ) {

				if(SHOW_DEBUG===true) {
					// console.log('evt:', evt);
					// console.log('data:', data);
					// console.log('data.domEvent:', data.domEvent);
				}

				if (custom_events.KeyUp) {
					custom_events.KeyUp(data.domEvent, {})
				}
			}); //end keyup event


		return true
	}//end onsetup_editor



	/**
	* SETUP_BUTTON_REFERENCE
	* callback when ckeditor is ready
	* Capture the event fired in the editor and callback to the caller to be processed. See render_edit_component_text_area.js
	*
	* Hooks into the CKEditor 'reference' command's 'execute' event so that
	* when the user presses the reference toolbar button, Dédalo's own modal
	* dialog is opened instead of any built-in CKEditor UI.
	*
	* Sequence when the reference button is activated:
	*   1. Publishes the event 'create_reference_<id_base>_<key>' via
	*      event_manager so any registered listener in the caller hierarchy
	*      can react.
	*   2. Checks whether the current selection already covers a reference tag
	*      (via get_selected_reference_element); if so, re-uses that tag
	*      object (edit mode) rather than creating a new one.
	*   3. If creating a new reference, calculates the next available tag_id
	*      (max existing reference tag_id + 1) to ensure uniqueness within
	*      the editor content.
	*   4. Calls self.caller.render_reference() which is component_text_area's
	*      method responsible for showing the reference-creation modal.
	*
	* @returns {boolean} true always
	*/
	this.setup_button_reference = function() {

		const self		= this
		const editor	= self.editor
		const key  		= self.key

		editor.commands.get( 'reference' ).on( 'execute', ( evt, args ) => {
			// fire event
			event_manager.publish('create_reference_'+ self.id_base + '_' + key, {
				caller		: self,
				text_editor	: self
			})

			const seleted_tag = self.get_selected_reference_element()

			// create the new tag for the reference
			const last_tag_id	= self.get_last_tag_id( {tag_type:'reference'} )
			const tag_id		= last_tag_id + 1

			const reference_tag		= {
				type	: 'reference',
				label	: 'reference ' + tag_id,
				tag_id	: String(tag_id),
				state	: 'n',
				data	: ''
			}
			const tag = (seleted_tag)
				? seleted_tag
				: self.caller.build_view_tag_obj(reference_tag, reference_tag.tag_id)

			// render the modal
			self.caller.render_reference({
				self		: self.caller,
				text_editor	: self,
				i			: key,
				tag			: tag
			})
		});


		return true
	}//end setup_button_reference



	/**
	* SET_CONTENT
	* Get the tag parameters and create the node of the DOM using the ckeditor tools
	* insert the node in the caret position
	*
	* Inserts a new 'imageInline' model element at the current caret position.
	* The tag_obj is passed directly as the element's attribute map; callers
	* must therefore pre-populate all required attributes (type, tag_id, state,
	* label, data, src, id, etc.) before calling this method.
	*
	* After insertion, is_dirty is set to true directly (bypassing the normal
	* debounce in init_status_changes) because the change is programmatic and
	* should be marked dirty immediately rather than waiting for the timer.
	*
	* @param {Object} tag_obj - Attribute map for the new imageInline element;
	*   expected keys: type, tag_id, state, label, data, src, src_id, id.
	*   All values must be their native types (not JSON-stringified).
	* @returns {boolean} true always
	*/
	this.set_content = function(tag_obj) {

		const self		= this
		const editor	= self.editor

		editor.model.change( writer => {
			// get the end position of the selection
			const position = editor.model.document.selection.getLastPosition()
			// create the tag_node
			const model_tag_node = writer.createElement( 'imageInline', tag_obj )
			// Insert the html in the current selection location.
			editor.model.insertContent( model_tag_node, position );
		});

		self.is_dirty = true;


		return true
	}//end set_content



	/**
	* DELETE_TAG
	* Removes the imageInline model node(s) that match the given tag_obj.
	*
	* Supports multi-type deletion (e.g. removing both 'indexIn' and 'indexOut'
	* for the same tag_id in a single call) by accepting type as either a string
	* or an Array.  Each type is processed in a separate loop pass because
	* deleting one node invalidates the current range, so the range must be
	* re-created for every iteration.
	*
	* The walk is performed over the CKEditor model (not the view) because model
	* node identity is stable and the _attrs Map is the authoritative source for
	* 'type' and 'tag_id'.
	*
	* Note: uses loose equality (==) to compare tag_id values because the stored
	* attribute may be a number while the incoming tag_id may be a string (or
	* vice versa).
	*
	* @param {Object} tag_obj - Search criteria
	* @param {string|Array} tag_obj.type   - Tag type(s) to match (e.g. 'indexIn' or ['indexIn','indexOut'])
	* @param {string|number} tag_obj.tag_id - Numeric ID of the tag to remove
	* @returns {Promise<boolean>} Resolves to true after all matching nodes have been removed
	*/
	this.delete_tag = function(tag_obj) {

		// options
			const type		= tag_obj.type
			const tag_id	= tag_obj.tag_id

		// short vars
			const self		= this
			const editor	= self.editor
			const ar_type	= (type instanceof Array)
				? type
				: [type]

		return new Promise(function(resolve) {

			// root. Whole editor document to traverse
				const root = editor.model.document.getRoot();

			// iterate multiple types like case [indexIn, indexOut]
			// note that it's necessary get the range in each iteration because
			// when a element is deleted, the range changes
			const ar_type_length = ar_type.length
			for (let i = 0; i < ar_type_length; i++) {

				// type
					const current_type = ar_type[i]

				// range. Create a range spanning over the entire root content:
					const range = editor.model.createRangeIn( root );

				// Iterate over all items in this range:
					for ( const value of range.getWalker({ ignoreElementEnd: true }) ) {

						const item = value.item

						// attributes. Get an object like:
						// {
						//   attributes : {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
						//	 classes : ['index']
						// }
						const attributes = item._attrs

						if(attributes && attributes.size > 0) {

							const current_att_type		= attributes.get('type')
							const current_att_tag_id	= attributes.get('tag_id')

							if(current_att_tag_id==tag_id && current_att_type===current_type) {

								// remove
									editor.model.change( writer => {
										writer.remove( item )
									});

								// set dirty state
									self.set_dirty(true)

								// if the tag was found break the loop
									break;
							}
						}
					}//end for( const value of range.getWalker({ ignoreElementEnd: true }) )
			}//end for (let i = 0; i < ar_type_length; i++)

			resolve(true)
		})
	}//end delete_tag



	/**
	* GET_EDITOR_CONTENT_DATA
	* get the full data of the editor in html format to be saved
	*
	* Returns the live DOM root element of the CKEditor editable area (not the
	* serialised HTML string — use get_value() for that).  This is useful when
	* the caller needs to traverse or measure the actual rendered DOM, e.g. for
	* tag-highlight overlays or print layout.
	*
	* The 'main' key in domRoots refers to the single root document element;
	* for a non-inline/iframe-based editor this is the body of the iframe, for
	* a div-based editable it is the div itself.
	*
	* @returns {HTMLElement|false} The editable root element, or false if the
	*   editor is not yet initialised or 'main' root is unavailable
	*/
	this.get_editor_content_data = function() {

		const self = this

		// editor
			const editor = self.editor
			if (!editor) {
				console.error("Error on get self.editor. Not available. self:", self);
				return false
			}

		// editor_content_data. get the domRoots map of the editor
			const domRoots				= editor.editing.view.domRoots;
			const editor_content_data	= domRoots.get('main') // Returns the root element of the editable area. For a non-inline iframe-based editor, returns the iframe's body element.
			if (!editor_content_data) {
				console.error("! INVALID editor_content_data (getBody) editor_content_data:", editor_content_data, " editor:", self.editor);
			}

		return editor_content_data
	}//end get_editor_content_data



	/**
	* GET_SELECTION
	* get the html fragment, in string format, selected by the user
	*
	* Extracts the current user selection from the CKEditor model, converts it
	* to a CKEditor DocumentFragment, then serialises that fragment to an HTML
	* string via editor.data.stringify().  The result is the raw HTML for only
	* the selected content, as CKEditor would serialise it (including downcast
	* of any imageInline / reference model nodes back to HTML).
	*
	* Returns an empty string when the selection is collapsed (no text is
	* selected), and false when the editor instance is not available.
	*
	* @returns {string|false} HTML string of the selected content, or false if
	*   the editor is unavailable
	*/
	this.get_selection = function() {

		const self = this

		const editor = self.editor
		if (!editor) {
			return false
		}

		// get the user selection
		const user_selection = editor.model.document.selection

		// get the content of the selection, it get the html representation
		const content = editor.model.getSelectedContent(user_selection)

		// convert the ckeditor data to html in string format
		const selection = editor.data.stringify(content)


		return selection
	}//end get_selection



	/**
	* WRAP_SELECTION_WITH_TAGS
	* Get the tag_in and the tag out
	*
	* Inserts a pair of imageInline model nodes around a text selection to
	* create a start/end marker pair (as used for indexIn/indexOut index tags).
	*
	* Two separate model.change() calls are required because after inserting
	* tag_in, the selection's last position (used for tag_out) shifts.  The
	* method therefore reads getFirstPosition() for the in-tag, then
	* getLastPosition() for the out-tag in the second pass.
	*
	* After both inserts, is_dirty is explicitly set to false.
	* (!) This intentionally overrides the normal debounce mechanism; the caller
	* is expected to manage the dirty state separately after a wrap operation.
	*
	* @param {Object} tag_obj_in  - Attribute map for the opening imageInline element (type:'indexIn', ...)
	* @param {Object} tag_obj_out - Attribute map for the closing imageInline element (type:'indexOut', ...)
	* @returns {boolean} true always
	*/
	this.wrap_selection_with_tags = function(tag_obj_in, tag_obj_out) {

		const self 	 = this
		const editor = self.editor

		editor.model.change( writer => {
			// convert the html to the model of ck_editor

			// get the in position of the selection
			const in_position = editor.model.document.selection.getFirstPosition()

			const model_tag_obj_in = writer.createElement( 'imageInline', tag_obj_in );

			editor.model.insertContent( model_tag_obj_in, in_position );

		});

		editor.model.change( writer => {
			// get the out position of the selection
			const out_position = editor.model.document.selection.getLastPosition()

			const model_tag_obj_out = writer.createElement( 'imageInline', tag_obj_out );
			// convert the html to the model of ck_editor
			editor.model.insertContent( model_tag_obj_out, out_position );
		});

		editor.editing.view.focus();
		self.is_dirty = false;


		return true
	}//end wrap_selection_with_tags



	/**
	* SET_SELECTION_FROM_TAG
	* Set text selection from given tag
	*
	* Handles two tag flavours differently:
	*
	*   'reference' tags — these are inline text runs with a 'reference' model
	*   attribute (not imageInline nodes).  CKEditor's view representation has
	*   a corresponding attribute element; the method locates it via
	*   get_view_tag() and uses writer.setSelection(el, 'on') to select it.
	*
	*   'indexIn'/'indexOut' tags — paired boundary markers.  The method finds
	*   both the 'indexIn' and 'indexOut' view elements for the given tag_id
	*   and calls set_selection_from_view_tags() to create a range that spans
	*   the text between them (from 'after' indexIn to 'before' indexOut).
	*
	* Returns false immediately for tag types other than 'reference',
	* 'indexIn', or 'indexOut'.
	*
	* @param {Object|null} tag_obj - Tag object with type and tag_id; pass null
	*   to no-op and return false
	* @returns {boolean} true when selection was set, false otherwise
	*/
	this.set_selection_from_tag = function(tag_obj) {

		// check tag object
			if(!tag_obj){
				return false
			}

		// short vars
			const self = this

		// Check the tag to be the type reference
		// reference tags don't need find the in and out because it has a close node
		// <reference>text to be selected</reference>
			if(tag_obj.type==='reference'){

				const editor = self.editor

				const tag_reference	= self.get_view_tag(tag_obj)

				editor.editing.view.change((writer) => {
					writer.setSelection( tag_reference, 'on' );
				});
			}

		// Index tags has a span to mark the in and other span to mark out as:
		// <span data.type="indexIn"></span>text to be selected<span data.type="indexOut"></span>
		// Check the tag to be the type indexXX
			if(tag_obj.type!=='indexIn' && tag_obj.type!=='indexOut'){
				return false
			}

		// tag_view_in. change the type to set it as indexIn and get the view tag in
			const tag_obj_in	= { ...tag_obj };
			tag_obj_in.type		= 'indexIn'
			const tag_view_in	= self.get_view_tag(tag_obj_in)

		// tag_view_out. change the type to set it as indexOut and get the view tag out
			const tag_obj_out	= { ...tag_obj };
			tag_obj_out.type	= 'indexOut'
			const tag_view_out	= self.get_view_tag(tag_obj_out)

		// selection_from_view_tags
			if(tag_view_in && tag_view_out){
				self.set_selection_from_view_tags(tag_view_in, tag_view_out)
			}else{
				console.warn('Invalid tag_view_in/tag_view_out:', tag_view_in, tag_view_out);
			}

		return true
	}//end set_selection_from_tag



	/**
	* GET_SELECTION_FROM_TAGS
	* Set selection and scroll selection into the view
	*
	* Creates a CKEditor view range that starts immediately *after* tag_view_in
	* and ends immediately *before* tag_view_out, then applies it as the view
	* selection.  The 'after'/'before' positions exclude the boundary marker
	* elements themselves so that only the content between them is highlighted.
	*
	* (!) Note: the method is named set_selection_from_view_tags in code but
	* the doc-block header says GET_SELECTION_FROM_TAGS — the end label
	* `//end get_selection_from_tags` reflects this legacy naming mismatch.
	*
	* @param {Object} tag_view_in  - CKEditor view element for the 'indexIn' span
	* @param {Object} tag_view_out - CKEditor view element for the 'indexOut' span
	* @returns {void}
	*/
	this.set_selection_from_view_tags = function(tag_view_in, tag_view_out) {

		const self 	 = this
		const editor = self.editor

		editor.editing.view.change((writer) => {

			const start = writer.createPositionAt(
				tag_view_in,
				'after'
			);

			const end = writer.createPositionAt(
				tag_view_out,
				'before'
			);

			// create the range of the new position
			const range = writer.createRange(start, end);

			writer.setSelection( range );
		});
	}//end get_selection_from_tags



	/**
	* SCROLL_TO_SELECTION
	* Scroll the editor to show the selection.
	* get the view selection and move the editor to center the range
	*
	* Uses CKEditor's built-in scrollToTheSelection() with a viewport offset
	* of 40 px so that the selected content is not obscured by a fixed toolbar.
	* No-ops silently when the selection range is null (e.g. when the editor
	* has no selection yet).
	*
	* @returns {void}
	*/
	this.scroll_to_selection = function() {

		const self		= this
		const editor	= self.editor

		const selection	= editor.editing.view.document.selection;
		const range		= selection.getFirstRange()

		if(range){
			editor.editing.view.scrollToTheSelection({
				target			: editor.editing.view.domConverter.viewRangeToDom(range),
				viewportOffset	: 40
			});
		}
	}//end scroll_to_selection



	/**
	* GET_VIEW_TAG
	* Locate the CKEditor view element corresponding to the given tag_obj.
	*
	* Walks the entire CKEditor view document tree (using createRangeIn on the
	* view root) looking for an element whose node name is 'img' or 'reference'
	* and whose data-type / data-tag_id attributes match tag_obj.type and
	* tag_obj.tag_id.
	*
	* For 'img' nodes (imageInline tags), the meaningful data-* attributes live
	* on the *parent* span element (not on the img itself), so the method
	* returns the parent span.  For 'reference' elements, the element itself
	* holds the attributes.
	*
	* Returns false (not null) when not found or when the editor is not ready,
	* so callers must guard with `if (!view_tag)`.
	*
	* @param {Object} tag_obj
	* @param {string} tag_obj.type   - Tag type to match (e.g. 'indexIn', 'reference')
	* @param {string} tag_obj.tag_id - Tag numeric ID as a string
	* @returns {Object|false} CKEditor view element (span or reference), or false if not found
	*/
	this.get_view_tag = function(tag_obj) {

		// the view type will need to be the same of the tag_obj
			const type = tag_obj.type

		// the view tag_id will need to be the same of the tag_obj
			const tag_id = tag_obj.tag_id

		// short vars
			const self		= this
			const editor	= self.editor

		// check
			if (!editor || !editor.editing) {
				console.warn('Ignored get_view_tag. Editor editing is not available. tag_obj:', tag_obj);
				return false
			}

		// root. Whole editor document to traverse
			const root = editor.editing.view.document.getRoot();

		// range. Create a range spanning over the entire root content:
			const range = editor.editing.view.createRangeIn( root );

		// Iterate over all items in this range:
			for ( const value of range.getWalker({ ignoreElementEnd: true }) ) {

				const item = value.item

				if(item.name !== 'img' && item.name !== 'reference'){
					continue
				}

				// attributes. Get an object like:
				// {
				//   attributes : {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
				//	 classes : ['index']
				// }
				// const htmlAttributes = item.getAttribute('htmlAttributes')
				// const htmlAttributes = item.getAttributes()
				const parent_item = (item.name === 'img')
					? item.parent
					: item

				const attributes = parent_item._attrs

				if(attributes && attributes.size > 0) {

					const current_type		= attributes.get('data-type')
					const current_tag_id	= attributes.get('data-tag_id')

					if(current_type===type && current_tag_id===tag_id) {
						return parent_item
					}
				}
			}//end for ( const value of range.getWalker({ ignoreElementEnd: true }) )


		return false
	}//end get_pair_tag



	/**
	* GET_VIEW_TAG_NODE
	* Get the DOM element of the tag
	* If the tag is a index the DOM element will be the span (it context the img node as child)
	*
	* Bridges from CKEditor's virtual view tree to the actual browser DOM by
	* using the view-to-DOM converter.  This is needed when the caller requires
	* a real HTMLElement (e.g. to measure position, add a highlight overlay, or
	* dispatch native DOM events).
	*
	* Internally calls get_view_tag() first to obtain the CKEditor view element,
	* then maps it to the DOM node via editor.editing.view.domConverter.
	*
	* @param {Object} tag_obj - Tag search criteria
	* @param {string} tag_obj.type   - Tag type (e.g. 'indexIn', 'draw', 'reference')
	* @param {string|number} tag_obj.tag_id - Tag numeric ID (converted to string internally)
	* @returns {HTMLElement} The real DOM span (or reference element) for the tag
	*/
	this.get_view_tag_node = function(tag_obj) {

		const self		= this
		const editor	= self.editor

		// the view type will need to be the same of the tag_obj
			const type = tag_obj.type

		// the view tag_id will need to be the same of the tag_obj
			const tag_id = tag_obj.tag_id

		// get view_tag
			const view_tag = self.get_view_tag({
				type	: type,
				tag_id	: tag_id.toString()
			})
		// get the DOM node of the view_tag, it will be the span node with the img node
			const tag_node = editor.editing.view.domConverter.mapViewToDom(view_tag)


		return tag_node
	}//end get_view_tag_node



	/**
	* GET_LAST_TAG_ID
	* Calculates all current text_editor editor tags id of given type (ex. 'tc') and get last used id
	*
	* Walks the entire CKEditor model tree collecting all tag_id values for
	* nodes whose type matches options.tag_type.  Returns the numeric maximum
	* of all found IDs (or 0 when none exist), which is used by callers to
	* derive the next available tag_id (last_tag_id + 1).
	*
	* Handles both imageInline model nodes (attributes on _attrs Map accessed
	* via getAttribute('type') / getAttribute('tag_id')) and inline reference
	* text runs (where the data lives in the 'reference' attribute object).
	*
	* Special case: 'index' is normalised to 'indexIn' because 'index' is a
	* logical group name, not an actual attribute value stored in the model.
	*
	* @param {Object} options
	* @param {string} options.tag_type - Logical tag type; 'index' is aliased to 'indexIn'
	* @returns {number} The highest numeric tag_id currently in the editor for that type, or 0
	*/
	this.get_last_tag_id = function(options) {

		// if the tag_type is index change to indexIn, index type is not used in the dataset of the tag and it's not parse to the model.
			const type = options.tag_type==='index'
				? 'indexIn'
				: options.tag_type

		// short vars
			const self		= this
			const editor	= self.editor

		// root. Whole editor document to traverse
			const root = editor.model.document.getRoot();

		// range. Create a range spanning over the entire root content:
			const range = editor.model.createRangeIn( root );

		// ar_tag_id, array with all id of the tags nodes
			const ar_tag_id = [0]

		// Iterate over all items in this range:
			for ( const value of range.getWalker({ ignoreElementEnd: true }) ) {

				const item = value.item

				// attributes. Get an object like:
				// {
				//   attributes : {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
				//	 classes : ['index']
				// }
				// const htmlAttributes = item.getAttribute('htmlAttributes')
				// const htmlAttributes = item.getAttributes()
				const current_type = item.hasAttribute('reference')
					? item.getAttribute( 'reference' ).type
					: item.getAttribute( 'type' )


				// if(attributes && attributes.size > 0) {

					// const current_type		= attributes.get('type')
					// const current_tag_id	= attributes.get('tag_id')

					if( current_type && current_type === type ) {
						 const current_tag_id	= item.hasAttribute('reference')
							? item.getAttribute( 'reference' ).tag_id
							: item.getAttribute( 'tag_id' )

						ar_tag_id.push(current_tag_id)
					}
				// }
			}//end for ( const value of range.getWalker({ ignoreElementEnd: true }) )

		const last_tag_id = Math.max(...ar_tag_id);


		return last_tag_id
	}//end get_last_tag_id



	/**
	* GET_VIEW_TAG_ATTRIBUTES
	* @param {Object} tag_obj - Tag object with type and tag_id for search the tag inside the model structure of ckeditor
	* @param {string} tag_obj.type   - Tag type to match (e.g. 'indexIn', 'draw')
	* @param {string} tag_obj.tag_id - Tag numeric ID as string
	* @returns {Object|null} Attribute object of the found tag, or null if not found.
	* 	sample: {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
	*
	* Walks the CKEditor view tree (not the model) to extract the data-*
	* attributes from the view representation of the matching tag.  The returned
	* plain object uses un-prefixed key names (type, tag_id, state, label, data)
	* regardless of how they are stored in the view (data-type, data-tag_id,
	* data-state, data-label, data-data).
	*
	* Used when the caller needs tag metadata without going through the model
	* (e.g. for read-only views where only the rendered DOM / view is available).
	*/
	this.get_view_tag_attributes = function(tag_obj) {

		// the view type will need to be the same of the tag_obj
			const type = tag_obj.type

		// the view tag_id will need to be the same of the tag_obj
			const tag_id = tag_obj.tag_id

		// short vars
			const self		= this
			const editor	= self.editor

		// root. Whole editor document to traverse
			const root = editor.editing.view.document.getRoot();

		// range. Create a range spanning over the entire root content:
			const range = editor.editing.view.createRangeIn( root );

		// Iterate over all items in this range:
			for ( const value of range.getWalker({ ignoreElementEnd: true }) ) {

				const item = value.item

				// ignore non image elements
					if(item.name !== 'img' && item.name !== 'reference') {
						continue
					}

				// attributes. Get an object map like:
				// {
				//   attributes : {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
				//	 classes : ['index']
				// }
				// when the tag is a img get his parent (the span with the attributes)
				// else get the item as reference (the attributes are into same node)
				const parent_item = (item.name === 'img') ? item.parent : item;

				const attributes = parent_item._attrs

				if(attributes && attributes.size > 0) {

					const tag_attributes = {
						type	: attributes.get('data-type'),
						tag_id	: attributes.get('data-tag_id'),
						state	: attributes.get('data-state'),
						label	: attributes.get('data-label'),
						data	: attributes.get('data-data')

					}
					if(tag_attributes.type===type && tag_attributes.tag_id===tag_id) {
						return tag_attributes
					}
				}
			}//end for ( const value of range.getWalker({ ignoreElementEnd: true }) )

		return null
	}//end get_pair_tag



	/**
	* UPDATE_TAG
	* Find and change target tag in editor
	*
	* Locates one or more imageInline model nodes that match tag_id and any of
	* the types in options.type, then merges new_data_obj properties onto each
	* matched node's attribute set.  Callers pass only the properties that
	* changed; unchanged properties are preserved from the current node state.
	*
	* Special handling for 'data' property: the raw data value is passed through
	* self.caller.tag_data_object_to_string() to produce the stringified form
	* expected in the model attribute.
	*
	* After updating attributes, the method rebuilds the tag's 'src' attribute
	* (the image URL used by the custom dedalo_tags plugin to render the visual
	* tag icon).  The URL is constructed as: <base_url>?id=<new_id> where
	* new_id comes from self.caller.build_view_tag_obj().
	*
	* The loop breaks once all expected type matches have been found (counter
	* `changed` reaches ar_type.length), preventing unnecessary full traversal.
	*
	* @param {Object} options
	* @param {string|Array} options.type         - Tag type(s) to match
	* @param {string|number} options.tag_id      - Tag numeric ID to match (loose equality)
	* @param {Object} options.new_data_obj       - Properties to set/overwrite; values must be
	*   their native types (not JSON-stringified). Special key 'data' is stringified internally.
	* @returns {Promise<boolean>} Resolves to true after all updates are applied
	*/
	this.update_tag = function(options) {

		// options
			const type			= options.type
			const tag_id		= options.tag_id
			const new_data_obj	= options.new_data_obj // all properties need to be his type (object, string, etc) do not send stringify properties

		// short vars
			const self		= this
			const editor	= self.editor
			const ar_type	= (type instanceof Array)
				? type
				: [type]
			let changed = 0

		return new Promise(function(resolve) {

			// root. Whole editor document to traverse
				const root = editor.model.document.getRoot();

			// range. Create a range spanning over the entire root content:
				const range = editor.model.createRangeIn( root );

			// Iterate over all items in this range:
				for ( const value of range.getWalker({ ignoreElementEnd: true }) ) {

					const item = value.item

					// attributes. Get an object like:
					// {
					//   attributes : {data: '', label: 'label in 1', state: 'r', tag_id: '1', type: 'indexIn', …}
					//	 classes : ['index']
					// }
					const attributes = item._attrs

					if(attributes && attributes.size > 0) {

						const current_type		= attributes.get('type')
						const current_tag_id	= attributes.get('tag_id')

						if(current_tag_id==tag_id && ar_type.includes(current_type)) {

							// short vars
								const current_state	= attributes.get('state')
								const current_label	= attributes.get('label')
								const current_data	= attributes.get('data')
								const current_src	= item.getAttribute('src')

							// edit_attributes. Clone attributes to prevent unwanted events trigger
								const edit_attributes = clone(attributes)

							// add/replace new_data_obj properties given
								for (const name in new_data_obj) {

									const current_value = name==='data'
										? self.caller.tag_data_object_to_string(new_data_obj[name])
										: new_data_obj[name]

									edit_attributes.set(name, current_value)
								}

							// id. Re-create the id like [/index-n-1-label in 1]
								const data_tag = {
									type	: current_type, // type
									tag_id	: current_tag_id, // tag_id
									state	: new_data_obj.state || current_state, // state
									label 	: new_data_obj.label || current_label, // label
									data	: new_data_obj.data || current_data // data
								}
								const new_tag	= self.caller.build_view_tag_obj( data_tag, current_tag_id )
								const new_id	= new_tag.id
								edit_attributes.set('src_id' , new_id)

							// set to model
								editor.model.change( writer => {
									writer.setAttributes( edit_attributes, item );
									if(data_tag.type !=='reference'){
										// image_url. Replace url var id with updated id tag
										const image_url = current_src.split('?')[0] + '?id=' + new_id
										writer.setAttribute( 'src', image_url, item );
									}
								});

							// set dirty state
								self.set_dirty(true)

							// changed
								changed++;

							// if the tag was found break the loop
								if (ar_type.length===changed) {
									break;
								}
						}
					}
				}//end for( const value of range.getWalker({ ignoreElementEnd: true }) )

			resolve(true)
		})
	}//end update_tag



	/**
	* SET_DIRTY
	* Mark the editor as having unsaved changes and notify the caller.
	*
	* When value is true, sets self.is_dirty and calls
	* self.caller.update_changed_data() so that the parent component_text_area
	* can enable the Save button and/or trigger auto-save logic.
	*
	* Passing false is accepted but is a no-op beyond setting is_dirty; the
	* component is not notified about a clean state through this path (clean
	* state is managed externally, e.g. after save() completes).
	*
	* @param {boolean} value - true to mark dirty and notify caller; false is accepted but does not notify
	* @returns {boolean} false on type error, true on success
	*/
	this.set_dirty = function(value) {

		const self = this

		// check value type
			if (typeof value !== 'boolean') {
				console.error("Error. Invalid value type. expected boolean: ", typeof value);
				return false
			}

		// true case
			if (value===true) {
				self.is_dirty = true
				// is_data_changed
				self.caller.update_changed_data({
					text_editor	: self,
					key			: self.key
				})
			}

		return true
	}//end set_dirty



	/**
	* BUILD_TOOLBAR
	* 	Render all toolbar buttons from editor_config
	*
	* Iterates editor_config.toolbar (an ordered array of button name strings)
	* and for each entry looks up the corresponding definition object in
	* editor_config.custom_buttons.  Creates the DOM button node via
	* render_button() (from render_text_editor.js), then:
	*   • Stores the node back onto button_config.node for later reference.
	*   • If button_config.manager_editor is true, wires the button to the
	*     CKEditor command system via factory_events_for_buttons() so that
	*     active/disabled state is synced with the editor command state.
	*   • Appends the node to toolbar_container.
	* Attaches a mousedown listener on toolbar_container that prevents default
	* and stops propagation so toolbar clicks do not blur the editor.
	*
	* Buttons without a matching definition in custom_buttons are logged as
	* a warning and skipped.
	*
	* @param {Object} editor_config
	* @param {string[]} editor_config.toolbar       - Ordered list of button name strings
	* @param {Object[]} editor_config.custom_buttons - Button definition objects with
	*   {name, manager_editor, options:{tooltip, image, onclick, class_name}}
	* @returns {HTMLElement} The populated toolbar_container element
	*/
	this.build_toolbar = function(editor_config) {

		const self = this
		const editor = self.editor

		const toolbar_container = self.toolbar_container

		// editor config vars
			// toolbar array with the order of the buttons like:
			// ['bold','italic','underline','|','undo','redo']
			const toolbar = editor_config.toolbar
			// custom_buttons array of the buttons objects with the own configuration
			const custom_buttons = editor_config.custom_buttons

			const toolbar_length = toolbar.length
			for (let i = 0; i < toolbar_length; i++) {

				const toolbar_item = toolbar[i]

				const button_config = custom_buttons.find(el => el.name === toolbar_item)
				if(!button_config){
					console.warn("Button object definition doesn't exist:", toolbar_item);
					continue
				}
				// create the node in the text_area render (common for all text_editors tinny, ckeditor, etc.)
				const button_node	= render_button(button_config)
				button_config.node	= button_node
				// when the button need to be processed by the editor, use the factory
				if(button_config.manager_editor === true){
					self.factory_events_for_buttons(button_config)
				}

				toolbar_container.appendChild(button_node)

				toolbar_container.addEventListener('mousedown', function(evt){
					evt.preventDefault()
					evt.stopPropagation()
				})
			}

		// toolbar toggle event
			// // show toolbar_container on user mousedown
			// // removes the toolbar_container when user click outside
			// const node = toolbar_container.parentNode
			// node.addEventListener("mousedown", function() {
			// 	// remove the hide class to show the toolbar
			// 	toolbar_container.classList.remove('hide')
			// 	document.body.addEventListener("mouseup", fn_remove)
			// })
			// function fn_remove(e) {
			// 	if (e.target!==node) {
			// 		const path	= e.composedPath()
			// 		const found	= path.find(el => el===node)
			// 		if (!found) {
			// 			toolbar_container.classList.add('hide')
			// 			document.body.removeEventListener("mouseup", fn_remove)
			// 		}
			// 	}
			// }

		return toolbar_container
	}//end this.build_toolbar



	/**
	* FACTORY_EVENTS_FOR_BUTTONS
	* @param {Object} button_obj - Button definition object created at the caller's render phase
	*   (see render_edit_component_text_area.js get_custom_buttons)
	* Like
	* {
	*	name			: "button_geo",
	*	manager_editor	: false,
	*	options	: {
	*		tooltip	: 'Add georef',
	*		image	: '../../core/themes/default/icons/geo.svg',
	*		onclick	: function(evt) {
	*			event_manager.publish('create_geo_tag_'+ self.id_base, {
	*				caller		: self,
	*				text_editor	: text_editor
	*			})
	*		}
	*	}
	* }
	*
	* Wires a button DOM node (button_obj.node) to its corresponding CKEditor
	* command or special handler.  Three cases are handled:
	*
	*   'html_source'    — toggles SourceEditing plugin mode directly (no
	*                      CKEditor command; accessed via the plugin instance).
	*   'find_and_replace' — calls render_find_and_replace(editor) which opens
	*                      the CKEditor find/replace dialog.
	*   all other names — retrieved via editor.commands.get(name) and bound to
	*                     editor.execute(name) on click.  Additionally:
	*                     • Listens to 'change:value' on the command (except
	*                       'undo'/'redo') to toggle an 'active' CSS class.
	*                     • Listens to 'change:isEnabled' to toggle a 'disable'
	*                       CSS class, reflecting whether the command can be
	*                       executed in the current editor context.
	*
	* (!) The mousedown prevention on the toolbar_container (set in build_toolbar)
	* prevents focus loss when clicking buttons, which is why click listeners
	* here do not need to call e.preventDefault().
	*
	* @returns {boolean|undefined} true for command-backed buttons; undefined
	*   (implicit return) for html_source and find_and_replace early-return paths
	*/
	this.factory_events_for_buttons = function(button_obj) {

		const self = this
		const editor = self.editor

		const name		= button_obj.name
		const button	= button_obj.node

		// html_source case. Editing the html_souece button doesn't has command, call it by the state of the plug-ing
			if(name==='html_source') {
				// Clicking the buttons should execute the editor command...
				button.addEventListener('click', function(){
					const state = editor.plugins.get( 'SourceEditing' ).isSourceEditingMode
					editor.plugins.get( 'SourceEditing' ).isSourceEditingMode = !state
				})
				return
			}

		// find_and_replace case
			if(name==='find_and_replace') {
				button.addEventListener('click', function(){
					render_find_and_replace(editor)
				})
				return
			}

		// command. Retrieve the editor command corresponding with the ID of the button in the DOM.
			const command = editor.commands.get( name );

		// Clicking the buttons should execute the editor command...
			button.addEventListener('click', function(){
				editor.execute( name )
				editor.editing.view.focus();
			})

		// ...but it should not steal the focus so the editing is uninterrupted.
			const onValueChange = () => {
				if(command.value){
					button.classList.add('active')
				}else{
					button.classList.remove('active')
				}
			};
			editor.listenTo( command, 'change:value', (evt)=>{
				if ( !new Set( [ 'undo', 'redo' ] ).has( name ) ) {
					onValueChange();
				}
			})

		// change the state of the button if the command is not enable
			const onIsEnabledChange = () => {

				if(!command.isEnabled){
					button.classList.add('disable')
				}else{
					button.classList.remove('disable')
				}
			};
			editor.listenTo( command, 'change:isEnabled', (evt)=>{
				onIsEnabledChange()
			})


		return true
	}//end factory_events_for_buttons



	/**
	* _GETVALUEFROMFIRSTALLOWEDNODE
	* Checks the attribute value of the first node in the selection that allows the attribute.
	* For the collapsed selection returns the selection attribute.
	*
	* This is a helper ported from the CKEditor 5 LinkEditing plugin pattern to
	* support the custom 'reference' attribute command.  It mirrors the internal
	* _getValueFromFirstAllowedNode logic used by CKEditor's AttributeCommand.
	*
	* @private
	* @returns {boolean} True when the first schema-allowed node has the attribute;
	*   false when no such node is found or when the selection is not collapsed
	*   and none of the items in the ranges allow the attribute
	*/
	this._getValueFromFirstAllowedNode = function() {

		const model		= this.editor.model;
		const schema	= model.schema;
		const selection	= model.document.selection;

		if ( selection.isCollapsed ) {
			return selection.hasAttribute( this.attributeKey );
		}

		for ( const range of selection.getRanges() ) {
			for ( const item of range.getItems() ) {
				if ( schema.checkAttribute( item, this.attributeKey ) ) {
					return item.hasAttribute( this.attributeKey );
				}
			}
		}

		return false;
	}//end _getValueFromFirstAllowedNode



	/**
	* GET_SELECTED_REFERENCE_ELEMENT
	* Returns the link {@link module:engine/view/attributeelement~AttributeElement} under
	* the {@link module:engine/view/document~Document editing view's} selection or `null`
	* if there is none.
	*
	* **Note**: For a non–collapsed selection, the link element is returned when **fully**
	* selected and the **only** element within the selection boundaries, or when
	* a linked widget is selected.
	*
	* Returns the 'reference' attribute value (the tag_obj) for the currently
	* selected reference element, or undefined when no reference is active.
	* The 'reference_editing' CKEditor plugin (custom Dédalo plug-in in
	* plug-ins/reference/) is used to call its findAttributeRange helper to
	* locate the element.
	*
	* Two resolution paths:
	*   1. Selected block element is schema-referable → getAttribute('reference')
	*      from the element.
	*   2. Otherwise → getAttribute('reference') from the current selection
	*      (text run with reference attribute).
	*
	* @private
	* @returns {Object|undefined} The reference tag_obj, or undefined if none selected
	*/
	this.get_selected_reference_element = function() {

		const self		= this
		const editor	= self.editor

		const model		= editor.model;
		const selection	= model.document.selection;

		// get the reference_editing plug-ing to get ck_funcitonalities
		const reference_editing = editor.plugins.get( 'reference_editing' )
		const selectedElement	= selection.getSelectedElement() || reference_editing.first( selection.getSelectedBlocks() );

		function is_referable_element( element, schema ) {
			if ( !element ) {
				return false;
			}
			return schema.checkAttribute( element.name, 'reference' );
		}
		// A check for any integration that allows reference elements.
		// Currently the selection reads attributes from text nodes only.
		// if ( is_referable_element( selectedElement, model.schema ) ) {
		const value = ( is_referable_element( selectedElement, model.schema ) )
				? selectedElement.getAttribute( 'reference' )
				: selection.getAttribute( 'reference' )


		return value
	}//end get_selected_reference_element



	/**
	* FIND_REFERENCE_ELEMENT_ANCESTOR
	* Returns `true` if a given view node is the reference element.
	*
	* Walks the ancestor chain from the given position to find any
	* attributeElement that has the custom property 'reference' set.
	* Used internally to determine whether a position is inside a reference
	* span when adjusting selection or performing reference operations.
	*
	* @param {Object} position - CKEditor view Position object; ancestors are
	*   obtained via position.getAncestors()
	* @returns {Object|undefined} The ancestor attributeElement with 'reference'
	*   custom property, or undefined if none found
	*/
	this.find_reference_element_ancestor = function ( position ) {

		const node = position.getAncestors()

		return node.find( ancestor =>
			ancestor.is( 'attributeElement' ) && !!ancestor.getCustomProperty( 'reference' )
		);
	}//end find_reference_element_ancestor



	/**
	* SET_REFERENCE
	* Apply or update the 'reference' model attribute on the current selection.
	*
	* Handles two distinct selection states:
	*
	*   Collapsed selection (caret):
	*     • If the caret is inside an existing reference text run (selection has
	*       'reference' attribute), updates that entire run's attribute to
	*       new_data_obj using reference_editing.findAttributeRange() to find
	*       its bounds.
	*     • If the caret is outside any reference, inserts a new text node with
	*       the reference attribute using locator_text_value as the display text.
	*     In both cases the 'reference' attribute is removed from the selection
	*     afterwards so subsequent typing does not continue inside the reference.
	*
	*   Non-collapsed selection:
	*     • Retrieves valid ranges via schema.getValidRanges() and also checks
	*       selected block elements that allow the 'reference' attribute.
	*     • Applies writer.setAttribute('reference', new_data_obj, range) to all
	*       applicable ranges.
	*
	* @param {Object} options
	* @param {Object} options.new_data_obj          - Reference tag object to set as the attribute value.
	*   All properties must be their native types (not stringified).
	* @param {string} options.locator_text_value    - Text string inserted as the visible reference
	*   label when creating a new reference on a collapsed selection
	* @returns {void}
	*/
	this.set_reference = function(options) {

		const self		= this
		const editor	= self.editor

		const new_data_obj			= options.new_data_obj // all properties need to be his type (object, string, etc) do not send stringify properties
		const locator_text_value	= options.locator_text_value

		const model		= editor.model;
		const selection	= model.document.selection;
		// get the reference_editing plugin to get ck_funcitonalities
		const reference_editing = editor.plugins.get( 'reference_editing' )

		model.change( writer => {
			// If selection is collapsed then update selected link or insert new one at the place of caret.
			if ( selection.isCollapsed ) {
				const position = selection.getFirstPosition();

				// When selection is inside text with `reference` attribute.
				if ( selection.hasAttribute( 'reference' ) ) {
					// Then update `reference` value.
					const reference_range = reference_editing.findAttributeRange( position, 'reference', selection.getAttribute( 'reference' ), model );

					writer.setAttribute( 'reference', new_data_obj, reference_range );

					// Put the selection at the end of the updated link.
					writer.setSelection( writer.createPositionAfter( reference_range.end.nodeBefore ) );
				}
				// If not then insert text node with `reference` attribute in place of caret.
				// However, since selection is collapsed, attribute value will be used as data for text node.
				else {
					const attributes = new Map( selection.getAttributes() );

					attributes.set( 'reference', new_data_obj );

					const { end: positionAfter } = model.insertContent( writer.createText( locator_text_value, attributes ), position );

					// Put the selection at the end of the inserted link.
					// Using end of range returned from insertContent in case nodes with the same attributes got merged.
					writer.setSelection( positionAfter );
				}

				// Remove the `reference` attribute and all link decorators from the selection.
				// It stops adding a new content into the link element.
				// [ 'reference', ...truthyManualDecorators, ...falsyManualDecorators ].forEach( item => {
				writer.removeSelectionAttribute( 'reference' );
				// } );
			}else{
				// If selection has non-collapsed ranges, we change attribute on nodes inside those ranges
				// omitting nodes where the `reference` attribute is disallowed.
				const ranges = model.schema.getValidRanges( selection.getRanges(), 'reference' );

				// But for the first, check whether the `reference` attribute is allowed on selected blocks (e.g. the "image" element).
				const allowedRanges = [];

				for ( const element of selection.getSelectedBlocks() ) {
					if ( model.schema.checkAttribute( element, 'reference' ) ) {
						allowedRanges.push( writer.createRangeOn( element ) );
					}
				}

				// Ranges that accept the `reference` attribute. Since we will iterate over `allowedRanges`, let's clone it.
				const rangesToUpdate = allowedRanges.slice();

				const is_range_to_update = function( range, allowedRanges ) {
					for ( const allowedRange of allowedRanges ) {
						// A range is inside an element that will have the `reference` attribute. Do not modify its nodes.
						if ( allowedRange.containsRange( range ) ) {
							return false;
						}
					}
					return true;
				}

				// For all selection ranges we want to check whether given range is inside an element that accepts the `reference` attribute.
				// If so, we don't want to propagate applying the attribute to its children.
				for ( const range of ranges ) {
					if ( is_range_to_update( range, allowedRanges ) ) {
						rangesToUpdate.push( range );
					}
				}

				for ( const range of rangesToUpdate ) {
					writer.setAttribute( 'reference', new_data_obj, range );
				}
			}
		});
	}//end set_reference



	/**
	* REMOVE_REFERENCE
	* Remove the 'reference' model attribute from the current selection.
	*
	* Collapsed selection: uses reference_editing.findAttributeRange() to
	* determine the full extent of the reference run at the caret position,
	* then removes the 'reference' attribute from that entire range.
	*
	* Non-collapsed selection: uses schema.getValidRanges() to find all
	* text nodes within the selection that allow the 'reference' attribute,
	* and removes it from each.
	*
	* @returns {void}
	*/
	this.remove_reference = function() {

		const self		= this
		const editor	= self.editor
		const model		= editor.model;
		const selection	= model.document.selection;

		// get the reference_editing plugin to get ck_funcitonalities
		const reference_editing = editor.plugins.get( 'reference_editing' )

		model.change( writer => {
			// Get ranges to unlink.
			const ranges_to_remove = selection.isCollapsed ?
				[ reference_editing.findAttributeRange(
					selection.getFirstPosition(),
					'reference',
					selection.getAttribute( 'reference' ),
					model
				) ] :
				model.schema.getValidRanges( selection.getRanges(), 'reference' );

			// Remove `reference` attribute from specified ranges.
			for ( const range of ranges_to_remove ) {
				writer.removeAttribute( 'reference', range );
			}
		});
	}//end remove_reference



	/**
	* GET_SELECTED_TAG
	* get the tag object that was selected
	*
	* Returns a unified tag_obj regardless of whether the selection is a
	* reference text run or an imageInline element:
	*
	*   reference: the 'reference' attribute value on the selection is the
	*   tag_obj directly.
	*
	*   imageInline (draw, geo, tc, indexIn/Out, etc.): the model element is
	*   obtained via selection.getSelectedElement() and its individual model
	*   attributes (type, tag_id, state, label, data) are assembled into a
	*   plain object.
	*
	* Returns false when there is neither a reference in the selection nor a
	* selected element (i.e. the user has a text cursor or text range without
	* a tag).
	*
	* @returns {Object|false} tag_obj with {type, tag_id, state, label, data},
	*   or false if no tag is selected
	*/
	this.get_selected_tag = function() {

		const self = this
		// get the editor
		const editor = self.editor
		if (!editor) {
			return false
		}

		// get the user selection
		const selection = editor.editing.model.document.selection;
		// references can be checked directly with the selection, as they are text
		const has_reference = selection.hasAttribute( 'reference' )
		// other tags as draw, geo,... are images and
		// they need to get the selected element instead the selection
		const element = selection.getSelectedElement()

		// if the selection has not references or element, as text selection
		// stop the process and return false
		if(!has_reference && !element){
			return false
		}
		// get the tag object
		// when the selected is a reference get from selection
		// otherwise use the element to get the attributes.
		const tag_obj =  has_reference
			? selection.getAttribute( 'reference' )
			: {
				type		: element.getAttribute('type'),
				tag_id		: element.getAttribute('tag_id'),
				state		: element.getAttribute('state'),
				label		: element.getAttribute('label'),
				data		: element.getAttribute('data')
			 }

		return tag_obj
	}//end get_selected_tag



	/**
	* FOCUS
	* Focus editor and set pointer to the end of text
	*
	* Moves the model selection to the end of the root document node, then
	* calls editorInstance.editing.view.focus() to transfer browser focus to
	* the CKEditor editable area.  Both steps are performed inside a single
	* model.change() batch so they execute as one undoable transaction.
	*
	* (!) The warning message 'Editor is available' is a pre-existing typo in
	* the source; the intent is 'Editor is NOT available'. Do not change.
	*
	* @returns {void}
	*/
	this.focus = function() {

		const editorInstance = this.editor
		if (!editorInstance) {
			console.warn('Editor is available', this);
			return
		}

		editorInstance.model.change( writer => {
			writer.setSelection( writer.createPositionAt( editorInstance.model.document.getRoot(), 'end' ));
			editorInstance.editing.view.focus();
		});
	}//end focus



	/**
	* DESTROY
	* Asynchronously destroys the editor instance if it exists.
	* Sets the 'this.editor' property to null after destruction.
	* @returns {Promise<void>}
	* 	A Promise that resolves when the editor is destroyed (or immediately if no editor exists).
	*/
	this.destroy = async function() {
		// Check if an editor instance exists
		if (this.editor) {
			try {
				// Asynchronously call the editor's destroy method
				await this.editor.destroy();
				// If destruction is successful, set the editor reference to null
				this.editor = null;
			} catch (error) {
				// Catch any errors that occur during the editor's destroy process
				console.error('Error destroying editor:', error);
			}
		} else {
			// If no editor exists, log a message for debugging
			if(SHOW_DEBUG===true) {
				console.warn('No editor instance to destroy.');
			}
		}
	}// end destroy



}//end service_ckeditor



// @license-end
