// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, DEDALO_CORE_URL, SHOW_DEBUG, SHOW_DEVELOPER */
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_EDIT_MENU
* Default edit-mode view implementation for the Dédalo top navigation menu.
*
* This module is the HTML-building layer called by render_menu.prototype.edit
* (via view_default_edit_menu.render). It owns the full DOM tree of the
* horizontal menu bar that appears at the top of every Dédalo edit-mode page.
*
* Responsibilities:
*  - Build the outer `.menu_wrapper` element and decorate it with entity /
*    role CSS classes (is_root, is_global_admin, dedalo_entity, version).
*  - Delegate area/section tree rendering to render_menu_tree (desktop) and
*    render_menu_mobile (hamburger overlay).
*  - Wire the quit button, Dédalo icon, language selectors, theme toggle,
*    AI-assistant panel, section-label breadcrumb, and inspector toggle.
*  - Show the debug info bar (version, DB name, PG/PHP stats, service-worker
*    indicator, RR-worker badge) only when SHOW_DEVELOPER or SHOW_DEBUG is
*    true.
*  - Handle compact-mode switching via ResizeObserver: when `.content_data`
*    overflows its row (height > 50 px) the desktop tree is hidden and the
*    mobile hamburger icon is shown instead.
*  - Manage the AI assistant panel lifecycle: lazy-load tool_assistant,
*    check user permissions via the tools API, re-parent the container
*    across page navigations, and synchronise its position with the menu
*    height in standalone (non-inspector) mode.
*
* Main exports:
*   view_default_edit_menu          — constructor (stub; used as namespace)
*   view_default_edit_menu.render   — async factory; returns the wrapper element
*
* Module-level state (not exported):
*   sync_standalone_position        — helper: aligns assistant panel to menu height
*   _assistant_nav_subscribed       — guard: ensures a single user_navigation listener
*/

// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {when_in_viewport} from '../../common/js/events.js'
	import {login} from '../../login/js/login.js'
	import {render_section_label} from './render_menu.js'
	import * as menu_tree from './render_menu_tree.js'
	import * as menu_mobile from './render_menu_mobile.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {toggle_theme} from '../../page/js/theme.js'
	import {response_data} from '../../common/js/api_error.js'

/**
* SYNC_STANDALONE_POSITION
* Align the assistant panel's top offset and height to the current menu wrapper
* height so the panel fills exactly the viewport below the menu bar.
*
* Called in standalone mode (no inspector_container present, e.g. list views)
* whenever the assistant panel is shown or re-parented after navigation.
* The menu can be taller than expected when the debug_info_bar is visible,
* so querying offsetHeight is necessary rather than using a hardcoded value.
*
* @param {HTMLElement} ac - The `.assistant_container` element to reposition
* @returns {void}
*/
// sync standalone assistant top/height with actual menu wrapper size (accounts for debug_info_bar)
	const sync_standalone_position = (ac) => {
		const menu_wrapper = document.querySelector('.menu_wrapper')
		const menu_h = menu_wrapper ? menu_wrapper.offsetHeight : 0
		if (menu_h > 0) {
			ac.style.top = menu_h + 'px'
			ac.style.height = 'calc(100vh - ' + menu_h + 'px)'
			ac.style.maxHeight = 'calc(100vh - ' + menu_h + 'px)'
		}
	}

// module-level assistant re-parenting on navigation (persists across menu re-renders).
// A single 'user_navigation' subscription is registered once at module load time.
// Each navigation event attempts to re-attach a visible assistant panel to the
// current inspector_container (edit mode) or document.body (standalone mode),
// retrying up to 30 times at 150 ms intervals to wait for the new DOM to settle.
	let _assistant_nav_subscribed = false
	if (!_assistant_nav_subscribed) {
		_assistant_nav_subscribed = true
		event_manager.subscribe('user_navigation', () => {
			const ac = document.querySelector('.assistant_container.show')
			if (!ac) return
			const try_reparent = (attempts = 0) => {
				if (attempts > 30) return // max ~3s
				const ic = document.getElementById('inspector_container')
				const is_standalone = !ic
				const desired_parent = ic || document.body
				ac.classList.toggle('standalone', is_standalone)
				if (is_standalone) {
					sync_standalone_position(ac)
				} else {
					ac.style.top = ''
					ac.style.height = ''
					ac.style.maxHeight = ''
					ic.classList.add('has_assistant')
				}
				if (!ac.parentNode || !ac.parentNode.isConnected || ac.parentNode !== desired_parent) {
					desired_parent.appendChild(ac)
				}
				// always retry a few times — DOM may not be ready yet on first attempts
				if (attempts < 10) {
					setTimeout(() => try_reparent(attempts + 1), 150)
				}
			}
			setTimeout(() => try_reparent(), 50)
		})
	}



/**
* VIEW_DEFAULT_EDIT_MENU
* Namespace constructor for the default edit-mode menu view.
*
* Acts as a pure namespace object: the constructor body is intentionally empty.
* All functionality is attached to `view_default_edit_menu.render` and the
* module-level private helpers. Follows the Dédalo pattern used by render_menu.js
* and other view modules where the constructor serves only as a named container.
*/
export const view_default_edit_menu = function() {

	return true
}//end view_default_edit_menu



/**
* RENDER
* Build and return the full `.menu_wrapper` HTMLElement for the edit-mode menu.
*
* Entry point called by render_menu.prototype.edit. Constructs the outer wrapper,
* delegates inner content to get_content_data_edit, and optionally appends the
* debug info bar when SHOW_DEVELOPER or SHOW_DEBUG is active.
*
* When `options.render_level` is `'content'` the function returns the inner
* `.content_data` DocumentFragment directly, bypassing the wrapper — used by
* callers that need to refresh only the menu content without re-creating the
* outer shell.
*
* The wrapper receives CSS classes for:
*   - '.menu_wrapper' and '.menu' (always)
*   - page_globals.dedalo_entity (e.g. 'my_institution') — used for entity theming
*   - 'is_root' or 'is_global_admin' — controls visibility of the left colour band
*   - 'v7_0_x' (version slug) — applied lazily once the element enters the viewport
*   - 'with_debug_info' — only when the debug bar is present
*
* A ResizeObserver on `.content_data` drives the compact/expanded toggle:
* when the content row wraps to a second line (height > 50 px) the class
* 'compact' is added, hiding the desktop tree and showing the hamburger icon.
* The edge viewport-width is stored on `content_data._compact_edge` so the
* observer can restore the expanded state when the viewport grows back past it.
*
* @param {Object} self    - Menu instance (from menu.js constructor)
* @param {Object} options - Render options
*   @param {string} [options.render_level='full'] - 'full' for wrapper+content;
*     'content' to return only the inner content node
* @returns {Promise<HTMLElement>} Resolves to `.menu_wrapper` (full) or
*   `.content_data` (content level)
*/
view_default_edit_menu.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type : 'div'
		})
		const classes = ['menu_wrapper','menu']
		if (page_globals && page_globals.dedalo_entity) {
			classes.push(page_globals.dedalo_entity)
		}
		// menu left band
		switch (true) {
			case page_globals.is_root===true:
				classes.push('is_root')
				break;
			case page_globals.is_global_admin===true:
				classes.push('is_global_admin')
				break;
			default:
				// nothing to add
				break;
		}
		wrapper.classList.add(...classes)
		// append content_data
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data

	// debug info bar. Detect debug info bar and add it to the wrapper
		const add_debug_info = ((typeof SHOW_DEVELOPER !== 'undefined' && SHOW_DEVELOPER===true) || (typeof SHOW_DEBUG !== 'undefined' && SHOW_DEBUG===true))
		if(add_debug_info) {
			wrapper.classList.add('with_debug_info')
			const debug_info_bar = render_debug_info_bar(self)
			if(debug_info_bar) {
				wrapper.appendChild(debug_info_bar)
			}
		}

	// events
		// compact toggle. Detect content_data overflow to switch between
		// desktop menu_hierarchy and mobile menu_mobile_icon.
		// The menu bar is a single flex row; when all items fit, height stays ~50 px.
		// When the viewport narrows enough that items wrap, height exceeds 50 px and
		// 'compact' hides the desktop tree, showing the hamburger icon instead.
		// _compact_edge records the viewport width at which compaction was triggered
		// so we can un-compact only when the viewport grows back past that threshold,
		// preventing oscillation at boundary widths.
		// (!) Never toggle 'compact' inside the observer callback: it resizes the
		// observed node in the same observation cycle ("ResizeObserver loop
		// completed with undelivered notifications", e.g. reload at phone width).
		// The callback only schedules; one frame-coalesced pass measures + writes.
		let frame_id = 0
		const update_compact = () => {
			frame_id = 0
			const height = content_data.getBoundingClientRect().height;
			const win_width = window.innerWidth;
			if (height > 50) {
				content_data.classList.add('compact');
				content_data._compact_edge = win_width;
			} else if (content_data._compact_edge && win_width > content_data._compact_edge) {
				content_data.classList.remove('compact');
			}
		}
		const resize_observer = new ResizeObserver(() => {
			if (!frame_id) {
				frame_id = requestAnimationFrame(update_compact)
			}
		});

		// fire events when_in_viewport.
		// The observer is started and the version class applied lazily once the wrapper
		// enters the viewport, avoiding unnecessary ResizeObserver callbacks before the
		// element is visible (e.g. during server-side pre-rendering or tab switches).
		when_in_viewport(wrapper, () => {
			resize_observer.observe(content_data);
			// update class from version
			// One class token from the release identity, e.g. '7.0.0-beta.6' → 'v7_0_0-beta_6':
			// anything outside [A-Za-z0-9_-] becomes '_' (same rule as render_page.js)
			wrapper.classList.add('v'+String(page_globals.dedalo_version).replace(/[^A-Za-z0-9_-]/g, '_'))
		})


	return wrapper
}//end render



/**
* GET_CONTENT_DATA_EDIT
* Build the inner `.content_data` DOM element containing all interactive menu items.
*
* Creates a DocumentFragment, populates it with every interactive menu item in
* left-to-right visual order, then wraps it in a `.content_data` div which is
* returned for appending into the outer wrapper produced by `render`.
*
* Items built (in DOM order within the fragment):
*  1. quit_button          — triggers login.quit(); keyboard-accessible
*  2. dedalo_icon          — opens https://dedalo.dev in a new window
*  3. menu_hierarchy       — desktop area/section tree (render_menu_tree.render_tree)
*  4. menu_mobile_icon     — hamburger trigger for mobile; lazily initialises
*                            render_menu_mobile on first click and subscribes to
*                            user_navigation to auto-hide the overlay on navigation
*  5. [ontology_link]      — commented out; preserved for future restoration
*  6. logged_user_name     — shows current username; for non-root users opens
*                            tool_user_admin via self.open_tool_user_admin_handler()
*  7. application lang selector — uses ui.build_select_lang; calls change_lang with
*                            lang_type='dedalo_application_lang'
*  8. data lang selector   — visible only when page_globals.dedalo_data_lang_selector
*                            is true; calls change_lang with lang_type='dedalo_data_lang'
*  9. menu_spacer          — flex spacer that pushes right-side items to the right edge
* 10. theme_toggle         — calls toggle_theme(); keyboard-accessible
* 11. ai_assistant_button  — lazy-loads tool_assistant, checks permissions via dd_tools_api,
*                            and manages the floating assistant panel (see inline comments)
* 12. section_label_container — holds render_section_label output plus button_toggle_inspector
*
* Side effects:
*  - Sets self.menu_active = false (reset on each render)
*  - Initialises self.events_tokens array if not already present (??=)
*  - Pushes a user_navigation token into self.events_tokens for the mobile menu
*
* @param {Object} self - Menu instance (from menu.js constructor); must expose
*   self.data.username, self.open_tool_user_admin_handler(), self.change_lang()
* @returns {HTMLElement} The `.content_data` div with pointer properties:
*   content_data.section_label            - the section label element
*   content_data.button_toggle_inspector  - the inspector toggle button element
*/
const get_content_data_edit = function(self) {

	// menu_active. set the first state of the menu
		self.menu_active = false
		self.events_tokens ??= []

	// username
		const username = self.data.username

	// DocumentFragment
		const fragment = new DocumentFragment()

	// quit_button
		const quit_button = ui.create_dom_element({
			element_type	: 'div',
			id				: 'quit',
			class_name		: 'quit top_item',
			parent			: fragment
		})
		quit_button.tabIndex = 0
		quit_button.setAttribute('role', 'button')
		const quit_click_handler = (e) => {
			e.stopPropagation()
			// login quit
			login.quit({
				caller : self
			})
		}
		quit_button.addEventListener('click', quit_click_handler)
		quit_button.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') quit_click_handler(e) })

	// dedalo_icon
		const dedalo_icon = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'dedalo_icon_top top_item',
			parent			: fragment
		})
		dedalo_icon.tabIndex = 0
		dedalo_icon.setAttribute('role', 'button')
		// click event
		const dedalo_icon_click_handler = (e) => {
			e.stopPropagation()
			window.open('https://dedalo.dev', 'Dédalo Site', []);
		}
		dedalo_icon.addEventListener('click', dedalo_icon_click_handler)
		dedalo_icon.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') dedalo_icon_click_handler(e) })

	// menu_hierarchy. areas/sections hierarchy list
		// menu tree (desktop)
			const menu_hierarchy = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'menu_hierarchy top_item',
				parent			: fragment
			})
			// menu_tree render
			menu_tree.render_tree({
				self		: self,
				tipo		: 'dd1',
				container	: menu_hierarchy
			})

		// mobile only
			const menu_mobile_icon = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'menu_mobile_icon top_item',
				parent			: fragment
			})
			menu_mobile_icon.tabIndex = 0
			menu_mobile_icon.setAttribute('role', 'button')

			// menu_mobile_wrapper is created lazily on first hamburger click to avoid
			// building a second DOM tree on every render. The variable persists in
			// the handler closure across subsequent clicks.
			let menu_mobile_wrapper = null
			// click event
			const menu_mobile_click_handler = (e) => {
				e.stopPropagation()

				if (!menu_mobile_wrapper) {
					menu_mobile_wrapper = menu_mobile.render_menu({
						self	: self,
						tipo	: 'dd1'
					})
					// insert after section_label_container
					// (!) section_label_container is declared later in this function but the
					// click handler only fires after the full function has returned, so the
					// closure captures the correct reference via hoisting of the let declaration.
					if (section_label_container && section_label_container.parentNode) {
						section_label_container.parentNode.insertBefore(menu_mobile_wrapper, section_label_container.nextSibling);
					}
					// auto-hide the mobile menu on any navigation event; token stored for cleanup
					const user_navigation_handler = (e) => {
						if (!menu_mobile_wrapper.classList.contains('hide')) {
							menu_mobile_wrapper.classList.add('hide')
						}
					}
					self.events_tokens.push(
						event_manager.subscribe('user_navigation', user_navigation_handler)
					)
				}else{
					// on subsequent clicks simply toggle visibility
					menu_mobile_wrapper.classList.toggle('hide')
				}
			}
			menu_mobile_icon.addEventListener('click', menu_mobile_click_handler)
			menu_mobile_icon.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') menu_mobile_click_handler(e) })

	// ontology link
	// (!) Commented out: the ontology shortcut was conditionally rendered when
	// self.data.show_ontology===true. Kept for potential future restoration;
	// do not remove.
		// if (self.data && self.data.show_ontology===true) {
		// 	const ontology_link = ui.create_dom_element({
		// 		element_type	: 'div',
		// 		class_name		: 'ontology top_item',
		// 		inner_html		: get_label.ontology || 'Ontology',
		// 		parent			: fragment
		// 	})
		// 	// set pointers
		// 	self.ontology_link = ontology_link
		// 	ontology_link.addEventListener('click', self.open_ontology)
		// }

	// user name link (open tool_user_admin)
		const logged_user_name = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'logged_user_name top_item',
			text_content	: username,
			parent			: fragment
		})
		// root user has no personal admin panel; suppress click events entirely
		if (username==='root') {
			logged_user_name.classList.add('is_root','noevents')
		}else{
			logged_user_name.tabIndex = 0
			logged_user_name.setAttribute('role', 'button')
			// click event
			const tool_user_admin_click_handler = function(e) {
				e.stopPropagation();
				self.open_tool_user_admin_handler()
			}//end fn_open_tool
			logged_user_name.addEventListener('click', tool_user_admin_click_handler)
			logged_user_name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') tool_user_admin_click_handler(e) })
		}

	// application lang selector
		const lang_datalist = page_globals.dedalo_application_langs || []
		const dedalo_aplication_langs_selector = ui.build_select_lang({
			name	: 'dedalo_application_langs',
			langs	: lang_datalist,
			action	: function(e) {
				// executed on change event
				e.preventDefault()
				change_lang({
					lang_type	: 'dedalo_application_lang',
					lang_value	: this.value,
					self		: self
				})
			},
			selected	: page_globals.dedalo_application_lang,
			class_name	: 'reset_input dedalo_aplication_langs_selector top_item'
		})
		dedalo_aplication_langs_selector.title = get_label.interface || 'Interface'
		fragment.appendChild(dedalo_aplication_langs_selector)

	// data lang selector
	// Shown only when the installation exposes multiple data languages
	// (page_globals.dedalo_data_lang_selector is set server-side per-entity).
	// Labels are prefixed with 'data: ' to visually distinguish from the
	// application (UI) language selector that precedes it.
		const show_data_lang_selector = page_globals.dedalo_data_lang_selector ?? false
		if (show_data_lang_selector) {
			const lang_datalist_data = lang_datalist.map(item =>{
				return {
					label	: (get_label.data || 'data') + ': ' + item.label,
					value	: item.value
				}
			})
			const dedalo_data_langs_selector = ui.build_select_lang({
				name	: 'dedalo_data_lang',
				langs	: lang_datalist_data,
				action	: function(e) {
					// executed on change event
					e.preventDefault()
					change_lang({
						lang_type	: 'dedalo_data_lang',
						lang_value	: this.value,
						self		: self
					})
				},
				selected	: page_globals.dedalo_data_lang,
				class_name	: 'reset_input dedalo_aplication_langs_selector data top_item'
			})
			fragment.appendChild(dedalo_data_langs_selector)
		}

	// menu_spacer
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'menu_spacer top_item',
			parent			: fragment
		})

	// theme toggle
		const theme_toggle = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'theme_toggle top_item',
			title			: get_label.theme_toggle || 'Toggle dark mode',
			parent			: fragment
		})
		theme_toggle.tabIndex = 0
		theme_toggle.setAttribute('role', 'button')
		theme_toggle.addEventListener('click', () => { toggle_theme() })
		theme_toggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle_theme() })

	// ai_assistant button
	// Created only when the server reports a configured assistant model
	// (page_globals.ai_capabilities.assistant, see src/ai/capabilities.ts).
	// A missing key (older server / absent payload) counts as HIDDEN.
	if (page_globals.ai_capabilities?.assistant === true) {
		const ai_assistant_button = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'ai_assistant_button top_item',
			title			: get_label.ai_assistant || 'AI Assistant',
			parent			: fragment
		})
		ai_assistant_button.tabIndex = 0
		ai_assistant_button.setAttribute('role', 'button')
		// prevent mousedown from propagating to document so the active component is not deactivated
		ai_assistant_button.addEventListener('mousedown', (e) => {
			e.stopPropagation()
		})
		// assistant panel state (persists across section navigations).
		// Closure variables shared across every click invocation for this menu render:
		//   assistant_instance  — the ai_assistant class instance (holds chat state)
		//   assistant_container — the .assistant_container HTMLElement (created once)
		//   assistant_visible   — tracks visibility to implement toggle behaviour
			let assistant_instance	= null
			let assistant_container	= null
			let assistant_visible	= false
		const ai_assistant_click_handler = async (e) => {
			e.stopPropagation()
			try {
				// find the current inspector_container in the page (edit mode)
				// inspector_container is re-queried on every click because section navigation
				// replaces the DOM element; we cannot cache a reference across navigations.
					const inspector_container = document.getElementById('inspector_container')
					const is_standalone = !inspector_container
				// toggle off: hide the panel
					if (assistant_visible) {
						if (assistant_container) assistant_container.classList.remove('show')
						if (inspector_container) inspector_container.classList.remove('has_assistant')
						ai_assistant_button.classList.remove('active')
						assistant_visible = false
						return
					}
				// first time: create the panel and init the assistant
				// guard: assistant_container===null means the tool has never been opened
					if (!assistant_container) {
						// check user has permission to use the tool.
						// 'user_tools' returns only the tools the logged-in user may access.
						// If tool_assistant is absent from the result the button silently does nothing.
							const api_response = await data_manager.request({
								body : {
									action	: 'user_tools',
									dd_api	: 'dd_tools_api',
									options	: {
										ar_requested_tools : ['tool_assistant']
									}
								}
							})
							const tools_context = response_data(api_response)
							if (!Array.isArray(tools_context)) return
							const tool_context = tools_context.find(t => t.name === 'tool_assistant')
							if (!tool_context) return

						// build the tool instance to get assistant_config.
						// tool_instance.build(true) populates tool_instance.assistant_config
						// with the server-side configuration for this user/entity.
							const { get_instance } = await import('../../common/js/instances.js')
							const instance_options = Object.assign({ caller : self }, tool_context)
							const tool_instance = await get_instance(instance_options)
							await tool_instance.build(true)

						// create assistant_container
						// in edit mode: inside inspector_container; in list mode: standalone fixed panel
							const container_parent = inspector_container || document.body
							const container_class = is_standalone
								? 'assistant_container standalone'
								: 'assistant_container'
							assistant_container = ui.create_dom_element({
								element_type	: 'div',
								class_name		: container_class,
								parent			: container_parent
							})
						// prevent mousedown from propagating to document so the active component is not deactivated
							assistant_container.addEventListener('mousedown', (e) => {
								e.stopPropagation()
							})

						// init ai_assistant and build chat UI.
						// Both imports are dynamic to avoid bundling tool_assistant into the main
						// menu chunk; they only download when the user first opens the panel.
							const { ai_assistant } = await import('../../../tools/tool_assistant/js/ai_assistant.js')
							assistant_instance = new ai_assistant({
								tool_config	: tool_instance.assistant_config || {},
								tool_self	: tool_instance
							})
							const chat_ui = await assistant_instance.build_chat_ui()
							assistant_container.appendChild(chat_ui)
					}
				// re-attach / re-parent the container if needed
				// (section navigation recreates inspector_container, or mode changed list↔edit)
				// Three conditions that require a move:
				//  1. parentNode is null (detached after DOM replacement)
				//  2. parentNode is disconnected from the live document
				//  3. parentNode is the wrong target (e.g. mode switched between edit and list)
					const desired_parent = inspector_container || document.body
					const needs_move = !assistant_container.parentNode
						|| !assistant_container.parentNode.isConnected
						|| assistant_container.parentNode !== desired_parent
					if (needs_move) {
						desired_parent.appendChild(assistant_container)
					}
					// update standalone class to match current mode
					assistant_container.classList.toggle('standalone', is_standalone)
				// sync top/height with actual menu height (debug_info_bar makes it taller)
					if (is_standalone) {
						sync_standalone_position(assistant_container)
					} else {
						// clear inline styles set by sync_standalone_position when switching back
						// to inspector (non-standalone) mode
						assistant_container.style.top = ''
						assistant_container.style.height = ''
						assistant_container.style.maxHeight = ''
					}
				// show the panel
					assistant_container.classList.add('show')
					if (inspector_container) inspector_container.classList.add('has_assistant')
					ai_assistant_button.classList.add('active')
					assistant_visible = true
			} catch (err) {
				console.error('[ai_assistant_click_handler]', err)
			}
		}
		ai_assistant_button.addEventListener('click', ai_assistant_click_handler)
		ai_assistant_button.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') ai_assistant_click_handler(e) })
	}

	// section label container
		const section_label_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_label_container top_item',
			parent			: fragment
		})

	// section label button (go to list)
		const section_label = render_section_label(self)
		section_label_container.appendChild(section_label)

	// inspector button toggle
		const button_toggle_inspector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'button_toggle_inspector top_item no_visible',
			title			: get_label.inspector || 'Inspector',
			parent			: section_label_container
		})
		button_toggle_inspector.tabIndex = 0
		button_toggle_inspector.setAttribute('role', 'button')
		// click event
		const toggle_inspector_click_handler = (e) => {
			e.stopPropagation()
			ui.toggle_inspector()
		}
		button_toggle_inspector.addEventListener('click', toggle_inspector_click_handler)
		button_toggle_inspector.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle_inspector_click_handler(e) })

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data'
		})
		content_data.appendChild(fragment)
		// set pointers
		content_data.section_label				= section_label
		content_data.button_toggle_inspector	= button_toggle_inspector


	return content_data
}//end get_content_data_edit



/**
* RENDER_DEBUG_INFO_BAR
* Build a diagnostic status bar appended below the main menu content.
*
* Rendered only when SHOW_DEVELOPER===true or SHOW_DEBUG===true (checked by the
* caller in `render`). Exposes server-side environment values from two sources in
* priority order: self.data.info_data (server response) falls back to page_globals
* (bootstrap globals) so the bar works even if info_data is missing.
*
* Elements rendered (left to right):
*   dedalo_version  — code version + build stamp; class 'beta' / 'dev' from page_globals.release_kind
*   dedalo_db_name  — active PostgreSQL database name
*   pg_version      — PostgreSQL server version string
*   php_version     — PHP interpreter version
*   php_memory      — PHP memory_limit or current usage
*   php_sapi_name   — PHP SAPI (fpm-fcgi, cli, etc.)
*   dedalo_entity   — entity identifier (institution slug)
*   dedalo_entity_id — numeric entity id (coerced to string for text content)
*   service_worker  — shown only when a service worker scriptURL is found; removed
*                     from the DOM when no worker is registered (async, best-effort)
*   environment     — click opens the environment.js.php diagnostic page in a new tab.
*                     (!) Uses the undeclared global DEDALO_ROOT_WEB — flagged below.
*   rr_worker       — badge shown only when DEDALO_RR_WORKER===true
*   ip_server       — IP address of the application server
*
* @param {Object} self - Menu instance; reads self.data.info_data for server-provided values
* @returns {HTMLElement} The `.debug_info_bar` div, ready to append to the menu wrapper
*/
export const render_debug_info_bar = (self) => {

	// short vars
		const info_data			= self.data.info_data || {}
		const dedalo_version	= info_data.dedalo_version || page_globals.dedalo_version
		const dedalo_build		= info_data.dedalo_build || page_globals.dedalo_build
		const dedalo_db_name	= info_data.dedalo_db_name || page_globals.dedalo_db_name
		const pg_version		= info_data.pg_version || page_globals.pg_version
		const php_version		= info_data.php_version || page_globals.php_version
		const php_memory		= info_data.php_memory || page_globals.php_memory
		const php_sapi_name		= info_data.php_sapi_name || page_globals.php_sapi_name
		const ip_server			= info_data.ip_server

	// debug_info_bar
		const debug_info_bar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'debug_info_bar'
		})

	// dedalo_version
	// Marks a pre-stable build: 'beta' for a prerelease (alpha|beta|rc), 'dev' for
	// an untagged one, nothing for a stable release. Read from the server's
	// classification page_globals.release_kind (stable|prerelease|dev), never
	// sniffed from the identity string: '7.0' in '7.0.0' would mark the stable
	// release beta too (WC-2026-10-15-release-identity-from-tag, addendum 2026-10-18).
		const version_style = (() => {
			switch (page_globals.release_kind) {
				case 'prerelease'	: return ' beta'
				case 'dev'			: return ' dev'
				default				: return ''
			}
		})()
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dedalo_version' + version_style,
			// dedalo_build is null on a dev checkout (WC-2026-08-23-build-provenance): omitted, never 'null'
			text_content	: ['Code v.', dedalo_version, dedalo_build].filter(Boolean).join(' '),
			parent			: debug_info_bar
		})

	// dedalo_db_name
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dedalo_db_name',
			text_content	: 'DB: ' + dedalo_db_name,
			parent			: debug_info_bar
		})

	// pg_version
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'pg_version',
			text_content	: 'PG v. ' + pg_version,
			parent			: debug_info_bar
		})

	// php_version
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'php_version',
			text_content	: 'Runtime ' + php_version,
			parent			: debug_info_bar
		})

	// php_memory
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'php_memory',
			text_content	: 'memory: ' + php_memory,
			parent			: debug_info_bar
		})

	// php_sapi_name
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'php_sapi_name',
			text_content	: 'sapi. ' + php_sapi_name,
			parent			: debug_info_bar
		})

	// dedalo_entity
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dedalo_entity',
			text_content	: page_globals.dedalo_entity,
			parent			: debug_info_bar
		})

	// dedalo_entity_id
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dedalo_entity_id',
			text_content	: page_globals.dedalo_entity_id + '',
			parent			: debug_info_bar
		})

	// service_worker_active
	// Created hidden; revealed asynchronously only when a registered and active service
	// worker is found. If no worker is registered the element is removed from the DOM
	// entirely (rather than kept hidden) to avoid occupying flex space.
		if ('serviceWorker' in navigator) {
			const service_worker_active = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'service_worker_active hide',
				parent			: debug_info_bar
			})
			try {
				navigator.serviceWorker.getRegistrations().then(registrations => {
					const script_url = registrations[0]?.active?.scriptURL
					if (script_url) {
						service_worker_active.classList.remove('hide')
						service_worker_active.title = 'Service worker is active at ' + script_url
					}else{
						service_worker_active.remove()
					}
				});
			} catch (error) {
				console.error(error)
			}
		}

	// environment
	// (!) DEDALO_ROOT_WEB is not declared in the /*global*/ header at the top of this file
	// and is not listed in page_globals. It is expected to be a globally injected constant
	// from the PHP bootstrap; if absent at runtime this will throw a ReferenceError.
		const environment_link = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'environment',
			title			: 'Environment',
			parent			: debug_info_bar
		})
		// click event
		const environment_click_handler = (e) => {
			e.stopPropagation()
			window.open(
				DEDALO_ROOT_WEB + '/core/api/v1/environment',
				'Environment',
				null
			)
		}
		environment_link.addEventListener('click', environment_click_handler)

	// Worker
	// DEDALO_RR_WORKER is a bootstrap global (not declared in /*global*/) that signals
	// the RoadRunner persistent-worker mode is active. The typeof guard avoids a
	// ReferenceError in environments where the constant is not injected.
		if(typeof DEDALO_RR_WORKER !== 'undefined' && DEDALO_RR_WORKER===true) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'rr_worker',
				title			: 'RR Worker',
				text_content	: 'RR',
				parent			: debug_info_bar
			})
		}

	// ip_server
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'ip_server',
			text_content	: ip_server,
			parent			: debug_info_bar
		})


	return debug_info_bar
}//end render_debug_info_bar



/**
* CHANGE_LANG
* Persist the user's language selection to the server then reload the page.
*
* Delegates to self.change_lang() (a menu prototype method that POSTs
* the new lang value to the Dédalo API) and triggers a full page reload
* once the server has confirmed the change. The reload uses false (use
* cached HTML) which is correct because language changes invalidate server-side
* data, not the static page shell.
*
* Sets the `#main` element's CSS class to 'loading' while the API call
* is in flight to provide visual feedback.
*
* @param {Object} options - Change language parameters
*   @param {string} options.lang_type  - Which lang slot to update:
*     'dedalo_application_lang' (UI strings) or 'dedalo_data_lang' (record data)
*   @param {string} options.lang_value - BCP-47-style language code, e.g. 'lg-spa'
*   @param {Object} options.self       - Menu instance with a change_lang() method
* @returns {Promise<boolean>} Always resolves to true (reload fires before return)
*/
const change_lang = async function(options) {

	// options
		const lang_type		= options.lang_type
		const lang_value	= options.lang_value
		const self			= options.self

	// set page style as loading
		const main = document.getElementById('main')
		if (main) {
			main.classList.add('loading')
		}

	// api call
		await self.change_lang({
			lang_type,
			lang_value
		})

	// reload window after the change
		window.location.reload(false);


	return true
}//end change_lang



// @license-end
