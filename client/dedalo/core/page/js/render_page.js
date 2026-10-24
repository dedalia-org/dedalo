// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_NOTIFICATION, Promise, DEDALO_ROOT_WEB, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_PAGE
* Client-side render layer for the Dédalo page shell.
*
* Responsibilities:
* - Builds the outermost page wrapper (div.wrapper.<type>) with a versioned class.
* - Drives async rendering of every page element declared in `self.context`
*   (areas, menus, tools, …) via `ui.load_item_with_spinner`.
* - Shows environment-status banners: version-mismatch recovery, maintenance mode,
*   and recovery mode, all gated by `page_globals` flags set by the PHP API.
* - Publishes the `render_page` event once all context elements have resolved.
* - Exports `render_notification_msg` for use by `page.js` when the
*   `dedalo_notification` event arrives (from config or lock events).
*
* Main exports:
*   render_page            — constructor; prototype.edit assigned to page.prototype.edit
*   render_notification_msg — renders/updates/removes the global notification banner
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {instantiate_page_element} from './page.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {render_job_tray} from './job_tray.js'
	import {render_build_failure} from '../../common/js/render_api_error.js'



/**
* RENDER_PAGE
* Constructor for the page render object.
* Returns true so that prototype methods can be assigned against it via
* `render_page.prototype.*` and then delegated from `page.prototype.edit`.
*/
export const render_page = function() {

	return true
}//end render_page



/**
* EDIT
* Builds and returns the full page wrapper element for the `edit` render mode.
*
* Orchestration:
* 1. Fetches the inner `content_data` element from `get_content_data` which
*    handles version checking, status banners, and async per-element rendering.
* 2. When `render_level === 'content'` the raw content_data node is returned
*    early (used by refresh cycles that only need the inner DOM subtree).
* 3. Otherwise, wraps content_data in a `div.wrapper.<type>` whose class list
*    also includes a sanitised version string (`version_X_Y_Z`) taken from
*    `page_globals.dedalo_version`.
* 4. Attaches `wrapper.content_data` pointer for later traversal, sets
*    `self.node` before returning so that `render_notification_msg` can locate
*    the wrapper immediately via `self.node`.
* 5. Appends `div.bubbles_notification_container` as a sibling notification slot
*    and stores its reference on `self.bubbles_notification_container`.
*
* @param {Object} options - Render options passed by the page lifecycle.
* @param {string} [options.render_level='full'] - 'full' builds the whole shell;
*   'content' returns only the inner content_data element.
* @returns {Promise<HTMLElement>} The outer wrapper div, or content_data alone
*   when render_level is 'content'.
*/
render_page.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content data
		const content_data = await get_content_data(self) // result is a promise
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = document.createElement('div')

		// styles
		const classes = ['wrapper',self.type]
		if (page_globals?.dedalo_version) {
			// One class token, whatever the identity holds: '7.0.0-beta.6' →
			// 'version_7_0_0-beta_6'. Anything outside [A-Za-z0-9_-] becomes '_' — a
			// space would make classList.add THROW and take the whole page down with it.
			classes.push( 'version_' + String(page_globals.dedalo_version).replace(/[^A-Za-z0-9_-]/g, '_') )
		}
		wrapper.classList.add(...classes)

		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data
		// fix node before finish render to allow select by render_notification_msg
		self.node = wrapper

	// bubbles_notification_container
		const bubbles_notification_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'bubbles_notification_container',
			parent			: wrapper
		})
		self.bubbles_notification_container = bubbles_notification_container

	// job_tray: the user's own background work, across BOTH job systems. It mounts
	// itself into #floating_dock (document-level, outside this wrapper) on purpose:
	// the wrapper is rebuilt on every area change, and a tray that died with it
	// would lose sight of a transcode the moment the operator navigated away —
	// which is the exact blindness it exists to cure. Idempotent per document; it
	// hides itself when nothing is running.
		render_job_tray()


 	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the inner `div.content_data` element that holds every page element.
*
* Execution order:
* 1. **Version gate**: compares the DATA triple of the runtime release identity
*    (`page_globals.dedalo_version`, e.g. 7.0.0-beta.6 → 7.0.0) with the DB
*    schema `data_version`. If they diverge the
*    function returns early with the maintenance/update widget so the user can
*    upgrade the database — no page elements are rendered.
* 2. **Status banners**: prepends recovery-mode and maintenance-mode banners when
*    the corresponding `page_globals` flags are set. Both can appear simultaneously
*    (recovery mode is more severe: the ontology may be corrupted).
* 3. **Boot notification**: if `page_globals.dedalo_notification` is defined and
*    the user is logged in, publishes the `dedalo_notification` event inside a
*    `requestAnimationFrame` so that `self.node` (set in `edit()` after this
*    function returns) is guaranteed to exist when the subscriber fires.
* 4. **Per-element async render loop**: iterates over `self.context` (the ordered
*    list of page elements returned by the server API). Each element is rendered
*    via `ui.load_item_with_spinner` which shows a placeholder spinner while the
*    element's JS module loads and its `build()` + `render()` methods run.
*    - Non-destroyable instances (e.g. the main menu) are re-attached from
*      `self.ar_instances` rather than re-built, avoiding a full reload.
*    - On build failure or exception the element slot shows a `div.error_alert`
*      rather than leaving a blank hole.
*    - Successfully built instances are pushed onto `self.ar_instances` so that
*      `page.destroy()` and navigation can locate them later.
* 5. **`render_page` event**: fires after all per-element promises settle, wrapped
*    in a `requestAnimationFrame` to allow CSS animations to start cleanly.
*    `Promise.all` is intentionally not awaited here — rendering continues in the
*    background; `content_data` is returned as soon as the loop is launched so the
*    wrapper node can be appended to the live DOM.
*
* @param {Object} self - The page instance (exposes `.context`, `.ar_instances`, `.type`).
* @returns {Promise<HTMLElement>} The populated `div.content_data` element.
*/
const get_content_data = async function(self) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.type)

	// update_data_version
	// When the data is not updated, stop load page and require the recovery key
	// if user provide the correct key, load the update data widget.
		// check the data and code versions
		// `dedalo_version` is the code's RELEASE IDENTITY ('7.0.0-beta.6') — never
		// compared. The server publishes the code's DATA triple beside it
		// (`dedalo_data_version`, '7.0.0'), and that bare string is what must equal
		// the stored `data_version` (an array or a plain string). Deriving it from
		// the identity (common/js/release_identity.js — never a dot-split) is only
		// the fallback for a page_globals without the key; lazy, so the boot graph
		// stays within its shrink-only budget (test/unit/page_load_budget_native.test.ts).
		const code_data_version	= page_globals?.dedalo_data_version
			?? (page_globals?.dedalo_version
				? (await import('../../common/js/release_identity.js')).data_version_of(page_globals.dedalo_version)
				: '')
		const data_version		= Array.isArray(page_globals?.data_version) ? page_globals.data_version.join('.') : (page_globals?.data_version || '')
		const versions_differ	= Boolean(code_data_version && data_version && code_data_version!==data_version)

		if( versions_differ ){
			// Lazy (engineering/CONVENTIONS.md §2, rationale 3 — rarely hit): only a
			// data/code version mismatch renders this widget, so it stays off the
			// boot graph (test/unit/page_load_budget_native.test.ts).
			const { render_update_data_maintenance } = await import('../../area_maintenance/js/render_update_data_maintenance.js')
			const update_data_node = await render_update_data_maintenance()
			content_data.appendChild(update_data_node)
			return content_data
		}

	// dedalo_recovery_mode. maintenance_msg (defined in config and get from environment)
		if(page_globals.recovery_mode===true){
			const recovery_container = render_recovery_msg()
			content_data.prepend(recovery_container)
		}

	// dedalo_maintenance_mode. maintenance_msg (defined in config and get from environment)
		if(page_globals.maintenance_mode===true){
			const maintenance_container = render_maintenance_msg()
			content_data.prepend(maintenance_container)
		}

	// dedalo_notification. notification_msg (defined in config and get from environment)
	// Wrapped in requestAnimationFrame to ensure self.node (wrapper) is set in edit() before publishing
		if(typeof page_globals.dedalo_notification!=='undefined' && page_globals.is_logged===true) {
			requestAnimationFrame(() => {
				event_manager.publish('dedalo_notification', page_globals.dedalo_notification)
			})
		}

	// add all instance rendered nodes
		// async mode: kick off all elements in parallel and collect their promises.
		// Spinners are appended immediately; actual nodes swap in as each resolves.
		const render_promises = []
		const context_length = self.context.length
		for (let i = 0; i < context_length; i++) {

			const current_context = self.context[i]

			// menu case. Prevent to render again on refresh page
			// The main menu has destroyable===false; re-use its existing DOM node
			// instead of re-instantiating so menu state (open/close) is preserved.
				const non_destroyable_instance = self.ar_instances.find(el => el.model===current_context.model && el.destroyable===false)
				if (non_destroyable_instance) {
					content_data.appendChild(non_destroyable_instance.node)
					continue;
				}

			// load_item_with_spinner
			// Appends a labelled spinner placeholder to `content_data`, then calls
			// the callback asynchronously; the callback's returned node replaces the
			// spinner once ready.
				const render_promise = ui.load_item_with_spinner({
					container			: content_data,
					preserve_content	: true,
					label				: current_context.label || current_context.model,
					model				: current_context.model,
					callback			: async () => {
						// instance
						const current_instance = await instantiate_page_element(
							self, // object page instance
							current_context // object is used as source
						)
						// if the instance doesn't exist stop.
						if(!current_instance){
							return null;
						}

						// store instance so that it can be located on destroy page
						if (!self.ar_instances.includes(current_instance)) {
							self.ar_instances.push(current_instance)
						}

						// build (load data)
						// build() returns false when the instance cannot resolve its
						// context or data (e.g. insufficient permissions). In that case
						// emit a descriptive error_alert rather than a blank slot.
						try {
							const build_result = await current_instance.build(true)
							if (build_result === false) {
								// on_retry: a transient failure (server restarting, timeout)
								// rebuilds just this element; still failing → a fresh banner.
								const on_retry = async () => {
									const retry_result = await current_instance.build(true)
									return retry_result === false
										? render_build_failure({instance: current_instance, on_retry})
										: await current_instance.render()
								}
								return render_build_failure({instance: current_instance, on_retry})
							}

							// render node
							const node = await current_instance.render()

							return node || ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'error_alert',
								text_content	: 'Error on render element ' + current_instance.model
							})
						} catch (e) {
							console.error(`Exception building/rendering "${current_instance.model}":`, e)
							return ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'error_alert',
								text_content	: `Exception on element "${current_instance.model}": ` + e.message
							})
						}
					}
				})
				render_promises.push(render_promise)
		}//end for (let i = 0; i < context_length; i++)

	// render is complete
	// (!) Promise.all is not awaited: content_data is returned immediately so the
	// caller can attach it to the live DOM while elements continue loading. The
	// `render_page` event fires in a rAF once all promises settle, giving
	// subscribers (e.g. area_thesaurus focus logic) a stable post-render hook.
		Promise.all(render_promises)
		.then(()=>{
			// event publish (wait for current animations / DOM swaps)
			requestAnimationFrame(() => {
				event_manager.publish('render_page')
			})
		})
		.catch(err => console.error("Error rendering page components:", err));


	return content_data
}//end get_content_data



/**
* RENDER_MAINTENANCE_MSG
* Builds and returns a banner element shown when `page_globals.maintenance_mode === true`.
* The banner text is taken from the i18n label `get_label.site_under_maintenance`
* (set by the PHP environment) with a hard-coded fallback string.
* Prepended to `content_data` so it appears above all page elements.
* @returns {HTMLElement} div.maintenance_container containing the message span.
*/
const render_maintenance_msg = function() {

	// maintenance_container
	const maintenance_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'maintenance_container'
	})

	// maintenance_msg
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'maintenance_msg',
		inner_html		: '<span style="font-size:2rem"> 👩🏽‍💻 </span> ' + (get_label.site_under_maintenance || 'System in maintenance'),
		parent			: maintenance_container
	})

	return maintenance_container
}//end render_maintenance_msg



/**
* RENDER_RECOVERY_MSG
* Builds and returns a high-visibility error banner shown when
* `page_globals.recovery_mode === true`, indicating the main ontology may be
* corrupted. The banner uses both the `recovery_container` and `error` CSS classes
* so it is rendered in a distinct error style separate from the maintenance banner.
* The message text is taken from `get_label.site_in_recovery_mode` with fallback.
* Prepended to `content_data` before any page elements are rendered.
* @returns {HTMLElement} div.recovery_container.error containing the warning message.
*/
const render_recovery_msg = function() {

	// recovery_container
	const recovery_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'recovery_container error'
	})

	// recovery_msg
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'recovery_msg',
		inner_html		: '<span style="font-size:2rem"> 🥵 </span> ' + (get_label.site_in_recovery_mode || 'WARNING: The system is in recovery mode, your main ontology is probably damaged!'),
		parent			: recovery_container
	})


	return recovery_container
}//end render_recovery_msg



/**
* RENDER_NOTIFICATION_MSG
* Renders, updates, or removes the global page-level notification banner.
*
* Called by `page.js` in response to the `dedalo_notification` event, which is
* published from two sources:
*   - `page_globals.dedalo_notification` set in the PHP config (boot-time).
*   - The `update_lock_components_state` event handler in page.js (runtime lock updates).
*
* Behaviour:
* - `dedalo_notification === null/undefined/falsy`: removes any existing
*   `wrapper.notification_container` from the DOM and resets `self.last_dedalo_notification`.
* - Identical notification (same `msg` + `class_name` as the last rendered one):
*   silently ignored to prevent redundant DOM mutations during repeated publishes.
* - New or changed notification: creates `div.notification_container` on first call
*   (prepended to `wrapper`) or clears its children for updates, then inserts a
*   `span.notification_msg.<class_name>` with the message and triggers a CSS
*   `fade-in` animation via `requestAnimationFrame`.
*
* Side effects:
* - Sets/unsets `wrapper.notification_container` (DOM pointer stored on the node itself).
* - Updates `self.last_dedalo_notification` after each successful render.
*
* (!) `self.node` must be set before this function is called. The boot-time
* notification publish in `get_content_data` is deferred to `requestAnimationFrame`
* specifically to ensure `self.node` is assigned first.
*
* @param {Object} self - The page instance; must have `.node` and
*   `.last_dedalo_notification` properties.
* @param {Object|null} dedalo_notification - Notification descriptor, or null/falsy
*   to dismiss any existing banner.
*   Shape: `{ msg: {string}, class_name: {string} }`
*   Example: `{ msg: "Testing the notification system", class_name: "warning" }`
* @returns {HTMLElement|null} The rendered `span.notification_msg` element, or null
*   when the notification was dismissed, unchanged, or `self.node` was missing.
*/
export const render_notification_msg = function( self, dedalo_notification ) {

	// wrapper node
		const wrapper = self.node
		if (!wrapper) {
			return null
		}

	// empty case
		if (!dedalo_notification) {
			if (wrapper.notification_container) {
				wrapper.notification_container.remove() // remove node
				wrapper.notification_container = null // set pointer
				if(SHOW_DEBUG===true) {
					console.warn('))) Removed wrapper.notification_container:', dedalo_notification);
				}
			}
			// fix to compare with next requests
			self.last_dedalo_notification = null

			return null
		}

	// check for real changes. If is the same value, ignore it
		if (self.last_dedalo_notification &&
			self.last_dedalo_notification.msg===dedalo_notification.msg &&
			self.last_dedalo_notification.class_name===dedalo_notification.class_name
			) {
			if(SHOW_DEBUG===true) {
				console.warn('))) Ignored dedalo_notification unchanged:', dedalo_notification);
			}
			return null
		}

	// notification_container
		if (!wrapper.notification_container) {
			// create a new one
			wrapper.notification_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'notification_container'
			})
			// prepend to main node
			wrapper.prepend(wrapper.notification_container)
		}else{
			// clean already existing container
			while (wrapper.notification_container.firstChild) {
				wrapper.notification_container.removeChild(wrapper.notification_container.firstChild);
			}
		}

	// dedalo_notification
		const msg			= dedalo_notification.msg || 'Unknown notification'
		const class_name	= dedalo_notification.class_name || ''

	// notification_msg
		const notification_msg = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'notification_msg ' + class_name,
			inner_html		: msg,
			parent			: wrapper.notification_container
		})
		// css animation fade
		requestAnimationFrame(
			() => {
				notification_msg.style.setProperty('--speed', '1s');
				notification_msg.classList.add('fade-in')
			}
		)

	// fix to compare with next requests. Clone object to avoid reference mutation bugs
	self.last_dedalo_notification = Object.assign({}, dedalo_notification)


	return notification_msg
}//end render_notification_msg



// @license-end
