// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {get_instance} from '../../common/js/instances.js'



/**
* RENDER_COMMON_SECTION
* Namespace for UI helpers shared across all section render modes (edit, list, solved, etc.).
*
* Unlike render_edit_section / render_list_section — which each own a single mode-specific
* render entry-point — this module provides cross-cutting utilities that are called from
* multiple render modes and from section.js itself. Currently exports:
*
*   - render_common_section          – empty namespace constructor (no-op)
*   - render_common_section.render_delete_record_dialog
*       Opens a <dd-modal> that lets the user delete a single record (by section_id) or
*       all currently found records (by sqo). Includes a collapsible relation-list panel
*       that warns about linked records before deletion.
*   - render_relation_list           – standalone helper that builds the collapsed relation-
*       list panel; also used by the inspector panel outside of delete dialogs.
*   - no_records_node                – creates the "No records found" placeholder element.
*   - NON_EDITABLE_SECTION_TIPOS     – the read-only section tipos whose list toolbar
*       carries only the search controls (no other-buttons drawer/toggle).
*
* All three exported helpers depend on the global `get_label` object for localised strings
* and on `ui` (core/common/js/ui.js) for DOM construction.
*/
export const render_common_section = function() {

	return true
}//end render_common_section



/**
* NON_EDITABLE_SECTION_TIPOS
* Section tipos whose list toolbar carries ONLY the search controls: no
* "other buttons" drawer and no show_other_buttons_button toggle.
*
* They are the read-only system surfaces — the consultation-only logs Activity
* (dd542) and Time machine (dd15) (WC-010 + WC-2026-10-06-consultation-only-no-section-tools)
* plus the registered-tools section (dd1324) — which carry no action buttons and
* no section tools, so the drawer would only ever be an empty, dead affordance.
*
* ONE list for every section list view (view_default_list_section,
* view_graph_list_section): while it lived as two separate literals, dd15 was
* present in neither drawer list and kept a toggle on the Time machine list
* while Activity correctly had none. Keep it here — do not re-inline it.
*/
export const NON_EDITABLE_SECTION_TIPOS = [
	'dd542',  // activity
	'dd15',   // time machine
	'dd1324'  // registered tools
]


/**
* IS_NON_TOOLS_SECTION
* True when a section list view must render ONLY the search controls — no
* other-buttons drawer, no section-tools popover.
*
* Two independent cases, ONE decision:
*   1. The consultation-only / registered-tools tipos above (by tipo).
*   2. A section_tool "process" page (oh81 Transcription, oh83 Indexation, …).
*      The node is a virtual alias: `start` reroutes it to its target section
*      (config.target_section_tipo) and the menu rewrites tipo->target, so the
*      section instance carries the TARGET's tipo while `self.config.source_model
*      === 'section_tool'` is the only surviving marker. Its content is driven by
*      the tool config (config.tool_context), not the target section's own
*      toolbar, so the toolbar's tools would act on the wrong surface.
*
* A helper (not another literal) so both list views share the rule and a
* section_tool can never be suppressed in one view and shown in the other.
*/
export const is_non_tools_section = function(self) {
	return NON_EDITABLE_SECTION_TIPOS.includes(self.tipo)
		|| self?.config?.source_model === 'section_tool'
}



/**
* RENDER_DELETE_RECORD_DIALOG
* Builds and opens a <dd-modal> confirmation dialog for deleting section records.
*
* Two deletion modes are supported, determined by whether `options.section_id` is provided:
*
*   - Single-record mode (section_id is set):
*       The dialog header shows "Delete ID: <section_id> [<label>]". The body renders a
*       collapsible `render_relation_list` panel so the user can inspect related records
*       before confirming. Calls `section.delete_section({ delete_mode: 'delete_record', … })`.
*
*   - Batch mode (section_id is NOT set):
*       The dialog header shows a label using `get_label.all_records_found` and the current
*       total. The body shows a prominent warning that ALL currently found records will be
*       deleted. Calls `section.delete_section({ delete_mode: 'delete_data', … })` for the
*       data-only button; record deletion uses `delete_mode: 'delete_record'` and includes
*       the full sqo so the server scopes the batch correctly.
*
* Both modes offer two action buttons:
*   - "Delete record" (danger): removes both data and the record skeleton.
*   - "Delete data only" (warning): wipes component data but leaves the record shell.
*
* A "Delete diffusion records" checkbox (checked by default) is shown in both modes and
* forwarded to `section.delete_section` as `delete_diffusion_records`.
*
* After successful deletion the section total is reset to null and the section is
* refreshed before the modal is closed.
*
* (!) `section_id` and `sqo` are both taken from `options`; in batch mode, `section_id`
*     must be falsy so that the sqo-based deletion path is taken server-side.
*
* @param {Object} options - Configuration object
* @param {Object} options.section      - The live section instance (must have get_total,
*                                        delete_section, refresh, and total properties)
* @param {number|string|null} options.section_id   - Record ID for single-record mode;
*                                                    null/undefined triggers batch mode
* @param {string} options.section_tipo - Ontology tipo of the section (e.g. 'oh1')
* @param {Object} options.sqo          - Search Query Object scoping the batch deletion
* @returns {Object} modal - The <dd-modal> instance returned by ui.attach_to_modal
*/
render_common_section.render_delete_record_dialog = async (options) => {

	// options
		const section = options.section
		if (!section) {
			console.error("render_delete_record_dialog: section is required")
			return false
		}
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo
		const sqo			= options.sqo

	// short vars
		const total			= await section.get_total()
		const label 		= section.label || section_tipo

		// In single-record mode use the id directly; in batch mode show a summary string
		// with the current total so the user knows how many records are affected.
		const id_label 		= section_id
			? section_id
			: get_label.all_records_found || 'All records found' + ' ('+total+')'

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			inner_html		: (get_label.delete || 'Delete') + ` ID: ${id_label} <span class="note">[${label}]</span>`,
			parent			: header
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body content delete_record'
		})

		// warning/relation_list
			if (section_id) {

				// relation_list
				// In single-record mode show the collapsible relation list so the user
				// can see what other records reference this one before confirming.
					const relation_list = render_relation_list({
						self			: section,
						section_tipo	: section_tipo,
						section_id		: section_id
					})
					body.appendChild(relation_list)
			}else{

				// warning
				// Batch mode: no per-record relation panel; show an explicit warning
				// with the affected total so the user understands the scope.
					ui.create_dom_element({
						element_type	: 'h3',
						class_name		: 'warning',
						parent			: body,
						inner_html		:
							(get_label.warning || 'Warning') + '. ' +
							(get_label.delete_found_records || 'All records found will be deleted.') + ' ' +
							(get_label.total || 'Total') + ': '  + total
					})
			}

		// delete diffusion records
		// Checkbox (checked by default) that controls whether the corresponding
		// diffusion/publication records are also purged by the server-side delete handler.
			const delete_diffusion_records_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'block_label unselectable',
				inner_html		: get_label.delete_diffusion_records || 'Delete diffusion records',
				parent			: body
			})
			const delete_diffusion_records_checkbox = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox'
			})
			delete_diffusion_records_checkbox.checked = true
			delete_diffusion_records_label.prepend(delete_diffusion_records_checkbox)

	// footer
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'footer content'
		})

		// button_delete_record
		// "Danger" styled button: removes both data and the record skeleton from the DB.
			const button_delete_record = ui.create_dom_element({
				element_type	: 'button',
				class_name 		: 'danger remove',
				text_content 	: get_label.delete_data_and_record || 'Delete record',
				parent			: footer
			})
			const click_delete_record_handler = (e) => {
				e.stopPropagation()

				if (!confirm(get_label.sure)) {
					return
				}

				// spinner
				const spinner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'spinner spinner_modal',
					parent			: body
				})
				body.classList.add('loading')
				footer.classList.add('loading')

				section.delete_section({
					sqo							: sqo,
					delete_mode					: 'delete_record',
					delete_diffusion_records	: delete_diffusion_records_checkbox.checked
				})
				.then(async () => {
					// force recalculation of total records
					section.total = null
					// refresh section
					await section.refresh()
					// fire modal event on_close
					modal.on_close()
				})
			}
			button_delete_record.addEventListener('click', click_delete_record_handler)

		// button_delete_data
		// "Warning" styled button: wipes component data only; the record shell is preserved.
		// Does NOT forward delete_diffusion_records — diffusion cleanup is skipped for
		// data-only deletes.
			const button_delete_data = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'warning remove',
				text_content	: get_label.delete_data_only || 'delete data',
				parent			: footer
			})
			// event click
			const click_delete_data_handler = (e) => {
				e.stopPropagation()

				if (!confirm(get_label.sure)) {
					return
				}

				// spinner
				const spinner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'spinner spinner_modal',
					parent			: body
				})
				body.classList.add('loading')
				footer.classList.add('loading')

				section.delete_section({
					sqo			: sqo,
					delete_mode	: 'delete_data'
				})
				.then(async () => {
					// force recalculation of total records
					section.total = null
					// refresh section
					await section.refresh()
					// fire modal on_close
					modal.on_close()
				})
			}
			button_delete_data.addEventListener('click', click_delete_data_handler)

	// modal
	// (!) `modal` is captured here and referenced inside click handlers defined above.
	// The handlers close over this variable via the closure; they run after this line
	// executes, so the forward reference is safe.
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'small', // string size small|big|normal
			callback	: (dd_modal) => {
				dd_modal.modal_content.style.width = '34rem'
			}
		})


	return modal
}//end render_delete_record_dialog



/**
* RENDER_RELATION_LIST
* Builds a collapsible panel that lazy-loads a `relation_list` instance for the given
* section record.
*
* The panel is initially collapsed (closed). When the user expands it the first time,
* `get_instance` fetches the `relation_list` model from the server and renders it inside
* the body element. Subsequent pagination events are handled via an `event_manager`
* subscription keyed on `'relation_list_paginator_' + section_tipo`.
*
* Collapse / expand state is persisted to the local IndexedDB via
* `ui.collapse_toggle_track` with the id `'inspector_relation_list'`. This means the
* state is shared across all records that open this panel in the same browser session;
* the last toggle wins.
*
* The subscription token is pushed onto `options.self.events_tokens` so that the
* parent section's `destroy()` lifecycle tears it down correctly.
*
* Lazy-load detail:
*   - On first expand: calls `get_instance({ model: 'relation_list', … })` with a
*     timestamp-suffixed `id_variant` to ensure a fresh instance per dialog opening.
*   - On pagination events: receives the already-initialised `relation_list` instance
*     directly, skipping the `get_instance` call.
*   - Height is preserved during the async re-render via `minHeight` to avoid layout
*     jumps, then cleared after 1 ms.
*
* @param {Object} options
* @param {Object} options.self          - Parent section instance; must expose `events_tokens {Array}`
* @param {string} options.section_tipo  - Ontology tipo of the section (e.g. 'oh1')
* @param {number|string} options.section_id - Record ID whose relations are displayed
* @returns {HTMLElement} relation_list_container - Detached DOM node ready to append
*/
export const render_relation_list = function(options) {

	// options
		const self			= options.self
		const section_tipo	= options.section_tipo
		const section_id	= options.section_id

	// short vars
		const mode			= 'edit'
		// Timestamp suffix ensures each dialog invocation gets a distinct instance key,
		// preventing accidental cache hits from a previous dialog session.
		const id_variant	= section_tipo +'_'+ section_id +'_'+ (new Date()).getTime()

	// wrapper
		const relation_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_container block'
		})

	// relation_list_head
	// Clickable header that drives the collapse/expand toggle; CSS class 'icon_arrow'
	// renders the disclosure arrow via the design system.
		const relation_list_head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_head icon_arrow',
			inner_html		: get_label.relations || 'Relations',
			parent			: relation_list_container
		})

	// relation_list_body
	// Starts hidden ('hide' class); content is injected lazily on first expand.
		const relation_list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_body hide',
			parent			: relation_list_container
		})

	// panel_instance. The relation_list instance THIS panel loaded. The paginator
	// channel is keyed by section_tipo, not by instance, so every panel ever built
	// for this section_tipo hears every page turn — see the handler below.
		let panel_instance = null

	// load_chain. Serializes page turns: two quick clicks on the arrows would
	// otherwise re-enter load_relation_list on the same instance and race on
	// self.node (the later render replaces a node the earlier one is appending).
		let load_chain = Promise.resolve()

	// relation_list events
	// Subscribe to paginator events so that when the embedded paginator fires a page
	// change the panel re-renders with the new page of results without re-init.
		let paginator_token = null
		const relation_list_paginator_handler = (relation_list) => {

			// (!) A dialog that has been closed takes its DOM with it (dd-modal removes
			// itself on close) but NOT its subscription: events_tokens is only drained
			// when the whole caller component is destroyed, so each delete-dialog opening
			// leaves one more listener on this channel. A stale listener re-renders the
			// LIVE instance into its own detached body, stealing the node from the panel
			// the user is looking at and blanking it. Drop it, and unsubscribe on the way.
				if (!relation_list_container.isConnected) {
					if (paginator_token) {
						event_manager.unsubscribe(paginator_token)
					}
					return
				}

			// not this panel's instance (another open panel on the same section_tipo)
				if (relation_list!==panel_instance) {
					return
				}

			relation_list_body.classList.add('loading')
			load_chain = load_chain
				.then(() => load_relation_list(relation_list))
				.then(function(){
					relation_list_body.classList.remove('loading')
				})
		}
		paginator_token = event_manager.subscribe('relation_list_paginator_'+section_tipo, relation_list_paginator_handler)
		self.events_tokens.push(paginator_token)

	// track collapse toggle state of content
	// load_relation_list: async function that (re-)renders the relation_list instance
	// into `relation_list_body`. Called both on first expand and on pagination.
		const load_relation_list = async function(instance) {

			relation_list_head.classList.add('up')

			// spinner
				const spinner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'spinner',
					parent			: relation_list_body
				})

			// If called from a pagination event, `instance` is the existing relation_list;
			// skip get_instance to avoid duplicate initialisation.
			const relation_list	= (instance && instance.model==='relation_list')
				? instance // pagination case do not need to init relation_list
				: await get_instance({
					model			: 'relation_list',
					tipo			: section_tipo,
					section_tipo	: section_tipo,
					section_id		: section_id,
					mode			: mode,
					id_variant		:id_variant
				})

			// panel_instance. Binds the instance to this panel, so paginator events
			// published by any other panel of the same section_tipo are ignored.
				panel_instance = relation_list

			// height preserve
			// Snapshot current height before clearing children so the container
			// does not collapse to zero during the async render, causing a layout flash.
				const height = relation_list_body.getBoundingClientRect().height
				relation_list_body.style.minHeight = height + 'px'

			await relation_list.build()
			const rendered_node = await relation_list.render()

			// render can bail out (illegal status) returning false. Appending it would
			// throw AFTER the body was emptied, leaving the panel permanently blank:
			// keep what is on screen instead.
				if (!(rendered_node instanceof Node)) {
					console.warn('[render_relation_list] invalid render node. Keeping current content:', rendered_node);
					spinner.remove()
					relation_list_body.style.minHeight = null
					return
				}

			while (relation_list_body.firstChild) {
				relation_list_body.removeChild(relation_list_body.firstChild)
			}
			relation_list_body.appendChild(rendered_node)

			// height preserve
			// Release the reserved minimum height after one tick so the browser
			// can recalculate the natural height of the new content.
				setTimeout(function(){
					relation_list_body.style.minHeight = null
				}, 1)
		}
		const unload_relation_list = function() {

			while (relation_list_body.firstChild) {
				relation_list_body.removeChild(relation_list_body.firstChild);
			}
			relation_list_head.classList.remove('up')
		}
		// collapse_toggle_track persists open/closed state to IndexedDB under the key
		// 'inspector_relation_list'. default_state: 'closed' means the panel starts
		// collapsed even on first visit (no stored state).
		ui.collapse_toggle_track({
			toggler				: relation_list_head,
			container			: relation_list_body,
			collapsed_id		: 'inspector_relation_list',
			collapse_callback	: unload_relation_list,
			expose_callback		: load_relation_list,
			default_state		: 'closed'
		})


	return relation_list_container
}//end render_relation_list



/**
* NO_RECORDS_NODE
* Creates a placeholder DOM element to display when a section has no records.
*
* Uses the localised string `get_label.no_records` with a hardcoded English fallback.
* The caller is responsible for appending the returned node to the appropriate
* container (typically the section's list body).
*
* @returns {HTMLElement} node - A <div class="no_records"> element with localised text
*/
export const no_records_node = () => {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'no_records',
		inner_html		: get_label.no_records || 'No records found'
	})

	return node
}//end no_records_node



// @license-end
