// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* UPDATE_ONTOLOGY MODULE
*
* Client-side controller for the Dédalo Ontology-update maintenance widget.
* It coordinates a two-phase flow:
*
*   1. Fetch remote-server metadata (`get_ontology_update_info`) to discover
*      which compressed snapshot files are available and which active TLD
*      entries need updating.
*   2. Submit the selected file list to the local server (`update_ontology`
*      action on `dd_area_maintenance_api`) which downloads, imports, and
*      reindexes the ontology tables and purges the ontology-derived caches.
*      (v7 has no generated JS lang files — labels are DB-derived.)
*
* Additionally the module exposes:
*   - `supported_code_version` — version-range guard used after import to
*     warn operators when the installed Dédalo code predates the newly
*     loaded ontology.
*   - Rendering is entirely delegated to `render_update_ontology.prototype.list`
*     (assigned as both `edit` and `list` render modes) so that this file
*     stays focused on data transport.
*
* Lifecycle (inherited from widget_common):
*   init → build → render (→ edit / list) → destroy
*
* Server API entry-point: `dd_area_maintenance_api` action `widget_request`
* with `source.model = 'update_ontology'`.
*
* @module update_ontology
*/
// imports
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {widget_common} from '../../../../widgets/widget_common/js/widget_common.js'
	import {area_maintenance} from '../../../../area_maintenance/js/area_maintenance.js'
	import {render_update_ontology} from './render_update_ontology.js'
	import {code_satisfies, data_version_of} from '../../../../common/js/release_identity.js'



/**
* UPDATE_ONTOLOGY
* Constructor for the update_ontology widget instance.
*
* All lifecycle properties are declared here (not in a class body) following
* Dédalo's prototype-assignment pattern.  The `init` / `build` / `render` /
* `destroy` methods are wired in the prototype block below.
*
* Instance properties:
* @property {string}  id            - Widget identifier string (set by init).
* @property {string}  section_tipo  - Ontology section tipo (e.g. 'dd0').
* @property {string}  section_id    - Record section_id within section_tipo.
* @property {string}  lang          - Active interface language code.
* @property {string}  mode          - Render mode: 'edit' | 'list'.
* @property {*}       value         - Hydrated widget value object fetched from
*                                     `get_value`; shape defined by the server-side
*                                     `update_ontology.ts` getValue:
*                                     { servers, current_ontology, active_ontology_tlds,
*                                       body, confirm_text }.
* @property {HTMLElement} node      - Root DOM node of this widget after render.
* @property {Array}   events_tokens - Subscriptions registered via event_manager;
*                                     drained on destroy to avoid listener leaks.
* @property {Array}   ar_instances  - Child widget/component instances managed
*                                     by this widget.
* @property {*}       status        - Runtime lifecycle status (set by framework).
*/
export const update_ontology = function() {

	this.id

	this.section_tipo
	this.section_id
	this.lang
	this.mode

	this.value

	this.node

	this.events_tokens	= []
	this.ar_instances	= []

	this.status
}//end update_ontology



/**
* COMMON FUNCTIONS
* extend functions from common
*/
// prototypes assign
	// lifecycle
	update_ontology.prototype.init		= widget_common.prototype.init
	update_ontology.prototype.build		= widget_common.prototype.build
	update_ontology.prototype.render	= widget_common.prototype.render
	update_ontology.prototype.destroy	= widget_common.prototype.destroy
	// get_value fetches widget state from dd_area_maintenance_api::get_widget_value
	// using `source.model = this.id` and returns api_response.result.
	update_ontology.prototype.get_value	= area_maintenance.prototype.get_value
	// render
	// Both edit and list modes delegate to the same render_update_ontology.list
	// implementation — the widget has no separate edit layout.
	update_ontology.prototype.edit		= render_update_ontology.prototype.list
	update_ontology.prototype.list		= render_update_ontology.prototype.list



/**
* SUPPORTED_CODE_VERSION
* Compare given required_version with current Dédalo version
* (from page_globals environment value)
* to determine whether it is less than, equal to or greater than current.
* If is greater than current installed returns false, else true
* This required_version value comes from Ontology root term (dd1) properties
*
* Version strings use dot-separated integers, e.g. '6.2.5'.  The comparison
* is numeric per segment so '6.10.0' > '6.9.0' as expected.
*
* Called after a successful `update_ontology` API response to check whether
* the freshly imported ontology requires a newer Dédalo code version than
* the one currently running.
*
* @param {string} required_version - Minimum code version string required by
*   the newly loaded ontology, e.g. '6.2.5'.  Comes from
*   `api_response.root_info.properties.version`.
* @returns {boolean} `true` when the installed code version satisfies the
*   requirement (installed >= required); `false` when the code is too old and
*   the operator must upgrade before the new ontology can be used safely.
*/
update_ontology.prototype.supported_code_version = (required_version) => {

	// The running code's DATA triple against the requirement — the same basis the
	// server compares (parseVersionString of the data triple). An untagged build's
	// identity ('7.0.1-dev') has no data triple of its own, so the served
	// dedalo_data_version is read first; the identity is derived only as fallback.
	// Never a dot-split of the identity ('7.0.0-beta.6' → NaN).
	const code_data_version = page_globals.dedalo_data_version
		|| data_version_of(page_globals.dedalo_version)
	return code_satisfies(required_version, code_data_version)
}//end supported_code_version



/**
* UPDATE_ONTOLOGY
* Execs the update_ontology action on server using the Working API dd_area_maintenance_api
*
* Dispatches to `dd_area_maintenance_api::widget_request` with
* `source.model = 'update_ontology'` and `source.action = 'update_ontology'`.
* On the server the widget's `update_ontology` api action handles it
* (src/core/area_maintenance/widgets/update_ontology.ts → the staged import in
* src/core/ontology/ontology_update.ts).
*
* The server answers AT ONCE: the import runs as a background job (like the
* code update) whose `{pid, pfile}` handle the panel follows through
* dd_utils_api:get_process_status — progress frames while it runs, the import's
* answer on the final frame (render_update_ontology.js track_update_job).
*
* `retries: 1` means exactly one attempt — retrying an ontology import
* automatically could leave tables in a partially-imported state.
*
* @param {Object} options - Import parameters forwarded verbatim to the server:
*   @param {Object}   options.server - Target server descriptor chosen by the
*     operator in the servers list; shape: `{ name, url, code, active }`.
*   @param {Array}    options.files  - Filtered list of file descriptors to
*     import, each: `{ section_tipo, tld, url, typology_id?, name_data?,
*     dependencies? }` (`dependencies` — `{tld, main, mandatory}` objects —
*     only when the master declares them).
*     Always includes `matrix_dd` first (shared private-list table).
*   @param {Object}   options.info   - Remote ontology metadata returned by
*     the prior `get_ontology_update_info` call; forwarded so the server can
*     record provenance.
* @returns {Promise<Object>} Resolves to the envelope v2 response
*   (ERRORS_SPEC §3): `{ ok: true, request_id, data: true, pid, pfile }` (the
*   job handle; `pid`/`pfile` are EXTENSION keys — read them with
*   `response_extension`), or `{ ok: false, request_id, error: {code, …} }` when
*   the job could not be submitted (test it with `request_failed`). The job's
*   RESULT, on its final frame's `data`: `{ msg, errors?, run_id, root_info,
*   census? }` (`root_info.properties.version` feeds `supported_code_version`);
*   a refused / failed run ends with a coded `error` instead.
*/
update_ontology.prototype.update_ontology = async (options) => {

	const api_response = await data_manager.request({
		credentials : 'same-origin',
		use_worker	: true,
		body		: {
			dd_api	: 'dd_area_maintenance_api',
			action	: 'widget_request',
			prevent_lock	: true,
			source	: {
				type	: 'widget',
				model	: 'update_ontology',
				action	: 'update_ontology'
			},
			options : options
		},
		retries : 1 // one try only: the submit is not idempotent
	})
	if(SHOW_DEBUG===true) {
		console.log('))) update_ontology api_response:', api_response);
	}


	return api_response
}//end update_ontology



// @license-end
