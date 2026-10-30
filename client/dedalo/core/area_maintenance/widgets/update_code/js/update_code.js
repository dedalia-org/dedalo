// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* UPDATE_CODE
* Widget controller for the "Update code" maintenance panel.
*
* This module implements the model layer for the code-update widget inside the
* area_maintenance dashboard.  Its role is to:
*
*   1. Provide the standard Dédalo widget lifecycle (init → build → render →
*      destroy) by delegating those prototype methods to widget_common.
*   2. Provide `get_value` (loading this widget's server-side data payload) from
*      area_maintenance (dd_area_maintenance_api::get_widget_value).
*   3. Expose three async methods that drive the update and restore workflows:
*      - `get_code_update_info`  — interrogates a remote Dédalo distribution
*        server and returns the list of available release zips plus metadata about
*        the current running version.
*      - `update_code`           — submits the server-side update as a BACKGROUND
*        JOB; the response returns immediately with `pid` + `pfile` extension
*        keys and the render layer follows the job's status stream.
*      - `restore_code`          — the same swap machinery run in REVERSE: a
*        restore point left behind by an earlier update is moved back into place.
*        Same background-job contract (`pid` + `pfile`), same phase frames, so the
*        render layer follows it through exactly the same tracker.
*      - `request_image_update` / `cancel_image_update_request` — on a CONTAINER
*        installation, record (or withdraw) a request the opt-in host updater
*        claims; the engine never touches docker.
*
* The DOM layer (modal, file-selection radio list, phase-track progress,
* error display, build-from-git buttons) is handled entirely by
* render_update_code.js.
*
* Lifecycle:
*   init()      → widget_common.prototype.init   (seeds properties, sets status)
*   build()     → widget_common.prototype.build  (calls get_value, populates self.value)
*   render()    → widget_common.prototype.render (dispatches to this.list())
*   destroy()   → widget_common.prototype.destroy
*   list/edit() → render_update_code.prototype.list (the DOM factory)
*
* Main export: `update_code` (constructor).
*
* @see core/area_maintenance/widgets/update_code/js/render_update_code.js — DOM rendering
* @see core/area_maintenance/js/area_maintenance.js — get_value + init_form contracts
* @see core/widgets/widget_common/js/widget_common.js — shared widget lifecycle base
*/



// imports
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {widget_common} from '../../../../widgets/widget_common/js/widget_common.js'
	import {area_maintenance} from '../../../../area_maintenance/js/area_maintenance.js'
	import {render_update_code} from './render_update_code.js'
	import {data_version_of} from '../../../../common/js/release_identity.js'
	import {channel_token} from './update_code_channel.js'



/**
* UPDATE_CODE
* Constructor for the update_code widget instance.
*
* All properties are declared here as undefined (the Dédalo convention for
* declaring the instance shape in the constructor body).  They are populated
* during the lifecycle:
*
*   - `id`, `section_tipo`, `section_id`, `lang`, `mode`, `node`, `status`:
*     seeded by widget_common.prototype.init from the options bag.
*   - `value`:  populated by build() after get_value() returns the server
*     payload (servers list, local-dir path, is_a_code_server flag, etc.).
*   - `events_tokens`: array of subscription tokens registered via event_manager;
*     destroyed in widget_common.prototype.destroy.
*   - `ar_instances`: child instances managed by this widget (unused in current
*     implementation but kept for lifecycle symmetry with other widgets).
*
* @property {string}      id            - Unique instance identifier.
* @property {string}      section_tipo  - Ontology tipo of the parent section.
* @property {string}      section_id    - Row id of the parent section record.
* @property {string}      lang          - Active UI language code.
* @property {string}      mode          - Render mode ('edit' or 'list').
* @property {Object}      value         - Data payload from the server:
*   @property {Array}     value.servers                      - Available distribution servers.
*   @property {boolean}   value.is_a_code_server             - True when this node is a
*                                                              Dédalo distribution server.
* @property {HTMLElement} node          - Root DOM node after render.
* @property {Array}       events_tokens - Subscribed event tokens (cleaned up on destroy).
* @property {Array}       ar_instances  - Child widget instances.
* @property {string}      status        - Lifecycle state managed by widget_common.
*/
export const update_code = function() {

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
}//end update_code



/**
* COMMON FUNCTIONS
* Prototype assignments that wire the standard widget and area_maintenance
* lifecycle into update_code.
*
* Lifecycle (from widget_common):
*   init    — seeds all declared properties from the options bag; sets
*             status = 'initializing' → 'initialized'.
*   build   — calls this.get_value() to fetch the server-side data payload and
*             stores it in this.value; sets status = 'building' → 'built'.
*   render  — dispatches to this.edit() or this.list() depending on this.mode.
*   destroy — unsubscribes all events_tokens, removes the DOM node.
*
* Data (from area_maintenance):
*   get_value — fires a worker request to dd_area_maintenance_api::get_widget_value
*               with this widget's id as source.model; returns the raw API result.
*               The 1-hour timeout and single-retry policy are inherited unchanged.
*
* Render (from render_update_code):
*   edit / list — both point to render_update_code.prototype.list, which builds
*                 the full widget wrapper (version info, server selector, update
*                 button, optional build-from-git controls).
*/
// prototypes assign
	// lifecycle
	update_code.prototype.init		= widget_common.prototype.init
	update_code.prototype.build		= widget_common.prototype.build
	update_code.prototype.render	= widget_common.prototype.render
	update_code.prototype.destroy	= widget_common.prototype.destroy
	update_code.prototype.get_value	= area_maintenance.prototype.get_value
	// render
	update_code.prototype.edit		= render_update_code.prototype.list
	update_code.prototype.list		= render_update_code.prototype.list



/**
* GET_CODE_UPDATE_INFO
* Queries a remote Dédalo distribution server for the list of available
* release archives and the metadata of the serving installation.
*
* Phase 1 of the two-step update workflow. The result is passed to
* render_update_code.js::render_info_modal so the operator can inspect
* available versions and choose one before committing to an update.
*
* The request is sent directly to the distribution server URL (not through
* the local API) using `data_manager.request`. The remote lists an existing
* manifest — it does not build one — so a normal 60 s timeout is enough.
*
* The `prevent_lock` flag ensures the request does not acquire a Dédalo record
* lock on either side.
*
* @param {Object} server - Active distribution server descriptor.
* @param {string} server.code - Server authentication / identifier code passed
*   to the remote API so it can scope the response to this installation.
* @param {string} server.url  - Full URL of the remote dd_utils_api endpoint.
* @param {string} [channel] - the panel's channel choice, the ladder
*   'master' ⊂ 'prerelease' ⊂ 'dev' (update_code_channel.js): 'prerelease' ALSO
*   asks for prereleases, 'dev' for prereleases and developer builds; anything
*   else asks for published releases only.
* @returns {Promise<Object>} api_response — envelope from the remote server:
*   {
*     data : {
*       files : Array<{
*         version : string,   // numeric release, e.g. "6.4.0"
*         url     : string,   // download URL for the zip archive
*         date    : string,   // ISO 8601 build timestamp
*         active  : boolean   // true after the operator selects this entry
*       }>,
*       info : {
*         version   : string, // e.g. "6.4.0"
*         date      : string,
*         entity_id : number,
*         entity    : string,
*         host      : string
*       }
*     },
*     msg    : string,
*     errors : string[]
*   }
*/
update_code.prototype.get_code_update_info = async function ( server, channel ) {

	// short vars
		const code				= server.code
		const url				= server.url
		// `version` is the DATA triple, never the release identity: a master (this
		// version or an OLDER one — its parser reads three integers) refuses
		// '7.0.0-beta.6' as an invalid version. The server publishes the triple
		// beside the identity (page_globals.dedalo_data_version); deriving it is
		// the fallback for a page_globals without the key.
		// `release` carries the identity itself (WC-2026-10-15-release-identity-from-tag)
		// and is what the master WALKS the code ladder from (audit U-06): a
		// code-only patch never moves the data version, so a 7.0.1 install on
		// data 7.0.0 is offered 7.0.2 only because it says it is 7.0.1. An ask
		// without it is walked from `version` (the bare data triple).
		const data_version		= page_globals.dedalo_data_version || data_version_of(page_globals.dedalo_version)
		const release			= page_globals.dedalo_version || null

	const api_response = await data_manager.request({
		url		: url,
		body	: {
			dd_api			: 'dd_utils_api',
			action			: 'get_code_update_info',
			prevent_lock	: true,
			source			: {},
			options			: {
				version	: data_version,
				release	: release,
				code	: code,
				// 'prerelease' asks the master to ALSO offer prereleases (immutable
				// betas), 'dev' prereleases and developer builds (branch builds,
				// same version — no bump). An ask, not a right: a master that did
				// not opt into a rung — or an OLDER master, which knows only 'dev'
				// — answers as for 'master' (the panel reads that back from
				// info.channels: update_code_channel.js channel_shortfall).
				// Anything but an exact token is the release channel.
				channel	: channel_token(channel)
			}
		},
		retries : 1, // one try only
		timeout : 60 * 1000 // it lists an existing manifest
	})
	if(SHOW_DEBUG===true) {
		console.log('))) get_code_update_info update_code api_response:', api_response);
	}


	return api_response
}//end get_code_update_info



/**
* UPDATE_CODE
* Submits the server-side code replacement as a BACKGROUND JOB.
*
* Phase 2 of the two-step update workflow; called after the operator has
* selected a release in the modal (render_update_code.js::render_info_modal)
* and accepted the confirm dialog.
*
* The request is routed to the local API (`dd_area_maintenance_api`,
* `widget_request` action → the `update_code` widget action). The server
* verifies the request, SUBMITS the job and answers immediately: the response
* carries `pid` + `pfile` extension keys and the render layer follows the
* job's status stream (update_process_status), including the mid-job server
* restart and the /health polling that ends it.
*
* The `prevent_lock` flag avoids the record-lock mechanism on both ends.
*
* @param {Object} options - Update parameters assembled by the modal.
* @param {Object} options.info - Version/entity metadata from Phase 1:
*   { version, date, entity_id, entity, host }
* @param {Object} options.file_active - The release zip entry selected by the
*   operator: { version, url, date, active }
* @param {boolean} [options.waive_backup] - The operator's explicit waiver of the
*   RECENT DATABASE BACKUP precondition (the modal's checkbox, offered only when
*   the panel's `backup_fresh` check is not `ok`). Strict `=== true` here as on
*   the server (core/update/code_update.ts): a truthy stray must never be what
*   disarms a guard; every waiver is logged loudly, with the requesting user, in
*   the server log. It waives the DATABASE backup only — the code backup is the
*   swap itself (two renames of a tree already on disk) and is never optional.
* @returns {Promise<Object>} api_response — envelope with `pid` + `pfile`
*   extension keys on success (the job handle), `error` on failure.
*/
update_code.prototype.update_code = async function ( options ) {

	// options
	const file_active	= options.file_active
	const info			= options.info
	const waive_backup	= options.waive_backup === true

	const api_response = await data_manager.request({
		body		: {
			dd_api		: 'dd_area_maintenance_api',
			action		: 'widget_request',
			prevent_lock	: true,
			source		: {
				type	: 'widget',
				model	: 'update_code',
				action	: 'update_code'
			},
			options	: {
				file			: file_active,
				info			: info,
				waive_backup	: waive_backup
			}
		},
		retries : 1, // one try only
		timeout : 60 * 1000 // the job is submitted, not awaited
	})
	if(SHOW_DEBUG===true) {
		console.log('))) update_code update_code api_response:', api_response);
	}


	return api_response
}//end update_code



/**
* RESTORE_CODE
* Submits the server-side RESTORE of a previous code tree as a BACKGROUND JOB.
*
* Every update renames the outgoing tree aside as a restore point (kept WITH its
* node_modules, so it boots with no network). This asks the engine to move one of
* those points back into place: the same atomic rename swap the update performs,
* run in reverse, with the currently live tree becoming a NEW restore point.
*
* THE POINT IS NAMED, NEVER PATHED. The server matches `name` against its own
* listing of the backup root and joins it itself; a client that could send a path
* would be choosing which directory to make live.
*
* @param {Object} options
* @param {string} options.name - Restore-point directory name exactly as the
*   panel received it in `value.consumer.restore_points[].name`.
* @param {boolean} [options.confirm_downgrade] - The operator's explicit
*   acknowledgement that the restored tree declares a DIFFERENT version than the
*   running one, and that database migrations already applied are NOT reverted by
*   moving code back. Strict `=== true` here as on the server: a truthy stray must
*   never be what disarms a guard, and every waiver is logged loudly with the
*   requesting user. The server refuses a version-changing restore without it.
* @returns {Promise<Object>} api_response — envelope with `pid` + `pfile`
*   extension keys on success (the job handle), `error` on failure.
*/
update_code.prototype.restore_code = async function ( options ) {

	// options
	const name					= options.name
	const confirm_downgrade		= options.confirm_downgrade === true
	const waive_backup			= options.waive_backup === true

	const api_response = await data_manager.request({
		body		: {
			dd_api		: 'dd_area_maintenance_api',
			action		: 'widget_request',
			prevent_lock	: true,
			source		: {
				type	: 'widget',
				model	: 'update_code',
				action	: 'restore_code'
			},
			options	: {
				name				: name,
				confirm_downgrade	: confirm_downgrade,
				// the destructive door's backup waiver (core/update/door_class.ts)
				waive_backup		: waive_backup
			}
		},
		retries : 1, // one try only
		timeout : 60 * 1000 // the job is submitted, not awaited
	})
	if(SHOW_DEBUG===true) {
		console.log('))) restore_code update_code api_response:', api_response);
	}


	return api_response
}//end restore_code



/**
* DELETE_RESTORE_POINT
* Removes ONE restore point from disk. Irreversible.
*
* SYNCHRONOUS, unlike its two neighbours: update_code and restore_code submit
* background jobs because they end in a server restart that kills the caller.
* This ends in a directory being gone, and that answer IS the product — the
* server re-checks the path after removing it and refuses when anything
* survives, so the envelope carries a verdict rather than a job handle.
*
* TEN MINUTES, not the hour the pre-job contract used. A restore point is a
* whole code tree with its node_modules (~10^5 inodes), which is seconds on a
* local SSD and minutes on a bind-mounted or network disk — but an hour-long
* pending request is the pattern the background-job contract exists to remove,
* and it would hold a connection open on a panel nobody is watching. If the
* removal outlives the timeout the CLIENT gives up while the SERVER finishes:
* the next panel read shows the truth (the row gone, or still there with the
* partial-delete sentence), which is the honest degradation for an operation
* whose result is written on the disk rather than held in the response.
*
* THE POINT IS NAMED, NEVER PATHED — the same contract as restore_code: the
* server matches `name` against its own listing of the backup root and joins it
* itself, so a client can never choose which directory is removed.
*
* @param {Object} options
* @param {string} options.name - Restore-point directory name exactly as the
*   panel received it in `value.consumer.restore_points[].name`.
* @returns {Promise<Object>} api_response — envelope whose `msg` names the point
*   deleted, or `error` (including the PARTIAL-delete refusal, which names what
*   could not be removed).
*/
update_code.prototype.delete_restore_point = async function ( options ) {

	const api_response = await data_manager.request({
		body		: {
			dd_api		: 'dd_area_maintenance_api',
			action		: 'widget_request',
			prevent_lock	: true,
			source		: {
				type	: 'widget',
				model	: 'update_code',
				action	: 'delete_restore_point'
			},
			options	: {
				name : options.name
			}
		},
		retries : 1, // one try only
		timeout : 600 * 1000 // see the note above: bounded, and the disk is the record
	})
	if(SHOW_DEBUG===true) {
		console.log('))) delete_restore_point update_code api_response:', api_response);
	}

	return api_response
}//end delete_restore_point



/**
* REQUEST_IMAGE_UPDATE
* On a CONTAINER installation (value.consumer.image present), records a request
* for the opt-in HOST UPDATER to install one release's image. The engine never
* updates its own image — it has no docker access, by design — so the answer
* is the recorded request, not a job: the host updater claims it within a
* minute and runs deploy/dedalo-image-update.sh (backup, pull or build, health
* check, rollback) from the operator's own `.dedalo.env`. The request names a
* version and nothing else.
*
* No `prevent_lock`: a request is one small file write, not a long job, and the
* widget_request door needs no lock exemption for it.
*
* @param {Object} options
* @param {string} options.version - the release's 'X.Y.Z' exactly as the code
*   server's manifest listed it
* @param {string} [options.channel] - the manifest item's own `channel`: 'dev'
*   for a developer item, 'prerelease' for a prerelease (an engine without
*   prerelease images refuses it as a malformed version — loudly, never as
*   the stable image of the same triple), anything else the release channel
* @param {string} [options.release] - a prerelease item's release identity
*   ('7.0.1-beta.2'): the image tag it names (sent only when given)
* @returns {Promise<Object>} api_response — `data.request` (the recorded request)
*   on success; `error` with `coordinates.reason` on a refusal
*/
update_code.prototype.request_image_update = async function ( options ) {

	const api_response = await data_manager.request({
		body		: {
			dd_api		: 'dd_area_maintenance_api',
			action		: 'widget_request',
			source		: {
				type	: 'widget',
				model	: 'update_code',
				action	: 'request_image_update'
			},
			options	: {
				version	: options.version,
				channel	: channel_token(options.channel),
				// a prerelease item's identity (code_manifest CodeReleaseItem.release):
				// the server tags the request by it (image_update_request.ts requestedTag)
				...(typeof options.release==='string' ? { release : options.release } : {})
			}
		},
		retries : 1, // one try only: a request is not idempotent
		timeout : 60 * 1000
	})
	if(SHOW_DEBUG===true) {
		console.log('))) request_image_update update_code api_response:', api_response);
	}

	return api_response
}//end request_image_update



/**
* CANCEL_IMAGE_UPDATE_REQUEST
* Withdraws the pending image-update request, while the host updater has not
* claimed it yet. A claimed request is already running on the Docker host and
* the server refuses (`coordinates.reason: 'request_claimed'`).
* @returns {Promise<Object>} api_response — `data.cancelled` on success
*/
update_code.prototype.cancel_image_update_request = async function () {

	const api_response = await data_manager.request({
		body		: {
			dd_api		: 'dd_area_maintenance_api',
			action		: 'widget_request',
			source		: {
				type	: 'widget',
				model	: 'update_code',
				action	: 'cancel_image_update_request'
			},
			options	: {}
		},
		retries : 1,
		timeout : 60 * 1000
	})
	if(SHOW_DEBUG===true) {
		console.log('))) cancel_image_update_request update_code api_response:', api_response);
	}

	return api_response
}//end cancel_image_update_request



// @license-end
