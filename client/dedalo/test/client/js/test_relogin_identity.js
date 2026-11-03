// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/



/**
* TEST_RELOGIN_IDENTITY
* A queued action never resumes under a DIFFERENT identity (LEAD-2 + CLIENT-5).
*
* THE DEFECT. A session dies mid-use; the failed save (or build_autoload) awaits
* `handle_api_error`, which opens the re-login overlay. The overlay's own guard
* compared the new user_id with the page's and reloaded on a mismatch — and
* protected nothing, because `error_dispatch.relogin()` resolved
* `recovered:true` from a `login_successful` SUBSCRIBER, and login.js publishes
* that event BEFORE it runs the guard. So user B's login retried user A's queued
* save under B's session: A's text, B's name in the Time Machine.
*
* THE RULE — ONE DOOR. Who logged in is decided in exactly one place,
* `error_dispatch.settle_relogin_attempt(api_response)` → 'resume' |
* 'retry_form' | 'refused'. Only 'same' resumes (and settles the pending
* recovery recovered:true); 'differs'/'unknown' LATCH the page identity, settle
* recovered:false and reload through `reload_page()` — `save()` and
* `build_autoload` send nothing until a login as the page's own user clears it;
* a failed login ('retry_form') changes nothing. The overlay is TRANSPORT: it
* hands the envelope to the door and resumes (destroy, unlock, on_success) only
* on 'resume'. An earlier repair decided identity in the overlay AND in the
* recovery promise; each masked the other, so removing either check kept this
* suite green — cases (n) and (o) measure each half on its own.
*
* HOW IT IS MEASURED. The real chain: a real component_input_text (test52 on
* the test3 playground) and the real build_autoload, a real overlay
* (render_relogin, real login context) dispatched through the real
* `login.action_dispatch` as another user. What is counted is the OUTCOME — the
* requests that followed the login and the reloads asked for. data_manager.request
* is patched on the shared singleton for exactly two things (this case's saves
* and this case's probe read); everything else, the overlay's own context
* included, passes through to the server. Nothing reaches the database: every
* save is answered by the stub.
*
* Mutations of the ONE-DOOR design (each applied alone, MEASURED red
* 2026-10-11): M1 the door resumes without relogin_identity → (a)(c)(d)(e)(f)
* (h)(j)(n)(o)(p); M2 the door skips revoke_page_identity → (a)(e)(f)(n)(o)(p);
* M3 the door settles recovered:true on a refusal → (j); M4 the overlay
* resumes whatever the outcome → (a)(h)(n); M5 a login_successful subscriber
* (name built at runtime, past the spelling fence) settling recovered:true →
* (j)(m); M6 an inline relogin_identity call in render_login.js →
* relogin_identity_tripwire census; M7 no build_autoload latch → (f)(p); M8 no
* save() latch → (e); M9 the door not clearing the latch on 'same' → (e)(n)(o).
*
* Earlier mutations this suite must catch (each verified red): relogin_identity always
* 'same'; a login_successful subscriber resolving recovered:true (case j — the
* latch alone masks it at the write doors) or resuming queued work (case m —
* the OUTCOME fence on the event, whatever the subscriber's spelling); relogin()
* always recovered:false; no latch check in save() (e) or in build_autoload
* (f); the latched save() not publishing 'save' (e); the latched build_autoload
* leaving its instance 'building' (f); the latch not cleared on 'same'; the
* overlay guard calling on_success on 'differs'; a data:false answer (wrong
* password) treated as a refusal (l); a settled recovery not forgotten (q —
* every later session loss would "recover" with no overlay and re-send in an
* unbounded loop) and an overlay that fails to open leaving its waiters hanging
* (r — through the set_relogin_renderer_for_test seam).
*
* (s) THE TRANSPORT LATCH. save() and build_autoload are the doors with queued
* work, but every other write (a delete, a tree move, a tool action, an upload)
* goes straight to the transport — and the overlay's '.loading' lock does not
* stop the keyboard. So the latch is ALSO at the transport: while revoked,
* data_manager.request / request_stream / request_fetch_stream and the upload
* parts send nothing but the login door. Measured on the REAL transports with
* fetch and XMLHttpRequest counted (and faked, so nothing reaches the server);
* the positive controls are the same calls unlatched and a login-door action
* latched. Mutations (each MEASURED red 2026-10-11): T1 no check in
* data_manager.request; T2 none in request_fetch_stream; T3 none in
* request_stream; T4 none in upload send_part; T5 the login door refused too.
* The login door is measured MEMBER BY MEMBER (error_dispatch.LOGIN_DOOR_ACTIONS,
* and the real overlay submit login.prototype.login), and as the
* (dd_utils_api, action) PAIR — 'login' on dd_core_api is refused.
*
* (s2) THE RAW TRANSPORTS — agent_stream, builder_stream, the transcription
* unload cleanup (send_unload_cleanup) and the lock-release beacon
* (send_lock_release_beacon): each opens its own connection, so each asks the
* latch; the case counts what they SEND (positive control: unlatched, once each).
*
* (s3) THE TOKEN DOOR. A CSRF token is an identity. Every token on the wire
* carries `session_user_id` beside it, and data_manager adopts it — and makes its
* transparent CSRF resend — only through error_dispatch.settle_session_identity:
* a session of ANOTHER user (a login in another tab replaced the cookie's
* session) is never adopted, never resent with; the page latches and reloads
* once. Covers the csrf_failed resend, the success of a CSRF-exempt action, a
* token with no owner, a login-door answer (envelope kept, token not taken),
* and a page with no user yet (the bootstrap: adopted).
*
* (t) build_autoload from data ALREADY IN HAND (tmp_api_response) completes while
* latched and sends nothing; a build that must fetch is refused.
*/

import {ApiError} from '../../../core/common/js/api_error.js'
import {build_autoload} from '../../../core/common/js/common.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
// namespace import ON PURPOSE: a missing door must fail the cases that need it,
// not unlink the whole module before a single case can say what is missing
import * as error_dispatch from '../../../core/common/js/error_dispatch.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {reset_unsaved_data} from '../../../core/common/js/events.js'
import {get_all_instances, get_instance} from '../../../core/common/js/instances.js'
import {login} from '../../../core/login/js/login.js'
import {render_relogin} from '../../../core/login/js/render_login.js'
import {send_lock_release_beacon} from '../../../core/page/js/page.js'
import {create_transfer} from '../../../core/services/service_upload/js/upload_transport.js'
import {agent_stream} from '../../../tools/tool_assistant/js/agent_stream.js'
import {builder_stream} from '../../../tools/tool_sitebuilder/js/builder_stream.js'
import {send_unload_cleanup} from '../../../tools/tool_transcription/js/tool_transcription.js'
import {lang, section_id, section_tipo} from './elements.js'



describe('RELOGIN_IDENTITY — a queued action never resumes as another user', function() {

	this.timeout(30000)

	const container = document.getElementById('content')

	// the ONE harmless answer to a save that is not the session loss: a silent,
	// non-retryable code (error_policy.js: 'client.aborted' -> silent), so no
	// toast, no relogin, nothing written
	const SILENT_REFUSAL = 'client.aborted'

	const has_reload_seam = () => typeof error_dispatch.set_page_reloader_for_test==='function'
	const revoked = () => typeof error_dispatch.is_page_identity_revoked==='function'
		? error_dispatch.is_page_identity_revoked()
		: false

	const wait_for = async (predicate, label, timeout_ms = 10000) => {
		const started = Date.now()
		while (Date.now() - started < timeout_ms) {
			const value = predicate()
			if (value) return value
			await new Promise(resolve => setTimeout(resolve, 25))
		}
		throw new Error('timed out waiting for ' + label)
	}

	// settle or fail: a recovery that never settles must be a RED, not a hang
	const settle = (promise, label, timeout_ms = 10000) => Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' never settled')), timeout_ms))
	])

	const login_instances = () => get_all_instances().filter(el => el.model==='login')

	// the '.overlay' elements of MOUNTED login instances (render_relogin marks its
	// content_data '.overlay'); other suites' nodes cannot inflate the count
	const mounted_overlays = () => login_instances().reduce((count, login) => {
		const node = login.node
		if (!(node instanceof Element) || !node.isConnected) return count
		return count + (node.matches('.overlay') ? 1 : 0) + node.querySelectorAll('.overlay').length
	}, 0)

	// hold_guard: what replaces the overlay's guard ONLY when the reload seam is
	// missing (see dispatch_login) — a named no-op, not a post-login flow
	const hold_guard = () => undefined

	/**
	* SITUATION
	* Builds one case: the stub, the reload seam, the real component(s).
	*/
	const situation = async ({components = 1, fail_saves = 1, save_code = null} = {}) => {

		const s = {
			saves		: 0,
			probe_reads	: 0,
			reloads		: 0,
			probe_rqo	: null,
			fail_probe	: false,
			instances	: [],
			nodes		: [],
			restore		: [],
			page_user_id: page_globals.user_id,
			page_wrapper: null
		}

		// the page the overlay locks: render_relogin adds 'loading' to the first
		// '.wrapper.page' — the harness has none, so the case builds its own
		s.page_wrapper = document.createElement('div')
		s.page_wrapper.className = 'wrapper page'
		document.body.appendChild(s.page_wrapper)
		s.restore.push(() => { s.page_wrapper.remove() })

		// the real component(s), built and rendered BEFORE the stub
		for (let i = 0; i < components; i++) {
			const instance = await get_instance({
				model			: 'component_input_text',
				tipo			: 'test52',
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'edit',
				lang			: lang,
				id_variant		: 'relogin_identity_' + i + '_' + Date.now()
			})
			await instance.build(true)
			const node = await instance.render()
			container.appendChild(node)
			s.instances.push(instance)
			s.nodes.push(node)
		}

		// the stub: this case's saves and this case's probe read, nothing else
		const original_request = data_manager.request
		data_manager.request = async function(options) {
			const body = options?.body
			if (body?.action==='save') {
				s.saves++
				return {
					ok		: false,
					error	: new ApiError({
						code	: save_code
							? save_code(s.saves)
							: (s.saves <= fail_saves ? 'auth.not_logged' : SILENT_REFUSAL),
						source	: 'envelope'
					})
				}
			}
			if (s.probe_rqo && body===s.probe_rqo) {
				s.probe_reads++
				if (s.fail_probe && s.probe_reads===1) {
					return {ok:false, error: new ApiError({code:'auth.not_logged', source:'envelope'})}
				}
				return {ok:true, data:{context:[], data:[]}}
			}
			return original_request.call(this, options)
		}
		s.restore.push(() => { data_manager.request = original_request })

		// the reload seam: counted, never executed
		if (has_reload_seam()) {
			const restore_reloader = error_dispatch.set_page_reloader_for_test(() => { s.reloads++ })
			s.restore.push(restore_reloader)
		}

		return s
	}

	/**
	* DISPATCH_LOGIN
	* Waits for the ONE overlay the failing call opened, then logs in through the
	* real login.action_dispatch with the given envelope.
	*/
	const dispatch_login = async (api_response) => {
		const login = await wait_for(
			() => login_instances().find(el => el.status==='rendered' && el.node),
			'the re-login overlay'
		)
		// SAFETY, NOT A SHORTCUT: without the reload seam the overlay's guard
		// calls window.location.reload() for real — that would reload this test
		// frame and re-run the suite forever. A missing seam is already a red of
		// its own (case 'the reload seam exists'); here the guard is held so the
		// cases can still report what they measure (the requests that followed),
		// which login.js decides BEFORE the guard runs.
		if (!has_reload_seam()) {
			login.custom_action_dispatch = hold_guard
		}
		await login.action_dispatch(api_response)
		// let every recovery continuation run
		await new Promise(resolve => setTimeout(resolve, 100))
		return login
	}

	const teardown = async (s) => {
		for (const restore of s.restore.reverse()) {
			try { restore() } catch (e) { console.error(e) }
		}
		for (const login of login_instances()) {
			try { await login.destroy(true, true, true) } catch (e) { console.error(e) }
		}
		document.querySelectorAll('.wrapper.page.loading').forEach(el => { el.classList.remove('loading') })
		error_dispatch.reset_error_dispatch_state()
		page_globals.user_id = s.page_user_id
		for (const instance of s.instances) {
			try { await instance.destroy(true, true, true) } catch (e) { console.error(e) }
		}
		reset_unsaved_data()
	}

	const another_user = () => String(Number(page_globals.user_id) + 1000)
	const new_value = (tag) => 'relogin identity ' + tag + ' ' + Date.now() + ' ' + Math.random()
	const save_of = (instance, tag) => instance.save([{action:'update', key:0, value:new_value(tag)}])



	it('precondition: the page is logged in with a known user_id', function() {
		assert.strictEqual(page_globals.is_logged, true, 'the harness page is logged in')
		assert.ok(page_globals.user_id!==null && page_globals.user_id!==undefined, 'page_globals.user_id is set')
	})

	it('the reload seam exists (set_page_reloader_for_test / reload_page)', function() {
		assert.strictEqual(typeof error_dispatch.set_page_reloader_for_test, 'function')
		assert.strictEqual(typeof error_dispatch.reload_page, 'function')
	})

	it('(i) relogin_identity — the one identity primitive', function() {
		const decide = error_dispatch.relogin_identity
		assert.strictEqual(typeof decide, 'function', 'error_dispatch exports relogin_identity')
		assert.strictEqual(decide({ok:true, data:true, user_id:5}, '5'), 'same', 'number vs string id is the same user')
		assert.strictEqual(decide({ok:true, data:true, user_id:'5'}, 5), 'same')
		assert.strictEqual(decide({ok:true, data:true, user_id:6}, 5), 'differs')
		assert.strictEqual(decide({ok:true, data:true}, 5), 'unknown', 'a login without user_id is not a verified match')
		assert.strictEqual(decide({ok:true, data:true, user_id:null}, 5), 'unknown')
		assert.strictEqual(decide({ok:true, data:true, user_id:5}, null), 'unknown', 'a page without user_id cannot be matched')
		assert.strictEqual(decide({ok:true, data:true, user_id:5}, undefined), 'unknown')
		assert.strictEqual(decide({ok:true, data:false, user_id:5}, 5), 'not_logged')
		assert.strictEqual(decide({ok:false, error:{code:'auth.bad_credentials'}}, 5), 'not_logged')
		// the PHP-era nesting is NOT read: the TS server never emits it
		assert.strictEqual(decide({ok:true, data:true, result_options:{user_id:5}}, 5), 'unknown')
	})

	it('(a) save, login as ANOTHER user: no retry, one reload, still modified, identity latched', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const pending = save_of(instance, 'a')
			await dispatch_login({ok:true, data:true, user_id:another_user()})
			await settle(pending, 'the failed save')

			assert.strictEqual(s.saves, 1, 'the queued save is NOT re-sent under the other user\'s session')
			assert.strictEqual(s.reloads, 1, 'the page reloads instead of resuming')
			assert.isTrue(instance.node.classList.contains('modified'), 'the edit is still flagged unsaved')
			assert.isTrue(revoked(), 'the page identity is latched as revoked')
			// a refusal resumes NOTHING — not even the overlay's own teardown: the
			// form and the page lock stay up while the reload is under way
			assert.strictEqual(mounted_overlays(), 1, 'exactly one overlay is still mounted')
			assert.isTrue(s.page_wrapper.classList.contains('loading'), 'the page stays locked')
		} finally {
			await teardown(s)
		}
	})

	it('(b) positive control — save, login as the SAME user: retried once, no reload', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const pending = save_of(instance, 'b')
			await dispatch_login({ok:true, data:true, user_id:page_globals.user_id})
			await settle(pending, 'the recovered save')

			assert.strictEqual(s.saves, 2, 'the same user\'s re-login resumes the save exactly once')
			assert.strictEqual(s.reloads, 0, 'no reload for the page\'s own user')
			assert.isFalse(revoked(), 'nothing latched')
		} finally {
			await teardown(s)
		}
	})

	it('(c) save, login response WITHOUT user_id: no retry, one reload (fail closed)', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const pending = save_of(instance, 'c')
			await dispatch_login({ok:true, data:true})
			await settle(pending, 'the failed save')

			assert.strictEqual(s.saves, 1, 'an unresolvable identity is not a match: nothing is re-sent')
			assert.strictEqual(s.reloads, 1)
		} finally {
			await teardown(s)
		}
	})

	it('(d) save on a page WITHOUT user_id, login as another user: no retry, one reload', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const other = another_user()
			const pending = save_of(instance, 'd')
			page_globals.user_id = null
			await dispatch_login({ok:true, data:true, user_id:other})
			await settle(pending, 'the failed save')

			assert.strictEqual(s.saves, 1, 'a page that cannot say who it belongs to resumes nothing')
			assert.strictEqual(s.reloads, 1)
		} finally {
			await teardown(s)
		}
	})

	it('(e) latch — while revoked a save sends NOTHING; a login as the page user clears it', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const pending = save_of(instance, 'e1')
			const login = await dispatch_login({ok:true, data:true, user_id:another_user()})
			await settle(pending, 'the failed save')
			assert.strictEqual(s.saves, 1, 'no retry after the refused login')

			// the user cancelled the reload, or it has not happened yet: the
			// overlay is still up and the page still holds A's state
			const published = []
			const token = event_manager.subscribe('save', (payload) => {
				if (payload?.instance===instance) published.push(payload)
			})
			let blocked
			try {
				blocked = await settle(save_of(instance, 'e2'), 'the latched save')
			} finally {
				event_manager.unsubscribe(token)
			}
			assert.strictEqual(blocked, false, 'save() refuses while the page identity is revoked')
			assert.strictEqual(s.saves, 1, 'and sends no request')
			// observers waiting on this save are told it will not land
			assert.strictEqual(published.length, 1, 'the refused save publishes \'save\' exactly once')
			assert.strictEqual(published[0].api_response, null, 'with no api_response: nothing was sent')

			// the page's own user logs in on the overlay that is still open
			if (!has_reload_seam()) {
				login.custom_action_dispatch = hold_guard
			}
			await login.action_dispatch({ok:true, data:true, user_id:s.page_user_id})
			await new Promise(resolve => setTimeout(resolve, 100))
			assert.isFalse(revoked(), 'a login as the page\'s own user clears the latch')

			await settle(save_of(instance, 'e3'), 'the save after the latch cleared')
			assert.strictEqual(s.saves, 2, 'the next save reaches the wire again')
		} finally {
			await teardown(s)
		}
	})

	it('(f) build_autoload, login as ANOTHER user: one read, one reload', async function() {
		const s = await situation({components: 0})
		try {
			reset_unsaved_data()
			assert.strictEqual(window.unsaved_data, false, 'no unsaved data: the retry branch is reachable')
			s.probe_rqo = {action:'read', source:{model:'section', tipo:section_tipo, section_tipo:section_tipo}, relogin_identity_probe:'f'}
			s.fail_probe = true
			const fake = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building'}
			const pending = build_autoload(fake)
			await dispatch_login({ok:true, data:true, user_id:another_user()})
			const result = await settle(pending, 'build_autoload')

			assert.strictEqual(s.probe_reads, 1, 'the read is NOT re-sent under the other user\'s session')
			assert.strictEqual(s.reloads, 1)
			assert.strictEqual(result, false)

			// the reload was cancelled: a later paginate/refresh of this page builds
			// again while the identity is still latched
			assert.isTrue(revoked(), 'precondition: the page identity is latched')
			s.fail_probe = false
			const again = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building'}
			const latched = await settle(build_autoload(again), 'the latched build_autoload')
			assert.strictEqual(latched, false, 'a latched build answers false')
			assert.strictEqual(s.probe_reads, 1, 'and sends NO read under the other user\'s session')
			assert.strictEqual(again.status, 'initialized', 'and resets status, so no render() waits on a build that never ends')
		} finally {
			await teardown(s)
		}
	})

	it('(g) positive control — build_autoload, login as the SAME user: re-read once', async function() {
		const s = await situation({components: 0})
		try {
			reset_unsaved_data()
			s.probe_rqo = {action:'read', source:{model:'section', tipo:section_tipo, section_tipo:section_tipo}, relogin_identity_probe:'g'}
			s.fail_probe = true
			const fake = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building'}
			const pending = build_autoload(fake)
			await dispatch_login({ok:true, data:true, user_id:page_globals.user_id})
			await settle(pending, 'build_autoload')

			assert.strictEqual(s.probe_reads, 2, 'the same user\'s re-login re-sends the read once')
			assert.strictEqual(s.reloads, 0)
		} finally {
			await teardown(s)
		}
	})

	it('(j) the recovery promise itself: handle_api_error never answers recovered:true for another user', async function() {
		// The write doors above are ALSO guarded by the latch, which would hide a
		// recovery that resolved on 'login_successful' (published before the
		// guard): the retry would be refused at save()'s entry. The recovery
		// promise is a contract of its own — other callers retry on it without a
		// latch — so its outcome is measured directly.
		const s = await situation({components: 0})
		try {
			const pending = error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			await dispatch_login({ok:true, data:true, user_id:another_user()})
			const outcome = await settle(pending, 'the relogin recovery')

			assert.strictEqual(outcome.recovered, false, 'another identity never recovers the failed call')
			assert.strictEqual(outcome.reason, 'differs')
			assert.strictEqual(s.reloads, 1)
		} finally {
			await teardown(s)
		}
	})

	it('(k) positive control — the recovery promise answers recovered:true for the same user', async function() {
		const s = await situation({components: 0})
		try {
			const pending = error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			await dispatch_login({ok:true, data:true, user_id:page_globals.user_id})
			const outcome = await settle(pending, 'the relogin recovery')

			assert.strictEqual(outcome.recovered, true)
			assert.strictEqual(s.reloads, 0)
		} finally {
			await teardown(s)
		}
	})

	it('(l) a wrong password (data:false) is NOT a refusal: no reload, no latch, the overlay stays', async function() {
		const s = await situation()
		try {
			const [instance] = s.instances
			const pending = save_of(instance, 'l')
			const login = await dispatch_login({ok:true, data:false})

			assert.strictEqual(s.reloads, 0, 'a failed login reloads nothing')
			assert.isFalse(revoked(), 'and latches nothing: no identity was authenticated')
			assert.strictEqual(login_instances().length, 1, 'the overlay is still the one open')
			assert.isTrue(login.node instanceof Element && login.node.isConnected, 'and still on the page, to try again')
			assert.strictEqual(s.saves, 1, 'the queued save waits')

			// the page's own user then logs in on that same overlay
			await login.action_dispatch({ok:true, data:true, user_id:s.page_user_id})
			await settle(pending, 'the recovered save')
			assert.strictEqual(s.saves, 2, 'and the save resumes once')
		} finally {
			await teardown(s)
		}
	})

	it('(m) the login_successful EVENT resumes nothing — only the overlay door does', async function() {
		// login.js publishes 'login_successful' BEFORE the overlay's identity
		// guard runs, so ANY subscriber that resumes queued work on it — however
		// the event name is spelt in its source — resumes it as whoever logged
		// in. Measured as the outcome: the event alone moves no queued save, no
		// queued read and no recovery promise.
		const s = await situation()
		try {
			const [instance] = s.instances
			reset_unsaved_data()
			const pending_save = save_of(instance, 'm')
			await wait_for(() => s.saves===1, 'the save to fail')
			const recovery = error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			let recovery_settled = false
			recovery.then(() => { recovery_settled = true }, () => { recovery_settled = true })
			const login = await wait_for(
				() => login_instances().find(el => el.status==='rendered' && el.node),
				'the re-login overlay'
			)

			event_manager.publish('login_successful', {ok:true, data:true, user_id:another_user()})
			event_manager.publish('login_successful', {ok:true, data:true, user_id:s.page_user_id})
			await new Promise(resolve => setTimeout(resolve, 200))

			assert.strictEqual(s.saves, 1, 'no queued save was re-sent on the event')
			assert.isFalse(recovery_settled, 'no recovery promise settled on the event')
			assert.strictEqual(s.reloads, 0, 'the event decides nothing')

			// the door: the page's own user logs in on the overlay
			await login.action_dispatch({ok:true, data:true, user_id:s.page_user_id})
			const outcome = await settle(recovery, 'the relogin recovery')
			await settle(pending_save, 'the recovered save')
			assert.strictEqual(outcome.recovered, true, 'the overlay door recovers')
			assert.strictEqual(s.saves, 2, 'and resumes the save exactly once')
		} finally {
			await teardown(s)
		}
	})

	it('(n) the overlay is transport: a standalone overlay never calls on_success for ANOTHER user', async function() {
		// render_relogin used on its own (no pending recovery — e.g. the
		// no_logged error page): its on_success must follow the door's verdict,
		// not a check of its own that could disagree with it.
		const s = await situation({components: 0})
		try {
			assert.strictEqual(document.querySelector('.wrapper.page'), s.page_wrapper, 'precondition: the case owns the page wrapper')
			const calls = []
			const login = await render_relogin({on_success: (...args) => { calls.push(args) }})
			if (!has_reload_seam()) {
				login.custom_action_dispatch = hold_guard
			}
			await login.action_dispatch({ok:true, data:true, user_id:another_user()})
			await new Promise(resolve => setTimeout(resolve, 100))

			assert.strictEqual(calls.length, 0, 'on_success is NOT called for another user')
			assert.strictEqual(s.reloads, 1, 'the page reloads instead')
			assert.isTrue(revoked(), 'and the page identity is latched')
			assert.isTrue(login.node instanceof Element && login.node.isConnected, 'the overlay stays mounted')
			assert.isTrue(s.page_wrapper.classList.contains('loading'), 'the page stays locked')

			// positive control: the page's own user on the same overlay resumes once
			await login.action_dispatch({ok:true, data:true, user_id:s.page_user_id})
			await new Promise(resolve => setTimeout(resolve, 100))
			assert.strictEqual(calls.length, 1, 'the page\'s own user resumes exactly once')
			assert.isFalse(revoked(), 'the latch is lifted')
			assert.isFalse(s.page_wrapper.classList.contains('loading'), 'and the page unlocked')
		} finally {
			await teardown(s)
		}
	})

	it('(o) settle_relogin_attempt — the ONE door: each envelope, its outcome, its side effects', async function() {
		const door = error_dispatch.settle_relogin_attempt
		assert.strictEqual(typeof door, 'function', 'error_dispatch exports settle_relogin_attempt (the one identity door)')
		const s = await situation({components: 0})
		try {
			const other = another_user()

			assert.strictEqual(door({ok:true, data:false}), 'retry_form', 'a failed login (data:false): the form stays')
			assert.strictEqual(s.reloads, 0, 'retry_form reloads nothing')
			assert.isFalse(revoked(), 'retry_form latches nothing')

			assert.strictEqual(door({ok:true, data:true, user_id:s.page_user_id}), 'resume', 'the page\'s own user resumes')
			assert.strictEqual(s.reloads, 0, 'resume reloads nothing')
			assert.isFalse(revoked(), 'resume latches nothing')

			assert.strictEqual(door({ok:true, data:true, user_id:other}), 'refused', 'another user is refused')
			assert.strictEqual(s.reloads, 1, 'a refusal reloads once')
			assert.isTrue(revoked(), 'a refusal latches the page identity')

			assert.strictEqual(door({ok:true, data:true, user_id:String(s.page_user_id)}), 'resume', 'the page user (id as string) resumes')
			assert.isFalse(revoked(), 'and lifts the latch')
			assert.strictEqual(s.reloads, 1)

			assert.strictEqual(door({ok:true, data:true}), 'refused', 'no user_id in the envelope: refused (fail closed)')
			assert.strictEqual(s.reloads, 2)
			assert.isTrue(revoked())
			door({ok:true, data:true, user_id:s.page_user_id})

			page_globals.user_id = null
			assert.strictEqual(door({ok:true, data:true, user_id:other}), 'refused', 'a page without user_id resumes nothing')
			assert.strictEqual(s.reloads, 3)
			assert.isTrue(revoked())
		} finally {
			await teardown(s)
		}
	})

	it('(p) a refusal through the overlay latches build_autoload: no read is sent while revoked', async function() {
		const s = await situation({components: 0})
		try {
			reset_unsaved_data()
			const recovery = error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			await dispatch_login({ok:true, data:true, user_id:another_user()})
			await settle(recovery, 'the relogin recovery')
			assert.isTrue(revoked(), 'precondition: the refused login latched the page identity')

			s.probe_rqo = {action:'read', source:{model:'section', tipo:section_tipo, section_tipo:section_tipo}, relogin_identity_probe:'p'}
			const fake = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building'}
			const result = await settle(build_autoload(fake), 'the latched build_autoload')

			assert.strictEqual(result, false, 'a latched build answers false')
			assert.strictEqual(s.probe_reads, 0, 'and sends NO read under the other user\'s session')
			assert.strictEqual(fake.status, 'initialized', 'and resets status')
		} finally {
			await teardown(s)
		}
	})

	it('(q) a SECOND session loss after a recovered one opens a NEW overlay and resumes nothing before it', async function() {
		// The settled recovery must be forgotten. If it is not, every later
		// session loss on this page gets the old {recovered:true} back without an
		// overlay: save() re-sends at once, fails, "recovers", re-sends — an
		// unbounded request loop, and the user never sees a login box again.
		// Bounded here: the 4th save onward answers the silent refusal.
		const s = await situation({save_code: (n) => (n===1 || n===3) ? 'auth.not_logged' : SILENT_REFUSAL})
		try {
			const [instance] = s.instances
			const first_save = save_of(instance, 'q1')
			const first_login = await dispatch_login({ok:true, data:true, user_id:s.page_user_id})
			await settle(first_save, 'the first recovered save')
			assert.strictEqual(s.saves, 2, 'first loss: resumed exactly once')

			const second_save = save_of(instance, 'q2')
			await wait_for(() => s.saves>=3, 'the second loss')
			const second_login = await wait_for(
				() => login_instances().find(el => el!==first_login && el.status==='rendered' && el.node),
				'a NEW re-login overlay for the second loss'
			)
			// let any wrongly-resolved recovery run its resend before counting
			await new Promise(resolve => setTimeout(resolve, 200))
			assert.strictEqual(s.saves, 3, 'nothing is re-sent before the new overlay is answered')

			if (!has_reload_seam()) {
				second_login.custom_action_dispatch = hold_guard
			}
			await second_login.action_dispatch({ok:true, data:true, user_id:s.page_user_id})
			await settle(second_save, 'the second recovered save')
			assert.strictEqual(s.saves, 4, 'second loss: resumed exactly once, by its own overlay')
			assert.strictEqual(s.reloads, 0)
		} finally {
			await teardown(s)
		}
	})

	it('(r) the overlay FAILS to open: every waiter settles recovered:false, and the next loss tries again', async function() {
		assert.strictEqual(typeof error_dispatch.set_relogin_renderer_for_test, 'function', 'error_dispatch exports the overlay seam')
		const s = await situation({components: 0})
		let opened = 0
		const restore_renderer = error_dispatch.set_relogin_renderer_for_test(() => {
			opened++
			return Promise.reject(new Error('relogin overlay failed to load (test)'))
		})
		s.restore.push(restore_renderer)
		try {
			const loss = () => error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			const waiters = [loss(), loss()]
			const outcomes = await settle(Promise.all(waiters), 'the waiters of a failed overlay', 5000)
			assert.deepEqual(outcomes.map(o => o.recovered), [false, false], 'every waiter settles recovered:false')
			assert.strictEqual(opened, 1, 'one overlay attempt for one session loss')

			// the failed attempt is forgotten: the next loss tries to open again
			const next = await settle(loss(), 'the next loss', 5000)
			assert.strictEqual(next.recovered, false)
			assert.strictEqual(opened, 2, 'a new loss opens a new attempt, not the settled one')
			assert.strictEqual(s.reloads, 0)
			assert.isFalse(revoked(), 'a failed overlay latches nothing')
		} finally {
			await teardown(s)
		}
	})

	it('(r2) the overlay renderer THROWS synchronously: same outcome as a rejection — settled, not rejected, retried next loss', async function() {
		const s = await situation({components: 0})
		let opened = 0
		const restore_renderer = error_dispatch.set_relogin_renderer_for_test(() => {
			opened++
			throw new Error('relogin overlay threw synchronously (test)')
		})
		s.restore.push(restore_renderer)
		try {
			const loss = () => error_dispatch.handle_api_error(
				new ApiError({code:'auth.not_logged', source:'envelope'}),
				{}
			)
			// allSettled: a REJECTED waiter (the throw escaping the promise
			// executor) is the defect, so it must be observed, not thrown here
			const results = await settle(Promise.allSettled([loss(), loss()]), 'the waiters of a throwing overlay', 5000)
			assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled'], 'no waiter is rejected')
			assert.deepEqual(results.map(r => r.value?.recovered), [false, false], 'every waiter settles recovered:false')
			assert.strictEqual(opened, 1, 'one overlay attempt for one session loss')

			const [next] = await settle(Promise.allSettled([loss()]), 'the next loss', 5000)
			assert.strictEqual(next.status, 'fulfilled', 'the next loss is not handed a stale rejection')
			assert.strictEqual(next.value?.recovered, false)
			assert.strictEqual(opened, 2, 'a new loss opens a new attempt')
			assert.strictEqual(s.reloads, 0)
			assert.isFalse(revoked(), 'a throwing overlay latches nothing')
		} finally {
			await teardown(s)
		}
	})

	it('(s) the TRANSPORT latch: while revoked nothing but the login door is sent — request, both streams, an upload', async function() {
		assert.strictEqual(typeof error_dispatch.revoke_page_identity, 'function')

		// count (and fake) every fetch and every XHR: nothing reaches the server
		const original_fetch = window.fetch
		const original_xhr = window.XMLHttpRequest
		const sent = {fetch: [], xhr: 0}
		window.fetch = async (url, init) => {
			let action = null
			try { action = JSON.parse(init?.body ?? 'null')?.action ?? null } catch (e) { action = '(unparsed)' }
			sent.fetch.push(action)
			return new Response(JSON.stringify({ok:true, data:true}), {
				status	: 200,
				headers	: {'Content-Type': 'application/json'}
			})
		}
		// an XHR that never opens a socket: answers its load with a refusal so
		// the transfer settles on its own (the positive control's outcome)
		class CountingXhr extends window.EventTarget {
			constructor() { super(); this.upload = new window.EventTarget(); this.status = 0; this.response = ''; this.responseText = '' }
			open() {}
			setRequestHeader() {}
			abort() {}
			send() {
				sent.xhr++
				// 400, not 503: a 502/503/504 is retried (upload_transport), a 4xx is terminal
				this.status = 400
				setTimeout(() => {
					const evt = new Event('load')
					Object.defineProperty(evt, 'target', {value: this})
					this.dispatchEvent(evt)
					this.dispatchEvent(new Event('loadend'))
				}, 0)
			}
		}
		window.XMLHttpRequest = CountingXhr

		const write_body = () => ({
			action	: 'delete',
			dd_api	: 'dd_core_api',
			source	: {section_tipo: section_tipo, section_id: section_id, tipo: section_tipo, model: 'section'}
		})
		const upload = () => create_transfer({
			file			: new Blob(['relogin identity upload']),
			name			: 'relogin_identity.txt',
			key_dir			: 'relogin_identity',
			tipo			: 'test52',
			chunk_size_mb	: 0,
			max_retry		: 1
		}).start()
		const stream_refusal = async (door) => {
			try {
				await data_manager[door]({body: write_body()})
				return null
			} catch (error) {
				return error
			}
		}

		try {
			// POSITIVE CONTROL — unlatched, each transport does send
			assert.isFalse(revoked(), 'precondition: not revoked')
			const open_response = await data_manager.request({body: write_body(), retries: 1})
			assert.deepEqual(sent.fetch, ['delete'], 'unlatched: the write is sent')
			assert.strictEqual(open_response.ok, true)
			await data_manager.request_fetch_stream({body: write_body()})
			assert.strictEqual(sent.fetch.length, 2, 'unlatched: request_fetch_stream sends')
			await upload()
			assert.strictEqual(sent.xhr, 1, 'unlatched: the upload part is sent')

			// LATCHED — nothing but the login door
			error_dispatch.revoke_page_identity('differs')
			sent.fetch.length = 0
			sent.xhr = 0

			const refused = await data_manager.request({body: write_body(), retries: 1})
			assert.strictEqual(refused.ok, false)
			assert.strictEqual(refused.error?.code, 'client.aborted')
			assert.strictEqual(refused.error?.details?.reason, 'page_identity_revoked')

			const fetch_stream_error = await stream_refusal('request_fetch_stream')
			assert.strictEqual(fetch_stream_error?.code, 'client.aborted', 'request_fetch_stream rejects')
			const sse_error = await stream_refusal('request_stream')
			assert.strictEqual(sse_error?.code, 'client.aborted', 'request_stream rejects')

			const upload_response = await upload()
			assert.strictEqual(upload_response.ok, false)
			assert.strictEqual(upload_response.error?.details?.reason, 'page_identity_revoked')

			assert.deepEqual(sent.fetch, [], 'latched: no fetch left the page')
			assert.strictEqual(sent.xhr, 0, 'latched: no upload part left the page')

			// ...and the login door stays open: EVERY member of it — the overlay must
			// still be able to log the page's own user back in, and the page to log out
			const login_doors = [...(error_dispatch.LOGIN_DOOR_ACTIONS ?? [])]
			assert.isAtLeast(login_doors.length, 5, 'error_dispatch exports its LOGIN_DOOR_ACTIONS')
			for (const action of login_doors) {
				await data_manager.request({body: {action, dd_api:'dd_utils_api', options:{}}, retries: 1})
			}
			assert.deepEqual(sent.fetch, login_doors, 'latched: every login-door action is sent')
			sent.fetch.length = 0

			// the REAL overlay submit (login.prototype.login) reaches the wire
			await login.prototype.login.call({}, {username: 'relogin_identity_probe', auth: 'x'})
			assert.deepEqual(sent.fetch, ['login'], 'latched: the overlay form\'s login is sent')
			sent.fetch.length = 0

			// the exemption is the (dd_utils_api, action) PAIR: the same action name on
			// another class, and a non-login action on dd_utils_api, are refused
			const pair_refused = await data_manager.request({body: {action:'login', dd_api:'dd_core_api', options:{}}, retries: 1})
			assert.strictEqual(pair_refused.error?.details?.reason, 'page_identity_revoked', 'login on dd_core_api is refused')
			await data_manager.request({body: {action:'change_lang', dd_api:'dd_utils_api', options:{}}, retries: 1})
			assert.deepEqual(sent.fetch, [], 'latched: login on another class and another dd_utils_api action are refused')

			// the latch lifted (the page user logged back in): sent again
			error_dispatch.clear_page_identity_revoked()
			await data_manager.request({body: write_body(), retries: 1})
			assert.deepEqual(sent.fetch, ['delete'], 'cleared: the write is sent again')
		} finally {
			window.fetch = original_fetch
			window.XMLHttpRequest = original_xhr
			error_dispatch.reset_error_dispatch_state()
		}
	})

	it('(s2) the RAW transports ask the latch and STOP: agent_stream, builder_stream, the unload cleanup, the lock beacon', async function() {
		// each of these opens its own connection (no data_manager): the census
		// (client_idempotency_tripwire) proves they CALL refused_by_page_identity;
		// this case proves the answer stops the send. Positive control first:
		// unlatched, each one sends exactly once.
		const original_fetch = window.fetch
		const sent = []
		window.fetch = async (url, init) => {
			let action = null
			try { action = JSON.parse(init?.body ?? 'null')?.action ?? null } catch (e) { action = '(unparsed)' }
			sent.push(action)
			return new Response(JSON.stringify({ok:true, data:true}), {
				status	: 200,
				headers	: {'Content-Type': 'application/json'}
			})
		}
		const beacons = []
		const send_beacon = (url, data) => { beacons.push(url); return true }

		const run_all = async () => {
			const errors = {agent: null, builder: null}
			await agent_stream({
				options		: {question: 'relogin identity probe'},
				on_error	: (e) => { errors.agent = e },
				on_final	: () => {}
			})
			await builder_stream({
				options		: {session_id: 'relogin_identity_probe', after: 0},
				on_error	: (e) => { errors.builder = e },
				on_done		: () => {}
			})
			const cleanup_sent = send_unload_cleanup({
				dd_api	: 'dd_tools_api',
				action	: 'tool_request',
				source	: {model: 'tool_transcription', action: 'delete_transcribable_audio_file'},
				options	: {}
			})
			const beacon_sent = send_lock_release_beacon({
				component_active	: {section_tipo: section_tipo, tipo: 'test52', mode: 'edit'},
				csrf_token			: 'relogin-identity-probe',
				api_url				: '/relogin_identity_probe_beacon',
				send_beacon			: send_beacon
			})
			return {errors, cleanup_sent, beacon_sent}
		}

		try {
			assert.isFalse(revoked(), 'precondition: not revoked')
			const open = await run_all()
			assert.deepEqual(sent, ['agent_chat_stream', 'tool_request', 'tool_request'], 'unlatched: each raw fetch is sent once')
			assert.strictEqual(open.cleanup_sent, true)
			assert.strictEqual(open.beacon_sent, true)
			assert.strictEqual(beacons.length, 1, 'unlatched: the lock beacon is sent')

			error_dispatch.revoke_page_identity('differs')
			sent.length = 0
			beacons.length = 0
			const latched = await run_all()
			assert.deepEqual(sent, [], 'latched: no raw fetch left the page')
			assert.strictEqual(beacons.length, 0, 'latched: no lock beacon — it would release the NEW session user\'s locks')
			assert.strictEqual(latched.cleanup_sent, false)
			assert.strictEqual(latched.beacon_sent, false)
			for (const [door, error] of Object.entries(latched.errors)) {
				assert.strictEqual(error?.code, 'client.aborted', door + ' answers client.aborted')
				assert.strictEqual(error?.details?.reason, 'page_identity_revoked', door + ' names the reason')
			}
		} finally {
			window.fetch = original_fetch
			error_dispatch.reset_error_dispatch_state()
		}
	})

	it('(s3) THE TOKEN DOOR: a session of ANOTHER user is never adopted — no CSRF resend, no token from an exempt success; the page latches and reloads', async function() {
		assert.strictEqual(typeof error_dispatch.settle_session_identity, 'function', 'error_dispatch exports settle_session_identity')

		const page_user_id	= page_globals.user_id
		const page_token	= page_globals.csrf_token
		const other			= another_user()
		let reloads = 0
		const restore_reloader = error_dispatch.set_page_reloader_for_test(() => { reloads++ })

		// a fake server: the queued answers, in order; every send recorded
		const original_fetch = window.fetch
		const sent = []
		let answers = []
		window.fetch = async (url, init) => {
			let action = null
			try { action = JSON.parse(init?.body ?? 'null')?.action ?? null } catch (e) { action = '(unparsed)' }
			sent.push({action, token: init?.headers?.['X-Dedalo-Csrf-Token'] ?? null})
			const [status, body] = answers.shift() ?? [200, {ok:true, data:true}]
			return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}})
		}
		const csrf_failed = (session_user_id, token) => [403, {
			ok			: false,
			error		: {code: 'auth.csrf_failed', retryable: true},
			action		: 'save',
			csrf_token	: token,
			session_user_id
		}]
		const write_body = () => ({action:'save', dd_api:'dd_core_api', source:{section_tipo, section_id, tipo:'test52', model:'component_input_text'}})
		const reset = () => {
			sent.length = 0
			answers = []
			reloads = 0
			page_globals.csrf_token = 'token-of-A'
			page_globals.user_id = page_user_id
			error_dispatch.reset_error_dispatch_state()
			error_dispatch.set_page_reloader_for_test(() => { reloads++ })
		}

		try {
			// (1) POSITIVE CONTROL — the page's own session (A logged out and back in
			// elsewhere): the token is adopted and the request resent ONCE
			reset()
			answers = [csrf_failed(page_user_id, 'token-of-A2'), [200, {ok:true, data:'saved', csrf_token:'token-of-A2', session_user_id:page_user_id}]]
			const resumed = await data_manager.request({body: write_body(), retries: 1})
			assert.deepEqual(sent.map(x => x.token), ['token-of-A', 'token-of-A2'], 'same user: resent once with the fresh token')
			assert.strictEqual(resumed.ok, true)
			assert.strictEqual(page_globals.csrf_token, 'token-of-A2')
			assert.strictEqual(reloads, 0)
			assert.isFalse(revoked())

			// (2) THE DEFECT — the cookie now holds B's session: csrf_failed carries
			// B's token. Never resent, never adopted; latched; one reload
			reset()
			answers = [csrf_failed(other, 'token-of-B')]
			const refused = await data_manager.request({body: write_body(), retries: 1})
			assert.strictEqual(sent.length, 1, 'another user: the save is NOT resent under B\'s session')
			assert.strictEqual(refused.ok, false)
			assert.strictEqual(refused.error?.code, 'client.aborted')
			assert.strictEqual(refused.error?.details?.reason, 'page_identity_revoked')
			assert.strictEqual(page_globals.csrf_token, 'token-of-A', 'B\'s token is not adopted')
			assert.isTrue(revoked(), 'the page identity is latched')
			assert.strictEqual(reloads, 1, 'the page reloads')
			// and nothing else leaves it
			await data_manager.request({body: write_body(), retries: 1})
			assert.strictEqual(sent.length, 1, 'latched: the next save sends nothing')

			// (3) the same session reached through a SUCCESS: an exempt action
			// (get_environment passes the CSRF gate) answered by B's session hands
			// B's valid token over — never adopted
			reset()
			answers = [[200, {ok:true, data:{}, csrf_token:'token-of-B', session_user_id:other}]]
			const exempt = await data_manager.request({body: {action:'get_environment', dd_api:'dd_core_api'}, retries: 1})
			assert.strictEqual(exempt.error?.details?.reason, 'page_identity_revoked', 'the answer of B\'s session is not this page\'s')
			assert.strictEqual(page_globals.csrf_token, 'token-of-A', 'a success does not carry B\'s token over either')
			assert.isTrue(revoked())
			assert.strictEqual(reloads, 1)

			// (4) an envelope that names NO session user, on a page with one: fail closed
			reset()
			answers = [[200, {ok:true, data:{}, csrf_token:'token-of-who'}]]
			const nameless = await data_manager.request({body: {action:'get_environment', dd_api:'dd_core_api'}, retries: 1})
			assert.strictEqual(nameless.error?.details?.reason, 'page_identity_revoked')
			assert.strictEqual(page_globals.csrf_token, 'token-of-A')
			assert.isTrue(revoked())

			// (5) a LOGIN-DOOR answer keeps its envelope (the login door decides what
			// a login means — settle_relogin_attempt), but B's token is still not taken
			reset()
			answers = [[200, {ok:true, data:true, user_id:other, csrf_token:'token-of-B', session_user_id:other}]]
			const login_answer = await data_manager.request({body: {action:'login', dd_api:'dd_utils_api', options:{}}, retries: 1})
			assert.strictEqual(login_answer.ok, true, 'the login envelope reaches its caller')
			assert.strictEqual(login_answer.user_id, other)
			assert.strictEqual(page_globals.csrf_token, 'token-of-A', 'B\'s token is not adopted on A\'s page')
			assert.isFalse(revoked(), 'the token door leaves a login to the login door')
			assert.strictEqual(reloads, 0)
			// ...and a refused token is never resent with, not even on a login door
			// (quit is CSRF-gated): one send, the refusal kept for the caller
			reset()
			answers = [csrf_failed(other, 'token-of-B')]
			const quit_answer = await data_manager.request({body: {action:'quit', dd_api:'dd_utils_api', options:{}}, retries: 1})
			assert.strictEqual(sent.length, 1, 'a login door is not resent with another user\'s token')
			assert.strictEqual(quit_answer.error?.code, 'auth.csrf_failed')
			assert.strictEqual(page_globals.csrf_token, 'token-of-A')

			// (6) a page with NO user yet (the start bootstrap, the login page)
			// holds nobody's state: it adopts
			reset()
			page_globals.user_id = null
			answers = [[200, {ok:true, data:{}, csrf_token:'token-of-boot', session_user_id:other}]]
			const boot = await data_manager.request({body: {action:'start', dd_api:'dd_core_api'}, retries: 1})
			assert.strictEqual(boot.ok, true)
			assert.strictEqual(page_globals.csrf_token, 'token-of-boot')
			assert.isFalse(revoked())

			// (7) the decision itself, and ONE reload however many answers refuse
			reset()
			const door = error_dispatch.settle_session_identity
			assert.strictEqual(error_dispatch.session_identity({session_user_id: String(page_user_id)}), 'same')
			assert.strictEqual(error_dispatch.session_identity({session_user_id: other}), 'differs')
			assert.strictEqual(error_dispatch.session_identity({}), 'unknown')
			assert.strictEqual(error_dispatch.session_identity({session_user_id: other}, null), 'anonymous_page')
			assert.strictEqual(door({session_user_id: other}, write_body()), 'refused')
			assert.strictEqual(door({session_user_id: other}, write_body()), 'refused')
			assert.strictEqual(reloads, 1, 'a second refusal while latched reloads nothing more')
		} finally {
			window.fetch = original_fetch
			page_globals.csrf_token = page_token
			page_globals.user_id = page_user_id
			restore_reloader()
			error_dispatch.reset_error_dispatch_state()
		}
	})

	it('(t) a build from data ALREADY IN HAND (tmp_api_response) proceeds while latched and sends nothing; one that must fetch is refused', async function() {
		const s = await situation({components: 0})
		try {
			error_dispatch.revoke_page_identity('differs')
			s.probe_rqo = {action:'read', source:{model:'section', tipo:section_tipo, section_tipo:section_tipo}, relogin_identity_probe:'t'}

			const preloaded_response = {ok:true, data:{context:[], data:[]}}
			const preloaded = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building', tmp_api_response:preloaded_response}
			const built = await settle(build_autoload(preloaded), 'the preloaded build_autoload')
			assert.strictEqual(built, preloaded_response, 'the preloaded build completes with the data it holds')
			assert.strictEqual(s.probe_reads, 0, 'and sends nothing')

			const fetching = {model:'section', tipo:section_tipo, rqo:s.probe_rqo, node:null, status:'building'}
			const refused = await settle(build_autoload(fetching), 'the latched build_autoload')
			assert.strictEqual(refused, false, 'a build that must fetch is refused')
			assert.strictEqual(s.probe_reads, 0, 'and sends nothing')
		} finally {
			await teardown(s)
		}
	})

	it('(h) two concurrent failing saves, ONE overlay, login as ANOTHER user: zero retries', async function() {
		const s = await situation({components: 2, fail_saves: 2})
		try {
			const pending = s.instances.map((instance, i) => save_of(instance, 'h' + i))
			await wait_for(() => s.saves===2, 'both saves to fail')
			await dispatch_login({ok:true, data:true, user_id:another_user()})
			await settle(Promise.all(pending), 'the two failed saves')

			assert.strictEqual(s.saves, 2, 'neither queued save is re-sent')
			assert.strictEqual(login_instances().length, 1, 'one overlay for one session loss')
			assert.strictEqual(s.reloads, 1)
		} finally {
			await teardown(s)
		}
	})
})



// @license-end
