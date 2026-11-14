// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* CHECK_CONFIG
* Maintenance widget that audits the live v7 installation's configuration: the
* database connection/credential status and the presence of the ../private config
* sources (.env, state.php, config.local.php).
*
* The widget also provides root-only controls for toggling maintenance mode
* and broadcasting a site-wide user notification — each backed by
* dedicated `dd_area_maintenance_api` actions on the server side.
*
* Architecture:
*   - Follows the standard maintenance-widget lifecycle:
*       init (widget_common) → build (own override) → render (widget_common) →
*       load (widget_common, fires get_value once on first open) → destroy.
*   - `get_value` is inherited from `area_maintenance.prototype.get_value`, which
*     fires a long-lived (up to 1 h) worker request to
*     `dd_area_maintenance_api::get_widget_value` and returns the parsed payload.
*   - The server-side peer (`class.check_config.php::get_value`) reports the v7
*     config status: DB connection/credentials and ../private config-source presence.
*   - DOM rendering and the maintenance/notification forms are handled
*     entirely by `render_check_config.js`.
*
* Value shape (object returned by check_config::get_value):
*   {
*     db_status      : {Object}  DB connection + credential checks + global_status
*     config_sources : {Array}   [{ name, required, exists, readable }] for ../private files
*   }
*
* When `db_status.global_status` is not true, or a required `config_sources` entry
* is missing/unreadable, the widget header is styled 'danger' (red) by
* `set_widget_label_style` to signal a configuration problem.
*
* Main export: `check_config` (constructor).
*
* @see core/area_maintenance/widgets/check_config/class.check_config.php  — server value provider
* @see core/area_maintenance/widgets/check_config/js/render_check_config.js — DOM rendering
* @see core/widgets/widget_common/js/widget_common.js — base lifecycle (init/build/render/load)
* @see core/area_maintenance/js/area_maintenance.js   — get_value implementation
*/



// imports
	import {widget_common} from '../../../../widgets/widget_common/js/widget_common.js'
	import {area_maintenance} from '../../../../area_maintenance/js/area_maintenance.js'
	import {render_check_config} from './render_check_config.js'



/**
* CHECK_CONFIG
* Constructor for the check_config maintenance widget instance.
*
* Property declarations here are intentionally bare (`undefined`); they are
* populated by `widget_common.prototype.init` (identity fields) and by `build`
* / `load` (data fields).  The constructor itself is synchronous and lightweight.
*
* @property {string}      id            - Unique widget instance identifier, set by init.
* @property {string}      section_tipo  - Ontology tipo of the parent maintenance area section.
* @property {string|number} section_id  - Record identifier within the parent section.
* @property {string}      lang          - Active UI language code (e.g. 'lg-eng').
* @property {string}      mode          - Render mode: 'edit' | 'list'.
* @property {Object|null} value         - Audit result object populated by load() → get_value().
*                                         See module header for the exact shape.
* @property {HTMLElement|null} node     - Root DOM node produced by render().
* @property {Array}       events_tokens - Subscriptions registered during render; cleared on destroy.
* @property {Array}       ar_instances  - Child component instances managed by this widget.
* @property {string}      status        - Lifecycle state: 'initializing' | 'initialized' |
*                                         'building' | 'built'.
*/
export const check_config = function() {

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
}//end check_config



/**
* COMMON FUNCTIONS
* Prototype assignments that wire shared lifecycle and render methods into
* check_config, following the standard Dédalo maintenance-widget pattern.
*
* Lifecycle (from widget_common / area_maintenance):
*   init       — seeds all instance properties from the options bag; guards
*                against duplicate initialisation.
*   render     — dispatches to this.edit() or this.list() based on this.mode.
*   refresh    — tears down per-render state and re-runs build → render.
*   destroy    — unsubscribes event tokens and removes the DOM node.
*   get_value  — inherited from area_maintenance; fires a worker request to
*                dd_area_maintenance_api::get_widget_value and returns the
*                diff-item array (see module header for shape).
*
* Render (from render_check_config):
*   edit / list — both alias render_check_config.prototype.list so the widget
*                 renders identically in both modes.
*
* Note: widget_common.prototype.build is intentionally NOT assigned here;
*       check_config.prototype.build (below) provides a custom override.
*/
// prototypes assign
	// // lifecycle
	check_config.prototype.init			= widget_common.prototype.init
	// check_config.prototype.build		= widget_common.prototype.build
	check_config.prototype.render		= widget_common.prototype.render
	check_config.prototype.refresh		= widget_common.prototype.refresh
	check_config.prototype.destroy		= widget_common.prototype.destroy
	check_config.prototype.get_value	= area_maintenance.prototype.get_value
	// // render
	check_config.prototype.edit			= render_check_config.prototype.list
	check_config.prototype.list			= render_check_config.prototype.list



/**
* BUILD
* Custom build that overrides widget_common.prototype.build.
*
* Delegates to `widget_common.prototype.build` for standard status bookkeeping
* ('building' → 'built').  Data loading is intentionally deferred — it does NOT
* happen here; instead it runs lazily via `widget_common.prototype.load` the
* first time the widget panel is opened in the maintenance dashboard
* (see render_area_maintenance).  This avoids triggering a potentially slow
* PHP config-diff computation on every page build.
*
* The try/catch block guards against unexpected exceptions thrown by the base
* build and stores any error on `self.error` for upstream inspection.
*
* @param {boolean} [autoload=false] - Forwarded to widget_common.prototype.build.
*   Kept false (the default) because data loading is handled by load(), not build().
* @returns {Promise<boolean>} Resolves to the return value of widget_common.prototype.build
*   (true on success).
*/
check_config.prototype.build = async function(autoload=false) {

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



// @license-end
