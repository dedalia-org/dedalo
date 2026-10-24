// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* MODULE render_semantic
* Semantic (RAG) search UI builders — 2026-07-22.
*
* ONE input, ONE state home (`search_instance.semantic`, search.js): the
* QUICK INPUT mounted in the section list toolbar
* (view_default_list_section.js get_buttons). The search panel mounts no
* duplicate block (removed 2026-07-23) — the shared instance state still
* composes (AND) with the structured filter tree on panel submit, and a
* preset load reflects its restored query back into the quick input
* (render_search.js).
*
* It is HIDDEN unless the searched section declares embed groups
* (dd_rag_api embed_groups — empty for: RAG off, section not opted in, caller
* not authorized; all byte-identical server-side by design). The group list is
* cached per section_tipo for the page life — a descriptor edit needs a reload
* (admin-rare; deliberate, no invalidation machinery).
*
* The PINNED CHIP is derived from the CALLER'S SQO, not from client memory:
* pins persist in the server session SQO across reloads/days while
* `self.semantic` dies with the page — without an sqo-derived chip the list
* would be invisibly filtered (or sentinel-EMPTY) with no cause and no exit
* (adversarial review #1). The chip's ✕ clears pins via the show_all path.
*/

// import
	import {data_manager} from '../../common/js/data_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {response_data} from '../../common/js/api_error.js'



// embed-groups cache: section_tipo → Promise<string[]> (page-life cache)
const embed_groups_cache = new Map()



/**
* GET_EMBED_GROUPS
* The section's embed-group ids from dd_rag_api (cached per section_tipo).
* Empty array ⇔ semantic search is unavailable for this section (hide the UI).
*
* ONLY AN ANSWER IS CACHED. A probe that did not answer (transport failure, an
* error envelope) is forgotten, so the next caller retries: caching it would
* conflate "this section has no embed groups" with "the probe hiccuped once"
* and disable semantic search for the whole page life with no way back.
*
* @param {string} section_tipo
* @returns {Promise<string[]>}
*/
export const get_embed_groups = function(section_tipo) {

	if (embed_groups_cache.has(section_tipo)) {
		return embed_groups_cache.get(section_tipo)
	}

	const forget = () => {
		embed_groups_cache.delete(section_tipo)
		return []
	}

	const js_promise = data_manager.request({
		use_worker	: false,
		body		: {
			dd_api			: 'dd_rag_api',
			action			: 'embed_groups',
			prevent_lock	: true,
			options			: { section_tipo : section_tipo }
		}
	})
	.then(function(api_response){
		// data_manager resolves an error envelope too (it never rejects on one)
		if (api_response?.ok!==true) {
			return forget()
		}
		const groups = response_data(api_response)?.groups
		return Array.isArray(groups) ? groups : []
	})
	.catch(function(){
		return forget()
	})

	embed_groups_cache.set(section_tipo, js_promise)

	return js_promise
}//end get_embed_groups



/**
* HAS_EMBED_GROUPS
* The capability question for a SEARCH SCOPE, which is a list of sections and
* not one: true when ANY target section is semantic-searchable. The scope sent
* to semantic_search is the whole array, so gating on the first element alone
* would suppress a search the server would have answered.
*
* An empty/absent target answers false — there is nothing to search.
*
* @param {string|string[]} target_section_tipo
* @returns {Promise<boolean>}
*/
export const has_embed_groups = async function(target_section_tipo) {

	const ar_tipo = Array.isArray(target_section_tipo)
		? target_section_tipo
		: (target_section_tipo ? [target_section_tipo] : [])

	if (ar_tipo.length===0) {
		return false
	}

	const ar_groups = await Promise.all(ar_tipo.map(get_embed_groups))

	return ar_groups.some(groups => Array.isArray(groups) && groups.length>0)
}//end has_embed_groups



/**
* BUILD_SEMANTIC_QUICK_INPUT
* The list-toolbar "search by meaning" input. Returns a hidden container that
* reveals itself only when the searched section has embed groups. Enter fires
* `search_instance.exec_semantic_search(q)`; while the resolve is in flight the
* input is disabled with a loading class (a second Enter is refused visibly).
*
* @param {Object} section_self - The section instance (list view); its
*   `self.filter` search instance exists before render (section.js build).
* @returns {HTMLElement}
*/
export const build_semantic_quick_input = function(section_self) {

	const container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'semantic_quick_search hide'
	})

	const input = ui.create_dom_element({
		element_type	: 'input',
		type			: 'search',
		class_name		: 'semantic_query',
		parent			: container
	})
	input.placeholder = get_label.search_by_meaning || 'Search by meaning'

	const fire = async () => {
		const filter_instance = section_self.filter
		if (!filter_instance || input.disabled) {
			return
		}
		input.disabled = true
		container.classList.add('loading')
		try {
			await filter_instance.exec_semantic_search(input.value)
		} finally {
			input.disabled = false
			container.classList.remove('loading')
		}
	}
	input.addEventListener('keydown', (e) => {
		if (e.key==='Enter') {
			e.preventDefault()
			fire()
		}
	})

	// reveal gate (async — accepted late reveal). Also seed the input from the
	// restored instance state so a temp-preset semantic query is visible.
	const target = section_self.filter?.target_section_tipo
	const section_tipo = Array.isArray(target) ? target[0] : (target || section_self.section_tipo)
	get_embed_groups(section_tipo)
	.then(function(groups){
		if (groups.length>0) {
			container.classList.remove('hide')
			const q = section_self.filter?.semantic?.q
			if (typeof q==='string' && q!=='') {
				input.value = q
			}
		}
	})

	return container
}//end build_semantic_quick_input



/**
* BUILD_PINNED_CHIP
* SQO-derived status chip for the list header: rendered whenever the caller's
* sqo carries filter_by_locators (any pin source — semantic, open-in-window…).
* States:
*  - sentinel pin (single id -1)      → 'no semantic matches'  + ✕
*  - N real pins from a meaning search → 'N results pinned by meaning search' + ✕
*  - N real pins from any other source → 'N records pinned'    + ✕
*    (e.g. back to list after creating a record: navigate_to_new_section
*    pins the new record and the session SQO carries it into the list)
*  - section_self.semantic_status==='unavailable' → 'semantic unavailable'
* The ✕ clears pins+order through the search instance's show_all (the one
* existing "reset navigation" path) and clears the semantic state with it.
*
* @param {Object} section_self - The section instance (list view).
* @returns {HTMLElement|null} The chip node, or null when nothing to show.
*/
export const build_pinned_chip = function(section_self) {

	const pins = section_self.rqo?.sqo?.filter_by_locators
	const unavailable = section_self.semantic_status==='unavailable'

	if (!unavailable && (!Array.isArray(pins) || pins.length===0)) {
		return null
	}

	const chip = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'semantic_pinned_chip'
	})

	const is_sentinel = Array.isArray(pins)
		&& pins.length===1
		&& Number(pins[0]?.section_id)===-1

	// attribute the pins to the meaning search only when it is known to own
	// them (live pin, or a restored semantic query). Anything else gets the
	// neutral wording — it is never wrong, the semantic one can be.
	const semantic		= section_self.filter?.semantic
	const is_semantic	= semantic?.pinned===true
		|| (typeof semantic?.q==='string' && semantic.q.trim()!=='')

	const label_text = unavailable
		? (get_label.semantic_unavailable || 'Semantic search unavailable')
		: is_sentinel
			? (get_label.semantic_no_results || 'No records match the meaning search')
			: is_semantic
				? `${pins.length} ${get_label.semantic_results_pinned || 'results pinned'}`
				: `${pins.length} ${get_label.records_pinned || 'records pinned'}`

	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'chip_label',
		text_content	: label_text,
		parent			: chip
	})

	if (!unavailable) {
		const clear_button = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button chip_clear',
			inner_html		: '✕',
			parent			: chip
		})
		clear_button.addEventListener('mousedown', (e) => {
			e.stopPropagation()
			// show_all clears filter+order+pins AND the semantic state (search.js)
			section_self.filter?.show_all(clear_button)
		})
	}

	return chip
}//end build_pinned_chip



/**
* APPLY_SEMANTIC_FROM_PRESET
* Named-preset load hook: restore the semantic state from a loaded preset's
* filter value (state only — the user's Apply re-runs the live query).
*
* @param {Object} search_self - The search instance.
* @param {Object|null} json_filter - The loaded preset filter value.
* @returns {boolean} True when semantic state was applied.
*/
export const apply_semantic_from_preset = function(search_self, json_filter) {

	const semantic = json_filter?.semantic
	if (!semantic || typeof semantic.q!=='string') {
		search_self.semantic.q		= ''
		search_self.semantic.group	= null
		return false
	}

	search_self.semantic.q		= semantic.q
	search_self.semantic.group	= typeof semantic.group==='string' ? semantic.group : null

	if(SHOW_DEBUG===true) {
		console.log('[apply_semantic_from_preset] restored semantic:', search_self.semantic);
	}

	return true
}//end apply_semantic_from_preset
