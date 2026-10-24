// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_dummy */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_ONTOLOGY_PARSER
*
* Client-side render layer for the tool_ontology_parser tool.
*
* This module is the visual half of the ontology parser tool, which lets
* authorised developers select individual ontology TLDs (top-level domains)
* or entire typology groups and then trigger two long-running server operations:
*
*   - Export   — serialises each selected ontology to a JSON COPY file on the
*                server so it can be distributed to other Dédalo installations.
*   - Regenerate — rebuilds the dd_ontology table rows from the master ontology
*                  data, effectively resyncing the run-time ontology cache.
*
* The module exports one symbol:
*   render_tool_ontology_parser — constructor (prototype pattern); its `edit`
*   method is mixed into tool_ontology_parser.prototype via tool_ontology_parser.js.
*
* Data shapes consumed from the tool instance (`self`):
*   self.ontologies           {Array}  — flat list of ontology descriptor objects
*                                        returned by the server's get_ontologies API:
*                                        { target_section_tipo, tld, name,
*                                          typology_id, typology_name }
*   self.selected_ontologies  {Array}  — mutable array of tld strings that the
*                                        user has checked; persisted to localStorage
*                                        so selections survive page reloads.
*
* Security note — SEC-031: all API response text (msg / errors / ar_msg) is
* written through _render_msg_lines() which emits DOM text nodes, never innerHTML,
* so backend error strings cannot inject HTML or scripts.
*/

// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {filter_ontologies} from './ontologies_filter.js'
	// the ONE failure test + payload accessor + text resolver (envelope v2)
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'

// SEC-031: helper to render API messages safely. Splits on `<br>` literals and emits
// text nodes so api_response.msg / errors / ar_msg cannot inject HTML/script when
// they include user-supplied filenames, ontology codes, or backend error fragments.
const _render_msg_lines = (target, lines) => {
	target.replaceChildren()
	const arr = Array.isArray(lines) ? lines : [String(lines ?? '')]
	arr.forEach((line, i) => {
		if (i > 0) target.appendChild(document.createElement('br'))
		const parts = String(line ?? '').split(/<br\s*\/?>/i)
		parts.forEach((part, j) => {
			if (j > 0) target.appendChild(document.createElement('br'))
			if (part.length) target.appendChild(document.createTextNode(part))
		})
	})
}


/**
* PAINT_STATUS
* Fetches the DRIFT of the current selection (inspect_ontologies) and renders it as a per-TLD
* checklist: in sync (green) or the counts of missing / stale / orphaned nodes. Pure read — safe
* on open, after a write, or on demand. An empty selection clears the panel; a failed fetch
* leaves a readable note instead of an empty box.
*
* @param {Object} self - the tool instance
* @param {HTMLElement} container
* @returns {Promise<void>}
*/
const paint_status = async function(self, container) {

	container.replaceChildren()
	container.classList.remove('ok', 'incomplete')

	if (!self.selected_ontologies || self.selected_ontologies.length===0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_headline',
			inner_html		: self.get_tool_label('status_none') || 'Select ontologies to see their status.',
			parent			: container
		})
		return
	}

	// loading feedback — inspect_ontologies is a round-trip; show it while we wait so the
	// panel is never blank after a Refresh (or an auto-repaint on open / after a write).
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'status_headline loading_status',
		inner_html		: self.get_tool_label('status_checking') || 'Checking status…',
		parent			: container
	})

	let states
	try {
		// envelope v2: `{states:[…]}` is the PAYLOAD (toolOntologyParserInspect
		// returns ok({states})), and a failure carries the coded error instead.
		const api_response	= await self.inspect_ontologies()
		const failed		= request_failed(api_response)
		const inspect_data	= failed ? null : response_data(api_response)
		states = Array.isArray(inspect_data?.states) ? inspect_data.states : null
		if (!states) throw new Error(failed ? error_text(api_response.error) : 'no states')
	} catch (err) {
		container.replaceChildren() // clear the loading line before the error
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_headline',
			text_content	: (self.get_tool_label('status_unavailable') || 'Status unavailable') + ': ' + (err?.message || err),
			parent			: container
		})
		return
	}

	container.replaceChildren() // clear the loading line before the results
	const all_in_sync = states.every(s => s.inSync===true)
	container.classList.add(all_in_sync ? 'ok' : 'incomplete')

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'status_headline',
		inner_html		: all_in_sync
			? (self.get_tool_label('status_all_in_sync') || 'All selected ontologies are in sync')
			: (self.get_tool_label('status_drift') || 'Some ontologies have drifted from their source'),
		parent			: container
	})

	const list = ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'status_checks',
		parent			: container
	})
	states.forEach(state => {
		// 'foreign' (WC-060): a source record whose ontology7 declares a DIFFERENT tld
		// than the section it sits in. Without a bucket here such a tld rendered a red
		// 'check failed' with an EMPTY reason — on the one panel built to diagnose it.
		const counts = { missing:0, stale:0, orphaned:0, foreign:0 }
		;(state.drift || []).forEach(d => { counts[d.kind] = (counts[d.kind]||0)+1 })
		// A kind this client does not know yet must still render a reason, never a
		// blank one: count anything unrecognised rather than dropping it.
		const known = ['missing','stale','orphaned','foreign']
		const other = (state.drift || []).filter(d => known.indexOf(d.kind) === -1).length
		const reasons = [
			counts.missing  ? counts.missing  + ' missing'  : '',
			counts.stale    ? counts.stale    + ' stale'    : '',
			counts.orphaned ? counts.orphaned + ' orphaned' : '',
			counts.foreign  ? counts.foreign  + ' misfiled' : '',
			other           ? other + ' other' : '',
			state.mainNodeOk ? '' : 'no main node'
		].filter(Boolean).join(', ')
		// ONT-TLD: records with NO ontology7 at all. They parse to no node, so they are
		// invisible in the ontology tree — worth saying every time. But they are NOT
		// drift: nothing here disagrees with anything, and no button can clear them, so
		// rendering them as a failed check left the panel permanently red with two
		// buttons that reported success. A warning that rides ALONGSIDE the state.
		const tldless = Number(state.tldlessNodes || 0)
		const tldless_note = tldless
			? ' — ' + tldless + ' record' + (tldless===1?'':'s') + ' without a tld (invisible in the tree)'
			: ''
		const detail = (state.inSync
			? 'in sync (' + state.matrixNodes + ' node' + (state.matrixNodes===1?'':'s') + ')'
			: (reasons || 'out of sync')) + tldless_note

		// In sync with a tld-less warning is 'warn', not 'failed': the projection IS
		// correct, and the operator still needs to see the invisible records.
		const item = ui.create_dom_element({
			element_type	: 'li',
			class_name		: state.inSync ? (tldless ? 'check warn' : 'check ok') : 'check failed',
			parent			: list
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'check_label',
			inner_html		: String(state.tld ?? '?'),
			parent			: item
		})
		const detail_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'check_detail',
			parent			: item
		})
		detail_node.appendChild(document.createTextNode(detail)) // SEC-031: text node, no innerHTML
	})
}



/**
* BUILD_FILTER_BAR
* The search / selection header of the TLD picker.
*
* The census is ~200 ontologies, most of them two-letter country codes spread over
* collapsible typology groups, so without this the operator can neither FIND a tld nor
* SEE which ones are currently checked (the selection is restored from localStorage and
* is scattered across groups that may be collapsed).
*
*   🔍 [ spa           × ]   12 / 204
*   3 selected   [Show selected only]  [Clear selection]
*
* Filtering HIDES rows, it never re-renders them: every checkbox stays in the DOM with its
* state and its change handler intact, so a search can never alter self.selected_ontologies.
* Groups collapsed by the user are force-opened for the duration of a filter through a
* `filtering` class (CSS only) — collapse_toggle_track's persisted state is not written, so
* clearing the box restores each group exactly as it was.
*
* @param {Object} self - the tool instance
* @param {Object} options
* @param {Array} options.groups - the DOM index returned by render_ontologies_list
* @param {HTMLElement} options.list_container - .ontologies_list_container (carries `filtering`)
* @param {Function} options.on_after_clear - run after "Clear selection" (repaints the status panel)
* @returns {Object} {node, refresh} — `refresh` re-reads the counters after an outside change
*/
const build_filter_bar = function(self, options) {

	const groups			= options.groups
	const list_container	= options.list_container
	const on_after_clear	= options.on_after_clear || (() => {})

	const total = (self.ontologies || []).length

	// selected_only. Deliberately transient (not persisted): a saved "show only selected"
	// would reopen the tool on a list that looks empty for no visible reason.
	let selected_only = false

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'filter_bar'
	})

	// search row — input + native-looking clear + match count
		const search_row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filter_row',
			parent			: node
		})
		const search_box = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filter_search',
			parent			: search_row
		})
		const filter_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'search',
			class_name		: 'filter_input',
			placeholder		: self.get_tool_label('filter_placeholder') || 'Search by TLD or name…',
			parent			: search_box
		})
		const clear_query_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'filter_clear_query hidden',
			inner_html		: '×',
			parent			: search_box
		})
		clear_query_button.type = 'button'
		const count_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'filter_count',
			parent			: search_row
		})

	// selection row — how many are checked, and the two ways to act on that
		const selection_row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filter_row filter_selection_row',
			parent			: node
		})
		const selected_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'filter_selected',
			parent			: selection_row
		})
		const selected_only_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'filter_toggle',
			inner_html		: self.get_tool_label('show_selected_only') || 'Show selected only',
			parent			: selection_row
		})
		selected_only_button.type = 'button'
		const clear_selection_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'filter_clear_selection',
			inner_html		: self.get_tool_label('clear_selection') || 'Clear selection',
			parent			: selection_row
		})
		clear_selection_button.type = 'button'

	// no_matches — the dead end has to say so, or an empty panel reads as a broken tool
		const no_matches_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filter_no_matches hidden',
			parent			: node
		})
		no_matches_node.appendChild(document.createTextNode(
			self.get_tool_label('filter_no_matches') || 'No ontologies match your search'
		)) // SEC-031: text node

	/**
	* PAINT_SELECTION_COUNTERS
	* The "N selected" readout plus the enabled state of the two selection actions
	* (with nothing checked they have nothing to do).
	*/
		const paint_selection_counters = () => {
			const count = self.selected_ontologies.length
			selected_node.replaceChildren(document.createTextNode(
				count + ' ' + (self.get_tool_label('selected_count') || 'selected')
			)) // SEC-031: text node
			selected_only_button.disabled		= count===0
			clear_selection_button.disabled		= count===0
			selected_only_button.classList.toggle('active', selected_only)
		}

	/**
	* APPLY_FILTER
	* Resolves visibility for the whole census and pushes it onto the DOM index. Cheap
	* enough (~200 class toggles) to run synchronously on every keystroke.
	*/
		const apply_filter = () => {

			const query		= filter_input.value
			const result	= filter_ontologies(self.ontologies, {
				query			: query,
				selected_only	: selected_only,
				selected		: self.selected_ontologies
			})

			// `filtering` is what force-opens collapsed groups (CSS only, see the .less)
			list_container.classList.toggle('filtering', query.trim()!=='' || selected_only)

			groups.forEach(group => {
				let visible_items = 0
				group.items.forEach(item => {
					const visible = result.visible_tlds.has(item.tld)
					item.label.classList.toggle('no_match', !visible)
					if (visible) visible_items++
				})
				const group_visible = visible_items > 0
				group.label.classList.toggle('no_match', !group_visible)
				group.container.classList.toggle('no_match', !group_visible)
				// the group checkbox now speaks for a different set of rows
				sync_group_checkbox(group)
			})

			count_node.replaceChildren(document.createTextNode(
				result.match_count + ' / ' + total
			)) // SEC-031: text node
			no_matches_node.classList.toggle('hidden', result.match_count > 0)
			clear_query_button.classList.toggle('hidden', query==='')
			paint_selection_counters()
		}

	// events
		filter_input.addEventListener('input', apply_filter)
		filter_input.addEventListener('keydown', (e) => {
			if (e.key==='Escape' && filter_input.value!=='') {
				e.stopPropagation() // do not let Escape close the tool while it still clears a query
				filter_input.value = ''
				apply_filter()
			}
		})
		clear_query_button.addEventListener('click', (e) => {
			e.stopPropagation()
			filter_input.value = ''
			apply_filter()
			filter_input.focus()
		})
		selected_only_button.addEventListener('click', (e) => {
			e.stopPropagation()
			selected_only = !selected_only
			apply_filter()
		})
		clear_selection_button.addEventListener('click', (e) => {
			e.stopPropagation()
			if (self.selected_ontologies.length===0) {
				return
			}
			const confirm_msg = self.get_tool_label('confirm_clear_selection')
				|| 'Clear the whole ontology selection?'
			if (!confirm(confirm_msg)) {
				return
			}
			// uncheck without dispatching change: the array and localStorage are written once
			// here instead of once per row.
			groups.forEach(group => group.items.forEach(item => { item.checkbox.checked = false }))
			self.selected_ontologies.length = 0
			localStorage.setItem('selected_ontologies', JSON.stringify(self.selected_ontologies))
			// leaving 'selected only' on would now show an empty list with no obvious cause
			selected_only = false
			apply_filter()
			on_after_clear()
		})

	// initial paint
		apply_filter()


	return {
		node	: node,
		refresh	: paint_selection_counters
	}
}//end build_filter_bar



/**
* RENDER_TOOL_ONTOLOGY_PARSER
* Constructor for the render layer of the ontology parser tool.
*
* Acts purely as a prototype namespace — no instance state is initialised here.
* The `edit` method defined on its prototype is mixed into the tool's prototype
* by tool_ontology_parser.js so that tool_common's render lifecycle can invoke it.
*
* @returns {boolean} Always returns true (constructor placeholder).
*/
export const render_tool_ontology_parser = function() {

	return true
}//end render_tool_ontology_parser



/**
* EDIT
* Render tool DOM nodes
* This function is called by render common attached in 'tool_dummy.js'
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' builds the complete wrapper;
*   'content' returns only the inner content_data element (used for partial refreshes).
* @returns {Promise<HTMLElement>} wrapper (render_level==='full') or content_data element.
*/
render_tool_ontology_parser.prototype.edit = async function(options) {

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
* Builds the full tool body as a DocumentFragment and then wraps it in the
* standard content_data container returned by ui.tool.build_content_data.
*
* DOM structure produced:
*   content_data
*   ├── h2.user_info                    (instructional text from tool labels)
*   ├── div.ontologies_list_container   (checkbox tree of typologies → TLDs)
*   ├── div.buttons_container
*   │   ├── button.warning.gear         (Export)
*   │   └── button.warning.repair       (Regenerate)
*   ├── div.messages_container          (primary status / result message)
*   ├── div.messages_container.process_messages.hidden  (per-TLD log lines)
*   └── div.messages_container.process_error.hidden     (per-TLD error lines)
*
* The Export and Regenerate buttons share the same UX pattern:
*   1. Confirm dialog guards against accidental invocation.
*   2. Empty selection aborts early with an alert.
*   3. A loading spinner is attached to content_data.parentNode while the API
*      call is in flight (timeout: 180 s, retries: 1 — see tool_ontology_parser.js).
*   4. The three message containers are updated via _render_msg_lines (SEC-031).
*
* (!) messages_container, process_messages_container, and process_error_container
*     are declared AFTER the buttons but referenced inside the button click closures.
*     This works because the closures capture the binding by reference and the
*     variables are in the same function scope — they exist by the time any click
*     can fire.  It is NOT a temporal dead zone issue (let/const are in the same
*     block, resolved before any async event fires).
*
* @param {Object} self - The tool_ontology_parser instance.
* @returns {Promise<HTMLElement>} The populated content_data wrapper element.
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

	// ontologies_list_container
		const ontologies_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'ontologies_list_container',
			parent 			: fragment
		});
		// the filter bar is built AFTER the list (it drives the list's DOM index) but
		// prepended above it; until then any selection change is a no-op.
		let refresh_filter_bar = () => {}
		const ontologies_list = render_ontologies_list(self, {
			on_selection_change : () => refresh_filter_bar()
		})
		ontologies_list_container.appendChild(ontologies_list.fragment)

	// status_container (declared here, RENDERED below the buttons — see get_content_data DOM
	// order note). The per-TLD DRIFT the server reports (inspect_ontologies ->
	// ontology_state.inspectOntology): which dd_ontology nodes are missing, stale or orphaned
	// vs the matrix source. Painted on open and repainted after every write. It sits BELOW the
	// buttons so its height changing on repaint does not shove the buttons around (the panel
	// used to be above them, which made the buttons jump). Empty until a selection exists.
		const status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_container'
		})

	// filter_bar — search + selection header, prepended above the typology tree. Built here
	// because "Clear selection" changes what the status panel is reporting on.
		const filter_bar = build_filter_bar(self, {
			groups			: ontologies_list.groups,
			list_container	: ontologies_list_container,
			on_after_clear	: () => { paint_status(self, status_container) }
		})
		ontologies_list_container.prepend(filter_bar.node)
		refresh_filter_bar = filter_bar.refresh

	// spinner - ONE definition shared by every action (was duplicated per handler, and its
	// early-returns left the spinner stuck on a falsy response; set_loading(false) now runs in a
	// finally, so the tool never hangs in .loading).
		let spinner = null
		const set_loading = (set) => {
			if (set===true) {
				content_data.classList.add('loading')
				messages_container.replaceChildren()
				spinner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'spinner inside',
					parent			: content_data.parentNode
				})
			}else{
				content_data.classList.remove('loading')
				if (spinner) { spinner.remove(); spinner = null }
			}
		}

	// run_action - the ONE action path (was ~90 lines duplicated per button). Confirms, runs,
	// renders the messages, repaints the status panel, and ALWAYS clears BOTH spinners: the
	// tool-wide overlay AND the clicked button's own `button_spinner` add-on (the shared class
	// buttons.less styles, used across the tools) — so every action gives feedback on the button
	// it was launched from, and the tool never hangs.
		const run_action = async (button, fn, confirm_msg) => {
			if (self.selected_ontologies.length===0) {
				alert(self.get_tool_label('select_one') || 'Select at least one ontology.')
				return
			}
			if (confirm_msg && !confirm(confirm_msg)) {
				return
			}
			messages_container.classList.remove('error')
			set_loading(true)
			if (button) button.classList.add('button_spinner')
			try {
				const api_response = await fn()
				if (!api_response) {
					_render_msg_lines(messages_container, 'No response')
					return
				}
				// ENVELOPE v2 (ERRORS_SPEC §3). The three panels read from two
				// DIFFERENT places, because a batch that ran dirty is a FAILURE here:
				//  · success — the account is the PAYLOAD's `summary` and the per-TLD
				//    lines its `ar_msg` (tools/tool_ontology_parser/server/
				//    tool_ontology_parser.ts summarize / repair / export).
				//  · failure — the dispatcher's one coded sentence, with the per-TLD
				//    `errors` + `ar_msg` riding as NAMED failure EXTENSION KEYS at the
				//    body's top level (batchFailed, §3.0), not inside `error.details`.
				// Reading `msg` for both is what printed the literal 'Unknown error'
				// after every clean run and swallowed the per-file export lines.
				const failed	= request_failed(api_response)
				const api_data	= failed ? null : response_data(api_response)
				const headline	= failed
					? error_text(api_response.error)
					: (api_data?.summary ?? (self.get_tool_label('done') || 'OK'))
				_render_msg_lines(messages_container, headline)
				messages_container.classList.toggle('error', failed)

				// errors: only a failure has them (extension key)
				const batch_errors = api_response.errors
				const process_errors = failed && Array.isArray(batch_errors)
					? batch_errors
					: []
				if (process_errors.length) {
					_render_msg_lines(process_error_container, process_errors)
					process_error_container.classList.remove('hidden')
				} else {
					process_error_container.replaceChildren()
					process_error_container.classList.add('hidden')
				}

				// ar_msg: the per-TLD lines, payload on a success and extension key
				// on a failure — the operator needs them on BOTH outcomes.
				const ar_msg = failed
					? (Array.isArray(api_response.ar_msg) ? api_response.ar_msg : [])
					: (Array.isArray(api_data?.ar_msg) ? api_data.ar_msg : [])
				if (ar_msg.length) {
					_render_msg_lines(process_messages_container, ar_msg)
					process_messages_container.classList.remove('hidden')
				} else {
					process_messages_container.replaceChildren()
					process_messages_container.classList.add('hidden')
				}
				await paint_status(self, status_container)
			} catch (err) {
				_render_msg_lines(messages_container, 'Unexpected error: ' + (err?.message || err))
				messages_container.classList.add('error')
			} finally {
				set_loading(false)
				if (button) button.classList.remove('button_spinner')
			}
		}

	// buttons container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

		// make_action - ONE builder for every action: a button + a short caption DESCRIPTION
		// (so the operator understands what each does before pressing) + a hover title, all
		// wired to run_action with the button's own `button_spinner`.
			const make_action = ({ label, cls, desc, run }) => {
				const group = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'button_group',
					parent			: buttons_container
				})
				const button = ui.create_dom_element({
					element_type	: 'button',
					class_name		: cls,
					inner_html		: label,
					parent			: group
				})
				button.title = desc // native tooltip in addition to the visible caption
				const caption = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'button_desc',
					parent			: group
				})
				caption.appendChild(document.createTextNode(desc)) // SEC-031: text node
				button.addEventListener('click', (e) => { e.stopPropagation(); run(button) })
				return button
			}

		// Repair TLDs - the only action that writes SOURCE records, not the projection.
		// A node's tld is DERIVED from its section (ONT-TLD), so the edit form renders it
		// read-only — which is why this button exists: without it the status panel names
		// misfiled records ("declares tld 'act', not 'actv'") that an operator has no way
		// to correct. Contentless rows are deliberately untouched: stamping a tld on one
		// would only add a nameless node to the tree, so those stay listed for a human.
			make_action({
				label	: self.get_tool_label('repair_tlds') || 'Repair TLDs',
				cls		: 'warning repair',
				desc	: self.get_tool_label('repair_tlds_desc')
					|| 'Rewrite a record’s TLD to match its section. Fixes misfiled nodes.',
				run		: (button) => run_action(button,
					() => self.repair_tlds(),
					self.get_tool_label('confirm_repair_tlds')
						|| 'Rewrite the TLD of every record whose TLD does not match its section?\n\nThis edits the ontology RECORDS, not only the derived table. Records with no content are left alone.\n\nRun Rebuild afterwards.'
				)
			})

		// Rebuild - the ONE write onto the projection: transactional wipe-and-rebuild.
		// (The incremental "Reconcile" companion was removed 2026-08-11: a transactional
		// rebuild publishes atomically, so it bought nothing but a choice with no criterion.)
			make_action({
				label	: self.get_tool_label('regenerate') || 'Rebuild',
				cls		: 'warning gear',
				desc	: self.get_tool_label('regenerate_desc')
					|| 'Wipe & re-derive dd_ontology from the ontology records.',
				run		: (button) => run_action(button,
					() => self.regenerate_ontologies(),
					self.get_tool_label('confirm_rebuild')
						|| 'REBUILD wipes and re-derives dd_ontology for the selected TLD(s) from the matrix source.\n\nEach TLD rebuilds in one transaction (safe rollback): readers keep seeing the current ontology until it commits.\n\nContinue?'
				)
			})

		// Export - write the ontology definition files.
			make_action({
				label	: self.get_tool_label('export') || 'Export',
				cls		: 'warning gear',
				desc	: self.get_tool_label('export_desc')
					|| 'Write the ontology definition files for dissemination.',
				run		: (button) => run_action(button,
					() => self.export_ontologies(),
					self.get_tool_label('confirm_export')
						|| 'Export the selected ontologies to their definition files?'
				)
			})

		// Refresh status - re-read the drift without writing anything (own button_spinner).
			make_action({
				label	: self.get_tool_label('refresh_status') || 'Refresh status',
				cls		: 'refresh reload',
				desc	: self.get_tool_label('refresh_status_desc')
					|| 'Re-check the selected ontologies. Reads only.',
				run		: async (button) => {
					button.classList.add('button_spinner')
					try {
						await paint_status(self, status_container)
					} finally {
						button.classList.remove('button_spinner')
					}
				}
			})

		// status_container goes HERE — below the buttons — so a repaint (its height changes with
		// the drift results) never pushes the buttons around.
			fragment.appendChild(status_container)

		// paint the drift once the body exists (fire-and-forget; empty selection -> empty panel).
			dd_request_idle_callback(() => { paint_status(self, status_container) })


	// messages_container
		const messages_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'messages_container',
			parent			: fragment
		})
		const process_messages_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'messages_container process_messages hidden',
			parent			: fragment
		})
		const process_error_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'messages_container process_error hidden',
			parent			: fragment
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* RENDER_ONTOLOGIES_LIST
* Creates the checkbox list selectors of all available ontology sections
*
* Builds a two-level collapsible checkbox tree:
*
*   Level 1 — Typology group (label + parent checkbox)
*     Level 2 — Individual ontology TLD items (label + child checkbox)
*
* Each typology label acts as a collapsible toggle (via ui.collapse_toggle_track).
* Its open/closed state is persisted to the local DB under the key
* 'tool_ontology_parser_<typology_id>'.
*
* Checking/unchecking a parent checkbox cascades to all child checkboxes via
* synthetic 'change' events, so the child change handlers maintain
* self.selected_ontologies consistently.
*
* Child checkbox state changes are debounced through dd_request_idle_callback
* before writing to localStorage ('selected_ontologies') so that rapid
* check/uncheck sequences do not thrash storage.
*
* Ontology item label display logic:
*   - The `tld` value is always the primary visible text (set as inner_html of
*     the label and as its title attribute for overflow tooltip).
*   - If the first segment of `name` (before ' | ') differs from `tld`, a child
*     <span class="item_label_name"> is appended with the human-readable name.
*
* @param {Object} self - The tool_ontology_parser instance.
*   self.ontologies          {Array}  flat list of ontology descriptors
*                                     (each has: tld, name, typology_id, typology_name)
*   self.selected_ontologies {Array}  mutable array of currently selected tld strings
* @param {Object} [options]
* @param {Function} [options.on_selection_change] - called after any checkbox change so the
*   filter bar can refresh its "N selected" readout. Never called during render.
* @returns {Object} {fragment, groups} — `groups` is the DOM INDEX the filter bar drives:
*   [{typology_id, label, container, checkbox, items:[{tld, label, checkbox}]}]. Filtering
*   toggles classes on these nodes instead of re-rendering, so checkbox state (and therefore
*   self.selected_ontologies) is never disturbed by a search.
*/
const render_ontologies_list = function (self, options) {

	const on_selection_change = options?.on_selection_change || (() => {})

	const ontologies = self.ontologies || []

	// parents unique
	// Deduplicate ontologies by typology_id to build the top-level grouping.
	// Map is used for O(1) dedup: iterating via values() preserves the last
	// occurrence per key, which is fine since all entries for a typology share
	// the same typology_id / typology_name.
	const key = 'typology_id';
	const unique_typologies = [...new Map(ontologies.map(el => [el[key], el] )).values()];

	// Sort typologies ascending by typology_id.  Entries without a typology_id
	// (null/undefined) are placed first by returning 0 (stable sort).
	const sorted_typologies = unique_typologies
		.sort( (a,b) => {
			if (!a.typology_id) {
				return 0
			}
			return a.typology_id < b.typology_id ? -1 : 0
		})

	const fragment	= new DocumentFragment()
	const groups	= []

	const sorted_typologies_length = sorted_typologies.length
	for (let i = 0; i < sorted_typologies_length; i++) {

		const typology_item = sorted_typologies[i]
		const group = {
			typology_id	: typology_item.typology_id,
			label		: null,
			container	: null,
			checkbox	: null,
			items		: []
		}
		groups.push(group)

		// typology_label — the collapsible group header.
		// 'icon_arrow' CSS class renders the collapse indicator; the 'up' class
		// is toggled by collapse_toggle_track's expose/collapse callbacks.
			const typology_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'item_label typology_label unselectable icon_arrow',
				inner_html		: typology_item.typology_name || 'Without typology',
				parent			: fragment
			})
			// Prevent the label's native click behaviour (which would toggle the
			// checkbox inside it) — only the explicit checkbox click is acted on.
			typology_label.addEventListener('click', (e) => {
				e.preventDefault() // prevent interactions with the input checkbox
			})

		// input checkbox
		// The parent checkbox is a UI convenience: checking it sets ALL children.
		// It does NOT have its own entry in self.selected_ontologies; only child
		// TLD strings are stored there.
			const typology_input_checkbox = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				id				: typology_item.typology_id,
				value			: typology_item.typology_id
			})
			// change event handler
			// Cascade the parent checkbox state to every VISIBLE child input by dispatching
			// synthetic 'change' events so the children's own handlers run.
			//
			// (!) Two things this must not do:
			//   - touch children hidden by the search filter. Cascading to the whole group
			//     would silently (un)check rows the operator cannot see, on a panel whose
			//     buttons then wipe and rebuild dd_ontology for exactly those tlds.
			//   - re-read typology_input_checkbox.checked inside the loop: each child change
			//     re-derives the parent state (sync_group_checkbox), so reading it per
			//     iteration would flip the target halfway through. Capture it once.
			const change_handler = (e) => {
				const target_state = typology_input_checkbox.checked
				const children_nodes = visible_group_inputs(group)
				for (let k = children_nodes.length - 1; k >= 0; k--) {
					children_nodes[k].checked = target_state
					children_nodes[k].dispatchEvent( new Event('change') );
				}
				sync_group_checkbox(group)
			}
			typology_input_checkbox.addEventListener('change', change_handler)
			// stopPropagation keeps the click from bubbling up to typology_label's
			// click handler (which calls e.preventDefault) — without this the
			// checkbox state would toggle twice.
			typology_input_checkbox.addEventListener('click', (e) => {
				e.stopPropagation()
			})
			typology_label.append(typology_input_checkbox)
			group.label		= typology_label
			group.checkbox	= typology_input_checkbox

		// children_container — holds the individual TLD rows for this typology.
			const children_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'children_container',
				parent			: fragment
			})
			group.container = children_container

		// track collapse toggle state of content
		// ui.collapse_toggle_track persists open/closed state per collapsed_id
		// in the local DB so the panel remembers its state across reloads.
			ui.collapse_toggle_track({
				toggler				: typology_label,
				container			: children_container,
				collapsed_id		: 'tool_ontology_parser_' + typology_item.typology_id,
				collapse_callback	: () => {typology_label.classList.remove('up')},
				expose_callback		: () => {typology_label.classList.add('up')},
				default_state		: 'opened' // 'opened|closed'
			})

		// children group items
		// Filter to this typology's TLDs and sort alphabetically by name.
			const children_ontologies = ontologies.filter(el => el.typology_id === typology_item.typology_id)
				.sort( (a,b) => (a.name < b.name) ? -1 : 0)

			const children_len = children_ontologies.length
			// Track how many children start out checked so we can set the parent
			// checkbox to checked if all children are pre-selected.
			let children_checked_counter = 0 // number of checked children counter
			for (let j = 0; j < children_len; j++) {

				const child = children_ontologies[j];

				// item_label — primary text is the TLD; tooltip via title attribute.
				const item_label = ui.create_dom_element({
					element_type	: 'label',
					class_name		: 'item_label unselectable',
					inner_html		: child.tld,
					title			: child.tld,
					parent			: children_container
				})

				// item_label_name — optional supplementary human-readable name.
				// The server stores names as "TLD | human name | ..." pipe-separated.
				// Only the first segment is shown; if it equals the TLD it would be
				// redundant, so the <span> is omitted in that case.
				// (!) name is NULLABLE in the census (data_io.ts maps '' to null when the
				// hierarchy has no term in the app lang) — a bare .split() threw there.
				const name_first_part = String(child.name ?? '').split(' | ')[0]
				if (name_first_part!=='' && name_first_part!==child.tld) {
					 ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'item_label_name',
						inner_html		: name_first_part,
						parent			: item_label
					})
				}

				// input checkbox
				const input_checkbox = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					id				: child.tld,
					value			: child.tld
				})
				// set value
				// Restore the previously persisted selection from self.selected_ontologies
				// (which was populated from localStorage during tool build).
				if (self.selected_ontologies.find(el => el===child.tld)) {
					input_checkbox.checked = true
					children_checked_counter++ // update counter
				}
				item_label.prepend(input_checkbox)
				group.items.push({
					tld			: child.tld,
					label		: item_label,
					checkbox	: input_checkbox
				})
				// change event handler
				// Keeps self.selected_ontologies in sync with the checkbox state and
				// persists the updated array to localStorage via an idle callback so
				// rapid toggling does not block the main thread.
				const change_handler = (e) => {
					if (input_checkbox.checked) {
						// add if not is not already included
						if (!self.selected_ontologies.includes(child.tld)) {
							self.selected_ontologies.push(child.tld)
						}
					}else{
						const index = self.selected_ontologies.indexOf(child.tld)
						if (index > -1) {
							self.selected_ontologies.splice(index, 1)
						}
					}
					// keep the group checkbox and the filter bar's "N selected" readout honest
					sync_group_checkbox(group)
					on_selection_change()
					// save selected_ontologies value as localStorage
					dd_request_idle_callback(
						() => {
							// current stored value
							const value_string = JSON.stringify( self.selected_ontologies )
							if (value_string!==localStorage.getItem('selected_ontologies')) {
								// store_value
								localStorage.setItem('selected_ontologies', value_string);
								if(SHOW_DEBUG===true) {
									// console.log("Saved localStorage.setItem:", localStorage.getItem('selected_ontologies'));
								}
							}
						}
					)
				}
				input_checkbox.addEventListener('change', change_handler)
			}

		// update grouper checked value. if all children are check, then parent is checked
		// (children_checked_counter is kept for the zero-children case, where deriving from
		// an empty list must NOT read as "all checked").
			if (children_len > 0 && children_checked_counter===children_len) {
				typology_input_checkbox.checked = true
			}
	}


	return {
		fragment	: fragment,
		groups		: groups
	}
}//end render_ontologies_list



/**
* VISIBLE_GROUP_INPUTS
* The checkboxes of a group's rows that the search filter is currently SHOWING.
* Every cascade and every parent-state derivation goes through this, so a filtered
* group can only ever act on what the operator can see.
*
* @param {Object} group - entry of the render_ontologies_list index
* @returns {HTMLInputElement[]}
*/
const visible_group_inputs = function(group) {

	return group.items
		.filter(item => !item.label.classList.contains('no_match'))
		.map(item => item.checkbox)
}//end visible_group_inputs



/**
* SYNC_GROUP_CHECKBOX
* Re-derives a typology checkbox from its VISIBLE children: checked when all of them
* are, indeterminate when only some are. A group with nothing visible is left unchecked
* and determinate (there is nothing for it to cascade to).
*
* @param {Object} group - entry of the render_ontologies_list index
* @returns {void}
*/
const sync_group_checkbox = function(group) {

	if (!group.checkbox) {
		return
	}

	const inputs	= visible_group_inputs(group)
	const checked	= inputs.filter(input => input.checked).length

	group.checkbox.checked			= inputs.length > 0 && checked===inputs.length
	group.checkbox.indeterminate	= checked > 0 && checked < inputs.length
}//end sync_group_checkbox



// @license-end
