// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, get_label, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* ERROR_DISPATCH
* Executes the policy for an ApiError: `handle_api_error(api_error, ctx)` →
* Promise<{recovered:boolean}>. Callers that can retry (component save,
* build_autoload) just `await` it: `recovered:true` means the cause is gone
* (the user re-logged in) and the call may be repeated; `false` means it was
* shown/handled and the caller stops.
*
* Owns the relogin-then-retry recovery: ONE overlay per session loss no matter
* how many requests failed at once, settled for all of them by ONE decision
* site, `settle_relogin_attempt` (below): it alone asks `relogin_identity` who
* logged in, latches or clears the page identity, settles the pending recovery
* and reloads. The overlay (render_login.js render_relogin) is TRANSPORT — it
* hands the login envelope to the door and resumes only on 'resume'.
* `recovered:true` means the page's OWN user logged back in; any other identity
* reloads the page and latches it (`is_page_identity_revoked`): until it
* reloads, no transport sends anything but the login door
* (`refused_by_page_identity`), so A's queued work never goes out under B's
* session. 'login_successful' is a notification
* published BEFORE the door runs — it is never an authorisation to resume and
* has no subscribers (LEAD-2 + CLIENT-5).
*
* A CSRF token is the same question asked without an overlay: data_manager
* adopts the token an envelope carries (and makes its transparent CSRF resend)
* only through `settle_session_identity` — a session replaced by a login in
* another document latches and reloads this page instead of carrying it over.
*
* Also owns the NOTICE half of the contract (ERRORS_SPEC §3): a SUCCESS
* envelope's `notices[]` go through `handle_api_notice` / `handle_api_notices`,
* the same policy table at severity 'warning' and never a page-level action —
* the request succeeded, so nothing may take the page away from the user.
*
* And it DECLARES the page-wide error signal (ERROR_SIGNAL / signal_error,
* below). That name lived in a module of its own until 2026-09-23, which put a
* 48-line file on the cold-boot critical path for one CustomEvent and broke the
* shrink-only boot budget (page_load_budget_native: 37 modules against 36). It
* belongs here: this file is already on that path and is already one of the two
* producers. The other, error_capture.js, cannot import anything by design and
* repeats the name as a literal — client_error_signal.test.ts refuses the two
* to drift. The only other consumer, the error-report launcher, is lazy and
* imports the constant from here.
*/

// imports
	import {ApiError, is_api_error, response_data} from './api_error.js'
	import {resolve_error_policy} from './error_policy.js'
	import {
		error_text,
		render_error_toast,
		render_error_inline,
		render_error_panel,
		render_error_modal,
		severity_type
	} from './render_api_error.js'



/**
* ERROR_SIGNAL
* The ONE page-wide "something went wrong" signal: a window CustomEvent any
* observer may listen to. Its single consumer today is the error-report
* launcher tab (common/js/error_report_launcher.js), which unfolds itself so a
* user who just saw a failure can report it without hunting for the launcher.
*
* Two producers, both of which the user actually experiences:
*   - common/js/error_capture.js — an uncaught JS error / unhandled rejection.
*     It is a side-effect-only module that installs its listeners before any
*     other application module evaluates and declares no imports ON PURPOSE, so
*     it repeats this name as a literal (gated).
*   - this file — an ApiError that was SHOWN (toast, page panel). Silent
*     policies and a recovered relogin are not failures the user can describe,
*     so they never raise the signal.
*
* It is a SIGNAL, not a channel: it carries no error payload beyond a coarse
* origin and code. The error data itself stays where it already lives — the
* bounded window.dedalo_js_errors buffer that tool_error_report reads when the
* user explicitly asks to report a problem. Nothing here transmits or stores.
*/
export const ERROR_SIGNAL = 'dedalo_error_signal'

/**
* SIGNAL_ERROR
* Raise the signal. Never throws: a page that is already failing must not fail
* twice because the observer machinery did.
* @param {object} detail {origin:'js'|'api', code:string|null}
* @return {void}
*/
export const signal_error = (detail) => {
	try {
		window.dispatchEvent(new CustomEvent(ERROR_SIGNAL, {detail: detail || {}}))
	} catch (e) {
		// an observer must never break the page it observes
	}
}//end signal_error

// The policy actions that mean "a defect the user could usefully report" — the
// ONLY ones that raise the page-wide error signal. See handle_api_error.
const REPORTABLE_ACTIONS = new Set(['page_panel', 'toast'])

// relogin_pending: the ONE in-flight relogin recovery (null when none)
let relogin_pending = null

// relogin_settle: the resolver of relogin_pending (null when none — e.g. a
// standalone render_relogin with no recovery waiting). Only the door
// (settle_relogin_attempt) and relogin's own failure path call it.
let relogin_settle = null

// page_identity_revoked: null, or {verdict} once a re-login authenticated an
// identity that is not provably this page's user. While set, the TRANSPORT
// sends nothing but the login door (refused_by_page_identity), and the two
// queued-work doors (component save, build_autoload) stop before it, keeping
// their unsaved state. See REVOKE_PAGE_IDENTITY.
let page_identity_revoked = null

// LOGIN_DOOR_ACTIONS: the only dd_utils_api actions a revoked page may still
// send — the overlay (or the login page) logging in, or logging out. Each one
// authenticates or ends a session; none carries the page's cached state.
// Exported for the gates only: the client suite sends each member through the
// latched transport (test_relogin_identity case s), and
// client_idempotency_tripwire holds it equal to the server's pre-auth session
// doors (dispatch.ts NO_LOGIN_ACTIONS, classified there) plus `quit`.
export const LOGIN_DOOR_ACTIONS = new Set([
	'get_login_context',
	'login',
	'quit',
	'request_password_reset',
	'confirm_password_reset'
])

// page_reloader: the ONE way this module reloads the page. A seam so the
// client suite can count reloads instead of reloading its own frame.
const default_page_reloader = () => window.location.reload()
let page_reloader = default_page_reloader

// relogin_renderer: how relogin() opens the overlay. Dynamic import: render_login
// pulls the whole login family; the dispatch module must stay importable by
// data_manager without dragging it in. A seam so the client suite can make the
// overlay FAIL to open and prove every waiter still settles.
const default_relogin_renderer = () => import('../../login/js/render_login.js')
	.then((module) => module.render_relogin({}))
let relogin_renderer = default_relogin_renderer

// toast dedupe: identical toasts (same code + text) within TOAST_DEDUPE_MS
// collapse into one — data_manager did the same through request_message.
const TOAST_DEDUPE_MS	= 3000
const recent_toasts		= new Map()



/**
* GLOBALS
* page_globals is a page global set by set_environment; a Worker or a bare test
* has none.
*/
const globals = () => (typeof page_globals!=='undefined' && page_globals && typeof page_globals==='object') ? page_globals : null



/**
* SET_PAGE_ERROR
* THE single page-level error slot: one ApiError, read by
* common.prototype.render to draw the page panel.
* @param {ApiError} api_error
*/
const set_page_error = (api_error) => {
	const pg = globals()
	if (!pg) return
	pg.page_error = api_error
}//end set_page_error



/**
* DEDUPED_TOAST
* @return bool true when a toast was actually published
*/
const deduped_toast = (api_error, entry) => {
	const now	= Date.now()
	const key	= api_error.code + '|' + error_text(api_error)
	for (const [k, at] of recent_toasts) {
		if (now - at > TOAST_DEDUPE_MS) recent_toasts.delete(k)
	}
	if (recent_toasts.has(key)) {
		return false
	}
	recent_toasts.set(key, now)
	// the ONE severity → bubble mapping (an 'info' entry used to paint as an error)
	render_error_toast(api_error, entry.severity ? {type: severity_type({severity: entry.severity})} : {})
	return true
}//end deduped_toast



/**
* RELOGIN_IDENTITY
* THE identity primitive of a re-login (LEAD-2 + CLIENT-5, CLI-09): did the
* account that just authenticated provably belong to this page?
*
*   'not_logged' — the login did not succeed (`data!==true`): nothing to decide,
*                  the overlay stays up for another attempt.
*   'unknown'    — the login succeeded but either side of the comparison is
*                  missing: the response carries no `user_id`, or the page has
*                  none. An unresolvable identity is NOT a match (fail closed —
*                  a null page id used to make the old guard fail OPEN).
*   'same'       — same user (compared as strings: the page holds a number, the
*                  wire may carry either).
*   'differs'    — another user.
*
* THE KEY IS TOP-LEVEL. Envelope v2 carries extension keys beside `ok`/`data`:
* the login handler answers `ok(true, {extend:{user_id, csrf_token}})`
* (src/core/api/handlers/dd_utils_api.ts). There is NO `result_options` in a TS
* response — that PHP-era spelling made an earlier guard INERT, and a fallback
* to it would be a second spelling of identity waiting to drift.
*
* Pure. Its ONE caller outside the test suite is settle_relogin_attempt (below):
* there is one place that decides who logged in.
* @param {Object} api_response - the login envelope
* @param {*} [page_user_id] - the page's user; when the argument is OMITTED,
*        page_globals.user_id. An explicit undefined/null is a page without a
*        user ('unknown') — never silently replaced by the global.
* @return {'same'|'differs'|'unknown'|'not_logged'}
*/
export const relogin_identity = (api_response, ...page_user) => {

	const page_user_id = page_user.length > 0 ? page_user[0] : globals()?.user_id

	if (response_data(api_response)!==true) {
		return 'not_logged'
	}

	const authenticated_user_id = api_response?.user_id
	if (authenticated_user_id===undefined || authenticated_user_id===null ||
		page_user_id===undefined || page_user_id===null) {
		return 'unknown'
	}

	return String(authenticated_user_id)===String(page_user_id)
		? 'same'
		: 'differs'
}//end relogin_identity



/**
* RELOAD_PAGE
* The one reload this module asks for (a re-login as another identity). Goes
* through the seam below so the client suite counts it instead of reloading its
* own frame.
* @return {void}
*/
export const reload_page = () => page_reloader()



/**
* SET_PAGE_RELOADER_FOR_TEST
* Test seam: replace the reloader; returns the function that restores it.
* @param {Function} fn
* @return {Function} restore
*/
export const set_page_reloader_for_test = (fn) => {
	const previous = page_reloader
	page_reloader = fn
	return () => { page_reloader = previous }
}//end set_page_reloader_for_test



/**
* SET_RELOGIN_RENDERER_FOR_TEST
* Test seam: replace how relogin() opens the overlay; returns the function that
* restores it.
* @param {Function} fn - () => Promise (the overlay opened) | throws/rejects
* @return {Function} restore
*/
export const set_relogin_renderer_for_test = (fn) => {
	const previous = relogin_renderer
	relogin_renderer = fn
	return () => { relogin_renderer = previous }
}//end set_relogin_renderer_for_test



/**
* REVOKE_PAGE_IDENTITY
* Latch: a re-login authenticated an identity that is not provably this page's
* user. Until the page reloads — or the page's own user logs in on the overlay
* (clear_page_identity_revoked) — its cached state belongs to the previous
* identity, so nothing leaves the page but the login door: every transport
* (data_manager.request / request_stream / request_fetch_stream, the upload
* parts, and the raw ones — agent_stream, builder_stream, the transcription
* unload cleanup, the lock-release beacon; census: client_idempotency_tripwire)
* asks refused_by_page_identity first, and the queued-work doors
* (component_common save, common build_autoload) stop before the transport so
* their unsaved state survives. The latch is what still protects the page when
* the user cancels the reload (a beforeunload prompt) and keeps working —
* keyboard focus is not stopped by the overlay's '.loading' lock.
* @param {string} verdict - 'differs'|'unknown'
* @return {void}
*/
export const revoke_page_identity = (verdict) => {
	page_identity_revoked = {verdict}
}//end revoke_page_identity



/**
* CLEAR_PAGE_IDENTITY_REVOKED
* The page's own user logged back in ('same'): the latch is lifted.
* @return {void}
*/
export const clear_page_identity_revoked = () => {
	page_identity_revoked = null
}//end clear_page_identity_revoked



/**
* IS_PAGE_IDENTITY_REVOKED
* @return {boolean}
*/
export const is_page_identity_revoked = () => page_identity_revoked!==null



/**
* REFUSED_BY_PAGE_IDENTITY
* THE TRANSPORT LATCH: true when a request with this body must not be sent —
* the page identity is revoked and the body is not a login-door action
* (LOGIN_DOOR_ACTIONS on dd_utils_api). A body that is not a plain object (a
* pre-serialized string, an upload's FormData, none) is never a login-door
* action, so it is refused while revoked. Asked by every client transport
* before it opens a connection; the decision lives here, beside the latch, so
* the transports cannot each spell their own exemption list.
* @param {*} body - the request body as the caller passed it
* @return {boolean}
*/
export const refused_by_page_identity = (body) => {
	if (page_identity_revoked===null) {
		return false
	}
	return !is_login_door_body(body)
}//end refused_by_page_identity



/**
* IS_LOGIN_DOOR_BODY
* True when the request body is a login-door action: a plain object on
* dd_utils_api whose action is in LOGIN_DOOR_ACTIONS. Anything else — another
* dd_api with the same action name, a string, FormData, none — is not.
* @param {*} body
* @return {boolean}
*/
export const is_login_door_body = (body) => body!==null
	&& typeof body==='object'
	&& !Array.isArray(body)
	&& body.dd_api==='dd_utils_api'
	&& LOGIN_DOOR_ACTIONS.has(body.action)
//end is_login_door_body



/**
* SESSION_IDENTITY
* Whose session answered this envelope? Every response of a session carries
* `csrf_token` and, beside it, `session_user_id` — the user that token belongs
* to (dispatch.ts executeRqo; the login handler for the session it mints).
*
*   'anonymous_page' — the page has no user yet (the `start` bootstrap, the
*                      login page): it holds no user's state, so there is no
*                      identity to protect.
*   'same'           — the session is the page user's (compared as strings).
*   'differs'        — the session belongs to another user: a login elsewhere
*                      (another tab, another window, an overlay) replaced it.
*   'unknown'        — the page has a user and the envelope names none: not a
*                      match (fail closed).
*
* Pure.
* @param {Object} envelope - an API envelope that carries `csrf_token`
* @param {*} [page_user_id] - when OMITTED, page_globals.user_id
* @return {'anonymous_page'|'same'|'differs'|'unknown'}
*/
export const session_identity = (envelope, ...page_user) => {

	const page_user_id = page_user.length > 0 ? page_user[0] : globals()?.user_id
	if (page_user_id===undefined || page_user_id===null) {
		return 'anonymous_page'
	}

	const session_user_id = envelope?.session_user_id
	if (session_user_id===undefined || session_user_id===null) {
		return 'unknown'
	}

	return String(session_user_id)===String(page_user_id)
		? 'same'
		: 'differs'
}//end session_identity



/**
* SETTLE_SESSION_IDENTITY
* THE TOKEN DOOR (LEAD-2 + CLIENT-5, second half). A CSRF token is an identity:
* holding it is what lets the page write. data_manager hands every envelope
* that carries one here BEFORE it adopts the token — and before the transparent
* CSRF resend, which used to move a page onto whatever session the cookie held
* (A's page, B's token, A's edit committed under B).
*
*   'adopt'   — the page's own session ('same'), or a page with no user yet
*               ('anonymous_page'): the token may be taken and the request
*               resent.
*   'refused' — another ('differs') or an unresolvable ('unknown') session. The
*               token is NOT taken. For a login-door action that is all: the
*               login door (settle_relogin_attempt, or the login page) decides
*               what a login means. For every other action the page identity is
*               latched, a pending re-login recovery settles recovered:false,
*               and the page reloads (once — a second refusal while latched
*               reloads nothing more); the caller answers client.aborted.
*
* The same latch as a refused re-login, reached without an overlay: the session
* was replaced by a login in ANOTHER document of the origin. Each document finds
* out on its next answer, so a tool window or a sibling tab latches on its own.
* @param {Object} envelope - the envelope that carries `csrf_token`
* @param {*} body - the request body it answers
* @return {'adopt'|'refused'}
*/
export const settle_session_identity = (envelope, body) => {

	const verdict = session_identity(envelope)
	if (verdict==='same' || verdict==='anonymous_page') {
		return 'adopt'
	}

	if (is_login_door_body(body)) {
		return 'refused'
	}

	const already_revoked = page_identity_revoked!==null
	revoke_page_identity(verdict)
	if (already_revoked) {
		return 'refused'
	}
	console.warn(
		'settle_session_identity: '
		+ (verdict==='differs'
			? 'the session now belongs to a DIFFERENT user (page ' + globals()?.user_id + ' -> ' + envelope?.session_user_id + ')'
			: 'the response names no session user (page ' + globals()?.user_id + ')')
		+ ' — a login elsewhere replaced it; reloading instead of sending this page\'s state under it.'
	)
	settle_pending({recovered:false, reason:verdict})
	reload_page()

	return 'refused'
}//end settle_session_identity



/**
* SETTLE_PENDING
* Settle the in-flight recovery (if any) for every waiter at once. A no-op when
* nothing is pending (a standalone render_relogin) or it already settled.
* @param {Object} outcome - {recovered:boolean, reason?:string}
* @return {void}
*/
const settle_pending = (outcome) => {
	if (relogin_settle===null) return
	const resolve = relogin_settle
	relogin_settle	= null
	relogin_pending	= null
	resolve(outcome)
}//end settle_pending



/**
* SETTLE_RELOGIN_ATTEMPT
* THE ONE DECISION SITE of a re-login (LEAD-2 + CLIENT-5, CLI-09). The overlay
* hands every login envelope here and acts only on the answer:
*
*   'retry_form' — the login did not succeed ('not_logged'): nothing latched,
*                  nothing settled, nothing reloaded; the form stays up.
*   'resume'     — the page's OWN user ('same'): the latch is lifted, every
*                  waiter settles recovered:true (it may repeat its request),
*                  and the overlay may unlock the page.
*   'refused'    — another ('differs') or an unresolvable ('unknown') identity:
*                  the page identity is latched (nothing but the login door
*                  is sent, even if the reload is cancelled), every waiter settles
*                  recovered:false BEFORE the reload is asked for, and the
*                  page reloads. The overlay and the page lock stay up.
*
* Why one site: the first repair decided identity twice — in the overlay guard
* and again in the recovery promise — and each check masked the other, so
* neither was load-bearing. Here the verdict, the latch, the settlement and
* the reload are one sequence that cannot disagree with itself.
* @param {Object} api_response - the login envelope
* @return {'resume'|'retry_form'|'refused'}
*/
export const settle_relogin_attempt = (api_response) => {

	// page user omitted on purpose: relogin_identity reads page_globals.user_id
	const verdict = relogin_identity(api_response)

	if (verdict==='not_logged') {
		return 'retry_form'
	}

	if (verdict==='same') {
		// lifted even when no recovery is pending: the user may have cancelled a
		// reload and then logged in again as the page's user
		clear_page_identity_revoked()
		settle_pending({recovered:true})
		return 'resume'
	}

	// 'differs' | 'unknown'
	revoke_page_identity(verdict)
	console.warn(
		'settle_relogin_attempt: '
		+ (verdict==='differs'
			? 'authenticated as a DIFFERENT user (page ' + globals()?.user_id + ' -> ' + api_response?.user_id + ')'
			: 'could not resolve the authenticated user_id (page ' + globals()?.user_id + ', response ' + api_response?.user_id + ')')
		+ ' — reloading instead of resuming this page\'s pending action.'
	)
	// settle BEFORE the reload: no waiter may still be pending when the page goes
	settle_pending({recovered:false, reason:verdict})
	reload_page()

	return 'refused'
}//end settle_relogin_attempt



/**
* RELOGIN
* Opens the re-login overlay once (never a SECOND login: a page that loaded
* logged-out is already showing the form) and returns the ONE recovery promise
* every concurrent waiter shares. It decides nothing: the overlay hands each
* login envelope to settle_relogin_attempt, which settles this promise —
* recovered:true only for the page's own user. 'login_successful' (published by
* login.js BEFORE the door runs) settles nothing: resolving on it is exactly how
* B's login used to retry A's queued save.
* @return Promise<{recovered:boolean, reason?:string}>
*/
const relogin = async () => {

	const pg = globals()
	// page_globals.is_logged is the boot snapshot: a session that expires mid-use
	// still reaches the overlay — that is the whole point.
	if (!pg || pg.is_logged!==true) {
		return {recovered:false}
	}
	if (relogin_pending) {
		return relogin_pending
	}

	relogin_pending = new Promise((resolve) => {

		relogin_settle = resolve

		// the overlay could not open (import or render failed): nobody can log
		// in, so every waiter settles recovered:false — never left hanging. A
		// synchronous throw of the renderer lands in the same catch.
		Promise.resolve()
			.then(() => relogin_renderer())
			.catch((error) => {
				console.error('error_dispatch relogin: render_relogin failed', error)
				settle_pending({recovered:false})
			})
	})

	return relogin_pending
}//end relogin



/**
* RENDER_SCOPED_PANEL
* The page-panel actions ('no_access_page', 'page_panel') are PAGE-level only
* when the failed request was the PAGE's own: `ctx.page_scope===true` (the page
* build, a page-root element's build). Only then is `page_globals.page_error`
* set — the slot common.prototype.render turns into the page panel. Any other
* request (an embedded side panel, an inspector block, a widget, a save) is
* panel-scoped and NEVER sets it: an embedded refusal used to set the page slot
* and every later render of every instance on the page became the no-access
* panel, with no way out but a reload.
*   - a wrapper given      → the panel goes into that wrapper (panel-local);
*   - page_scope===false   → the request's own path owns the surface: an
*                            embedded build answers false and its caller draws
*                            it, or common.prototype.render of the failed
*                            instance does (render_build_failure); the page's
*                            every-request listener stays quiet so a panel-local
*                            refusal never also raises a toast. Nothing here;
*   - neither              → a toast, so the refusal is never silent.
* @param {ApiError} api_error
* @param {Object} entry - the resolved policy row
* @param {Object} ctx - handle_api_error ctx
* @return void
*/
const render_scoped_panel = (api_error, entry, ctx) => {

	if (ctx.page_scope===true) {
		set_page_error(api_error)
	}
	if (ctx.wrapper && typeof ctx.wrapper.appendChild==='function') {
		ctx.wrapper.appendChild(render_error_panel(api_error))
		return
	}
	if (ctx.page_scope===undefined) {
		deduped_toast(api_error, entry)
	}
}//end render_scoped_panel



/**
* HANDLE_API_ERROR
* @param {ApiError|Object} api_error
* @param {Object} [ctx] - {wrapper?:HTMLElement (inline/panel target), scope?:string, silent?:bool,
*   page_scope?:bool (true: the PAGE's own request — the only one that may set
*   page_globals.page_error; false: an embedded build whose caller renders the
*   failure; see render_scoped_panel)}
* @return Promise<{recovered:boolean, action:string}>
*/
export const handle_api_error = async (api_error, ctx = {}) => {

	if (!is_api_error(api_error)) {
		console.warn('handle_api_error: not an ApiError', api_error)
		return {recovered:false, action:'silent'}
	}

	const entry		= resolve_error_policy(api_error)
	const action	= ctx.silent===true ? 'silent' : entry.action

	// page-wide error signal (declared above): it unfolds the error-report
	// launcher, so it must mean "a DEFECT worth reporting", not merely "the user
	// saw something". An allowlist, because the wrong half is the dangerous one:
	// 'inline' is a validation message about the user's own typing, and
	// 'no_access_page' a routine permission refusal — unfolding for those trains
	// the user to ignore the tab by the time a real crash raises it. Excluded by
	// construction: silent/csrf_retry (nothing shown), relogin (a session expiry
	// the user resolves in place), modal ('record.in_use' — a conflict with
	// another editor, not a fault), and every 'warning' severity (a dropped
	// network is transient). What remains is the page-panel and toast band: the
	// unexpected internal failures the default '*' policy lands on.
	if (REPORTABLE_ACTIONS.has(action) && entry.severity!=='warning') {
		signal_error({origin:'api', code: api_error.code || null})
	}

	if (typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
		console.warn(`handle_api_error [${api_error.code}] → ${action}`, api_error, ctx)
	}

	switch (action) {

		case 'relogin': {
			const outcome = await relogin()
			return {...outcome, action}
		}

		case 'no_access_page':
		case 'page_panel': {
			render_scoped_panel(api_error, entry, ctx)
			return {recovered:false, action}
		}

		case 'modal': {
			render_error_modal(api_error)
			return {recovered:false, action}
		}

		case 'inline': {
			if (ctx.wrapper) {
				render_error_inline(ctx.wrapper, api_error)
			} else {
				deduped_toast(api_error, entry)
			}
			return {recovered:false, action}
		}

		case 'toast': {
			deduped_toast(api_error, entry)
			return {recovered:false, action}
		}

		case 'csrf_retry':	// data_manager already resent once; nothing to show
		case 'silent':
		default:
			return {recovered:false, action}
	}
}//end handle_api_error



/**
* HANDLE_API_NOTICE
* The notice half of the contract (ERRORS_SPEC §3): a SUCCESS envelope may
* carry `notices:[{code, label_key, retryable, details}]` — a coded fact that is
* NOT a failure (a refused child delete, a degraded external source, a login
* soft warning). The request succeeded; something the caller should know did
* not go the obvious way.
*
* A notice is dispatched through the SAME policy table an ApiError is, so a
* tool/area silences or re-routes its own domain with `register_error_policy`
* (e.g. `external.*` → `silent`, because the autocomplete chip already renders
* the degradation from `source_status`). The default for a code with no entry
* of its own is the `'*'` row — a toast — at severity `warning`: a notice is
* never red.
*
* The notice is turned into an ApiError-shaped object (same fields, same
* renderer) rather than a second model: `error_text` resolves `label_key` +
* `details` exactly as it does for a failure, and every surface (toast, inline,
* modal) keeps working unchanged.
*
* @param {Object} notice - {code, label_key?, retryable?, details?}
* @param {Object} [ctx] - {wrapper?:HTMLElement, request_id?:string, silent?:bool}
* @return Promise<{recovered:boolean, action:string}>
*/
export const handle_api_notice = async (notice, ctx = {}) => {

	const api_error = api_error_from_notice(notice, ctx)
	if (!api_error) {
		console.warn('handle_api_notice: not a notice', notice)
		return {recovered:false, action:'silent'}
	}

	const entry		= resolve_error_policy(api_error)
	// A notice never re-logs-in, never takes over the page and never blocks:
	// those actions belong to a FAILED request. Anything the table answers with
	// that is not a showable surface degrades to a toast.
	const showable	= ['toast', 'modal', 'inline', 'silent']
	const action	= ctx.silent===true
		? 'silent'
		: (showable.includes(entry.action) ? entry.action : 'toast')

	if (typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
		console.warn(`handle_api_notice [${api_error.code}] → ${action}`, notice, ctx)
	}

	switch (action) {

		case 'modal':
			render_error_modal(api_error)
			return {recovered:false, action}

		case 'inline':
			if (ctx.wrapper) {
				render_error_inline(ctx.wrapper, api_error)
				return {recovered:false, action}
			}
			deduped_toast(api_error, {severity:'warning'})
			return {recovered:false, action:'toast'}

		case 'toast':
			deduped_toast(api_error, {severity: entry.severity || 'warning'})
			return {recovered:false, action}

		case 'silent':
		default:
			return {recovered:false, action:'silent'}
	}
}//end handle_api_notice



/**
* API_ERROR_FROM_NOTICE
* Builds the ApiError-shaped carrier a notice renders through. Exported because
* a caller that renders the notice in its OWN wrapper (section.js delete) needs
* the same text resolution without going through the policy table.
* @param {Object} notice
* @param {Object} [ctx] - {request_id?:string}
* @return ApiError|null
*/
export const api_error_from_notice = (notice, ctx = {}) => {

	if (!notice || typeof notice!=='object' || typeof notice.code!=='string' || !notice.code.length) {
		return null
	}

	return new ApiError({
		code		: notice.code,
		label_key	: typeof notice.label_key==='string' ? notice.label_key : null,
		details		: notice.details,
		retryable	: notice.retryable===true,
		request_id	: typeof ctx.request_id==='string' ? ctx.request_id : null,
		severity	: 'warning',
		transport	: false,
		source		: 'envelope',
		raw			: notice
	})
}//end api_error_from_notice



/**
* HANDLE_API_NOTICES
* The page-level subscriber body: dispatch every notice of one envelope.
* @param {Object} payload - {notices:Array, api_response:Object}
* @return Promise<Array>
*/
export const handle_api_notices = async (payload = {}) => {

	const notices = Array.isArray(payload.notices) ? payload.notices : []
	const ctx = {request_id: payload.api_response?.request_id}

	const outcomes = []
	for (const notice of notices) {
		outcomes.push(await handle_api_notice(notice, ctx))
	}

	return outcomes
}//end handle_api_notices



/**
* OUTCOME_UNKNOWN_CODES
* The server's own "I do not know whether (or what) it ran" answers — the
* idempotency gate (src/core/api/dispatch.ts GATE 4): a twin that waited past
* its bound while the leader still runs (`in_progress`), a twin of a leader that
* THREW and may already have committed (`outcome_unknown`), and a twin of a
* leader that COMPLETED but whose answer was too large to keep
* (`replay_unavailable` — it ran; what it answered is lost).
* These are the server's SPELLINGS of those situations, so they are gated by
* OUTCOME, not by spelling: test/unit/client_outcome_unknown_native.test.ts
* builds each situation through the real dispatcher and requires this module
* to read the answer as unknown (and a known refusal from the same gate as
* known) — a renamed or retired server code turns it red.
*/
const OUTCOME_UNKNOWN_CODES = new Set([
	'idempotency.in_progress',
	'idempotency.outcome_unknown',
	'idempotency.replay_unavailable'
])



/**
* OUTCOME_UNKNOWN
* Whether a FAILED request leaves the server-side outcome UNKNOWN: the
* operation may have run, may still be running, or may never have started.
*  - every TRANSPORT failure (`client.*`: a timeout, a dropped connection, an
*    unreadable answer, a proxy's non-envelope page). The browser gave up, but
*    an attempt may have landed — and the engine has no request.signal
*    handling, so an aborted attempt runs to completion
*    (WC-2026-08-28-idempotency-key);
*  - the server's OUTCOME_UNKNOWN_CODES above.
* A SERVER REFUSAL (an envelope `ok:false` with any other code) is a KNOWN
* outcome: the server answered, and said no. Anything that is not an ApiError
* cannot vouch for a known outcome, so it reads as unknown.
*
* WHY IT EXISTS. A control that starts non-idempotent work (a commit job, a
* data transform) must not re-arm on an unknown outcome: the operator's re-click
* mints a NEW idempotency key, and the server executes it AGAIN beside the
* first. Such a caller keeps the control disabled and offers a way to find out
* (the operator's own jobs, get_activity) instead.
* @param {ApiError|*} api_error - the failed envelope's `error`
* @return {boolean}
*/
export const outcome_unknown = (api_error) => {

	if (!is_api_error(api_error)) {
		return true
	}
	if (api_error.transport===true) {
		return true
	}

	return OUTCOME_UNKNOWN_CODES.has(api_error.code)
}//end outcome_unknown



/**
* RESET_ERROR_DISPATCH_STATE
* Test helper: forget the pending relogin, the toast dedupe window and the
* page-identity latch, and restore the real reloader and overlay renderer.
*/
export const reset_error_dispatch_state = () => {
	relogin_pending = null
	relogin_settle = null
	recent_toasts.clear()
	page_identity_revoked = null
	page_reloader = default_page_reloader
	relogin_renderer = default_relogin_renderer
}//end reset_error_dispatch_state



// @license-end
