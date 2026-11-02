// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/


// import
	import { request_failed, response_data } from '../../common/js/api_error.js'
	import { data_manager } from '../../common/js/data_manager.js'
	import { error_text } from '../../common/js/render_api_error.js'
	import { ui } from '../../common/js/ui.js'
	import {
		clone,
		open_filtered_window,
		printf
	} from '../../common/js/utils/index.js'
	import { is_filter_empty, is_own_record_pin } from '../../search/js/search_utils.js'



/**
* OPEN RELATIONSHIPS — how it works (WC-2026-10-30-search-referenced-by-leaf)
*
* "Open relationships" asks a RELATIONAL question: the records of a target
* section T referenced by any record of a source set S. The client never
* collects ids for it. It builds ONE source object
*
*   { section_tipo:[…], filter?, filter_by_locators?, from_component_tipo? }
*
* and uses it twice, verbatim:
*   1. `dd_core_api.relation_targets` with options.source → the target sections
*      the source references, each with its EXACT row count, already filtered by
*      the user's read grant (the server owns the census; the client no longer
*      guesses targets from the portals present in its loaded context);
*   2. the opened window's filter, as the leaf `{ referenced_by: source }`. The
*      server compiles it into one semi-join over matrix_relation_index, so the
*      window paginates and counts normally and the ACL is applied in SQL.
*
* The source set is the whole found set by definition: it never carries limit,
* offset or order (the server refuses them). The leaf nests: opening
* relationships from a window that is itself filtered by a leaf puts that leaf
* inside the new source's filter (the server bounds the depth).
*/



/**
* RELATION_TARGETS_TIMEOUT_MS
* Per-attempt transport timeout of the census request: above the server's own
* census budget (search/relation_targets.ts RELATION_TARGETS_BUDGET_MS = 30 s),
* so a census the server stops is answered as the typed `db.statement_timeout`
* instead of a transport timeout (and its retry). Exported for the gates: the
* server gate (relation_targets_native) orders it after the server budget, the
* client gate (test_open_related_data) asserts it is the timeout the census
* request actually hands data_manager.
*/
export const RELATION_TARGETS_TIMEOUT_MS = 35 * 1000



/**
* BUILD_CALLER_RECORD
* The { section_tipo, section_id } of the record the caller has open, or null
* when it has none (list mode, or no caller instance was passed).
*
* Used to tell the auto single-record pin apart from a real result set (see
* is_own_record_pin) and as the 'current' scope's source pin.
*
* @param {Object|null} self_caller - The caller SECTION instance.
* @returns {Object|null}
*/
const build_caller_record = function(self_caller) {

	const section_tipo	= self_caller?.section_tipo ?? self_caller?.tipo
	const section_id	= self_caller?.section_id

	if (!section_tipo || section_id===null || section_id===undefined) {
		return null
	}

	return {
		section_tipo	: section_tipo,
		section_id		: section_id
	}
}//end build_caller_record



// is_own_record_pin lives in search/js/search_utils.js — the RECORD VIEW /
// PAGE VIEW rule is shared with section.js, see its doc there.



/**
* BUILD_SCOPED_SQO
* Derives the SQO for the chosen scope from the caller section's CURRENT view
* SQO.
*
* The caller's SQO describes what the section is showing right now, and the open
* record is identified in ONE OF TWO WAYS depending on how the user got there.
* The two need OPPOSITE handling of the offset:
*
*   - navigated from the LIST (the pen button, render_list_section.js): the SQO is
*     the list's, with `limit:1, offset:<row position>` and NO pin — `section_id`
*     is deliberately kept off the source, so build_rqo_show never generates one.
*     Here the OFFSET IS THE RECORD SELECTOR and must be preserved; resetting it
*     asks the server for the FIRST found record instead of the open one.
*   - loaded with a known section_id (a direct url): build_rqo_show adds the auto
*     single-record pin and the offset is 0, so the pin alone selects the record.
*
* A third, DEGRADED state is what this originally had to survive: a stale stored
* edit pagination pairing the pin with a non-zero offset, where the offset skips
* the only pinned row (and the section's own edit form came up empty too — the
* same conflict). section.js now prevents that upstream: a pinned sqo is a
* RECORD VIEW and never meets a stored offset. The sqo handed to this function
* may still come from elsewhere, so it simply does not compound it.
*
* Hence, for 'current': reset the offset only when the pin set already names
* exactly one record.
*
* 'found' is a SET, not a page: limit, offset and order are removed (a
* referenced_by source refuses them, and a count ignores them). Only the caller's
* own auto pin is dropped; any other pin set is the user's result and stays.
*
* @param {Object} sqo - The caller's Search Query Object. Never mutated: the
*   portal caller hands over its parent section's live object.
* @param {string} scope - 'current' | 'found'.
* @param {Object|null} caller_record - { section_tipo, section_id } of the open
*   record, used to tell the auto pin apart from a real result set. When null the
*   pin is treated as a result set (the conservative direction: never widen).
* @returns {Object} A cloned, scoped SQO.
*/
export const build_scoped_sqo = function(sqo, scope, caller_record) {

	const pins = Array.isArray(sqo.filter_by_locators)
		? sqo.filter_by_locators
		: []

	if (scope==='found') {
		// The whole found set: no page, no order. Nothing is fetched row by row
		// any more, so no page ceiling applies (the server answers the set with a
		// semi-join and an exact count).
		const found_sqo = {}
		for (const [key, value] of Object.entries(clone(sqo))) {
			if (key!=='limit' && key!=='offset' && key!=='order') {
				found_sqo[key] = value
			}
		}
		// Drop the pin ONLY when it is the caller's own auto single-record pin.
		// Any other pin set is the result the user is actually looking at and
		// stays. sqo.filter is untouched either way.
		if (is_own_record_pin(pins, caller_record)===true) {
			found_sqo.filter_by_locators = []
		}
		return found_sqo
	}

	// Current record only.
	const scoped_sqo = clone(sqo)
	scoped_sqo.limit = 1
	// A one-locator pin set already names the record, so the found-set offset is
	// stale and would skip it. With no pin — or with several — the offset is what
	// picks the record out of the set and MUST survive.
	if (pins.length===1) {
		scoped_sqo.offset = 0
	}

	return scoped_sqo
}//end build_scoped_sqo



/**
* HAS_FILTER_NODES
* True when a filter object holds at least one item under an operator key.
* Structure, not values: an item whose q is empty is still sent, so the server
* decides the found set exactly as the section's own search does.
* @param {Object|null|undefined} filter
* @returns {boolean}
*/
const has_filter_nodes = function(filter) {

	if (!filter || typeof filter!=='object' || Array.isArray(filter)) {
		return false
	}

	return Object.keys(filter).some(key => Array.isArray(filter[key]) && filter[key].length > 0)
}//end has_filter_nodes



/**
* BUILD_RELATION_SOURCE
* The `referenced_by` SOURCE object for a scope — the one object sent to
* relation_targets AND placed, verbatim, in every opened window's filter.
*
*   current → the open record itself: a one-locator pin on the caller record.
*             The record is pinned by identity, never by limit/offset (a source
*             is a set and refuses a page).
*   found   → the caller's found set: build_scoped_sqo('found') keeps the user's
*             own filter and pins and drops only the auto pin. A found set that
*             EXPANDS to recursive children (the search panel's 'Children'
*             checkbox: sqo.children_recursive) keeps the flag: the server
*             refuses it BY NAME (a source has no descendant pre-pass), so the
*             modal says why instead of counting only the matched terms while
*             the list — and the found total above — include their descendants.
*
* @param {Object} sqo - The caller's current view SQO (read only).
* @param {string} scope - 'current' | 'found'.
* @param {Object|null} caller_record - The open record, or null.
* @param {string|null} [from_component_tipo] - Portal mode: only the locators
*   this component of the source owns.
* @returns {Object|null} The source, or null when the scope cannot be named
*   ('current' without an open record, or no source section).
*/
export const build_relation_source = function(sqo, scope, caller_record, from_component_tipo=null) {

	const source = {}

	if (scope==='current') {
		if (!caller_record) {
			return null
		}
		source.section_tipo			= [caller_record.section_tipo]
		source.filter_by_locators	= [{
			section_tipo	: caller_record.section_tipo,
			section_id		: caller_record.section_id
		}]
	}else{
		const scoped_sqo	= build_scoped_sqo(sqo || {}, 'found', caller_record)
		const section_tipo	= (Array.isArray(scoped_sqo.section_tipo)
			? scoped_sqo.section_tipo
			: [scoped_sqo.section_tipo]
		).filter(el => typeof el==='string' && el.length > 0)

		if (section_tipo.length < 1) {
			return null
		}
		source.section_tipo = section_tipo

		if (has_filter_nodes(scoped_sqo.filter)) {
			source.filter = scoped_sqo.filter
		}

		// passed through, never dropped: dropping it would silently narrow the
		// source to the matched terms (the server refuses it, loudly)
		if (scoped_sqo.children_recursive===true) {
			source.children_recursive = true
		}

		const pins = Array.isArray(scoped_sqo.filter_by_locators)
			? scoped_sqo.filter_by_locators
			: []
		if (pins.length > 0) {
			source.filter_by_locators = pins
			// passed through, never rewritten: the server accepts only 'OR' and
			// refuses anything else loudly instead of narrowing it
			if (scoped_sqo.filter_by_locators_op) {
				source.filter_by_locators_op = scoped_sqo.filter_by_locators_op
			}
		}
	}

	if (from_component_tipo) {
		source.from_component_tipo = from_component_tipo
	}

	return source
}//end build_relation_source



/**
* IS_SOURCE_UNFILTERED
* True when a source names a whole section: no pins and no active filter value.
* @param {Object} source
* @returns {boolean}
*/
const is_source_unfiltered = function(source) {

	const has_pins = Array.isArray(source?.filter_by_locators) && source.filter_by_locators.length > 0
	if (has_pins) {
		return false
	}

	return source?.filter
		? is_filter_empty(source.filter)
		: true
}//end is_source_unfiltered



/**
* FETCH_RELATION_TARGETS
* Asks the server which sections the source references, and how many records
* of each: `dd_core_api.relation_targets` → [{ tipo, label, total }].
* The server bounds the census by its own statement budget
* (search/relation_targets.ts RELATION_TARGETS_BUDGET_MS, 30 s) and answers a
* typed `db.statement_timeout` past it; the per-attempt timeout here sits above
* that budget, so the typed answer arrives before the transport gives up.
* @param {Object} source - A referenced_by source (build_relation_source).
* @param {AbortSignal} [signal] - Aborts the request (a superseded scope, a
*   closed modal): it then resolves `client.aborted` (silent by policy). The
*   abort is client-side only — the engine has no request.signal handling, so a
*   statement already running ends at its budget, not at the abort.
* @returns {Promise<{targets:Array<Object>|null, error:Object|null}>}
*   targets is null on failure; error is the ApiError then.
*/
export const fetch_relation_targets = async function(source, signal) {

	const api_response = await data_manager.request({
		body : {
			dd_api	: 'dd_core_api',
			action	: 'relation_targets',
			options	: {
				source : source
			}
		},
		timeout	: RELATION_TARGETS_TIMEOUT_MS,
		...(signal ? { signal } : {})
	})

	if (!api_response || request_failed(api_response)) {
		return {
			targets	: null,
			error	: api_response?.error || null
		}
	}

	const data = response_data(api_response)

	return {
		targets	: Array.isArray(data) ? data : [],
		error	: null
	}
}//end fetch_relation_targets



/**
* RENDER_OPEN_LIST_WITH_DIRECT_RELATIONS
* Builds and displays the modal that opens the records related to the caller.
*
* Two choices are presented:
*   1. Scope — the source set:
*        - "current" : only the record open in the editor (disabled when the
*          caller has no open record);
*        - "found"   : every record of the active search result set.
*   2. Target — the sections the source references, asked from the server
*      (relation_targets) for the selected scope and re-asked whenever the scope
*      flips, each shown with its record count. Section mode (inspector) picks
*      ONE target with a radio; portal mode (from_component_tipo) lists them and
*      opens every one. No target → the empty state, inside the modal.
*
* @param {Object} options - Configuration bag passed in by the caller.
* @param {Object} options.sqo - The caller section's CURRENT view SQO. Required.
*   Never sent as-is and never mutated: each scope derives its own clone.
* @param {string|null} [options.from_component_tipo] - Portal mode: the portal
*   component whose locators define the relation. Omitted for the section
*   (inspector) mode, where every indexed relation of the source counts.
* @param {string} options.label - Human-readable label of the caller, inserted
*   into the modal body.
* @param {number} options.total - The caller's current record count. In edit
*   mode this is 1, so it is replaced asynchronously by the real found-set total
*   whenever options.self_caller can compute one.
* @param {Object} options.self_caller - The live caller SECTION instance
*   (`options.self` is accepted as a legacy alias). It names the open record
*   (the 'current' scope), recomputes the found-records total via get_total(sqo)
*   and is the caller of the short-lived section that pins each window's filter
*   in the server session. The opened windows are independent pages: they do
*   NOT track this instance.
* @returns {void} The modal is attached as a side effect.
*/
export const render_open_list_with_direct_relations = ( options ) => {

	const sqo					= options.sqo
	const from_component_tipo	= options.from_component_tipo || null
	const caller_label			= options.label
	const total_records			= options.total
	// self_caller. Callers disagree on the key name (the inspector passes
	// 'self_caller', older code passed 'self'), so accept both.
	const self_caller			= options.self_caller ?? options.self
	const caller_record			= build_caller_record(self_caller)
	const portal_mode			= from_component_tipo!==null

	if (!sqo) {
		console.error('Missing SQO in section in its request config object');
		return;
	}

	// state. One mutable bag read by every handler below.
	//   scope         : 'current' | 'found'
	//   source        : the source the DISPLAYED targets were counted for — the
	//                   one placed in the opened windows (never a newer one)
	//   targets       : the displayed [{tipo,label,total}], null while loading
	//   selected_tipo : section mode's picked target
	//   request_seq   : a flip while a request is in flight makes its answer stale
	//   controller    : the in-flight census's AbortController — aborted when a
	//                   flip supersedes it or the modal closes, so superseded
	//                   censuses never pile up behind the current one
		const state = {
			scope			: caller_record ? 'current' : 'found',
			source			: null,
			targets			: null,
			selected_tipo	: null,
			request_seq		: 0,
			controller		: null
		}

	// abort_census. Ends the in-flight census request, if any.
		const abort_census = () => {
			if (state.controller) {
				state.controller.abort()
				state.controller = null
			}
		}

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_node		: get_label.open_relationships || 'Open relationships',
			parent			: header
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content body'
		})

		// Build the body prompt with the caller label interpolated via printf.
		// The translated string accepts two positional placeholders:
		//   {0} → caller label (wrapped in <strong> for visual emphasis)
		//   {1} → total found records count
		const bold_caller_label = `<strong>${caller_label}</strong>`
		const raw_body_label = get_label.open_relationships_of_field || 'Open relationships of {0} from the current record (1) or from all found records ({1})?'
		const body_label = printf(raw_body_label, bold_caller_label, total_records)

		const body_label_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			inner_html		: body_label,
			parent			: body
		})

		// found total.
		// options.total is the caller's CURRENT count, which in edit mode is 1
		// (the section SQO is pinned to the open record). Recompute it from the
		// found-scope SQO and patch the number in when it resolves; the initial
		// render stays synchronous. Only sections expose get_total.
		if (typeof self_caller?.get_total === 'function') {
			self_caller.get_total( build_scoped_sqo(sqo, 'found', caller_record) )
			.then(found_total => {
				if (found_total===undefined || found_total===null || found_total===total_records) {
					return
				}
				body_label_node.innerHTML = printf(raw_body_label, bold_caller_label, found_total)
			})
			.catch(error => console.error('Failed to resolve the found records total:', error))
		}

		// scope selector (current | found)
			const radio_button_content = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'radio_button_content',
				parent			: body
			})

			const scope_change_handler = (e) => {
				state.scope = e.target.value
				load_targets()
			}

			// option current_record
				const current_record_label = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'current_record_label option_row unselectable',
					text_node		: get_label.current_record || 'Current record',
					parent			: radio_button_content
				})

				const current_record_radio = ui.create_dom_element({
					element_type	: 'input',
					type			: 'radio',
					name			: 'data_selection',
					value			: 'current'
				})
				// "current" is the default when there is an open record to name;
				// without one (list mode) it cannot be expressed and is disabled.
				current_record_radio.checked	= state.scope==='current'
				current_record_radio.disabled	= !caller_record
				current_record_radio.addEventListener('change', scope_change_handler)
				current_record_label.prepend(current_record_radio)

			// option found_records
				const found_records_label = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'found_records_label option_row unselectable',
					text_node		: get_label.found_records || 'All found records',
					parent			: radio_button_content
				})

				const found_records_radio = ui.create_dom_element({
					element_type	: 'input',
					type			: 'radio',
					name			: 'data_selection',
					value			: 'found'
				})
				found_records_radio.checked = state.scope==='found'
				found_records_radio.addEventListener('change', scope_change_handler)
				found_records_label.prepend(found_records_radio)

		// targets block. Re-rendered on every answer.
			const target_sections_block = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'target_sections_block',
				parent			: body
			})

	// footer buttons (slotted into the modal footer, so they stay visible while
	// the target list scrolls)
		const button_open_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'button_open_container footer content'
		})

		const button_cancel = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'secondary',
			inner_html		: get_label.cancel || 'Cancel',
			parent			: button_open_container
		})
		button_cancel.addEventListener('mouseup', () => modal.close())

		const button_open = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'success',
			inner_html		: get_label.open || 'Open',
			parent			: button_open_container
		})
		// Enabled only when the displayed answer offers something to open (and, in
		// section mode, a target is picked).
		button_open.disabled = true

		const update_open_state = () => {
			const has_targets = Array.isArray(state.targets) && state.targets.length > 0
			button_open.disabled = portal_mode
				? !has_targets
				: !(has_targets && state.selected_tipo)
		}

	// render_message. Loading / empty / error states, inside the modal.
		const render_message = (text, class_name) => {
			target_sections_block.replaceChildren()
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'target_sections_empty ' + class_name,
				text_content	: text,
				parent			: target_sections_block
			})
		}

	// render_targets. The answer for the current scope.
		const render_targets = () => {

			target_sections_block.replaceChildren()

			const targets		= state.targets
			const targets_len	= targets.length

			// a target picked under the other scope stays picked only when the
			// new answer still offers it
			if (state.selected_tipo && !targets.some(el => el.tipo===state.selected_tipo)) {
				state.selected_tipo = null
			}

			const target_sections_header = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'target_sections_header',
				parent			: target_sections_block
			})

			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'target_sections_title',
				text_node		: `${get_label.sections || 'sections'} (${targets_len})`,
				parent			: target_sections_header
			})

			const target_sections_content = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'target_sections_content',
				parent			: target_sections_block
			})

			// ar_target_section_nodes. Used by the filter to show/hide rows
			const ar_target_section_nodes = []

			for (let i = 0; i < targets_len; i++) {
				const target = targets[i]

				const target_section_label = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'target_section_label option_row unselectable',
					text_content	: `${target.label || target.tipo} (${target.total})`,
					parent			: target_sections_content
				})
				target_section_label.dataset.tipo = target.tipo

				// section mode: one radio per target. Portal mode opens every
				// listed target, so the rows are informative only.
				if (!portal_mode) {
					const target_radio = ui.create_dom_element({
						element_type	: 'input',
						type			: 'radio',
						name			: 'target_section',
						value			: target.tipo
					})
					target_radio.checked = target.tipo===state.selected_tipo
					target_radio.addEventListener('change', (e) => {
						state.selected_tipo = e.target.value
						update_open_state()
					})
					// inside the label, so clicking the text toggles it too
					target_section_label.prepend(target_radio)
				}

				ar_target_section_nodes.push({
					node		: target_section_label,
					search_text	: (target.label || target.tipo).toLowerCase()
				})
			}

			// filter. Long target lists are unusable without a way to narrow them.
			if (targets_len > 8) {

				const filter_input = ui.create_dom_element({
					element_type	: 'input',
					type			: 'search',
					class_name		: 'target_sections_filter',
					placeholder		: get_label.search || 'Search',
					parent			: target_sections_header
				})

				// empty state. Without it a non-matching search reads as a blank panel.
				const no_matches_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'target_sections_empty hide',
					text_content	: get_label.no_sections_match || 'No sections match your search',
					parent			: target_sections_block
				})

				const filter_handler = () => {
					const search_value = filter_input.value.trim().toLowerCase()
					let matches_len = 0
					for (const item of ar_target_section_nodes) {
						// the already selected row is never hidden: Open would
						// otherwise fire on a choice the user cannot see
						const matches = search_value.length===0
							|| item.search_text.includes(search_value)
							|| item.node.querySelector('input')?.checked===true
						item.node.classList.toggle('hide', !matches)
						if (matches===true) {
							matches_len++
						}
					}
					no_matches_node.classList.toggle('hide', matches_len>0)
				}
				filter_input.addEventListener('input', filter_handler)

				// Enter confirms the dialog when the Open button is enabled
				filter_input.addEventListener('keydown', (e) => {
					if (e.key==='Enter' && button_open.disabled===false) {
						e.preventDefault()
						perform_open()
					}
				})
			}

			update_open_state()
			freeze_height()
		}

	// load_targets. Ask the server for the current scope; a later flip wins.
		const load_targets = async () => {

			const seq		= ++state.request_seq
			const source	= build_relation_source(sqo, state.scope, caller_record, from_component_tipo)

			// a newer scope supersedes the census still in flight
			abort_census()

			state.targets	= null
			state.source	= null
			update_open_state()
			unfreeze_height()

			if (!source) {
				state.targets = []
				render_message(get_label.no_target_sections || 'No related sections available', 'no_targets')
				return
			}

			render_message(get_label.loading || 'Loading...', 'loading')

			const controller	= new AbortController()
			state.controller	= controller

			let answer
			try {
				answer = await fetch_relation_targets(source, controller.signal)
			} catch (error) {
				answer = { targets : null, error : error }
			}

			// stale: the user flipped the scope (or closed the modal) while this
			// was in flight — its request was aborted, its answer is not shown
			if (seq!==state.request_seq || controller.signal.aborted) {
				return
			}
			state.controller = null

			if (answer.targets===null) {
				state.targets = []
				// SUPERSEDED (409 resource.conflict): the census is single-flight PER
				// SESSION, so the same modal in another tab or window of this session
				// replaced this one's request, which this modal never aborted. Not a
				// failure of this scope: say so and offer to count again (a manual
				// reload, never an automatic one — two tabs would supersede each
				// other forever).
				if (answer.error?.code==='resource.conflict') {
					render_message(error_text(answer.error), 'superseded')
					const button_reload = ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'secondary button_reload_targets',
						inner_html		: get_label.reload || 'Reload',
						parent			: target_sections_block
					})
					button_reload.addEventListener('mouseup', () => load_targets())
					update_open_state()
					return
				}
				console.error('relation_targets failed:', answer.error);
				render_message(
					answer.error ? error_text(answer.error) : (get_label.error || 'Error'),
					'error'
				)
				update_open_state()
				return
			}

			state.source	= source
			state.targets	= answer.targets

			if (answer.targets.length < 1) {
				render_message(get_label.no_target_sections || 'No related sections available', 'no_targets')
				update_open_state()
				return
			}

			render_targets()
		}

	// button_open action
		const perform_open = () => {
			if (button_open.disabled===true || !state.source) {
				return
			}
			const tipos = portal_mode
				? state.targets.map(el => el.tipo)
				: [state.selected_tipo]

			open_related_data({
				source			: state.source,
				target_tipos	: tipos,
				modal			: modal,
				caller_label	: caller_label,
				self_caller		: self_caller
			})
		}
		button_open.addEventListener('mouseup', perform_open)

	// height freeze. Once a target list is rendered the dialog keeps its height,
	// so it does not re-centre on every filter keystroke. The CSS max-height still
	// caps it. Released before each re-load (the next answer may be shorter).
		let modal_content_node = null
		const unfreeze_height = () => {
			if (modal_content_node) {
				modal_content_node.style.height = ''
			}
		}
		const freeze_height = () => {
			requestAnimationFrame(() => {
				if (!modal_content_node) {
					return
				}
				modal_content_node.style.height = ''
				modal_content_node.style.height = modal_content_node.getBoundingClientRect().height + 'px'
			})
		}

	// modal
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: button_open_container,
			size		: 'small', // string size big|normal|small
			minimizable	: false,
			// a closed modal abandons its census: abort it, and make any late
			// answer stale
			on_close	: () => {
				state.request_seq++
				abort_census()
			},
			callback	: (dd_modal) => {
				dd_modal.classList.add('open_relations_modal')
				modal_content_node = dd_modal.get_modal_content?.() || null
			}
		})

	// first answer, for the default scope
		load_targets()
}// end render_open_list_with_direct_relations



/**
* OPEN_RELATED_DATA
* Opens one window per target section, each filtered by the SAME referenced_by
* source the displayed counts were computed for.
*
* Flow:
*   1. Close the modal (first, so every exit path below leaves it gone and a
*      confirm() is not stacked on top of it).
*   2. A source that names a WHOLE section (no pins, no active filter value)
*      asks first: every relation of every record is a legitimate question, but
*      rarely the intended one.
*   3. For each target, open_filtered_window with the filter
*      `{ $and: [{ referenced_by: source }] }`. Windows are opened in reverse
*      order (the first target ends on top), staggered 30 px.
*
* (!) NOT awaited, deliberately. Each open_filtered_window persists its filter in
* the server session before opening its window; those writes are independent
* (session_store.setSessionSqo merges per section_tipo), and a popup blocked by
* the browser must not take the remaining windows down with it. Each call
* reports its own failure.
*
* @param {Object} options
* @param {Object} options.source - The referenced_by source the targets were
*   counted for.
* @param {Array<string>} options.target_tipos - The sections to open.
* @param {HTMLElement} options.modal - The dd_modal to close.
* @param {string} options.caller_label - Caller label for the confirm() text.
* @param {Object} options.self_caller - Caller of the short-lived section that
*   pins each window's filter.
* @returns {boolean} false when nothing was opened.
*/
const open_related_data = function( options ){

	const source		= options.source
	const target_tipos	= options.target_tipos.filter(Boolean)
	const caller_label	= options.caller_label
	const self_caller	= options.self_caller
	const modal			= options.modal

	modal.close()

	if (target_tipos.length < 1) {
		return false
	}

	if (is_source_unfiltered(source)) {
		const raw_label		= get_label.will_open_all_related_records || 'This will open all related data of {0} of all records in a new window without filtering. Are you sure?'
		const label			= printf(raw_label, caller_label)
		const warning_label	= (get_label.warning || 'WARNING').toUpperCase()
		if (!confirm(warning_label + '\n' + label)) {
			return false
		}
	}

	const targets_len = target_tipos.length
	for (let i = targets_len - 1; i >= 0; i--) {
		const section_tipo = target_tipos[i]

		open_filtered_window({
			caller			: self_caller,
			section_tipo	: section_tipo,
			// a fresh clone per window: each dummy section owns its request
			filter			: { '$and' : [{ referenced_by : clone(source) }] },
			target_window	: section_tipo,
			left			: i*30,
			top				: (i*30)+25 // macOS menu has 25 pixels
		})
		.catch(error => {
			// fire-and-forget: without the catch a blocked popup or a failed
			// dummy-section build is an unhandled rejection and the window
			// silently never appears
			console.error(`Failed to open the related records window for '${section_tipo}':`, error);
		})
	}

	return true
}//end open_related_data



// @license-end
