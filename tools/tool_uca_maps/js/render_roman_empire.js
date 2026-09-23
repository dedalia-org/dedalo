// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_ROMAN_EMPIRE
* DOM for the "Roma" panel (fila #14). Shell built once at attach: a source
* selector, the three sources' own form fields (only the active one visible)
* and a shared result list. Everything it triggers reaches `self.<method>(...)`,
* never `roman_empire.js` directly.
*
* The Pelagios dataset checkboxes are built from what `get_capabilities`
* reports as PRESENT, never from a client-side copy of the list — the server's
* `PELAGIOS_DATASETS` stays the only place the layer names are written down.
*
* @module render_roman_empire
*/



import {ui} from '../../../core/common/js/ui.js'
import {a11y} from '../../../core/common/js/a11y.js'



/**
* Wait after the last keystroke before searching. v6 fires a request on EVERY
* keyup in all three blocks (`special_tools_roman_empire.js:215/785/1286`),
* which for DARE is one call to Lund University per character typed. The
* suggestions stay; the storm does not.
*/
const LIVE_SEARCH_DELAY_MS = 300



/** DARE's own site vocabulary (`special_tools_roman_empire.js` imperium_type_object). */
const DARE_SITE_TYPES = [
	['', 'All types'], ['11', 'City'], ['13', 'Civitas'], ['12', 'Town'], ['14', 'Villa'],
	['16', 'Station'], ['56', 'Port'], ['57', 'Mine'], ['58', 'Production'], ['17', 'Fortress'],
	['18', 'Fort'], ['53', 'Fortlet/tower'], ['15', 'Camp'], ['41', 'River'], ['43', 'Rapid'],
	['46', 'Mountain'], ['47', 'Island'], ['50', 'Cape'], ['76', 'Lighthouse'], ['49', 'Pass'],
	['51', 'Bridge'], ['55', 'Road/milestone'], ['52', 'Aqueduct'], ['77', 'Canal'], ['20', 'Well']
]

/** DARE's country filter (v6's own list, ISO 3166-1 alpha-2 + its own labels). */
const DARE_COUNTRIES = [
	['', 'All countries'], ['AL', 'Albania'], ['DZ', 'Algeria'], ['AM', 'Armenia'], ['AT', 'Austria'],
	['AZ', 'Azerbaijan'], ['BH', 'Bahrain'], ['BE', 'Belgium'], ['BA', 'Bosnia and Herzegovina'],
	['BG', 'Bulgaria'], ['HR', 'Croatia'], ['CZ', 'Czech Republic'], ['DK', 'Denmark'],
	['DJ', 'Djibouti'], ['EG', 'Egypt'], ['ER', 'Eritrea'], ['ET', 'Ethiopia'], ['FR', 'France'],
	['GE', 'Georgia'], ['DE', 'Germany'], ['GB', 'Great Britain'], ['GR', 'Greece'], ['HU', 'Hungary'],
	['IR', 'Iran'], ['IQ', 'Iraq'], ['IE', 'Ireland'], ['IL', 'Israel'], ['IT', 'Italy'],
	['JO', 'Jordania'], ['XK', 'Kosovo'], ['KW', 'Kuwait'], ['LB', 'Lebanon'], ['LU', 'Luxembourg'],
	['LY', 'Libya'], ['MK', 'Macedonia'], ['MA', 'Morocco'], ['ME', 'Montenegro'], ['NL', 'Netherlands'],
	['OM', 'Oman'], ['PS', 'Palestine'], ['PL', 'Poland'], ['PT', 'Portugal'], ['QA', 'Qatar'],
	['RO', 'Romania'], ['SA', 'Saudi Arabia'], ['RS', 'Serbia'], ['SK', 'Slovakia'], ['SI', 'Slovenia'],
	['ES', 'Spain'], ['SO', 'Somalia'], ['SD', 'Sudan'], ['SE', 'Sweden'], ['CH', 'Switzerland'],
	['SY', 'Syria'], ['TN', 'Tunisia'], ['TR', 'Turkey'], ['AE', 'United Arab Emirates'], ['YE', 'Yemen']
]



/**
* RENDER_ROMAN_EMPIRE_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_roman_empire_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('roman_control_title') || 'Roman Empire',
		parent			: header
	})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-message', parent: panel})
	message.hidden = true

	render_source_selector(self, panel)
	render_query_row(self, panel)
	render_pleiades_form(self, panel)
	render_pelagios_form(self, panel)
	render_dare_form(self, panel)

	show_active_source_form(self, panel)

	return panel
}//end render_roman_empire_panel



/**
* SHOW_ROMAN_MESSAGE / CLEAR_ROMAN_MESSAGE
* Plain in-flow status line, same reasoning as every other panel here.
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
const show_roman_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-roman-message')
	message.textContent	= text
	message.hidden		= false
}//end show_roman_message

const clear_roman_message = function(panel) {
	panel.querySelector('.uca-maps-roman-message').hidden = true
}//end clear_roman_message



/**
* RENDER_SOURCE_SELECTOR
* The three gazetteers under their REAL names (audit correction #2). Changing
* the source drops the previous hits: they belong to the source that found
* them.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_source_selector = function(self, panel) {

	const select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-roman-source-select', parent: panel})

	const sources = [
		['pleiades', self.get_tool_label('roman_source_pleiades') || 'Pleiades'],
		['pelagios', self.get_tool_label('roman_source_pelagios') || 'Pelagios'],
		['dare', self.get_tool_label('roman_source_dare') || 'DARE (imperium.ahlfeldt.se)']
	]
	for (const [value, text] of sources) {
		const option = ui.create_dom_element({element_type: 'option', text_content: text, parent: select})
		option.value = value
	}
	select.value = self._roman_source

	select.addEventListener('change', () => {
		self.set_roman_source(select.value)
		clear_roman_message(panel)
		show_active_source_form(self, panel)
		populate_roman_results(self, panel)
	})

}//end render_source_selector



/**
* RENDER_QUERY_ROW
* The one search field every source shares. There is no Search button and no
* in-flow result list any more (Sergio, 2026-09-17): the hits arrive as a
* TYPEAHEAD anchored to the field — typing opens it, ↑/↓ walk it, Enter or a
* click draws the place on the map, Esc closes it. v6's own three blocks
* search on every keyup; this keeps that immediacy and adds the keyboard
* contract the rest of Dédalo already has (core `service_autocomplete`).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_query_row = function(self, panel) {

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-form', parent: panel})

	const query_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-roman-input', parent: form})
	query_input.type		= 'text'
	query_input.placeholder	= self.get_tool_label('roman_placeholder') || 'Place name'
	query_input.autocomplete	= 'off'

	/**
	* Runs the active source's search and opens the suggestion list with what
	* comes back. `live` is the as-you-type path: it stays quiet about an empty
	* box, which is a state you pass THROUGH while typing, not an error.
	*/
	const run_search = async (live) => {

		const result = await self.search_roman(collect_roman_params(self, panel, query_input.value))

		if (!result.ok) {
			// a torn-down tool — or a search overtaken by a later keystroke —
			// answers {ok:false} with no error text
			if (result.error && !live) {
				show_roman_message(panel, result.error)
			}
			return
		}

		clear_roman_message(panel)
		populate_roman_results(self, panel)
	}

	// Enter with the list closed (or nothing chosen yet) searches NOW, without
	// waiting out the debounce; with a row active it draws that row — see
	// the keydown handler below.
	query_input.addEventListener('keydown', (event) => {

		const rows = suggestion_rows(self)

		if (event.key==='ArrowDown' || event.key==='ArrowUp') {
			if (rows.length===0) {
				return
			}
			event.preventDefault()
			const step	= event.key==='ArrowDown' ? 1 : -1
			const next	= self._roman_active_index + step
			set_active_suggestion(self, Math.max(0, Math.min(rows.length - 1, next)))
			return
		}

		if (event.key==='Escape') {
			if (rows.length > 0) {
				event.preventDefault()
			}
			self.close_roman_suggestions()
			return
		}

		if (event.key==='Enter') {
			event.preventDefault()
			if (self._roman_active_index >= 0 && rows.length > 0) {
				choose_suggestion(self, panel, self._roman_active_index)
				return
			}
			if (self._roman_search_timer) {
				clearTimeout(self._roman_search_timer)
				self._roman_search_timer = null
			}
			run_search(false)
		}
	})

	// SUGGESTIONS AS YOU TYPE (v6 parity: it searches on every keyup in all
	// three blocks). Below the source's own minimum nothing travels — the
	// server would refuse it, and a refusal is not a suggestion.
	query_input.addEventListener('input', () => {

		if (self._roman_search_timer) {
			clearTimeout(self._roman_search_timer)
			self._roman_search_timer = null
		}

		const params	= collect_roman_params(self, panel, query_input.value)
		const minimum	= self.roman_min_query(self._roman_source, params.type)
		if (String(params.query || '').trim().length < minimum) {
			self.close_roman_suggestions()
			return
		}

		self._roman_search_timer = setTimeout(() => {
			self._roman_search_timer = null
			run_search(true)
		}, LIVE_SEARCH_DELAY_MS)
	})

	// clicking anywhere that is not the field or the list closes it — the
	// listener is on the MAP container, which is also what the list hangs
	// from, and it is removed with the map itself on teardown
	self._roman_outside_handler = (event) => {
		if (!self.roman_dropdown || self.roman_dropdown.hidden) {
			return
		}
		if (event.target!==query_input && !self.roman_dropdown.contains(event.target)) {
			self.close_roman_suggestions()
		}
	}
	self.geolocation.map.getContainer().addEventListener('mousedown', self._roman_outside_handler)

}//end render_query_row



/**
* SUGGESTION_ROWS
* @param {Object} self - tool_uca_maps instance
* @returns {Array<HTMLElement>}
*/
const suggestion_rows = function(self) {
	return self.roman_dropdown && !self.roman_dropdown.hidden
		? Array.from(self.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button'))
		: []
}//end suggestion_rows



/**
* SET_ACTIVE_SUGGESTION
* Moves the keyboard highlight. The active row is the DOM class, never a
* second copy of the state (same law as the panels' own visibility).
*
* @param {Object} self - tool_uca_maps instance
* @param {number} index
* @returns {void}
*/
const set_active_suggestion = function(self, index) {

	const rows = suggestion_rows(self)
	rows.forEach((row, position) => {
		row.classList.toggle('is-active', position===index)
	})
	self._roman_active_index = index

	const active = rows[index]
	if (active && typeof active.scrollIntoView==='function') {
		active.scrollIntoView({block: 'nearest'})
	}

}//end set_active_suggestion



/**
* CHOOSE_SUGGESTION
* Draws the chosen place on the map and closes the list (Sergio, 2026-09-17:
* choosing IS adding — one gesture, like v6). The typed text stays, so a
* second place from the same search is one more click away.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {number} index
* @returns {Promise<void>}
*/
const choose_suggestion = async function(self, panel, index) {

	self.close_roman_suggestions()

	const added = await self.add_roman_result(index)
	if (!added.ok && added.error) {
		show_roman_message(panel, added.error)
	}

}//end choose_suggestion



/**
* RENDER_PLEIADES_FORM
* v6's own two radio options, as a select: search the index by place name or
* by Pleiades id.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_pleiades_form = function(self, panel) {

	const box = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-source-form uca-maps-roman-pleiades-form', parent: panel})

	const select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-roman-pleiades-type', parent: box})
	const options = [
		['name', self.get_tool_label('roman_pleiades_by_name') || 'By place name'],
		['id', self.get_tool_label('roman_pleiades_by_id') || 'By Pleiades id']
	]
	for (const [value, text] of options) {
		const option = ui.create_dom_element({element_type: 'option', text_content: text, parent: select})
		option.value = value
	}

}//end render_pleiades_form



/**
* RENDER_PELAGIOS_FORM
* The dataset checkbox list — EMPTY until `refresh_roman_sources` fills it
* from what the install actually has (file header).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_pelagios_form = function(self, panel) {

	const box = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-source-form uca-maps-roman-pelagios-form', parent: panel})

	const button_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-dataset-buttons', parent: box})

	const all_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-roman-datasets-all',
		text_content	: self.get_tool_label('roman_datasets_all') || 'All layers',
		parent			: button_row
	})
	all_btn.type = 'button'
	all_btn.addEventListener('click', () => set_all_datasets(panel, true))

	const none_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-roman-datasets-none',
		text_content	: self.get_tool_label('roman_datasets_none') || 'No layers',
		parent			: button_row
	})
	none_btn.type = 'button'
	none_btn.addEventListener('click', () => set_all_datasets(panel, false))

	ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-datasets', parent: box})

}//end render_pelagios_form



/**
* SET_ALL_DATASETS
* @param {HTMLElement} panel
* @param {boolean} checked
* @returns {void}
*/
const set_all_datasets = function(panel, checked) {
	const boxes = panel.querySelectorAll('.uca-maps-roman-dataset-checkbox')
	for (const box of boxes) {
		box.checked = checked
	}
}//end set_all_datasets



/**
* RENDER_DARE_FORM
* v6's own three filters: which name is searched (modern/ancient), the site
* type and the country. The two vocabularies are DARE's own — kept in its
* language, like any other third-party service's data.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const render_dare_form = function(self, panel) {

	const box = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-source-form uca-maps-roman-dare-form', parent: panel})

	const name_select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-roman-dare-name-type', parent: box})
	const name_options = [
		['mss', self.get_tool_label('roman_dare_modern_name') || 'Modern place name'],
		['ass', self.get_tool_label('roman_dare_ancient_name') || 'Ancient place name']
	]
	for (const [value, text] of name_options) {
		const option = ui.create_dom_element({element_type: 'option', text_content: text, parent: name_select})
		option.value = value
	}

	const type_select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-roman-dare-type', parent: box})
	for (const [value, text] of DARE_SITE_TYPES) {
		const option = ui.create_dom_element({element_type: 'option', text_content: text, parent: type_select})
		option.value = value
	}

	const country_select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-roman-dare-country', parent: box})
	for (const [value, text] of DARE_COUNTRIES) {
		const option = ui.create_dom_element({element_type: 'option', text_content: text, parent: country_select})
		option.value = value
	}

}//end render_dare_form



/**
* SHOW_ACTIVE_SOURCE_FORM
* Only the active source's own fields are in the panel — the other two are
* `hidden`, never a collapsible section of their own (toolbar law, hito 3c).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const show_active_source_form = function(self, panel) {

	const forms = {
		pleiades	: panel.querySelector('.uca-maps-roman-pleiades-form'),
		pelagios	: panel.querySelector('.uca-maps-roman-pelagios-form'),
		dare		: panel.querySelector('.uca-maps-roman-dare-form')
	}
	for (const source of Object.keys(forms)) {
		forms[source].hidden = source!==self._roman_source
	}

}//end show_active_source_form



/**
* REFRESH_ROMAN_SOURCES
* Applies the gazetteer capability: a local source this install cannot serve
* is DISABLED in the selector with a reason, instead of offering a search that
* always answers "unavailable". DARE needs no local data, so it is never
* disabled — and it is what the selector falls back to when the active source
* turns out to be unavailable.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const refresh_roman_sources = function(self, panel) {

	const capability	= self._roman_gazetteers
	const datasets		= (capability && Array.isArray(capability.pelagios)) ? capability.pelagios : []
	const available		= {
		pleiades	: Boolean(capability && capability.pleiades),
		pelagios	: datasets.length > 0,
		dare		: true
	}

	const select = panel.querySelector('.uca-maps-roman-source-select')
	for (const option of select.options) {
		option.disabled = !available[option.value]
	}

	render_dataset_checkboxes(self, panel, datasets)

	if (!available[self._roman_source]) {
		self.set_roman_source('dare')
		select.value = 'dare'
		show_active_source_form(self, panel)
		populate_roman_results(self, panel)
		show_roman_message(
			panel,
			self.get_tool_label('roman_local_data_missing') || 'This install has no local gazetteer data; only DARE is available.'
		)
	}

}//end refresh_roman_sources



/**
* RENDER_DATASET_CHECKBOXES
* One checkbox per dataset the install actually ships, all checked (v6's own
* default: every layer selected).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {Array<string>} datasets
* @returns {void}
*/
const render_dataset_checkboxes = function(self, panel, datasets) {

	const container = panel.querySelector('.uca-maps-roman-datasets')
	container.replaceChildren()

	for (const dataset of datasets) {

		const row = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-roman-dataset-row', parent: container})

		const checkbox = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-roman-dataset-checkbox', parent: row})
		checkbox.type		= 'checkbox'
		checkbox.checked	= true
		checkbox.value		= dataset

		ui.create_dom_element({element_type: 'span', text_content: dataset, parent: row})
	}

}//end render_dataset_checkboxes



/**
* COLLECT_ROMAN_PARAMS
* Reads the active source's own fields out of the panel — the ONE place the
* DOM is turned into a search request.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {string} query
* @returns {Object}
*/
const collect_roman_params = function(self, panel, query) {

	const params = {query: query}

	if (self._roman_source==='pleiades') {
		params.type = panel.querySelector('.uca-maps-roman-pleiades-type').value
	}

	if (self._roman_source==='pelagios') {
		params.datasets = Array.from(panel.querySelectorAll('.uca-maps-roman-dataset-checkbox'))
			.filter((box) => box.checked)
			.map((box) => box.value)
	}

	if (self._roman_source==='dare') {
		params.name_type	= panel.querySelector('.uca-maps-roman-dare-name-type').value
		params.type_id		= panel.querySelector('.uca-maps-roman-dare-type').value
		params.country		= panel.querySelector('.uca-maps-roman-dare-country').value
	}

	return params
}//end collect_roman_params



/**
* POPULATE_ROMAN_RESULTS
* Fills the floating suggestion list from `self._roman_results` and opens it
* under the field. Empty results open it too, with one non-clickable line —
* in a typeahead "nothing matches" belongs where the matches would be, not in
* the panel's error line (which stays for real failures: a source down, an
* install with no local data).
*
* The list hangs from the MAP container, not from the panel: see
* `roman_empire.js` attach for why (the shared panel CSS would clip it).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_roman_results = function(self, panel) {

	const list = self.roman_dropdown
	if (!list) {
		return
	}
	list.replaceChildren()
	self._roman_active_index = -1

	const results = self._roman_results
	if (!results) {
		list.hidden = true
		return
	}

	if (results.length===0) {
		const empty = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'uca-maps-roman-empty',
			text_content	: self.get_tool_label('roman_no_results') || 'No places found.',
			parent			: list
		})
		empty.setAttribute('aria-disabled', 'true')
	}

	results.forEach((result, index) => {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-roman-result-item', parent: list})

		const detail = [result.dataset, result.geometry_type, result.id].filter(Boolean).join(' · ')

		const add_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-roman-result-button',
			title			: result.name,
			parent			: item
		})
		add_btn.type = 'button'
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-roman-result-name',
			text_content	: result.name,
			parent			: add_btn
		})
		if (detail) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'uca-maps-roman-result-detail',
				text_content	: detail,
				parent			: add_btn
			})
		}

		// mousedown, not click: the field keeps the focus (and the caret)
		// through the whole gesture, so choosing never closes the list by
		// blurring it first. Through a11y because a pointer event that is not
		// `click` is never dispatched by a keyboard, so the row was reachable
		// by Tab and dead on Enter — the helper wires both to ONE callback
		// (client_keyboard_activation_tripwire).
		a11y.make_activable(add_btn, {
			pointer_event	: 'mousedown',
			on_activate		: (event) => {
				event.preventDefault()
				choose_suggestion(self, panel, index)
			}
		})
		add_btn.addEventListener('mouseenter', () => set_active_suggestion(self, index))
	})

	anchor_suggestions_to_input(self, panel)
	list.hidden = false

}//end populate_roman_results



/**
* ANCHOR_SUGGESTIONS_TO_INPUT
* Positions the list right under the field, in the map container's own
* coordinates — measured live, same approach (and the same accepted "not
* recalculated on resize" gap) as toolbar.js's anchor_panel_to_button.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const anchor_suggestions_to_input = function(self, panel) {

	const input		= panel.querySelector('.uca-maps-roman-input')
	const container	= self.roman_dropdown && self.roman_dropdown.parentNode
	if (!input || !container) {
		return
	}

	const input_rect		= input.getBoundingClientRect()
	const container_rect	= container.getBoundingClientRect()

	self.roman_dropdown.style.top	= Math.round(input_rect.bottom - container_rect.top + 2) + 'px'
	self.roman_dropdown.style.left	= Math.round(input_rect.left - container_rect.left) + 'px'
	self.roman_dropdown.style.width	= Math.round(input_rect.width) + 'px'

}//end anchor_suggestions_to_input



// @license-end
