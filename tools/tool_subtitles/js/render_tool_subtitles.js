// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {keyboard_codes} from '../../../core/common/js/utils/keyboard.js'
	import {prepend_bubble, render_node_info} from '../../../core/common/js/utils/notifications.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'



/**
* RENDER_TOOL_SUBTITLES
* DOM-rendering layer for the tool_subtitles subtitle editor.
*
* This module is the visual half of the tool_subtitles pair (the other half is
* tool_subtitles.js, which carries the constructor, prototype chain, and API
* calls).  Every exported or module-level function here is concerned exclusively
* with building and wiring browser DOM — no network requests and no data
* mutations happen in this file.
*
* Layout produced by edit():
*
*   ┌─ tool wrapper (ui.tool.build_wrapper_edit) ───────────────────────────┐
*   │  header: [lang selector] [tool_tm button]  [activity-info panel]      │
*   │  ┌──────────────────────┬────────────────────────────────────────────┐ │
*   │  │  left_container      │  right_container                           │ │
*   │  │  (subtitle list)     │  media player (component_av / other)       │ │
*   │  │  ↳ render_subtitles  │  [component_av only:]                      │ │
*   │  │    ↳ per-item        │    playback-speed slider                   │ │
*   │  │      CKEditor        │    keyboard-shortcut controls              │ │
*   │  │      instances       │    subtitle-build block                    │ │
*   │  └──────────────────────┴────────────────────────────────────────────┘ │
*   └───────────────────────────────────────────────────────────────────────┘
*
* Subtitle data model (self.ar_value):
*   Each entry is an object with at least { type, value }. Two types exist:
*     'tc'   — a timecode marker (e.g. "00:01:23.456"); rendered as a
*              contenteditable <div class="tc">.
*     'text' — a rich-text subtitle segment; rendered inside a CKEditor
*              instance (service_ckeditor) so the user can apply bold /
*              italic / underline inline markup.
*
* User preferences (keyboard shortcut keys and numeric durations) are persisted
* in localStorage under the keys 'av_playpause_key', 'av_rewind_secs',
* 'tag_insert_key', and 'subtitles_characters_per_line'.  These are read on
* each edit() call and written back by change/keyup listeners.
*
* Exported symbols:
*   render_tool_subtitles — constructor (empty shell; methods added on its
*                           prototype so tool_subtitles.js can mixin via
*                           `tool_subtitles.prototype.edit = render_tool_subtitles.prototype.edit`)
*
* Related files:
*   tool_subtitles.js          — constructor + data/API methods
*   index.js                   — barrel re-export
*   css/tool_subtitles.less    — visual styles for this layout
*/
export const render_tool_subtitles = function() {

	return true
}//end render_tool_subtitles



/**
* EDIT
* Builds and returns the full edit-mode DOM wrapper for the subtitles tool.
*
* Delegates heavy lifting to the private helpers:
*   • get_content_data_edit  — builds left (subtitle list) and right (player)
*                              columns; wires CKEditor per subtitle segment.
*   • render_subtitles_options — builds the language selector and optional
*                               tool_time_machine button placed in the header.
*   • render_activity_info   — builds the save-status notification strip in
*                              the header activity slot.
*
* When options.render_level === 'content' the function returns the raw
* content_data node without the outer wrapper shell.  This allows partial
* refresh of just the subtitle list (e.g. after a lang change) without
* re-building the entire tool frame.
*
* @param {Object} [options={}] - Render options.
* @param {string} [options.render_level='full'] - 'full' returns the complete
*   wrapper; 'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} The tool wrapper element (render_level 'full')
*   or the inner content_data element (render_level 'content').
*/
render_tool_subtitles.prototype.edit = async function(options={render_level:'full'}) {

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
		const tanscription_options = await render_subtitles_options(self, content_data)
		wrapper.tool_buttons_container.appendChild(tanscription_options)

	// render_activity_info are the information of the activity as "Save"
		const activity_info = render_activity_info(self)
		wrapper.activity_info_container.appendChild(activity_info)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Constructs the two-column content area that is the body of the edit view.
*
* Left column (left_container):
*   Populated asynchronously by render_subtitles(), which iterates self.ar_value
*   and emits either a contenteditable 'tc' node or a CKEditor-backed
*   'text' container per subtitle segment.  The reference is stored on
*   content_data.left_container so the lang-selector action in
*   render_subtitles_options() can clear and re-populate it without touching
*   the right column.
*
* Right column (right_container):
*   Always contains the rendered media_component (component_av or another
*   supported model) in player mode.
*
*   For component_av specifically, three additional UI blocks are appended:
*     1. Playback-speed slider (range 0–2, step 0.1; calls
*        media_component.set_playback_rate() on change).
*     2. Keyboard-shortcut control panel — lets the user configure:
*          • Play/pause key: any keyboard key, persisted in localStorage as
*            'av_playpause_key'; pushed into
*            component_text_area.context.features.av_player.av_play_pause_code.
*          • Auto-rewind duration in seconds, persisted as 'av_rewind_secs';
*            pushed into
*            component_text_area.context.features.av_player.av_rewind_seconds.
*          • Tag-insert key: persisted as 'tag_insert_key'; pushed into
*            component_text_area.context.features.av_player.av_insert_tc_code.
*     3. Subtitle-build block — contains the "Build subtitles" button and a
*        "characters per line" input (persisted as
*        'subtitles_characters_per_line'; default 90).
*
* The function does NOT await the render_subtitles Promise; the subtitle list
* is appended asynchronously via .then().  This means left_container may be
* temporarily empty while media player setup proceeds.
*
* @param {Object} self - The tool_subtitles instance.
* @returns {Promise<HTMLElement>} The content_data wrapper node, enriched with
*   two custom properties: .left_container and .right_container.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// left_container
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'left_container',
			parent			: fragment
		})

	// create the nodes for the subtitles
		const subtitles_nodes = render_subtitles(self)
		.then(function(node){
			left_container.appendChild(node)
		})

	// component_text_area.component caller
		const component_text_area = self.caller

		// component_text_area.render()
		// .then(function(node){
		// 	left_container.appendChild(node)
		// })

	// right_container
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'right_container',
			parent 			: fragment
		})

	// media_component
		self.media_component.mode = 'player'
		await self.media_component.build(true)
		const media_component_node = await self.media_component.render();
		right_container.appendChild(media_component_node)

	// component_av specifics
		if (self.media_component.model==='component_av') {
			// slider for control audiovisual speed
				const slider_container = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'slider_container',
					parent 			: right_container
				})
				const slider_label = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'slider_label',
					inner_html 		: self.get_tool_label('play_speed') || 'Play speed',
					parent 			: slider_container
				})
				const slider = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'slider',
					parent 			: slider_container
				})
					const output = ui.create_dom_element({
						element_type	: 'output',
						class_name		: 'speed_range_value',
						parent			: slider,
						value 			: 1
					})
					const range = ui.create_dom_element({
						element_type	: 'input',
						class_name 		: 'slider',
						type 			: 'range',
						parent 			: slider
					})
					range.value = output.value
					range.min = 0
					range.max = 2
					range.step = 0.1
					range.addEventListener('change', function(){
						output.value = range.value
						self.media_component.set_playback_rate(range.value)
					})

			// Inputs options for keyboard control and rewind controls
				const transcription_keys = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'transcription_keys',
					parent 			: right_container
				})
				// play / pause key used to stop and rewind the video, it change the text_area default key to the users specify
					const playpause_key = ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'playpause_key',
						parent 			: transcription_keys
					})
						const playpause_key_label = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'label',
							inner_html		: self.get_tool_label('play_pause_key') || 'Play/pause key',
							parent			: playpause_key
						})
						const playpause_key_input = ui.create_dom_element({
							element_type	: 'input',
							type 			: 'text',
							parent 			: playpause_key
						})
						// get the cookie of the key
						const av_playpause_key_value = localStorage.getItem('av_playpause_key')

						const av_playpause_keyboard_code									= av_playpause_key_value ? av_playpause_key_value : 'Escape' // Default 'Escape'
						// get the user friendly name of the key code based in specific object imported form /common/utils/js/keyborad.js
						const av_playpause_keyboard_key										= keyboard_codes[av_playpause_keyboard_code]
						component_text_area.context.features.av_player.av_play_pause_code	= av_playpause_keyboard_code
						playpause_key_input.value											= av_playpause_keyboard_key

						playpause_key_input.addEventListener('keyup', function(event){
							const keyborard_code					= event.code
							const keyborard_key						= event.key
							// set the cookie of the key
							localStorage.setItem('av_playpause_key', keyborard_code);
							playpause_key_input.value									= keyborard_key
							component_text_area.context.features.av_player.av_play_pause_code	= keyborard_code
						})
					// rewind value is the time that the av rewind when is paused by the play/pause key
					// it change the text_area default rewind time to the user has specify
					const av_rewind_secs = ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'av_rewind_secs',
						parent 			: transcription_keys
					})
						const av_rewind_secs_label = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'label',
							inner_html		: self.get_tool_label('auto_rewind') || 'Auto-rewind',
							parent			: av_rewind_secs
						})
						const av_rewind_secs_input = ui.create_dom_element({
							element_type	: 'input',
							type 			: 'text',
							parent 			: av_rewind_secs
						})
						const av_rewind_secs_name = ui.create_dom_element({
							element_type	: 'span',
							parent 			: av_rewind_secs,
							inner_html		: self.get_tool_label('seconds_abbr') || 'sec/s.'
						})
						// get the cookie of the key
						const av_rewind_secs_value = localStorage.getItem('av_rewind_secs')
						const secs_val  = av_rewind_secs_value ? av_rewind_secs_value : 3; // Default 3 sec

						// Set value from cookie or default
						av_rewind_secs_input.value				= secs_val
						component_text_area.context.features.av_player.av_rewind_seconds	= secs_val

						av_rewind_secs_input.addEventListener('change', function(event){
							// if the key pressed is not a number use the default
							const value = parseInt(event.target.value)
								? parseInt(event.target.value)
								: 3
							// set the cookie of the key
							localStorage.setItem('av_rewind_secs', value);
							av_rewind_secs_input.value				= value
							component_text_area.context.features.av_player.av_rewind_seconds	= value
						})

					// tag key is used to get the tc from av and insert the tag in the text_area
					// the user could change the default key "f2" to other key
					// it change the text_area default key to the users specify
					const tag_insert_key = ui.create_dom_element({
						element_type	: 'span',
						class_name 		: 'tag_insert_key',
						parent 			: transcription_keys
					})
						const tag_insert_key_label = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'label',
							inner_html		: get_label.insert_tag || 'Insert tag',
							parent			: tag_insert_key
						})
						const tag_insert_key_input = ui.create_dom_element({
							element_type	: 'input',
							type 			: 'text',
							parent 			: tag_insert_key
						})
						// get the cookie of the key
						const tag_insert_key_value = localStorage.getItem('tag_insert_key')

						const tag_insert_keyboard_code			= tag_insert_key_value ? tag_insert_key_value : 'F2' // Default 'F2'
						// get the user friendly name of the key code based in specific object imported form /common/utils/js/keyborad.js
						const tag_insert_keyboard_key			= keyboard_codes[tag_insert_keyboard_code]
						tag_insert_key_input.value				= tag_insert_keyboard_key
						component_text_area.context.features.av_player.av_insert_tc_code	= tag_insert_keyboard_code

						tag_insert_key_input.addEventListener('keyup', function(event){
							const keyborard_code					= event.code
							const keyborard_key						= event.key
							// set the cookie of the key
							localStorage.setItem('tag_insert_key', keyborard_code);
							tag_insert_key_input.value				= keyborard_key
							component_text_area.context.features.av_player.av_insert_tc_code	= keyborard_code
						})

			// subtitles_block
				const subtitles_block = ui.create_dom_element({
					element_type	: 'div',
					class_name 		: 'subtitles_block',
					parent 			: right_container
				})

				// button_build_subtitles
					ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'light btn_subtitles',
						inner_html		: self.get_tool_label('build_subtitles') || 'Build subtitles',
						parent			: subtitles_block
					})

				// input characters per line
					const input_characters_per_line = ui.create_dom_element({
						element_type	: 'input',
						type			: 'text',
						parent			: subtitles_block
					})

				// label_characters_per_line
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'label',
						inner_html		: get_label.characters_per_line || 'Characters per line',
						parent			: subtitles_block
					})

				// get the cookie of the key
					const subtitles_characters_value = localStorage.getItem('subtitles_characters_per_line')
					const chatacters_val  = subtitles_characters_value ? subtitles_characters_value : 90; // Default 90 sec

					// Set value from cookie or default
					input_characters_per_line.value				= chatacters_val
					// component_text_area.av_rewind_seconds	= chatacters_val

					input_characters_per_line.addEventListener('change', function(event){
						// if the key pressed is not a number use the default
						const value = parseInt(event.target.value)
							? parseInt(event.target.value)
							: 90
						// set the cookie of the key
						localStorage.setItem('subtitles_characters_per_line', value);
						input_characters_per_line.value				= value
						// component_text_area.av_rewind_seconds	= value
					})
		}//end if (self.media_component.model==='component_av') {

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)
		// save the pointers of the content_data nodes, to used by the buttons to access to the components
		content_data.left_container		= left_container
		content_data.right_container	= right_container


	return content_data
}//end get_content_data_edit



/**
* RENDER_SUBTITLES_OPTIONS
* Builds the optional header controls placed in the tool's tool_buttons_container.
*
* Two widgets are produced:
*
*   1. Language selector (<div class="lang_selector">):
*      Built with ui.build_select_lang().  When the user picks a new lang the
*      action callback:
*        a. calls self.get_subtitles_data(newLang) to reload self.ar_value for
*           the chosen language,
*        b. sets self.lang,
*        c. calls render_subtitles(self) and replaces all children of
*           content_data.left_container with the new subtitle list.
*      The content_data reference is captured via closure; this is why the caller
*      (edit()) must pass it here — the lang selector and the subtitle list share
*      a DOM pointer so the swap is surgical and does not touch the right column.
*
*   2. Tool Time Machine button (conditional):
*      Present only when the user has access to tool_time_machine (queried via
*      self.get_user_tools()).  On click, delegates to open_tool() from
*      tool_common, passing the caller (the transcription component) as context.
*
* @param {Object} self - The tool_subtitles instance.
* @param {HTMLElement} content_data - The content_data node returned by
*   get_content_data_edit(), used by the lang selector action to target
*   content_data.left_container for subtitle list swaps.
* @returns {Promise<DocumentFragment>} Fragment containing the lang selector
*   (always) and the tool_tm button (when accessible).
*/
const render_subtitles_options = async function(self, content_data) {

	const fragment = new DocumentFragment()

	// lang selector
		const lang_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'lang_selector',
			parent			: fragment
		})
		const lang_label = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'lang_label',
			inner_html 		: get_label.language || 'Language',
			parent 			: lang_container
		})
		// the lang selector use the content_data pointer .left_container to remove the transcription text_area and rebuild the new node
		const lang_selector = ui.build_select_lang({
			id			: "index_lang_selector",
			selected	: self.lang,
			class_name	: 'dd_input',
			action		: async function(e){
				// create new one
				await self.get_subtitles_data(e.target.value)
				self.lang = e.target.value
				render_subtitles(self).then(function(node){
					// remove previous nodes
					while (content_data.left_container.lastChild) {//} && content_data.left_container.lastChild.id!==lang_selector.id) {
						content_data.left_container.removeChild(content_data.left_container.lastChild)
					}
					// add the new one
					content_data.left_container.appendChild(node)
				})
			}
		})
		lang_container.appendChild(lang_selector)

	// external tools
		const ar_register_tools	= await self.get_user_tools(['tool_time_machine'])
		const tool_tm			= ar_register_tools.find(el => el.name === 'tool_time_machine')


	// Button tool time machine
		if(tool_tm) {
			const tool_tm_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'tool_button tool_tm_button light',
				inner_html		: tool_tm.label || 'Tool Time machine',
				parent			: fragment
			})
			const tool_tm_icon = ui.create_dom_element({
				element_type	: 'img',
				class_name		: 'icon',
				src				: tool_tm.icon,
				parent			: tool_tm_button
			})
			tool_tm_button.prepend(tool_tm_icon)
			tool_tm_button.addEventListener('click', function(event) {
				event.stopPropagation();
				// open_tool (tool_common)
					open_tool({
						tool_context	: tool_tm,
						caller			: self.caller
					})
			})
		}

	return fragment
}//end render_subtitles_options



/**
* RENDER_ACTIVITY_INFO
* Builds a notification strip that reflects save-event outcomes in the header.
*
* Subscribes to the 'save' event published by event_manager.  Each time a save
* completes, fn_saved() renders a info node (via render_node_info) and prepends
* it to activity_info_body so the most-recent notification appears at the top.
*
* The event subscription token is pushed onto self.events_tokens so the common
* destroy() lifecycle can unsubscribe it when the tool is torn down.
*
* @param {Object} self - The tool_subtitles instance; self.events_tokens must
*   be an Array (initialised in the tool_subtitles constructor).
* @returns {DocumentFragment} Fragment containing the activity_info_body element.
*/
const render_activity_info = function(self) {

	const fragment = new DocumentFragment()

	// activity alert
		const activity_info_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'activity_info_body',
			parent			: fragment
		})
		self.events_tokens.push(
			event_manager.subscribe('save', fn_saved)
		)
		function fn_saved(options){
			const node_info = render_node_info(options)
			prepend_bubble(activity_info_body, node_info)
		}


	return fragment
}//end render_activity_info




/**
* RENDER_SUBTITLES
* Iterates self.ar_value and produces one DOM node per subtitle item.
*
* Each element of self.ar_value is dispatched by its .type property:
*
*   'tc'   — Emits a contenteditable <div class="tc"> showing the raw timecode
*            string.  The user can edit the timecode directly in the browser.
*
*   'text' (default) — Emits a two-child container:
*              .toolbar_container  (hidden by default, class 'hide')
*              .value_container    (holds the raw HTML subtitle text)
*            and then calls init_current_service_text_editor() synchronously
*            (awaited) to mount a service_ckeditor instance on value_container.
*            Note: An IntersectionObserver-based lazy-init strategy is present
*            in commented-out code; it was replaced with immediate await init.
*
* The function returns a DocumentFragment containing all emitted nodes.
* After resolution, render_subtitles_options() and the lang-selector action
* both append/replace this fragment inside left_container.
*
* (!) self.ar_value must already be populated (by tool_subtitles.get_subtitles_data)
* before this function is called; an empty array produces an empty fragment
* without error.
*
* @param {Object} self - The tool_subtitles instance.  Required properties:
*   @param {Array}  self.ar_value              - Subtitle data items.
*   @param {string} self.lang                  - Current editing language code.
*   @param {Array}  self.service_text_editor_instance - Pre-sized array; entries
*     are set to the created service_ckeditor instance by index.
*   @param {Array}  self.text_editor            - Final resolved CKEditor keyed
*     by item index; set inside init_current_service_text_editor.
* @returns {Promise<DocumentFragment>} Fragment with all subtitle nodes appended.
*/
const render_subtitles = async function(self) {

	const fragment	= new DocumentFragment()
	const lang		= self.lang

	const ar_value_len = self.ar_value.length

	for (let i = 0; i < ar_value_len; i++) {
		const current_value = self.ar_value[i]

		switch (current_value.type) {
			case 'tc':

			const current_tc_node = ui.create_dom_element({
					element_type	: 'div',
					contenteditable : true,
					class_name		: current_value.type,
					inner_html		: current_value.value,
					parent			: fragment
				})

				break;
			case 'text':
			default:

				// value is a raw html without parse into nodes (txt format)
					const value = current_value.value

				// text_editor_container container
					const text_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'text_container'
					})

				// toolbar_container
					const toolbar_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'toolbar_container hide',
						parent			: text_container
					})

				// value_container
					const value_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'value_container ' +current_value.type,
						inner_html		: value,
						parent			: text_container
					})

					const options = {
						value_container		: value_container,
						toolbar_container	: toolbar_container,
						value				: value
					}

				// observer. Init the editor when container node is in DOM
				// const observer = new IntersectionObserver(function(entries) {
				// 	// if(entries[0].isIntersecting === true) {}
				// 	const entry = entries[1] || entries[0]
				// 	if (entry.isIntersecting===true || entry.intersectionRatio > 0) {
				// 		observer.disconnect();
					await init_current_service_text_editor(self, i, options)


				// 		// observer.unobserve(entry.target);
				// 	}
				// }, { threshold: [0] });
				// observer.observe(text_container);

				// const contenteditable_buttons = get_contenteditable_buttons(current_text_node)

				// InlineEditor.create( current_text_node, {} )
				// 	.then( editor => {} )
				// 	.catch( error => {
				// 		console.error( 'Oops, something went wrong! it is not possible load ckeditor' );
				// 		console.error( error );
				// 	} );

				// fragment.appendChild(contenteditable_buttons)
				fragment.appendChild(text_container)

			break;
		}

	}


	return fragment
}//end render_subtitles



/**
* INIT_CURRENT_SERVICE_TEXT_EDITOR
* Instantiates and initialises a service_ckeditor for one subtitle text segment.
*
* This function is the bridge between the DOM node built by render_subtitles()
* and the CKEditor-based rich-text service.  It is called once per 'text'-typed
* item in self.ar_value, with i as the item's array index.
*
* Steps:
*   1. Creates a new service_ckeditor instance (new self.service_text_editor()).
*   2. Registers it in self.service_text_editor_instance[i] so it can be
*      referenced before init completes.
*   3. Builds the toolbar array and editor_config, wiring custom buttons
*      (get_custom_buttons) and custom events (get_custom_events) — both keyed
*      by i so save/event handlers can reach the right segment.
*   4. Calls service_ckeditor.init() and, after resolution, stores the
*      fully-initialised instance in self.text_editor[i].
*
* (!) The editor is mounted directly into value_container and toolbar_container,
* which must already be in the DocumentFragment (or the live DOM) before this is
* called; CKEditor requires a real DOM node to attach to.
*
* @param {Object}      self             - The tool_subtitles instance.
* @param {number}      i                - Zero-based index of the subtitle item
*   in self.ar_value; used as the CKEditor key and as the index into
*   self.text_editor[] and self.service_text_editor_instance[].
* @param {Object}      options          - Container references for the editor.
* @param {HTMLElement} options.value_container   - Node where CKEditor renders
*   editable content.
* @param {HTMLElement} options.toolbar_container - Node where the custom Dédalo
*   toolbar is rendered.
* @returns {Promise<Object>} The initialised service_ckeditor instance.
*/
// init_current_service_text_editor
const init_current_service_text_editor = async function(self, i, options) {

	// init the option variables
		const value_container	= options.value_container
		const toolbar_container	= options.toolbar_container

	// service_editor. Fixed on init
		const current_service_text_editor = new self.service_text_editor()

	// fix service instance with current input key
		self.service_text_editor_instance[i] = current_service_text_editor

	// toolbar. create the toolbar base
		const toolbar = ['bold','italic','underline','|','undo','redo','|','button_save']

	// editor_config
		const editor_config = {
			// plugins		: ['paste','image','print','searchreplace','code','noneditable','fullscreen'], // ,'fullscreen'
			toolbar			: toolbar, // array of strings like ['bold','italic']
			custom_buttons	: get_custom_buttons(self, current_service_text_editor, i),
			custom_events	: get_custom_events(self, i, current_service_text_editor),
			read_only		: false
		}

	// init editor
		await current_service_text_editor.init({
			caller				: self,
			value_container		: value_container,
			toolbar_container	: toolbar_container,
			key					: i,
			editor_config		: editor_config,
			editor_class		: 'ddEditor'
		})
		// .then(function(){
			// fix current_service_text_editor when is ready
			self.text_editor[i] = current_service_text_editor
		// })

	return current_service_text_editor
}//end init_current_service_text_editor


/**
* GET_CUSTOM_BUTTONS
* Builds the custom toolbar button descriptors for a single subtitle CKEditor.
*
* Each descriptor is a plain object consumed by service_ckeditor.build_toolbar():
*   {
*     name           {string}  — button identifier; '|' is a separator sentinel.
*     manager_editor {boolean} — when true, service_ckeditor wires the button
*                                to the CKEditor command of the same name
*                                (bold/italic/underline/undo/redo); when false,
*                                the onclick handler in options drives behaviour.
*     options        {Object}  — tooltip, image path, class_name, onclick, text.
*   }
*
* Buttons produced (in order): separator, bold, italic, underline, undo, redo,
* button_save.  The save button's onclick calls text_editor.save() which in turn
* triggers the component's save_value() on the enclosing tool instance.
*
* The get_label.save string may contain HTML tags (e.g. tooltip markup); they are
* stripped with a regex before being used as the button label text.
*
* @param {Object}   self        - The tool_subtitles instance (not directly used
*   here but passed for forward-compatibility with per-button permission checks).
* @param {Object}   text_editor - The service_ckeditor instance for this segment;
*   captured in the save button's onclick closure.
* @param {number}   i           - Zero-based index of the subtitle item; available
*   for keying if per-segment button overrides are added in the future.
* @returns {Array} Array of button descriptor objects for service_ckeditor.
*/
const get_custom_buttons = (self, text_editor, i) => {

	// custom_buttons
	const custom_buttons = []

	// separator
		custom_buttons.push({
			name			: '|',
			manager_editor	: false,
			options	: {
				tooltip		: '',
				image		: '../../core/themes/default/icons/separator.svg',
				class_name	: 'separator',
				onclick		: null
			}
		})

	// bold
		custom_buttons.push({
			name			: "bold",
			manager_editor	: true,
			options	: {
				tooltip	: 'bold',
				image	: '../../core/themes/default/icons/bold.svg'
			}
		})

	// italic
		custom_buttons.push({
			name			: "italic",
			manager_editor	: true,
			options	: {
				tooltip	: 'italic',
				image	: '../../core/themes/default/icons/italic.svg'
			}
		})

	// underline
		custom_buttons.push({
			name			: "underline",
			manager_editor	: true,
			options	: {
				tooltip	: 'underline',
				image	: '../../core/themes/default/icons/underline.svg'
			}
		})

	// undo
		custom_buttons.push({
			name			: "undo",
			manager_editor	: true,
			options	: {
				tooltip		: 'undo',
				image		: '../../core/themes/default/icons/undo.svg',
				class_name	: 'disable'
			}
		})

	// redo
		custom_buttons.push({
			name			: "redo",
			manager_editor	: true,
			options	: {
				tooltip		: 'redo',
				image		: '../../core/themes/default/icons/redo.svg',
				class_name	: 'disable'
			}
		})
	// button_save
		const save_label = get_label.save.replace(/<\/?[^>]+(>|$)/g, "") || "Save"
		custom_buttons.push({
			name			: "button_save",
			manager_editor	: false,
			options	: {
				text	: save_label,
				tooltip	: save_label,
				icon	: false,
				onclick	: function(evt) {
					// save. text_editor save function calls current component save_value()
					text_editor.save()
				}
			}
		})

	return custom_buttons
}//end get_custom_buttons



/**
* GET_CUSTOM_EVENTS
* Builds the custom event handler map for a single subtitle CKEditor.
*
* service_ckeditor accepts a custom_events plain object whose keys are CKEditor
* event names and whose values are handler functions.  Currently this returns an
* empty object (no custom events are wired), but the function exists as an
* extension point: add entries here when per-segment events are needed (e.g.
* 'change:data' to sync the subtitle model on every keystroke, or a focus event
* to highlight the matching timecode node in the left column).
*
* @param {Object}   self        - The tool_subtitles instance; available for
*   closures that need to mutate self.ar_value or trigger re-renders.
* @param {number}   i           - Zero-based index of the subtitle item; use to
*   target the correct self.ar_value[i] entry inside event handlers.
* @param {Object}   text_editor - The service_ckeditor instance for this segment.
* @returns {Object} Plain object of CKEditor event name → handler mappings.
*   Currently always returns {}.
*/
const get_custom_events = (self, i, text_editor) => {

	const custom_events = {}
	return custom_events
}//end get_custom_events



// (!) The large block of commented-out code below (GET_CONTENTEDITABLE_BUTTONS,
// DO_COMMAND, wrap_text, unwrap_text, find_tag, findParentTag, expandToTag) is
// a prototype for a fully custom contenteditable inline formatting system that
// predates the current service_ckeditor approach.  It was replaced because
// direct execCommand / Selection manipulation is unreliable across browsers and
// the tag-boundary edge-cases (do_command, find_tag) were never fully resolved.
// Retained for reference — do not restore without a test plan for nested-tag
// cases (see the start_parent_tag / end_parent_tag split logic in do_command).


/**
* GET_CONTENTEDITABLE_BUTTONS
*/
// const get_contenteditable_buttons = function(text_node) {

// 	const fragment = new DocumentFragment()

// 	// bold
// 		const button_bold = ui.create_dom_element({
// 			element_type	: 'button',
// 			class_name 		: 'light bold',
// 			text_content 	: "B",
// 			parent 			: fragment
// 		})
// 		button_bold.addEventListener("click", (e)=>{
// 			e.stopPropagation()
// 			do_command('strong', text_node)
// 		})
// 	// italic
// 		const button_italic = ui.create_dom_element({
// 			element_type	: 'button',
// 			class_name 		: 'light italic',
// 			text_content 	: "I",
// 			parent 			: fragment
// 		})
// 		button_italic.addEventListener("click", (e)=>{
// 			e.stopPropagation()
// 			do_command('em', text_node)
// 		})
// 	// underline
// 		const button_underline = ui.create_dom_element({
// 			element_type	: 'button',
// 			class_name 		: 'light underline',
// 			text_content 	: "U",
// 			parent 			: fragment
// 		})
// 		button_underline.addEventListener("click", (e)=>{
// 			e.stopPropagation()
// 			do_command('u', text_node)
// 		})
// 	// // find and replace
// 	// 	const button_replace = ui.create_dom_element({
// 	// 		element_type	: 'button',
// 	// 		class_name 		: 'light replace',
// 	// 		text_content 	: "Replace",
// 	// 		parent 			: fragment
// 	// 	})
// 	// 	button_replace.addEventListener("click", (e)=>{
// 	// 		e.stopPropagation()
// 	// 		do_command('insertText', 'nuevoooooXXX')
// 	// 	})

// 	// contenteditable_buttons
// 		const contenteditable_buttons = ui.create_dom_element({
// 			element_type	: 'div',
// 			class_name 		: 'contenteditable_buttons'
// 		})
// 		contenteditable_buttons.addEventListener("click", (e)=>{
// 			e.preventDefault()
// 		})
// 		contenteditable_buttons.appendChild(fragment)


// 	return contenteditable_buttons
// }//end get_contenteditable_buttons



/**
* DO_COMMAND
*/
// const do_command = (node_type, text_node) => {
// 	// get the selection object done by user
// 	const selection_object = document.getSelection();



// 	// console.log("parent_tag:",parent_tag);
// 	// get the node that content the text selected
// 	// const content_element = (selection_object.baseNode.nodeType === Node.TEXT_NODE)
// 	// 	? selection_object.baseNode.parentNode
// 	// 	: selection_object.baseNode;

// 	// if the section is not the current text attached stop it!
// 	// if(content_element !== text_node){
// 	// 	return
// 	// }
// 	// create the node type (bold, italics, etc)
// 	const new_node = document.createElement(node_type);

// 	// const found = selection_object.containsNode(node, true);
// 	// console.log("found:",found);

// 	// get the selection range done by user
// 	const selection_range = selection_object.getRangeAt(0);

// 	const old_range = selection_range.extractContents();

// 	if (old_range.nodeType !== Node.TEXT_NODE){

// 		// find is the node_type is inside the selection, node_type need to be in uppercase
// 		// const parent_tag = findParentTag(node_type.toUpperCase())

// 		// the Node in which the selection begins
// 		const start_anchor_node	= selection_object.anchorNode
// 		// the Node in which the selection ends
// 		const end_anchor_node	= selection_object.focusNode

// 		const start_parent_tag = find_tag(text_node, start_anchor_node, node_type.toUpperCase())
// 		if(start_parent_tag){
// 			const start_range = document.createRange();
// 			start_range.selectNode(start_parent_tag)
// 			// start_range.setStart(start_parent_tag, 0);
// 			start_range.setEnd(selection_range.startContainer, selection_range.startOffset);
// 			const start_node = start_range.extractContents();
// 			console.log("start_range:",start_node);
// 			start_range.insertNode(start_node);
// 		}

// 		const end_parent_tag = find_tag(text_node, end_anchor_node, node_type.toUpperCase())
// 		if(end_parent_tag){
// 			const end_range = document.createRange();
// 			end_range.selectNode(end_parent_tag)
// 			end_range.setStart(selection_range.endContainer, selection_range.endOffset);

// 			const end_node = end_range.extractContents();
// 			end_range.insertNode(end_node);
// 		}

// 		const old_node = document.createElement('div');
// 		old_node.appendChild(old_range)

// 		const node_string = old_node.innerHTML;

// 		const remove_regex 	= '(<\/?'+node_type+'>)'
// 		const regex =  new RegExp(remove_regex,'gi');

// 		const match = node_string.match(remove_regex)
// 		const clean_string = node_string.replace( regex, '')

// 		if(match){
// 			const fragment = new DocumentFragment()

// 			const clean_node = document.createElement('div');
// 			clean_node.innerHTML = clean_string

// 			const child_nodes = [...clean_node.childNodes]
// 			const len = child_nodes.length
// 			for (let i = 0; i < len; i++) {

// 				fragment.append(child_nodes[i])
// 			}
// 			selection_range.insertNode(fragment);

// 			selection_object.removeAllRanges();
// 			selection_object.addRange(selection_range);
// 			return
// 		}

// 		new_node.insertAdjacentHTML('afterbegin',clean_string )

// 	}else{
// 		new_node.appendChild(old_range)
// 	}

// 	// new_node.appendChild(old_range)
// 	selection_range.insertNode(new_node);

// 	selection_object.removeAllRanges();
// 	selection_object.addRange(selection_range);
// }

// const wrap_text = function(argument) {

// 	const new_node = document.createElement(node_type);

// 	// get the selection range done by user
// 	const selection_range = selection_object.getRangeAt(0);

// 	const old_range = selection_range.extractContents();
// 	new_node.appendChild(old_range)
// 	selection_range.insertNode(new_node);

// }

// const unwrap_text = function(text_wrapper) {

// 	// Expand selection to all term-tag
// 	// expandToTag(text_wrapper);

// 	const sel = window.getSelection();
// 	const range = sel.getRangeAt(0);

// 	const unwrappedContent = range.extractContents();


// 	// Remove empty term-tag
// 	text_wrapper.parentNode.removeChild(text_wrapper);


// 	// Insert extracted content
// 	range.insertNode(unwrappedContent);

// 	// Restore selection
// 	sel.removeAllRanges();
// 	sel.addRange(range);

// }


// const find_tag = function(text_node, node_anchor, node_tag) {

// 	const parent_node = node_anchor

// 	if(parent_node === text_node){
// 		return null
// 	}
// 	if(parent_node.tagName === node_tag){
// 		return parent_node
// 	}else{
// 		return find_tag(text_node, parent_node.parentNode, node_tag)
// 	}
// }



// /**
// * Looks ahead to find passed tag from current selection
// *
// * @param  {string} tagName       - tag to found
// * @param  {string} [className]   - tag's class name
// * @param  {number} [searchDepth] - count of tags that can be included. For better performance.
// *
// * @returns {HTMLElement|null}
// */
// const findParentTag = function (tagName, className, searchDepth = 10){
// 	const selection = window.getSelection();
// 	let parentTag = null;

// 	// If selection is missing or no anchorNode or focusNode were found then return null
// 	if (!selection || !selection.anchorNode || !selection.focusNode) {
// 		return null;
// 	}

// 	// Define Nodes for start and end of selection
// 	const boundNodes = [
// 		// the Node in which the selection begins
// 		selection.anchorNode, // as HTMLElement,
// 		// the Node in which the selection ends
// 		selection.focusNode // as HTMLElement,
// 	];

// 	// For each selection parent Nodes we try to find target tag [with target class name]
// 	// It would be saved in parentTag variable
// 	boundNodes.forEach((parent) => {
// 		// Reset tags limit
// 		let searchDepthIterable = searchDepth;

// 		while (searchDepthIterable > 0 && parent.parentNode) {

// 			// Check tag's name
// 			if (parent.tagName === tagName) {

// 				// Save the result
// 				parentTag = parent;

// 				// Optional additional check for class-name mismatching
// 				if (className && parent.classList && !parent.classList.contains(className)) {
// 					parentTag = null;
// 				}

// 				// If we have found required tag with class then go out from the cycle
// 				if (parentTag) {
// 					break;
// 				}
// 			}
// 			// Target tag was not found. Go up to the parent and check it
// 			parent = parent.parentNode //as HTMLElement;
// 			searchDepthIterable--;
// 		}
// 	});

// 	// Return found tag or null
// 	return parentTag;
// }

// /**
// * Expands selection range to the passed parent node
// *
// * @param {HTMLElement} element - element which contents should be selected
// */
// const expandToTag = function ( element ){
// 	const selection = window.getSelection();

// 	selection.removeAllRanges();
// 	const range = document.createRange();

// 	range.selectNodeContents(element);
// 	selection.addRange(range);
// }



// @license-end
