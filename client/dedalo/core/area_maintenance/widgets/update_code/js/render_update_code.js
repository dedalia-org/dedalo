// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {dd_request_idle_callback} from '../../../../common/js/events.js'
	import {normalize_stream_error, request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {handle_api_error} from '../../../../common/js/error_dispatch.js'
	import {login} from '../../../../login/js/login.js'
	import {render_servers_list} from '../../update_ontology/js/render_update_ontology.js'
	import {error_text} from '../../../../common/js/render_api_error.js'
	import {
		render_consumer_status,
		refresh_readiness,
		backup_waiver_check,
		image_update_command,
		image_command_tag
	} from './render_update_status.js'
	import {
		channel_shortfall_note,
		channel_token,
		item_release
	} from './update_code_channel.js'
	import {
		UPDATE_PHASES,
		init_phase_state,
		apply_phase_frame,
		resolve_final_frame,
		resolve_health_outcome
	} from './update_code_phases.js'



/**
* RENDER_UPDATE_CODE
* Client-side render module for the `update_code` maintenance widget.
*
* Flow:
*   1. `list` builds the panel: a `dd_readout` with the running version/build,
*      the shared server picker (render_servers_list over CODE_SERVERS), and
*      the "check available updates" button.
*   2. The button calls `self.get_code_update_info(server)` and opens
*      `render_info_modal` with the manifest the code server answered.
*   3. Picking a version and accepting the `ui.confirm` dialog calls
*      `self.update_code({info, file_active})`, which submits a BACKGROUND JOB
*      and answers immediately with `{pid, pfile}` extension keys.
*   4. `track_process` follows the job: `update_process_status` streams the
*      job's frames (each carries the phase track — see update_code_phases.js),
*      and when the stream dies at/after the `swap` phase — the server restart
*      kills it BY DESIGN — the tracker deletes the resume key and polls
*      `GET /health` until the new version answers (or the deadline declares
*      the server gone / rolled back).
*   5. On success the panel shows the updated state FIRST, then offers a
*      reload (`login.quit`) via `ui.confirm`; a dismissed dialog leaves a
*      persistent "reload pending" note with its own button.
*
* The PUBLISH side (building `<v>.zip` / `<v>-dev.zip` from git on a code
* server) is the serve_code widget since 2026-09-28.
*
* The 'development' entity REFUSES to update itself: the refusal renders in
* the panel (disabled button + warning note) BEFORE any picker opens.
*
* RESTORE runs the same road backwards. Every restore point listed by the
* consumer readout carries a Restore button (render_update_status.js); it opens
* `render_restore_modal`, which calls `self.restore_code({name, confirm_downgrade})`
* and hands the resulting `{pid, pfile}` to the SAME `track_process` — same phase
* reducer, same /health ending — under its own resume key. There is exactly one
* progress machine in this widget, and a restore is one of its jobs.
*
* A CONTAINER INSTALLATION (value.consumer.image, 2026-10-09) does not swap its
* tree — its code is the image, replaced on the Docker host. There the release
* modal shows, for the selected release, the exact host command
* (`./deploy/dedalo-image-update.sh --version <tag>`, composed from the server's
* facts) instead of the Update button, and — when the opt-in host updater is
* alive and nothing is pending — a "Request this update" button that records a
* request the host claims; `follow_image_request` then follows it to its
* recorded outcome. Every installation's modal shows each release's NOTES.
*
* Exports:
*   render_update_code — constructor (prototype-only; no instance state)
*/
export const render_update_code = function() {

	return true
}//end render_update_code



// process resume key (IndexedDB 'status' table) — written by render_stream on
// job start, cleared by it on stream end, and cleared HERE before health
// polling (the old pid/pfile mean nothing to the restarted process).
const LOCAL_DB_ID = 'process_update_code'

// The RESTORE job's own resume key. A restore is a different job with a
// different expectation of /health (it lands on an OLDER version), so a resumed
// restore read back under the update's key would be judged 'rolled_back' by the
// very reducer that is supposed to confirm it. Two keys, never one.
const LOCAL_DB_ID_RESTORE = 'process_restore_code'

/**
* JOB_IN_PROGRESS
* True while EITHER resume key holds a job handle. The update and the restore
* move the same tree under the same server-side run lock, so from the panel's
* side there is one busy state, not two: a guard that only looked at its own key
* would let an operator start an update on top of a running restore and only
* learn about it from the server's lock refusal, mid-swap.
* @returns {Promise<boolean>}
*/
const job_in_progress = async function() {

	const running_update	= await data_manager.get_local_db_data(LOCAL_DB_ID, 'status')
	const running_restore	= await data_manager.get_local_db_data(LOCAL_DB_ID_RESTORE, 'status')

	return !!(running_update && running_update.value) || !!(running_restore && running_restore.value)
}//end job_in_progress



// per-modal radio group sequence: a radio group is document-wide by name, so
// each modal instance owns its own group (mirrors the picker_seq pattern of
// render_update_ontology.js).
let modal_seq = 0



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
*		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_update_code.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* BUILD_READOUT
* Two-tone key/value readout using the shared widget_kit grid
* (`.dd_readout` > `.dd_row` > `.dd_k` + `.dd_v`).
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
* GET_CONTENT_DATA_EDIT
* Builds and returns the full content panel for the update_code widget.
*
* Value shape consumed from `self.value` (update_code.get_value on the server):
*   {
*     servers: [{
*       name: string, url: string, code: string,
*       response_code: number, result: object|false
*     }],
*     is_a_code_server: boolean
*   }
*
* @param {Object} self - update_code widget instance (this inside list())
* @returns {Promise<HTMLElement>} content_data div ready to be embedded
*/
const get_content_data_edit = async function(self) {

	// value
		const value = self.value || {}

	// short vars
		const servers			= value.servers || []
		const is_development	= page_globals.dedalo_entity==='development'

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// body_response
	// Declared BEFORE the status half: the restore buttons the consumer readout
	// mounts hand their job to `track_process` on this surface, so it has to
	// exist before that readout is built. It is appended to content_data at the
	// END, where it belongs on screen.
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// STATUS: what is running, whether an update can even proceed, what
	// happened last time, and what could be rolled back to. Replaces the old
	// two-row version/build readout — same facts, plus every gate the pipeline
	// would refuse on (before 2026-08-24 those were discoverable only by
	// pressing the button and reading the failure). Server: value.consumer,
	// core/update/status.ts. Falls back to the two-row readout when an older
	// server answers without the status halves.
	// The CONSUMER role only: the code THIS installation runs. The PUBLISH role
	// (code server: build + serve releases) is its own widget since 2026-09-28,
	// serve_code — the same split as update_ontology / serve_ontology.
		const consumer_body = content_data
		// ONE writer for the consumer half, callable again from the re-seed: a
		// panel first painted through the FALLBACK (no `consumer` in the payload)
		// could otherwise never gain a readiness block, because refresh_readiness
		// finds nothing to replace — leaving the panel on version+build while the
		// modal in front of it reads the same fresh value and offers a waiver for
		// a check the panel never shows.
		let consumer_half = null
		const render_consumer_half = function(consumer) {
			const holder = ui.create_dom_element({ element_type : 'div' })
			if (consumer_half===null) {
				consumer_body.appendChild(holder)
			} else {
				consumer_body.replaceChild(holder, consumer_half)
			}
			consumer_half = holder
			if (consumer) {
				// the restore points are ACTIONABLE here: each bootable one gets a
				// Restore button that opens the confirm modal. The development entity
				// refuses to overwrite its own tree (same posture as the update button
				// below), so it gets no restore affordance either.
				render_consumer_status(
					holder,
					consumer,
					is_development
						? null
						// The SERVER's own version string travels with the point: the
						// modal's downgrade decision must be the pipeline's, and the
						// page global carries a prerelease tag the pipeline never sees.
						: (point) => render_restore_modal(self, point, body_response, (consumer.engine || {}).version),
					// DELETE, on the same terms as Restore: a development checkout
					// gets neither, because neither may touch its tree.
					is_development ? null : (point) => delete_restore_point(self, point, body_response),
					// the image block's Cancel (container installations only; the
					// block is not rendered at all elsewhere)
					is_development ? null : { on_cancel : () => cancel_image_request(self, body_response) }
				)
			} else {
				holder.appendChild(build_readout([
					{ k : (get_label.update_code_current_version || 'Current version'), v : page_globals.dedalo_version, mono : true },
					{ k : (get_label.update_code_current_build || 'Current build'), v : page_globals.dedalo_build, mono : true }
				]))
			}
			return holder
		}
		render_consumer_half(value.consumer)

	// RE-READ the consumer half from the server. Deleting a restore point
	// changes the very list this half renders, so the row that was acted on has
	// to come back from disk rather than from the value this render closed over
	// (the same reason serve_code re-reads its readout after a build). Exposed on
	// the instance because the actor — delete_restore_point — is a module-level
	// function, not a closure of this render.
		self.refresh_consumer = async () => {
			try {
				const fresh = await self.get_value()
				if (!fresh || !fresh.consumer) {
					return
				}
				self.value = fresh
				render_consumer_half(fresh.consumer)
			} catch (error) {
				// a failed refresh must never take the panel down: the action
				// already reported its own outcome in body_response
				console.error('update_code: could not refresh the consumer readout', error)
			}
		}

	// servers. The shared picker over CODE_SERVERS with its OWN storage key:
	// remembering the choice must not collide with the ontology picker's.
		const servers_list = render_servers_list( value, 'CODE_SERVERS', 'dedalo.update_code.server' )
		consumer_body.appendChild(servers_list)

	// resume a running update OR restore
	// If a previous job was started (browser closed or page refreshed during
	// the long-running server process), IndexedDB still holds its PID + pfile.
	// Resume the stream so the user sees live phase status on widget open —
	// routed through the SAME tracker (and the same ending) as a fresh start.
	// The two keys are read separately and re-attached under their OWN key: only
	// one job can run at a time (server side they share one run lock), but a
	// restore resumed as an update would be judged against the wrong version.
		const check_process_data = (local_db_id, operation) => {
			data_manager.get_local_db_data(
				local_db_id,
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					// WHAT ACTUALLY SURVIVES THE PAGE (corrected 2026-08-26; the
					// comment here used to claim the digest always did).
					// The handle is written at job start by render_stream
					// (common/js/render_common.js ~:458) and holds {pid, pfile} —
					// nothing else. The DIGEST is added only by finish_interrupted,
					// i.e. only when THIS page session watched the stream die
					// pre-swap and rewrote the key itself; a page that was simply
					// refreshed or closed leaves both tokens behind.
					// So the real fallback is downstream: the terminal envelope's
					// own `version` (on_done: `state.expected_version ||
					// ending.version`). When even that is missing — a job the
					// server reconciled, which reports no version at all — the
					// /health verdict is not decidable and poll_health says so
					// (update_code_unconfirmed) instead of inventing a rollback.
					track_process(
						local_data.value.pid,
						local_data.value.pfile,
						body_response,
						null,
						local_data.value.digest ?? null,
						false,
						local_db_id,
						operation
					)
				}
			})
		}
		check_process_data(LOCAL_DB_ID, 'update')
		check_process_data(LOCAL_DB_ID_RESTORE, 'restore')

	// development refusal — BEFORE any picker/modal: ask nothing, refuse first.
		if (is_development) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning',
				text_content	: get_label.update_code_dev_refused || 'To avoid accidental overwrites, the development installation does not allow updating the code.',
				parent			: consumer_body
			})
		}

	// channel choice — WHAT to ask the code server for: published releases,
	// prereleases too, or developer builds too (the ladder master ⊂ prerelease ⊂
	// dev, update_code_channel.js). One radio group, published pre-selected.
	// A PRERELEASE is an immutable, sha-verified tag build of a version that is
	// not yet stable (7.0.1-beta.2). A DEVELOPER BUILD is a build of the 'master'
	// tip (a release is a tag), so it carries NO version bump and installs over
	// the same version: it is how unreleased work is tested on a real
	// installation. Choosing either is the ARMING on this side — everything else
	// (superuser, maintenance mode, a recent backup, the sha256 check) is
	// unchanged. The code server must have opted into that rung too, and one
	// that did not answers with releases only (said so above the list:
	// channel_shortfall_note).
		const channel_row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'channel_row',
			parent			: consumer_body
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'channel_heading',
			text_content	: get_label.update_code_channel_choice || 'Offer',
			parent			: channel_row
		})
		// per-panel group name: two panels on one page never share a radio group
		const channel_group = 'update_code_channel_' + (++modal_seq)
		const channel_options = [
			{
				token	: 'master',
				label	: get_label.update_code_channel_published || 'Published releases',
				note	: null
			},
			{
				token	: 'prerelease',
				label	: get_label.update_code_prerelease_channel || 'Prereleases',
				note	: get_label.update_code_prerelease_channel_note || 'Also offers prereleases (alpha, beta, release candidate): fixed, verified builds of a version that is not yet stable. Use them to try a coming release before it is published, not on a production installation.'
			},
			{
				token	: 'dev',
				label	: get_label.update_code_dev_channel || 'Developer builds',
				note	: get_label.update_code_dev_channel_note || "Also offers developer builds made from the 'master' branch: the latest integrated code, not yet released. A developer build may carry the same version number as the installed one, and is then installed over it. Use them to test development work, never on a production installation."
			}
		]
		const channel_inputs = channel_options.map(option => {
			// label WRAPS the input (the house pattern — move_lang/move_locator): the
			// click target is the whole option without an id/for pair to keep in sync.
			const option_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'channel_option channel_option_' + option.token,
				text_content	: option.label,
				parent			: channel_row
			})
			const input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'radio',
				class_name		: 'channel_radio',
				name			: channel_group,
				value			: option.token
			})
			input.checked = option.token==='master'
			// the developer option's icon reads BEFORE the words: it is the only
			// development-facing control on an otherwise production panel. Masked
			// svg, same vocabulary the area map uses for its 'dev' category (bug.svg).
			if (option.token==='dev') {
				option_label.prepend(ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'dev_channel_icon'
				}))
			}
			option_label.prepend(input)
			// the caution is SHOWN once its option is chosen (CSS :has(:checked)) —
			// it is what the operator has to read before checking WITH it on — and
			// rides the option's tooltip before that, so the default panel stays quiet
			if (option.note) {
				option_label.title = option.note
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_note channel_note channel_note_' + option.token,
					text_content	: option.note,
					parent			: channel_row
				})
			}
			return input
		})
		// the chosen token, read at click time (never cached: the operator may
		// change it between two checks)
		const chosen_channel = () => channel_token(channel_inputs.find(el => el.checked===true)?.value)

	// button_submit (check available updates)
		const button_submit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_submit',
			inner_html		: get_label.update_code_check_updates || 'Check available updates',
			parent			: consumer_body
		})
		if (is_development) {
			button_submit.disabled = true
		}
		// click event
		const click_event = async (e) => {
			e.stopPropagation()

			// clean previous inline feedback
				body_response.querySelectorAll('.error').forEach(el => { el.remove() })
				servers_list.classList.remove('empty')

			// busy guard: a running update OR restore owns the panel (make_backup
			// pattern). Both move the same tree under the same server-side run
			// lock, so either one blocks the other here too.
				const running = await job_in_progress()
				if (running) {
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						text_content	: get_label.update_code_busy || 'An update is already running.',
						parent			: body_response
					})
					return
				}

			// server to be used: a radio must be active in the picker. Inline
			// error + mandatory-field marking, never a blocking dialog.
				const server = servers.find(el => el.active === true )
				if( !server ){
					servers_list.classList.add('empty')
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						text_content	: get_label.update_code_no_server_selected || 'Select a code server first.',
						parent			: body_response
					})
					const first_radio = servers_list.querySelector('input[type="radio"]:not(:disabled)')
					if (first_radio) {
						first_radio.focus()
					}
					return
				}

			// clean body_response nodes
				while (body_response.firstChild) {
					body_response.removeChild(body_response.firstChild);
				}

			// loading add. Lock the button while the remote API call is in flight
				e.target.classList.add('lock')
				const spinner = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'spinner'
				})
				body_response.prepend(spinner)

			// Code information. Call selected remote server API to get updates list
				const asked_channel = chosen_channel()
				const server_code_api_response = await self.get_code_update_info(
					server,
					asked_channel
				)
				if(SHOW_DEBUG===true) {
					console.log('))) get_content_data_edit server_code_api_response:', server_code_api_response);
				}

				// result check
					const result = response_data(server_code_api_response)
					const errors = response_extension(server_code_api_response, 'errors') || []
					if(request_failed(server_code_api_response) || !result || errors.length){
						// remove spinner
						e.target.classList.remove('lock')
						spinner.remove()
						if (request_failed(server_code_api_response)) {
							// ONE error model: policy + renderer decide the surface
							await handle_api_error(server_code_api_response.error, {wrapper: body_response})
						} else {
							// error message node add (server text as TEXT, never an HTML sink)
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'error',
								text_content	: String(response_extension(server_code_api_response, 'msg') || 'Error connecting server'),
								parent			: body_response
							})
						}
						// additional errors (remote shell/git output — TEXT only)
						const errors_length = errors.length
						for (let i = 0; i < errors_length; i++) {
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'error',
								text_content	: String(errors[i] ?? ''),
								parent			: body_response
							})
						}
						return
					}

				// RE-SEED the widget payload before opening the modal. The modal
				// decides whether to offer the waive-backup control from the
				// `backup_fresh` check, and self.value was read at build() time:
				// a panel left open across the freshness deadline would hide the
				// only control that lets the operator proceed. A failed re-seed
				// is never a reason not to show the release list — keep the
				// value we have.
				// COST, stated: get_value re-probes every configured code server
				// (5 s timeout each) and recomputes the whole status. It is
				// bounded and the button is still locked with its spinner up,
				// but on an install with dead CODE_SERVERS entries this is what
				// delays the modal.
					try {
						const fresh_value = await self.get_value()
						if (fresh_value) {
							self.value = fresh_value
							// …and RE-STATE the panel from it. Without this the
							// modal's waiver row and the readiness row behind it
							// can show the same fact in two states at once.
							// refresh_readiness answers false when there is no
							// readiness block to replace — the FALLBACK painting —
							// and then the whole half is rendered again.
							if (refresh_readiness(consumer_half, fresh_value.consumer)!==true) {
								render_consumer_half(fresh_value.consumer)
							}
						}
					} catch (error) {
						// get_value resolves an error envelope rather than throwing,
						// so the real degrade path is the guard above; this is the
						// backstop, and a failed re-seed must never take the panel
						// down (same posture as refresh_consumer above)
						console.error('update_code: could not re-seed the panel value before the modal', error)
					}

				// show info modal
				// `result` shape: { info: {version, date, entity_id, entity, host},
				//                   files: [{version, url, date}] }
					render_info_modal( self, result, body_response, asked_channel )

				// remove spinner
				e.target.classList.remove('lock')
				spinner.remove()
		}
		button_submit.addEventListener('click', click_event)

	// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit



/**
* RENDER_PHASE_TRACK
* The visual phase track: a shared-kit progress bar plus one row per phase
* with a state chip. Returns a paint(state) function fed by the reducer.
* @param {HTMLElement} parent
* @returns {{node:HTMLElement, paint:Function}}
*/
const render_phase_track = function(parent) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'phase_track',
		parent			: parent
	})

	// progress bar (widget_kit)
	const bar = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar',
		parent			: node
	})
	const bar_fill = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar_fill',
		parent			: bar
	})
	const bar_note = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_bar_note',
		parent			: node
	})

	// one row per phase
	const readout = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_readout',
		parent			: node
	})
	const chips = {}
	// status words are labels too, same style as the phase names
	const status_text = (status) => get_label['update_code_status_'+status] || status
	UPDATE_PHASES.forEach(phase_id => {
		const row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_row',
			parent			: readout
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_k',
			text_content	: get_label['update_code_phase_'+phase_id] || phase_id,
			parent			: row
		})
		const v = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_v',
			parent			: row
		})
		chips[phase_id] = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'dd_badge',
			text_content	: status_text('pending'),
			parent			: v
		})
	})

	const chip_class = (status) => {
		switch (status) {
			case 'done'		: return 'dd_badge state_ok'
			case 'running'	: return 'dd_badge state_warning'
			case 'failed'	: return 'dd_badge state_danger'
			default			: return 'dd_badge'
		}
	}

	const paint = (state) => {
		let done_count = 0
		let running = false
		state.phases.forEach(p => {
			const chip = chips[p.id]
			if (!chip) return
			chip.className = chip_class(p.status)
			chip.textContent = status_text(p.status)
			if (p.status==='done' || p.status==='skipped') done_count++
			if (p.status==='running') running = true
		})
		bar_fill.style.width = Math.round(done_count / state.phases.length * 100) + '%'
		bar.classList.toggle('indeterminate', running || state.mode==='polling')
		if (state.mode==='failed') {
			bar_fill.classList.add('state_danger')
		} else if (state.mode==='rolled_back') {
			bar_fill.classList.add('state_warning')
		}
		// while the run is live the bar note IS its progress sentence. On a
		// terminal failure the ending note below states it — echoing it here
		// printed the same sentence twice.
		bar_note.textContent = (state.mode==='failed' || state.mode==='rolled_back')
			? ''
			: (state.message || '')
	}

	return { node : node, paint : paint }
}//end render_phase_track



/**
* RUN_WORDING
* The ENDING SENTENCES of one run, per operation (2026-08-26).
*
* The restore reuses the update's tracker verbatim — same frames, same reducer,
* same phase track — and until now it also reused its words: a finished restore
* said "Code updated to version 6.9.9", a dropped connection warned "do not
* start another update", and the reload prompt was headed "Update". All four
* describe the opposite of what the operator asked for.
*
* A wording SET, not a forked tracker: the shared code path is the reason the
* restore is followed correctly at all, and the caller already knows which of
* the two it started.
*
* @param {string} operation - 'update' | 'restore'
* @returns {Object} {done_header, done, connection_lost, failed, rolled_back}
*/
const run_wording = function(operation) {

	if (operation==='restore') {
		return {
			done_header		: get_label.update_code_restore || 'Restore',
			done			: get_label.update_code_restored || 'Code restored to version %s.',
			connection_lost	: get_label.update_code_restore_connection_lost || 'Connection lost — the restore may still be running on the server. Reopen this panel to re-attach, and do not start another restore.',
			failed			: get_label.update_code_restore_failed || 'The restore failed.',
			rolled_back		: get_label.update_code_restore_rolled_back || 'The restore was rolled back — the server is running the code it was running before.'
		}
	}

	return {
		done_header		: get_label.update || 'Update',
		done			: get_label.update_code_updated || 'Code updated to version %s.',
		connection_lost	: get_label.update_code_connection_lost || 'Connection lost — the update may still be running on the server. Reopen this panel to re-attach, and do not start another update.',
		failed			: get_label.update_code_failed || 'The update failed.',
		rolled_back		: get_label.update_code_rolled_back || 'The update was rolled back — the server is running the previous version.'
	}
}//end run_wording



/**
* TRACK_PROCESS
* Follows a running update job: streams its status via update_process_status
* (which also persists/cleans the IndexedDB resume key), feeds every frame to
* the pure reducer, and paints the phase track. When the stream dies at/after
* `swap` — the restart kills it by design — the tracker deletes the resume key
* itself and polls GET /health until the new version answers.
*
* Used by BOTH paths: the modal's fresh start and the panel-mount resume.
*
* @param {string|number} pid
* @param {string} pfile
* @param {HTMLElement} body_response - panel response surface
* @param {string|null} expected_version - version the job installs (null on resume)
* @param {string|null} [expected_digest] - sha256 of the archive the job installs
*   (the manifest item's own digest). On a DEVELOPER build the version is
*   identical on both sides of the swap, so this is the only token that can tell
*   the new tree from a rolled-back one.
* @param {boolean} [scroll_into_view=true] - bring the tracking surface into
*   view. The panel is long and `body_response` sits at its END: a user who
*   pressed Update in the modal would otherwise watch nothing until they
*   scrolled by hand. FALSE on the resume path, where the widget is just
*   opening and stealing the scroll would be a surprise.
* @param {string} [local_db_id=LOCAL_DB_ID] - the resume key this job is
*   persisted under. The RESTORE job passes LOCAL_DB_ID_RESTORE: same tracker,
*   same reducer, but a resumed restore must never be re-attached as an update.
* @param {string} [operation='update'] - 'update' | 'restore'. The tracker is
*   deliberately SHARED, but its ENDING SENTENCES are not: "Code updated to
*   version 6.9.9" at the end of a rollback is a false statement about what the
*   operator just did. The caller always knows which operation it started, so
*   the wording travels with the run instead of the tracker guessing (run_wording).
* @returns {void}
*/
const track_process = function(pid, pfile, body_response, expected_version, expected_digest=null, scroll_into_view=true, local_db_id=LOCAL_DB_ID, operation='update') {

	// per-run wording: ONE tracker, two vocabularies (see @param operation).
	// Read at run time, never at import time — get_label is a page global the
	// login fills in.
		const wording = run_wording(operation)

	// clean previous surface
		while (body_response.firstChild) {
			body_response.removeChild(body_response.firstChild);
		}

	// tracking surface: while a job runs, the phase track sticks to the top of
	// the viewport (update_code.less) so appended notes never push it away.
		body_response.classList.add('tracking')

	// phase track + reducer state
		const track = render_phase_track(body_response)
		let state = init_phase_state(expected_version, expected_digest)
		track.paint(state)

	// stream surface (render_stream owns this node)
		const stream_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'update_stream',
			parent			: body_response
		})

	// bring the progress into view (see scroll_into_view above).
	//
	// AFTER the stream node exists, and NOT `behavior:'smooth'`. Both halves are
	// load-bearing, measured on the docker museum in map view (2026-08-28,
	// 640px viewport): called before the surface was finished, the smooth scroll
	// settled 184px SHORT of its target — the phase track came to rest at
	// top:210 instead of top:26, so the track's own 352px pushed the stream to
	// 582 and the spinner inside it to the very bottom edge. That is the
	// reported "the spinner and the progress info are hidden below the table of
	// steps": the CSS cap was doing its job and the SCROLL was landing wrong.
	// A smooth scroll animates toward an offset computed when it is issued, so
	// it must not be issued while nodes are still being appended; the same call
	// with the surface complete lands at 26 exactly. rAF lets the appended nodes
	// lay out first — without it the offset is computed from a stale layout
	// again, just one frame earlier.
		if (scroll_into_view===true) {
			ui.reveal(body_response, { behavior:'auto', block:'start' })
		}

	// frame feed. update_process_status/render_stream expose no per-chunk hook
	// to the caller (common.js is shared surface), but render_stream ALWAYS
	// mirrors each raw SSE chunk into `.display_json_box` (display_json:true).
	// Observe that mirror, parse the chunk, feed the reducer.
	// LOAD-BEARING COUPLING to two common.js behaviours — mechanically pinned by
	// test/unit/client_update_code_render.test.ts ("stream-mirror coupling"):
	//   1. update_process_status calls render_stream with display_json:true;
	//   2. render_stream writes JSON.stringify(sse_response) into that box.
	// A change to either goes red THERE, not silently blank here. The raw <pre>
	// mirror is reducer feed, not operator surface: update_code.less hides it.
		let stream_final = false	// a final frame (is_running:false) arrived
		let final_error = null		// its normalized ApiError, when it carried one
		let final_frame = null		// the terminal frame itself (resolve_final_frame)
		const observer = new MutationObserver(() => {
			const box = stream_node.querySelector('.display_json_box')
			if (!box) return
			let sse_response = null
			try {
				sse_response = JSON.parse(box.textContent)
			} catch (_error) {
				return
			}
			if (sse_response && typeof sse_response==='object' && sse_response.is_running===false) {
				// the JOB ended (which is not the same as the stream dying)
				stream_final = true
				final_error = normalize_stream_error(sse_response)
				final_frame = sse_response
			}
			const frame = sse_response?.data
			if (frame && typeof frame==='object') {
				state = apply_phase_frame(state, frame)
				track.paint(state)
			}
		})
		observer.observe(stream_node, { subtree:true, childList:true, characterData:true })

	// endings

		// the job is over: release the sticky track (it only earns the top of
		// the viewport while there is progress to watch)
		const end_tracking = () => body_response.classList.remove('tracking')

		// EVERY ending appends its sentence as the LAST child of a surface that
		// is taller than the viewport, and the run's own scroll put the TOP of
		// that surface at the top of the screen. The phase track alone fills a
		// short window (update_code.less caps it for exactly this reason), so a
		// refusal, a rollback or a lost connection landed in space the operator
		// never saw: the panel looked like it had simply stopped. The track's
		// cap makes room; this puts the sentence IN it (ui.reveal: next frame,
		// DOM-stub guarded).
		const reveal = (node) => ui.reveal(node, { block:'center' })

		const finish_success = async (version) => {
			end_tracking()
			state = { ...state, mode:'done' }
			track.paint(state)
			// success state FIRST…
			reveal(ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_ok update_done',
				text_content	: wording.done
					.replace('%s', String(version || state.expected_version || '')),
				parent			: body_response
			}))
			// …then the reload prompt: the browser still holds the OLD ES modules
			// and only a full re-login reloads them.
			const accepted = await ui.confirm({
				header			: wording.done_header,
				body			: get_label.update_code_reload_required || 'Reload required: log in again to load the new code.',
				accept_label	: get_label.update_code_reload_now || 'Reload now'
			})
			if (accepted===true) {
				await login.quit()
				return
			}
			// dismissed: a persistent "reload pending" chip with its own button
			// revealed like every other ending note (reveal returns the node): this
			// one carries the button the operator must still press, so it is the
			// LAST thing that may be left below the fold.
			const pending = reveal(ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning reload_pending',
				text_content	: get_label.update_code_reload_required || 'Reload required: log in again to load the new code.',
				parent			: body_response
			}))
			const reload_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light',
				inner_html		: get_label.update_code_reload_now || 'Reload now',
				parent			: pending
			})
			reload_button.addEventListener('click', (e) => {
				e.stopPropagation()
				login.quit()
			})
		}

		const finish_failed = (message) => {
			end_tracking()
			track.paint(state)
			// a PRE-PHASE refusal (bad checksum, no supervisor, image channel…)
			// starts no phase at all: the track is all-pending, so the refusal
			// sentence IS the whole story — render it prominently.
			const is_refusal = state.last_phase===null
			// …and an all-pending table is then pure noise above that sentence:
			// drop it so the refusal is the only thing on the surface.
			if (is_refusal) {
				track.node.remove()
			}
			reveal(ui.create_dom_element({
				element_type	: 'div',
				class_name		: is_refusal ? 'dd_note state_danger update_refusal' : 'dd_note state_danger',
				text_content	: String(message || state.message || wording.failed),
				parent			: body_response
			}))
		}

		// the stream died pre-swap: INDETERMINATE — the server-side job is not
		// tied to the SSE connection and may still swap and restart later.
		// render_stream's teardown already deleted the resume key, so RESTORE it:
		// reopening the panel re-attaches to the (possibly still running) job.
		const finish_interrupted = () => {
			end_tracking()
			track.paint(state)
			data_manager.set_local_db_data(
				{ id : local_db_id, value : { pid : pid, pfile : pfile, digest : expected_digest } },
				'status'
			)
			reveal(ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning connection_lost',
				// per-run wording (run_wording): `update_code_connection_lost` for
				// an update, `update_code_restore_connection_lost` for a restore —
				// the sentence names the operation the operator must NOT start twice.
				text_content	: wording.connection_lost,
				parent			: body_response
			}))
		}

		const poll_health = () => {
			const deadline = Date.now() + 120000
			const tick = async () => {
				let version = null
				let digest = null
				try {
					const health_response = await fetch('/health')
					if (health_response.ok) {
						const health = await health_response.json()
						version = health?.version ?? null
						// null on a server older than the install stamp — the verdict
						// falls back to the version compare in that case.
						digest = health?.install_digest ?? null
					}
				} catch (_error) {
					// server still restarting: keep polling until the deadline
				}
				if (version!==null) {
					const ending = resolve_health_outcome(state, version, digest)
					if (ending.outcome==='updated') {
						finish_success(version)
						return
					}
					// NOTHING TO COMPARE AGAINST. On the panel-RESUME path both
					// tokens can be null (the stored job handle holds pid+pfile
					// only — see check_process_data), and resolve_health_outcome
					// answers 'rolled_back' for want of anything better. Reporting
					// a rollback the panel cannot see is as false as reporting a
					// success: say what is known — the server is back, on this
					// version — and let the operator compare.
					if (!state.expected_version && !state.expected_digest) {
						end_tracking()
						state = { ...state, mode:'polling' }
						track.paint(state)
						reveal(ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'dd_note state_warning update_unconfirmed',
							text_content	: (get_label.update_code_unconfirmed || 'The server is back and running version %s. This panel was reopened after the run started, so it cannot confirm by itself whether the operation completed — compare that version with the one you expected.')
								.replace('%s', String(version)),
							parent			: body_response
						}))
						return
					}
					// the server is back on the OLD version → the job rolled back
					end_tracking()
					state = { ...state, mode:'rolled_back' }
					track.paint(state)
					const rolled_back_text = wording.rolled_back
						+ (ending.message ? (' ' + ending.message) : '')
					reveal(ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'dd_note state_warning',
						text_content	: rolled_back_text,
						parent			: body_response
					}))
					return
				}
				if (Date.now() >= deadline) {
					state = { ...state, mode:'failed' }
					finish_failed(get_label.update_code_server_gone || 'The server did not come back — check the logs.')
					return
				}
				setTimeout(tick, 2000)
			}
			setTimeout(tick, 2000)
		}

	// on_done: the stream closed (final frame OR connection death)
		const on_done = () => {
			observer.disconnect()
			if (state.mode==='done') {
				finish_success(state.version)
				return
			}
			if (state.mode==='rolled_back') {
				finish_failed(wording.rolled_back
					+ (state.message ? (' ' + state.message) : ''))
				return
			}
			if (state.mode==='failed') {
				finish_failed(state.message)
				return
			}
			// the JOB itself ended (final frame seen). The terminal frame's
			// envelope is WIRE TRUTH and outranks the track: a fast install
			// whose swap/restart/done tail lands inside one poll beat delivers
			// a mid-flight track PLUS a done envelope naming the installed
			// version — that is SUCCESS, never failure.
			if (stream_final) {
				const ending = resolve_final_frame(state, final_frame)
				if (ending && ending.outcome==='updated') {
					// The terminal envelope is emitted BEFORE the restart, while
					// the rollback sentinel still reads "pending" — it means
					// "the swap landed and I am about to restart", NOT "the new
					// code is live". Forcing every phase (health included) to
					// 'done' here skipped poll_health() entirely, so the panel
					// declared success without one confirmation that the tree it
					// installed can actually boot — and reported success just
					// the same when the engine came back rolled back.
					// So: everything up to and including 'restart' is done; the
					// 'health' phase stays running and /health decides.
					state = apply_phase_frame(state, {
						phases : state.phases.map(p => ({
							id		: p.id,
							status	: p.id==='health' ? 'running' : 'done'
						}))
					})
					// expected_version is null on the panel-RESUME path; without
					// it resolve_health_outcome would read a perfectly good
					// update as 'rolled_back'.
					state = {
						...state,
						mode				: 'polling',
						expected_version	: state.expected_version || ending.version
					}
					track.paint(state)
					// the old pid/pfile mean nothing to the restarted process
					data_manager.delete_local_db_data(local_db_id, 'status')
					poll_health()
					return
				}
				// TERMINAL, BUT INTERRUPTED — NOT FAILED (2026-08-26).
				// The panel-resume path re-attaches to a job the SERVER already
				// reconciled: the operator refreshed mid-run, the swap restarted
				// the process, and boot marked the orphaned pfile 'interrupted'
				// (core/media/jobs.ts). The first frame is then terminal with the
				// reconcile marker as its only error — and this branch printed
				// "The update failed / interrupted: owning server process died"
				// over an operation that had COMPLETED, without ever asking
				// /health. That frame says the stream's owner died and nothing
				// else, which is precisely the live path's post-swap situation:
				// hand off to the same poll and let /health be the verdict.
				if (ending && ending.outcome==='interrupted') {
					state = apply_phase_frame(state, { phases : [{ id : 'health', status : 'running' }] })
					state = { ...state, mode:'polling' }
					track.paint(state)
					// the old pid/pfile mean nothing to the restarted process
					data_manager.delete_local_db_data(local_db_id, 'status')
					poll_health()
					return
				}
				state = { ...state, mode:'failed' }
				const failure_message = (ending && ending.outcome==='failed' && ending.message)
					|| state.message
					|| (final_error ? error_text(final_error) : null)
					|| wording.failed
				finish_failed(failure_message)
				return
			}
			// the stream died mid-job: let the reducer decide
			// (post-swap → polling; pre-swap → indeterminate 'interrupted')
			state = apply_phase_frame(state, { interrupted : true })
			track.paint(state)
			if (state.mode==='polling') {
				// the old pid/pfile are meaningless to the restarted process:
				// delete the resume key BEFORE polling
				data_manager.delete_local_db_data(local_db_id, 'status')
				poll_health()
			} else {
				finish_interrupted()
			}
		}

	// stream the job (persists the resume key, renders msg/stop, cleans up)
		update_process_status(local_db_id, pid, pfile, stream_node, 1000, on_done)
}//end track_process



/**
* RENDER_INFO_MODAL
* Opens a modal dialog that lets the administrator select a code version and
* start the update.
*
* Modal structure:
*   - Header: the code server's entity/host (TEXT — never markup).
*   - Body: source readout (entity/host/version) + files_container — one radio
*     row per available ZIP (version, URL, build date). The FIRST entry — the
*     server sorts ascending, so the next rung on the linear upgrade path — is
*     pre-selected; the Update button stays DISABLED until one is selected.
*   - Footer: the waive-backup row (rendered ONLY when the panel's `backup_fresh`
*     check is not `ok` — the one precondition a request may waive) + the
*     "Update" button (confirm-gated via ui.confirm; the version + host travel in
*     the injection-safe `note` slot, and a waived backup is restated there) +
*     response surface.
*
* versions_info shape (update_code.prototype.get_code_update_info):
*   {
*     info  : { version, date, entity_id, entity, host },
*     files : [{ version, url, date }]   // version is always numeric x.y.z
*   }
*
* On accept the update starts as a BACKGROUND JOB: the response's `pid` +
* `pfile` extension keys feed `track_process` on the PANEL surface and the
* modal closes.
*
* SEC-XSS-009: API error strings and update messages are written via
* `textContent` / `createTextNode`, never via `innerHTML`.
*
* EXPORTED for the browser suite (client/dedalo/test/client/js/test_update_code.js):
* the waive-backup row's whole contract is "rendered only when the pipeline
* would refuse", which is a decision, not a shape — and a source-shape gate
* cannot see a decision.
*
* @param {Object} self - update_code widget instance
* @param {Object} versions_info - result object from get_code_update_info
* @param {HTMLElement} body_response - the PANEL response surface (phase track home)
* @param {string} [asked_channel] - the channel token the list was asked with
*   ('master' when omitted): a rung the code server did not honour is said so
*   above the list (update_code_channel.js channel_shortfall_note)
* @returns {HTMLElement} modal element (already attached to the DOM)
*/
export const render_info_modal = function( self, versions_info, body_response, asked_channel ) {

	// blur any selection
		document.activeElement.blur();

	// info (what the server actually sends: version/date/entity_id/entity/host)
		const info = versions_info.info || {}

	// a CONTAINER installation: the release is installed on the Docker host
	// (the command, or a request to the host updater), never by this engine
		const image = self.value?.consumer?.image || null

	// header. TEXT only: entity + host are remote data
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			text_content	: [info.entity, info.host].filter(Boolean).join(' · ') || (get_label.update || 'Update')
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body widget_update_code'
		})

	// source readout
		body.appendChild(build_readout([
			{ k : (get_label.version || 'Version'), v : info.version, mono : true },
			{ k : (get_label.update_ontology_master_server || 'Master server'), v : info.host }
		]))

	// a rung the code server did not honour: an OLDER master answers a
	// prerelease ask as a release one (it knows only 'dev'), a master that did
	// not opt in does the same. The list below is then releases only, and must
	// not read as "there are no prereleases".
		const shortfall_note = channel_shortfall_note(asked_channel, versions_info)
		if (shortfall_note) {
			// static get_label references (the label gates read them), keyed by
			// the note the leaf decided
			const note_text = {
				update_code_channel_not_offered_prerelease			: get_label.update_code_channel_not_offered_prerelease || 'This code server does not offer prereleases: only published releases are listed.',
				update_code_channel_not_offered_prerelease_with_dev	: get_label.update_code_channel_not_offered_prerelease_with_dev || 'This code server does not offer prereleases: published releases and developer builds are listed.',
				update_code_channel_not_offered_dev					: get_label.update_code_channel_not_offered_dev || 'This code server does not offer developer builds: only the releases it publishes are listed.'
			}
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning channel_shortfall',
				text_content	: note_text[shortfall_note],
				parent			: body
			})
		}

	// files_container
		const files_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'files_container',
			parent			: body
		})

	// footer + response (declared before the loop: the loop toggles the button)
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content'
		})
		const response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response content'
		})

	// waive_backup row — the ONE precondition an operator can waive.
	// A code update REFUSES without a recent DATABASE backup
	// (core/update/preconditions.ts, backupRequire) and the refusal sentence
	// itself names the escape hatch. This is that escape hatch, put where the
	// decision is actually made — beside the Update button, not on the panel.
	// It waives the DATABASE backup only: the CODE backup is the swap itself
	// (two renames of a tree already on disk) and is never optional.
	// OFFERED ONLY WHEN IT WOULD CHANGE THE OUTCOME. The server's `backup_fresh`
	// check (core/update/status.ts) is `ok` exactly when the pipeline will not
	// refuse on this account; on an `ok` install the row is not rendered at all,
	// so the panel never invites anyone to disarm a guard that is not in the way.
	// The predicate is SHARED with the readiness headline (render_update_status)
	// — a headline naming a waiver this modal does not offer, or a checkbox the
	// headline never warned about, would be the same panel/pipeline disagreement
	// from the other side.
		// declared BEFORE mount_waive_row: the row inserts itself above the
		// button, and `let` in the same block would leave it in the TDZ.
		let button_update = null
		let image_panel = null
		let waive_backup_input = null
		const mount_waive_row = function(check) {
			if (waive_backup_input!==null) {
				return waive_backup_input
			}
			const waive_backup_row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'waive_backup_row',
				parent			: footer
			})
			// it must precede the Update button even when mounted LATE (the
			// deadline-crossing path below): the caution is read, not stumbled on.
			if (button_update && button_update.parentNode===footer) {
				footer.insertBefore(waive_backup_row, button_update)
			}
			// label WRAPS the input (the house pattern, same as channel_row):
			// the click target is the whole row without an id/for pair to keep in sync.
			const waive_backup_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'waive_backup_label',
				text_content	: get_label.update_code_waive_backup || 'Update without a recent database backup',
				parent			: waive_backup_row
			})
			waive_backup_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'waive_backup_check',
				name			: 'update_code_waive_backup'
			})
			waive_backup_label.prepend(waive_backup_input)
			// the age FACT, when the server measured one ('none' means no backup
			// was found at all). The server sends facts, the client the wording.
			const backup_age = Number(check.detail)
			const note_text = (get_label.update_code_waive_backup_note || 'The database will not be restorable if the update goes wrong. Make a backup first whenever you can; every waiver is recorded in the server log with your user.')
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note waive_backup_note state_warning',
				text_content	: Number.isFinite(backup_age)
					? ((get_label.update_code_check_backup_fresh || 'Recent database backup') + ': ' + String(backup_age) + ' h — ' + note_text)
					: note_text,
				parent			: waive_backup_row
			})

			return waive_backup_input
		}
		// the waiver belongs to the in-container update, which an image
		// installation never runs: its own update script takes the backup
		const backup_check = image ? null : backup_waiver_check(self.value?.consumer)
		if (backup_check) {
			mount_waive_row(backup_check)
		}

	// files. One radio row each; the <label> WRAPS the input (no ids), the
	// group name is per-modal.
		const group_name = 'update_code_version_' + (++modal_seq)
		const files = versions_info.files || []
		const files_length = files.length
		const valid_files = []
		for (let i = 0; i < files_length; i++) {

			const current_version = files[i];

			// a prerelease row is named by its identity (7.0.1-beta.2), never by
			// the bare data triple its `version` carries; a malformed one is
			// not offered at all (item_release → null)
			const release_name = item_release(current_version)
			if (release_name===null) {
				continue
			}

			const file_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'file_container',
				parent			: files_container
			})
			file_container.dataset.version = String(current_version.version ?? '')
			const version_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'version_label unselectable',
				text_node		: release_name,
				parent			: file_container
			})

			// input radio (wrapped by the label: no id needed, exactly as the
			// shared server picker does)
			const input_radio = ui.create_dom_element({
				element_type	: 'input',
				type			: 'radio',
				name			: group_name,
				value			: current_version.url
			})

			// change event handler
			const change_handler = () => {
				files.forEach( el => { delete el.active } )
				current_version.active = input_radio.checked
				body.querySelectorAll('.version_label, .value').forEach( el => { el.classList.remove('active') } )
				version_label.classList.add('active')
				value_node.classList.add('active')
				date_node.classList.add('active')
				if (button_update) {
					button_update.disabled = false
				}
				if (image_panel) {
					image_panel.select(current_version)
				}
			}
			input_radio.addEventListener('change', change_handler)
			input_radio.addEventListener('click', (e) => {
				e.stopPropagation()
			})

			// value (URL)
			const value_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: String(current_version.url ?? ''),
				parent			: version_label
			})

			// date
			const date_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value date',
				text_content	: String(current_version.date || ''),
				parent			: version_label
			})

			version_label.prepend(input_radio)

			// what the release changes, BEFORE it is chosen (published items only:
			// the code server's frozen changes/<version>/release.json notes)
			render_release_notes(file_container, current_version.notes)

			// by default the first OFFERED row is pre-selected. The server sorts ASCENDING
			// (code_manifest.ts linearUpgradeTargets), so index 0 is the NEXT
			// rung on the linear upgrade path — the only choice the consumer's
			// assertLinearUpgrade accepts. Never "the newest": picking the last
			// entry would offer a version the install cannot legally jump to.
			if(valid_files.length===0){
				input_radio.checked = true
				current_version.active = true
				version_label.classList.add('active')
			}

			// add to valid_files
			valid_files.push(current_version)
		}//end for (let i = 0; i < files_length; i++)

		if (valid_files.length===0) {

			// No updates found: the server has no ZIP newer than this version.
			// The full server response is dumped as JSON for diagnostics.
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'content',
				text_content	: get_label.update_code_no_updates || 'There are no updates available for your version.',
				parent			: response
			})
			ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'content',
				text_content	: JSON.stringify(versions_info, null, 2),
				parent			: response
			})

		}else if (image) {

			// container installation: the host command for the selected release,
			// and the request button when the host updater can take it
				image_panel = render_image_command_panel(self, image, footer, response, body_response, () => modal)
				image_panel.select(files.find(el => el.active===true) || null)

		}else{

			// button_update. DISABLED until a version is selected (index 0 is
			// pre-selected, so it starts enabled with a valid selection).
				button_update = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'success',
					inner_html		: get_label.update || 'Update',
					parent			: footer
				})
				button_update.disabled = !files.some(el => el.active===true)

				// click event
				const click_handler = async (e) => {
					e.stopPropagation()

					// inline validation: a version file must be chosen
					const file_active = files.find(el => el.active === true)
					if (!file_active) {
						button_update.disabled = true
						response.textContent = get_label.empty_selection || 'Empty selection'
						response.classList.add('error')
						return
					}
					response.classList.remove('error')

					// THE DEADLINE CAN FALL WHILE THE MODAL IS OPEN. The panel
					// value is re-seeded when the modal opens, but freshness ages:
					// a backup at 23.9 h renders no checkbox, and six minutes later
					// the very same request is refused for a stale backup — the job
					// answering with the byte-frozen sentence that names a wire flag
					// the operator has no control for, which is precisely the dead
					// end this feature exists to abolish, narrowed to a window.
					// So re-ask right here, and if a waiver has become necessary,
					// MOUNT the row and stop instead of submitting a refusal.
					if (waive_backup_input===null) {
						try {
							const late_value = await self.get_value()
							if (late_value) {
								self.value = late_value
								const late_check = backup_waiver_check(late_value.consumer)
								if (late_check) {
									mount_waive_row(late_check)
									response.textContent = get_label.update_code_waive_backup_now_required
										|| 'The database backup went stale while this dialog was open. Make a backup, or accept the waiver below, then press Update again.'
									response.classList.add('error')
									return
								}
							}
						} catch (error) {
							// never block the update on a failed re-ask: the server
							// still refuses correctly if the backup really did age
							console.error('update_code: could not re-check backup freshness before submitting', error)
						}
					}

					// the operator's explicit waiver of the recent-backup
					// precondition. `false` whenever the row was not offered
					// (waive_backup_input stays null on a fresh-backup install).
					const waive_backup = waive_backup_input?.checked === true

					// confirm. The version + host are DATA → the `note` text slot.
					// A waived backup is restated HERE, at the last gate: the
					// checkbox is one click, the consequence is not.
					const accepted = await ui.confirm({
						header			: get_label.update || 'Update',
						note			: (get_label.update_code_confirm_note || 'install version %s from %s')
							.replace('%s', String(file_active.version ?? ''))
							.replace('%s', String(info.host ?? ''))
							+ (waive_backup
								? ' ' + (get_label.update_code_waive_backup_confirm || 'without a recent database backup')
								: ''),
						body			: get_label.sure || 'Are you sure?',
						accept_label	: get_label.update || 'Update'
					})
					if (accepted!==true) {
						return
					}

					button_update.classList.add('hide')
					body.classList.add('loading')

					// spinner
					const spinner = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'spinner',
						parent			: footer
					})

					// update_code. Submits the BACKGROUND JOB; the response returns
					// immediately with `pid` + `pfile` extension keys.
					const api_response = await self.update_code({
						info			: info,
						file_active		: file_active,
						waive_backup	: waive_backup
					})

					body.classList.remove('loading')
					spinner.remove()

					// the update's own findings: EXTENSION KEYS of the success body —
					// a FAILURE says it once, coded, through `error`.
					const update_errors = response_extension(api_response, 'errors') || []
					const pid	= response_extension(api_response, 'pid')
					const pfile	= response_extension(api_response, 'pfile')
					if (request_failed(api_response) || !response_data(api_response) || update_errors.length || !pid || !pfile) {

						// SEC-XSS-009: shell/git output may contain HTML
						// metacharacters — TEXT nodes only.
						response.replaceChildren()
						if (update_errors.length) {
							update_errors.forEach((err, idx) => {
								if (idx > 0) response.appendChild(document.createElement('br'))
								response.appendChild(document.createTextNode(String(err)))
							})
						} else {
							response.textContent = request_failed(api_response)
								? error_text(api_response.error)
								: (response_extension(api_response, 'msg') || 'Unknown error on API update_code')
						}
						button_update.classList.remove('hide')
						return
					}

					// job accepted: close the modal, follow it on the panel surface
					if (typeof modal.close==='function') {
						modal.close()
					}
					// the expectation is the RELEASE IDENTITY /health will answer
					// (a prerelease's 7.0.1-beta.2, a release's 7.0.1), never the
					// bare triple: a same-triple walk (beta.6 → beta.7) leaves the
					// triple unchanged on both sides of the swap
					track_process(
						pid,
						pfile,
						body_response,
						item_release(file_active) || null,
						String(file_active.sha256 ?? '') || null
					)
				}
				button_update.addEventListener('click', click_handler)
				// Focus the Update button immediately so keyboard users can confirm
				// without moving focus away from the modal.
				dd_request_idle_callback(
					() => {
						button_update.focus()
					}
				)
		}

	// response add at end (after buttons)
		footer.appendChild(response)

	// modal
	// Size override: 65rem wide to accommodate the long ZIP URLs in the file list.
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'normal',
			callback	: (dd_modal) => {
				dd_modal.modal_content.style.width = '65rem'
			}
		})
		modal.classList.add('widget_update_code_modal')


	return modal
}//end render_info_modal



/**
* RENDER_RELEASE_NOTES
* One release's notes under its row in the version modal: the *Action needed*
* titles first (what the operator must do when updating across it), then every
* change with its kind. Titles are the change log's own fragment
* titles, set as TEXT. Nothing is drawn for an item without notes (a developer
* build, or a release cut before notes existed).
* @param {HTMLElement} parent - the release row
* @param {Object|undefined} notes - {date, action_needed:[], entries:[{type, audience, title}]}
* @returns {HTMLElement|null}
*/
export const render_release_notes = function(parent, notes) {

	if (!notes || !Array.isArray(notes.entries)) {
		return null
	}

	const block = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'release_notes',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'summary',
		class_name		: 'release_notes_summary',
		text_content	: `${get_label.update_code_release_notes || 'Release notes'} · ${String(notes.date || '')}`,
		parent			: block
	})

	const action_needed = Array.isArray(notes.action_needed) ? notes.action_needed : []
	if (action_needed.length) {
		block.open = true // an action the operator must take is never folded away
		const warning = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_warning release_action_needed',
			text_content	: get_label.update_code_action_needed || 'Action needed when you update',
			parent			: block
		})
		const list = ui.create_dom_element({ element_type : 'ul', parent : warning })
		action_needed.forEach(title => {
			ui.create_dom_element({ element_type : 'li', text_content : String(title), parent : list })
		})
	}

	const entries = ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'release_note_entries',
		parent			: block
	})
	notes.entries.forEach(entry => {
		const li = ui.create_dom_element({ element_type : 'li', parent : entries })
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'dd_badge release_note_type',
			text_content	: get_label['update_code_change_' + entry.type] || String(entry.type),
			parent			: li
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'release_note_title',
			text_content	: String(entry.title),
			parent			: li
		})
	})

	return block
}//end render_release_notes



/**
* COPY_TEXT
* Puts `text` on the clipboard and says so on the button. A browser that
* refuses (an insecure origin, a denied permission) leaves the command on
* screen to be selected by hand — the button says it could not copy.
* @param {HTMLElement} button
* @param {string} text
* @returns {Promise<void>}
*/
const copy_text = async function(button, text) {

	try {
		await navigator.clipboard.writeText(text)
		button.textContent = get_label.update_code_copied || 'Copied'
	} catch (_error) {
		button.textContent = get_label.update_code_copy_failed || 'Select and copy it by hand'
	}
}//end copy_text



/**
* RENDER_IMAGE_COMMAND_PANEL
* The footer of the version modal on a CONTAINER installation.
*
* For the selected release it shows the host command, composed from the
* server's facts only (image_update_command: the program + flag the panel was
* told, the tag from the manifest item's own `X.Y.Z` — a version outside that
* grammar shows NO command, since this text is pasted into a root shell), with
* a Copy button and where to run it.
*
* "Request this update" is offered ONLY when the host updater says it is alive
* and nothing is pending — the same conditions the server refuses on, read from
* the same panel value; the server still decides.
*
* @param {Object} self - update_code widget instance
* @param {Object} image - value.consumer.image
* @param {HTMLElement} footer
* @param {HTMLElement} response - the modal's response surface
* @param {HTMLElement} body_response - the PANEL response surface
* @param {Function} get_modal - () => the modal (attached after this runs)
* @returns {{select: Function}} select(item) re-states the panel for a release
*/
const render_image_command_panel = function(self, image, footer, response, body_response, get_modal) {

	const panel = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'image_command_panel',
		parent			: footer
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_eyebrow',
		text_content	: get_label.update_code_image_command || 'Update command',
		parent			: panel
	})
	const command_row = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'image_command_row',
		parent			: panel
	})
	const command_node = ui.create_dom_element({
		element_type	: 'code',
		class_name		: 'image_command mono',
		parent			: command_row
	})
	const button_copy = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'light button_copy_command',
		text_content	: get_label.copy || 'Copy',
		parent			: command_row
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_note image_command_note',
		text_content	: get_label.update_code_image_command_note || 'Run it on the Docker host, in the stack directory (the one holding .dedalo.env). It takes a database backup, installs the image, and rolls back by itself if the new version does not come up healthy.',
		parent			: panel
	})

	const can_request = (image.host_updater || {}).state==='alive' && !image.request
	const button_request = can_request
		? ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'success button_request_image_update',
			text_content	: get_label.update_code_image_request_update || 'Request this update',
			parent			: panel
		})
		: null

	let selected = null
	button_copy.addEventListener('click', (e) => {
		e.stopPropagation()
		if (command_node.textContent) {
			copy_text(button_copy, command_node.textContent)
		}
	})
	if (button_request) {
		button_request.addEventListener('click', async (e) => {
			e.stopPropagation()
			if (!selected || image_command_tag(selected)===null) {
				return
			}
			button_request.disabled = true
			const request = await submit_image_request(self, selected, response)
			if (!request) {
				button_request.disabled = false
				return
			}
			const modal = get_modal()
			if (modal && typeof modal.close==='function') {
				modal.close()
			}
			follow_image_request(self, request, body_response)
		})
	}

	return {
		select : (item) => {
			selected = item
			const command = item ? image_update_command(image, item) : null
			command_node.textContent = command || ''
			button_copy.textContent = get_label.copy || 'Copy'
			button_copy.disabled = command===null
			if (button_request) {
				button_request.disabled = command===null
			}
		}
	}
}//end render_image_command_panel



/**
* IMAGE_REFUSAL_TEXT
* A request refusal, worded from labels by its `coordinates.reason` id; the
* server's own sentence when the id has no label yet.
* @param {Object} error - the envelope's error
* @returns {string}
*/
const image_refusal_text = function(error) {

	const reason = error?.coordinates?.reason
	const label = reason ? get_label['update_code_image_refused_' + reason] : null

	return label || error_text(error)
}//end image_refusal_text



/**
* SUBMIT_IMAGE_REQUEST
* Records the request for one release. A refusal is written in the modal's
* response surface (TEXT), and the modal stays open.
* @param {Object} self
* @param {Object} item - the selected manifest item
* @param {HTMLElement} response
* @returns {Promise<Object|null>} the recorded request, or null
*/
const submit_image_request = async function(self, item, response) {

	response.classList.remove('error')
	response.textContent = ''
	const api_response = await self.request_image_update({
		version	: String(item.version ?? ''),
		channel	: channel_token(item.channel),
		...(item.channel==='prerelease' ? { release : String(item.release ?? '') } : {})
	})
	if (request_failed(api_response)) {
		response.textContent = image_refusal_text(api_response.error)
		response.classList.add('error')
		return null
	}

	return response_data(api_response)?.request || null
}//end submit_image_request



/**
* CANCEL_IMAGE_REQUEST
* Withdraws the pending request (the image block's Cancel), then re-reads the
* panel. A request the host already claimed is refused by the server, worded
* by its reason.
* @param {Object} self
* @param {HTMLElement} body_response
* @returns {Promise<void>}
*/
const cancel_image_request = async function(self, body_response) {

	body_response.replaceChildren()
	const api_response = await self.cancel_image_update_request()
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: request_failed(api_response) ? 'dd_note state_danger' : 'dd_note state_ok',
		text_content	: request_failed(api_response)
			? image_refusal_text(api_response.error)
			: (get_label.update_code_image_cancelled || 'The update request was cancelled.'),
		parent			: body_response
	})
	if (typeof self.refresh_consumer==='function') {
		await self.refresh_consumer()
	}
}//end cancel_image_request



/**
* IMAGE_FOLLOW_DEADLINE_MS
* How long the panel follows a request: the host updater's own unit allows an
* update two hours (TimeoutStartSec), a build-mode update with a large database
* backup can use much of that. Past it the panel stops following and says so —
* the outcome is still recorded, and shown, on the next panel read.
*/
const IMAGE_FOLLOW_DEADLINE_MS = 2 * 60 * 60 * 1000



/**
* FOLLOW_IMAGE_REQUEST
* Follows a recorded request to its outcome, on the panel surface.
*
* Two sources, one at a time. While the engine answers, the panel value says
* where the request is (`request.state`: requested → claimed) and, once the host
* recorded it, the outcome (`last_outcome.request_id` === this request). When
* the engine stops answering — the host is replacing its container — the panel
* switches to `GET /health`, the same unauthenticated probe the in-place update
* ends on, until an engine answers again. Which version answers is NOT the
* verdict (the new one, or the old one after a rollback, both answer): the
* panel goes back to the panel value for the recorded outcome — the host wrote
* it, this side only reads it.
*
* @param {Object} self
* @param {Object} request - the recorded request (data.request)
* @param {HTMLElement} body_response
* @returns {void}
*/
const follow_image_request = function(self, request, body_response) {

	body_response.replaceChildren()
	const note = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_note state_warning image_follow_note',
		text_content	: get_label.update_code_image_requested || 'Update requested. The host updater starts it within a minute; this panel follows it.',
		parent			: body_response
	})
	const deadline = Date.now() + IMAGE_FOLLOW_DEADLINE_MS

	const finish = async (outcome) => {
		if (typeof self.refresh_consumer==='function') {
			await self.refresh_consumer()
		}
		note.className = outcome.status==='green' ? 'dd_note state_ok image_follow_note' : 'dd_note state_danger image_follow_note'
		note.textContent = `${get_label['update_code_image_outcome_' + outcome.status] || outcome.status}: ${outcome.from || '—'} → ${outcome.to || '—'} (${outcome.detail})`
		if (outcome.status==='green') {
			// the browser still holds the OLD modules (same as the in-place update)
			const reload_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light',
				text_content	: get_label.update_code_reload_now || 'Reload now',
				parent			: note
			})
			reload_button.addEventListener('click', (e) => {
				e.stopPropagation()
				login.quit()
			})
		}
	}

	const read_panel = async () => {
		try {
			const value = await self.get_value()
			return value?.consumer?.image ? value.consumer.image : null
		} catch (_error) {
			return null
		}
	}

	const read_health = async () => {
		try {
			const health_response = await fetch('/health')
			return health_response.ok ? ((await health_response.json())?.version ?? null) : null
		} catch (_error) {
			return null
		}
	}

	let engine_gone = false
	const tick = async () => {
		if (Date.now() >= deadline) {
			note.textContent = get_label.update_code_image_follow_timeout || 'This panel stopped following the update. Reopen it later to see the outcome.'
			return
		}
		if (engine_gone) {
			const version = await read_health()
			if (version!==null) {
				// an engine is back — the new one, or the old one after a rollback;
				// the recorded outcome says which
				engine_gone = false
				note.textContent = get_label.update_code_image_engine_back || 'The engine is back; reading the recorded outcome…'
			}
			setTimeout(tick, 3000)
			return
		}
		const image = await read_panel()
		if (image===null) {
			engine_gone = true
			note.textContent = get_label.update_code_image_waiting_engine || 'The engine is being replaced on the Docker host…'
			setTimeout(tick, 3000)
			return
		}
		const outcome = image.last_outcome
		if (!image.request && outcome && outcome.request_id===request.id) {
			finish(outcome)
			return
		}
		if (!image.request || image.request.id!==request.id) {
			// cancelled (here or by another administrator), or replaced: nothing
			// of THIS request is left to follow
			note.textContent = get_label.update_code_image_request_gone || 'The request is no longer pending, and no outcome was recorded for it.'
			if (typeof self.refresh_consumer==='function') {
				self.refresh_consumer()
			}
			return
		}
		if (image.request.state==='claimed') {
			note.textContent = get_label.update_code_image_request_claimed_note || 'The host updater is installing the update (backup, image, health check)…'
		}
		// every panel read re-probes the code servers: a calm pace
		setTimeout(tick, 10000)
	}
	setTimeout(tick, 5000)
}//end follow_image_request



/**
* DELETE_RESTORE_POINT
* Removes one restore point, after a confirmation that NAMES it.
*
* No modal and no phase track: unlike a restore this swaps nothing, restarts
* nothing and takes no lock — it is one request whose answer is a verdict. The
* server verifies the directory is actually gone before answering (see
* core/update/restore_points.ts removeRestorePointDir), so a success here is a
* statement about the disk and not about the request.
*
* The panel never offers this on the point the server marked `deletable:false`
* — the rollback for the running code — so the confirm is about "this copy",
* never about "your only way back".
*
* @param {Object} self - update_code widget instance
* @param {Object} point - the restore point row {name, version, …}
* @param {HTMLElement} body_response - where the outcome is rendered
* @returns {Promise<void>}
*/
const delete_restore_point = async function(self, point, body_response) {

	const accepted = await ui.confirm({
		header			: get_label.update_code_delete_point || 'Delete restore point',
		// the NAME is in the question: several points differ only by timestamp,
		// and "are you sure?" about an unnamed one is not a question.
		body			: (get_label.update_code_delete_point_confirm
			|| 'Delete the restore point %s? The code copy it holds is removed from disk and cannot be recovered.')
			.replace('%s', String(point.name)),
		accept_label	: get_label.delete || 'Delete'
	})
	if (accepted!==true) {
		return
	}

	while (body_response.firstChild) {
		body_response.removeChild(body_response.firstChild)
	}
	const spinner = ui.create_dom_element({ element_type : 'div', class_name : 'spinner' })
	body_response.prepend(spinner)
	try {
		const api_response = await self.delete_restore_point({ name : point.name })
		if (request_failed(api_response)) {
			// ONE error model: policy + renderer decide the surface. A PARTIAL
			// delete arrives here — the server refuses rather than claiming a
			// removal it could not verify — and its sentence names what survived.
			await handle_api_error(api_response.error, {wrapper: body_response})
			return
		}
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_ok',
			text_content	: String(response_extension(api_response, 'msg')
				|| (get_label.update_code_delete_point_done || 'Restore point deleted.')),
			parent			: body_response
		})
	} finally {
		spinner.remove()
		// the list beside the button is a claim about the disk that this call
		// just changed — re-read it, exactly as a build does.
		if (typeof self.refresh_consumer==='function') {
			await self.refresh_consumer()
		}
	}
}//end delete_restore_point



/**
* RENDER_RESTORE_MODAL
* The confirm dialog for putting a previous code tree back into place.
*
* A restore is not an undo. Three facts decide whether an operator should press
* the button, and all three are stated here rather than left to be inferred:
*
*   1. WHICH CODE — from the running version TO the restore point's version,
*      named on the same line, because "restore" alone says nothing about which
*      direction the installation moves in.
*   2. THE DATABASE IS NOT MOVED WITH IT. Migrations already applied stay
*      applied; older code meeting a newer schema is the real hazard of this
*      button and the reason the version-changing case needs an explicit,
*      logged acknowledgement (`confirm_downgrade`) exactly like `waive_backup`
*      above — the checkbox is the ONLY waiver, and the server refuses without it.
*   3. NOTHING IS LOST. The swap is two renames: the live tree does not
*      disappear, it becomes a new restore point.
*
* SAME VERSION, NO CHECKBOX. Restoring a point that declares the version already
* running (the developer-channel case: a branch build installed over its own
* release) carries no schema hazard, so no waiver is asked for — a guard offered
* where it changes nothing teaches operators to tick guards.
*
* On accept the restore starts as a BACKGROUND JOB with the SAME frames as an
* update, so it is followed by the SAME `track_process` on the panel surface —
* under its own resume key (LOCAL_DB_ID_RESTORE).
*
* SEC-XSS-009: every server-sent value (the point's name, version, digest) is
* written via `textContent`, never `innerHTML`.
*
* EXPORTED for the browser suite (client/dedalo/test/client/js/test_update_code.js):
* "the submit unlocks only when the checkbox is ticked, and only when the versions
* differ" is a decision, not a shape, and a source-shape gate cannot see one.
*
* THE COMPARISON BASIS IS THE SERVER'S, NOT THE PAGE'S (2026-08-25 review).
* `page_globals.dedalo_version` is DEDALO_ENGINE_VERSION, which carries the
* prerelease tag — '7.0.1-dev' on a dev checkout or a dev-channel install —
* while the pipeline compares `DEDALO_DATA_VERSION.join('.')`, a bare
* '7.0.1'. Read from the page, every developer-channel restore of its OWN
* version drew the downgrade waiver, locked the button behind it, and then had
* the server log a "VERSION CHANGE CONFIRMED … from 7.0.1 to 7.0.1" audit line
* for a change that was not one — the panel/pipeline disagreement this widget's
* headers forbid, in the exact case this header calls the no-checkbox case.
* `running_version` is `value.consumer.engine.version`: the string the server
* itself compares.
*
* @param {Object} self - update_code widget instance
* @param {Object} point - one value.consumer.restore_points[] entry:
*   {name, stamp, bootable, version, bun_pin, digest, restorable, restorable_reason}
* @param {HTMLElement} body_response - the PANEL response surface (phase track home)
* @param {string} running_version - value.consumer.engine.version, the BARE
*   version triple the server's own compare uses
* @returns {HTMLElement} modal element (already attached to the DOM)
*/
export const render_restore_modal = function( self, point, body_response, running_version ) {

	// blur any selection
		document.activeElement.blur();

	// the two ends of the move. The running version is the SERVER's bare triple
	// (see above) — the restore point's is what its own version.ts declares
	// (null when it cannot be read: then the version compare cannot be made and
	// the waiver is asked for, never skipped).
		const from_version		= String(running_version || page_globals.dedalo_data_version || '')
		const to_version		= point.version ? String(point.version) : null
		const version_changes	= to_version===null || to_version!==from_version

	// header. TEXT only: the directory name is disk data
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			text_content	: get_label.update_code_restore_confirm || 'Restore this code copy'
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body widget_update_code'
		})

	// what moves where
		body.appendChild(build_readout([
			{ k : (get_label.update_code_restore_from || 'Currently running'), v : from_version, mono : true },
			{ k : (get_label.update_code_restore_to || 'Will run after the restore'), v : to_version, mono : true },
			// its OWN key: `update_code_restore_points` is the panel SECTION title
			// (plural), and used here it read "Restore points: dedalo_7.0.0_…" —
			// a list heading labelling one directory name.
			{ k : (get_label.update_code_restore_point_name || 'Restore point'), v : point.name, mono : true },
			{ k : (get_label.update_code_install_digest || 'Installed archive'), v : point.digest, mono : true }
		]))

	// the two consequences, in plain words. They are NOTES, not warnings, in the
	// shared severity vocabulary: the migration one is a hazard (state_warning),
	// the new-restore-point one is a reassurance and must not read as an alarm.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_warning restore_note_migrations',
			text_content	: get_label.update_code_restore_note_migrations || 'Database changes already applied are NOT undone: only the code goes back. Older code running against a newer database can fail.',
			parent			: body
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note restore_note_becomes_restore_point',
			text_content	: get_label.update_code_restore_note_becomes_restore_point || 'Nothing is deleted: the code running now is kept as a new restore point, so this move can be undone the same way.',
			parent			: body
		})

	// footer + response
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content'
		})
		const response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response content'
		})

	// button_restore, declared before the checkbox that gates it
		const button_restore = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'success button_restore_submit',
			inner_html		: get_label.update_code_restore || 'Restore',
			parent			: footer
		})

	// confirm_downgrade row — the version-changing case's ONE waiver, put where
	// the decision is made (beside the button), exactly as waive_backup is.
	// Same house pattern: the <label> WRAPS the input, so the whole row is the
	// click target without an id/for pair to keep in sync.
		let confirm_downgrade_input = null
		if (version_changes) {

			const confirm_row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'confirm_downgrade_row',
				parent			: footer
			})
			const confirm_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'confirm_downgrade_label',
				text_content	: (get_label.update_code_restore_confirm_downgrade || 'I understand this installation will run version %s while the database stays as it is')
					.replace('%s', to_version || '—'),
				parent			: confirm_row
			})
			confirm_downgrade_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'confirm_downgrade_check',
				name			: 'update_code_confirm_downgrade'
			})
			confirm_label.prepend(confirm_downgrade_input)
			// the button stays locked until the waiver is given: the server
			// refuses without it, and a submit that can only fail is not an offer
			button_restore.disabled = true
			confirm_downgrade_input.addEventListener('change', () => {
				button_restore.disabled = confirm_downgrade_input.checked!==true
			})
			// the row moves BELOW the readout and ABOVE the button in source
			// order too — insertBefore keeps the button last in the footer
			footer.insertBefore(confirm_row, button_restore)
		}

	// click event
		const click_handler = async (e) => {
			e.stopPropagation()

			response.classList.remove('error')

			// busy guard: the update and the restore share the server's run lock
				if (await job_in_progress()) {
					response.textContent = get_label.update_code_busy || 'An update is already running.'
					response.classList.add('error')
					return
				}

			const confirm_downgrade = confirm_downgrade_input?.checked === true

			// confirm. The versions are DATA → the injection-safe `note` slot.
			const accepted = await ui.confirm({
				header			: get_label.update_code_restore || 'Restore',
				note			: (get_label.update_code_restore_confirm || 'Restore this code copy')
					+ ': ' + from_version + ' → ' + (to_version || '—'),
				body			: get_label.sure || 'Are you sure?',
				accept_label	: get_label.update_code_restore || 'Restore'
			})
			if (accepted!==true) {
				return
			}

			// button_spinner: the ring lives ON the button while the submit is in
			// flight (the area_maintenance widget convention) — no separate
			// spinner node competing with it for the operator's attention.
			button_restore.disabled = true
			button_restore.classList.add('button_spinner')

			// restore_code. Submits the BACKGROUND JOB; the response returns
			// immediately with `pid` + `pfile` extension keys.
			const api_response = await self.restore_code({
				name				: point.name,
				confirm_downgrade	: confirm_downgrade
			})

			button_restore.classList.remove('button_spinner')

			// the restore's own findings: EXTENSION KEYS of the success body —
			// a FAILURE says it once, coded, through `error`.
			const restore_errors	= response_extension(api_response, 'errors') || []
			const pid				= response_extension(api_response, 'pid')
			const pfile				= response_extension(api_response, 'pfile')
			if (request_failed(api_response) || !response_data(api_response) || restore_errors.length || !pid || !pfile) {

				// SEC-XSS-009: server sentences and shell output may contain HTML
				// metacharacters — TEXT nodes only.
				response.replaceChildren()
				if (restore_errors.length) {
					restore_errors.forEach((err, idx) => {
						if (idx > 0) response.appendChild(document.createElement('br'))
						response.appendChild(document.createTextNode(String(err)))
					})
				} else {
					response.textContent = request_failed(api_response)
						? error_text(api_response.error)
						: (response_extension(api_response, 'msg') || 'Unknown error on API restore_code')
				}
				response.classList.add('error')
				button_restore.disabled = false
				return
			}

			// job accepted: close the modal, follow it on the panel surface with
			// the SAME tracker the update uses — under the RESTORE resume key.
			if (typeof modal.close==='function') {
				modal.close()
			}
			track_process(
				pid,
				pfile,
				body_response,
				to_version,
				point.digest ? String(point.digest) : null,
				true,
				LOCAL_DB_ID_RESTORE,
				'restore'
			)
		}
		button_restore.addEventListener('click', click_handler)

	// response add at end (after buttons)
		footer.appendChild(response)

	// modal
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'normal'
		})
		modal.classList.add('widget_update_code_modal', 'widget_update_code_restore_modal')

	// Focus the Restore button so keyboard users can confirm without leaving the
	// modal — unless the waiver gates it, where focus belongs on the checkbox.
		dd_request_idle_callback(
			() => {
				if (confirm_downgrade_input) {
					confirm_downgrade_input.focus()
				} else {
					button_restore.focus()
				}
			}
		)


	return modal
}//end render_restore_modal



// @license-end
