// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DD_TIPOS */
/*eslint no-undef: "error"*/



// imports
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {clone} from '../../../core/common/js/utils/index.js'



// window focus / visibilitychange debounce (one read per tab return)
	export const USED_FOCUS_DEBOUNCE_MS = 150



/**
* USED_STATE
* The "used" marker of the cataloging mosaic: a card's drag handle gets the class
* `used` while its record is referenced by a term of one of the catalog hierarchies
* loaded in the thesaurus panel (the hierarchies' target_section_tipo).
*
* SERVER TRUTH, NEVER A CLIENT GUESS. The marker is computed from the record's
* component_inverse (dd1596) entries — the incoming relations the server derives
* live from the relation index. It used to be set once at render and then only ever
* ADDED on the drop event: a term deleted from the tree (ts_object.delete_term), or
* a term whose link component was emptied, left the card marked "used" until the
* whole tool was reloaded. Every mutation signal now re-reads dd1596 for the
* affected cards and toggles the class from that answer (refresh_used_state).
*
* ONE TRUTH, NO NODE REGISTRY (WC-2026-10-30-section-record-row-box). The
* section keeps `used_keys`, the Set of the page's used records
* (compute_used_keys over the window's entries). The mosaic's row window applies
* it to every tile it builds — the fill AND a later placeholder swap — through
* its `decorate` (mark_used_row), and refresh_used_state updates the Set and
* toggles the tiles currently built, found as the content_data's own rows and
* mapped to their records through the window's frozen entries (`entry_of`), never
* through a stored node.
*/



/**
* GET_CATALOG_TARGET_TIPOS
* The target_section_tipo of every hierarchy loaded in the thesaurus panel (dd100
* datum, `value` nodes of type 'hierarchy') — the sections whose terms "use" a card.
* @param {Object|null} area_thesaurus - The tool's area_thesaurus instance.
* @returns {Array<string>}
*/
export const get_catalog_target_tipos = function(area_thesaurus) {

	const data	= area_thesaurus?.data?.find(item => item.tipo==='dd100')
	const nodes	= Array.isArray(data?.value) ? data.value : []

	return nodes
		.filter(node => node.type==='hierarchy' && node.target_section_tipo)
		.map(node => node.target_section_tipo)
}//end get_catalog_target_tipos



/**
* IS_USED
* True when any inverse entry comes from one of the catalog target sections.
* @param {Array|undefined} entries - component_inverse (dd1596) `entries` (WC-001).
* @param {Array<string>} target_tipos - get_catalog_target_tipos() result.
* @returns {boolean}
*/
export const is_used = function(entries, target_tipos) {

	if (!Array.isArray(entries) || !Array.isArray(target_tipos) || target_tipos.length===0) {
		return false
	}

	return entries.some(el => target_tipos.includes(el.from_section_tipo))
}//end is_used



/**
* LOCATOR_KEY
* Type-tolerant key of a record ('5' and 5 are the same section_id).
* @param {Object} locator - {section_tipo, section_id}
* @returns {string}
*/
export const locator_key = function(locator) {

	return `${locator.section_tipo}_${locator.section_id}`
}//end locator_key



/**
* COMPUTE_USED_KEYS
* The Set of used records of the section's page: for every entry, its dd1596
* item in the section datum (the read that rendered the page) answered by
* is_used. One index of the datum first, so a 1000-row page is one pass.
* @param {Object} section - The cataloging section (data.entries, datum.data)
* @param {Array<string>} target_tipos - get_catalog_target_tipos() result.
* @returns {Set<string>} locator_key of every used record
*/
export const compute_used_keys = function(section, target_tipos) {

	const used			= new Set()
	const inverse_tipo	= DD_TIPOS.DEDALO_SECTION_INFO_INVERSE_RELATIONS
	const entries		= section?.data?.entries || []
	const datum_data	= section?.datum?.data || []

	const inverse_items = new Map()
	for (const item of datum_data) {
		if (item.tipo===inverse_tipo) {
			inverse_items.set(locator_key(item), item)
		}
	}
	for (const entry of entries) {
		const key = locator_key(entry)
		if (is_used(inverse_items.get(key)?.entries, target_tipos)) {
			used.add(key)
		}
	}


	return used
}//end compute_used_keys



/**
* MARK_USED_ROW
* Toggle `used` on the drag indicator of ONE tile (its own drag column; the
* hover overlay, nested in the tile, has none).
* @param {HTMLElement} row_node - The tile (`.section_record`, a direct child of
*   the content_data)
* @param {boolean} used
* @returns {void}
*/
export const mark_used_row = function(row_node, used) {

	const dragger = row_node ? row_node.querySelector(':scope > .column_drag .dragger') : null
	if (dragger) {
		dragger.classList.toggle('used', used===true)
	}
}//end mark_used_row



/**
* SUBSCRIBE_USED_TRIGGERS
* Wires every signal after which a card's marker may have changed. The marker is
* derived from OTHER records (the catalog terms that link a card), and the client
* does not know which card a removed term pointed at, so (a)-(c) refresh every
* card of the page (one read, bounded by the page size):
*   (a) `section_deleted` of a catalog section (ts_object.delete_term →
*       section.delete_section publishes it): a term deleted from the tree.
*   (b) `save` of the link component (tool_config.set_new_thesaurus_value.tipo) in a
*       catalog section: a link emptied or changed, inline in the tree or in the
*       term record opened in this window. The drop's own save is NOT skipped: a
*       one-shot skip state proved fragile (a rejected save left it armed), and
*       the extra bounded read is coalesced/serialized by refresh_used_state.
*   (c) window `focus` / `visibilitychange` to visible: a change made in another
*       window (the term record opened by open_record, another tab) publishes
*       nothing here.
* (A tree MOVE needs nothing: the term keeps its section, so its link does not
* change.) Event tokens go to tool.events_tokens (released by common destroy); the
* window listeners are released by unsubscribe_used_triggers.
* @param {Object} tool - tool_cataloging instance.
* @returns {boolean} Always true.
*/
export const subscribe_used_triggers = function(tool) {

	// (a) a catalog term deleted
		const section_deleted_handler = function(options) {
			const catalog_tipos = get_catalog_target_tipos(tool.area_thesaurus)
			if (catalog_tipos.includes(options?.section_tipo)) {
				tool.refresh_used_state()
			}
		}
		tool.events_tokens.push(
			event_manager.subscribe('section_deleted', section_deleted_handler)
		)

	// (b) a term's link component saved
		const save_handler = function(options) {
			const instance	= options?.instance
			const link		= tool.tool_config?.set_new_thesaurus_value
			if (!instance || !link) {
				return
			}
			const catalog_tipos = get_catalog_target_tipos(tool.area_thesaurus)
			if (instance.tipo===link.tipo && catalog_tipos.includes(instance.section_tipo)) {
				tool.refresh_used_state()
			}
		}
		tool.events_tokens.push(
			event_manager.subscribe('save', save_handler)
		)

	// (c) back from another window. A tab return fires BOTH focus and
	// visibilitychange: debounced so the pair costs one read.
		tool.used_focus_handler = function() {
			clearTimeout(tool.used_focus_timer)
			tool.used_focus_timer = setTimeout(() => {
				tool.used_focus_timer = null
				if (document.visibilityState==='visible') {
					tool.refresh_used_state()
				}
			}, USED_FOCUS_DEBOUNCE_MS)
		}
		window.addEventListener('focus', tool.used_focus_handler)
		document.addEventListener('visibilitychange', tool.used_focus_handler)


	return true
}//end subscribe_used_triggers



/**
* UNSUBSCRIBE_USED_TRIGGERS
* Removes the window listeners of subscribe_used_triggers (its event_manager
* tokens live in tool.events_tokens and are released by common destroy).
* @param {Object} tool - tool_cataloging instance.
* @returns {boolean} Always true.
*/
export const unsubscribe_used_triggers = function(tool) {

	if (tool.used_focus_handler) {
		window.removeEventListener('focus', tool.used_focus_handler)
		document.removeEventListener('visibilitychange', tool.used_focus_handler)
		tool.used_focus_handler = null
	}
	clearTimeout(tool.used_focus_timer)
	tool.used_focus_timer = null


	return true
}//end unsubscribe_used_triggers



/**
* REFRESH_USED_STATE
* Re-reads dd1596 for the given cards (or every card of the page) in ONE section
* read, splices the fresh items into the section datum, updates the section's
* `used_keys` (so a tile the window builds later is marked from the new truth)
* and toggles `used` on the tiles currently built.
*
* Calls are SERIALIZED on the tool: a later call is sent only after the previous
* one applied, so an older answer can never overwrite a newer one. A refresh-all
* already queued (not started) absorbs further refresh-all calls (focus storms).
*
* @param {Object} tool - tool_cataloging instance.
* @param {Array<Object>|null} [locators=null] - Records to refresh; null = every
*   card of the page.
* @returns {Promise<boolean>} true when the state was applied.
*/
export const refresh_used_state = function(tool, locators=null) {

	const refresh_all = !Array.isArray(locators)

	if (refresh_all && tool.used_refresh_all_queued) {
		return tool.used_refresh_all_queued
	}

	const previous	= tool.used_refresh_chain || Promise.resolve()
	const run		= previous
		.catch(() => {})
		.then(() => {
			if (refresh_all) {
				tool.used_refresh_all_queued = null
			}
			return apply_used_state(tool, locators)
		})
		.catch(error => {
			console.error('[tool_cataloging] used state refresh failed:', error)
			return false
		})

	tool.used_refresh_chain = run
	if (refresh_all) {
		tool.used_refresh_all_queued = run
	}

	return run
}//end refresh_used_state



/**
* APPLY_USED_STATE
* One refresh round (see refresh_used_state).
* @param {Object} tool
* @param {Array<Object>|null} locators
* @returns {Promise<boolean>}
*/
const apply_used_state = async function(tool, locators) {

	const section		= tool.section_to_cataloging
	const record_window	= section?.record_windows?.rows || null
	if (!section || tool.status==='destroyed' || !record_window || record_window.size===0) {
		return false
	}

	// records to refresh: the requested ones on this page, or all of them (the
	// window's frozen entries — never a node registry)
		const wanted = Array.isArray(locators)
			? new Set(locators.map(locator_key))
			: null
		const requested = new Map()
		for (let i = 0; i < record_window.size; i++) {
			const entry = record_window.entry_of(i)
			if (!entry) {
				continue
			}
			const key = locator_key(entry)
			if (wanted===null || wanted.has(key)) {
				requested.set(key, {
					section_tipo	: entry.section_tipo,
					section_id		: entry.section_id
				})
			}
		}
		if (requested.size===0) {
			return false
		}

	// read: dd1596 only, pinned to the records, outside the user's session navigation
		const inverse_tipo	= DD_TIPOS.DEDALO_SECTION_INFO_INVERSE_RELATIONS
		const ddo			= section.rqo?.show?.ddo_map?.find(el => el.tipo===inverse_tipo)
		const inverse_ddo	= ddo
			? clone(ddo)
			: {
				tipo			: inverse_tipo,
				section_tipo	: section.section_tipo,
				parent			: section.tipo,
				mode			: 'list'
			}
		const source = Object.assign(clone(section.rqo?.source || {}), {
			session_save : false
		})
		const filter_by_locators = [...requested.values()]
		const rqo = {
			action			: 'read',
			prevent_lock	: true,
			source			: source,
			show			: {
				ddo_map : [inverse_ddo]
			},
			sqo				: {
				section_tipo		: [section.section_tipo],
				filter_by_locators	: filter_by_locators,
				limit				: filter_by_locators.length,
				offset				: 0
			}
		}
		const api_response = await data_manager.request({
			body : rqo
		})
		if (request_failed(api_response)) {
			console.error('[tool_cataloging] used state read failed:', api_response.error)
			return false
		}
		// the tool or the page may be gone while the read was in flight (a page
		// change supersedes the window: its rows are not these records any more)
		if (tool.status==='destroyed' || section.record_windows?.rows!==record_window) {
			return false
		}

	// fresh dd1596 items, by record
		const items	= response_data(api_response)?.data || []
		const fresh	= new Map()
		for (const item of items) {
			if (item.tipo===inverse_tipo) {
				fresh.set(locator_key(item), item)
			}
		}

	// datum: replace the requested records' dd1596 items (in place: the section
	// and its records share the array)
		const datum_data = section.datum?.data
		if (Array.isArray(datum_data)) {
			for (let i = datum_data.length - 1; i >= 0; i--) {
				const el = datum_data[i]
				if (el.tipo===inverse_tipo && requested.has(locator_key(el))) {
					datum_data.splice(i, 1)
				}
			}
			datum_data.push(...fresh.values())
		}

	// used_keys: the truth decorate reads for every tile built from now on
		const target_tipos	= get_catalog_target_tipos(tool.area_thesaurus)
		const used_keys		= (section.used_keys instanceof Set)
			? section.used_keys
			: (section.used_keys = new Set())
		for (const key of requested.keys()) {
			if (is_used(fresh.get(key)?.entries, target_tipos)) {
				used_keys.add(key)
			}else{
				used_keys.delete(key)
			}
		}

	// tiles built now: the content_data's own rows (placeholders hold nothing)
		const content_data	= section.node?.content_data || null
		const rows			= content_data
			? content_data.querySelectorAll(':scope > .section_record:not(.placeholder)')
			: []
		for (const row of rows) {
			const entry = record_window.entry_of(Number(row.dataset.index))
			if (!entry) {
				continue
			}
			const key = locator_key(entry)
			if (requested.has(key)) {
				mark_used_row(row, used_keys.has(key))
			}
		}


	return true
}//end apply_used_state



// @license-end
