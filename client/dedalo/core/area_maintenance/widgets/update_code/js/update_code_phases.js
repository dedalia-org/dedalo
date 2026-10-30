// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0



/**
* UPDATE_CODE_PHASES
* Pure state machine for the update_code progress track. NO imports, NO DOM:
* render_update_code.js feeds it stream frames and paints the returned state;
* test/unit/client_update_code_render.test.ts drives it directly.
*
* Frame contract (the server's background-job stream, `data` of each SSE chunk):
*   { phase, phases:[{id,status}], version, expected_version, message?,
*     rollback?:{performed,to} }
* phase  ∈ download|verify|extract|deps|preflight|swap|restart|health
* status ∈ pending|running|done|failed|skipped
*
* A synthetic `{interrupted:true}` frame means THE STREAM DIED — and ONLY that.
* The server-side job is not tied to the SSE connection, so where the job was
* decides what the death means: the swap/restart kills the serving process BY
* DESIGN, so an interruption at or after `swap` switches to health-polling;
* before `swap` the death is INDETERMINATE — the connection is gone but the
* job may still be running (a dropped stream during a long deps/preflight) —
* so the mode is `interrupted`, never `failed`. Only a frame that actually
* reports a failed phase (or a rollback) may say failed.
*/



/** The fixed phase order of the server-side update job. */
export const UPDATE_PHASES = ['download','verify','extract','deps','preflight','swap','restart','health']

const phase_index = (id) => UPDATE_PHASES.indexOf(id)



/**
* INIT_PHASE_STATE
* @param {string|null} [expected_version] - the version the job installs
* @param {string|null} [expected_digest] - sha256 of the ARCHIVE the job installs.
*   On a developer build the version is identical before and after the swap, so
*   this is the only token that tells the new tree from a rolled-back one.
* @returns {Object} state
*/
export const init_phase_state = function(expected_version=null, expected_digest=null) {
	return {
		phases				: UPDATE_PHASES.map(id => ({ id : id, status : 'pending' })),
		last_phase			: null,			// last phase id the stream reported
		mode				: 'streaming',	// streaming | polling | interrupted | done | failed | rolled_back
		message				: null,			// last human message (the last error sentence on failure)
		version				: null,			// version the server last reported
		expected_version	: expected_version,
		expected_digest		: expected_digest,	// sha256 of the archive being installed
		rollback			: null			// {performed, to} when the server rolled back
	}
}//end init_phase_state



/**
* APPLY_PHASE_FRAME
* Pure reducer: returns a NEW state, never mutates the given one.
* @param {Object} state - current state (init_phase_state shape)
* @param {Object} frame - stream frame, or the synthetic {interrupted:true}
* @returns {Object} next state
*/
export const apply_phase_frame = function(state, frame) {

	const next = {
		...state,
		phases : state.phases.map(p => ({ ...p }))
	}

	if (!frame || typeof frame!=='object') {
		return next
	}

	// interrupted: the stream died without a final frame.
	// At/after swap the restart is the PLANNED death → poll /health.
	// Before swap the DEATH IS INDETERMINATE: the job is not tied to the SSE
	// connection and may still be running server-side → 'interrupted' (the
	// caller keeps the resume key and tells the operator), NEVER 'failed'.
	if (frame.interrupted===true) {
		const reached = state.last_phase===null ? -1 : phase_index(state.last_phase)
		next.mode = (reached >= phase_index('swap'))
			? 'polling'
			: 'interrupted'
		return next
	}

	// phase statuses
	if (Array.isArray(frame.phases)) {
		for (const reported of frame.phases) {
			const row = next.phases.find(p => p.id===reported.id)
			if (row && typeof reported.status==='string') {
				row.status = reported.status
			}
		}
	}
	if (typeof frame.phase==='string' && phase_index(frame.phase)!==-1) {
		next.last_phase = frame.phase
	}
	if (typeof frame.message==='string' && frame.message.length>0) {
		next.message = frame.message
	}
	if (typeof frame.version==='string') {
		next.version = frame.version
	}
	if (typeof frame.expected_version==='string') {
		next.expected_version = frame.expected_version
	}
	if (frame.rollback && typeof frame.rollback==='object') {
		next.rollback = frame.rollback
	}

	// derived mode
	if (next.rollback && next.rollback.performed===true) {
		next.mode = 'rolled_back'
	} else if (next.phases.some(p => p.status==='failed')) {
		next.mode = 'failed'
	} else if (next.phases.every(p => p.status==='done' || p.status==='skipped')) {
		next.mode = 'done'
	}

	return next
}//end apply_phase_frame



/**
 * JOB_INTERRUPTED_PREFIX
 * The job manager's OWN marker for "this job's owning process died", written by
 * core/media/jobs.ts into `record.errors` on every interruption path:
 *   reconcileProcessFiles()  → 'interrupted: owning server process died (boot reconcile)'
 *   status() lazy reconcile  → 'interrupted: owning server process died (lazy reconcile)'
 *   interruptRunning(reason) → `interrupted: ${reason}`
 *
 * WHY A PREFIX AND NOT A FIELD. The record HAS a structured `status`
 * ('interrupted' vs 'error'), but the wire frame does not: JobStatusFrame is
 * `{pid, pfile, is_running, data, errors, total_time}` (jobs.ts frameOf, mirrored
 * by core/api/process_status.ts). The status collapses into `is_running:false`
 * before it reaches this client, so the only token that survives the wire is the
 * marker the same module stamps into `errors[]`. It is a machine-written
 * constant, not an operator sentence — a translation or a reworded message
 * cannot move it, and a worker's own thrown sentence never carries it.
 */
export const JOB_INTERRUPTED_PREFIX = 'interrupted: '

/** True when EVERY error the frame carries is that marker — i.e. the job was
 * reconciled, and nothing else went wrong. One real error in the array makes
 * this false, and the failure path keeps it. */
const is_job_interruption = function(errors) {
	return Array.isArray(errors)
		&& errors.length>0
		&& errors.every(e => typeof e==='string' && e.startsWith(JOB_INTERRUPTED_PREFIX))
}



/**
 * RESOLVE_FINAL_FRAME
 * Interprets the STREAM'S TERMINAL frame (`is_running:false`) once it is seen.
 * The job's final `data` is its RETURN ENVELOPE, not a phase snapshot — so a
 * fast install whose `swap → restart → done` tail lands inside one poll beat
 * delivers a track frozen mid-flight PLUS a terminal frame whose envelope
 * already knows the truth. That envelope outranks the frozen track:
 *
 *   {data:{ok:true,  data:{version}}}            → updated  (install landed)
 *   {errors:['interrupted: …']}                  → interrupted (see below)
 *   {data:{ok:false,error:{message}} | errors:[…]} → failed  (the sentence rides)
 *
 * INTERRUPTED IS NOT FAILED (2026-08-26). An operator who refreshes the panel
 * mid-run leaves the job orphaned; the swap restarts the server, and the NEW
 * process reconciles the pfile to status 'interrupted' (jobs.ts). When the panel
 * re-attaches, its FIRST frame is already terminal and carries only that marker
 * — an update or restore that COMPLETED was being reported as "the update
 * failed / interrupted: owning server process died", and /health was never
 * asked. Such a frame decides nothing about the outcome: it says the STREAM'S
 * owner died, exactly like the synthetic {interrupted:true} the live path emits
 * post-swap, so the caller must degrade to the same /health handoff.
 *
 * Returns {outcome:'updated', version} | {outcome:'interrupted', message}
 * | {outcome:'failed', message} | null when the frame decides nothing (caller
 * keeps its existing heuristics).
 * @param {Object} state - reducer state (unused today; symmetry + future use)
 * @param {Object|null} frame - the terminal JobStatusFrame, null when none seen
 */
export const resolve_final_frame = function(state, frame) {

	if (!frame || frame.is_running!==false) {
		return null
	}
	const result = frame.data
	const is_envelope = !!(result && typeof result==='object')
	if (is_envelope && result.ok===true && result.data && typeof result.data.version==='string') {
		// `release` (the identity the new tree answers /health with) when the job
		// named one — a prerelease or a release; a developer build's is its
		// archive's to say, so only its data triple rides (code_update.ts)
		return {
			outcome : 'updated',
			version : typeof result.data.release==='string' ? result.data.release : result.data.version
		}
	}
	// the reconciled job: terminal, but it never reported an outcome. An
	// EXPLICIT ok:false envelope outranks it — that is the pipeline itself
	// saying it failed, whatever the job manager stamped afterwards.
	if (!(is_envelope && result.ok===false) && is_job_interruption(frame.errors)) {
		return { outcome : 'interrupted', message : frame.errors.join(' ') }
	}
	if (is_envelope) {
		// The failure sentence, in wire order: the job frame's own `errors[]`
		// first (it collects the throw the worker caught), else envelope v2's
		// `error.message`. NEVER `result.msg` — `msg` is a handler extension key
		// the pipeline writes on SUCCESS only (src/core/update/code_update.ts
		// ok({version},{extend:{msg}})), so on a failed run it is undefined, and
		// on the degenerate ok-without-version run it is a success sentence
		// rendered as the failure's.
		const message = Array.isArray(frame.errors) && frame.errors.length > 0
			? frame.errors.join(' ')
			: (result.error && typeof result.error.message==='string' && result.error.message.length>0
				? result.error.message
				: null)
		if (result.ok===false || message!==null) {
			return { outcome : 'failed', message : message }
		}
	}
	if (Array.isArray(frame.errors) && frame.errors.length>0) {
		return { outcome : 'failed', message : frame.errors.join(' ') }
	}
	return null
}//end resolve_final_frame



/**
* RESOLVE_HEALTH_OUTCOME
* Decides the ending once /health answers (or the deadline passes).
*
* WHICH TOKEN DECIDES. The version cannot, on its own: a developer-channel
* install replaces the tree WITHOUT a version bump, so the rolled-back old tree
* answers /health with exactly the version the update expected — every such
* update would report success. When the panel knows which ARCHIVE it installed
* (`expected_digest`, straight from the manifest item's sha256) the digest
* decides, because that is what actually differs between the two trees.
*
* The fallback stays deliberate: a server too old to publish `install_digest`
* answers null, and calling that a rollback would break every update against an
* older install. Version compare is the honest answer there — the same answer
* this function always gave.
*
* THE EXPECTATION IS AN IDENTITY (2026-10-18, the identity walk). The job names
* what it installs by the release identity /health will answer
* (code_update.ts: the restart frame's `expected_version`, the envelope's
* `release`; the click passes the item's own, update_code_channel.js
* item_release), so the compare is EXACT. A prerelease never "meets" its bare
* triple: since the door walks within a triple (beta.6 → beta.7 → 7.0.0), the
* rolled-back tree answers the SAME triple, and a triple match would read every
* such rollback as an update.
*
* @param {Object} state - reducer state (mode 'polling')
* @param {string|null} health_version - `version` from /health, null when the
*   server never came back before the deadline
* THE NEW TREE MUST ALSO HAVE MIGRATED (update audit 2026-10-29, U-01). A
* server that boots the new code but whose boot migration FAILED answers /health
* 503 with `boot_schema: 'failed'`, and the server refuses to confirm the update.
* That is never 'updated', whatever the version or digest says: it is
* 'schema_failed' while the schema is untouched (`boot_schema_moved` false: the
* watchdog rolls the code back, so the caller keeps watching), and
* 'needs_restore' when it moved or nobody could tell (true/null: the sentinel
* is needs_restore, no automatic action will come — a human restores a backup).
*
* @param {Object} state - reducer state (mode 'polling')
* @param {string|null} health_version - `version` from /health, null when the
*   server never came back before the deadline
* @param {string|null} [health_digest] - `install_digest` from /health
* @param {string|null} [boot_schema] - `boot_schema` from /health (ok|failed|skipped;
*   absent on an older server)
* @param {boolean|null} [boot_schema_moved] - `boot_schema_moved` from /health
*   (present only when boot_schema is failed; null = unknown, read as moved)
* @returns {{outcome:string, message:(string|null)}}
*   outcome ∈ updated | schema_failed | needs_restore | rolled_back | server_gone
*/
export const resolve_health_outcome = function(state, health_version, health_digest=null, boot_schema=null, boot_schema_moved=null) {

	if (health_version===null || health_version===undefined || health_version==='') {
		return { outcome : 'server_gone', message : state.message }
	}
	if (boot_schema==='failed') {
		return boot_schema_moved===false
			? { outcome : 'schema_failed', message : state.message }
			: { outcome : 'needs_restore', message : state.message }
	}
	if (state.expected_digest && health_digest) {
		return health_digest===state.expected_digest
			? { outcome : 'updated', message : null }
			: { outcome : 'rolled_back', message : state.message }
	}
	if (state.expected_version && health_version===state.expected_version) {
		return { outcome : 'updated', message : null }
	}
	// the server is back but not on the new version → the job rolled back
	return { outcome : 'rolled_back', message : state.message }
}//end resolve_health_outcome



/**
* READ_HEALTH_BODY
* What one /health answer says to the poller. A 200 is a server that came back.
* A 503 still carries the body, and two 503s are verdicts, not a server still
* restarting: `boot_schema: 'failed'` (U-01 — resolve_health_outcome decides
* between schema_failed and needs_restore), and `data_version.state: 'ahead'`
* (the database is newer than the booted code — a deliberate restore of older
* code across a data version: the operation HAPPENED, and the server stays
* unhealthy until a human restores the matching database). Any other answer
* (`version` null) keeps the poll going.
*
* @param {number} status - the HTTP status
* @param {Object|null} body - the parsed body (null when there is none)
* @returns {{version:(string|null), digest:(string|null), boot_schema:(string|null), boot_schema_moved:(boolean|null), data_ahead:boolean, run:(Object|null)}}
*/
export const read_health_body = function(status, body) {
	const boot_schema	= body?.boot_schema ?? null
	const data_ahead	= status===503 && body?.data_version?.state==='ahead'
	const came_back		= status===200 || (status===503 && (boot_schema==='failed' || data_ahead))
	return {
		version				: came_back ? (body?.version ?? null) : null,
		// null on a server older than the install stamp — the verdict falls
		// back to the version compare in that case.
		digest				: body?.install_digest ?? null,
		boot_schema			: boot_schema,
		boot_schema_moved	: body?.boot_schema_moved ?? null,
		data_ahead			: data_ahead,
		// the update run this boot belongs to (core/update/run/), or null
		run					: body?.update_run ?? null
	}
}//end read_health_body



/**
* RUN_PROGRESS
* Where the update run stands, read from /health's `update_run` (update audit
* 2026-10-29, Phase 2.6). The new tree answering is NOT the end of an update
* any more: after the restart the run applies the ontology, schema, data and
* ancillary phases, and confirms only once VERIFIED. Pure.
*  - 'none'          no run on this server (an older engine): the version verdict decides
*  - 'running'       phases still running — keep watching, the update is not done
*  - 'confirmed'     the run confirmed — the version verdict decides
*  - 'needs_restore' the walk crossed a data model and failed: a human restores a backup
*  - 'rolling_back'  the run ordered the previous code back — the old version answers next
*  - 'failed'        ended without a confirm (MANUAL / ABANDONED / FAILED_PRE_SWAP / REFUSED)
* @param object|null run
* @return string
*/
export const run_progress = function(run) {
	const state = run?.state ?? null
	if (state===null) {
		return 'none'
	}
	switch (state) {
		case 'CONFIRMED':			return 'confirmed'
		case 'NEEDS_DB_RESTORE':	return 'needs_restore'
		case 'ROLLED_BACK_CODE':	return 'rolling_back'
		case 'MANUAL':
		case 'ABANDONED':
		case 'FAILED_PRE_SWAP':
		case 'REFUSED':				return 'failed'
		default:					return 'running'
	}
}//end run_progress



// @license-end
