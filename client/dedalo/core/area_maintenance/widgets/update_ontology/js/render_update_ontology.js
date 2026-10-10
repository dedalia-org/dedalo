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
*      browser (by URL) and restored on the next render. Selecting one fires
*      `ontology_server_select_change` so the TLD input auto-fills. Below it, a
*      collapsed admin note: `build_client_info` (the ONTOLOGY_SERVERS key that
*      populates the picker). Whether THIS install can SERVE its ontology is its
*      own widget since 2026-09-28 (serve_ontology).
*   d. Update form — a TLD reference block (where the default list comes from +
*      the configured/master lists to copy from) over the TLD input, which is the
*      OPERATOR's (persisted in localStorage, never overwritten by a server
*      selection), + the destructive submit button. On
*      submit: Phase 1 `get_ontology_update_info` (discover files) → show the
*      installed→incoming version change → Phase 2 `update_ontology` (import) →
*      one status line + a collapsible import log + a collapsed raw-JSON detail.
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
*/

// imports
	import {ui} from '../../../../common/js/ui.js'
	import {dd_request_idle_callback} from '../../../../common/js/events.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {event_manager} from '../../../../common/js/event_manager.js'
	import {request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {error_text} from '../../../../common/js/render_api_error.js'



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
		class_name		: 'response_detail'
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
* GET_UPDATE_INFO
* Phase 1 of the update: ask a master for its manifest (available files + the
* version info). Called from TWO places — the reference block's "Fetch list"
* button and the submit flow — so the request shape lives in ONE place.
*
* @param {Object} server - a `value.servers` entry (url + code)
* @returns {Promise<Object>} the raw api_response (caller inspects the envelope)
*/
const get_update_info = async function (server) {

	const api_response = await data_manager.request({
		url		: server.url,
		body	: {
			dd_api			: 'dd_utils_api',
			action			: 'get_ontology_update_info',
			prevent_lock	: true,
			source			: { action : 'update_ontology' },
			options : {
				version	: page_globals.dedalo_version,
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
* different hosts never share an edit).
*/
const TLDS_STORAGE_KEY = 'dedalo.update_ontology.tlds'

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
		return (typeof stored==='string' && stored.trim().length>0) ? stored : null
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
* BUILD_TLDS_REFERENCE
* The block that sits ABOVE the TLD input: where the prefilled list comes from,
* plus the two reference lists (what this installation is configured for, and
* what the selected master actually offers).
*
* Why it exists: the input used to be OVERWRITTEN every time a master was
* selected, silently discarding the operator's edit. Now the input is the
* operator's — remembered across reloads — and the lists are reference material
* they copy from deliberately (whole list, or one TLD at a time by clicking it).
*
* @param {Object} options
* @param {string[]} options.configured   - value.active_ontology_tlds
* @param {boolean} options.configured_by_env - value.active_ontology_tlds_configured:
*   false means ACTIVE_ONTOLOGY_TLDS is unset and the list is the engine fallback
* @param {Function} options.get_value    - reads the live input value
* @param {Function} options.set_value    - writes the input value (and persists it)
* @param {Function} options.fetch_server_tlds - async (server) => string[]; the
*   master's own list, read from its manifest when the operator asks for it
* @returns {{node:HTMLElement, set_server:Function}}
*   `set_server(server)` arms the master row for the newly selected master.
*/
const build_tlds_reference = function (options) {

	const configured	= options.configured || []
	const get_value		= options.get_value
	const set_value		= options.set_value

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'tlds_reference'
	})

	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_eyebrow',
		inner_html		: (get_label.update_ontology_tlds_title || 'Ontologies to update'),
		parent			: node
	})
	// Two different answers, and an administrator must not confuse them: either
	// somebody configured this installation's TLDs, or nobody did and what is
	// shown is the engine's built-in fallback.
	const origin_html = options.configured_by_env===true
		? (get_label.update_ontology_tlds_origin_env || 'It starts from <code>ACTIVE_ONTOLOGY_TLDS</code> in <code>../private/.env</code> — the shared TLDs this installation tracks — always unioned with the core pair <code>ontology</code> / <code>ontologytype</code>. Change it there to change the default for everyone.')
		: (get_label.update_ontology_tlds_origin_fallback || '<b><code>ACTIVE_ONTOLOGY_TLDS</code> is not set in <code>../private/.env</code></b>, so it starts from the engine\u2019s built-in fallback (below), unioned with the core pair <code>ontology</code> / <code>ontologytype</code>. Domain TLDs (<code>oh</code>, <code>ich</code>, <code>tch</code>, <code>numisdata</code>, \u2026) are per-installation: set the key to make your own set the default for everyone.')

	ui.create_dom_element({
		element_type	: 'p',
		class_name		: 'dd_note',
		inner_html		: (get_label.update_ontology_tlds_note || 'The list below is yours to edit — it is remembered in this browser and is never overwritten when you pick a master.') + ' ' + origin_html,
		parent			: node
	})

	// every chip currently on screen, so the "is this TLD in the line?" state can
	// be repainted from ONE place (the input is the single source of truth: chips
	// only reflect it, and typing in the input must move them too)
	const chip_nodes = []

	/** Splits the input line into trimmed, non-empty TLDs. */
	const current_list = function () {
		return get_value().split(',').map(el => el.trim()).filter(el => el.length>0)
	}

	/** Repaints every chip's selected state from the input line. */
	const sync_chips = function () {
		const current = current_list()
		chip_nodes.forEach(entry => {
			const selected = current.indexOf(entry.tld)!==-1
			entry.node.classList.toggle('on', selected)
			entry.node.setAttribute('aria-pressed', selected ? 'true' : 'false')
			entry.node.title = (selected
				? (get_label.update_ontology_tld_remove || 'Remove “%s” from the list below')
				: (get_label.update_ontology_tld_add || 'Add “%s” to the list below')
			).replace('%s', entry.tld)
		})
	}

	/** Writes the input and repaints the chips in one step. */
	const apply_value = function (new_value) {
		set_value(new_value)
		sync_chips()
	}

	/**
	* Adds a TLD to the input if missing, removes it if already there — so a chip
	* is a toggle, not a one-way append.
	*/
	const toggle_tld = function (tld) {
		const current = current_list()
		const found = current.indexOf(tld)
		if (found===-1) {
			current.push(tld)
		} else {
			current.splice(found, 1)
		}
		apply_value(current.join(','))
	}

	/**
	* One reference row: a label, the chips, and a "Use this list" button that
	* replaces the input wholesale.
	*/
	const build_row = function (label, tlds, empty_text, with_use_list) {

		const row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'tlds_row',
			parent			: node
		})
		const head = ui.create_dom_element({ element_type:'div', class_name:'hd', parent:row })
		const label_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'lbl',
			text_content	: label,
			parent			: head
		})
		// "Use this list" REPLACES the whole input, so it only exists where that is
		// a sane action: a master publishes its ENTIRE manifest (200+ TLDs, every
		// language pack included) and importing all of it is never what an operator
		// means — there, chips are added one by one.
		const use_button = with_use_list===true
			? ui.create_dom_element({
				element_type	: 'button',
				type			: 'button',
				class_name		: 'light use_list',
				inner_html		: (get_label.update_ontology_tlds_use_list || 'Use this list'),
				parent			: head
			})
			: null
		const chips = ui.create_dom_element({ element_type:'div', class_name:'chips', parent:row })

		const paint = function (list, empty_override) {
			const ar_tlds = (list || []).filter(Boolean)
			while (chips.firstChild) {
				chips.removeChild(chips.firstChild)
			}
			// drop this row's stale entries from the shared registry
			for (let i = chip_nodes.length-1; i >= 0; i--) {
				if (chip_nodes[i].row===chips) {
					chip_nodes.splice(i, 1)
				}
			}
			if (!ar_tlds.length) {
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'empty',
					text_content	: empty_override || empty_text,
					parent			: chips
				})
				if (use_button) {
					use_button.disabled = true
				}
				return
			}
			if (use_button) {
				use_button.disabled = false
				use_button.onclick = () => apply_value(ar_tlds.join(','))
			}
			ar_tlds.forEach(tld => {
				const chip = ui.create_dom_element({
					element_type	: 'button',
					type			: 'button',
					class_name		: 'tld_chip',
					text_content	: String(tld),
					parent			: chips
				})
				chip.addEventListener('click', () => toggle_tld(String(tld)))
				chip_nodes.push({ tld : String(tld), node : chip, row : chips })
			})
			sync_chips()
		}
		paint(tlds)

		return {
			paint		: paint,
			head		: head,
			set_label	: (text) => { label_node.textContent = text }
		}
	}//end build_row

	// the configured row never changes after render; the master row is filled on
	// demand — a master publishes its list only in its manifest, which costs a
	// request, so it is fetched when the operator asks for it, not on selection
	build_row(
		options.configured_by_env===true
			? (get_label.update_ontology_tlds_row_configured || 'Configured in this installation')
			: (get_label.update_ontology_tlds_row_fallback || 'Engine fallback (not configured)'),
		configured,
		(get_label.update_ontology_tlds_empty_none || 'none'),
		true
	)
	const server_row = build_row(
		(get_label.update_ontology_tlds_row_master || 'Offered by the selected master'),
		[],
		(get_label.update_ontology_tlds_empty_select_master || 'select a master, then fetch its list'),
		false
	)

	const fetch_button = ui.create_dom_element({
		element_type	: 'button',
		type			: 'button',
		class_name		: 'light fetch_list',
		inner_html		: (get_label.update_ontology_tlds_fetch_list || 'Fetch list'),
		parent			: server_row.head
	})
	fetch_button.disabled = true

	let selected_server = null

	fetch_button.addEventListener('click', async () => {
		if (!selected_server) {
			return
		}
		fetch_button.disabled = true
		fetch_button.classList.add('button_spinner')
		try {
			const tlds = await options.fetch_server_tlds(selected_server)
			server_row.paint(
				tlds || [],
				(get_label.update_ontology_tlds_empty_master_none || 'the master returned no list — check its access code')
			)
			server_row.set_label(
				(get_label.update_ontology_tlds_row_master_count || 'Offered by %s (%s)')
					.replace('%s', selected_server.name)
					.replace('%s', String((tlds || []).length))
			)
		} finally {
			fetch_button.classList.remove('button_spinner')
			fetch_button.disabled = false
		}
	})

	return {
		node			: node,
		// the input is editable by hand too: the panel calls this on every
		// keystroke so the chips never lie about what is in the line
		sync			: sync_chips,
		set_server		: (server) => {
			selected_server = server || null
			fetch_button.disabled = !selected_server
			server_row.paint([])
			server_row.set_label(selected_server
				? (get_label.update_ontology_tlds_row_master_named || 'Offered by %s').replace('%s', selected_server.name)
				: (get_label.update_ontology_tlds_row_master || 'Offered by the selected master'))
		}
	}
}//end build_tlds_reference



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
		class_name		: 'serving_info client_info'
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
			inner_html		: (get_label.update_ontology_overwrite_note || '<b>Replaces the ontologies of the selected TLDs.</b> Imports them from the master over the live ontologies and re-processes them. Custom TLDs and localontology overrides are not part of them and are kept — unless you add <em>localontology</em> to the list.'),
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
	// reset this widget's reference row.
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

	// d. update form
		if (self.caller?.init_form) {
			self.caller.init_form({
				submit_label	: (get_label.update_ontology_submit || 'Replace selected ontologies'),
				confirm_text	: confirm_text,
				body_info		: content_data,
				body_response	: body_response,
				inputs			: [{
					type		: 'text',
					name		: 'active_ontology_tlds',
					label		: (get_label.update_ontology_tlds_title || 'Ontologies to update'),
					mandatory	: true,
					value		: active_ontology_tlds
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
					// declared here, wired right after the reference block exists
					let sync_reference = () => {}
					tlds_input.addEventListener('input', () => {
						tlds_input.classList.remove('empty')
						store_tlds(tlds_input.value)
						sync_reference()
					})

					// reference lists ABOVE the input — nothing here writes the
					// input unless the operator clicks
					const reference = build_tlds_reference({
						configured	: Array.isArray(active_ontology_tlds)
							? active_ontology_tlds
							: String(active_ontology_tlds).split(','),
						configured_by_env : value.active_ontology_tlds_configured===true,
						get_value	: () => tlds_input.value,
						set_value	: (new_value) => {
							tlds_input.value = new_value
							tlds_input.classList.remove('empty')
							store_tlds(new_value)
						},
						fetch_server_tlds : async (server) => {
							const api_response = await get_update_info(server)
							const result = response_data(api_response)
							if (request_failed(api_response) || !result) {
								return []
							}
							// the manifest names one file per TLD
							return [...new Set(
								(result.files || []).map(el => el.tld).filter(Boolean)
							)]
						}
					})
					sync_reference = reference.sync
					nodes.form_container.insertBefore(reference.node, nodes.form_container.firstChild)
					// first paint: the prefilled/remembered line lights its chips
					reference.sync()

					// selecting a master ARMS THE REFERENCE ROW ONLY (it used to
					// overwrite the input, discarding the operator's edit)
					const render_handler = function(){
						reference.set_server(servers.find(el => el.active === true) || null)
					}
					self.events_tokens.push(
						event_manager.subscribe('ontology_server_select_change', render_handler)
					)
				},
				on_submit : async (e, values) => {

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

					// show installed → incoming before the import completes
						ui.reveal(body_response.appendChild(build_version_change(current_ontology, result.info)))

					// build the file list: user-selected TLDs, enriched, with matrix_dd always first
						const files_filtered = result.files.filter( el => ar_active_ontology_tlds.find(item => item === el.tld) )
						files_filtered.forEach(file_item => {
							const found = result.info.active_ontologies.find(el => el.tld===file_item.tld)
							if (found) {
								file_item.typology_id	= found.typology_id
								file_item.name_data		= found.name_data
								// declared dependencies ({tld, main, mandatory} objects): forwarded ONLY
								// when the master declares them (absent = not declared) — the import
								// records them on the registry row (hierarchy60) so this server re-serves
								// them (WC-2026-10-10-ontology-dependencies-hierarchy60)
								if (found.dependencies !== undefined) {
									file_item.dependencies = found.dependencies
								}
							}
						})
						const selected_files = []
						const matrix_dd = result.files.find( el => el.tld==='matrix_dd' )
						if(matrix_dd){
							selected_files.push(matrix_dd)
						}
						selected_files.push(...files_filtered)

					// Phase 2: import
						const api_response = await self.update_ontology({
							server	: server,
							files	: selected_files,
							info	: result.info
						})

					// fail case
						if(request_failed(api_response) || !response_data(api_response)){
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

					// status line (revealed: the whole result reads down from it)
						ui.reveal(ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'ok',
							inner_html		: (get_label.update_ontology_done || 'Ontology updated.'),
							parent			: body_response
						}))

					// version compatibility warning
						const required_version = api_response.root_info?.properties?.version || null
						if (required_version && !self.supported_code_version(required_version)) {
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'warning',
								text_content	: (get_label.update_ontology_code_older || 'Your Dédalo code is older than this ontology needs (≥ %s). Update the code soon to avoid incompatibilities.').replace('%s', required_version),
								parent			: body_response
							})
						}

					// non-fatal import errors
						const errors = (response_extension(api_response, 'errors') || []).filter(Boolean)
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
						const import_log = response_extension(api_response, 'msg')
						if (import_log) {
							body_response.appendChild(
								build_details((get_label.update_ontology_import_log || 'Import log'), import_log, { open:true, pre_class:'log' })
							)
						}

					// collapsed raw response for developers
						if (api_response.debug && api_response.debug.rqo_string) {
							delete api_response.debug.rqo_string
						}
						body_response.appendChild(
							build_details(
								(get_label.update_ontology_dev_response || 'Developer response (raw JSON)'),
								JSON.stringify(api_response, null, 2),
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
				}
			})
		}

	// the picker may have restored a remembered master: announce it now that the
	// form (and its reference row) is listening
		publish_active_server(servers, on_server_change)

	// append the response surface last
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit



/**
* PUBLISH_ACTIVE_SERVER
* Announces the server `render_servers_list` restored from storage, AFTER the
* panel's subscribers exist. Without this the picker would show a selected
* master while the reference row still said "select a master". Routed through
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
