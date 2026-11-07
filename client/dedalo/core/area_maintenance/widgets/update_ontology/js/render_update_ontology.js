// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* RENDER_UPDATE_ONTOLOGY
* Client-side rendering module for the `update_ontology` maintenance widget.
*
* View layer only — data transport lives in `update_ontology.js`, the import
* pipeline in `src/core/ontology/ontology_update.ts`. The panel does ONE job:
* pull an ontology snapshot from a master server and overwrite the local one.
*
* Layout (top → bottom)
* ---------------------
*   a. Danger callout — the overwrite is irreversible.
*   b. Installed ontology — a labelled readout (version / source / date / entity)
*      from `self.value.current_ontology` (the dd1 root-node properties).
*   c. Master server — radio picker (`render_servers_list`) with a reachability
*      pill; unreachable servers are disabled. The choice is REMEMBERED in this
*      browser (by URL) and restored on the next render. Several masters are
*      usable side by side: the update takes the ticked TLDs from the picked one
*      (the run's `source`). Below it, a collapsed admin note: `build_client_info`
*      (the ONTOLOGY_SERVERS key that populates the picker). Whether THIS install
*      can SERVE its ontology is its own widget since 2026-09-28 (serve_ontology).
*   d. Update form — the picked master's catalog (`build_tld_catalog`: every
*      ontology it offers, grouped by typology, named, marked new / installed /
*      installed-but-not-tracked) over the TLD input, which is the OPERATOR's
*      (persisted in localStorage, never overwritten by a server selection), +
*      the destructive submit button. On submit: Phase 1
*      `get_ontology_update_info` (discover files) → show the installed→incoming
*      version change → the confirm modal → Phase 2 `update_ontology` (a
*      background job, followed with a progress bar: track_update_job) → one
*      status line + a collapsible import log + a collapsed raw-JSON detail.
*
* Removed at the v7 redesign (were dead or redundant): the STRUCTURE_FROM_SERVER
* / ACTIVE_ONTOLOGY_TLDS config grid, the raw current-ontology JSON dump, the
* duplicated response message + always-expanded JSON envelope, and the
* "rebuild lang files" and "export to translate" panels (both engine_denied in
* v7 — labels are DB-derived and the CSV workflow is unported).
*
* Public exports
* --------------
*   render_update_ontology  — prototype constructor (`list`/`edit` assigned in
*                             update_ontology.js).
*   render_servers_list     — exported for reuse by the server-picker.
*   get_update_info         — exported for its executed wire gate.
*   tld_catalog_rows        — exported for its client gate.
*   update_progress_share   — exported for its client gate.
*/

// imports
	import {ui} from '../../../../common/js/ui.js'
	import {dd_request_idle_callback} from '../../../../common/js/events.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {event_manager} from '../../../../common/js/event_manager.js'
	import {is_api_error, normalize_stream_error, request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {error_text} from '../../../../common/js/render_api_error.js'
	import {data_version_of} from '../../../../common/js/release_identity.js'
	import {build_waive_backup_row} from '../../update_code/js/render_update_status.js'



/**
* RENDER_UPDATE_ONTOLOGY
* No-op constructor; all logic lives in the prototype `list` method (assigned as
* both `list` and `edit` in update_ontology.js). Never instantiate directly.
*/
export const render_update_ontology = function() {

	return true
}//end render_update_ontology



/**
* LIST
* Entry-point render method. Builds the panel and wraps it in the standard
* widget shell.
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} wrapper (full) or content_data (content)
*/
render_update_ontology.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* BUILD_READOUT
* Two-tone key/value readout using the shared widget_kit grid
* (`.dd_readout` > `.dd_row` > `.dd_k` + `.dd_v`).
*
* @param {Array<{k:string, v:string, mono?:boolean}>} rows
* @returns {HTMLElement}
*/
const build_readout = function (rows) {

	const readout = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_readout'
	})
	rows.forEach(row => {
		const tr = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_row',
			parent			: readout
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_k',
			inner_html		: row.k,
			parent			: tr
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: row.mono ? 'dd_v mono' : 'dd_v',
			text_content	: (row.v===null || row.v===undefined || row.v==='') ? '—' : String(row.v),
			parent			: tr
		})
	})

	return readout
}//end build_readout



/**
* BUILD_DETAILS
* Collapsible `<details>` holding a monospace console `<pre>`.
*
* @param {string} summary_text
* @param {string} pre_content
* @param {Object} [opts]
* @param {boolean} [opts.open=false]
* @param {string}  [opts.pre_class='']
* @returns {HTMLElement}
*/
const build_details = function (summary_text, pre_content, opts) {

	const options = opts || {}
	const details = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'dd_fold response_detail'
	})
	if (options.open===true) {
		details.setAttribute('open', 'open')
	}
	ui.create_dom_element({
		element_type	: 'summary',
		inner_html		: summary_text,
		parent			: details
	})
	// pre_content is SERVER text (import log, warnings, raw JSON): TEXT, never a sink
	ui.create_dom_element({
		element_type	: 'pre',
		class_name		: options.pre_class || '',
		text_content	: String(pre_content ?? ''),
		parent			: details
	})

	return details
}//end build_details



/**
* BUILD_VERSION_CHANGE
* installed → incoming transition cards, shown once the manifest is fetched so
* the operator sees the target version before the import lands.
*
* @param {Object} installed  - self.value.current_ontology
* @param {Object} incoming    - result.info from get_ontology_update_info
* @returns {HTMLElement}
*/
const build_version_change = function (installed, incoming) {

	const fmt_date = (d) => (typeof d==='string' && d.length>=10) ? d.slice(0,10) : '—'

	const wrap = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'version_change'
	})

	// installed card
		const from = ui.create_dom_element({ element_type:'div', class_name:'vcard', parent:wrap })
		ui.create_dom_element({ element_type:'div', class_name:'lbl', inner_html:(get_label.update_ontology_version_installed_now || 'Installed now'), parent:from })
		ui.create_dom_element({ element_type:'div', class_name:'num', text_content:String(installed.version || '—'), parent:from })
		ui.create_dom_element({ element_type:'div', class_name:'src', text_content:`${installed.host || '—'} · ${fmt_date(installed.date)}`, parent:from })

	// arrow
		ui.create_dom_element({ element_type:'div', class_name:'arrow', inner_html:'→', parent:wrap })

	// incoming card
		const to = ui.create_dom_element({ element_type:'div', class_name:'vcard incoming', parent:wrap })
		ui.create_dom_element({ element_type:'div', class_name:'lbl', inner_html:(get_label.update_ontology_version_incoming || 'Incoming'), parent:to })
		ui.create_dom_element({ element_type:'div', class_name:'num', text_content:String((incoming && incoming.version) || '—'), parent:to })
		ui.create_dom_element({ element_type:'div', class_name:'src', text_content:`${(incoming && incoming.host) || '—'} · ${fmt_date(incoming && incoming.date)}`, parent:to })

	return wrap
}//end build_version_change



/**
* BUILD_FAILURE
* The failure of a Phase 1/Phase 2 request, IN the panel. The page-wide
* 'api_error' channel (data_manager → page.js → handle_api_error) already runs
* the policy (relogin, error report signal), but its toast lands in the
* inspector bubble container, which this area does not show — so a refused
* update used to surface in the console only.
* The label alone ('The maintenance action failed') is useless to an operator:
* the server message carries the cause (e.g. an origin mismatch naming both
* hosts), and the request_id joins the server log. Text nodes only — server
* text never reaches an HTML sink.
*
* @param {Object} api_error - envelope `error` (ApiError or its plain shape)
* @returns {HTMLElement}
*/
export const build_failure = function (api_error) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'error'
	})

	const headline	= String(error_text(api_error))
	const message	= typeof api_error?.message==='string' ? api_error.message : ''
	const lines		= [headline]
	if (message.length && message!==headline) {
		lines.push(...message.split(/\n/))
	}
	if (typeof api_error?.request_id==='string' && api_error.request_id.length) {
		lines.push(`request_id: ${api_error.request_id}`)
	}
	lines.forEach((line, i) => {
		if (i>0) node.appendChild(document.createElement('br'))
		node.appendChild(document.createTextNode(line))
	})

	return node
}//end build_failure



/**
* BUILD_IMPORT_FILES
* Phase 2's file list from the master's manifest: `matrix_dd` first and once
* (when the manifest names it AND it is selected), then the manifest files of the selected TLDs, in manifest
* order, each enriched from `info.active_ontologies` with its typology_id,
* name_data and — ONLY when the master declares them — its `dependencies`
* ({tld, main, mandatory} objects). Absent stays absent (≠ []: an empty list
* is a declaration of "none"); the import records them on the registry row
* (hierarchy60) so this server re-serves them
* (WC-2026-10-10-ontology-dependencies-hierarchy60).
* Pure: the manifest is not mutated. Exported for its gate:
* client/dedalo/test/client/js/test_update_code.js (build_import_files).
*
* @param {Object} manifest - the get_update_info result: {files, info}
* @param {Array<string>} ar_active_ontology_tlds - the operator's TLD selection
* @returns {Array<Object>} files for the update_ontology request
*/
export const build_import_files = function (manifest, ar_active_ontology_tlds) {

	const files				= Array.isArray(manifest?.files) ? manifest.files : []
	const active_ontologies	= Array.isArray(manifest?.info?.active_ontologies) ? manifest.info.active_ontologies : []

	const files_filtered = files
		// matrix_dd is placed first below, once, when selected
		.filter(el => el.tld!=='matrix_dd' && ar_active_ontology_tlds.includes(el.tld))
		.map(el => {
			const file_item	= {...el}
			const found		= active_ontologies.find(item => item.tld===file_item.tld)
			if (found) {
				file_item.typology_id	= found.typology_id
				file_item.name_data		= found.name_data
				if (found.dependencies !== undefined) {
					file_item.dependencies = found.dependencies
				}
			}
			return file_item
		})

	const selected_files	= []
	const matrix_dd			= files.find(el => el.tld==='matrix_dd')
	if (matrix_dd && ar_active_ontology_tlds.includes('matrix_dd')) {
		selected_files.push({...matrix_dd})
	}
	selected_files.push(...files_filtered)

	return selected_files
}//end build_import_files



/**
* GET_UPDATE_INFO
* Phase 1 of the update: ask a master for its manifest (available files + the
* version info). Called from TWO places — the catalog (when a master is picked)
* and the submit flow — so the request shape lives in ONE place.
* Exported so its wire shape (the DATA triple as `options.version`, never the
* release identity) is gated by EXECUTING it:
* test/unit/client_release_identity_wire.test.ts.
*
* @param {Object} server - a `value.servers` entry (url + code)
* @returns {Promise<Object>} the raw api_response (caller inspects the envelope)
*/
export const get_update_info = async function (server) {

	const api_response = await data_manager.request({
		url		: server.url,
		body	: {
			dd_api			: 'dd_utils_api',
			action			: 'get_ontology_update_info',
			prevent_lock	: true,
			source			: { action : 'update_ontology' },
			options : {
				// the DATA triple: an ontology server reads major.minor of it,
				// and an older one parses integers only (published beside the
				// identity as page_globals.dedalo_data_version; derived as fallback)
				version	: page_globals.dedalo_data_version || data_version_of(page_globals.dedalo_version),
				code	: server.code
			}
		},
		retries : 1,
		timeout : 3600 * 1000
	})
	if(SHOW_DEBUG===true) {
		console.log('))) get_ontology_update_info:', api_response)
	}

	return api_response
}//end get_update_info



/**
* TLDS_STORAGE_KEY
* Per-ORIGIN key (localStorage is origin-scoped, so two installations served from
* different hosts never share an edit). The selection names `matrix_dd` (the
* shared value lists) explicitly since 2026-11-07; the line remembered under the
* older key never did — the lists were always added — so it is read once, with
* `matrix_dd` appended, moved to the new key and dropped (a later Clear must
* not bring it back).
*/
const TLDS_STORAGE_KEY			= 'dedalo.update_ontology.selection'
const TLDS_STORAGE_KEY_BEFORE	= 'dedalo.update_ontology.tlds'

/**
* READ_STORED_TLDS / STORE_TLDS
* The operator's own TLD line, remembered across reloads. Private-mode browsers
* throw on access, so both sides are guarded and simply degrade to "no memory".
*
* @returns {string|null}
*/
const read_stored_tlds = function () {
	try {
		const stored = window.localStorage.getItem(TLDS_STORAGE_KEY)
		if (typeof stored==='string' && stored.trim().length>0) {
			return stored
		}
		const before = window.localStorage.getItem(TLDS_STORAGE_KEY_BEFORE)
		if (typeof before!=='string' || before.trim().length===0) {
			return null
		}
		// moved once: the older key is dropped, so a later Clear cannot resurrect it
		const moved = before + ',matrix_dd'
		window.localStorage.setItem(TLDS_STORAGE_KEY, moved)
		window.localStorage.removeItem(TLDS_STORAGE_KEY_BEFORE)
		return moved
	} catch (_error) {
		return null
	}
}
const store_tlds = function (value) {
	try {
		if (typeof value==='string' && value.trim().length>0) {
			window.localStorage.setItem(TLDS_STORAGE_KEY, value)
		} else {
			window.localStorage.removeItem(TLDS_STORAGE_KEY)
		}
	} catch (_error) {
		// no memory available — the input still works for this visit
	}
}//end store_tlds



/**
* READ_STORED_SERVER / STORE_SERVER
* The chosen master, remembered across navigations and reloads. The URL is the
* identity (names are free text and may repeat); the key is per PICKER, since
* update_code reuses this picker over a different server list. Same private-mode
* guard as the TLD line: no memory is a degradation, never an error.
*
* @param {string} storage_key
*/
const read_stored_server = function (storage_key) {
	try {
		const stored = window.localStorage.getItem(storage_key)
		return (typeof stored==='string' && stored.length>0) ? stored : null
	} catch (_error) {
		return null
	}
}
const store_server = function (storage_key, url) {
	try {
		if (typeof url==='string' && url.length>0) {
			window.localStorage.setItem(storage_key, url)
		} else {
			window.localStorage.removeItem(storage_key)
		}
	} catch (_error) {
		// no memory available — the selection still works for this visit
	}
}//end store_server



/**
* TLD_NAME
* An ontology's name in `lang` (else English, else the manifest's `name`),
* without the ` | <tld>` suffix the master appends (the TLD is shown beside it).
* `name_data` is the manifest's `[{lang, value}]` list; an older master sends a
* `{lang: value}` map — both are read.
*
* @param {Object} meta - an `info.active_ontologies` entry
* @param {string} tld
* @param {string} lang - e.g. 'lg-spa'
* @returns {string|null}
*/
const tld_name = function (meta, tld, lang) {
	const data = meta?.name_data
	const pick = (code) => {
		if (Array.isArray(data)) {
			return data.find(el => el?.lang===code)?.value
		}
		const value = data?.[code]
		return Array.isArray(value) ? value[0] : value
	}
	const raw = pick(lang) || pick('lg-eng') || meta?.name || null
	if (typeof raw!=='string' || raw.length===0) {
		return null
	}
	const suffix = ' | ' + tld
	return raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw
}//end tld_name



/**
* TLD_CATALOG_ROWS
* What a master offers, one row per TLD, in the words an operator reads: name,
* typology (the group) and what selecting it does HERE —
*   'new'       not installed: it will be added;
*   'installed' installed and tracked (ACTIVE_ONTOLOGY_TLDS ∪ core): replaced;
*   'untracked' installed but NOT tracked: possibly a local ontology of this
*               installation — replacing it overwrites it, so it is flagged.
* `matrix_dd` (the shared value lists) heads the list, in its own group.
* Sorted by group, then TLD. Pure — exported for its client gate.
*
* @param {Object} manifest - `get_ontology_update_info` result ({info, files})
* @param {string[]} installed - value.installed_tlds
* @param {string[]} tracked - value.active_ontology_tlds
* @param {string} lang
* @returns {Array<{tld:string, name:string, group:string, state:string}>}
*/
export const tld_catalog_rows = function (manifest, installed, tracked, lang) {

	const files			= Array.isArray(manifest?.files) ? manifest.files : []
	const meta			= new Map((manifest?.info?.active_ontologies || []).map(el => [el?.tld, el]))
	const installed_set	= new Set(installed || [])
	const tracked_set	= new Set(tracked || [])
	const lists_name	= get_label.update_ontology_matrix_dd_name || 'Shared value lists'
	const other_group	= get_label.update_ontology_group_other || 'Other'

	const rows = []
	const seen = new Set()
	for (const file of files) {
		const tld = file?.tld
		// `matrix` is the export's data dump, never an ontology
		if (typeof tld!=='string' || tld==='matrix' || seen.has(tld)) {
			continue
		}
		seen.add(tld)
		if (tld==='matrix_dd') {
			rows.push({ tld, name : lists_name, group : lists_name, state : 'installed', first : true })
			continue
		}
		const entry = meta.get(tld)
		rows.push({
			tld,
			name	: tld_name(entry, tld, lang) || tld,
			group	: (typeof entry?.typology_name==='string' && entry.typology_name) || other_group,
			state	: !installed_set.has(tld) ? 'new' : (tracked_set.has(tld) ? 'installed' : 'untracked')
		})
	}

	rows.sort((a, b) => (b.first===true) - (a.first===true)
		|| a.group.localeCompare(b.group)
		|| a.tld.localeCompare(b.tld))
	rows.forEach(row => { delete row.first })

	return rows
}//end tld_catalog_rows



/**
* BUILD_TLD_CATALOG
* The selection block ABOVE the TLD input: every ontology the picked master
* offers, grouped by typology, each with its name and what selecting it does
* here (new / installed / installed but not tracked). Ticking a row adds its TLD
* to the input; the input stays the single source of truth (typing works too,
* and every checkbox is repainted from it), remembered in this browser.
*
* A server selection only (re)lists what THAT master offers — it never writes
* the input. The list is read from the master's manifest when the master is
* picked (one request, kept per master for the visit).
*
* @param {Object} options
* @param {Function} options.get_value - reads the live input value
* @param {Function} options.set_value - writes the input value (and persists it)
* @param {string[]} options.installed - value.installed_tlds
* @param {string[]} options.tracked - value.active_ontology_tlds
* @param {boolean} options.configured_by_env - value.active_ontology_tlds_configured
* @param {Function} options.fetch_manifest - async (server) => manifest | ApiError (the master refused) | null
* @returns {{node:HTMLElement, sync:Function, set_server:Function, untracked_selected:Function}}
*/
const build_tld_catalog = function (options) {

	const get_value	= options.get_value
	const set_value	= options.set_value
	const tracked	= options.tracked || []
	const defaults	= [...new Set([...tracked, 'matrix_dd'])]
	const lang		= page_globals.dedalo_application_lang || 'lg-eng'

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'tld_catalog'
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_eyebrow',
		inner_html		: (get_label.update_ontology_tlds_title || 'Ontologies to update'),
		parent			: node
	})
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'dd_note',
		inner_html		: (get_label.update_ontology_catalog_note || 'Pick a server above: every ontology it offers is listed here, with its name and whether it is installed. The ticked ones are replaced from that server. Your selection is remembered in this browser.'),
		parent			: node
	})

	// toolbar: filter, selected-only, count, default, clear
	const toolbar = ui.create_dom_element({ element_type:'div', class_name:'tld_toolbar', parent:node })
	const filter_input = ui.create_dom_element({
		element_type	: 'input',
		type			: 'search',
		class_name		: 'tld_filter',
		placeholder		: (get_label.update_ontology_filter_placeholder || 'Filter by TLD, name or typology'),
		parent			: toolbar
	})
	filter_input.setAttribute('aria-label', filter_input.placeholder)
	const only_label = ui.create_dom_element({ element_type:'label', class_name:'tld_only', parent:toolbar })
	const only_input = ui.create_dom_element({ element_type:'input', type:'checkbox', parent:only_label })
	only_label.appendChild(document.createTextNode(' ' + (get_label.update_ontology_selected_only || 'Selected only')))
	const count_node = ui.create_dom_element({ element_type:'span', class_name:'tld_count', parent:toolbar })
	const default_button = ui.create_dom_element({
		element_type	: 'button',
		type			: 'button',
		class_name		: 'light tld_default',
		inner_html		: (get_label.update_ontology_use_default || 'Default selection'),
		parent			: toolbar
	})
	const clear_button = ui.create_dom_element({
		element_type	: 'button',
		type			: 'button',
		class_name		: 'light tld_clear',
		inner_html		: (get_label.update_ontology_clear || 'Clear'),
		parent			: toolbar
	})
	// where the default comes from — an administrator must know which it is
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'dd_note tld_default_note',
		inner_html		: options.configured_by_env===true
			? (get_label.update_ontology_default_env || 'Default selection: <code>ACTIVE_ONTOLOGY_TLDS</code> from <code>../private/.env</code>, plus the core pair and the shared value lists.')
			: (get_label.update_ontology_default_fallback || 'Default selection: the engine’s built-in list, because <code>ACTIVE_ONTOLOGY_TLDS</code> is not set in <code>../private/.env</code>. Set it to make your own set the default for everyone.'),
		parent			: node
	})

	const list_head = ui.create_dom_element({ element_type:'div', class_name:'tld_list_head', parent:node })
	const list = ui.create_dom_element({ element_type:'div', class_name:'tld_list', parent:node })
	const notes = ui.create_dom_element({ element_type:'div', class_name:'tld_notes', parent:node })

	let rows		= []	// tld_catalog_rows of the listed master
	let row_nodes	= []	// {row, node, input}
	let server		= null
	const manifests	= new Map() // per master url, for the visit

	/** The input line as trimmed, non-empty TLDs. */
	const current_list = () => get_value().split(',').map(el => el.trim()).filter(el => el.length>0)

	const write = (list_value) => {
		set_value(list_value.join(','))
		sync()
	}

	const empty = (text) => {
		while (list.firstChild) {
			list.removeChild(list.firstChild)
		}
		row_nodes = []
		ui.create_dom_element({ element_type:'div', class_name:'empty', text_content:text, parent:list })
	}

	/** Repaints checkboxes, filter, count and notes from the input line. */
	const sync = function () {
		const current	= new Set(current_list())
		const needle	= filter_input.value.trim().toLowerCase()
		for (const entry of row_nodes) {
			const on = current.has(entry.row.tld)
			entry.input.checked = on
			entry.node.classList.toggle('on', on)
			const matches = needle.length===0
				|| entry.row.tld.includes(needle)
				|| entry.row.name.toLowerCase().includes(needle)
				|| entry.row.group.toLowerCase().includes(needle)
			entry.node.hidden = !matches || (only_input.checked && !on)
		}
		// a group with every row hidden hides its heading too
		list.querySelectorAll('.tld_group').forEach(group => {
			group.hidden = !group.querySelector('.tld_row:not([hidden])')
		})
		count_node.textContent = (get_label.update_ontology_selected_count || '%s selected').replace('%s', String(current.size))

		while (notes.firstChild) {
			notes.removeChild(notes.firstChild)
		}
		const untracked = untracked_selected()
		if (untracked.length>0) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning',
				text_content	: (get_label.update_ontology_untracked_warning || 'Will overwrite ontologies installed here that this installation does not track: %s. If one is a local ontology, untick it.').replace('%s', untracked.join(', ')),
				parent			: notes
			})
		}
		if (rows.length>0) {
			const offered = new Set(rows.map(row => row.tld))
			const missing = [...current].filter(tld => !offered.has(tld))
			if (missing.length>0) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_note',
					text_content	: (get_label.update_ontology_not_offered || 'Not offered by this server, will be skipped: %s').replace('%s', missing.join(', ')),
					parent			: notes
				})
			}
		}
	}

	/** The selected TLDs the listed master offers that are installed here but not tracked. */
	const untracked_selected = function () {
		const current = new Set(current_list())
		return rows.filter(row => row.state==='untracked' && current.has(row.tld)).map(row => row.tld)
	}

	const state_badge = {
		new			: { cls:'pill_ok',    text:() => get_label.update_ontology_state_new || 'New' },
		installed	: { cls:'pill_neutral', text:() => get_label.update_ontology_state_installed || 'Installed' },
		untracked	: { cls:'pill_warning', text:() => get_label.update_ontology_state_untracked || 'Installed · not tracked' }
	}

	/** Lists `rows` grouped (the row order is already by group). */
	const paint = function () {
		while (list.firstChild) {
			list.removeChild(list.firstChild)
		}
		row_nodes = []
		let group_node = null
		let group_name = null
		for (const row of rows) {
			if (row.group!==group_name) {
				group_name = row.group
				group_node = ui.create_dom_element({ element_type:'div', class_name:'tld_group', parent:list })
				ui.create_dom_element({ element_type:'div', class_name:'grp', text_content:group_name, parent:group_node })
			}
			const row_node = ui.create_dom_element({ element_type:'label', class_name:'tld_row', parent:group_node })
			const input = ui.create_dom_element({ element_type:'input', type:'checkbox', value:row.tld, parent:row_node })
			input.addEventListener('change', () => {
				const current = current_list().filter(tld => tld!==row.tld)
				if (input.checked) {
					current.push(row.tld)
				}
				write(current)
			})
			ui.create_dom_element({ element_type:'code', class_name:'tld', text_content:row.tld, parent:row_node })
			ui.create_dom_element({ element_type:'span', class_name:'nm', text_content:row.name, parent:row_node })
			const badge = state_badge[row.state]
			const pill = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_badge ' + badge.cls,
				text_content	: badge.text(),
				parent			: row_node
			})
			if (row.state==='untracked') {
				pill.title = get_label.update_ontology_state_untracked_title || 'Installed here but not in this installation’s tracked set (ACTIVE_ONTOLOGY_TLDS). It may be a local ontology: replacing it overwrites it.'
			}
			row_nodes.push({ row, node:row_node, input })
		}
		sync()
	}

	filter_input.addEventListener('input', sync)
	only_input.addEventListener('change', sync)
	default_button.addEventListener('click', () => write(defaults))
	clear_button.addEventListener('click', () => write([]))

	/** Lists what `next` offers (null = no master picked). */
	const set_server = async function (next) {
		server = next || null
		rows = []
		list_head.textContent = server
			? (get_label.update_ontology_tlds_row_master_named || 'Offered by %s').replace('%s', server.name)
			: ''
		if (!server) {
			empty(get_label.update_ontology_catalog_pick_server || 'Pick a server to list its ontologies.')
			sync()
			return
		}
		empty(get_label.update_ontology_catalog_loading || 'Reading the server’s list…')
		list.classList.add('loading')
		const asked = server
		let manifest = manifests.get(asked.url)
		if (manifest===undefined) {
			manifest = await options.fetch_manifest(asked)
			if (manifest && !is_api_error(manifest)) {
				manifests.set(asked.url, manifest)
			}
		}
		list.classList.remove('loading')
		// a newer pick won while this one was loading
		if (server!==asked) {
			return
		}
		// the master's own reason (e.g. no export for this version): never cached, a re-pick retries
		if (is_api_error(manifest)) {
			empty('')
			list.replaceChildren(build_failure(manifest))
			sync()
			return
		}
		rows = tld_catalog_rows(manifest, options.installed, tracked, lang)
		if (rows.length===0) {
			empty(get_label.update_ontology_tlds_empty_master_none || 'the master returned no list — check its access code')
			sync()
			return
		}
		list_head.textContent = (get_label.update_ontology_tlds_row_master_count || 'Offered by %s (%s)')
			.replace('%s', server.name)
			.replace('%s', String(rows.length))
		paint()
	}

	empty(get_label.update_ontology_catalog_pick_server || 'Pick a server to list its ontologies.')

	return {
		node,
		// the input is editable by hand too: the panel calls this on every
		// keystroke so the checkboxes never lie about what is in the line
		sync,
		set_server,
		untracked_selected
	}
}//end build_tld_catalog



/**
* OPEN_CONFIRM_MODAL
* The update's last gate, in the SAME shape as the code update's version modal
* (render_update_code.js render_info_modal): what will be replaced, from where,
* and — only when the run would refuse without it — the backup waiver row
* (render_update_status.js build_waive_backup_row, the one row both modals
* mount) beside the action button, then `ui.confirm` restating the choice.
* The update run (core/update/run/start.ts) REFUSES without a recent,
* proven-restorable database backup; `value.backup` is the server's own
* `backup_fresh` line, re-read on click (the backup can age while the modal is
* open) so a waiver that became necessary is offered instead of a refusal.
* Resolves `{waive_backup}` on accept, `null` when the operator closes it.
*
* @param {Object} self - the update_ontology widget instance
* @param {Object} options
* @param {Object} options.server - the picked master
* @param {Object} options.result - Phase 1 manifest ({info, files})
* @param {Array<Object>} options.selected_files - build_import_files output
* @param {string[]} options.untracked - selected TLDs installed but not tracked
* @param {string} options.confirm_text - the irreversibility warning
* @returns {Promise<{waive_backup:boolean}|null>}
*/
const open_confirm_modal = function (self, options) {

	const { server, result, selected_files, untracked, confirm_text } = options
	const value	= self.value || {}
	const lang	= page_globals.dedalo_application_lang || 'lg-eng'
	const host	= result.info?.host || server.name || ''
	const tlds	= selected_files.map(el => el.tld)
	const submit_label = get_label.update_ontology_submit || 'Replace selected ontologies'

	return new Promise((resolve) => {

		let settled = false
		const settle = (decision) => {
			if (!settled) {
				settled = true
				resolve(decision)
			}
		}

		// header. TEXT only: the master's name/host are remote data
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			text_content	: [server.name, result.info?.host].filter(Boolean).join(' · ') || submit_label
		})

		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body widget_update_ontology'
		})
		body.appendChild(build_version_change(value.current_ontology || {}, result.info))

		// what will be replaced, named
		ui.create_dom_element({ element_type:'span', class_name:'dd_eyebrow', inner_html:(get_label.update_ontology_tlds_title || 'Ontologies to update'), parent:body })
		const list = ui.create_dom_element({ element_type:'div', class_name:'confirm_tlds', parent:body })
		for (const file of selected_files) {
			const row = ui.create_dom_element({ element_type:'div', class_name:'confirm_tld', parent:list })
			ui.create_dom_element({ element_type:'code', class_name:'tld', text_content:file.tld, parent:row })
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'nm',
				text_content	: file.tld==='matrix_dd'
					? (get_label.update_ontology_matrix_dd_name || 'Shared value lists')
					: (tld_name(file, file.tld, lang) || ''),
				parent			: row
			})
		}
		if (untracked.length>0) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning untracked_note',
				text_content	: (get_label.update_ontology_untracked_warning || 'Will overwrite ontologies installed here that this installation does not track: %s. If one is a local ontology, untick it.').replace('%s', untracked.join(', ')),
				parent			: body
			})
		}

		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content'
		})
		const button_update = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'danger',
			inner_html		: submit_label,
			parent			: footer
		})
		const response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response content',
			parent			: footer
		})

		// the waiver: mounted only when the run would refuse without it, ABOVE
		// the button (read, not stumbled on) — the code modal's row, alone
		let waive_backup_input = null
		const mount_waive_row = function (check) {
			if (waive_backup_input!==null) {
				return
			}
			const waive = build_waive_backup_row(check, 'update_ontology_waive_backup')
			footer.appendChild(waive.row)
			// everything mounted so far goes above the button
			footer.appendChild(button_update)
			footer.appendChild(response)
			waive_backup_input = waive.input
			// the run would refuse anyway: no Replace until the waiver is given
			const sync_button = () => {
				button_update.disabled = waive_backup_input.checked!==true
			}
			waive_backup_input.addEventListener('change', sync_button)
			sync_button()
		}
		if (value.backup && value.backup.state!=='ok') {
			mount_waive_row(value.backup)
		}

		// one click at a time: the re-check below reads the whole panel value (it
		// probes every master), and a second click must not stack a second confirm
		let busy = false
		button_update.addEventListener('click', async (e) => {
			e.stopPropagation()
			if (busy) {
				return
			}
			busy = true
			try {
				await on_update_click()
			} finally {
				busy = false
			}
		})
		const on_update_click = async () => {

			// the backup can age while the modal is open: re-ask, and offer the
			// waiver instead of submitting a request the run would refuse
			if (waive_backup_input===null) {
				try {
					const late_value = await self.get_value()
					if (late_value?.backup && late_value.backup.state!=='ok') {
						self.value = late_value
						mount_waive_row(late_value.backup)
						response.textContent = get_label.update_code_waive_backup_now_required
							|| 'The database backup went stale while this dialog was open. Make a backup, or accept the waiver below, then press Update again.'
						response.classList.add('error')
						return
					}
				} catch (error) {
					// never block on a failed re-ask: the server still refuses correctly
					console.error('update_ontology: could not re-check backup freshness before submitting', error)
				}
			}

			const waive_backup = waive_backup_input?.checked === true
			// the TLDs + host are DATA → the `note` text slot; a waived backup is
			// restated here, at the last gate
			const accepted = await ui.confirm({
				header			: submit_label,
				note			: tlds.join(', ') + ' ← ' + host
					+ (waive_backup
						? ' — ' + (get_label.update_code_waive_backup_confirm || 'without a recent database backup')
						: ''),
				body			: confirm_text,
				accept_label	: submit_label
			})
			if (accepted!==true) {
				return
			}
			settle({ waive_backup })
			if (typeof modal.close==='function') {
				modal.close()
			}
		}

		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'normal',
			on_close	: () => settle(null),
			// same width as the code update's version modal
			callback	: (dd_modal) => {
				dd_modal.modal_content.style.width = '65rem'
			}
		})
		modal.classList.add('widget_update_ontology_modal')

		dd_request_idle_callback(() => {
			button_update.focus()
		})
	})
}//end open_confirm_modal



/**
* BUILD_CLIENT_INFO
* Admin help for the PULL side: which servers this installation may pull from
* comes from ONE config key, so the panel names it, reports how many entries it
* holds, and shows the exact `../private/.env` line to add. The `code` must be
* the `ONTOLOGY_SERVER_CODE` of the server being contacted.
*
* @param {Array} servers - value.servers (already probed server-side)
* @returns {HTMLElement} collapsed <details> (collapsed on load in every state)
*/
const build_client_info = function (servers) {

	const total = servers.length

	// Collapsed on load, always: the panel's first screen is the update itself,
	// and the summary pill already reports the state ("None configured").
	const details = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'dd_fold serving_info client_info'
	})
	const summary = ui.create_dom_element({
		element_type	: 'summary',
		parent			: details
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'ttl',
		inner_html		: (get_label.update_ontology_connect_title || 'Connect to a remote ontology server'),
		parent			: summary
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: total>0 ? 'dd_badge pill_ok' : 'dd_badge pill_warning',
		inner_html		: total>0
			? (get_label.update_ontology_connect_state_configured || '%s configured').replace('%s', String(total))
			: (get_label.update_ontology_connect_state_none || 'None configured'),
		parent			: summary
	})

	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'serving_body',
		parent			: details
	})
	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'dd_note',
		inner_html		: (get_label.update_ontology_connect_body || 'The list above is built from <code>ONTOLOGY_SERVERS</code> in <code>../private/.env</code> (one JSON array, one object per master). Add the servers you are authorized to pull from and restart the server.'),
		parent			: body
	})
	ui.create_dom_element({
		element_type	: 'pre',
		class_name		: 'env_sample',
		text_content	: 'ONTOLOGY_SERVERS=[{"name":"Dédalo Ontology server","url":"https://myserverdomain.org/dedalo/core/api/v1/json/","code":"xx-myspecialcode-xxx"}]',
		parent			: body
	})
	const fields = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'serving_checks',
		parent			: body
	})
	;[
		{ k:'name', d:(get_label.update_ontology_field_name_info || 'Free label, only shown in the list above.') },
		{ k:'url',  d:(get_label.update_ontology_field_url_info || 'The master’s JSON API endpoint, ending in <code>/dedalo/core/api/v1/json/</code>.') },
		{ k:'code', d:(get_label.update_ontology_field_code_info || 'The <code>ONTOLOGY_SERVER_CODE</code> configured on THAT server. A wrong or missing code makes it answer as unreachable.') }
	].forEach(field => {
		const row = ui.create_dom_element({ element_type:'div', class_name:'chk field', parent:fields })
		ui.create_dom_element({ element_type:'span', class_name:'mark', inner_html:'·', parent:row })
		const txt = ui.create_dom_element({ element_type:'div', class_name:'txt', parent:row })
		const head = ui.create_dom_element({ element_type:'div', class_name:'hd', parent:txt })
		ui.create_dom_element({ element_type:'code', text_content:field.k, parent:head })
		ui.create_dom_element({ element_type:'div', class_name:'desc', inner_html:field.d, parent:txt })
	})

	return details
}//end build_client_info



/**
* UPDATE_PROGRESS_SHARE
* Where a progress frame puts the bar, 0..1. The server reports facts per stage
* (core/ontology/update_progress.ts: stage, done of total); the stages take
* very different times, so each owns a fixed share of the bar.
* shortcut: fixed shares, not measured durations — weigh them by file size if a
* real install shows the bar crawling in one stage.
* Exported for its client gate.
*
* @param {Object|null|undefined} progress - frame.data.progress
* @returns {number|null} null = no usable frame yet (indeterminate)
*/
export const update_progress_share = function (progress) {

	const shares = { download:[0, 0.25], import:[0.25, 0.6], derive:[0.6, 0.95], finish:[0.95, 1] }
	const range = shares[progress?.stage]
	if (!range) {
		return null
	}
	const total	= Number(progress.total)
	const done	= Number(progress.done)
	const part	= (Number.isFinite(total) && total>0 && Number.isFinite(done))
		? Math.min(Math.max(done / total, 0), 1)
		: 0

	return range[0] + (range[1] - range[0]) * part
}//end update_progress_share



/**
* TRACK_UPDATE_JOB
* Follows the update's background job (dd_utils_api:get_process_status, via the
* shared common.js update_process_status) with a
* progress bar (the widget kit's .dd_bar) and a caption naming the stage and the
* ontology in work. Resolves the LAST frame — its `data` is the import's answer,
* or its `error` the coded refusal/failure — once the job ends or the stream
* cannot be opened (then a terminal frame carrying that error).
*
* @param {string|number} pid
* @param {string} pfile
* @param {HTMLElement} parent
* @returns {Promise<Object|null>}
*/
const track_update_job = function (pid, pfile, parent) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'update_progress',
		parent			: parent
	})
	const caption = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar_note update_progress_caption',
		text_content	: get_label.update_ontology_progress_start || 'Starting the update…',
		parent			: node
	})
	const bar = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar indeterminate',
		parent			: node
	})
	bar.setAttribute('role', 'progressbar')
	bar.setAttribute('aria-valuemin', '0')
	bar.setAttribute('aria-valuemax', '100')
	const fill = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar_fill',
		parent			: bar
	})
	ui.reveal(node)

	const stage_text = {
		download	: get_label.update_ontology_progress_download || 'Downloading',
		import		: get_label.update_ontology_progress_import || 'Importing',
		derive		: get_label.update_ontology_progress_derive || 'Processing',
		finish		: get_label.update_ontology_progress_finish || 'Finishing'
	}
	const paint = (progress) => {
		const share = update_progress_share(progress)
		if (share===null) {
			return
		}
		const percent = Math.round(share * 100)
		bar.classList.remove('indeterminate')
		fill.style.width = percent + '%'
		bar.setAttribute('aria-valuenow', String(percent))
		// the ontology in work and its place in the stage, as TEXT (remote tld)
		caption.textContent = [
			stage_text[progress.stage],
			progress.tld || null,
			progress.stage==='finish' ? null : '(' + (Number(progress.done) + 1) + '/' + progress.total + ')'
		].filter(Boolean).join(' ')
	}

	// the job's status stream, through the ONE shared tracker (no second
	// stream opener under area_maintenance): its own status nodes are kept out
	// of sight, the bar above is the operator surface
	const stream_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'update_progress_stream',
		parent			: node
	})

	return new Promise((resolve) => {
		update_process_status(
			'update_ontology_process',
			pid,
			pfile,
			stream_node,
			1000,
			(last) => {
				node.remove()
				resolve(last)
			},
			(frame) => paint(frame?.data?.progress)
		)
	})
}//end track_update_job



/**
* GET_CONTENT_DATA_EDIT
* Builds the full inner content DOM for the update_ontology widget and wires the
* two-phase submit flow.
*
* `self.value` shape (from `update_ontology.ts` getValue):
* ```
* {
*   current_ontology : { version, date, host, entity, entity_label },
*   servers          : [{ name, url, code, tld?, response_code, result? }],
*   active_ontology_tlds : string[],
*   backup           : { id:'backup_fresh', state, detail?, scope? },
*   confirm_text     : string
* }
* ```
*
* @param {Object} self - the update_ontology widget instance
* @returns {Promise<HTMLElement>}
*/
const get_content_data_edit = async function(self) {

	// value
		const value = self.value || {}
		const current_ontology		= value.current_ontology || {}
		const servers				= value.servers || []
		const active_ontology_tlds	= value.active_ontology_tlds || []
		const confirm_text			= get_label.update_ontology_confirm_text || value.confirm_text || 'Sure?'

	// content_data (own class — the wrapper's content node is otherwise classless,
	// so styles must hang off this, not a non-existent `.content_data` class)
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data update_ontology_content'
		})

	// a. danger callout — the overwrite is irreversible
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_danger overwrite_note',
			inner_html		: (get_label.update_ontology_overwrite_note || '<b>Replaces the ontologies of the selected TLDs.</b> Imports them from the master over the live ontologies and re-processes them. Local TLDs and localontology overrides are never part of an update and are kept.'),
			parent			: content_data
		})

	// b. installed ontology readout
		const installed_section = ui.create_dom_element({ element_type:'div', class_name:'section', parent:content_data })
		ui.create_dom_element({ element_type:'span', class_name:'dd_eyebrow', inner_html:(get_label.update_ontology_installed_title || 'Installed ontology'), parent:installed_section })
		installed_section.appendChild(build_readout([
			{ k:(get_label.version || 'Version'), v:current_ontology.version, mono:true },
			{ k:(get_label.source || 'Source'), v:current_ontology.host },
			{ k:(get_label.installed || 'Installed'), v:(typeof current_ontology.date==='string' ? current_ontology.date.slice(0,10) : null) },
			{ k:(get_label.entity_label || 'Entity'), v:current_ontology.entity_label || current_ontology.entity }
		]))

	// c. master server picker
	// on_server_change: THIS caller's selection callback — the only place the
	// panel-wide `ontology_server_select_change` event is published, so a
	// co-mounted CODE picker (update_code, which passes no callback) can never
	// reset this widget's TLD catalog.
		const on_server_change = (server) => {
			event_manager.publish('ontology_server_select_change', server ? (server.tld || null) : null)
		}
		const servers_section = ui.create_dom_element({ element_type:'div', class_name:'section', parent:content_data })
		ui.create_dom_element({ element_type:'span', class_name:'dd_eyebrow', inner_html:(get_label.update_ontology_master_server || 'Master server'), parent:servers_section })
		servers_section.appendChild(render_servers_list(value, 'ONTOLOGY_SERVERS', 'dedalo.update_ontology.server', on_server_change))
		servers_section.appendChild(build_client_info(servers))

	// body_response: result surface, declared before init_form so on_submit can close over it
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// d. update form. Confirmation (and the backup waiver) happen in
	// open_confirm_modal, after the master's manifest is read — not in the
	// form's native confirm()
		let catalog = null
		let submitting = false
		const single_flight = async (run) => {
			if (submitting) {
				return
			}
			submitting = true
			try {
				return await run()
			} finally {
				submitting = false
			}
		}
		if (self.caller?.init_form) {
			self.caller.init_form({
				submit_label	: (get_label.update_ontology_submit || 'Replace selected ontologies'),
				confirm_text	: false,
				body_info		: content_data,
				body_response	: body_response,
				inputs			: [{
					type		: 'text',
					name		: 'active_ontology_tlds',
					label		: (get_label.update_ontology_tlds_title || 'Ontologies to update'),
					mandatory	: true,
					// the default selection: the tracked TLDs + the shared value lists
					value		: [...new Set([...active_ontology_tlds, 'matrix_dd'])].join(',')
				}],
				on_render : (nodes) => {
					const input_nodes = nodes.input_nodes || []
					const tlds_input = input_nodes.find(el => el.name === 'active_ontology_tlds')

					// the operator's line wins over the configured default, and
					// survives a reload
					const stored = read_stored_tlds()
					if (stored!==null) {
						tlds_input.value = stored
					}
					// declared here, wired right after the catalog exists
					let sync_catalog = () => {}
					tlds_input.addEventListener('input', () => {
						tlds_input.classList.remove('empty')
						store_tlds(tlds_input.value)
						sync_catalog()
					})

					// the picked master's ontologies ABOVE the input — nothing here
					// writes the input unless the operator ticks a row
					catalog = build_tld_catalog({
						tracked		: Array.isArray(active_ontology_tlds)
							? active_ontology_tlds
							: String(active_ontology_tlds).split(','),
						installed	: value.installed_tlds || [],
						configured_by_env : value.active_ontology_tlds_configured===true,
						get_value	: () => tlds_input.value,
						set_value	: (new_value) => {
							tlds_input.value = new_value
							tlds_input.classList.remove('empty')
							store_tlds(new_value)
						},
						fetch_manifest : async (server) => {
							const api_response = await get_update_info(server)
							const result = response_data(api_response)
							return request_failed(api_response) ? api_response.error : (result || null)
						}
					})
					sync_catalog = catalog.sync
					nodes.form_container.insertBefore(catalog.node, nodes.form_container.firstChild)
					// first paint: the prefilled/remembered line ticks its rows
					catalog.sync()

					// selecting a master LISTS ITS ONTOLOGIES ONLY (it used to
					// overwrite the input, discarding the operator's edit)
					const render_handler = function(){
						catalog.set_server(servers.find(el => el.active === true) || null)
					}
					self.events_tokens.push(
						event_manager.subscribe('ontology_server_select_change', render_handler)
					)
				},
				// SINGLE-FLIGHT: a submit lasts the whole job (minutes); Enter in the
				// TLD input must not start a second one over the tracked first
				on_submit : (e, values) => single_flight(async () => {

					// parse the TLD list
						const active_ontology_tlds_value	= values[0]?.value
						const ar_active_ontology_tlds		= active_ontology_tlds_value.split(',')
							.map(el => el.trim())
							.filter(el => el.length>1)

						if (!ar_active_ontology_tlds.length) {
							alert(get_label.update_ontology_select_tld_alert || 'Select at least one ontology to update.')
							return
						}

					// the server marked active by the radio handler
						const server = servers.find(el => el.active === true )
						if( !server ){
							alert(get_label.update_ontology_select_server_alert || 'Select a master server first.')
							return
						}

					// reset the response surface
						while (body_response.firstChild) {
							body_response.removeChild(body_response.firstChild)
						}

					// Phase 1: discover available files + version info on the master
						const server_ontology_api_response = await get_update_info(server)

						const result = response_data(server_ontology_api_response)
						if(request_failed(server_ontology_api_response) || !result){
							if (request_failed(server_ontology_api_response)) {
								ui.reveal(body_response.appendChild(build_failure(server_ontology_api_response.error)))
							} else {
								ui.reveal(ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'error',
									text_content	: String(response_extension(server_ontology_api_response, 'msg') || get_label.update_ontology_unreachable_error || 'Could not reach the master server.'),
									parent			: body_response
								}))
							}
							return
						}

					// build the file list: user-selected TLDs, enriched, with matrix_dd always first
						const selected_files = build_import_files(result, ar_active_ontology_tlds)
						// nothing ticked that this master offers: refuse here (the server would
						// update nothing — never let the run look like it did something)
						if (!selected_files.length) {
							alert(get_label.update_ontology_select_tld_alert || 'Select at least one ontology to update.')
							return
						}

					// confirm in the modal (what, from where, the backup waiver)
						const decision = await open_confirm_modal(self, {
							server,
							result,
							selected_files,
							untracked		: catalog ? catalog.untracked_selected() : [],
							confirm_text
						})
						if (decision===null) {
							return
						}

					// show installed → incoming while the import runs
						ui.reveal(body_response.appendChild(build_version_change(current_ontology, result.info)))

					// Phase 2: import — submitted as a background job, followed with
					// a progress bar
						const api_response = await self.update_ontology({
							server		: server,
							files		: selected_files,
							info		: result.info,
							waive_backup: decision.waive_backup
						})
						const pid	= response_extension(api_response, 'pid')
						const pfile	= response_extension(api_response, 'pfile')
						if(request_failed(api_response) || !pid || !pfile){
							if (request_failed(api_response)) {
								ui.reveal(body_response.appendChild(build_failure(api_response.error)))
							} else {
								ui.reveal(ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'error',
									text_content	: String(response_extension(api_response, 'msg') || get_label.update_ontology_import_failed || 'The ontology import failed.'),
									parent			: body_response
								}))
							}
							return
						}
						const final_frame = await track_update_job(pid, pfile, body_response)

					// fail case. SUCCESS IS ONLY a finished job carrying the run's answer
					// (ontologyAnswer always sets run_id): while running, the job's data
					// is a PROGRESS frame, and a dropped stream, a stop or the lane
					// deadline all end on one with no coded error
						const job_error = normalize_stream_error(final_frame)
						const job_result = final_frame?.data
						const finished = final_frame?.is_running===false
							&& job_result!==null && typeof job_result==='object'
							&& typeof job_result.run_id==='string'
						if (job_error || !finished) {
							ui.reveal(job_error
								? body_response.appendChild(build_failure(job_error))
								: ui.create_dom_element({
									element_type	: 'div',
									class_name		: 'error',
									// still running for all we know (the stream dropped), or ended
									// without an answer (stopped / deadline: its lines say why)
									text_content	: final_frame?.is_running===false
										? [get_label.update_ontology_import_failed || 'The ontology import failed.', ...(Array.isArray(final_frame.errors) ? final_frame.errors : [])].join(' ')
										: (get_label.update_ontology_job_lost || 'Lost contact with the update while it was running. It may still be running: reload this panel in a few minutes to see the installed version.'),
									parent			: body_response
								}))
							return
						}

					// status line (revealed: the whole result reads down from it)
						ui.reveal(ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'ok',
							inner_html		: (get_label.update_ontology_done || 'Ontology updated.'),
							parent			: body_response
						}))

					// version compatibility warning
						const required_version = job_result.root_info?.properties?.version || null
						if (required_version && !self.supported_code_version(required_version)) {
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'warning',
								text_content	: (get_label.update_ontology_code_older || 'Your Dédalo code is older than this ontology needs (≥ %s). Update the code soon to avoid incompatibilities.').replace('%s', required_version),
								parent			: body_response
							})
						}

					// non-fatal import errors
						const errors = (Array.isArray(job_result.errors) ? job_result.errors : []).filter(Boolean)
						if (errors.length>0) {
							body_response.appendChild(
								build_details(
									(get_label.update_ontology_import_warnings || 'Import warnings (%s)').replace('%s', String(errors.length)),
									errors.join('\n'),
									{ open:true, pre_class:'warning' }
								)
							)
						}

					// collapsible import log (the per-file messages)
						if (typeof job_result.msg==='string' && job_result.msg.length>0) {
							body_response.appendChild(
								build_details((get_label.update_ontology_import_log || 'Import log'), job_result.msg, { open:true, pre_class:'log' })
							)
						}

					// collapsed raw job frame for developers
						body_response.appendChild(
							build_details(
								(get_label.update_ontology_dev_response || 'Developer response (raw JSON)'),
								JSON.stringify(final_frame, null, 2),
								{ open:false, pre_class:'dev_json' }
							)
						)

					// refresh the menu (server rebuilt its nav cache during the update)
						dd_request_idle_callback(
							() => {
								const page = self.caller.caller
								if (page) {
									const menu = page.ar_instances.find(el => el.model==='menu')
									if (menu) {
										menu.refresh({ build_autoload : true })
									}
								}
							}
						)
				})
			})
		}

	// the picker may have restored a remembered master: announce it now that the
	// form (and its TLD catalog) is listening
		publish_active_server(servers, on_server_change)

	// append the response surface last
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit



/**
* PUBLISH_ACTIVE_SERVER
* Announces the server `render_servers_list` restored from storage, AFTER the
* panel's subscribers exist. Without this the picker would show a selected
* master while the TLD catalog still said "pick a server". Routed through
* the SAME per-caller callback as a live selection — never a bare publish.
*
* @param {Array} servers - value.servers, already marked by the picker
* @param {Function} [on_change] - the caller's selection callback
*/
const publish_active_server = function (servers, on_change) {

	const active = (servers || []).find(el => el.active === true)
	if (!active) {
		return
	}
	if (typeof on_change==='function') {
		on_change(active)
	}
}//end publish_active_server



/**
* RENDER_SERVERS_LIST
* Radio picker for `value.servers`. Each row shows the server name + URL and a
* reachability pill; unreachable servers are disabled. Selecting a row publishes
* selection through the caller's `on_change` callback (update_ontology's own
* caller publishes `ontology_server_select_change` from it; update_code passes
* nothing, so picking a CODE server never touches the ontology widget) and
* marks `server.active = true` so the submit handler can find the chosen
* server.
*
* Reachability is pre-probed server-side (`update_ontology.ts` getValue →
* `checkRemoteServer`); the client only reads `response_code` + `result`.
*
* @param {Object} value - widget value; `value.servers` is the descriptor list
* @param {string} [env_key='ONTOLOGY_SERVERS'] - config key named in the empty
*   notice; `update_code` reuses this picker over CODE_SERVERS
* @param {string} [storage_key] - localStorage key remembering the chosen server
*   across navigations and reloads; one per picker (update_code passes its own)
* @param {Function} [on_change] - called with the selected server descriptor on
*   every selection (and by publish_active_server with the restored one). A
*   CALLBACK, not an event name: only the caller that passes one hears its own
*   picker, so co-mounted pickers cannot bleed into each other's widgets.
* @returns {HTMLElement} the `.server_picker` container
*/
let picker_seq = 0

export const render_servers_list = function (value, env_key='ONTOLOGY_SERVERS', storage_key='dedalo.update_ontology.server', on_change) {

	// A radio GROUP is document-wide by name, and this panel renders twice (the
	// Map view mounts its own instance beside the List one). With a shared name
	// the second picker's restore silently unchecked the first one's radio — the
	// selection looked lost after navigating back. One group per picker.
	const group_name = 'ontology_server_' + (++picker_seq)

	const servers = value.servers || []

	// the master picked last time, by URL (may be gone from the config, or now
	// unreachable — both are handled by simply not matching)
	const stored_url = read_stored_server(storage_key)

	const picker = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'server_picker'
	})

	if (!servers.length) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note empty',
			text_content	: (get_label.update_ontology_servers_empty || 'No master servers are configured (%s).').replace('%s', env_key),
			parent			: picker
		})
		return picker
	}

	const server_len = servers.length
	for (let i = 0; i < server_len; i++) {

		const current_server	= servers[i]
		// `current_server.result` is the REMOTE's decoded body (a nested probe key,
		// not our envelope): its own payload says whether it answered ready.
		const reachable			= current_server.response_code === 200 && !!response_data(current_server.result)

		// row = clickable <label> wrapping the radio, meta and pill
			const server_row = ui.create_dom_element({
				element_type	: 'label',
				class_name		: reachable ? 'server_row' : 'server_row off',
				title			: reachable
					? current_server.name
					: (current_server.msg || get_label.update_ontology_server_unreachable || 'Unreachable'),
				parent			: picker
			})

		// radio
			const input_radio = ui.create_dom_element({
				element_type	: 'input',
				type			: 'radio',
				name 			: group_name,
				value			: current_server.url,
				parent			: server_row
			})
			if (!reachable) {
				input_radio.disabled = 'disabled'
			}
			const change_handler = () => {
				servers.forEach( el => delete el.active )
				current_server.active = input_radio.checked
				picker.querySelectorAll('.server_row').forEach( el => { el.classList.remove('on') } )
				server_row.classList.add('on')
				store_server(storage_key, current_server.url)
				if (typeof on_change==='function') {
					on_change(current_server)
				}
			}
			input_radio.addEventListener('change', change_handler)
			input_radio.addEventListener('click', (e) => { e.stopPropagation() })

			// restore the remembered choice. The EVENT is not published here: the
			// picker is built before the form subscribes, so nobody would hear it —
			// the caller republishes once the panel is assembled (see
			// `publish_active_server`).
			if (reachable && stored_url!==null && current_server.url===stored_url) {
				input_radio.checked = true
				servers.forEach( el => delete el.active )
				current_server.active = true
				server_row.classList.add('on')
			}

		// meta: name + url
			const meta = ui.create_dom_element({ element_type:'span', class_name:'meta', parent:server_row })
			ui.create_dom_element({ element_type:'span', class_name:'nm', text_content:String(current_server.name ?? ''), parent:meta })
			ui.create_dom_element({ element_type:'span', class_name:'url', text_content:String(current_server.url ?? ''), parent:meta })

		// reachability pill
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: reachable ? 'dd_badge pill_ok' : 'dd_badge pill_danger',
				inner_html		: reachable
					? (get_label.update_ontology_server_reachable || 'Reachable')
					: (get_label.update_ontology_server_unreachable || 'Unreachable'),
				parent			: server_row
			})
	}


	return picker
}//end render_servers_list



// @license-end
