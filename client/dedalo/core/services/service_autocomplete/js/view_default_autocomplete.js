// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/

/**
* MODULE: view_default_autocomplete
*
* Default view layer for the service_autocomplete service.
* Provides all DOM construction and event wiring for the autocomplete widget:
* search input with debounced lookup, source / section / filter-by-list
* checkboxes, operator ($or/$and) and result-limit selectors, a live datalist
* of section_record rows, and an optional floating grid-chooser panel
* (render_grid_choose / get_grid_choose_data).
*
* Public API is attached directly to the exported `view_default_autocomplete`
* function object:
*   - view_default_autocomplete.render         — build and return the widget wrapper
*   - view_default_autocomplete.show           — remove the 'hide' CSS class
*   - view_default_autocomplete.hide           — add the 'hide' CSS class
*   - view_default_autocomplete.render_grid_choose — open the floating grid chooser
*
* All private helpers (get_content_data, render_source_selector, etc.) are
* module-scoped `const` functions not exported.
*/

// imports
	import {ui} from '../../../common/js/ui.js'
	import {data_manager} from '../../../common/js/data_manager.js'
	import {event_manager} from '../../../common/js/event_manager.js'
	import {clone, same_section_id, append_text_lines} from '../../../common/js/utils/index.js'
	import {get_instance} from '../../../common/js/instances.js'
	import {get_section_records} from '../../../section/js/section.js'
	// the ONE label-key resolver for an external source_status. Shared with
	// component_external so a state never gets two different words.
	import {source_status_label} from '../../../component_external/js/external_render.js'
	import {request_failed, response_data} from '../../../common/js/api_error.js'



/**
* VIEW_DEFAULT_AUTOCOMPLETE
* Constructor / namespace object for the default autocomplete view.
* Returns true immediately; the real work is performed by the static methods
* attached below (render, show, hide, render_grid_choose).
* @returns {boolean} Always true
*/
export const view_default_autocomplete = function() {

	return true
}//end view_default_autocomplete



/**
* RENDER
* Build and return the full autocomplete widget wrapper (or content fragment
* only when render_level === 'content').
*
* When render_level is 'full' (default):
*  - creates the outer `.wrapper_service_autocomplete` div
*  - wires mousedown/click stopPropagation so clicking inside the autocomplete
*    panel does not deactivate the caller component (Alt+click is allowed through
*    for accessibility)
*  - mirrors the caller's 'search' mode and 'hilite_element' state to the wrapper
*  - updates self.node and publishes the 'render_<id>' event
*
* When render_level is 'content':
*  - returns the DocumentFragment produced by get_content_data() directly and
*    fixes the self.node.content_data pointer; no wrapper div is created.
*
* @param {Object} self    - The service_autocomplete instance
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'full' or 'content'
* @returns {Promise<HTMLElement>} The wrapper div (full) or content fragment (content)
*/
view_default_autocomplete.render = async function (self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			// fix pointers
			self.node.content_data = content_data
			return content_data
		}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_service_autocomplete'
		})
		wrapper.appendChild(content_data)
		// fix pointers
		wrapper.content_data = content_data
		// prevent to deactivate component on autocomplete click
		wrapper.addEventListener('mousedown', function(e) {
			if (!e.altKey) {
				e.stopPropagation()
			}
		})
		wrapper.addEventListener('click', function(e) {
			e.stopPropagation()
		})

		if(self.caller?.mode==='search'){
			wrapper.classList.add('search')
		}

		if(self.caller?.node?.classList.contains('hilite_element')){
			wrapper.classList.add('hilite_element')
		}

	// fix node
		self.node = wrapper

	// event publish
		event_manager.publish('render_'+self.id, self.node)



	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the full DOM tree of the autocomplete widget body and returns it as
* a DocumentFragment ready for insertion.
*
* Validates that at least one target section_tipo is configured in
* self.context.request_config before constructing any UI — renders an inline
* debug error message and returns early if none are found.
*
* Sub-regions built (in order):
*  1. options_container (.options_hidden) — hidden by default, toggled by gear button
*     a. source_selector      — render_source_selector()
*     b. sections_selector    — render_filters_selector()
*     c. inputs_list          — render_inputs_list()
*     d. operator_selector    — render_operator_selector()
*  2. search_input             — render_search_input()
*  3. button_options (.gear)   — toggles options_container visibility
*  4. datalist_node (<ul>)     — populated by render_datalist() on each search
*
* Side-effects:
*  - Adds a document-level 'keydown' handler (fn_service_autocomplete_keys) that
*    delegates to self.service_autocomplete_keys(); the handler is removed when
*    the 'deactivate_component' event fires for self.caller.
*  - Stores the keydown handler at self._fn_keydown for external cleanup.
*  - Fixes self.search_input, self.datalist, self.options_container pointers.
*
* (!) The subscription token for 'deactivate_component' is pushed into
*     self.events_tokens — callers must drain this array on destroy to avoid
*     memory leaks.
*
* @param {Object} self - The service_autocomplete instance
* @returns {DocumentFragment} The fully assembled widget content
*/
const get_content_data = function(self) {

	// fragment
		const fragment = new DocumentFragment()

	// check there exists valid target sections before create the options and selector
		const all_ar_section	= []
		const ar_source			= self.context.request_config || []
		const ar_source_length	= ar_source.length
		for (let i = 0; i < ar_source_length; i++) {
			const source		= ar_source[i]
			const current_sqo	= source.sqo
			const ar_section	= current_sqo.section_tipo
			if (ar_section) {
				all_ar_section.push(...ar_section)
			}
		}
		if (all_ar_section.length<1) {
			// The ontology link is an ELEMENT, appended as a node. The sentence goes
			// in as text lines — nothing here is ever parsed as HTML (DS-1).
			const ontology_link		= ui.get_ontology_term_link(self.tipo)
			const debug_container	= ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'debug',
				parent			: fragment
			})
			append_text_lines(debug_container, [
				'Invalid target section tipo (empty).',
				'Please, configure at least one target section tipo for current component:'
			])
			debug_container.appendChild(document.createElement('br'))
			debug_container.appendChild(ontology_link)
			return fragment
		}

	// options container
		const options_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'options_hidden',
			parent			: fragment
		})

	// source selector (Dédalo, Zenon, etc.)
		const source_selector = render_source_selector(self)
		options_container.appendChild(source_selector)

	// sections selector
		const sections_selector = render_filters_selector(self)
		options_container.appendChild(sections_selector)

	// components fields for inputs_list
		const inputs_list = render_inputs_list(self)
		options_container.appendChild(inputs_list)

	// operator selector
		const operator_selector = render_operator_selector(self)
		options_container.appendChild(operator_selector)

	// search_input
		const search_input = render_search_input(self)
		fragment.appendChild(search_input)

		// scroll to search input
			// search_input.addEventListener('focus', function(e){
			// 	e.preventDefault()
			// 	search_input.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'nearest'})
			// })

	// button options
		const button_options = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button_options button gear',
			parent			: fragment
		})
		// add listener to the select
		button_options.addEventListener('mouseup', function() {
			options_container.classList.toggle('visible');
		})

	// datalist_node
		const datalist_node = ui.create_dom_element({
			element_type	: 'ul',
			id				: self.list_name,
			class_name		: 'autocomplete_data',
			parent			: fragment
		})

		// keydown event (document)
		// remove any previous handler first: get_content_data re-runs on every
		// source-selector change, so without this each pass would leave an orphaned
		// document keydown listener (the old closure is no longer in self._fn_keydown
		// and could never be removed) accumulating for the page lifetime.
		if (self._fn_keydown) {
			document.removeEventListener('keydown', self._fn_keydown, false)
		}
		document.addEventListener('keydown', fn_service_autocomplete_keys, false)
		function fn_service_autocomplete_keys(e) {
			// deactivate when the caller is not focused, it block keydown of other components.
			if (!self.caller?.active) {
				return
			}
			self.service_autocomplete_keys(e)
		}
		// remove the event when the caller is deactivate to avoid conflicts between events
		// remove any previous subscription first: get_content_data re-runs on every
		// source-selector change, so without this each pass would leave an orphaned
		// 'deactivate_component' subscription firing for the page lifetime.
		if (self._deactivate_token) {
			event_manager.unsubscribe(self._deactivate_token)
			const prev_index = self.events_tokens.indexOf(self._deactivate_token)
			if (prev_index!==-1) {
				self.events_tokens.splice(prev_index, 1)
			}
		}
		const deactivate_component_handler = (component) => {
			if (component.id===self.caller.id) {
				document.removeEventListener('keydown', fn_service_autocomplete_keys, false)
			}
		}
		self._deactivate_token = event_manager.subscribe('deactivate_component', deactivate_component_handler)
		self.events_tokens.push(self._deactivate_token)

	// store handler reference for cleanup on destroy
		self._fn_keydown = fn_service_autocomplete_keys

	// fix main nodes pointers
		self.search_input		= search_input
		self.datalist			= datalist_node
		self.options_container	= options_container


	return fragment
}//end render // (!) closing label should read '//end get_content_data'; pre-existing typo — do not rename



/**
* RENDER_SOURCE_SELECTOR
* Build a labeled `<select>` drop-down that lets the user switch between the
* available search sources (e.g. Dédalo, Zenon …) defined in
* self.context.request_config.
*
* Each `<option>` value is the numeric string index of the corresponding
* request_config entry. The option label is derived from the first
* section_tipo's label; when multiple section_tipos are present a ", etc."
* suffix is appended.
*
* On change:
*  1. Resets self.search_cache (a Map).
*  2. Clones the selected request_config entry and calls self.build() with it
*     (first resetting self.status to 'initialized' so build() does not
*     short-circuit its 'built' guard).
*  3. Re-renders the content area and replaces self.node's children in place
*     while keeping the options_container visible.
*
* (!) The commented-out `request_ddo` / `ddo_section` lines (lines ~245-246)
*     are dead code from a previous API shape — left for reference.
*
* @param {Object} self - The service_autocomplete instance
* @returns {HTMLElement} The assembled source_selector div
*/
const render_source_selector = function(self) {

	// source elements
		const ar_source = self.context.request_config

	// switcher source
		const source_selector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'source_selector'
		})
		// label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'css_label label',
			inner_html		: get_label.source || 'Source',
			parent			: source_selector
		})
		// select
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'select_source_selector',
			parent			: source_selector
		})

		// options
			const ar_search_length = ar_source.length
			for (let i = 0; i < ar_search_length; i++) {

				const source			= ar_source[i]
				const current_sqo		= source.sqo //find(item => item.typo === 'sqo')
				const ar_section		= current_sqo.section_tipo
				// const request_ddo	= source.find(item => item.typo === 'request_ddo').value
				// const ddo_section	= request_ddo.find(item => item.type === 'section' && item.typo === 'ddo')
				const search_engine		= source.api_engine//find(current_item=> current_item.typo==='search_engine').value

				const label = ar_section && ar_section.length > 1
					? (ar_section[0].label || ('Unknown label ' + ar_section[0])) + ', etc.'
					: ar_section && ar_section[0]
						? ar_section[0].label || ('Unknown label ' + ar_section[0])
						: 'Unknown label ' + JSON.stringify(ar_section)

				const switcher_source = ui.create_dom_element({
					element_type	: 'option',
					parent			: select,
					value			: i.toString(), // pass key as string option
					text_content	: label
				})

				if (search_engine===self.search_engine) {
					switcher_source.setAttribute('selected', true)
				}
			}//end for (let i = 0; i < ar_search_length; i++)

		// add listener to the select
		select.addEventListener('change', async function(e){

			// reset search cache
			self.search_cache = new Map()

			const key = e.target.value

			const request_config_object = clone(self.context.request_config[key])

			// reset status to allow build() to process the new request_config_object
			// (build() short-circuits when status is 'built')
			self.status = 'initialized'

			await self.build({
				request_config_object : request_config_object
			})
			const content_data = await self.render({
				render_level : 'content'
			})

			// clean the last list
			while (self.node.firstChild) {
				self.node.removeChild(self.node.firstChild)
			}
			self.node.appendChild(content_data)
			self.options_container.classList.add('visible');
		})

	// set default value
		// self.build_filter_fields(select.value, options)

	return source_selector
}//end render_source_selector



/**
* RENDER_SEARCH_INPUT
* Create the text input element that drives the autocomplete search.
*
* Behaviour:
*  - 'keyup' fires input_handler on every keystroke; navigation keys
*    (Escape, Arrows, Ctrl, Meta, Alt, Shift, CapsLock, Enter) are ignored.
*  - 'paste' fires input_handler immediately and sets is_searching to true to
*    prevent a duplicate search from the subsequent keyup event.
*  - input_handler debounces the API call: 320 ms by default, collapsed to 1 ms
*    when the query is already cached (self.search_cache.has(q)).
*  - A spinner `<div>` is inserted after the input while the request is in
*    flight and removed on completion or error.
*  - self.split_q() is called to distribute multi-field queries across
*    self.filter_free_nodes when a separator is detected.
*  - Results are cached in self.search_cache keyed by the raw query string q.
*  - The is_searching flag prevents overlapping concurrent requests; it is
*    reset in every exit path of the setTimeout callback.
*
* (!) The scroll-into-view focus listener is commented out (lines ~152-155) —
*     left as dead code for future reference.
*
* @param {Object} self - The service_autocomplete instance
* @returns {HTMLElement} The configured `<input type="text">` element
*/
const render_search_input = function(self) {

	// search field
		const search_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'autocomplete_input'
		})
		search_input.setAttribute('list', self.list_name)
		search_input.setAttribute('placeholder', get_label.find + '...')
		// search_input.setAttribute('autocomplete', 'off')
		search_input.setAttribute('autocorrect', 'off')

		// Init a timeout variable to be used below
			let timeout = null
			let is_searching = false
			// monotonic request sequence: guards against out-of-order autocomplete
			// responses (a slower older request overwriting a newer one).
			if (typeof self._search_seq !== 'number') {
				self._search_seq = 0
			}

		// input_handler
			const input_handler = async function(e) {
				e.stopPropagation();
				e.preventDefault();

				// is_searching. Search is locked until request finish
					if (is_searching === true) {
						return
					}

				// ignore keys
					const ignore_keys = [
						'Escape',
						'ArrowLeft',
						'ArrowRight',
						'ArrowUp',
						'ArrowDown',
						'Control',
						'Meta',
						'Alt',
						'Shift',
						'CapsLock',
						'Enter'
					]
					if (e.key && ignore_keys.includes(e.key)) {
						return
					}

				// is_paste
					const is_paste = (e.type && e.type==='paste')

				// paste case. Note that clipboard event trigger keyup event too. Because this,
				// lock search immediately after paste event to prevent search overlap
					if (is_paste) {
						// lock search until finish to prevent double search
						is_searching = true
						// Get pasted data via clipboard API (set e.preventDefault() before !)
						const clipboardData	= e.clipboardData || window.clipboardData;
						const pastedData	= clipboardData.getData('Text');
						search_input.value	= pastedData
					}

				// loading styles. class searching (remove icon magnifying glass)
					search_input.classList.add('searching')
					// spinner
					const prev_spinner = search_input.parentNode.querySelector('.spinner')
					if(prev_spinner){
						prev_spinner.remove()
					}
					const spinner = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'spinner'
					})
					search_input.parentNode.insertBefore(spinner, search_input.nextSibling);

				// search prepare
					// q
						const q = search_input.value
						self.filter_free_nodes.map(el => {
							el.filter_item.q = ''
							el.value = ''
						})
					// split_q. ar q split iterate
						const split_q	= self.split_q(q)
						const ar_q		= split_q.ar_q
						if (split_q.divisor!==false) {
							// propagate to filter fields
							const filter_free_nodes_len	= self.filter_free_nodes.length
							for (let j = 0; j < filter_free_nodes_len; j++) {
								if (ar_q[j]) {
									self.filter_free_nodes[j].filter_item.q = ar_q[j]
									self.filter_free_nodes[j].value = ar_q[j]
								}
							}
						}else{
							self.filter_free_nodes.map(el => {
								el.filter_item.q = search_input.value
								el.value = search_input.value
							})
						}

				// Clear the timeout if it has already been set.
				// This will prevent the previous task from executing
				// if it has been less than <MILLISECONDS>
					if (timeout) {
						clearTimeout(timeout);
					}

				// datalist container node
					const datalist = self.datalist
					while (datalist.firstChild) {
						datalist.removeChild(datalist.firstChild);
					}
					const loading_label = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'loading_label',
						inner_html		: get_label.searching || 'Searching..',
						parent			: datalist
					})

				// search fire is delayed to enable multiple simultaneous selections
				// get final value (input events are fired one by one)
					const ms = self.search_cache.has(q) || is_paste===true
						? 1
						: 320 * 1
					timeout = setTimeout(async()=>{

						// request sequence token. A slower in-flight request must not
						// overwrite the results of a newer keystroke's request.
						const my_seq = ++self._search_seq

						try {
							await execute_search_render(self, {
								q				: q,
								my_seq			: my_seq,
								loading_label	: loading_label,
								spinner			: spinner,
								search_input	: search_input
							})
						} finally {
							is_searching = false
						}
					}, ms)
			}//end input_handler

		// event input. changes the input value fire the search
			search_input.addEventListener('keyup', input_handler);

		// event paste
			search_input.addEventListener('paste', input_handler);


	return search_input
}//end render_search_input



/**
* RENDER_SEARCH_NOTICE
* Say WHY the datalist is empty, when there is something to say.
*
* An autocomplete that answers every failure with an empty list tells the
* curator one thing — "nothing matches" — for four completely different
* situations: the catalogue really has no match, the external source is down,
* this installation has not allowlisted its host (or has switched it off), or
* nothing was typed. Those need different actions, so they need different
* words.
*
* THE TEXT IS NEVER PROSE FROM THIS FILE. The server sends the same typed
* `source_status` the record path sends ({service, state, label_key,
* retryable} — src/core/components/component_external/value.ts), and
* `source_status_label` resolves the label KEY through the labels catalog. The
* only status this client builds itself is the local 'empty_query' one, which
* never leaves the browser because nothing was asked; it too carries a key.
*
* A response that failed with NO status is the transport failing in front of
* the envelope (a 4xx, whose body `data_manager.request` discards, or a thrown
* fetch): 'external_search_failed', still a key, never the old
* 'There was a network error' string built at the XHR site.
*
* The `state_<state>` class is what makes the neutral case (nothing typed) look
* unlike the failures; the title carries the untranslated diagnostics — the
* service name and the engine's error tokens ('external_blocked_host',
* 'external_circuit_open', …) — which name the finer grain the closed state set
* folds together and are what an operator quotes in a bug report.
*
* @param {Object} self - The service_autocomplete instance
* @param {Object|null} api_response - the response, or null when it threw
* @returns {HTMLElement|null} the appended notice, or null when there is
*   nothing to say (a plain successful search)
*/
export const render_search_notice = function(self, api_response) {

	// datalist. Nothing to render into (the widget is not built / was destroyed)
		const datalist = self ? self.datalist : null
		if (!datalist) {
			return null
		}

	// status. Either the engine's typed state, or — when the response failed
	// with no envelope at all — the generic failure, which is still a key.
	//
	// THE FALLBACK IS ENGINE-SCOPED. `render_search_notice` runs for EVERY
	// autocomplete, dedalo ones included (numisdata161 declares no api_engine at
	// all), so labelling any failed response 'external_search_failed' told a
	// cataloguer that an external source had failed when no external source was
	// involved — it sent them looking at Zenon for a plain SQO error. A dedalo
	// engine keeps the pre-2026-08-06 behaviour: no notice, the failure surfaces
	// through the normal error path. Only the ENGINE's own typed source_status
	// is ever rendered for it, and a dedalo engine never sends one.
		const is_external	= !!(self && self.search_engine && self.search_engine!=='dedalo')
		// Envelope v2: a DEGRADED external search is a SUCCESS (`ok:true` + a
		// `notices[]` entry + the `source_status` extension key) — the request was
		// well-formed, the SOURCE is what is down (ERRORS_SPEC §5.4). So "failed"
		// is `request_failed()`, never `result===false`, which a degraded search
		// no longer sets.
		const succeeded		= !!api_response && !request_failed(api_response)
		const status		= (api_response && api_response.source_status)
			? api_response.source_status
			: (succeeded
				? null
				: {
					state		: 'failed',
					// Only an EXTERNAL engine may blame an external source. A
					// dedalo search that fails is a dedalo failure, and saying
					// otherwise sends the cataloguer to inspect a service that
					// was never contacted. Both are still label KEYS.
					label_key	: is_external ? 'external_search_failed' : 'search_failed',
					retryable	: true
				})
		if (!status) {
			return null
		}

	// diagnostics. The notice title carries the server's error tokens, but a
	// failure is worth a console line too: the tokens are what an operator
	// quotes in a bug report, and a dropdown title is easy to miss.
		if (!succeeded && typeof console!=='undefined') {
			console.error('[autocomplete] search failed. engine:', self ? self.search_engine : null,
				'component:', self ? self.tipo : null, 'response:', api_response)
		}

	// title. Diagnostics for the operator, plain text.
		const title_parts = []
		if (status.service) {
			title_parts.push(status.service)
		}
		// the code IS the diagnostic an operator quotes: the failure's `error.code`,
		// and — on a degraded success — the notice codes.
		if (api_response && api_response.error && typeof api_response.error.code==='string') {
			title_parts.push(api_response.error.code)
		}
		if (api_response && Array.isArray(api_response.notices)) {
			for (const notice of api_response.notices) {
				if (typeof notice?.code==='string') {
					title_parts.push(notice.code)
				}
			}
		}

	// node
		const notice = ui.create_dom_element({
			// a div, exactly like the sibling loading_label: the datalist ul holds
			// selectable rows, and a notice must never be arrow-key selectable.
			element_type	: 'div',
			class_name		: 'search_notice state_' + (status.state || 'unknown'),
			text_content	: source_status_label(status),
			title			: title_parts.join(' · '),
			parent			: datalist
		})

	return notice
}//end render_search_notice



/**
* EXECUTE_SEARCH_RENDER
* Runs one autocomplete search (cache-aware) and renders the result into the
* datalist, then clears the per-request loading UI for the latest request.
*
* Extracted from render_search_input so the search→render→cleanup contract can
* be exercised in isolation. The request-sequence token (my_seq) guards against
* out-of-order responses: a slower older request must not overwrite a newer one.
*
* @param {Object} self    - The service_autocomplete instance
* @param {Object} options - { q, my_seq, loading_label, spinner, search_input }
* @returns {Promise<void>}
*/
export const execute_search_render = async function(self, options) {

	const q				= options.q
	const my_seq		= options.my_seq
	const loading_label	= options.loading_label
	const spinner		= options.spinner
	const search_input	= options.search_input

	try {
		// api_response. Get from cache if exists. A cache hit is replayed as a
		// plain SUCCESS envelope: only clean, non-degraded answers are ever
		// cached (see the cache-write guard below), so it carries no notice.
			const cached = q.length ? self.search_cache.get(q) : undefined
			const api_response = cached
				? { ok : true, data : cached, result : cached }
				: await self.autocomplete_search()

		// a newer search superseded this one: drop the stale response
			if (my_seq !== self._search_seq) {
				return
			}

		// no result from API case. NAMED, never swallowed: until 2026-08-06 this
		// early return dropped the response on the floor, so a search against a
		// dead (or CSP-blocked) external source was indistinguishable from a
		// search that found nothing. The notice reads the typed state the engine
		// sends and renders its LABEL KEY.
			if (!api_response || request_failed(api_response)) {
				await render_datalist(self, null)
				render_search_notice(self, api_response)
				return
			}

		// cache result. Add if not already exists (bounded to avoid unbounded growth
		// over a long typing session; once full, new queries simply skip the cache).
		//
		// NEVER CACHE A DEGRADED ANSWER. A degraded external search now succeeds
		// (`ok:true` + `notices[]` + a `source_status` whose state is never 'ok' —
		// the field is omitted entirely on a clean answer, ERRORS_SPEC §5.4), so the
		// old `result!==false` guard no longer keeps it out: without this the empty
		// list a down source returned would be pinned to `q` for the rest of the
		// typing session, and the source coming back up would never be noticed.
			const degraded = (Array.isArray(api_response.notices) && api_response.notices.length > 0)
				|| (!!api_response.source_status && api_response.source_status.state !== 'ok')
		// A Map, never a plain object keyed by the typed query: q is user text, and
		// q='__proto__' would re-parent a `{}` cache (CodeQL #8105).
			if (!degraded && !self.search_cache.has(q) && self.search_cache.size < 100) {
				self.search_cache.set(q, response_data(api_response))
			}

		// render datalist (call API and render the response result)
			await render_datalist(self, response_data(api_response))

		// notice. A successful response may still carry a state worth saying —
		// today the local 'empty_query' one, which never leaves the browser.
			render_search_notice(self, api_response)

	} catch (error) {
		// a failed search must not jam the widget or raise an unhandled promise
		// rejection; log, SAY SO in the datalist, and fall through to the cleanup.
		console.error('[service_autocomplete] autocomplete search failed:', error)
		if (my_seq === self._search_seq) {
			await render_datalist(self, null)
			render_search_notice(self, null)
		}
	} finally {
		// always clear the loading UI for the latest request — even on error / no
		// result / stale — so a thrown search can never leave a stuck "Searching..".
		if (my_seq === self._search_seq) {
			if (loading_label && loading_label.parentNode) {
				loading_label.remove()
			}
			search_input.classList.remove('searching')
			if (spinner) {
				spinner.remove()
			}
		}
	}
}//end execute_search_render



/**
* RUN_SEARCH
* Fire an autocomplete search and render its result. Used by the option controls
* (sections / filter_by_list checkboxes, operator, limit, per-field inputs); the
* main search input uses execute_search_render. Both share self._search_seq so a
* slower older request can never overwrite a newer one, regardless of which
* control triggered it.
*
* @param {Object} self - The service_autocomplete instance
* @returns {Promise<void>}
*/
export const run_search = async function(self) {

	// request sequence token (shared with execute_search_render). A slower older
	// request must not overwrite the results of a newer one from any control.
	const my_seq = (typeof self._search_seq==='number' ? self._search_seq : 0) + 1
	self._search_seq = my_seq

	try {
		const api_response = await self.autocomplete_search()

		// a newer search superseded this one: drop the stale response
		if (my_seq !== self._search_seq) {
			return
		}

		const result = (api_response && !request_failed(api_response))
			? response_data(api_response)
			: null

		await render_datalist(self, result)
		render_search_notice(self, api_response)

	} catch (error) {
		// a failed search must not raise an unhandled rejection; clear the list
		// and say why it is empty.
		console.error('[service_autocomplete] autocomplete search failed:', error)
		if (my_seq === self._search_seq) {
			await render_datalist(self, null)
			render_search_notice(self, null)
		}
	}
}//end run_search



/**
* RENDER_FILTERS_SELECTOR
* Build the filter panel that contains one or more checkbox groups:
*
*  1. Sections filter — one checkbox per entry in self.ar_search_section_tipo;
*     toggling a checkbox adds/removes the section_tipo from ar_search_section_tipo
*     and resets self.search_cache.
*
*  2. filter_by_list groups — one group per entry in
*     self.rqo_search.sqo_options.filter_by_list (when present); each checkbox
*     represents a relation value and pushes/splices entries into
*     self.ar_filter_by_list. The filter value object is a format:'relation'
*     leaf whose q is a partial locator (from_component_tipo + section_tipo +
*     section_id) resolved server-side on matrix_relation_index.
*
* Checkbox state is persisted to localStorage under the key
* `service_autocomplete_${self.id_base}` as a JSON array of active IDs.
* On first render the full set of IDs is written; subsequent renders read
* existing state.
*
* Side-effects: sets self.filters_container pointer.
*
* (!) The commented-out `css_autocomplete_hi_search_field` class name on the
*     filters_container (line ~494) is a leftover from an older naming scheme.
*
* @param {Object} self - The service_autocomplete instance
* @returns {HTMLElement} The populated filters_container div
*/
const render_filters_selector = function(self) {

	const ar_id = []

	// container. Filters container
		const filters_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'filters_container' // css_autocomplete_hi_search_field
		})
		// fix
		self.filters_container = filters_container

	// sections filter
		const ar_sections			= self.ar_search_section_tipo // defined on init
		const ar_sections_length	= ar_sections.length
		if (ar_sections_length>0) {

			// get the datalist of all sections to create the checkbox
			const filter_items = []
			for (let i = 0; i < ar_sections_length; i++) {

				const section_tipo		= ar_sections[i]

				const label_find = self.request_config_object.sqo.section_tipo.find(el=> el.tipo===section_tipo)
				const label = label_find
					? label_find.label
					: ''

				const datalist_item	= {
					grouper	: 'sections',
					id		: section_tipo,
					value	: section_tipo,
					label	: label,
					change	: function(input_node){

						// reset search cache
						self.search_cache = new Map()

						// State-idempotent sync (same defect as the filter_by_list
						// callback, 2026-07-09): ar_sections MIRRORS the checked
						// boxes. The old transition logic spliced index -1 (= last
						// element) when unchecking an untracked box, and REMOVED a
						// pre-seeded section on a redundant 'checked' notification.
						const index = ar_sections.indexOf(input_node.dd_value)
						if (input_node.checked===true) {
							if (index===-1) {
								ar_sections.push(input_node.dd_value)
							}
						}else if (index!==-1) {
							ar_sections.splice(index, 1);
						}
					}
				}
				filter_items.push(datalist_item)

				ar_id.push(section_tipo) // add to global array of id
			}

			const filter_id		= self.list_name
			const filter_label	= get_label.sections || "Sections"
			const filter_node	= build_filter(self, filter_items, filter_label, filter_id)
			filters_container.appendChild(filter_node)
		}

	// filter_by_list. if the component caller has a filter_by_list we add the datalist of the component
		const filter_by_list = self.rqo_search.sqo_options.filter_by_list//find(item => item.typo==='filter_by_list') || false
		if(filter_by_list) {

			const ar_filter_by_list	= self.ar_filter_by_list

			const filter_by_list_value_length = filter_by_list.length
			for (let i = 0; i < filter_by_list_value_length; i++) {

				const current_filter		= filter_by_list[i]
				const section				= current_filter.context.section_tipo
				const component_tipo		= current_filter.context.tipo
				const component_datalist	= current_filter.datalist
				const filter_label			= current_filter.context.label

				const filter_items = []
				for (let j = 0; j < component_datalist.length; j++) {

					const current_datalist	= component_datalist[j]
					const id				= section +'_'+ component_tipo +'_'+ current_datalist.section_id
					// q is a partial locator (format:'relation'): match records whose
					// relation column holds a locator with these fields. Replaces the
					// legacy format:'function' flat key ('<fct>_<st>_<si>') — the server
					// resolves this on matrix_relation_index, no DB function involved.
					const q					= {
						from_component_tipo	: component_tipo,
						section_tipo		: current_datalist.value.section_tipo,
						section_id			: current_datalist.value.section_id
					}
					const path				= [{
						section_tipo	: section,
						component_tipo	: component_tipo
					}]
					const datalist_item		= {
						grouper	: component_tipo,
						id		: id,
						value	: {
							q				: q,
							path			: path,
							format 			: 'relation'
						},
						label	: current_datalist.label,
						change	: function(input_node){

							// reset search cache
							self.search_cache = new Map()

							// State-idempotent sync: ar_filter_by_list MIRRORS the checked
							// boxes. The previous transition-based logic broke unchecking:
							// a box that was never pushed resolved index -1 and
							// splice(-1,1) removed the LAST entry (or no-op'd on empty), so
							// deselecting a catalogue never narrowed the search (2026-07-09,
							// numisdata161 pre-filter bug; same defect upstream — DEC-16).
							const index = ar_filter_by_list.findIndex(item => item.id===input_node.id)
							if (input_node.checked===true) {
								if (index===-1) {
									ar_filter_by_list.push({
										id		: input_node.id,
										value	: input_node.dd_value
									})
								}
							}else if (index!==-1) {
								ar_filter_by_list.splice(index, 1);
							}
						}
					}
					filter_items.push(datalist_item)
					// NOTE: ar_filter_by_list is seeded from each checkbox's INITIAL
					// checked state in render_option_checkbox (the change callback is
					// idempotent, so seeding cannot invert the checkbox logic). A full
					// selection is dropped by the engine's is_full_list_selection fast
					// path, so the default all-checked state still searches unfiltered.

					ar_id.push(id) // add to global array of id
				}
				const filter_id		= 'filter_by_list_' + component_tipo + '_' + i
				const filter_node	= build_filter(self, filter_items, filter_label,  filter_id)
				filters_container.appendChild(filter_node)
			}
		}

	// localStorage
		if (!localStorage.getItem(`service_autocomplete_${self.id_base}`)) {
			// add full the first time
			localStorage.setItem(`service_autocomplete_${self.id_base}`, JSON.stringify(ar_id) )
		}


	return filters_container
}//end render_filters_selector



/**
* BUILD_FILTER
* Render a labeled `<ul>` of checkbox items for a single filter group,
* including an "All" master-checkbox that dispatches individual change events
* to each child checkbox so their own handlers remain the single source of truth.
*
* Structure:
*   <ul class="filter_node">
*     <li class="all_selector">
*       <label><input type="checkbox" id="<filter_id>_all"> All <filter_name></label>
*     </li>
*     <li>…render_option_checkbox() per item…</li>
*   </ul>
*
* The "All" checkbox change handler iterates all child inputs and fires a
* synthetic 'change' Event on each one that differs from the new state, so
* localStorage and self.search_cache are updated consistently.
*
* @param {Object} self         - The service_autocomplete instance
* @param {Array}  filter_items - Array of datalist item descriptors passed to render_option_checkbox
* @param {string} filter_name  - Human-readable label for the group (e.g. "Sections")
* @param {string} filter_id    - Base id string for the "All" checkbox element
* @returns {HTMLElement} The assembled `<ul>` filter_node
*/
const build_filter = function(self, filter_items, filter_name, filter_id) {

	const filter_node = ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'filter_node'
	})

	// all_selector li
		const all_selector = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'all_selector',
			parent			: filter_node
		})

	// label
		const label = get_label.all || 'All'
		const all_section_label = ui.create_dom_element({
			element_type	: 'label',
			text_content	: label + ' ' + filter_name,
			parent			: all_selector
		})

	// all_section_checkbox
		const all_section_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			id				: filter_id + '_all'
		})
		all_section_checkbox.checked = false
		// change event
		const change_handler = (e) => {
			// reset search cache
			self.search_cache = new Map()

			const checked_value	= e.target.checked
			const inputs		= filter_node.querySelectorAll('input')
			for (let i = 0; i < inputs.length; i++) {
				if (inputs[i]==all_section_checkbox) continue;
				if (inputs[i].checked!==checked_value) {
					inputs[i].checked = checked_value
					inputs[i].dispatchEvent(new Event('change'));
				}
			}
		}
		all_section_checkbox.addEventListener('change', change_handler);
		// prepend
		all_section_label.prepend(all_section_checkbox)

	// items
		filter_items.map(filter_item => {
			const chekbox_node = render_option_checkbox(self, filter_item)
			filter_node.appendChild(chekbox_node)
		})


	return filter_node
}//end build_filter



/**
* SAFE_JSON_PARSE
* Parses JSON from localStorage with error handling.
* Returns null instead of throwing when the stored value is absent or malformed.
*
* @param {string} key - localStorage key to read and parse
* @returns {*} Parsed value, or null on parse error / missing key
*/
const safe_json_parse = function(key) {
	try {
		return JSON.parse(localStorage.getItem(key))
	} catch (e) {
		return null
	}
}//end safe_json_parse



/**
* RENDER_OPTION_CHECKBOX
* Build a single `<li>` containing a labeled checkbox for one filter option.
*
* Checkbox initial state defaults to checked (true); the state is then
* reconciled against the localStorage array via safe_json_parse() — if the id
* is present in the stored array the checkbox is checked, otherwise unchecked.
* The datalist_item.change callback is invoked immediately during init when the
* state needs to change, so the parent arrays (ar_sections / ar_filter_by_list)
* stay consistent without a DOM event.
*
* On subsequent user interaction ('change' event):
*  1. Calls datalist_item.change(this) to update the parent tracking array.
*  2. Calls update_local_storage_ar_id() to sync localStorage.
*  3. Fires self.autocomplete_search() and refreshes the datalist.
*
* The inner update_local_storage_ar_id closure reads the localStorage array,
* splices/pushes the id, and re-serialises it. Returns the found index (or -1),
* or false when the localStorage key is absent.
*
* @param {Object} self          - The service_autocomplete instance
* @param {Object} datalist_item - Filter item descriptor with id, value, label, change
* @returns {HTMLElement} The assembled `<li>` element
*/
const render_option_checkbox = function(self, datalist_item) {

	const id		= datalist_item.id
	const value		= datalist_item.value
	const label		= datalist_item.label || value
	const change	= datalist_item.change

	// li container
		const li = ui.create_dom_element({
			element_type : 'li'
		})

	// label
		const section_label = ui.create_dom_element({
			element_type	: 'label',
			inner_html		: label,
			title			: label,
			parent			: li
		})

	// input_checkbox
		const input_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			id				: id

		})
		input_checkbox.checked	= true; // default value is true
		input_checkbox.dd_value	= value

		// local storage check. If exists, use it to update checked status
			const local_storage_ar_id = safe_json_parse(`service_autocomplete_${self.id_base}`)
		if (local_storage_ar_id) {
			input_checkbox.checked = local_storage_ar_id.includes(id)
		}

		// seed the caller's state from the INITIAL checked value (the change
		// callback is idempotent): the filter list must mirror the checked
		// boxes from the first render, or the first UNCHECK is a no-op and the
		// pre-filter never narrows (2026-07-09, numisdata161 bug).
			change(input_checkbox)

		// event change
			const change_handler = async function(e) {
				// reset search cache
				self.search_cache = new Map()

				change(this) // caller callback function

				update_local_storage_ar_id(this)

				// force re-search with new options (sequenced to avoid out-of-order renders)
					await run_search(self)
			}
			input_checkbox.addEventListener('change', change_handler);

		// local_storage update
			const update_local_storage_ar_id = function(element) {

				const id			= element.id
				const current_state	= element.checked

				const local_storage_ar_id = safe_json_parse(`service_autocomplete_${self.id_base}`)
				if (local_storage_ar_id) {
					// State-idempotent sync (same defect as the ar_filter_by_list
					// callback, 2026-07-09): the stored list MIRRORS the checked
					// boxes. The old transition logic spliced key -1 (= last id) on
					// an uncheck of an untracked box and REMOVED a stored id on a
					// redundant 'checked' event (the master "All" toggle emits
					// them in bulk), scrambling the persisted checkbox state.
					const key = local_storage_ar_id.indexOf(id)
					if (current_state===true) {
						if (key===-1) {
							local_storage_ar_id.push(id)
						}
					}else if (key!==-1) {
						local_storage_ar_id.splice(key, 1);
					}
					// save updated array
					localStorage.setItem(`service_autocomplete_${self.id_base}`, JSON.stringify(local_storage_ar_id) )

					return key
				}

				return false
			}

		// prepend
		section_label.prepend(input_checkbox)


	return li
}//end render_option_checkbox



// pause after the last keystroke before a per-field input searches (same
// cadence as the main search input)
const FILTER_INPUT_DEBOUNCE_MS = 320



/**
* RENDER_INPUTS_LIST
* Build a set of labelled text inputs — one per filter_free item — that allow
* the user to type per-field search terms independently of the main search input.
*
* Iterates self.rqo_search.sqo_options.filter_free (an object keyed by
* operator, each value an array of filter items). For each filter item the last
* element of filter_item.path carries the component label (HTML tags are
* stripped before display).
*
* Each input:
*  - Sets filter_item.q and fires run_search() FILTER_INPUT_DEBOUNCE_MS after
*    the user stops typing ('input'), or at once on 'change' / Enter; a value
*    already searched is not searched again, except on Enter (explicit retry).
*  - Labels a deep path with every step's label (Modelo › Término).
*  - Stores a back-reference (component_input.filter_item = filter_item) so
*    the main search input's input_handler can also update the q values via
*    self.filter_free_nodes.
*
* Side-effect: pushes each component_input into self.filter_free_nodes.
*
* @param {Object} self - The service_autocomplete instance
* @returns {HTMLElement} The `.inputs_list` div containing all field inputs
*/
const render_inputs_list = function(self) {

	const inputs_list = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'inputs_list'
	})

	const filter_free = self.rqo_search.sqo_options.filter_free
	for (const operator in filter_free) {

		const filter_group			= filter_free[operator]
		const filter_group_length	= filter_group.length
		for (let i = 0; i < filter_group_length; i++) {

			const filter_item = filter_group[i]

			// label. A deep path (a relation column searched through what it
			// displays, e.g. Modelo › Término) names every step, so two
			// 'Término' inputs stay distinguishable
			const component_label = filter_item.path
				.map(ddo => ddo.label ? ddo.label.replace(/(<([^>]+)>)/ig, '') : '')
				.filter(Boolean)
				.join(' › ')

			// input_group
			const input_group = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'input_group',
				parent			: inputs_list
			})

			// input
			const component_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'text',
				parent			: input_group
			})

			// placeholder (replaced by the label to allow to know what we are editing anytime)
				// component_input.setAttribute('placeholder', component_label )

			// label
			ui.create_dom_element({
				element_type	: 'label',
				inner_html		: component_label,
				parent			: input_group
			})

			// set pointer
			component_input.filter_item = filter_item

			// change event
			// typing searches after a pause (input_handler); 'change' and Enter
			// search at once. A value already in filter_item.q (searched by the
			// debounce, or set by the main search input) is not searched again,
			// except on Enter (force), the explicit retry. A detached input (the
			// service was destroyed while a pause was pending) never searches.
			let timeout = null
			const change_handler = async (force=false) => {
				clearTimeout(timeout)
				if (!component_input.isConnected) {
					return
				}
				if (force!==true && component_input.value===(filter_item.q ?? '')) {
					return
				}
				// reset search cache (a per-field input changes the query, like every other control)
				self.search_cache = new Map()
				// update filter_item q value from input
				filter_item.q = component_input.value
				// force search (sequenced to avoid out-of-order renders)
				await run_search(self)
			}
			component_input.addEventListener('change', () => change_handler())

			// input event. Debounced search while typing
			const input_handler = (e) => {
				e.stopPropagation()
				clearTimeout(timeout)
				timeout = setTimeout(() => change_handler(), FILTER_INPUT_DEBOUNCE_MS)
			}
			component_input.addEventListener('input', input_handler)

			// keyup event
			const keyup_handler = (e) => {
				e.stopPropagation()
				if (e.key==='Enter') {
					change_handler(true)
				}
			}
			component_input.addEventListener('keyup', keyup_handler)

			// add node
			self.filter_free_nodes.push(component_input)
		}
	}//end for (let operator in filter_free)


	return inputs_list
}//end render_inputs_list



/**
* RENDER_OPERATOR_SELECTOR
* Build the operator/limit control panel containing:
*
*  - A `<select>` for the boolean search operator ($or / $and) that updates
*    self.operator and re-fires the search on change.
*  - A numeric `<input>` (type="number") for the result limit that updates
*    self.limit, persists the value to localStorage under
*    'service_autocomplete_limit', and re-fires the search on change or Enter.
*
* The operator select's 'click' handler stops propagation to prevent the panel
* from collapsing when interacting with the control.
*
* (!) fn_change and fn_keyup are declared as named function declarations inside
*     the function body and referenced via addEventListener — hoisting makes
*     them available before the addEventListener calls despite the reversed
*     declaration order in the source.
*
* @param {Object} self - The service_autocomplete instance
* @returns {HTMLElement} The `.search_operators_div` container
*/
const render_operator_selector = function(self) {

	// operator selector. Get the operator to use into the filter free
		const operator	= self.operator

	// operator_selector
		const operator_selector = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_operators_div'
		})

	// select_container
		const select_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'select_container',
			parent			: operator_selector
		})
	// label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'css_label label',
			inner_html		: get_label.search_operators || 'Search operators',
			parent			: select_container
		})
	// select
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'operator_selector',
			parent			: select_container
		})
		select.addEventListener('click', function(e) {
			e.stopPropagation()
		})
		select.addEventListener('change', async function(e){

			// reset search cache
			self.search_cache = new Map()

			// set the new operator selected
			self.operator	= e.target.value

			// launch search again (sequenced to avoid out-of-order renders)
			await run_search(self)
		})
		const option_or = ui.create_dom_element({
			element_type	: 'option',
			value			: '$or',
			inner_html		: get_label.or || 'or',
			parent			: select
		})
		const option_and = ui.create_dom_element({
			element_type	: 'option',
			value			: '$and',
			inner_html		: get_label.and || 'and',
			parent			: select
		})
		if (operator==='$or') {
			option_or.setAttribute('selected', true)
		}else{
			option_and.setAttribute('selected', true)
		}

	// max_container
		const max_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'max_container',
			parent			: operator_selector
		})
	// label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'css_label label_max',
			inner_html		: get_label.max || 'Max.',
			parent			: max_container
		})
	// input
		const input_max = ui.create_dom_element({
			element_type	: 'input',
			type			: 'number',
			class_name		: 'input_max',
			value			: self.limit,
			parent			: max_container
		})
		input_max.addEventListener('change', fn_change)
		async function fn_change(e) {

			// reset search cache
			self.search_cache = new Map()

			const value = parseInt( e.target.value )
			if (value<1) {
				return
			}

			// update self limit
			self.limit = value

			// launch search again (sequenced to avoid out-of-order renders)
			await run_search(self)

			// update localStorage limit value
			localStorage.setItem('service_autocomplete_limit', self.limit )
		}
		input_max.addEventListener('keyup', fn_keyup)
		async function fn_keyup(e) {
			e.preventDefault()

			if (e.key==='Enter') {
				// Create the event
				const change_event = new CustomEvent("change", {});
				// Dispatch/Trigger/Fire the event
				input_max.dispatchEvent(change_event);
			}
		}


	return operator_selector
}//end render_operator_selector



/**
* RENDER_DATALIST
* Render API search results as `<li>` rows inside the self.datalist `<ul>`.
*
* Steps:
*  1. Clears the existing datalist children.
*  2. Returns early (empty datalist) when result is falsy, missing data, or
*     the 'sections' entry has no entries.
*  3. Stores result on self.datum so that ddinfo column renderers can read
*     autocomplete data instead of fetching section_records independently.
*  4. Strips unused properties (publication dates, etc.) from entries to build
*     a lean `value` array of {section_tipo, section_id, paginated_key}.
*  5. Calls get_section_records() with a unique id_variant (timestamp-based) to
*     avoid collisions with page-level component instances.
*  6. Stores returned instances in self.ar_instances for later cleanup.
*  7. For each section_record creates a `<li class="autocomplete_data_li">` with:
*       - mouseenter/mouseleave: toggle 'selected' class
*       - click: calls selection_handler (see below)
*     Rows are appended ONLY after their section_record has rendered, in result
*     order, and the function resolves when every row is complete. Appending the
*     empty `<li>`s first (the old `.then()` shape) painted the open list as a
*     tall band of empty rows until each record resolved — a blank dropdown that
*     covered the page on a slow render.
*
* selection_handler logic:
*  - Checks self.properties.events for a custom 'add_value' event handler.
*    If found, calls view_default_autocomplete[add_value.perform.function]()
*    and opens the grid-choose panel; warns to console when the function is
*    not defined on the view object.
*  - Default (no custom event): AWAITS `commit_selection` (the caller's
*    `link_records` door, refusals surfaced as a notification), then clears
*    the datalist and search input, and hides the service.
*
* (!) The commented-out `data` / `context` / `ar_search_sections` blocks
*     (lines ~1058-1078) reflect an older API data shape — retained for history.
* (!) id_variant is regenerated on every call so instances are never cached;
*     this is intentional per the inline comment.
*
* @param {Object} self   - The service_autocomplete instance
* @param {Object} result - The api_response.result object from autocomplete_search
* @returns {Promise<HTMLElement>} The populated (or cleared) datalist `<ul>`
*/
export const render_datalist = async function(self, result) {

	// render token. A newer render_datalist supersedes this one: without it a
	// slow older render would append its rows AFTER the newer render cleared
	// the list, leaving results that no longer match the typed query.
		self._render_token = (self._render_token || 0) + 1
		const render_token = self._render_token

	// datalist container node
		const datalist = self.datalist

	// clean the last list
		while (datalist.firstChild) {
			datalist.removeChild(datalist.firstChild)
		}

	// destroy the previous batch of section_record instances before building a new
	// list. render_datalist runs on every keystroke / option change with a fresh
	// timestamp-based id_variant, so these instances are never reused; without an
	// explicit destroy they accumulate forever in the global instances registry
	// (a memory + DOM leak that grows with each search). Done before the early
	// returns so an empty result also releases the prior batch.
		const previous_instances = Array.isArray(self.ar_instances) ? self.ar_instances : []
		self.ar_instances = []
		if (previous_instances.length>0) {
			const ar_destroy = []
			for (let i = 0; i < previous_instances.length; i++) {
				const instance = previous_instances[i]
				if (instance && typeof instance.destroy==='function') {
					ar_destroy.push(instance.destroy(true, true, true))
				}
			}
			await Promise.all(ar_destroy)
		}

	// empty or falsy result case
		if (!result || result===false || !result.data || !result.data.length) {
			return datalist
		}

	// total
		const sections_data	= result.data.find(el => el.typo==='sections')
		const total			= sections_data && sections_data.entries
			? sections_data.entries.length
			: 0
		// if the api doesn't send any data, do not continue, return empty datalist
		if (total===0) {
			return datalist
		}

	// datum. Added result as datum because will be necessary to render ddinfo column
	// ddinfo will get data from autocomplete service instead the section_record
	// ddinfo column is dependent of the caller (component_portal or in these case service autocomplete)
		self.datum = result

	// data. if the api doesn't send any data, do not continue, return empty datalist
		// const data = result.data.find(el=> el.tipo===self.tipo && el.typo==='sections')
		// if(!data){
		// 	return datalist
		// }

	// value. Remove unused value items properties (publication_first_date, publication_last_user, etc.)
		const value = sections_data.entries.map(el => {
			const item = {
				section_tipo	: el.section_tipo,
				section_id		: el.section_id,
				paginated_key	: el.paginated_key
			}
			return item
		})

	// context
		// const context = result.context

	// get the sections that was searched
		// const ar_search_sections = self.ar_search_section_tipo

	// rqo_search. Get dd objects from the context that will be used to build the lists in correct order
		const rqo_search = self.rqo_search

	// fields_separator. Get the fields_separator between columns
		const fields_separator = (rqo_search.show.fields_separator)
			? rqo_search.show.fields_separator
			: ' | '

	// get the ar_locator founded in sections
		// const data_locator	= data.find((item)=> item.tipo === rqo_search.source.tipo && item.typo === 'sections');
		// const ar_locator	= (data_locator) ? data_locator.value : []

	// ar_instances was already reset (and the previous batch destroyed) at the top
	// of this function, before the early returns.

	// id_variant. Don't allow cache instances here because interact with page instances.
	// Use always a custom id_variant to prevent it
		const id_variant = (self.id_variant || '') + '_' + new Date().getTime()

	// ar_section_record
		const ar_section_record	= await get_section_records({
			caller				: self,
			mode				: 'list',
			view				: 'text',
			datum				: result,
			entries				: value,
			request_config		: [self.rqo_search],
			columns_map			: self.columns_map,
			fields_separator	: fields_separator,
			id_variant			: id_variant
		})
		// store to allow destroy later
		self.ar_instances.push(...ar_section_record)

	// a newer render superseded this one while the records were being built
		if (render_token !== self._render_token) {
			return datalist
		}

	// mouseenter_handler
		const mouseenter_handler = async (e) => {
			e.stopPropagation()
			// reset
				const children = e.target.parentNode.children || [];
				[...children].map((el)=>{
					if(el.classList.contains('selected')) {
						el.classList.remove('selected')
					}
				})
			// set as selected
				e.target.classList.add('selected')
		}

	// mouseleave_handler
		const mouseleave_handler = async (e) => {
			e.stopPropagation()
			e.target.classList.remove('selected')
		}

	// selection_handler
		const selection_handler = async (options) => {
			// options
				const e							= options.e
				const current_section_record	= options.current_section_record
				const locator					= options.locator
				const datalist					= options.datalist

			// value
				const value = locator

			// events
				const events = self.properties.events || null
				if(events){

					// custom events manager from properties

					const add_value = events.find(el => el.event === 'add_value')
					// caller is refreshed after add value
					if(add_value){
						if(typeof view_default_autocomplete[add_value.perform.function] === 'function'){

							const params	= add_value.perform.params
							const grid_node	= await view_default_autocomplete[add_value.perform.function](self, current_section_record , params)
							if(grid_node && !self.node.grid_choose_container){
								self.node.grid_choose_container = grid_node
								document.body.appendChild(self.node.grid_choose_container)
							}

							// clean the last list
								while (datalist.firstChild) {
									datalist.removeChild(datalist.firstChild)
								}

							// clean the input value
								self.search_input.value = '';

							// hide service
								self.hide()

						}else{
							console.warn('Function sent is not defined to be exec by service autocomplete:', self.add_value);
						}
						return
					}
				}else{

					// default click action

					// add value. AWAITED, and its outcome READ: the pick is the
					// cataloguer's commit, and the widget's own visual grammar
					// (list cleared, input cleared, widget hidden) is the grammar
					// of success — it must not play before the answer is known.
						await commit_selection(self, value)

					// clean the last list
						while (datalist.firstChild) {
							datalist.removeChild(datalist.firstChild)
						}

					// clean the input value
						self.search_input.value = '';

					// hide service
						self.hide()
				}
		}//end selection_handler

	// iterate the section_records
		const ar_section_record_length = ar_section_record.length
		const row_promises = []
		for (let i = 0; i < ar_section_record_length; i++) {

			// section_record
				const current_section_record = ar_section_record[i]

			// locator
				const locator = current_section_record.locator

			// id_variant add to force unique components before render
				// current_section_record.id_variant = locator.section_tipo + '_' + locator.section_id

			// get data that mach with the current section from the global data sent by the API
			// get the full row with all items in the ddo that mach with the section_id
			// const current_row = data.filter((item)=> item.section_tipo===section_tipo && item.section_id===section_id )
				// const section_record_node = await current_section_record.render()

			// li_node container. NOT appended yet: a row is appended only after its
			// section_record renders (see below), so the open list never paints as a
			// tall band of empty rows while the records are still being built.
				const li_node = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'autocomplete_data_li',
					title			: ' [' + locator.section_tipo + '-' + locator.section_id + ']'
				})
				li_node.locator = locator
				// click event. When the user do click in one row send the data to the caller_instance for save it.
				const click_handler = function(e) {
					e.stopPropagation()
					selection_handler({
						e						: e,
						current_section_record	: current_section_record,
						locator					: this.locator,
						datalist				: datalist
					})
				}
				li_node.addEventListener('click', click_handler)
				// mouseenter event
				li_node.addEventListener('mouseenter', mouseenter_handler)
				// mouseleave event
				li_node.addEventListener('mouseleave', mouseleave_handler);

			// render the row, then hand it back for the ordered append. A row whose
			// render rejects is NAMED and skipped: one broken record must not blank
			// the whole list (and must not leave an empty row behind either).
				row_promises.push((async () => {
					try {
						const section_record_node = await current_section_record.render()
						li_node.appendChild(section_record_node)
						return li_node
					} catch (error) {
						console.error('(!) [service_autocomplete] refused: result row could not be rendered. Skipped:',
							locator.section_tipo + '_' + locator.section_id, error)
						return null
					}
				})())
		}//end for of current_section (section_tipo)

	// append in result order. render_datalist resolves only when every row is
	// COMPLETE, so callers can remove their loading UI without exposing blanks.
		const li_nodes = await Promise.all(row_promises)

		// a newer render superseded this one while the rows were rendering:
		// drop them (the newer render owns the list now).
		if (render_token !== self._render_token) {
			return datalist
		}
		datalist.append(...li_nodes.filter(Boolean))


	return datalist
}//end render_datalist



/**
* COMMIT_SELECTION
* THE default pick action of the datalist: links ONE locator into the caller
* through its `link_records` door and SURFACES every refusal.
*
* Until 2026-09-04 the selection handler fired `self.caller?.link_record(value)`
* with the comment "Don't wait here" and immediately cleared the list, cleared
* the input and hid the widget — the visual grammar of success — while the
* door's own contract says NOTHING IS DROPPED SILENTLY: every locator that does
* not land comes back in `refused` with a named reason. A pick of a record
* already linked (but outside the loaded page, so the client-side duplicate scan
* missed it) was refused by the server, logged to the console, and the screen
* said nothing. Refusals now reach the cataloguer as a notification toast (not a
* blocking alert: the datalist is a keyboard-driven surface and the refusal is
* informational — the stored data already equals the intent in the dominant
* duplicate case).
*
* Exported so the client suite can drive it against a fake caller.
*
* @param {Object} self    - The service_autocomplete instance (`self.caller` is
*                           a relation component: component_portal or a model
*                           inheriting its prototype).
* @param {Object} locator - The picked locator.
* @returns {Promise<Object>} the `link_records` outcome
*                            `{linked:[locator], refused:[{locator, reason}], total}`.
*/
export const commit_selection = async function(self, locator) {

	const caller = self.caller

	// a caller without the door is a wiring defect: name it, never drop the pick
		if (!caller || typeof caller.link_records!=='function') {
			const reason = 'caller_without_link_records'
			console.error('(!) [service_autocomplete.commit_selection] refused:', reason, 'caller:', caller);
			return {linked: [], refused: [{locator: locator, reason: reason}], total: null}
		}

	// link. ONE save through the caller's door; the outcome is the whole point
		const outcome = await caller.link_records([locator])

	// refused. Every locator that did not land, with its reason, to the cataloguer
		const refused = Array.isArray(outcome?.refused) ? outcome.refused : []
		if (refused.length>0) {
			const lines = refused.map(item => item.locator
				? `${item.reason} — ${item.locator.section_tipo}_${item.locator.section_id} ${item.locator.label || ''}`.trim()
				: String(item.reason)
			)
			event_manager.publish('notification', {
				msg			: (get_label.error || 'Error') + ': ' + lines.join('\n'),
				type		: 'warning',
				remove_time	: 10000,
				refused		: refused
			})
		}

	return outcome
}//end commit_selection



/**
* SHOW
* Remove the 'hide' CSS class from self.node to make the widget visible.
* No-op when the node is absent or does not carry the 'hide' class.
*
* @returns {boolean} Always true
*/
view_default_autocomplete.show = function () {

	if (this.node && this.node.classList.contains('hide')) {
		this.node.classList.remove('hide')
	}

	return true
}//end show



/**
* HIDE
* Add the 'hide' CSS class to self.node to make the widget invisible.
* No-op when the node is absent or already carries the 'hide' class.
*
* @returns {boolean} Always true
*/
view_default_autocomplete.hide = function () {

	if (this.node && !this.node.classList.contains('hide')) {
		this.node.classList.add('hide')
	}

	return true
}//end hide



/**
* GET_LAST_DDO_DATA_VALUE
* Recursive function that follows a column path through the API data tree to
* reach the terminal component carrying the display text.
*
* All intermediate ddo items in the chain are portals whose value is a locator
* array; only the final component in the chain holds the actual text data.
* The function peels one ddo from the tail of current_path on each recursive
* call, using the locator returned by the preceding level to locate the next
* data row in the flat data array.
*
* Base cases:
*  - current_element_data is not found → returns false (stops recursion)
*  - current_path_length === 1          → returns current_element_data (leaf reached)
*
* (!) Only value[0] (the first locator) is ever processed per call; multiple
*     locators in value are silently ignored in the current implementation.
*
* @param {Array}  current_path - Remaining ddo path array (mutated via pop on each level)
* @param {Array}  value        - Array of locator objects; only index 0 is used
* @param {Array}  data         - Flat data array from the API response
* @returns {Object|boolean} The matching data element at the leaf, or false if not found
*/
const get_last_ddo_data_value = function(current_path, value, data) {

	// check the path length sent, the first loop is the full path, but it is changed with the check data
	// note: only the first locator in value is processed (the loop returned on first iteration)
	const current_path_length = current_path.length
	const locator = value[0]
	const section_tipo 	= locator.section_tipo
	const section_id 	= locator.section_id
	// get the column data with last ddo
	const ddo_item = current_path[current_path.length - 1];
	// get the data into the full data from API and get the value (locator or final data as input_text data)
	const current_element_data = data.find((item)=> item.tipo===ddo_item.tipo && item.section_tipo===section_tipo && same_section_id(item.section_id, section_id))
	const current_value = (current_element_data)
		? current_element_data.value
		: false
	// if the element doesn't has data stop the recursion.
	if(current_value === false) return false;
	// create new_path without and remove the current ddo
	const new_path = [...current_path]
	new_path.pop()
	// if it is the last ddo, the data is the correct data to build the column
	// else continue with the path doing recursion
	if (current_path_length===1) {
		return current_element_data
	}

	return get_last_ddo_data_value(new_path, current_value, data)
}//end get_last_ddo_data_value



/**
* RENDER_GRID_CHOOSE
* Render result data as DOM grid nodes inside a floating, draggable panel
* appended to document.body. The panel position is preserved across repeated
* calls by reusing an existing `#choose_container` element.
*
* Designed for use as a custom 'add_value' event handler specified in
* self.properties.events. Currently wired by 'numisdata575'.
*
* Workflow:
*  1. Resolves the selected section_record's label from section_record.datum.
*  2. Calls get_grid_choose_data() to fetch secondary API data.
*  3. Reuses or creates `#choose_container` (.grid_choose_container.draggable).
*     When freshly created, positions it relative to self.datalist's bounding
*     rect + 20px offset.
*  4. Adds a draggable header with the selected label and a close button.
*     Drag is implemented via mousedown/mousemove/mouseup on document; boundary
*     clamping keeps the panel within its parent element. Listeners are stored
*     on `grid_choose_container._drag_listeners` for cleanup on close.
*  5. Iterates ar_locator entries; for each locator iterates rqo_search.show.columns
*     paths; calls get_last_ddo_data_value() per column to resolve data, then
*     get_instance() + build() + render() to produce component nodes appended
*     to the container.
*
* Early exits (returns null or partial container) when:
*  - get_grid_choose_data() returns null
*  - rqo_search.show.columns is absent or empty
*
* (!) Commented-out grid_item div blocks (lines ~1538-1545) represent an older
*     per-row wrapping approach — retained for historical reference.
* (!) The `data_locator` lookup (line ~1523) uses `==` (loose equality) between
*     source tipo strings — pre-existing code, do not change.
*
* @param {Object} self           - The service_autocomplete instance
* @param {Object} section_record - The section_record instance the user selected
* @param {Object} params         - Configuration for the secondary request
* @param {string} params.mode                - Component render mode (e.g. 'list')
* @param {string} params.request_config_type - Key to look up in self.request_config
* @param {string} params.view                - Component view (e.g. 'tag')
* @returns {Promise<HTMLElement|null>} The populated grid_choose_container div, or null on failure
*/
view_default_autocomplete.render_grid_choose = async function( self, section_record, params ) {

	// selection (from user selected section_record)
		const selected_section_id	= section_record.section_id
		const selected_section_tipo	= section_record.section_tipo
		const data_selection		= section_record.datum.data.find(
			el => el.section_id==selected_section_id && el.section_tipo==selected_section_tipo
		)
		const selected_label = data_selection
			? data_selection.value
			: selected_section_tipo + '_' + selected_section_id

	// data from API
		const grid_choose_data = await get_grid_choose_data(self, section_record, params)
		if (!grid_choose_data) {
			console.warn('[render_grid_choose] No data returned from get_grid_choose_data')
			return null
		}

	// get dd objects from the context that will be used to build the lists in correct order
		const rqo_search	= grid_choose_data.rqo_search
		const data			= grid_choose_data.data
		const context		= grid_choose_data.context

	// grid_choose_container
		const current_container		= document.getElementById('choose_container')
		const grid_choose_container	= current_container
			|| ui.create_dom_element({
				element_type	: 'div',
				id				: 'choose_container',
				class_name		: 'grid_choose_container draggable'
			})

		// clean the last list
			while (grid_choose_container.firstChild) {
				grid_choose_container.removeChild(grid_choose_container.firstChild)
			}

		// service node reference. Set bellow autocomplete search box when is created (once)
			if (!current_container && self.datalist) {
				const reference_node	= self.datalist
				const rect				= reference_node.getBoundingClientRect();
				const top				= rect.top  + window.scrollY + 20
				const left				= rect.left + window.scrollX + 20
				// set coordinates. Same as datalist position
				grid_choose_container.style.left	= left + 'px'
				grid_choose_container.style.top		= top + 'px'
			}

	// label. From section_record node
		const label = Array.isArray(selected_label)
			? selected_label.join(', ')
			: selected_label

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'grid_choose_header text_unselectable dragger',
			// the selected record's own value: TEXT, never parsed as markup
			text_content	: label,
			parent			: grid_choose_container
		});
		// drag move set
			let x = null, y = null, target = null, margin_left = null, margin_top = null

			// mousedown event. Header is the drag area
			const mousedown_handler = function(e) {
				e.stopPropagation()

				const path = e.composedPath();

				let clickedDragger = false;
				for(let i = 0; path[i] !== document; i++) {

					if (path[i].classList.contains('dragger')) {
						// dragger is clicked (header)
						clickedDragger = true;
					}
					else if (clickedDragger===true && path[i].classList.contains('draggable')) {
						// draggable is set (all modal-content)
						target = path[i];
						target.classList.add('dragging');
						x = e.clientX - target.style.left.slice(0, -2);
						y = e.clientY - target.style.top.slice(0, -2);

						// this is calculated once, every time that user clicks on header
						// to get the whole container margin and use it as position offset
						const compStyles	= window.getComputedStyle(target);
						margin_left			= parseInt(compStyles.getPropertyValue('margin-left'))
						margin_top			= parseInt(compStyles.getPropertyValue('margin-top'))

						return;
					}
				}
			}
			header.addEventListener('mousedown', mousedown_handler)

			// mouseup event
			const mouseup_handler = function(e) {
				e.stopPropagation()
				if (target) {
					target.classList.remove('dragging');
				}
				target = null;
			}
			// remove any drag listeners left over from a previous open of the reused
			// #choose_container, so repeated opens don't leak document listeners.
			if (grid_choose_container._drag_listeners) {
				const prev_listeners = grid_choose_container._drag_listeners
				if (prev_listeners.mouseup) document.removeEventListener('mouseup', prev_listeners.mouseup)
				if (prev_listeners.mousemove) document.removeEventListener('mousemove', prev_listeners.mousemove)
			}
			document.addEventListener('mouseup', mouseup_handler)

			// store handlers on container for cleanup
			grid_choose_container._drag_listeners = { mouseup: mouseup_handler, mousemove: null }

			// mousemove event
			const mousemove_handler = (e) => {
				// no target case (mouse position changes but target is null or undefined)
					if (!target) {
						return;
					}

				// re-position element based on mouse position
					target.style.left	= e.clientX - x + 'px';
					target.style.top	= e.clientY - y + 'px';

				// limit boundaries. take care of initial margin offset
					const pRect		= target.parentElement.getBoundingClientRect();
					const tgtRect	= target.getBoundingClientRect();
					if (tgtRect.left < pRect.left) {
						target.style.left = (0 - margin_left) + 'px';
					}
					if (tgtRect.top < pRect.top) {
						target.style.top = (0 - margin_top) + 'px';
					}
					if (tgtRect.right > (pRect.right)) {
						target.style.left = (pRect.width - tgtRect.width - margin_left) + 'px';
					}
					if (tgtRect.bottom > (pRect.bottom)) {
						target.style.top = (pRect.height - tgtRect.height - margin_top - 1) + 'px';
					}
			}
			document.addEventListener('mousemove', mousemove_handler)
			grid_choose_container._drag_listeners.mousemove = mousemove_handler

	// button_close
		const button_close = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button close white',
			parent			: header
		})
		const cleanup_drag_listeners = function() {
			const listeners = grid_choose_container._drag_listeners
			if (listeners) {
				if (listeners.mouseup) document.removeEventListener('mouseup', listeners.mouseup)
				if (listeners.mousemove) document.removeEventListener('mousemove', listeners.mousemove)
				grid_choose_container._drag_listeners = null
			}
		}
		const fn_click = function(e) {
			e.stopPropagation()
			while (grid_choose_container.firstChild) {
				grid_choose_container.removeChild(grid_choose_container.firstChild)
			}
			grid_choose_container.remove()
			if (self.node && self.node.grid_choose_container) {
				delete self.node.grid_choose_container
			}

			cleanup_drag_listeners()
		}//end fn_click
		button_close.addEventListener('click', fn_click)

	// ar_search_sections. get the sections that was searched
		// const ar_search_sections = rqo_search.sqo.section_tipo

	// columns
		const columns = rqo_search.show?.columns
		if (!columns || !columns.length) {
			console.warn('[render_grid_choose] No columns defined in rqo_search.show')
			return grid_choose_container
		}

	// get the ar_locator founded in sections
		const source_tipo = rqo_search.source?.tipo
		const data_locator = source_tipo
			? data.find((item)=> item.tipo===source_tipo && item.typo==='sections')
			: null;
		const ar_locator	= (data_locator) ? data_locator.entries : []

	// iterate the sections
		for (const current_locator of ar_locator) {

			// const section_tipo	= current_locator.section_tipo
			// const section_id	= current_locator.section_id

			// get data that mach with the current section from the global data sent by the API
			// get the full row with all items in the ddo that mach with the section_id
			// const current_row = data.filter((item)=> item.section_tipo===section_tipo && item.section_id===section_id )

			// grid_item
				// const grid_item = ui.create_dom_element({
				// 	element_type	: 'div',
				// 	class_name		: 'grid_item',
				// 	dataset			: {value : JSON.stringify(current_locator)},
				// 	parent			: grid_choose_container
				// })

			// values. build the text of the row with label nodes in correct order (the ddo order in context).
				const columns_length = columns.length
				for (let i = 0; i < columns_length; i++) {

					const current_path = columns[i]

					// the columns has the last element in the chain in the first position of the array,
					// the first position is the only component that is necessary to build and show
						const ddo_item				= current_path[0]
						const current_element_data	= get_last_ddo_data_value(current_path, [current_locator], data)
						// if the element doesn't has data continue to the next element.
						if (typeof current_element_data==='undefined' || current_element_data===false) {
							console.warn('[render_grid_choose] Ignored tipo not found in row:', ddo_item.tipo, ddo_item);
							continue
						}

					// context of the element
						const current_element_context = context.find( (item) =>
							item.tipo===ddo_item.tipo &&
							item.section_tipo===current_element_data.section_tipo
						)
						if (!current_element_context) {
							console.error('Ignored element: context not found. ddo_item:', ddo_item, 'context:', context);
							continue;
						}

					// mode and view
						current_element_context.mode = params.mode || 'list'
						current_element_context.view = params.view || 'default'

					// instance
						const instance_options = {
							context			: current_element_context,
							data			: current_element_data,
							datum			: {data : data, context: context},
							tipo			: current_element_context.tipo,
							section_tipo	: current_element_context.section_tipo,
							model			: current_element_context.model,
							section_id		: current_element_data.section_id,
							mode			: current_element_context.mode, // 'mini',
							lang			: current_element_context.lang,
							id_variant		: self.id
						}
						const current_instance = await get_instance(instance_options)
						await current_instance.build(false)
						const node = await current_instance.render()

					// append instance rendered node
						grid_choose_container.appendChild(node)
				}//end for ddo_item
		}//end for (const current_locator of ar_locator)


	return grid_choose_container
}//end render_grid_choose



/**
* GET_GRID_CHOOSE_DATA
* Fetch and prepare the secondary API data required by render_grid_choose.
*
* Steps:
*  1. Finds the matching request_config entry by params.request_config_type;
*     warns and returns undefined if not found.
*  2. Calls self.caller.build_rqo_search() to obtain a fresh rqo_search object.
*  3. Strips filter_free and filter_by_list from sqo_options (not relevant for
*     grid-choose queries).
*  4. Overrides sqo to pin the query to the selected section_record via
*     filter_by_locators and limits section_tipo to that record's type.
*  5. Raises the default limit to 200 to allow enough grid rows.
*  6. Sends the request via data_manager with use_worker:true.
*  7. Returns a grid_choose_data object with rqo_search, data[], and context[].
*
* Returns null (not undefined) for all failure branches after the initial
* request_config lookup, so callers can use a strict null check.
*
* (!) The commented-out rebuild_search_query_object call (lines ~1640-1643)
*     was an earlier approach to rqo construction — retained for reference.
*
* @param {Object} self           - The service_autocomplete instance
* @param {Object} section_record - The section_record instance selected by the user
* @param {Object} params         - Params forwarded from render_grid_choose
* @param {string} params.request_config_type - Key to select the right request_config entry
* @returns {Promise<Object|null>} grid_choose_data {rqo_search, data, context}, or null on failure
*/
const get_grid_choose_data = async function(self, section_record, params) {

	// request_config
		const request_config = self.request_config.find(el => el.type===params.request_config_type)
		if(!request_config){
			console.warn("Called request_config is not defined with type: ", params.request_config_type);
			return
		}

	// rqo
		const rqo_search = await self.caller?.build_rqo_search(request_config, 'search')
		if (!rqo_search) {
			console.warn('[get_grid_choose_data] Unable to build rqo_search')
			return null
		}

		// remove non used search params
		delete rqo_search.sqo_options.filter_free
		delete rqo_search.sqo_options.filter_by_list

		// const rqo = await self.rebuild_search_query_object({
		// 	rqo_search		: rqo_search
		// });

		rqo_search.sqo.filter_by_locators = [{
			section_id		: section_record.section_id,
			section_tipo	: section_record.section_tipo
		}]

		// limit. Increase default limit (25) to allow more results
		rqo_search.sqo.limit = 200

		// section_tipo. Search only in section tipo of selected instance
		rqo_search.sqo.section_tipo = [section_record.section_tipo]

	// API read request
		const api_response = await data_manager.request({
			body		: rqo_search,
			use_worker	: true
		})

	// guard api_response
		const grid_datum = response_data(api_response)
		if (!grid_datum) {
			console.warn('[get_grid_choose_data] API returned no data')
			return null
		}

	// grid_choose_data
		const grid_choose_data = {
			rqo_search	: rqo_search,
			data		: grid_datum.data || [],
			context		: grid_datum.context || []
		}


	return grid_choose_data
}//end get_grid_choose_data



// @license-end
