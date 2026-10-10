// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* EXPORT_HIERARCHY
* Area-maintenance widget that exports section hierarchies to compressed files
* and synchronises thesaurus active-status flags for those hierarchies.
*
* This widget is rendered inside the system-administrator maintenance area
* (area_maintenance) and provides three long-running administrative operations:
*
*   1. Export hierarchies — fires `exec_export_hierarchy` which triggers the
*      server to produce `.copy.gz` files in the engine's own hierarchy import
*      directory (`install/import/hierarchy/`).  The caller
*      supplies an explicit comma-separated list of section tipos of ACTIVE
*      hierarchies (e.g. `"es1,fr1"`); the core `lg` is never exported.
*
*   2. Export hierarchy.json — fires `exec_export_hierarchy_json`, which writes
*      the thesaurus manifest the installer reads (every active hierarchy +
*      the sha256 of the data files present in that directory).
*
*   3. Sync hierarchy active-status — fires `sync_hierarchy_active_status` to
*      reconcile the `Active` flag stored in hierarchy records against the
*      corresponding `Active in thesaurus` flag.
*
* All API calls route through `dd_area_maintenance_api::widget_request` with
* a one-hour timeout and no retry on failure (retries=1 means a single attempt).
*
* Lifecycle follows the standard Dédalo widget pattern:
*   init() → build() → render() → destroy()
*
* Widget value (loaded by `get_value` / `area_maintenance.prototype.get_value`):
*   {
*     export_hierarchy_path : string|null  // absolute server output directory
*                                          // (a fixed server-side constant)
*   }
*
* Server peer:  core/area_maintenance/widgets/export_hierarchy/class.export_hierarchy.php
* API handler:  core/api/v1/common/class.dd_area_maintenance_api.php
* DOM builder:  core/area_maintenance/widgets/export_hierarchy/js/render_export_hierarchy.js
*
* Main exports: `export_hierarchy` (constructor).
*/



// imports
	import {widget_common} from '../../../../widgets/widget_common/js/widget_common.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {area_maintenance} from '../../../../area_maintenance/js/area_maintenance.js'
	import {render_export_hierarchy} from './render_export_hierarchy.js'



/**
* EXPORT_HIERARCHY
* Constructor for the export_hierarchy widget instance.
*
* Property declarations are intentionally bare (undefined) here; they are
* populated by `widget_common.prototype.init` (identity fields) and by
* `build` / `get_value` (data fields).  Callers should never access properties
* before `init` and `build` have resolved.
*
* @property {string}       id            - Unique instance identifier set by init.
* @property {string}       section_tipo  - Ontology tipo of the owning section (unused at render; kept for lifecycle parity).
* @property {string}       section_id    - Section record id (unused at render; kept for lifecycle parity).
* @property {string}       lang          - Active UI language code.
* @property {string}       mode          - Render mode: 'edit' or 'list'.
* @property {Object}       value         - Widget payload loaded by get_value.
*   @property {string|null} value.export_hierarchy_path - Absolute server path where
*     hierarchy export files are written (a fixed server-side constant), or null if
*     the panel value failed to load.  The DOM builder uses this to show/hide the
*     export form.
* @property {HTMLElement}  node          - Root DOM node injected into the page after render.
* @property {Array}        events_tokens - Subscriptions accumulated during lifecycle; cleared by destroy.
* @property {Array}        ar_instances  - Child widget/component instances; cleared by destroy.
* @property {string}       status        - Lifecycle status string ('building' | 'built' | 'destroyed').
*/
export const export_hierarchy = function() {

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
}//end export_hierarchy



/**
* COMMON FUNCTIONS
* Prototype assignments that wire the standard Dédalo widget lifecycle and render
* methods into export_hierarchy, keeping each responsibility in a single canonical
* location.
*
* Lifecycle (from widget_common):
*   init    — resolves identity fields from options; called before build.
*   build   — overridden below; base is here only as the default fallback.
*   render  — dispatches to this.edit() or this.list() based on this.mode.
*   destroy — unsubscribes events_tokens; removes DOM node.
*
* Data loading (from area_maintenance):
*   get_value — fires dd_area_maintenance_api::get_widget_value and stores
*               the resolved payload in this.value.
*
* Render (from render_export_hierarchy):
*   edit / list — both alias render_export_hierarchy.prototype.list, which
*                 builds the two-section DOM (export form + sync form).
*/
// prototypes assign
	// lifecycle
	export_hierarchy.prototype.init			= widget_common.prototype.init
	export_hierarchy.prototype.build		= widget_common.prototype.build
	export_hierarchy.prototype.render		= widget_common.prototype.render
	export_hierarchy.prototype.destroy		= widget_common.prototype.destroy
	export_hierarchy.prototype.get_value	= area_maintenance.prototype.get_value
	// render
	export_hierarchy.prototype.edit			= render_export_hierarchy.prototype.list
	export_hierarchy.prototype.list			= render_export_hierarchy.prototype.list



/**
* BUILD
* Custom build that overrides widget_common.prototype.build.
*
* Delegates to `widget_common.prototype.build` for the standard autoload path
* (identity fields + optional value pre-fetch).  For this widget, the actual
* data (this.value) is loaded lazily on panel-open via the area_maintenance
* unified widget load() mechanism — see render_area_maintenance — so no extra
* data fetching is needed here beyond what widget_common.prototype.build already
* handles.
*
* Errors thrown by the base build are caught so that a failed data fetch does
* not crash the whole maintenance area; the error is preserved on `self.error`
* and logged to the console.
*
* @param {boolean} [autoload=false] - When true, widget_common.prototype.build
*   will attempt to pre-load the widget value via get_value before the panel
*   is opened.
* @returns {Promise<boolean>} Resolves to the return value of
*   widget_common.prototype.build (true on success).
*/
export_hierarchy.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
	// THE GUARD THIS FILE'S JSDoc PROMISES (P2-25 / DEAD-03).
	//
	// The awaited base build sat OUTSIDE the try, leaving an EMPTY try and an
	// UNREACHABLE catch — biome names it correctness/noUnreachable — while the
	// comment above says the block "guards against unexpected exceptions thrown
	// by the base build and stores any error on `self.error`". It guarded
	// nothing: a throw took down the maintenance dashboard's build instead of
	// surfacing an error state on this widget.
	let common_build = false
	try {

		// data now loads on open via the unified widget load() (see render_area_maintenance)

		common_build = await widget_common.prototype.build.call(this, autoload);
	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* EXEC_EXPORT_HIERARCHY
* Fires the server-side hierarchy export for one or more section tipos.
*
* Calls `dd_area_maintenance_api::widget_request` with action `export_hierarchy`.
* The server iterates over the requested section tipos, serialises each
* hierarchy tree, compresses it to a `.copy.gz` file, and writes it into the
* engine's hierarchy import directory (`install/import/hierarchy/`), from where
* the same files can be re-imported by the "Add hierarchy" panel.
*
* The request is dispatched through a Web Worker (`use_worker: true`) because
* the export can take several minutes for large ontologies; `prevent_lock: true`
* keeps the PHP session unlocked so other browser tabs remain responsive.
*
* (!) This method is defined as an arrow function assigned to the prototype.
*     Arrow functions do not bind `this`, so `self` inside the body refers to
*     the enclosing module scope, not the widget instance.  The method therefore
*     cannot read instance properties (e.g. this.value) — it only uses the
*     section_tipo argument.  This is intentional: the operation is stateless.
*
* @param {string} section_tipo - Comma-separated section tipo codes to export,
*   e.g. `"es1"` or `"es1,fr1"`. An explicit list ONLY (2026-10-10): each tipo
*   must be the thesaurus or model section of an ACTIVE hierarchy; the core
*   `lg` is refused (its terms ship in the seed). Each refusal is one line of
*   the response's `errors`.
* @returns {Promise<Object>} Resolves to the raw API response object:
*   {
*     result   : boolean,    // true on success
*     errors   : Array,      // non-empty on partial or full failure
*     msg      : string,     // human-readable summary
*     ...      : *           // additional fields from the server handler
*   }
*/
export_hierarchy.prototype.exec_export_hierarchy = async (section_tipo) => {

	// get value from API
	const api_response = await data_manager.request({
		use_worker	: true,
		body		: {
			dd_api			: 'dd_area_maintenance_api',
			action			: 'widget_request',
			prevent_lock	: true,
			source			: {
				type	: 'widget',
				model	: 'export_hierarchy',
				action	: 'export_hierarchy'
			},
			options : {
				section_tipo : section_tipo // string like 'es1,fr1'
			}
		},
		retries : 1, // one try only
		timeout : 3600 * 1000 // 1 hour waiting response
	})
	if(SHOW_DEBUG===true) {
		console.log('))) exec_export_hierarchy export_hierarchy api_response:', api_response);
	}


	return api_response
}//end exec_export_hierarchy



/**
* EXEC_EXPORT_HIERARCHY_JSON
* Fires the server-side `export_hierarchy_json` action: writes
* `hierarchy.json` in `install/import/hierarchy/` — every ACTIVE hierarchy with its
* metadata, declared dependencies and the sha256 of the data files present in
* that directory NOW (WC-2026-10-10-hierarchy-json-manifest). Export the data
* files first: a dump written later is not covered by the manifest's checksums.
*
* Same transport as exec_export_hierarchy (worker, unlocked session, one try).
*
* @returns {Promise<Object>} Resolves to the raw API response object:
*   {
*     result             : boolean,  // true when the file was written
*     errors             : Array,    // census lines (rows skipped / degraded)
*     msg                : string,
*     files              : Array,    // [{section_tipo,table,file_name,bytes,url}]
*     active_hierarchies : number,
*     data_files         : number,
*     empty_hierarchies  : Array     // tlds activated EMPTY at install time
*   }
*/
export_hierarchy.prototype.exec_export_hierarchy_json = async () => {

	// get value from API
	const api_response = await data_manager.request({
		use_worker	: true,
		body		: {
			dd_api			: 'dd_area_maintenance_api',
			action			: 'widget_request',
			prevent_lock	: true,
			source			: {
				type	: 'widget',
				model	: 'export_hierarchy',
				action	: 'export_hierarchy_json'
			},
			options : {}
		},
		retries : 1, // one try only
		timeout : 3600 * 1000 // 1 hour waiting response
	})
	if(SHOW_DEBUG===true) {
		console.log('))) exec_export_hierarchy_json api_response:', api_response);
	}


	return api_response
}//end exec_export_hierarchy_json



/**
* SYNC_HIERARCHY_ACTIVE_STATUS
* Fires the server-side operation that reconciles hierarchy `Active` flags with
* thesaurus `Active in thesaurus` flags across all sections.
*
* Calls `dd_area_maintenance_api::widget_request` with action
* `sync_hierarchy_active_status`.  The server walks every hierarchy record and
* overwrites the local `Active` status to match the corresponding thesaurus term's
* `Active in thesaurus` status, correcting drift that can accumulate when terms
* are activated/deactivated through the thesaurus UI without touching hierarchy
* records directly.
*
* Like `exec_export_hierarchy`, this is dispatched through a Web Worker with
* `prevent_lock: true` and a one-hour timeout.  No options are sent because the
* operation always runs across all sections.
*
* (!) This method is an arrow function on the prototype; it cannot access the
*     widget instance via `this`.  See note in exec_export_hierarchy above.
*
* @returns {Promise<Object>} Resolves to the raw API response object:
*   {
*     result   : boolean,
*     errors   : Array,
*     msg      : string,
*     ...      : *
*   }
*/
export_hierarchy.prototype.sync_hierarchy_active_status = async () => {

	// get value from API
	const api_response = await data_manager.request({
		use_worker	: true,
		body		: {
			dd_api			: 'dd_area_maintenance_api',
			action			: 'widget_request',
			prevent_lock	: true,
			source			: {
				type	: 'widget',
				model	: 'export_hierarchy',
				action	: 'sync_hierarchy_active_status',
			},
			options : {}
		},
		retries : 1, // one try only
		timeout : 3600 * 1000 // 1 hour waiting response
	})
	if(SHOW_DEBUG===true) {
		console.log('))) sync_hierarchy_active_status sync_hierarchy_active_status api_response:', api_response);
	}


	return api_response
}//end sync_hierarchy_active_status




// @license-end
