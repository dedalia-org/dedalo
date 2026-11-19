// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* ERROR_REPORTS
* Maintenance widget controller browsing this installation's error reports (WC-018).
*
* TS-OWNED widget (no PHP twin): this directory is excluded from
* scripts/sync_client.sh like diffusion_server_control (WC-005). The server
* half lives at src/core/area_maintenance/widgets/error_reports.ts (listed on
* every installation: each stores the reports its admins send).
*
* Value shape (get_widget_value → errorReportsGetValue):
*   this.value = { total: number|null, latest_received_at: string|null, target: string }
*
* Rows load on demand through widget_request → 'get_reports'
* (render_error_reports.js). Every report-derived string renders via
* textContent — the payloads are UNTRUSTED user/browser content (DS-1).
*
* Main export: `error_reports` (constructor).
*/



// imports
	import {widget_common} from '../../../../widgets/widget_common/js/widget_common.js'
	import {area_maintenance} from '../../../../area_maintenance/js/area_maintenance.js'
	import {render_error_reports} from './render_error_reports.js'



/**
* ERROR_REPORTS
* Constructor. Properties are populated by the standard widget lifecycle
* invoked by the area_maintenance shell: init → build → render.
*/
export const error_reports = function() {

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
}//end error_reports



// prototypes assign
	// lifecycle
	error_reports.prototype.init		= widget_common.prototype.init
	error_reports.prototype.build		= widget_common.prototype.build
	error_reports.prototype.render		= widget_common.prototype.render
	error_reports.prototype.refresh		= widget_common.prototype.refresh
	error_reports.prototype.destroy		= widget_common.prototype.destroy
	error_reports.prototype.get_value	= area_maintenance.prototype.get_value
	// render
	error_reports.prototype.edit		= render_error_reports.prototype.list
	error_reports.prototype.list		= render_error_reports.prototype.list



/**
* BUILD
* Custom build overwrites the common widget method: data loads on-open via
* the unified widget load() (see render_area_maintenance).
* @param {boolean} autoload
* @returns {Promise<boolean>}
*/
error_reports.prototype.build = async function(autoload=false) {

	const self = this

	const common_build = await widget_common.prototype.build.call(this, autoload);

	return common_build
}//end build



// @license-end
