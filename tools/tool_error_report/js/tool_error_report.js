// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals */
/*eslint no-undef: "error"*/



/**
* TOOL_ERROR_REPORT
*
* Administrators-only tool to report a problem to the Dédalo maintainers the
* moment it happens. It auto-collects:
*   - the current page context (section_tipo / section_id from the caller,
*     the page path with only navigation params, user agent);
*   - the page-wide JavaScript error buffer `window.dedalo_js_errors`
*     (installed at boot by core/common/js/error_capture.js);
*   - an informational snapshot of a FEW page globals (allowlist-constructed —
*     NEVER a spread of page_globals: no csrf_token, no username, no server
*     internals; the server stamps real identity itself).
* The admin adds a free-text description and submits; the tool's server half
* (server/index.ts, action 'send_report') stamps identity, stores the report on
* this installation and emails it when configured. Nothing is transmitted until the admin
* explicitly clicks send — the buffer alone never leaves the browser.
*
* This tool renders no components: build() overrides the ddo_map loader with
* a no-op, so the lifecycle stays init → build → render over a plain form.
*/



// import
	import {tool_common, wire_tool} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_error_report} from './render_tool_error_report.js'



/**
* TOOL_ERROR_REPORT
* Tool constructor. Declares every instance property used by this tool.
*/
export const tool_error_report = function () {

	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null
	this.events_tokens	= null
	this.status			= null
	this.type			= null
	this.caller			= null
	this.lang			= null
	// optional admin-attached screenshot as a compressed data URL (set by the
	// render layer's capture UI); null until the admin attaches one.
	this.screenshot		= null
}//end tool_error_report



// standard prototype wiring: render/destroy/refresh from tool_common,
// edit from render_tool_error_report
wire_tool(tool_error_report, render_tool_error_report)

// server round-trips: wire_tool does NOT stamp tool_request — take it from
// the tool_common prototype explicitly (it adds source/create_source + the
// dd_tools_api envelope around the action).
tool_error_report.prototype.tool_request = tool_common.prototype.tool_request



/**
* INIT
* Generic tool init only — this tool has no extra instance vars beyond lang.
*
* This tool is caller-OPTIONAL: it is launched globally from the top menu bar
* (accessible on every page — list, thesaurus, area, edit) and reads its
* context from the page URL + the global JS-error buffer, not from a caller
* instance. tool_common.init sets a spurious `Empty caller !` error when opened
* caller-less; clear it so the report form renders instead of the error view.
*
* @param {Object} options - forwarded from open_tool
* @returns {Promise<boolean>}
*/
tool_error_report.prototype.init = async function(options) {

	const self = this

	const common_init = await tool_common.prototype.init.call(this, options);

	try {
		self.lang = options.lang
		// caller-less is a valid, expected state for this tool
		if (!self.caller && self.error) {
			self.error = null
		}
	} catch (error) {
		self.error = error
		console.error(error)
	}

	return common_init
}//end init



/**
* ON_CLOSE_ACTIONS
* Custom modal-close teardown. Defining this makes view_modal SKIP its default
* cleanup (caller.refresh + ui.component.activate on the caller), which this
* tool must avoid: it is launched from a synthetic caller (the top-bar / global
* launcher), not a live component, so the default re-activate would fail. We
* just destroy the tool instance.
* @param {string} mode - 'modal' (unused)
* @returns {void}
*/
tool_error_report.prototype.on_close_actions = function() {

	const self = this

	try {
		if (typeof self.destroy==='function') {
			self.destroy(true, true, true)
		}
	} catch (error) {
		console.error(error)
	}
}//end on_close_actions



/**
* BUILD
* Generic build with a no-op ddo_map loader: the report form uses no
* component instances, so nothing must be resolved or fetched.
* @param {boolean} [autoload=false]
* @returns {Promise<boolean>}
*/
tool_error_report.prototype.build = async function(autoload=false) {

	const self = this

	const common_build = await tool_common.prototype.build.call(this, autoload, {
		load_ddo_map : async function() {
			self.ar_instances = []
			return true
		}
	});

	return common_build
}//end build



/**
* COLLECT_REPORT_DATA
* Assemble the auto-collected part of the report payload.
*
* SECURITY (EG-1, allowlist-constructed): every field below is picked one by
* one. Do NOT spread page_globals or add fields — csrf_token, username, db
* name and engine versions must never leave the browser through this tool;
* the server stamps trusted identity itself.
*
* @returns {Object} the client-observable submission fields (no description)
*/
tool_error_report.prototype.collect_report_data = function() {

	const self = this

	// page path + NAVIGATION params only (EG-6: never the raw query string —
	// stray params could carry tokens; the fragment is dropped entirely).
		const nav_params	= ['tipo','section_id','id','mode','lang','t','m']
		const search		= new URLSearchParams(window.location.search)
		const kept			= new URLSearchParams()
		for (const name of nav_params) {
			if (search.has(name)) {
				kept.set(name, search.get(name))
			}
		}
		const query		= kept.toString()
		const page_url	= (window.location.pathname + (query ? '?' + query : '')).slice(0, 2048)

	// section context. Prefer the caller instance (rich, section-page opens);
	// fall back to the page URL tipo/section_id — the global menu-bar launcher
	// opens caller-less from ANY page (list, thesaurus, area, edit).
		const caller			= self.caller || {}
		const url_tipo			= search.get('tipo') || search.get('t') || null
		const url_section_id	= search.get('section_id') || null
		const raw_section_tipo	= caller.section_tipo || caller.tipo || url_tipo
		// section_tipo must satisfy the server's identifier chokepoint
		// (^[a-z]+[0-9]+$) or the strict schema rejects the whole payload; drop
		// it otherwise (the tipo is still visible inside page_url).
		const section_tipo		= (typeof raw_section_tipo==='string' && /^[a-z]+[0-9]+$/.test(raw_section_tipo))
			? raw_section_tipo
			: null
		const raw_section_id	= (caller.section_id!==null && caller.section_id!==undefined)
			? caller.section_id
			: url_section_id
		const section_id		= (raw_section_id!==null && raw_section_id!==undefined && String(raw_section_id).length>0)
			? String(raw_section_id).slice(0, 64)
			: null

	// captured JS errors. Copy field-by-field so foreign objects pushed onto
	// the buffer by other code can never smuggle extra keys past the server's
	// strict schema.
		const buffer	= Array.isArray(window.dedalo_js_errors)
			? window.dedalo_js_errors.slice(-50)
			: []
		const js_errors	= buffer.map(el => ({
			type	: (el.type==='unhandledrejection' || el.type==='console') ? el.type : 'error',
			msg		: typeof el.msg==='string' ? el.msg.slice(0, 2000) : null,
			source	: typeof el.source==='string' ? el.source.slice(0, 1024) : null,
			line	: typeof el.line==='number' ? el.line : null,
			col		: typeof el.col==='number' ? el.col : null,
			stack	: typeof el.stack==='string' ? el.stack.slice(0, 6000) : null,
			time	: typeof el.time==='string' ? el.time.slice(0, 40) : null,
			count	: typeof el.count==='number' && el.count > 0 ? Math.min(el.count, 1000000) : 1
		}))

	// informational snapshot (server re-asserts identity; this only helps
	// spot client/server mismatches while triaging).
		const client_globals = {
			user_id				: typeof page_globals.user_id==='number' ? page_globals.user_id : null,
			dedalo_version		: typeof page_globals.dedalo_version==='string' ? page_globals.dedalo_version : null,
			application_lang	: typeof page_globals.dedalo_application_lang==='string' ? page_globals.dedalo_application_lang : null,
			data_lang			: typeof page_globals.dedalo_data_lang==='string' ? page_globals.dedalo_data_lang : null
		}

	// optional screenshot: a compressed image/jpeg data URL the admin attached
	// via the capture UI. Only a well-formed image data URL is forwarded; any
	// other value is dropped (the server's strict schema would reject it anyway).
		const screenshot = (typeof self.screenshot==='string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(self.screenshot))
			? self.screenshot
			: null

	return {
		page_url		: page_url,
		section_tipo	: section_tipo,
		section_id		: section_id,
		user_agent		: typeof navigator!=='undefined' ? String(navigator.userAgent).slice(0, 512) : null,
		js_errors		: js_errors,
		client_globals	: client_globals,
		screenshot		: screenshot
	}
}//end collect_report_data



/**
* SEND_REPORT
* Submit the report to this installation's server (action 'send_report'),
* which stamps identity, stores it locally and emails it when configured.
* @param {string} description - the admin's free-text problem description
* @returns {Promise<Object>} API response envelope {result, msg, errors}
*/
tool_error_report.prototype.send_report = async function(description) {

	const self = this

	const options		= self.collect_report_data()
	options.description	= String(description).slice(0, 8000)

	const response = await self.tool_request({
		action	: 'send_report',
		options	: options
	})

	return response
}//end send_report



// @license-end
