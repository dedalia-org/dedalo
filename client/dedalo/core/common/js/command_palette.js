// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals */
/*eslint no-undef: "error"*/



// import
	import {navigate_to_menu_item} from '../../menu/js/render_menu_tree.js'
	import {is_non_tools_section} from '../../section/js/render_common_section.js'
	import {open_tool} from '../../tools_common/js/tool_common.js'
	import {event_manager} from './event_manager.js'
	import {ui} from './ui.js'



/**
* COMMAND_PALETTE
* The application-wide ⌘K / Ctrl+K palette: one search box that jumps to a
* section or opens a tool, so a repeated "go to section → open tool" round needs
* no menu browsing and no per-tool shortcut (one key to remember, nothing to
* collide).
*
* Groups, in order:
*  1. provider items — a page area adds its own (area_maintenance: its widgets)
*     via add_palette_provider; removed again on the area's destroy.
*  2. Tools        — the current section's tools (section.tools, the same list
*     its tools menu shows), opened with the section as caller, as a click would.
*  3. Recent       — the last RECENT_MAX menu items navigated to, per user, in
*     localStorage; labels/permissions re-resolved from the CURRENT menu, so a
*     stale or revoked entry simply does not show.
*  4. Sections     — the user's menu tree_datalist (already permission-filtered).
*
* Never opens over a modal or inside a tool window (?tool=…).
*/



const RECENT_MAX = 8

const providers = new Set()
let palette = null // lazily built DOM {backdrop, input, list}
let items = []
let restore_focus = null
let page_ref = null



/**
* FOLD
* Lower-cases and strips diacritics so 'audiovis' matches 'Audiovisual'.
* @param {string} s
* @returns {string}
*/
export const fold = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()



/**
* ADD_PALETTE_PROVIDER
* @param {Function} fn - returns [{label, hint?, css?, action}]
* @returns {Function} remove
*/
export const add_palette_provider = (fn) => {
	providers.add(fn)
	return () => providers.delete(fn)
}



// recent sections (per user, per browser)
	const recent_key = () => 'dedalo_palette_recent_' + (page_globals.user_id ?? '')
	export const get_recent = () => {
		try {
			const v = JSON.parse(localStorage.getItem(recent_key()) || '[]')
			return Array.isArray(v) ? v : []
		} catch { return [] }
	}
	export const push_recent = (tipo) => {
		if (!tipo) { return }
		try {
			const list = [tipo, ...get_recent().filter(t => t!==tipo)].slice(0, RECENT_MAX)
			localStorage.setItem(recent_key(), JSON.stringify(list))
		} catch { /* storage blocked: recents are a convenience */ }
	}



/**
* GET_MENU_DATALIST
* @returns {Array} the menu instance's tree_datalist ([] when no menu)
*/
const get_menu_datalist = () => {
	const menu = page_ref?.ar_instances?.find(el => el.model==='menu')
	return menu?.data?.tree_datalist || []
}



/**
* STRIP_LABEL
* Menu labels may carry <mark> (untranslated fallback). Returns {text, fallback}.
* @param {string} label
* @returns {{text:string, fallback:boolean}}
*/
const strip_label = (label) => ({
	text		: String(label || '').replace(/(<([^>]+)>)/ig, ''),
	fallback	: String(label || '').includes('<mark>')
})



/**
* BUILD_ITEMS
* Collects every group's entries for the current page state.
* @returns {Array} [{group, label, hint, css, action}]
*/
export const build_items = () => {

	const out = []

	// providers
		for (const fn of providers) {
			for (const it of fn() || []) {
				out.push({ group : it.group || '', ...it })
			}
		}

	// tools of the current section (menu also carries tools: skip it).
	// section_tool pages (oh81 …) offer none: same rule as the list toolbar —
	// the caller carries the tool page's config.tool_context, which a section
	// tool would inherit as its own tool_config (tool_diffusion crashed on it).
		const caller = page_ref?.ar_instances?.find(el => el.model!=='menu' && el.tools?.length)
		if (caller && !is_non_tools_section(caller)) {
			const identify_enabled = page_globals.ai_capabilities?.identify === true
			for (const tool_context of caller.tools) {
				if (tool_context.name==='tool_identify' && !identify_enabled) { continue }
				out.push({
					group	: get_label.tools || 'Tools',
					label	: tool_context.label || tool_context.name,
					hint	: caller.label || caller.tipo || '',
					action	: () => open_tool({ tool_context, caller })
				})
			}
		}

	// sections: recent first, then all
		const datalist	= get_menu_datalist()
		const by_tipo	= new Map(datalist.map(d => [d.tipo, d]))
		const base_url	= window.location.pathname
		const section_item = (d, group) => {
			const { text, fallback } = strip_label(d.label)
			const parent = by_tipo.get(d.parent)
			return {
				group,
				label	: text,
				css		: fallback ? 'mark' : '',
				hint	: parent ? strip_label(parent.label).text : '',
				action	: () => navigate_to_menu_item(d, `${base_url}?tipo=${d.tipo}&mode=list`)
			}
		}
		for (const tipo of get_recent()) {
			const d = by_tipo.get(tipo)
			if (d) { out.push(section_item(d, get_label.recent || 'Recent')) }
		}
		for (const d of datalist) {
			out.push(section_item(d, get_label.sections || 'sections'))
		}

	return out
}//end build_items



/**
* RENDER_LIST
* Filters `items` by the input and paints them, group headings included.
* @returns {void}
*/
const render_list = () => {

	const q = fold(palette.input.value.trim())
	palette.list.replaceChildren()

	let group = null
	let first = true
	for (const it of items) {
		if (q && !fold(it.label + ' ' + (it.hint || '')).includes(q)) { continue }
		if (it.group!==group) {
			group = it.group
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'p_group',
				text_content	: group,
				parent			: palette.list
			})
		}
		// a native button (clickable, Enter/Space) kept out of the Tab order:
		// the keyboard path is the input's arrows + Enter (combobox pattern)
		const row = ui.create_dom_element({
			element_type	: 'button',
			type			: 'button',
			class_name		: 'p_item' + (first ? ' sel' : '') + (it.css ? ' ' + it.css : ''),
			parent			: palette.list
		})
		row.setAttribute('role', 'option')
		row.tabIndex = -1
		ui.create_dom_element({ element_type : 'span', class_name : 'p_name', text_content : it.label, parent : row })
		ui.create_dom_element({ element_type : 'span', class_name : 'p_zone', text_content : it.hint || '', parent : row })
		row.addEventListener('click', () => run(it))
		row._item = it
		first = false
	}

	if (first) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'p_empty',
			text_content	: get_label.command_palette_empty || 'No matches',
			parent			: palette.list
		})
	}
}//end render_list



/**
* MOVE_SELECTION
* @param {number} step - +1 / -1
* @returns {void}
*/
const move_selection = (step) => {
	const rows	= [...palette.list.querySelectorAll('.p_item')]
	if (!rows.length) { return }
	const i		= rows.findIndex(r => r.classList.contains('sel'))
	const next	= rows[(i + step + rows.length) % rows.length]
	rows[i]?.classList.remove('sel')
	next.classList.add('sel')
	next.scrollIntoView({ block : 'nearest' })
}



/**
* RUN
* Closes the palette then performs the item's action.
* @param {Object} it
* @returns {void}
*/
const run = (it) => {
	close_command_palette(false)
	it.action()
}



/**
* BUILD_PALETTE
* @returns {Object} {backdrop, input, list}
*/
const build_palette = () => {

	const backdrop = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'command_palette_backdrop',
		parent			: document.body
	})
	const box = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'command_palette',
		parent			: backdrop
	})
	box.setAttribute('role', 'dialog')
	box.setAttribute('aria-modal', 'true')
	const input = ui.create_dom_element({
		element_type	: 'input',
		type			: 'text',
		class_name		: 'command_palette_input',
		placeholder		: get_label.command_palette_placeholder || 'Go to a section or tool…',
		parent			: box
	})
	input.setAttribute('autocomplete', 'off')
	input.setAttribute('aria-label', input.placeholder)
	const list = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'command_palette_list',
		parent			: box
	})
	list.setAttribute('role', 'listbox')

	input.addEventListener('input', render_list)
	// Handled here and stopped: page.js binds document-level Enter (search) and
	// Escape (deactivate) that must not fire while the palette is open.
	input.addEventListener('keydown', (e) => {
		switch (e.key) {
			case 'ArrowDown':	move_selection(1); break
			case 'ArrowUp':		move_selection(-1); break
			case 'Escape':		close_command_palette(); break
			case 'Enter': {
				const sel = list.querySelector('.p_item.sel')
				if (sel) { run(sel._item) }
				break
			}
			default:
				if ((e.metaKey || e.ctrlKey) && (e.key==='k' || e.key==='K')) {
					close_command_palette()
					break
				}
				return
		}
		e.preventDefault()
		e.stopPropagation()
	})
	backdrop.addEventListener('click', (e) => {
		if (e.target===backdrop) { close_command_palette() }
	})

	return { backdrop, input, list }
}//end build_palette



/**
* OPEN_COMMAND_PALETTE
* @returns {boolean} opened
*/
export const open_command_palette = () => {

	// never over a modal or inside a tool window
		if (window.modal || new URLSearchParams(window.location.search).has('tool')) {
			return false
		}

	items = build_items()
	if (!items.length) { return false }

	palette = palette || build_palette()
	restore_focus = document.activeElement
	palette.input.value = ''
	render_list()
	palette.backdrop.classList.add('open')
	palette.input.focus()

	return true
}//end open_command_palette



/**
* CLOSE_COMMAND_PALETTE
* @param {boolean} [refocus=true] - give focus back to where it was
* @returns {void}
*/
export const close_command_palette = (refocus=true) => {
	if (!palette?.backdrop.classList.contains('open')) { return }
	palette.backdrop.classList.remove('open')
	// a hidden input keeps focus otherwise, and the next open would remember it
	palette.input.blur()
	if (refocus && restore_focus?.isConnected) { restore_focus.focus() }
	restore_focus = null
}



/**
* INIT_COMMAND_PALETTE
* Called by page.add_events. Binds the page (for menu + section lookup) and,
* once, records menu navigations as recents.
* @param {Object} page - the page instance
* @returns {void}
*/
export const init_command_palette = (page) => {

	const first = page_ref===null
	page_ref = page
	if (!first) { return }

	// shortcut: only in-app navigations count; a direct URL load is not recorded
	event_manager.subscribe('user_navigation', (options) => {
		const tipo = options?.source?.tipo
		if (!tipo) { return }
		const d = get_menu_datalist().find(el => el.tipo===tipo || el.config?.swap_tipo===tipo)
		if (d) { push_recent(d.tipo) }
	})
}//end init_command_palette



// @license-end
