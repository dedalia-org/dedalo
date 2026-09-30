// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_ROMAN_EMPIRE
* DOM for the "Roma" panel (fila #14). Shell built once at attach: the three
* sources stacked, as in v6's modal, each with its own field, filters and
* status line, and ONE floating result list anchored to whichever field
* searched. Everything it triggers reaches `self.<method>(...)`, never
* `roman_empire.js` directly.
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
* The centred shell (toolbar.js) already carries the title and the ×.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_roman_empire_panel = function(self, panel) {

	const titles = {
		pleiades	: self.get_tool_label('roman_source_pleiades') || 'Pleiades',
		pelagios	: self.get_tool_label('roman_source_pelagios') || 'Pelagios',
		dare		: self.get_tool_label('roman_source_dare') || 'DARE (imperium.ahlfeldt.se)'
	}
	const render_filters = {
		pleiades	: render_pleiades_filters,
		pelagios	: render_pelagios_filters,
		dare		: render_dare_filters
	}

	for (const source of ROMAN_SOURCE_ORDER) {

		const block = ui.create_dom_element({
			element_type	: 'section',
			class_name		: 'uca-maps-roman-source uca-maps-roman-' + source,
			parent			: panel
		})
		block.dataset.source = source

		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-panel-subtitle',
			text_content	: titles[source],
			parent			: block
		})

		const unavailable = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-roman-unavailable',
			text_content	: self.get_tool_label('roman_source_unavailable') || 'Not available: this install has no local data for this gazetteer.',
			parent			: block
		})
		unavailable.hidden = true

		render_query_input(self, panel, block)
		render_filters[source](self, block)

		const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-message', parent: block})
		message.hidden = true
	}

	// the list follows its field when the panel scrolls, and closes only once
	// the field leaves the panel's view. Never close on any scroll: hiding a
	// message at the bottom makes the browser clamp scrollTop and fire one
	panel.addEventListener('scroll', () => {
		if (self.roman_dropdown && !self.roman_dropdown.hidden) {
			place_roman_list(self, panel)
		}
	})

	// pointer and keyboard ways of going elsewhere, one rule. CAPTURE on the
	// map container: the panel stops mousedown bubbling
	// (disableClickPropagation). Detach removes it; focusin dies with the panel.
	self._roman_outside_handler = (event) => leave_roman_list_if_elsewhere(self, panel, event.target)
	self.geolocation.map.getContainer().addEventListener('mousedown', self._roman_outside_handler, true)
	panel.addEventListener('focusin', (event) => leave_roman_list_if_elsewhere(self, panel, event.target))

	wire_list_keyboard(self, panel)

	return panel
}//end render_roman_empire_panel



/**
* WHOSE IS THE LIST
* ONE list serves three fields, and `self._roman_source` says whose it is from
* the moment a field ARMS a search — waiting out the debounce, in flight or
* showing hits. Three doors decide everything about it; no handler reasons on
* its own about "open" vs "pending" (every earlier bug lived in that gap).
*/

/**
* CLAIM_ROMAN_LIST
* A field arms a search: another field's list, and its search, go.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} source
* @returns {void}
*/
const claim_roman_list = function(self, source) {
	if (self._roman_source!==source) {
		self.close_roman_suggestions()
		self._roman_source = source
	}
}//end claim_roman_list

/**
* LEAVE_ROMAN_LIST_IF_ELSEWHERE
* A press or a focus anywhere but the owning field or the list closes the list
* and voids its search. The panel's own box is not "elsewhere": Chrome targets
* the element when its scrollbar is pressed, and every control is a descendant.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {EventTarget} target
* @returns {void}
*/
const leave_roman_list_if_elsewhere = function(self, panel, target) {
	if (!self._roman_source || target===panel) {
		return
	}
	if (target===source_input(panel, self._roman_source)) {
		return
	}
	if (self.roman_dropdown && self.roman_dropdown.contains(target)) {
		return
	}
	self.close_roman_suggestions()
}//end leave_roman_list_if_elsewhere

/**
* PLACE_ROMAN_LIST
* Anchors the list under its field, or closes it when that field is not fully
* inside the panel's view (below the sticky header) — on a scroll AND when hits
* arrive, so a late answer never opens under a field scrolled away.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {boolean} whether the list may show
*/
const place_roman_list = function(self, panel) {

	const input = source_input(panel, self._roman_source)
	if (!input || panel.hidden) {
		self.close_roman_suggestions()
		return false
	}

	const panel_rect	= panel.getBoundingClientRect()
	const header		= panel.querySelector(':scope > .uca-maps-panel-header')
	const view_top		= panel_rect.top + panel.clientTop + (header ? header.offsetHeight : 0)
	const view_bottom	= panel_rect.top + panel.clientTop + panel.clientHeight
	const input_rect	= input.getBoundingClientRect()

	if (input_rect.top < view_top || input_rect.bottom > view_bottom) {
		self.close_roman_suggestions()
		return false
	}
	anchor_suggestions_to_input(self, panel)
	return true

}//end place_roman_list



/** v6's own order (`special_tools_roman_empire.js:73-75`). */
const ROMAN_SOURCE_ORDER = ['pleiades', 'pelagios', 'dare']

/** Radio groups need a name unique per page: two maps may be open at once. */
let pleiades_radio_seq = 0



/**
* SOURCE_BLOCK / SOURCE_INPUT
* @param {HTMLElement} panel
* @param {string|null} source
* @returns {HTMLElement|null}
*/
const source_block = function(panel, source) {
	return source ? panel.querySelector('.uca-maps-roman-' + source) : null
}//end source_block

const source_input = function(panel, source) {
	const block = source_block(panel, source)
	return block ? block.querySelector('.uca-maps-roman-input') : null
}//end source_input



/**
* SHOW_ROMAN_MESSAGE / CLEAR_ROMAN_MESSAGE
* Plain in-flow status line, one per source: an error belongs under the field
* that caused it.
*
* @param {HTMLElement} block - a source's own section
* @param {string} text
* @returns {void}
*/
const show_roman_message = function(block, text) {
	const message = block.querySelector('.uca-maps-roman-message')
	message.textContent	= text
	message.hidden		= false
}//end show_roman_message

const clear_roman_message = function(block) {
	block.querySelector('.uca-maps-roman-message').hidden = true
}//end clear_roman_message



/**
* RENDER_QUERY_INPUT
* A source's own search field. There is no Search button and no in-flow result
* list (Sergio, 2026-09-17): the hits arrive as a TYPEAHEAD anchored to the
* field — typing opens it, ↑/↓ walk it, Enter or a click draws the place on
* the map, Esc closes it. v6's three blocks search on every keyup; this keeps
* that immediacy with the keyboard contract of core `service_autocomplete`.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {HTMLElement} block - the source's own section
* @returns {void}
*/
const render_query_input = function(self, panel, block) {

	const source = block.dataset.source

	const query_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-roman-input', parent: block})
	query_input.type			= 'text'
	query_input.placeholder		= self.get_tool_label('roman_placeholder') || 'Place name'
	query_input.autocomplete	= 'off'

	/**
	* Runs this source's search and opens the suggestion list with what comes
	* back. `live` is the as-you-type path: it stays quiet about an empty box,
	* which is a state you pass THROUGH while typing, not an error.
	*/
	const run_search = async (live) => {

		const result = await self.search_roman(source, collect_roman_params(block, query_input.value))

		if (!result.ok) {
			// a torn-down tool — or a search overtaken by a later keystroke —
			// answers {ok:false} with no error text
			if (result.error && !live) {
				show_roman_message(block, result.error)
			}
			return
		}

		clear_roman_message(block)
		populate_roman_results(self, panel)
	}

	// Enter with the list closed (or nothing chosen yet) searches NOW, without
	// waiting out the debounce; with a row active it draws that row.
	query_input.addEventListener('keydown', (event) => {

		const rows = suggestion_rows(self, source)

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

		// Sergio, 2026-09-30: an open list sits "right after" its field, so Tab
		// walks into it instead of leaving for the panel's next control
		if (event.key==='Tab' && !event.shiftKey && rows.length > 0) {
			event.preventDefault()
			rows[Math.max(0, self._roman_active_index)].focus()
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
			claim_roman_list(self, source)
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

		const params	= collect_roman_params(block, query_input.value)
		const minimum	= self.roman_min_query(source, params.type)
		if (String(params.query || '').trim().length < minimum) {
			self.close_roman_suggestions()
			return
		}

		claim_roman_list(self, source)
		self._roman_search_timer = setTimeout(() => {
			self._roman_search_timer = null
			run_search(true)
		}, LIVE_SEARCH_DELAY_MS)
	})

}//end render_query_input



/**
* SUGGESTION_ROWS
* The open list's rows, but only for the field it belongs to: ↑/↓ in one
* source's field never walk another source's hits.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} source - the field's source
* @returns {Array<HTMLElement>}
*/
const suggestion_rows = function(self, source) {
	return self.roman_dropdown && !self.roman_dropdown.hidden && self._roman_source===source
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

	const rows = suggestion_rows(self, self._roman_source)
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
* WIRE_LIST_KEYBOARD
* Keyboard inside the list, once its rows have the focus: Tab / Shift+Tab and
* ↓ / ↑ walk the rows (the focused row IS the highlight); before the first row
* is the field, past the last one Tab leaves the list as an inline list would
* be left — to the control after the field. Esc closes it back to the field.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const wire_list_keyboard = function(self, panel) {

	const list = self.roman_dropdown

	// entering the rows freezes them: a search still waiting or in flight would
	// rebuild the list under the focused row and drop the focus to <body>
	list.addEventListener('focusin', (event) => {
		const at = suggestion_rows(self, self._roman_source).indexOf(event.target)
		if (at < 0) {
			return
		}
		self.hold_roman_suggestions()
		if (at!==self._roman_active_index) {
			set_active_suggestion(self, at)
		}
	})

	list.addEventListener('keydown', (event) => {

		const rows	= suggestion_rows(self, self._roman_source)
		const at	= rows.indexOf(event.target)
		const input	= source_input(panel, self._roman_source)
		if (at < 0 || !input) {
			return
		}

		if (event.key==='Escape') {
			event.preventDefault()
			self.close_roman_suggestions()
			input.focus()
			return
		}

		const walks = event.key==='Tab' || event.key==='ArrowDown' || event.key==='ArrowUp'
		if (!walks) {
			return // Enter / Space: a11y.make_activable chooses the row
		}
		event.preventDefault()

		const back	= event.key==='ArrowUp' || (event.key==='Tab' && event.shiftKey)
		const next	= at + (back ? -1 : 1)
		if (next < 0) {
			input.focus()
		} else if (next < rows.length) {
			rows[next].focus()
		} else if (event.key==='Tab') {
			self.close_roman_suggestions()
			const after = control_after(panel, input)
			if (after) {
				after.focus()
			}
		}
	})

}//end wire_list_keyboard



/**
* CONTROL_AFTER
* The first enabled, focusable control after `node` in the panel's DOM order.
* A radio group is entered at its CHECKED radio, as native Tab does: its first
* radio, unchecked, would take a Space and switch the search type silently.
*
* @param {HTMLElement} panel
* @param {HTMLElement} node
* @returns {HTMLElement|null}
*/
const control_after = function(panel, node) {
	const controls = panel.querySelectorAll('input, select, button, textarea, a[href], [tabindex]:not([tabindex="-1"])')
	for (const control of controls) {
		if (control.disabled || !(node.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)) {
			continue
		}
		if (control.type==='radio' && !control.checked && control.name) {
			const checked = panel.querySelector('input[type="radio"][name="' + CSS.escape(control.name) + '"]:checked')
			if (checked) {
				return checked
			}
		}
		return control
	}
	return null
}//end control_after



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

	// read before the await: a later search may hand the list to another source,
	// and a reopening wipes the panel — an error from before it is not news
	const block		= source_block(panel, self._roman_source)
	const opening	= self._roman_panel_opening
	const input		= source_input(panel, self._roman_source)
	const from_list	= Boolean(self.roman_dropdown && self.roman_dropdown.contains(document.activeElement))

	self.close_roman_suggestions()
	if (from_list && input) {
		input.focus() // the focused row is now hidden: the focus would fall to <body>
	}

	const added = await self.add_roman_result(index)
	if (!added.ok && added.error && block && opening===self._roman_panel_opening) {
		show_roman_message(block, added.error)
	}

}//end choose_suggestion



/**
* RENDER_PLEIADES_FILTERS
* v6's own two radio options (`special_tools_roman_empire.js:155/174`): search
* the index by place name or by Pleiades id.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} block - the source's own section
* @returns {void}
*/
const render_pleiades_filters = function(self, block) {

	const group = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-pleiades-type', parent: block})
	group.setAttribute('role', 'radiogroup')

	const name		= 'uca-maps-roman-pleiades-type-' + (++pleiades_radio_seq)
	const options	= [
		['name', self.get_tool_label('roman_pleiades_by_name') || 'By place name'],
		['id', self.get_tool_label('roman_pleiades_by_id') || 'By Pleiades id']
	]
	for (const [value, text] of options) {
		const label = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-roman-radio', parent: group})
		const radio = ui.create_dom_element({element_type: 'input', parent: label})
		radio.type		= 'radio'
		radio.name		= name
		radio.value		= value
		radio.checked	= value==='name'
		ui.create_dom_element({element_type: 'span', text_content: text, parent: label})
	}

}//end render_pleiades_filters



/**
* RENDER_PELAGIOS_FILTERS
* The dataset checkbox list — EMPTY until `refresh_roman_sources` fills it
* from what the install actually has (file header).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} block - the source's own section
* @returns {void}
*/
const render_pelagios_filters = function(self, block) {

	const button_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-dataset-buttons', parent: block})

	const all_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-roman-datasets-all',
		text_content	: self.get_tool_label('roman_datasets_all') || 'All layers',
		parent			: button_row
	})
	all_btn.type = 'button'
	all_btn.addEventListener('click', () => set_all_datasets(block, true))

	const none_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-roman-datasets-none',
		text_content	: self.get_tool_label('roman_datasets_none') || 'No layers',
		parent			: button_row
	})
	none_btn.type = 'button'
	none_btn.addEventListener('click', () => set_all_datasets(block, false))

	ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-datasets', parent: block})

}//end render_pelagios_filters



/**
* SET_ALL_DATASETS
* @param {HTMLElement} block - the Pelagios section
* @param {boolean} checked
* @returns {void}
*/
const set_all_datasets = function(block, checked) {
	const boxes = block.querySelectorAll('.uca-maps-roman-dataset-checkbox')
	for (const box of boxes) {
		box.checked = checked
	}
}//end set_all_datasets



/**
* RENDER_DARE_FILTERS
* v6's own three filters: which name is searched (modern/ancient), the site
* type and the country. The two vocabularies are DARE's own — kept in its
* language, like any other third-party service's data.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} block - the source's own section
* @returns {void}
*/
const render_dare_filters = function(self, block) {

	const box = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-roman-dare-filters', parent: block})

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

}//end render_dare_filters



/**
* REFRESH_ROMAN_SOURCES
* Applies the gazetteer capability: a local source this install cannot serve
* keeps its section, disabled and saying why, instead of offering a search
* that always answers "unavailable". DARE needs no local data, so it is never
* disabled.
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

	const pelagios_block = source_block(panel, 'pelagios')
	if (pelagios_block) {
		render_dataset_checkboxes(self, pelagios_block, datasets)
	}

	for (const source of ROMAN_SOURCE_ORDER) {
		const block = source_block(panel, source)
		if (!block) {
			continue
		}
		block.classList.toggle('is-unavailable', !available[source])
		block.querySelector('.uca-maps-roman-unavailable').hidden = available[source]
		for (const control of block.querySelectorAll('input, select, button')) {
			control.disabled = !available[source]
		}
	}

	// a list of hits from a source that just turned out unavailable goes too
	if (self._roman_source && !available[self._roman_source]) {
		self.clear_roman_search()
		self.close_roman_suggestions()
	}

}//end refresh_roman_sources



/**
* RESET_ROMAN_PANEL
* Every open starts clean, as in v6, whose `load_modal` rebuilds the whole
* modal on each click (`special_tools_roman_empire.js:61-77`): empty fields,
* no messages, no list, filters back to their defaults. What the capability
* disabled stays disabled — that is the install, not the user's input.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const reset_roman_panel = function(self, panel) {

	self._roman_panel_opening = (self._roman_panel_opening || 0) + 1
	self.clear_roman_search()
	self.close_roman_suggestions() // also cancels a keystroke still waiting

	for (const block of panel.querySelectorAll('.uca-maps-roman-source')) {
		block.querySelector('.uca-maps-roman-input').value = ''
		clear_roman_message(block)
	}
	for (const radio of panel.querySelectorAll('.uca-maps-roman-pleiades-type input')) {
		radio.checked = radio.value==='name'
	}
	for (const select of panel.querySelectorAll('.uca-maps-roman-dare-filters select')) {
		select.selectedIndex = 0
	}
	const pelagios_block = source_block(panel, 'pelagios')
	if (pelagios_block) {
		set_all_datasets(pelagios_block, true)
	}

}//end reset_roman_panel



/**
* RENDER_DATASET_CHECKBOXES
* One checkbox per dataset the install actually ships, all checked (v6's own
* default: every layer selected).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} block - the Pelagios section
* @param {Array<string>} datasets
* @returns {void}
*/
const render_dataset_checkboxes = function(self, block, datasets) {

	const container = block.querySelector('.uca-maps-roman-datasets')
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
* Reads one source's own fields out of its section — the ONE place the DOM is
* turned into a search request.
*
* @param {HTMLElement} block - the source's own section
* @param {string} query
* @returns {Object}
*/
const collect_roman_params = function(block, query) {

	const source = block.dataset.source
	const params = {query: query}

	if (source==='pleiades') {
		const checked = block.querySelector('.uca-maps-roman-pleiades-type input:checked')
		params.type = checked ? checked.value : 'name'
	}

	if (source==='pelagios') {
		params.datasets = Array.from(block.querySelectorAll('.uca-maps-roman-dataset-checkbox'))
			.filter((box) => box.checked)
			.map((box) => box.value)
	}

	if (source==='dare') {
		params.name_type	= block.querySelector('.uca-maps-roman-dare-name-type').value
		params.type_id		= block.querySelector('.uca-maps-roman-dare-type').value
		params.country		= block.querySelector('.uca-maps-roman-dare-country').value
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
		// the focused row IS the highlight: while the keyboard is in the list the
		// pointer moves the focus too, or Enter draws a row other than the lit one
		add_btn.addEventListener('mouseenter', () => {
			if (list.contains(document.activeElement)) {
				add_btn.focus({preventScroll: true})
			} else {
				set_active_suggestion(self, index)
			}
		})
	})

	if (place_roman_list(self, panel)) {
		list.hidden = false
	}

}//end populate_roman_results



/**
* ANCHOR_SUGGESTIONS_TO_INPUT
* Positions the list right under its source's field, in the map container's own
* coordinates — measured live, same approach (and the same accepted "not
* recalculated on resize" gap) as toolbar.js's anchor_panel_to_button.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
const anchor_suggestions_to_input = function(self, panel) {

	const input		= source_input(panel, self._roman_source)
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
