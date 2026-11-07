// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/
'use strict';

/**
* TEST_RENDER_API_ERROR
* The one renderer (core/common/js/render_api_error.js): text resolution and
* the four surfaces.
*
* WHY THESE ASSERTIONS. (1) The user reads the LABEL, not the server's English:
* `error_text` is asserted label → `${param}` / `%s` filled → message → code, in
* that order, with the label planted on `get_label` and removed again. (2) XSS:
* an `error.message` is server text and a `details` value can be typed by a
* user, so every surface is asserted to render `<img src=x onerror=…>` as TEXT —
* the DOM contains no <img> and the exact string is the textContent. (3) The
* panel always shows the request_id line: it is the only join key with the
* server log. (4) The debug suffix appears ONLY under SHOW_DEBUG.
*/

import {
	error_text,
	register_tool_error_labels,
	error_debug_suffix,
	render_error_toast,
	render_error_inline,
	render_error_panel,
	render_error_modal
} from '../../../core/common/js/render_api_error.js'
import {ApiError, CLIENT_ERROR} from '../../../core/common/js/api_error.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {render_stream} from '../../../core/common/js/render_common.js'



const XSS = '<img src=x onerror="window.__xss_fired=true">'

// with_label — plant a label on the page global for the duration of fn
	const with_label = async (key, value, fn) => {
		const had = Object.prototype.hasOwnProperty.call(get_label, key)
		const old = get_label[key]
		get_label[key] = value
		try {
			await fn()
		} finally {
			if (had) get_label[key] = old
			else delete get_label[key]
		}
	}

// with_debug — flip SHOW_DEBUG for the duration of fn
	const with_debug = async (value, fn) => {
		const old = window.SHOW_DEBUG
		window.SHOW_DEBUG = value
		try {
			await fn()
		} finally {
			window.SHOW_DEBUG = old
		}
	}



describe('RENDER_API_ERROR — error_text', function() {

	it('label wins: get_label[label_key] with ${param} and %s filled from details', async function() {
		await with_label('error_test_client_gate', 'Record ${section_id} of ${section_tipo} is locked', async () => {
			const text = error_text(new ApiError({code: 'record.in_use', label_key: 'error_test_client_gate', message: 'English', details: {section_id: 12, section_tipo: 'oh1'}}))
			assert.equal(text, 'Record 12 of oh1 is locked')
		})
		await with_label('error_test_client_gate', 'Field %s: %s', async () => {
			const text = error_text(new ApiError({code: 'validation.x', label_key: 'error_test_client_gate', details: {field: 'date', reason: 'not a date'}}))
			assert.equal(text, 'Field date: not a date')
		})
		await with_label('error_test_client_gate', 'Missing ${nope}', async () => {
			assert.equal(error_text(new ApiError({code: 'x.y', label_key: 'error_test_client_gate', details: {}})), 'Missing ${nope}', 'unknown placeholders stay visible')
		})
	})

	it('falls back to the English message, then to the code / client fallback', async function() {
		assert.equal(error_text(new ApiError({code: 'perm.denied', label_key: 'no_such_label_in_catalog_xyz', message: 'Insufficient permissions'})), 'Insufficient permissions')
		assert.equal(error_text(new ApiError({code: 'some.code', message: ''})), 'some.code')
		// the catalog normally HAS error_client_network; blank it to reach the built-in English
		await with_label('error_client_network', '', async () => {
			assert.equal(error_text(new ApiError({code: CLIENT_ERROR.NETWORK})), 'Network connection failed')
		})
		assert.equal(error_text(null), '')
		assert.equal(error_text('plain'), 'plain')
	})

	it('client codes resolve their error_client_* label when the catalog has it', async function() {
		await with_label('error_client_timeout', 'Tiempo agotado', async () => {
			assert.equal(error_text(new ApiError({code: CLIENT_ERROR.TIMEOUT})), 'Tiempo agotado')
		})
	})

	it('debug suffix [code · request_id] only under SHOW_DEBUG', async function() {
		const api_error = new ApiError({code: 'perm.denied', request_id: 'rq-42'})
		await with_debug(false, async () => assert.equal(error_debug_suffix(api_error), ''))
		await with_debug(true, async () => {
			assert.equal(error_debug_suffix(api_error), ' [perm.denied · rq-42]')
			assert.equal(error_debug_suffix(new ApiError({code: 'perm.denied'})), ' [perm.denied]')
		})
	})
})



describe('RENDER_API_ERROR — error_text for a tool refusal (details.reason_key)', function() {

	// A scratch tool name no real tool can take; its labels are forgotten again in
	// `finally` so no test leaks a registration into the next.
	const TOOL = 'tool_zz_reason_probe'
	const with_tool_labels = async (labels, fn) => {
		register_tool_error_labels(TOOL, labels)
		try {
			await fn()
		} finally {
			register_tool_error_labels(TOOL, null)
		}
	}
	const refusal = (fields = {}) => new ApiError({
		code		: 'request.invalid_options',
		label_key	: 'error_request_invalid_options',
		message		: 'The bbox is not numeric',
		details		: {reason_key: 'bad_bbox'},
		tool		: TOOL,
		...fields
	})

	it('the tool label reason_<key> wins over the core label and the wire message', async function() {
		await with_label('error_request_invalid_options', 'Core generic label', async () => {
			await with_tool_labels([{name: 'reason_bad_bbox', value: 'El recuadro no es numérico'}], async () => {
				assert.equal(error_text(refusal()), 'El recuadro no es numérico')
			})
		})
	})

	it('${param} in the tool label is filled from the declared details', async function() {
		await with_tool_labels([{name: 'reason_down', value: 'Cannot reach ${site}'}], async () => {
			const api_error = refusal({code: 'tool.source_unavailable', details: {reason_key: 'down', site: 'https://tiles.example.org'}})
			assert.equal(error_text(api_error), 'Cannot reach https://tiles.example.org')
		})
	})

	it('no label for the key (or none registered) → the wire message, i.e. the sentence the tool declared for the key — not the core label', async function() {
		await with_label('error_request_invalid_options', 'Core generic label', async () => {
			assert.equal(error_text(refusal()), 'The bbox is not numeric', 'tool without registered labels')
			await with_tool_labels([{name: 'reason_other', value: 'Other'}], async () => {
				assert.equal(error_text(refusal()), 'The bbox is not numeric', 'a label for a different key')
			})
			await with_tool_labels([], async () => {
				assert.equal(error_text(refusal()), 'The bbox is not numeric', 'the empty array the server serves for an untranslated language')
			})
		})
	})

	it('only reason_* entries are kept; a UI label of the same name as the key is not a refusal sentence', async function() {
		await with_tool_labels([{name: 'bad_bbox', value: 'A UI label'}], async () => {
			assert.equal(error_text(refusal()), 'The bbox is not numeric')
		})
	})

	it('a reason_key without a known tool, or a tool refusal without reason_key, takes the unchanged core chain', async function() {
		await with_label('error_request_invalid_options', 'Core generic label', async () => {
			await with_tool_labels([{name: 'reason_bad_bbox', value: 'Tool sentence'}], async () => {
				assert.equal(error_text(refusal({tool: null})), 'Core generic label', 'no tool → core label first, as before')
				assert.equal(error_text(refusal({tool: 'tool_zz_other'})), 'The bbox is not numeric', 'another tool: its labels are not this one\'s')
				assert.equal(error_text(refusal({details: {}})), 'Core generic label', 'no reason_key → the core chain')
			})
		})
	})

	it('a non-string / empty reason_key is ignored (no label name is built from it)', async function() {
		await with_tool_labels([{name: 'reason_', value: 'Empty key'}, {name: 'reason_1', value: 'Numeric'}], async () => {
			await with_label('error_request_invalid_options', 'Core generic label', async () => {
				assert.equal(error_text(refusal({details: {reason_key: ''}})), 'Core generic label')
				assert.equal(error_text(refusal({details: {reason_key: 1}})), 'Core generic label')
			})
		})
	})

	it('register_tool_error_labels: replaces, forgets on a non-array, rejects a nameless tool', function() {
		assert.isFalse(register_tool_error_labels('', []))
		assert.isFalse(register_tool_error_labels(null, []))
		assert.isTrue(register_tool_error_labels(TOOL, [{name: 'reason_a', value: 'A'}]))
		assert.equal(error_text(refusal({details: {reason_key: 'a'}})), 'A')
		assert.isTrue(register_tool_error_labels(TOOL, [{name: 'reason_b', value: 'B'}]))
		assert.equal(error_text(refusal({details: {reason_key: 'a'}})), 'The bbox is not numeric', 'a re-registration replaces')
		assert.isFalse(register_tool_error_labels(TOOL, null))
		assert.equal(error_text(refusal({details: {reason_key: 'b'}})), 'The bbox is not numeric', 'null forgets the tool')
	})

	it('a label with a ${param} the error does not carry, or a %s, is not shown as written: the wire message stands in', async function() {
		for (const value of ['At most ${max} items', 'Bad value %s', 'Cannot reach ${site} (${port})']) {
			await with_tool_labels([{name: 'reason_down', value}], async () => {
				const api_error = refusal({code: 'tool.source_unavailable', message: 'Fallback sentence', details: {reason_key: 'down', site: 'tiles.example.org'}})
				assert.equal(error_text(api_error), 'Fallback sentence', value)
			})
		}
		// …and with no wire message either (a plain object: ApiError defaults its message to the code), the core chain takes over — never the raw placeholder
		await with_label('error_request_invalid_options', 'Core generic label', async () => {
			await with_tool_labels([{name: 'reason_bad_bbox', value: 'At most ${max} items'}], async () => {
				const plain = {code: 'request.invalid_options', label_key: 'error_request_invalid_options', details: {reason_key: 'bad_bbox'}, tool: TOOL}
				assert.equal(error_text(plain), 'Core generic label')
			})
		})
		// control: every placeholder filled → the label as written
		await with_tool_labels([{name: 'reason_down', value: 'Cannot reach ${site}'}], async () => {
			const api_error = refusal({code: 'tool.source_unavailable', details: {reason_key: 'down', site: 'tiles.example.org'}})
			assert.equal(error_text(api_error), 'Cannot reach tiles.example.org')
		})
	})

	it('a refusal that arrives as a job frame reads in the tool\'s words once the frame site names the tool (render_stream {tool})', async function() {
		const frame = {
			is_running	: false,
			total_time	: '1 ms',
			error		: {code: 'request.invalid_options', message: 'The bbox is not numeric', label_key: 'error_request_invalid_options', details: {reason_key: 'bad_bbox'}}
		}
		const panel_text = (options) => {
			const container = document.createElement('div')
			const stream = render_stream({container, id: 'test_render_api_error_stream', display_json: false, ...options})
			stream.update_info_node(frame)
			return container.textContent
		}
		await with_label('error_request_invalid_options', 'Core generic label', async () => {
			await with_tool_labels([{name: 'reason_bad_bbox', value: 'El recuadro no es numérico'}], async () => {
				assert.include(panel_text({tool: TOOL}), 'El recuadro no es numérico', 'the tool named → its sentence')
				assert.notInclude(panel_text({tool: TOOL}), 'Core generic label')
				assert.include(panel_text({}), 'Core generic label', 'no tool named → the core label, as before')
				assert.include(panel_text({tool: 'tool_zz_other'}), 'The bbox is not numeric', 'another tool: its labels are not this one\'s → the wire message')
			})
		})
	})

	it('the tool sentence reaches the DOM as TEXT, never HTML', async function() {
		await with_tool_labels([{name: 'reason_bad_bbox', value: XSS}], async () => {
			const heading = render_error_panel(refusal()).querySelector('h1.server_response_error')
			assert.isNull(heading.querySelector('img'), 'no element was parsed out of the label')
			assert.equal(heading.textContent, XSS)
		})
	})
})



describe('RENDER_API_ERROR — surfaces render text, never HTML', function() {

	// SHOW_DEBUG appends ` [code · request_id]`; the dev server ships it true, so
	// it is pinned false for the exact-text assertions and restored after each test
	let original_debug
	beforeEach(function() {
		original_debug		= window.SHOW_DEBUG
		window.SHOW_DEBUG	= false
	})
	afterEach(function() {
		window.SHOW_DEBUG = original_debug
		delete window.__xss_fired
	})

	it('render_error_toast publishes the notification event with the text (and the ApiError)', async function() {
		const seen	= []
		const token	= event_manager.subscribe('notification', (payload) => seen.push(payload))
		try {
			const payload = render_error_toast(new ApiError({code: 'x.y', message: XSS}), {remove_time: 5})
			assert.equal(seen.length, 1)
			assert.strictEqual(seen[0], payload)
			assert.equal(payload.msg, XSS)
			assert.equal(payload.type, 'error')
			assert.equal(payload.remove_time, 5)
			assert.equal(payload.api_error.code, 'x.y')
			// what page.js does with it: render_node_info is text-only — assert the
			// bubble it builds carries the string as text
			const {render_node_info} = await import('../../../core/common/js/utils/notifications.js')
			const bubble = render_node_info(payload)
			assert.isNull(bubble.querySelector('img'))
			assert.include(bubble.textContent, XSS)
		} finally {
			event_manager.unsubscribe(token)
		}
	})

	it('render_error_inline renders the message as text inside the wrapper', function() {
		const wrapper = document.createElement('div')
		document.body.appendChild(wrapper)
		try {
			render_error_inline(wrapper, new ApiError({code: 'validation.x', message: XSS}))
			const text_node = wrapper.querySelector('.component_message .text')
			assert.ok(text_node)
			assert.equal(text_node.textContent, XSS)
			assert.isNull(wrapper.querySelector('img'))
			assert.notOk(window.__xss_fired)
		} finally {
			wrapper.remove()
		}
		assert.isNull(render_error_inline(null, new ApiError({code: 'x'})))
	})

	it('render_error_panel: text-only message, ALWAYS a request_id line, reload for auth.*, home otherwise', function() {
		const panel = render_error_panel(new ApiError({code: 'perm.denied', message: XSS, request_id: 'rq-77'}))
		assert.isTrue(panel.classList.contains('page_error_container'))
		assert.equal(panel.dataset.code, 'perm.denied')
		assert.equal(panel.querySelector('h1').textContent, XSS)
		// the logo is the only <img>, and it is ours
		const imgs = panel.querySelectorAll('img')
		assert.equal(imgs.length, 1)
		assert.isTrue(imgs[0].classList.contains('icon_dedalo'))
		assert.equal(panel.querySelector('.request_id').textContent, 'request_id: rq-77')
		assert.ok(panel.querySelector('a.link.home'))
		assert.isNull(panel.querySelector('a.link.reload'))
		assert.isTrue(panel.classList.contains('no_access_error'))

		const auth = render_error_panel(new ApiError({code: 'auth.not_logged'}))
		assert.ok(auth.querySelector('a.link.reload'))
		assert.isNull(auth.querySelector('a.link.home'))
		assert.equal(auth.querySelector('.request_id').textContent, 'request_id: -', 'no server answer → still a line')

		const bare = render_error_panel(new ApiError({code: 'not_logged'}))
		assert.isNull(bare.querySelector('a.link.reload'), 'the bare v1 token is not a code any more (compat removed 2026-08-16)')
	})

	it('render_error_modal: text-only body with the request_id, closes cleanly', function() {
		const modal = render_error_modal(new ApiError({code: 'record.in_use', message: XSS, request_id: 'rq-m'}))
		try {
			const body = modal.querySelector('.api_error_modal') || document.querySelector('.api_error_modal')
			assert.ok(body, 'modal body rendered')
			assert.equal(body.querySelector('.text').textContent, XSS)
			assert.isNull(body.querySelector('img'))
			assert.include(body.querySelector('.request_id').textContent, 'rq-m')
			assert.notOk(window.__xss_fired)
		} finally {
			modal.remove()
		}
	})

	it('a details value with markup is rendered as text too (label path)', async function() {
		await with_label('error_test_client_gate', 'Value ${value} refused', async () => {
			const panel = render_error_panel(new ApiError({code: 'validation.x', label_key: 'error_test_client_gate', details: {value: XSS}}))
			assert.equal(panel.querySelector('h1').textContent, `Value ${XSS} refused`)
			assert.equal(panel.querySelectorAll('img').length, 1, 'only the logo')
		})
	})
})



// @license-end
