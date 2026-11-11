// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/
'use strict';

/**
* TEST_ERROR_POLICY
* The pure policy table (core/common/js/error_policy.js) and its executor
* (error_dispatch.js `handle_api_error`).
*
* WHY THESE ASSERTIONS. The table is what turns a CODE into what the user sees;
* the wrong row is a session loss shown as a toast, or a validation message
* shown as a full-page panel. So: exact → `<domain>.*` → `'*'` resolution is
* asserted per row the plan names, the bare v1 tokens are asserted NOT to be
* codes any more (the compat aliases went with the server mirror on
* 2026-08-16), and the additive registration is asserted to refuse core
* overrides — a tool that softens `auth.not_logged` is a bug, not a feature.
*
* handle_api_error is exercised without a backend: the page-level actions only
* set `page_globals.page_error`, the toast goes
* through the 'notification' event (captured, and asserted deduped), the relogin
* action is asserted NOT to open when the page is not logged in (the "never a
* SECOND login" rule) — a real overlay needs the login context from the server.
*/

import {
	CORE_POLICY,
	ERROR_ACTIONS,
	resolve_error_policy,
	register_error_policy,
	unregister_error_policy
} from '../../../core/common/js/error_policy.js'
import {
	handle_api_error,
	handle_api_notice,
	handle_api_notices,
	api_error_from_notice,
	outcome_unknown,
	reset_error_dispatch_state
} from '../../../core/common/js/error_dispatch.js'
import {ApiError, CLIENT_ERROR} from '../../../core/common/js/api_error.js'
import {event_manager} from '../../../core/common/js/event_manager.js'



describe('ERROR_POLICY — resolution', function() {

	it('every core entry names a known action', function() {
		for (const [key, entry] of Object.entries(CORE_POLICY)) {
			assert.include(ERROR_ACTIONS, entry.action, key)
		}
	})

	it('resolves the plan\'s rows: exact code → action', function() {
		const expected = {
			'auth.not_logged'			: 'relogin',
			'auth.csrf_failed'			: 'csrf_retry',
			'perm.denied'				: 'no_access_page',
			'request.invalid_tipo'		: 'page_panel',
			'request.invalid_context'	: 'page_panel',
			'record.in_use'				: 'modal',
			'client.network'			: 'toast',
			'client.timeout'			: 'toast',
			'client.aborted'			: 'silent',
			'lock.update_state'			: 'silent'
		}
		for (const [code, action] of Object.entries(expected)) {
			assert.equal(resolve_error_policy(code).action, action, code)
			assert.equal(resolve_error_policy(new ApiError({code})).action, action, code + ' (ApiError)')
		}
		assert.equal(resolve_error_policy('perm.denied').label, 'no_access_page')
		assert.equal(resolve_error_policy('client.network').severity, 'warning')
	})

	it('the bare v1 tokens are NOT aliases any more (compat removed 2026-08-16): they fall to *', function() {
		assert.equal(resolve_error_policy('not_logged').matched, '*')
		assert.equal(resolve_error_policy('csrf_failed').matched, '*')
		assert.equal(resolve_error_policy('not_authorized').matched, '*')
	})

	it('falls through exact → <domain>.* → *', function() {
		assert.equal(resolve_error_policy('validation.date_format').action, 'inline')
		assert.equal(resolve_error_policy('validation.date_format').matched, 'validation.*')
		assert.equal(resolve_error_policy('perm.section_read').action, 'no_access_page')
		assert.equal(resolve_error_policy('internal.unexpected').action, 'toast')
		assert.equal(resolve_error_policy('internal.unexpected').matched, '*')
		assert.equal(resolve_error_policy('').matched, '*')
		assert.equal(resolve_error_policy(null).matched, '*')
	})

	it('register_error_policy is additive, wins for its own domain, and cannot override a core code', function() {
		const keys = ['site_builder.*', 'site_builder.publish_failed']
		try {
			const count = register_error_policy({
				'site_builder.*'				: {action: 'toast', severity: 'warning'},
				'site_builder.publish_failed'	: {action: 'modal'}
			})
			assert.equal(count, 2)
			assert.equal(resolve_error_policy('site_builder.publish_failed').action, 'modal')
			assert.equal(resolve_error_policy('site_builder.other').action, 'toast')
			assert.equal(resolve_error_policy('site_builder.other').matched, 'site_builder.*')

			// core override: throws under SHOW_DEBUG, warns otherwise — either way the core row stays
			const original_debug = window.SHOW_DEBUG
			try {
				window.SHOW_DEBUG = true
				assert.throws(() => register_error_policy({'auth.not_logged': {action: 'silent'}}))
				window.SHOW_DEBUG = false
				assert.equal(register_error_policy({'auth.not_logged': {action: 'silent'}}), 0)
				assert.equal(register_error_policy({'*': {action: 'silent'}}), 0)
			} finally {
				window.SHOW_DEBUG = original_debug
			}
			assert.equal(resolve_error_policy('auth.not_logged').action, 'relogin')
			assert.equal(resolve_error_policy('whatever.else').action, 'toast')

			// an unknown action is refused too
			window.SHOW_DEBUG = false
			assert.equal(register_error_policy({'x.y': {action: 'explode'}}), 0)
			window.SHOW_DEBUG = original_debug
		} finally {
			unregister_error_policy(keys.concat(['x.y']))
		}
		assert.equal(resolve_error_policy('site_builder.other').matched, '*', 'unregistered again')
	})
})



describe('ERROR_DISPATCH — handle_api_error', function() {

	// capture 'notification' events published while fn runs
	const with_notifications = async (fn) => {
		const seen	= []
		const token	= event_manager.subscribe('notification', (payload) => seen.push(payload))
		try {
			await fn(seen)
		} finally {
			event_manager.unsubscribe(token)
		}
		return seen
	}

	// SHOW_DEBUG appends ` [code · request_id]` to every rendered text; the dev
	// server ships it true, so it is pinned false here and restored after each test
	let original_debug
	beforeEach(function() {
		reset_error_dispatch_state()
		page_globals.page_error	= null
		original_debug			= window.SHOW_DEBUG
		window.SHOW_DEBUG		= false
	})
	afterEach(function() {
		window.SHOW_DEBUG = original_debug
	})

	it('refuses a non-ApiError (silent, not recovered)', async function() {
		assert.deepEqual(await handle_api_error({code: 'x'}), {recovered: false, action: 'silent'})
	})

	it('toast: publishes ONE notification and dedupes the identical toast within 3s', async function() {
		const seen = await with_notifications(async () => {
			const api_error = new ApiError({code: 'internal.unexpected', message: 'Something broke', request_id: 'rq'})
			assert.deepEqual(await handle_api_error(api_error), {recovered: false, action: 'toast'})
			await handle_api_error(api_error)
			await handle_api_error(new ApiError({code: 'internal.unexpected', message: 'Something broke'}))
		})
		assert.equal(seen.length, 1)
		assert.equal(seen[0].msg, 'Something broke')
		assert.equal(seen[0].type, 'error')
		assert.equal(seen[0].api_error.code, 'internal.unexpected')
	})

	it('toast severity from the policy row: client.network is a warning', async function() {
		const seen = await with_notifications(async () => {
			await handle_api_error(new ApiError({code: CLIENT_ERROR.NETWORK}))
		})
		assert.equal(seen.length, 1)
		assert.equal(seen[0].type, 'warning')
	})

	it('toast severity info paints as information (success), never as an error', async function() {
		register_error_policy({'zz_test.info_notice': {action: 'toast', severity: 'info'}})
		let seen
		try {
			seen = await with_notifications(async () => {
				await handle_api_notice({code: 'zz_test.info_notice', label_key: 'zz_test_info_notice', retryable: false})
			})
		} finally {
			unregister_error_policy(['zz_test.info_notice'])
		}
		assert.equal(seen.length, 1)
		assert.equal(seen[0].type, 'success')
	})

	it('silent: client.aborted and lock.update_state show nothing', async function() {
		const seen = await with_notifications(async () => {
			assert.equal((await handle_api_error(new ApiError({code: CLIENT_ERROR.ABORTED}))).action, 'silent')
			assert.equal((await handle_api_error(new ApiError({code: 'lock.update_state'}))).action, 'silent')
		})
		assert.equal(seen.length, 0)
	})

	it('ctx.silent forces silence for any code', async function() {
		const seen = await with_notifications(async () => {
			assert.equal((await handle_api_error(new ApiError({code: 'internal.unexpected'}), {silent: true})).action, 'silent')
		})
		assert.equal(seen.length, 0)
	})

	it('no_access_page, PAGE scope: sets page_globals.page_error — THE single page-level slot', async function() {
		const api_error = new ApiError({code: 'perm.denied', message: 'Insufficient permissions', request_id: 'rq-p'})
		const outcome = await handle_api_error(api_error, {page_scope: true})
		assert.deepEqual(outcome, {recovered: false, action: 'no_access_page'})
		assert.strictEqual(page_globals.page_error, api_error)
		assert.isUndefined(page_globals.api_errors, 'the legacy array is gone (P4)')
	})

	it('no_access_page, EMBEDDED scope: never sets page_globals.page_error', async function() {
		// an embedded build (page_scope:false): its caller renders the failure — no slot, no toast
		const seen = await with_notifications(async () => {
			const outcome = await handle_api_error(new ApiError({code: 'perm.denied'}), {page_scope: false})
			assert.deepEqual(outcome, {recovered: false, action: 'no_access_page'})
		})
		assert.isNull(page_globals.page_error, 'an embedded refusal is panel-scoped')
		assert.equal(seen.length, 0, 'the caller owns the surface')
		// unspecified scope, no wrapper: still not the page's — but never silent (a toast)
		const seen_unscoped = await with_notifications(async () => {
			await handle_api_error(new ApiError({code: 'perm.denied', message: 'Insufficient permissions'}))
		})
		assert.isNull(page_globals.page_error)
		assert.equal(seen_unscoped.length, 1)
	})

	it('no_access_page / page_panel render the panel into ctx.wrapper when given (text only)', async function() {
		const wrapper = document.createElement('div')
		await handle_api_error(new ApiError({code: 'request.invalid_tipo', message: 'Invalid tipo <b>x</b>'}), {wrapper})
		const panel = wrapper.querySelector('.page_error_container')
		assert.ok(panel)
		assert.equal(panel.dataset.code, 'request.invalid_tipo')
		assert.equal(panel.querySelector('h1').textContent, 'Invalid tipo <b>x</b>')
		assert.isNull(panel.querySelector('b'))
		assert.isNull(page_globals.page_error, 'a wrapper-local panel is not the page slot')
	})

	it('inline: renders into ctx.wrapper via ui.show_message; falls back to a toast without a wrapper', async function() {
		const wrapper = document.createElement('div')
		document.body.appendChild(wrapper)
		try {
			const outcome = await handle_api_error(new ApiError({code: 'validation.date_format', message: 'Bad date'}), {wrapper})
			assert.equal(outcome.action, 'inline')
			assert.equal(wrapper.querySelector('.component_message .text').textContent, 'Bad date')
		} finally {
			wrapper.remove()
		}
		const seen = await with_notifications(async () => {
			await handle_api_error(new ApiError({code: 'validation.other', message: 'No wrapper'}))
		})
		assert.equal(seen.length, 1)
	})

	it('relogin: never a SECOND login — resolves recovered:false without opening when the page is not logged in', async function() {
		const original = page_globals.is_logged
		try {
			page_globals.is_logged = false
			assert.deepEqual(await handle_api_error(new ApiError({code: 'auth.not_logged'})), {recovered: false, action: 'relogin'})
			assert.isNull(document.querySelector('.login .overlay'), 'no overlay was appended')
		} finally {
			page_globals.is_logged = original
		}
	})

	it('csrf_retry is a no-op here (data_manager already resent once)', async function() {
		assert.deepEqual(await handle_api_error(new ApiError({code: 'auth.csrf_failed'})), {recovered: false, action: 'csrf_retry'})
	})
})



describe('API_NOTICES — a SUCCESS envelope\'s coded facts', function() {

	// WHY. A notice is NOT a failure: the request succeeded and something the
	// caller should know did not go the obvious way (a child refused a delete,
	// an external source is degraded). The rules that must hold, or a notice
	// becomes either invisible or a fake error:
	//   - it resolves through the SAME policy table (one table, not two);
	//   - it can never take the page away — a page-level action degrades to a
	//     toast, because the request the user made actually worked;
	//   - its severity is 'warning', never 'error' (no red for a success);
	//   - `label_key` + `details` resolve exactly as a failure's do.

	const with_notifications = async (fn) => {
		const seen	= []
		const token	= event_manager.subscribe('notification', (payload) => seen.push(payload))
		try {
			await fn(seen)
		} finally {
			event_manager.unsubscribe(token)
		}
		return seen
	}

	let original_debug
	beforeEach(function() {
		reset_error_dispatch_state()
		original_debug		= window.SHOW_DEBUG
		window.SHOW_DEBUG	= false
	})
	afterEach(function() {
		window.SHOW_DEBUG = original_debug
	})

	it('builds an ApiError-shaped carrier: code, label_key, details, severity warning', function() {
		const api_error = api_error_from_notice({
			code		: 'record.delete_children_refused',
			label_key	: 'error_record_delete_children_refused',
			retryable	: false,
			details		: {not_deleted: '12,13'}
		}, {request_id: 'rq-1'})
		assert.equal(api_error.code, 'record.delete_children_refused')
		assert.equal(api_error.label_key, 'error_record_delete_children_refused')
		assert.equal(api_error.details.not_deleted, '12,13')
		assert.equal(api_error.severity, 'warning')
		assert.equal(api_error.request_id, 'rq-1')
		assert.isFalse(api_error.transport)
	})

	it('rejects a shapeless notice instead of rendering nothing silently', async function() {
		assert.isNull(api_error_from_notice({}))
		assert.deepEqual(await handle_api_notice(null), {recovered: false, action: 'silent'})
	})

	it('the delete notice renders INLINE in the caller\'s wrapper', async function() {
		const wrapper = document.createElement('div')
		document.body.appendChild(wrapper)
		try {
			const outcome = await handle_api_notice({
				code	: 'record.delete_children_refused',
				details	: {not_deleted: '12,13'}
			}, {wrapper})
			assert.equal(outcome.action, 'inline')
			assert.isNotNull(wrapper.querySelector('.component_message'))
		} finally {
			wrapper.remove()
		}
	})

	it('the same notice degrades to a WARNING toast when no wrapper is given', async function() {
		const seen = await with_notifications(async () => {
			const outcome = await handle_api_notice({code: 'record.delete_children_refused', details: {not_deleted: '9'}})
			assert.equal(outcome.action, 'toast')
		})
		assert.equal(seen.length, 1)
		assert.equal(seen[0].type, 'warning')
	})

	it('a page-level policy row can never fire for a notice: the request SUCCEEDED', async function() {
		// `perm.*` resolves to no_access_page for a FAILURE; as a notice it may
		// only speak, never replace the page.
		const seen = await with_notifications(async () => {
			const outcome = await handle_api_notice({code: 'perm.something'})
			assert.equal(outcome.action, 'toast')
		})
		assert.equal(seen.length, 1)
		assert.equal(seen[0].type, 'warning')
	})

	it('ctx.silent suppresses it entirely', async function() {
		const seen = await with_notifications(async () => {
			const outcome = await handle_api_notice({code: 'record.delete_children_refused'}, {silent: true})
			assert.equal(outcome.action, 'silent')
		})
		assert.equal(seen.length, 0)
	})

	it('handle_api_notices dispatches every notice of one envelope', async function() {
		const outcomes = await handle_api_notices({
			notices		: [{code: 'external.unavailable'}, {code: 'external.disabled'}],
			api_response: {request_id: 'rq-2'}
		})
		assert.equal(outcomes.length, 2)
	})

	it('a registered domain can silence its own notices (the widget renders them itself)', async function() {
		register_error_policy({'test_notice.*': {action: 'silent'}})
		try {
			const seen = await with_notifications(async () => {
				const outcome = await handle_api_notice({code: 'test_notice.degraded'})
				assert.equal(outcome.action, 'silent')
			})
			assert.equal(seen.length, 0)
		} finally {
			unregister_error_policy(['test_notice.*'])
		}
	})
})



/**
* OUTCOME_UNKNOWN — does a failed request leave the server's outcome unknown?
* The question an action button must answer before it re-arms (a re-click mints
* a NEW idempotency key, so the server executes it again). Every transport
* failure is unknown — an attempt may have landed, and the engine runs an
* aborted request to completion — and so are the server's own "I do not know
* whether (or what) it ran" codes. A server refusal is KNOWN: it answered, and said no.
*/
describe('ERROR_DISPATCH — outcome_unknown', function() {

	it('every transport failure is an unknown outcome', function() {
		for (const code of Object.values(CLIENT_ERROR)) {
			assert.isTrue(outcome_unknown(new ApiError({code, source:'transport'})), code)
		}
		// a proxy's non-envelope answer (status known, body not ours)
		assert.isTrue(outcome_unknown(new ApiError({code:CLIENT_ERROR.HTTP_STATUS, status:504, source:'transport'})))
	})

	it("the server's idempotency in_progress / outcome_unknown / replay_unavailable are unknown; a refusal is known", function() {
		for (const code of ['idempotency.in_progress', 'idempotency.outcome_unknown', 'idempotency.replay_unavailable']) {
			assert.isTrue(outcome_unknown(new ApiError({code, source:'envelope', transport:false})), code)
		}
		for (const code of ['request.invalid_options', 'auth.not_logged', 'perm.denied', 'idempotency.key_reused', 'server.unspecified']) {
			assert.isFalse(outcome_unknown(new ApiError({code, source:'envelope', transport:false})), code)
		}
	})

	it('a value that is not an ApiError cannot vouch for a known outcome', function() {
		assert.isTrue(outcome_unknown(null))
		assert.isTrue(outcome_unknown({code:'request.invalid_options'}))
	})
})



// @license-end
