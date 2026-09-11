// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_PLACE_SEARCH
* DOM for the "Search" panel (functionality #1). Shell (header + search form
* + result list container) built once at attach — the query input must
* survive a reopen mid-typing; the list rebuilds from `self._place_results`
* on every search/clear (same split as `render_wms_services.js`). Everything
* it triggers reaches `self.<method>(...)`, never `place_search.js` directly.
*
* @module render_place_search
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_PLACE_SEARCH_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_place_search_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('place_search_control_title') || 'Place search',
		parent			: header
	})

	render_search_form(self, panel)

	ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-place-search-results', parent: panel})

	return panel
}//end render_place_search_panel



/**
* SHOW_PLACE_SEARCH_MESSAGE
* Plain in-flow status line — NOT `ui.show_message`'s page-level toast,
* clipped by this panel's own `overflow-y: auto` (same reasoning as
* `render_wms_services.js` show_wms_message).
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
const show_place_search_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-place-search-message')
	message.textContent	= text
	message.hidden		= false
}//end show_place_search_message



/**
* RENDER_SEARCH_FORM
* Query input + "Search"/"Clear" buttons. Enter in the field searches too —
* v6's geocoder box does, and a search panel where Enter does nothing reads
* as broken.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_search_form = function(self, panel) {

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-place-search-form', parent: panel})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-place-search-message', parent: form})
	message.hidden = true

	const query_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-place-search-input',
		parent			: form
	})
	query_input.type		= 'text'
	query_input.placeholder	= self.get_tool_label('place_search_placeholder') || 'Place name'

	const button_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-place-search-button-row', parent: form})

	const search_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-place-search-button',
		text_content	: self.get_tool_label('place_search_button') || 'Search',
		parent			: button_row
	})
	search_btn.type = 'button'

	const run_search = async () => {

		search_btn.disabled = true
		const result = await self.search_places(query_input.value)
		search_btn.disabled = false

		if (!result.ok) {
			// a torn-down tool answers {ok:false} with no error text — there is
			// no panel left to write into, and no failure to report either
			if (result.error) {
				show_place_search_message(panel, result.error)
				panel.querySelector('.uca-maps-place-search-results').replaceChildren()
			}
			return
		}

		message.hidden = true
		if (result.results.length===0) {
			show_place_search_message(panel, self.get_tool_label('place_search_no_results') || 'No places found.')
		}
		populate_place_search_results(self, panel)
	}

	search_btn.addEventListener('click', run_search)
	query_input.addEventListener('keydown', (event) => {
		if (event.key==='Enter') {
			event.preventDefault()
			run_search()
		}
	})

	const clear_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-place-search-clear-button',
		text_content	: self.get_tool_label('place_search_clear_button') || 'Clear search',
		parent			: button_row
	})
	clear_btn.type = 'button'
	clear_btn.addEventListener('click', () => {
		self.clear_place_search()
		message.hidden		= true
		query_input.value	= ''
		populate_place_search_results(self, panel)
	})

}//end render_search_form



/**
* POPULATE_PLACE_SEARCH_RESULTS
* Rebuilds the result `<ul>` from `self._place_results` — called after every
* search/clear, same "no incremental diff" reasoning as
* `render_wms_services.js` populate_wms_search_results.
*
* Each row is a button, not a bare `<li>` with a click listener: the list is
* keyboard-reachable that way, and a search box that only answers the mouse
* is a worse control than the one v6 had.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_place_search_results = function(self, panel) {

	const list = panel.querySelector('.uca-maps-place-search-results')
	list.replaceChildren()

	const results = self._place_results
	if (!results) {
		return
	}

	results.forEach((result, index) => {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-place-search-result-item', parent: list})

		const focus_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-place-search-result-button',
			text_content	: result.name,
			title			: result.name,
			parent			: item
		})
		focus_btn.type = 'button'
		focus_btn.addEventListener('click', () => self.focus_place_result(index))

	})

}//end populate_place_search_results



// @license-end
