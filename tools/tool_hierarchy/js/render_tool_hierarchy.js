// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_dummy */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_HIERARCHY
* Client-side view layer for tool_hierarchy.
*
* This module provides the DOM rendering logic for the Hierarchy tool, which
* allows operators to generate a new custom Ontology virtual section (a
* "hierarchy1" preset) derived from a caller section. The generated structure
* creates all hierarchy elements required for thesaurus functionality
* (ontology descriptors, dd_ontology entries, general term root nodes).
*
* Architecture:
*   - `render_tool_hierarchy` is a lightweight constructor whose `edit` method
*     is mixed into `tool_hierarchy.prototype.edit` by tool_hierarchy.js.
*   - The main UI work happens in the private `get_content_data` function, which
*     renders six ontology-field components (tld, name, active, typology, lang,
*     real_section_tipo) and a Generate button that fires a server-side API call.
*   - `render_component` is exported so that callers outside this module can
*     reuse the same component-bootstrap pattern if needed.
*
* Ontology tipos used in this form (defined in DEDALO_HIERARCHY_* constants):
*   hierarchy6   — TLD (top-level domain identifier, DEDALO_HIERARCHY_TLD2_TIPO)
*   hierarchy5   — Name / term label (DEDALO_HIERARCHY_TERM_TIPO)
*   hierarchy4   — Active flag (DEDALO_HIERARCHY_ACTIVE_TIPO)
*   hierarchy9   — Typology reference (DEDALO_HIERARCHY_TYPOLOGY_TIPO)
*   hierarchy8   — Language relation (DEDALO_HIERARCHY_LANG_TIPO)
*   hierarchy109 — Real section tipo pointer (DEDALO_HIERARCHY_SOURCE_REAL_SECTION_TIPO)
*
* Exports:
*   render_tool_hierarchy — constructor (prototype carries .edit)
*   render_component      — async component bootstrap helper
*/



// imports
	import {get_instance} from '../../../core/common/js/instances.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {is_api_error, request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {pause, append_text_lines} from '../../../core/common/js/utils/index.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'



/**
* RENDER_TOOL_HIERARCHY
* Constructor for the client-side render delegate of tool_hierarchy.
*
* Instances are never used standalone. tool_hierarchy.js copies
* `render_tool_hierarchy.prototype.edit` onto `tool_hierarchy.prototype.edit`
* so that the tool_common render pipeline calls it as `self.edit(options)`.
*
* @returns {boolean} Always returns true (no-op; fulfils prototype convention).
*/
export const render_tool_hierarchy = function() {

	return true
}//end render_tool_hierarchy



/**
* EDIT
* Render tool DOM nodes
* This function is called by render common attached in 'tool_dummy.js'
*
* Entry point called by `tool_common.prototype.render` when `mode === 'edit'`.
* Builds the full wrapper (header + content) or, when `render_level === 'content'`,
* returns only the inner content_data node (used for partial refreshes).
*
* @param {Object} options - Render options passed by tool_common.
* @param {string} [options.render_level='full'] - 'full' returns a wrapped element
*   with header; 'content' returns only the content_data node (no wrapper/header).
* @returns {Promise<HTMLElement>} The constructed wrapper element (render_level 'full')
*   or the raw content_data node (render_level 'content').
*/
render_tool_hierarchy.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Render tool body or 'content_data'
*
* Builds the main body of the tool UI: six ontology-field component instances
* (rendered in edit mode) plus a Generate button. All components are collected
* into `components_instances` so the click handler can validate them in bulk
* and highlight the first invalid one before submitting.
*
* Layout of the returned content_data node:
*   <div.content_data>
*     <h2.user_info>            — instructional heading
*     <div.msg_fields>          — "all fields are mandatory" notice
*     <div.components_container>
*       [6 component nodes]     — tld, name, active, typology, lang, real_section_tipo
*     <div.buttons_container>
*       <button.warning.gear>   — Generate (triggers API call)
*       <span.checkbox-label>
*         <input[checkbox]>     — force_to_create flag
*     <div.messages_container>  — API response messages / errors
*
* @param {Object} self - The tool_hierarchy instance (provides caller context,
*   section_tipo, section_id, ar_instances, get_tool_label, generate_virtual_section).
* @returns {Promise<HTMLElement>} The constructed content_data <div> element.
*/
const get_content_data = async function(self) {

	const fragment = new DocumentFragment()

	// user_info
		ui.create_dom_element({
			element_type	: 'h2',
			class_name		: 'user_info',
			inner_html		: self.get_tool_label('user_info'),
			parent			: fragment
		})

		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'msg_fields',
			inner_html		: self.get_tool_label('all_fields_mandatory') || 'All fields are mandatory',
			parent			: fragment
		})

	// components container
		const components_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'components_container',
			parent 			: fragment
		});

	// components
	// components_instances list
		const components_instances = []

	// tld
	// hierarchy6 (DEDALO_HIERARCHY_TLD2_TIPO) — the top-level domain identifier string
		const tld_component_instance = await render_component(self, 'hierarchy6');
		components_container.appendChild(tld_component_instance.node)
		components_instances.push(tld_component_instance)

	// name
	// hierarchy5 (DEDALO_HIERARCHY_TERM_TIPO) — the human-readable name / term label
		const name_component_instance = await render_component(self, 'hierarchy5');
		components_container.appendChild(name_component_instance.node)
		components_instances.push(name_component_instance)

	// active
	// hierarchy4 (DEDALO_HIERARCHY_ACTIVE_TIPO) — relation to the "active" flag term;
	// validation checks section_id === 1 (the boolean-true term in the thesaurus)
		const active_component_instance = await render_component(self, 'hierarchy4');
		components_container.appendChild(active_component_instance.node)
		components_instances.push(active_component_instance)

	// typology
	// hierarchy9 (DEDALO_HIERARCHY_TYPOLOGY_TIPO) — relation to the hierarchy type term
		const typology_component_instance = await render_component(self, 'hierarchy9');
		components_container.appendChild(typology_component_instance.node)
		components_instances.push(typology_component_instance)

	// lang
	// hierarchy8 (DEDALO_HIERARCHY_LANG_TIPO) — relation to the target language term
		const lang_component_instance = await render_component(self, 'hierarchy8');
		components_container.appendChild(lang_component_instance.node)
		components_instances.push(lang_component_instance)

	// real_section_tipo
	// hierarchy109 (DEDALO_HIERARCHY_SOURCE_REAL_SECTION_TIPO) — the tipo string of the
	// real (non-virtual) section that backs this hierarchy; must be a non-empty string
		const real_st_component_instance = await render_component(self, 'hierarchy109');
		components_container.appendChild(real_st_component_instance.node)
		components_instances.push(real_st_component_instance)

	// status panel
	// The SERVER owns the answer to "is this hierarchy usable?" (one invariant, one
	// checker: core/ontology/hierarchy_state.ts inspectHierarchy). We render its
	// checklist rather than guessing client-side. Before this panel existed the tool
	// was a blind button: you pressed Generate and the hierarchy either worked or
	// silently did not — a General Term locator pointing at a record that was never
	// created left the thesaurus tree empty with nothing on screen to explain why.
		const status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_container',
			parent			: fragment
		})
		render_status_panel(self, status_container) // async; paints when the state arrives

	// buttons container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

		// button_generate — "Activate / repair": converge to the invariant (ensureHierarchy).
		// Idempotent and non-destructive, so it is safe to press on a healthy hierarchy.
			const button_generate = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'warning gear',
				inner_html		: self.get_tool_label('generate'),
				parent			: buttons_container
			})
			// click event
			const click_handler = async (e) => {
				e.stopPropagation();

				// clear_messages: resets all previous error highlights and messages
				// before starting a new validation + submission cycle
				const clear_messages = () => {
					messages_container.classList.remove('error')
					messages_container.innerHTML = ''
					components_instances.forEach(el => el.node.classList.remove('error'))
				}
				clear_messages()

				// set_loading
				// Adds/removes the 'loading' CSS class and a spinner overlay so the UI
				// gives visual feedback while the (potentially slow) server call runs.
				// The spinner is appended to content_data.parentNode (the wrapper), not
				// content_data itself, so it overlays the entire tool area.
					let spinner
					const set_loading = (set) => {
						if (set) {
							content_data.classList.add('loading')
							messages_container.innerHTML = ''
							// spinner
							spinner = ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'spinner',
								parent			: content_data.parentNode
							})
						}else{
							content_data.classList.remove('loading')
							if (spinner) spinner.remove()
						}
					}

				// set error
				// Marks a single component as invalid: adds the 'error' CSS class to its
				// node, activates (focuses) it so the user can see what is wrong, and
				// writes the per-label error message into messages_container.
					const set_error = (instance) => {
						instance.node.classList.add('error')
						ui.component.activate(instance)
						messages_container.textContent =
						  (self.get_tool_label('insert_value') || 'Please, insert a valid value to continue.') + ' ' + instance.label
					}

				// is valid
				// Returns true when the component instance has no data that satisfies
				// condition_fn, calling set_error as a side-effect before returning.
				// Designed to be used with short-circuit OR so validation stops at the
				// first failing field.
					const is_invalid = (instance, condition_fn) => {
						if (!instance.data?.entries || !condition_fn(instance.data?.entries)) {
							set_error(instance)
							return true
						}
						return false
					}

				// check value
				// Only the fields the OPERATOR must supply — the ones the server cannot
				// derive: tld, name, typology, lang.
				//   tld / name       — entries[0].value must be a non-empty string
				//   typology / lang  — entries[0].section_id must be truthy (a term is selected)
				// `active` (hierarchy4) and `real_section_tipo` (hierarchy109) are NO LONGER
				// preconditions: ensureHierarchy SETS them — activating the hierarchy is the
				// job, so refusing to start because it is not yet active was circular, and it
				// is what forced operators to hand-toggle the radio before pressing the button.
				// Validation short-circuits: the first failing field stops the check and
				// focuses that component. Returns false to abort submission.
					if (
						is_invalid(tld_component_instance, val => val?.[0]?.value?.length) ||
						is_invalid(name_component_instance, val => val?.[0]?.value?.length) ||
						is_invalid(typology_component_instance, val => val?.[0]?.section_id) ||
						is_invalid(lang_component_instance, val => val?.[0]?.section_id)
					) return false

				// confirm — and say WHAT will happen, per action.
				// The two actions have genuinely different blast radii, and the old UI hid
				// that behind one generic "Sure?": the plain action is now idempotent and
				// non-destructive (it only ADDS what is missing), while REBUILD deletes the
				// tld's ontology before re-provisioning it. The terms are safe in both cases —
				// the teardown removes the dd_ontology nodes and the '<tld>0' node records,
				// never the '<tld>1' thesaurus records — so that is spelled out too, because
				// an operator who fears for 69,000 terms will never press the button.
				// REBUILD is FROM SCRATCH (owner decision D10): every ontology definition of the
				// hierarchy — own list columns and other custom nodes included — is deleted and
				// re-provisioned; the confirmation says so before anything is sent.
					const rebuild = check_force_to_create.checked
					const confirm_msg = rebuild
						? (self.get_tool_label('confirm_rebuild')
							|| 'REBUILD FROM SCRATCH: every ontology definition of this hierarchy (all its nodes, including any own list columns or other custom definitions, and its ontology record) will be deleted and created again.\n\nThe thesaurus TERMS are NOT deleted.\n\nContinue?')
						: (self.get_tool_label('confirm_activate')
							|| 'Activate / repair this hierarchy?\n\nOnly what is missing will be created. Nothing is deleted.')
					if (!confirm(confirm_msg)) {
						return false
					}

				set_loading(true)

				// API call
				// Delegates to tool_hierarchy.prototype.generate_virtual_section, which
				// POSTs to dd_tools_api with the caller's section_id / section_tipo and
				// the optional force_to_create flag. A try/catch handles network-level
				// failures separately from server-reported errors in the response body.
				let api_response
				try {
					api_response = await self.generate_virtual_section({
						force_to_create : check_force_to_create.checked
					})
				} catch (err) {
					console.error('generate_virtual_section threw:', err)
					messages_container.classList.add('error')
					// ONE error model: an ApiError goes to the dispatcher, anything else
					// is client text (text_content — never an HTML-parsing sink)
					if (is_api_error(err)) {
						await handle_api_error(err, {wrapper: messages_container})
					}else{
						ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'error',
							text_content	: 'Unexpected error: ' + err.message,
							parent			: messages_container
						})
					}
					set_loading(false)
					return
				}

				// payload (envelope v2)
				// The SUCCESS payload is `{state, applied, summary}` — tools/tool_hierarchy/
				// server/tool_hierarchy.ts:99-102. `response_data` is the ONE accessor
				// (`data`, then the compat `result` mirror); on a FAILURE it is `false`,
				// so the object literal below keeps every read total.
					const api_response_data = response_data(api_response) || {}

				// failure
				// ONE error model: a failed call carries an ApiError, and the dispatcher
				// owns both the policy and the surface (render_error_inline writes TEXT
				// into this wrapper). Server text NEVER reaches an HTML sink.
					const failed = request_failed(api_response)
					if (failed) {
						console.error('generate_virtual_section failed:', api_response.error)
						messages_container.classList.add('error')
						await handle_api_error(api_response.error, {wrapper: messages_container})

						// reason — the teardown refusal's TOP-LEVEL extension key
						// (ontology.teardown_refused, hierarchy_state.ts rebuildHierarchy): the
						// server just said "Force to create" may not run here, so the control
						// follows it without a second round-trip.
							if (api_response.error?.code==='ontology.teardown_refused' && api_response.reason) {
								self.rebuild_policy = {allowed: false, reason: api_response.reason}
								paint_rebuild_policy(self)
							}

						// errors — a NAMED extension key on the FAILURE envelope, at its TOP
						// level, beside `state` (ERRORS_SPEC §3.0; thrown as DedaloError
						// `extend` in tool_hierarchy.ts:93-97). It is the per-CHECK detail
						// behind the one sentence the dispatcher just printed: without it
						// the panel can only say the run was refused, never which invariant
						// refused it. NOT inside `error.details`, so it is read from here.
							const check_errors = api_response.errors
							if (check_errors?.length) {
								append_text_lines(
									ui.create_dom_element({
										element_type	: 'div',
										class_name		: 'error',
										parent			: messages_container
									}),
									// bare string prints as-is; a coded entry resolves through
									// the ONE renderer
									check_errors.map(entry => typeof entry==='string' ? entry : error_text(entry))
								)
							}
					}else{

						// summary
						// Envelope v2 has NO prose `msg` on a success: the run sentence is
						// `data.summary` (the server's `outcome.msg`). Rendered as one line
						// per entry — each its own TEXT node, with the client supplying the
						// <br> elements between them.
							const summary		= api_response_data.summary
							const msg_lines		= Array.isArray(summary)
								? summary
								: (summary ? [summary] : [])
							if (msg_lines.length) {
								append_text_lines(
									ui.create_dom_element({
										element_type	: 'div',
										class_name		: 'messages',
										parent			: messages_container
									}),
									msg_lines
								)
							}

						// errors
						// A success carries none today (the server's per-check list rides on
						// the REFUSAL, above) — read anyway, because a payload that grows one
						// must not need a client change to be seen.
							const payload_errors = api_response_data.errors
							if (payload_errors?.length) {
								append_text_lines(
									ui.create_dom_element({
										element_type	: 'div',
										class_name		: 'error',
										parent			: messages_container
									}),
									payload_errors.map(entry => typeof entry==='string' ? entry : error_text(entry))
								)
							}
					}

				// applied
				// What ensureHierarchy actually CHANGED (empty on a healthy hierarchy —
				// the action is idempotent, and saying "nothing to do" out loud is the
				// point: it tells the operator the button worked AND that the hierarchy
				// was already sound, two things the old UI could not distinguish).
					if (api_response_data.applied?.length) {
						const applied_list = ui.create_dom_element({
							element_type	: 'ul',
							class_name		: 'applied',
							parent			: messages_container
						})
						for (const line of api_response_data.applied) {
							ui.create_dom_element({
								element_type	: 'li',
								text_content	: String(line),
								parent			: applied_list
							})
						}
					}

				// status panel
				// Repaint the checklist from the state the SERVER returned with the write —
				// no second round-trip, and no chance of the panel disagreeing with what
				// just happened.
				// (!) TWO PLACES, on purpose: `state` is PAYLOAD on a success and a named
				// TOP-LEVEL extension key on the refusal (tool_hierarchy.ts:96), which is
				// exactly the case the checklist matters most in — a refused Generate must
				// still show WHICH invariant is unmet.
					const state = api_response_data.state ?? api_response.state
					if (state) {
						paint_status(self, status_container, state)
					}

				// reload section (caller)
				// On success, refresh the caller section so the new
				// virtual section appears in its record, and also refresh the menu
				// instance so the new hierarchy entry becomes visible in the navigation.
				// Both refreshes are guarded with try/catch because the caller chain is
				// not guaranteed to be present in all render contexts.
					if (!failed) {
						try {
							// refresh section
							self.caller?.refresh()
							// refresh menu
							const menu = self.caller?.caller?.ar_instances?.find(el => el.model==='menu');
							if (menu) menu.refresh()
						} catch (error) {
							console.error('Unable to refresh section or menu: ' , error)
						}
					}

				set_loading(false)
			}
			button_generate.addEventListener('click', click_handler)
			// focus buttons
			// Defer focus to an idle callback so the browser has completed its
			// layout pass before we attempt to shift keyboard focus, avoiding
			// potential scroll-jank on slow devices.
			dd_request_idle_callback(
				() => {
					button_generate.focus()
				}
			)

		// check box: REBUILD (the destructive variant of the same button)
		// Checked → the server deletes the tld's ONTOLOGY FROM SCRATCH (every dd_ontology
		// node, the ontology_main row, every '<tld>0' node record) and re-provisions it —
		// only for a hierarchy that owns its provisioned ontology; otherwise the control
		// is disabled with the server's reason (paint_rebuild_policy). The
		// thesaurus TERMS in '<tld>1' are NOT touched — the old label ("existing
		// thesaurus data may be lost") was wrong about that, and being wrong in the
		// scary direction meant nobody dared use the one control that fixes a broken
		// ontology.
			const label_field_check_box = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'checkbox-label',
				inner_html		: self.get_tool_label('force_to_create') || 'Rebuild the ontology (terms are kept)',
				parent			: buttons_container
			})
			const check_force_to_create = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				parent			: label_field_check_box
			})
			// the server's verdict on "Force to create" (inspect_hierarchy `rebuild`) may
			// arrive before or after this point: keep the control, and paint whichever
			// verdict is already known
			self.force_to_create_control = {
				label		: label_field_check_box,
				checkbox	: check_force_to_create
			}
			paint_rebuild_policy(self)

	// messages_container
	// Created after the buttons but declared at function scope so the click_handler
	// closure (defined earlier) can reference it without a forward-declaration issue.
		const messages_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'messages_container',
			parent			: fragment
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* PAINT_STATUS
* Renders the hierarchy's invariant checklist into `container`.
*
* Every line is one condition the SERVER checked (hierarchy_state.ts inspectHierarchy):
* the record, the tld, the typology, the source section, the two flags, the ontology,
* the target sections, and the two general-term ROOTS. A failing line shows what is
* actually there — "DANGLING → al1/1 does not exist" is the message that would have
* explained Albania in one glance instead of an afternoon.
*
* Pure DOM: takes the state, paints it. No fetching, so it can be reused by both the
* initial load and the post-write repaint (which reuses the state the write returned).
*
* @param {Object} self - the tool instance (for labels)
* @param {HTMLElement} container
* @param {Object} state - {usable, tld, checks:[{id,label,ok,detail}]}
* @return {void}
*/
export const paint_status = function(self, container, state) {

	container.innerHTML = ''
	if (!state || !Array.isArray(state.checks)) {
		return
	}

	container.classList.toggle('ok', state.usable===true)
	container.classList.toggle('incomplete', state.usable!==true)

	// headline: the one thing an operator wants to know before reading anything else
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_headline',
			inner_html		: state.usable
				? (self.get_tool_label('status_ready') || 'This hierarchy is ready')
				: (self.get_tool_label('status_incomplete') || 'This hierarchy is incomplete'),
			parent			: container
		})

	// the checklist
		const list = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'status_checks',
			parent			: container
		})
		for (const check of state.checks) {
			const item = ui.create_dom_element({
				element_type	: 'li',
				class_name		: check.ok ? 'check ok' : 'check failed',
				parent			: list
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'check_label',
				text_content	: check.label,
				parent			: item
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'check_detail',
				text_content	: check.detail,
				parent			: item
			})
		}
}//end paint_status



/**
* PAINT_REBUILD_POLICY
* Disables "Force to create" when the server says it may not run on this hierarchy, and
* says WHY next to it.
*
* The verdict is the server's (inspect_hierarchy `rebuild` = {allowed, reason}, from
* hierarchy_state.ts classifyHierarchyRebuild — the same check the write door enforces):
* only a hierarchy that OWNS its provisioned ontology may be deleted and recreated. The
* reason is one of core | not_sole_declarer | root_only | ontology_package |
* invalid_source, each with its own tool label (`rebuild_refused_<reason>`).
* Pure DOM over `self.rebuild_policy` + `self.force_to_create_control`; a no-op until
* both exist. All text goes through text_content.
*
* @param {Object} self - the tool instance
* @return {void}
*/
export const paint_rebuild_policy = function(self) {

	const control	= self.force_to_create_control
	const policy	= self.rebuild_policy
	if (!control || !policy) {
		return
	}

	const refused = policy.allowed===false
	control.checkbox.disabled = refused
	if (refused) {
		control.checkbox.checked = false
	}
	control.label.classList.toggle('disabled', refused)

	// one note, replaced on every paint
	const previous = control.label.parentNode?.querySelector(':scope > .rebuild_refused')
	if (previous) {
		previous.remove()
	}
	if (!refused) {
		control.label.removeAttribute('title')
		return
	}
	const note_text = self.get_tool_label('rebuild_refused_' + policy.reason)
		|| ('Force to create is not available for this hierarchy (' + String(policy.reason) + ')')
	control.label.title = note_text
	if (control.label.parentNode) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'rebuild_refused',
			text_content	: note_text,
			parent			: control.label.parentNode
		})
	}
}//end paint_rebuild_policy



/**
* RENDER_STATUS_PANEL
* Fetches the hierarchy state and paints it. Fire-and-forget from the render path: the
* panel appears as soon as the server answers, and a failure to fetch leaves a readable
* note instead of an empty box (the tool must still be usable when inspect is unavailable).
*
* @param {Object} self - the tool instance
* @param {HTMLElement} container
* @return {Promise<void>}
*/
export const render_status_panel = async function(self, container) {

	const unavailable_label = () => self.get_tool_label('status_unavailable') || 'Hierarchy status unavailable'

	try {
		const api_response = await self.inspect_hierarchy()
		// envelope v2: inspect answers `ok({state})` — the checklist is PAYLOAD
		// (tools/tool_hierarchy/server/tool_hierarchy.ts:68), so it is read through
		// the ONE accessor, not off the envelope's top level.
		const state = response_data(api_response)?.state
		// "Force to create" verdict (inspect_hierarchy `rebuild`, HIER-REBUILD)
		const rebuild = response_data(api_response)?.rebuild
		if (rebuild) {
			self.rebuild_policy = rebuild
			paint_rebuild_policy(self)
		}
		if (state) {
			paint_status(self, container, state)
			return
		}
		// no state: say so in the panel, and let the dispatcher say WHY (the server
		// msg is never printed here — the ApiError carries it, in the user's language)
		container.innerHTML = ''
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_headline',
			text_content	: unavailable_label(),
			parent			: container
		})
		if (request_failed(api_response)) {
			console.error('inspect_hierarchy failed:', api_response.error)
			await handle_api_error(api_response.error, {wrapper: container})
		}
	} catch (error) {
		console.error('inspect_hierarchy threw:', error)
		container.innerHTML = ''
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_headline',
			text_content	: unavailable_label() + ': ' + error.message,
			parent			: container
		})
	}
}//end render_status_panel



/**
* RENDER_COMPONENT
* Creates the DOM nodes of the component based on given tipo
*
* Bootstraps a single Dédalo component instance for the given ontology tipo,
* using the tool's caller section as the data context, and renders it in edit
* mode. The instance is registered in `self.ar_instances` so that the
* tool_common lifecycle (destroy, refresh) manages it automatically.
*
* Instance options set here:
*   - model: null — forces `get_instance` to resolve the model from ontology,
*     rather than accepting a hardcoded model name.
*   - id_variant: self.name — appends the tool's name to the component id to
*     prevent DOM id collisions when the same tipo is used in multiple contexts.
*   - caller: self — marks this tool as the component's caller, which is checked
*     by render logic to suppress tool-within-tool nesting (show_interface.tools)
*     and the inline add button (show_interface.button_add).
*   - lang: page_globals.dedalo_data_nolan — components in tool forms always
*     operate on the language-neutral (nolan) lang slot regardless of the
*     user's active interface language.
*
* @param {Object} self - The tool_hierarchy instance; must expose caller
*   (with section_tipo and section_id), name, and ar_instances.
* @param {string} tipo - The ontology tipo identifier of the component to render
*   (e.g. 'hierarchy6', 'hierarchy5', 'hierarchy4', 'hierarchy9', 'hierarchy8',
*   'hierarchy109').
* @returns {Promise<Object>} The fully initialised, built, and rendered component
*   instance. Its `.node` property holds the rendered HTMLElement.
*/
export const render_component = async function (self, tipo) {

	// component instance_options
	const lang_instance_options = {
		model			: null, // force to resolve model
		mode			: 'edit',
		tipo			: tipo,
		section_tipo	: self.caller.section_tipo,
		section_id		: self.caller.section_id,
		lang			: page_globals.dedalo_data_nolan,
		id_variant		: self.name, // id_variant prevents id conflicts
		caller			: self // set current tool as component caller (to check if component is inside tool or not)
	}
	// get instance and init
	const component_instance = await get_instance(lang_instance_options)
	self.ar_instances.push(component_instance)
	// build
	await component_instance.build(true)
	// show_interface
	// Suppress tool buttons and the inline "add" button so the components inside
	// this tool form look like simple fields rather than full editing widgets.
	component_instance.show_interface.tools = false
	component_instance.show_interface.button_add = false
	// render
	await component_instance.render()


	return component_instance
}//end render_component



// @license-end
