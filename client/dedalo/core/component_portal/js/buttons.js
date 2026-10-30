// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL, SHOW_DEBUG*/
/*eslint no-undef: "error"*/



// imports
	import { event_manager } from '../../common/js/event_manager.js'
	import { get_instance } from '../../common/js/instances.js'
	import { ui } from '../../common/js/ui.js'
	import { render_value } from '../../common/js/utils/render_escape.js'
	import { render_open_list_with_direct_relations } from '../../section/js/render_open_list_with_direct_relations.js'
	import {
		clone,
		object_to_url_vars,
		open_window,
		get_caller_by_model
	} from '../../common/js/utils/index.js'
	import { ApiError, CLIENT_ERROR } from '../../common/js/api_error.js'
	import { handle_api_error } from '../../common/js/error_dispatch.js'



/**
* BUTTONS
* Factory namespace for all action-button DOM elements rendered by component_portal.
*
* Each exported function creates one `<span>` button node, binds its event
* listeners, and returns the node ready to be appended by the caller view
* (e.g. view_default_edit_portal, view_line_edit_portal).
*
* The `self` argument received by every factory is the live component_portal
* instance. Key properties consulted:
*   - self.target_section {Array<{tipo:string,label:string}>} — ordered list of
*     section types this portal can point to (derived from request_config_object
*     .sqo.section_tipo during build()).
*   - self.rqo {Object} — the current Request Query Object sent to the server.
*   - self.data {Object} — the last resolved data payload from the server,
*     containing `entries` (Array of {section_tipo, section_id, …} locators).
*   - self.events_tokens {Array} — token list managed by component_common; push
*     event_manager subscription tokens here so they are cleaned up on destroy().
*   - self.id_base {string} — stable identifier prefix used for pub/sub events.
*   - self.modal {Object|null} — reference to the active dd-modal, written by
*     render_button_link so that downstream code (e.g. set_value handlers) can
*     close it programmatically.
*
* Exported: buttons (namespace object, not a class).
*/
export const buttons = () => {}



/**
* RENDER_BUTTON_UPDATE_DATA_EXTERNAL
* Creates a 'sync' button that forces the server to recalculate the portal's
* external data source and then re-renders the component content.
*
* This is relevant only when the portal's source.mode is 'external' (the
* context properties define an external data provider rather than a user-
* managed relation list).  Clicking the button injects the
* `get_data_external: true` flag into rqo.source.build_options before calling
* self.refresh(); the server read path then recomputes the observed mirror
* (the same recompute an observer save runs), persists it only when it drifted,
* and answers the refreshed value.  The legacy v6 spelling `get_dato_external`
* is NOT honoured by the server.
*
* The flag is SINGLE-USE: `build_options` is deleted once the refresh settles
* (finally), so later reads of the same rqo (pagination, refresh after an edit)
* do not re-trigger the recompute.
*
* Permission: refresh is a READ-level action (the mirror is a pure function of
* committed data), so the button is offered at permissions >= 1 too — see
* get_buttons_by_permissions in render_edit_component_portal.js.
*
* Guard: if self.rqo.source is absent the handler logs an error and aborts
* rather than attempting to write a property on undefined.
*
* In flight: the button is DISABLED (class 'loading', aria-disabled) from the
* click until the refresh settles, and a click while one is in flight is
* ignored — one refresh at a time per button, so repeated clicks never stack
* server recomputes behind the same row lock.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement} Span element with class 'button sync'.
*/
buttons.render_button_update_data_external = (self) => {

	// button_update data external
	const button_update_data_external = ui.create_dom_element({
		element_type	: 'span',
		title			: get_label.update || 'Update',
		class_name		: 'button sync'
	})

	// in flight: one refresh at a time (see header)
	let in_flight = false

	// event click
	const update_data_external_click_handler = async function(e) {
		e.stopPropagation()

		if (in_flight) {
			return
		}

		// Validate source exists before modifying
		if (!self.rqo?.source) {
			console.error('Cannot update: source is not available');
			return;
		}

		in_flight = true
		button_update_data_external.classList.add('loading')
		button_update_data_external.setAttribute('aria-disabled', 'true')

		// force server data to calculate external data (single use: removed once the
		// refresh settles, so the flag never rides a later read of this rqo)
		const source = self.rqo.source
		source.build_options = {
			get_data_external : true
		}
		// refresh
		try {
			await self.refresh({
				build_autoload	: true,
				render_level	: 'content'
			})
		} finally {
			Reflect.deleteProperty(source, 'build_options')
			in_flight = false
			button_update_data_external.classList.remove('loading')
			button_update_data_external.removeAttribute('aria-disabled')
		}
	}
	button_update_data_external.addEventListener('click', update_data_external_click_handler)


	return button_update_data_external
}//end render_button_update_data_external



/**
* RENDER_BUTTON_ADD
* Creates an 'add' button that creates a new related section record inline,
* then immediately opens it in a modal for the user to fill in.
*
* Flow:
*  1. The target section list is sorted alphabetically by label so the first
*     element is always the lexicographically earliest section type.
*  2. When exactly one target section type is configured, its tipo is used
*     directly.  When more than one is configured, target_section_tipo is set
*     to false and an alert is shown (multi-target add is not supported here;
*     the button itself is hidden by build() in that case).
*  3. self.add_new_element() POSTs to the API to create the record and returns
*     true on success, leaving the created record's address in
*     self.created_section_id (the server's created_section_id, WC-081).  That
*     address names the record to open; the pre-WC-081 heuristic — the LAST
*     entry of self.data.entries — remains as the fallback, and is only correct
*     when the echoed page ends on the new record.
*  4. A section instance is built and rendered in a modal.  On modal close,
*     self.refresh() is called and 'add_row_<id>' is published so row views
*     can animate/scroll to the new entry.
*  5. The global service_autocomplete (if active) is destroyed after the click
*     to avoid stale autocomplete overlays.
*
* Guards: alerts (not console.error) are used for validation failures so the
* user sees explicit feedback — this matches the existing UI contract in the
* portal.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement} Span element with class 'button add'.
*/
buttons.render_button_add = (self) => {

	const target_section		= self.target_section || []
	const target_section_length	= target_section.length

	// sort section by label ascendant
	target_section.sort((a, b) => (a.label > b.label) ? 1 : -1)

	const button_add = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button add',
		title			: get_label.new || 'New'
	})

	// event click
	const add_click_handler = async function(e) {
		e.stopPropagation()

		if (target_section_length === 0) {
			alert('Error. No target sections available');
			return
		}

		// target_section_tipo. to add section selector
		const target_section_tipo = target_section_length > 1
			? false
			: target_section[0]?.tipo
		if (!target_section_tipo) {
			alert('Error. Empty or invalid target_section');
			return
		}

		// add_new_element
		try {
			const result = await self.add_new_element(target_section_tipo)
			if (result===true) {

				// Validate data structure
				if (!self.data?.entries || !Array.isArray(self.data.entries) || self.data.entries.length === 0) {
					console.error('Invalid data structure');
					return;
				}

				// new_value. The record to open, by ADDRESS: the server reports the
				// section_id it created (created_section_id). The fallback is the old
				// heuristic — the last echoed entry — which only names the new record
				// when the echoed page ends on it.
				const created_section_id = self.created_section_id ?? null
				const last_value	= self.data.entries[self.data.entries.length-1]
				const new_value		= created_section_id!==null
					? (self.data.entries.find(el =>
						el.section_tipo===target_section_tipo &&
						String(el.section_id)===String(created_section_id)
					) ?? {
						// Not on the echoed page (an older server, or a page that does
						// not end on it): the address alone is enough to open it.
						section_tipo	: target_section_tipo,
						section_id		: created_section_id
					})
					: last_value
				const section_tipo	= new_value.section_tipo
				const section_id	= new_value.section_id

				// header
				// (!) attach_to_modal parses a string header as HTML: the section label
				// is ontology data and goes through the ONE escaper as text.
				const header = (get_label.new || 'New section') + ' ' + render_value(target_section[0]?.label || '', 'text')

				// body section. Create the new section instance
				const section = await get_instance({
					model			: 'section',
					mode			: 'edit',
					tipo			: section_tipo,
					section_tipo	: section_tipo,
					section_id		: section_id,
					inspector		: false,
					session_save	: false,
					session_key		: 'section_' + section_tipo + '_' + self.tipo
				})
				await section.build(true)
				const section_node = await section.render()

				// modal. Create a modal to attach the section node
				const modal = ui.attach_to_modal({
					header		: header,
					body		: section_node
				})
				modal.on_close = function(){
					self.refresh().then(()=>{
						event_manager.publish('add_row_'+ self.id)
					})
				}

				// activate_first_component. Get the first ddo in ddo_map to be focused
				ui.activate_first_component({
					section	: section
				})
			}//end if (result===true)
		} catch (error) {
			console.error('Error adding new element:', error);
			// client-side failure: one ApiError through the same policy/renderer
			// as a server refusal (no blocking browser dialog)
			handle_api_error(new ApiError({
				code	: CLIENT_ERROR.BAD_RESPONSE,
				message	: 'An error occurred while adding the new element',
				raw		: error
			}), {wrapper: self.node});
		}

		// Clean up. Remove aux items
		if (window.page_globals.service_autocomplete) {
			window.page_globals.service_autocomplete.destroy(true, true, true)
		}
	}
	button_add.addEventListener('click', add_click_handler)


	return button_add
}//end render_button_add



/**
* RENDER_BUTTON_LINK
* Creates a 'link' button that opens an iframe-based section-list modal so the
* user can browse existing records and link one to the portal.
*
* The iframe URL points to the target section in 'list' mode and passes
* `initiator=self.id` so the list page can call back to this portal instance
* (via event_manager or window.opener) when the user selects a record.
*
* When multiple target sections are configured a `<select>` element is added
* to the modal header; changing the selection reloads the iframe to the chosen
* section type.  For a single target section the select is rendered with class
* 'mono' (visually hidden in CSS) but the DOM element is still present.
*
* A reference to the modal is stored on self.modal so that downstream handlers
* (e.g. the set_value callback inside component_portal.js) can close it after
* the user picks a record.
*
* Guard: returns null early (with a console.warn) if target_section is empty,
* preventing render errors when the portal context lacks a configured section.
*
* (!) The cleanup function registered on self.modal.cleanup uses anonymous
* functions for removeEventListener, which means the listeners are NOT actually
* removed (anonymous functions cannot be de-registered by reference). This is a
* known pre-existing limitation — do not attempt to fix it here.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement|null} Span element with class 'button link', or null
*   when no target sections are configured.
*/
buttons.render_button_link = (self) => {

	const target_section		= self.target_section || []
	const target_section_length	= target_section.length

	// Validate target_section exists
	if (target_section_length === 0) {
		console.warn('No target sections available for button link', self);
		return null;
	}

	const button_link = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button link',
		title			: get_label.link_resource || 'Link resource'
	})
	// event mousedown
	const mousedown_handler = async function(e) {
		e.stopPropagation()

		const section_tipo = target_section[0]?.tipo;
		if (!section_tipo) {
			alert("Error on get section_tipo");
			return
		}

		// iframe
		( () => {

			const get_iframe_url = (tipo) => {

				const session_key = 'section_' + tipo + '_' + self.tipo

				const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
					tipo		: tipo,
					mode		: 'list',
					session_key	: session_key, // used to save server and local DDB custom SQO
					menu		: false,
					initiator	: self.id // initiator is the caller (self)
				})

				return url
			}

			// modal_body
				const iframe_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'iframe_container'
				})
				const iframe = ui.create_dom_element({
					element_type	: 'iframe',
					class_name		: 'fixed',
					src				: get_iframe_url(section_tipo),
					parent			: iframe_container
				})

			// modal_header
				// header_custom
				const header_custom = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'header_custom'
				})
				// header label
				ui.create_dom_element({
					element_type	: 'span',
					inner_html		: get_label.section,
					class_name		: 'label',
					parent			: header_custom
				})

			// select_section
				const select_section = ui.create_dom_element({
					element_type	: 'select',
					class_name		: 'select_section' + (target_section_length===1 ? ' mono' : ''),
					parent			: header_custom
				})
				// named handlers so cleanup() can remove the same references later
				const select_click_handler = function(e){
					e.stopPropagation()
				}
				const select_mousedown_handler = function(e){
					e.stopPropagation()
				}
				const select_change_handler = function(){
					iframe.src = get_iframe_url(this.value)
				}
				select_section.addEventListener('click', select_click_handler)
				select_section.addEventListener('mousedown', select_mousedown_handler)
				select_section.addEventListener('change', select_change_handler)
				// options for select_section
					for (let i = 0; i < target_section_length; i++) {
						const item = target_section[i]
						ui.create_dom_element({
							element_type	: 'option',
							value			: item.tipo,
							inner_html		: render_value(item.label + ' [' + item.tipo + ']', 'text'),
							parent			: select_section
						})
					}

			// fix modal to allow close later, on set value
			// Note: Store modal reference on self to allow external control/cleanup
				try {
					self.modal = ui.attach_to_modal({
						header	: header_custom,
						body	: iframe_container,
						footer	: null,
						size	: 'big'
					})
					// Store cleanup function on modal for potential cleanup
					self.modal.cleanup = function() {
						// Remove event listeners by reference (the previous version passed
						// brand-new anonymous functions, so removeEventListener was a no-op).
						select_section.removeEventListener('click', select_click_handler)
						select_section.removeEventListener('mousedown', select_mousedown_handler)
						select_section.removeEventListener('change', select_change_handler)
					}
				} catch (error) {
					console.error('Error creating modal:', error);
					handle_api_error(new ApiError({
						code	: CLIENT_ERROR.BAD_RESPONSE,
						message	: 'An error occurred while opening the link dialog',
						raw		: error
					}), {wrapper: self.node});
				}
		})()

		return
	}
	button_link.addEventListener('mousedown', mousedown_handler)


	return button_link
}//end render_button_link



/**
* RENDER_BUTTON_LIST
* Creates a 'pen' (open-list) button that opens the target section's list view
* in a new browser window.
*
* The button title is the human-readable label of the first (and typically
* only) target section.  When SHOW_DEBUG is true, the section's tipo string is
* appended in brackets to aid development.  HTML tags are stripped from the
* label before it is used as a tooltip value.
*
* When the new window is blurred (user switches back to the main tab), the
* portal calls self.refresh() with build_autoload:true to pick up any changes
* made in the separate window.
*
* Guard: returns null with a console.error if target_section is empty or
* DEDALO_CORE_URL is undefined at click time.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement|null} Span element with class 'button pen', or null
*   when no target sections are configured.
*/
buttons.render_button_list = (self) => {

	const target_section	= self.target_section || []
	const first_section		= target_section[0] || null

	// Validate first_section exists
	if (!first_section) {
		console.error('No target section available for list button');
		return null;
	}

	// label
	const label = (SHOW_DEBUG === true)
		? `${first_section.label || 'Unknown'} [${first_section.tipo || 'Unknown'}]`
		: (first_section.label || 'Unknown')

	// Ensure label is a string before using replace
	const clean_label = typeof label === 'string'
		? label.replace(/(<([^>]+)>)/ig, '')
		: 'Unknown'

	const button_list = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button pen',
		title			: clean_label
	})

	// event mousedown
	const mousedown_handler = function(e){
		e.stopPropagation()

		// Validate required dependencies
		if (typeof DEDALO_CORE_URL === 'undefined') {
			console.error('DEDALO_CORE_URL is not defined');
			return;
		}

		try {

			// open a new window
			const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
				tipo	: first_section.tipo,
				mode	: 'list',
				menu	: false
			})
			open_window({
				url		: url,
				name	: 'section_view',
				width	: 1280,
				height	: 740,
				on_blur : () => {
					// refresh current instance
					self.refresh({
						build_autoload : true
					})
				}
			})

		} catch (error) {
			console.error('Error opening window:', error);
		}
	}//end mousedown_handler
	button_list.addEventListener('mousedown', mousedown_handler)


	return button_list
}//end render_button_list



/**
* RENDER_LIST_FROM_COMPONENT_DATA_BUTTON
* Creates a 'list' button that opens the render_open_list_with_direct_relations
* dialog, which lets the user view all records directly related to this portal
* either for the current record only or for the full found set.
*
* The button is hidden via the CSS class 'hide' until at least one entry is
* present in self.data.entries.  Visibility is maintained reactively by
* subscribing to 'update_value_<id_base>' events, which are published whenever
* the portal's data changes (e.g. after save or refresh).  The subscription
* token is pushed to self.events_tokens so it is cleaned up on destroy().
*
* The options bag forwarded to render_open_list_with_direct_relations includes:
*   - sqo: a CLONE of the parent section's current Search Query Object (from
*     caller_section.rqo.sqo), which the dialog scopes per the user's choice.
*     Cloned here because that object is the parent section's live pagination
*     state — it must not move behind the user's back.
*   - caller_tipo / rqo_options: locator information so the dialog can build
*     the correct raw-read API request for this specific portal component.
*   - label / total: display strings shown in the dialog body.
*   - self_caller: the parent section — opener of the spawned windows and the
*     source of the found-records total.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement} Span element with class 'button list'.
*/
buttons.render_list_from_component_data_button = (self) => {

	const list_from_component_data_button = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button list',
		title			: get_label.list_from_component_data || 'List from component data'
	})

	// event mousedown. Add listener to the button
	const mousedown_handler = async (e) => {
		e.stopPropagation()

		const caller_section = get_caller_by_model(self, 'section')
		if (!caller_section) {
			console.error('Error. No caller section found');
			return
		}

		const options = {
			sqo	: clone(caller_section.rqo?.sqo || {}),
			caller_tipo		: self.tipo,
			rqo_options		: {
				type			: 'component',
				section_tipo	: self.section_tipo,
				tipo			: self.tipo,
				model			: self.model
			},
			label		: self.label,
			total		: caller_section.total ?? 0,
			// the parent section: opener of the spawned windows and the source
			// of the found-records total shown in the dialog body.
			self_caller	: caller_section
		}
		render_open_list_with_direct_relations( options )
	}
	list_from_component_data_button.addEventListener('mousedown', mousedown_handler)

	// event change data
	const update_value_handler = () => {

		// Early return if required dependencies are missing
		if (!self?.data || !list_from_component_data_button) {
			console.warn('update_value_handler: Missing required dependencies');
			return;
		}

		const value		= self.data.entries || [];
		const has_data	= value.length > 0;

		// Toggle for display the button
		list_from_component_data_button.classList.toggle('hide', !has_data);
	}
	self.events_tokens.push(
		event_manager.subscribe('update_value_' + self.id_base, update_value_handler)
	)

	// Initial display logic
	// Display only if contains data
    update_value_handler();


	return list_from_component_data_button
}//end render_list_from_component_data_button



/**
* RENDER_BUTTON_TREE_SELECTOR
* Creates a 'tree' button that opens the area_thesaurus or area_ontology window
* in 'relation' mode, allowing the user to browse the hierarchical thesaurus
* and link a term to this portal.
*
* The correct target window (thesaurus vs. ontology) is determined inside
* component_portal.open_ontology_window() based on whether the portal's
* section_tipo belongs to the ontology root (section_id === '0') or to a
* thesaurus section.  This button always passes 'relation' as the mode string.
*
* @param {Object} self - Live component_portal instance.
* @returns {HTMLElement} Span element with class 'button tree'.
*/
buttons.render_button_tree_selector = (self) => {

	const button_tree_selector = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button tree',
		title			: get_label.link_resource || 'Link resource'
	})

	// event mousedown. Add listener to the button
	const mousedown_handler = (e) => {
		e.stopPropagation()

		// show/hide the thesaurus pane — THE picker surface. The pane is mounted on
		// document.body beside this component (never inside it), so a picked term is
		// seen landing here. Never call open_ontology_window with a mode: the mode
		// string it used to pass is no longer a client declaration (the server grants
		// it from the caller).
		//
		// (!) THE GATE IS THE VIEW, NOT A DOM NODE. The pane is created ON DEMAND by
		// toggle_thesaurus_pane and lives outside the wrapper, so querying the wrapper
		// for it — as an earlier version did — finds nothing and sends EVERY click to
		// the separate-window fallback: the window then declares the caller, is granted
		// relation mode by the server, and has no picker wired onto it. What actually
		// decides whether this component picks is its resolved view.
		// Six shipped ontology nodes declare `button_tree:true` WITHOUT a tree view;
		// those keep the separate BROWSE window they had before — a button that does
		// nothing at all is a worse answer than one that opens the tree to look at.
		const view = self.view || self.context?.view || null
		if (view==='tree' && typeof self.toggle_thesaurus_pane==='function') {
			self.toggle_thesaurus_pane().catch(error => {
				console.error('Error toggling the thesaurus pane:', error);
			})
		} else {
			try {
				self.open_ontology_window(null, null)
			} catch (error) {
				console.error('Error opening ontology window:', error);
			}
		}
	}
	button_tree_selector.addEventListener('mousedown', mousedown_handler)


	return button_tree_selector
}//end render_button_tree_selector



// @license-end
