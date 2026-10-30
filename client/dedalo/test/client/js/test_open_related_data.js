// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';



import {data_manager} from '../../../core/common/js/data_manager.js'
import {is_filter_empty} from '../../../core/search/js/search_utils.js'
import {
	build_relation_source,
	build_scoped_sqo,
	RELATION_TARGETS_TIMEOUT_MS,
	render_open_list_with_direct_relations
} from '../../../core/section/js/render_open_list_with_direct_relations.js'



/**
* TEST_OPEN_RELATED_DATA
* "Open relationships" — the inspector button and the portal's "list from
* component data" button (WC-2026-10-30-search-referenced-by-leaf).
*
* THE FLOW PINNED HERE. The dialog builds ONE referenced_by SOURCE per scope
*   current → a one-locator pin on the open record (never limit/offset)
*   found   → the caller's found set: the user's filter + result pins, the auto
*             pin dropped, no limit/offset/order (a source is a set)
* and uses it twice, verbatim: `dd_core_api.relation_targets` (options.source)
* answers the target sections with their counts, re-asked on every scope flip;
* each opened window's filter is `{ $and:[{ referenced_by: source }] }`. No
* read_raw, no id list: the server compiles the leaf to one semi-join.
*
* SCOPING HISTORY (the build_scoped_sqo cases). The caller's view SQO is not
* what either scope means: in edit mode it carries an auto single-record pin
* and/or the record's position in the found set (limit:1 / offset:N). Sent
* verbatim the pin + offset skipped the only matching row. Both scopes derive
* their SQO on a clone (the portal caller hands over its parent section's live
* object).
*
* No backend: data_manager.request is a method on a shared singleton, so it is
* patched in place to capture the outgoing RQO and answer with a canned result;
* window.open is patched to observe what the dialog ends up opening.
*/



// The record every fixture below has open: the 2nd of the found set.
	const OPEN_RECORD = { section_tipo:'test3', section_id:2 }

// A fake caller SECTION instance — the identity build_scoped_sqo needs to tell
// the auto single-record pin apart from a real (semantic) result set, and the
// 'current' scope's source pin. No get_total: the async found-total patch is
// skipped.
	const make_caller_section = () => ({
		model			: 'section',
		tipo			: OPEN_RECORD.section_tipo,
		section_tipo	: OPEN_RECORD.section_tipo,
		section_id		: OPEN_RECORD.section_id
	})

// make_pinned_sqo — the shape a section carries when it was loaded KNOWING its
// section_id (direct url, restored edit pagination): build_rqo_show adds the
// auto pin, and the found-set offset is left over beside it.
	const make_pinned_sqo = () => ({
		section_tipo		: ['test3'],
		limit				: 1,
		offset				: 1,
		filter_by_locators	: [{ ...OPEN_RECORD }],
		filter				: { '$and' : [{ q:['x'], path:[{section_tipo:'test3', component_tipo:'test52'}] }] },
		parsed				: false
	})

// make_navigated_sqo — THE MAINSTREAM SHAPE. Clicking a row's edit pen clones
// the list sqo and sets limit:1 / offset:<row position>, deliberately WITHOUT a
// section_id on the source (render_list_section.js), so no pin is ever
// generated: here the OFFSET is what selects the record.
	const make_navigated_sqo = () => ({
		section_tipo		: ['test3'],
		limit				: 1,
		offset				: 1,
		filter_by_locators	: [],
		filter				: { '$and' : [{ q:['x'], path:[{section_tipo:'test3', component_tipo:'test52'}] }] },
		parsed				: false
	})

// make_semantic_sqo — a semantic/RAG search resolves its ranked hits INTO
// filter_by_locators (search/js/search.js exec_search). Those pins are the user's
// result set, not an auto pin, and must never be discarded.
	const make_semantic_sqo = () => ({
		section_tipo		: ['test3'],
		limit				: 1,
		offset				: 1,
		filter_by_locators	: [
			{ section_tipo:'test3', section_id:7 },
			{ section_tipo:'test3', section_id:2 },
			{ section_tipo:'test3', section_id:9 }
		],
		order				: [{ mode:'locator_position' }],
		parsed				: false
	})

// make_dialog_options — the inspector's caller shape (section mode).
	const make_dialog_options = (sqo) => ({
		sqo			: sqo,
		label		: 'Fake caller',
		total		: 1,
		self_caller	: make_caller_section()
	})

// make_portal_options — the portal caller's shape: from_component_tipo set.
	const make_portal_options = (sqo) => ({
		sqo					: sqo,
		from_component_tipo	: 'test80',
		label				: 'Fake portal',
		total				: 1,
		self_caller			: make_caller_section()
	})

// canned relation_targets answers
	const TWO_TARGETS = [
		{ tipo:'test4', label:'Fake target A', total:3 },
		{ tipo:'test5', label:'Fake target B', total:1234 }
	]
	const ok_targets = (targets) => ({ ok : true, data : targets })

// tick — let the dialog's async relation_targets round settle
	const tick = (ms=60) => new Promise(resolve => setTimeout(resolve, ms))

// with_stubbed_request — patch the shared data_manager, run fn, always restore.
// relation_targets is answered by `answer(body, signal)` (an envelope, or a
// promise of one); every other action (the 'read' the dummy section issues while
// open_filtered_window pins its session filter) gets an inert one. Each
// relation_targets request's options.signal is recorded, in order, in the
// `signals` array handed to fn as its second argument, and its options.timeout
// (what the transport is told to wait) in the `timeouts` array, the third.
	const with_stubbed_request = async (answer, fn) => {
		const original	= data_manager.request
		const captured	= []
		const signals	= []
		const timeouts	= []
		data_manager.request = async (options) => {
			const body = options?.body
			captured.push(body)
			if (body?.action==='relation_targets') {
				signals.push(options?.signal ?? null)
				timeouts.push(options?.timeout)
				return answer(body, options?.signal ?? null)
			}
			return { ok : true, data : { context:[], data:[] } }
		}
		try {
			await fn(captured, signals, timeouts)
		} finally {
			data_manager.request = original
		}
		return captured
	}

// with_stubbed_open — everything open_filtered_window does bottoms out in
// window.open.
	const with_stubbed_open = async (fn) => {
		const original	= window.open
		const urls		= []
		window.open = (url) => {
			urls.push(url)
			return { focus(){}, resizeTo(){}, moveTo(){} }
		}
		try {
			await fn(urls)
		} finally {
			window.open = original
		}
		return urls
	}

// with_stubbed_dialogs — alert/confirm must never block the run; recorded.
	const with_stubbed_dialogs = async (fn) => {
		const original_alert	= window.alert
		const original_confirm	= window.confirm
		const messages			= []
		window.alert	= (msg) => { messages.push(msg) }
		window.confirm	= (msg) => { messages.push(msg); return true }
		try {
			await fn(messages)
		} finally {
			window.alert	= original_alert
			window.confirm	= original_confirm
		}
		return messages
	}

// helpers over the captured bodies
	const targets_requests	= (captured) => captured.filter(el => el?.action==='relation_targets')
	const leaf_of			= (body) => body?.sqo?.filter?.$and?.[0]?.referenced_by
	const window_tipos		= (urls) => urls.map(url => url.split('tipo=')[1].split('&')[0]).sort()

// open_modal — render the dialog and wait for its first answer
	const open_modal = async (options) => {
		render_open_list_with_direct_relations(options)
		await tick()
		return document.querySelector('.open_relations_modal')
	}

// flip_scope / pick_target / press_open
	const flip_scope = (modal, scope) => {
		const radio = modal.querySelector(`input[name=data_selection][value=${scope}]`)
		radio.checked = true
		radio.dispatchEvent(new Event('change', {bubbles:true}))
	}
	const pick_target = (modal, tipo) => {
		const radio = modal.querySelector(`input[name=target_section][value=${tipo}]`)
		radio.checked = true
		radio.dispatchEvent(new Event('change', {bubbles:true}))
	}
	const press_open = (modal) => {
		modal.querySelector('button.success').dispatchEvent(new MouseEvent('mouseup', {bubbles:true}))
	}

// cleanup_modals — the dialog closes itself, but a failed assertion can leave
// one behind; a stale node would be picked up by the NEXT test's querySelector
// and turn one failure into a cascade. Always call it from a finally.
	const cleanup_modals = () => {
		for (const el of document.querySelectorAll('.open_relations_modal')) {
			el.remove()
		}
	}



describe(`OPEN_RELATED_DATA`, async () => {

	// THE PINNED CASE. A leftover found-set offset beside a one-record pin skips
	// the only matching row, so read_raw answers with nothing.
	it(`scope 'current' drops a stale offset when the pin already names the record`, async function() {

		const sqo		= make_pinned_sqo()
		const scoped	= build_scoped_sqo(sqo, 'current', make_caller_section())

		assert.strictEqual(scoped.offset, 0,
			'the found-set offset would skip the single pinned row')
		assert.strictEqual(scoped.limit, 1)
		assert.deepEqual(scoped.filter_by_locators, sqo.filter_by_locators,
			'the current record pin must survive')
	})

	// THE MAINSTREAM CASE, and the opposite requirement. Navigating from the list
	// produces NO pin — the offset alone names the record. Zeroing it here returns
	// the FIRST found record's relations instead of the open one's, silently.
	it(`scope 'current' PRESERVES the offset when there is no pin to name the record`, async function() {

		const sqo		= make_navigated_sqo()
		const scoped	= build_scoped_sqo(sqo, 'current', make_caller_section())

		assert.strictEqual(scoped.offset, 1,
			'with no pin the offset IS the record selector and must not be reset')
		assert.strictEqual(scoped.limit, 1)
	})

	// A semantic/RAG result set also lives in filter_by_locators, with several
	// entries; the offset then picks the open record out of THAT set.
	it(`scope 'current' preserves the offset inside a multi-pin result set`, async function() {

		const scoped = build_scoped_sqo(make_semantic_sqo(), 'current', make_caller_section())

		assert.strictEqual(scoped.offset, 1)
		assert.strictEqual(scoped.filter_by_locators.length, 3,
			'a semantic result set must not be reduced')
	})

	// 'found' must mean the user's search, not the open record: the AUTO pin is
	// the open record and goes, the real search lives in sqo.filter.
	it(`scope 'found' drops the caller's OWN record pin and is a set, not a page`, async function() {

		const sqo		= make_pinned_sqo()
		const scoped	= build_scoped_sqo(sqo, 'found', make_caller_section())

		assert.deepEqual(scoped.filter_by_locators, [],
			'the auto single-record pin would silently reduce "all found" to "current"')
		// a referenced_by source is a SET: it refuses limit/offset/order, and
		// nothing is fetched row by row any more, so no page ceiling applies
		assert.strictEqual('limit' in scoped, false, '"all found" is a set, not a page')
		assert.strictEqual('offset' in scoped, false)
		assert.strictEqual('order' in scoped, false)
		assert.deepEqual(scoped.filter, sqo.filter,
			'the user\'s own search must decide the found set')
	})

	// THE COUNTERPART. filter_by_locators is also how a semantic search carries
	// its ranked hits. Dropping those would open relations for records the user
	// never searched for — and with the zero-hit sentinel, for the whole section.
	it(`scope 'found' NEVER drops a pin set that is the user's own result`, async function() {

		const scoped = build_scoped_sqo(make_semantic_sqo(), 'found', make_caller_section())

		assert.strictEqual(scoped.filter_by_locators.length, 3,
			'a semantic result set is the found set, not an auto pin')
		assert.strictEqual('limit' in scoped, false)
		assert.strictEqual('order' in scoped, false,
			'the ranked order is irrelevant to a set (and refused by the source schema)')
	})

	// The zero-hit sentinel (section_id:-1) means "honestly empty". It is a
	// one-entry pin set, so only the caller-identity check keeps it.
	it(`scope 'found' keeps the zero-hit semantic sentinel`, async function() {

		const sqo = make_navigated_sqo()
		sqo.filter_by_locators = [{ section_tipo:'test3', section_id:-1 }]

		const scoped = build_scoped_sqo(sqo, 'found', make_caller_section())

		assert.deepEqual(scoped.filter_by_locators, [{ section_tipo:'test3', section_id:-1 }],
			'dropping the sentinel would open the ENTIRE section')
	})

	// Without a caller identity the auto pin cannot be recognised, so the pin
	// must be kept: narrowing is recoverable, widening past what the user can see
	// is not.
	it(`scope 'found' keeps the pin when the caller record is unknown`, async function() {

		const scoped = build_scoped_sqo(make_pinned_sqo(), 'found', null)

		assert.strictEqual(scoped.filter_by_locators.length, 1)
	})

	// The portal caller hands over its parent section's LIVE sqo. Re-paginating
	// it would silently move the user's own list. Asserted deeply: a shallow copy
	// would still let a nested edit through.
	it(`the caller's sqo is never mutated, at any depth`, async function() {

		const sqo		= make_semantic_sqo()
		const snapshot	= JSON.stringify(sqo)
		const pins_ref	= sqo.filter_by_locators

		const a = build_scoped_sqo(sqo, 'current', make_caller_section())
		const b = build_scoped_sqo(sqo, 'found', make_caller_section())

		assert.strictEqual(JSON.stringify(sqo), snapshot)
		assert.notStrictEqual(a.filter_by_locators, pins_ref,
			'the pin array must be a copy, not the caller\'s own')
		assert.notStrictEqual(a.filter_by_locators[0], pins_ref[0],
			'and so must each locator inside it')
		assert.strictEqual(b.filter_by_locators.length, 3)

		// the nested user filter too (the pinned fixture is the one that has one)
		const pinned		= make_pinned_sqo()
		const filter_ref	= pinned.filter
		const scoped		= build_scoped_sqo(pinned, 'found', make_caller_section())
		assert.notStrictEqual(scoped.filter, filter_ref,
			'the filter must be a copy — a shallow spread would share it')
		assert.deepEqual(scoped.filter, filter_ref)
	})

	// ---------------------------------------------------------------------------
	// the source object
	// ---------------------------------------------------------------------------

	// 'current' names the open record BY IDENTITY. The mainstream (navigated)
	// shape has no pin at all — the offset selected the record — and a source
	// refuses limit/offset, so the pin comes from the caller instance.
	it(`build_relation_source 'current' pins the open record, with no page keys`, async function() {

		const source = build_relation_source(make_navigated_sqo(), 'current', OPEN_RECORD)

		assert.deepEqual(source, {
			section_tipo		: ['test3'],
			filter_by_locators	: [{ section_tipo:'test3', section_id:2 }]
		}, 'exactly the open record, nothing else')
	})

	// Without an open record 'current' cannot be expressed: null, never a guess.
	it(`build_relation_source 'current' without an open record is null`, async function() {

		assert.strictEqual(build_relation_source(make_pinned_sqo(), 'current', null), null)
	})

	// 'found' carries the user's filter and drops the auto pin and every page key
	// (the server refuses limit/offset/order on a source, loudly).
	it(`build_relation_source 'found' is the found set: filter kept, auto pin and page keys gone`, async function() {

		const sqo		= make_pinned_sqo()
		const source	= build_relation_source(sqo, 'found', OPEN_RECORD)

		assert.deepEqual(Object.keys(source).sort(), ['filter','section_tipo'],
			'only allowed source keys; an empty pin set is not sent')
		assert.deepEqual(source.filter, sqo.filter)
		assert.notStrictEqual(source.filter, sqo.filter, 'a copy, never the caller\'s live filter')
	})

	// a semantic result set IS the found set and must survive as pins
	it(`build_relation_source 'found' keeps a semantic result set as pins`, async function() {

		const source = build_relation_source(make_semantic_sqo(), 'found', OPEN_RECORD)

		assert.strictEqual(source.filter_by_locators.length, 3)
		assert.strictEqual('order' in source, false)
		assert.strictEqual('filter' in source, false, 'no filter nodes → no filter key')
	})

	// A found set EXPANDED to recursive children (the search panel's 'Children'
	// checkbox) is never narrowed to its matched terms by dropping the flag: it
	// rides the source, and the server refuses it by name (shown in the modal).
	it(`build_relation_source 'found' never drops children_recursive`, async function() {

		const sqo		= { ...make_navigated_sqo(), children_recursive : true }
		const source	= build_relation_source(sqo, 'found', OPEN_RECORD)

		assert.strictEqual(source.children_recursive, true)
		// 'current' names one record: the flag has no meaning there
		const current = build_relation_source(sqo, 'current', OPEN_RECORD)
		assert.strictEqual('children_recursive' in current, false)
		// and a plain found set does not invent it
		const plain = build_relation_source(make_navigated_sqo(), 'found', OPEN_RECORD)
		assert.strictEqual('children_recursive' in plain, false)
	})

	// portal mode narrows to the component's own locators
	it(`build_relation_source carries from_component_tipo in portal mode`, async function() {

		const source = build_relation_source(make_pinned_sqo(), 'current', OPEN_RECORD, 'test80')

		assert.strictEqual(source.from_component_tipo, 'test80')
	})

	// A referenced_by leaf has no q. Read as a group, the old recursion walked the
	// source object and then its strings char by char, forever. It is an ACTIVE
	// leaf: it always narrows the set.
	it(`is_filter_empty treats a referenced_by leaf as an active clause`, async function() {

		const leaf_filter = { '$and' : [{ referenced_by : { section_tipo:['test3'], filter:null } }] }
		assert.strictEqual(is_filter_empty(leaf_filter), false)

		// nested inside an otherwise empty group too
		const nested = { '$and' : [{ q:'', path:[] }, { '$or' : [{ referenced_by : { section_tipo:['test3'] } }] }] }
		assert.strictEqual(is_filter_empty(nested), false)

		// and an empty filter stays empty
		assert.strictEqual(is_filter_empty({ '$and' : [{ q:'', path:[] }] }), true)
	})

	// ---------------------------------------------------------------------------
	// the dialog
	// ---------------------------------------------------------------------------

	// On open, the default scope ('current') is asked; flipping re-asks with the
	// found-set source. read_raw is gone from this flow.
	it(`the dialog asks relation_targets per scope and never read_raw`, async function() {

		this.timeout(5000)

		let captured		= []
		let labels_current	= null
		let labels_found	= null
		try {
			captured = await with_stubbed_request(
				(body) => ok_targets(body.options.source.filter_by_locators?.length===1 && !body.options.source.filter
					? [TWO_TARGETS[0]]
					: TWO_TARGETS),
				async () => {
					const modal = await open_modal(make_dialog_options(make_pinned_sqo()))
					labels_current = [...modal.querySelectorAll('.target_section_label')].map(el => el.textContent)
					flip_scope(modal, 'found')
					await tick()
					labels_found = [...modal.querySelectorAll('.target_section_label')].map(el => el.textContent)
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(captured.some(el => el?.action==='read_raw'), false, 'no read_raw in this flow')

		const requests = targets_requests(captured)
		assert.strictEqual(requests.length, 2, 'one request per scope shown')
		assert.strictEqual(requests[0].dd_api, 'dd_core_api')
		assert.strictEqual(requests[0].sqo, undefined, 'the source rides in options, not rqo.sqo')
		assert.deepEqual(requests[0].options.source, {
			section_tipo		: ['test3'],
			filter_by_locators	: [OPEN_RECORD]
		}, 'current = the open record')

		const found_source = requests[1].options.source
		assert.deepEqual(found_source.filter, make_pinned_sqo().filter, 'found = the user\'s search')
		for (const key of ['limit','offset','order','filter_by_locators']) {
			assert.strictEqual(key in found_source, false, `found source must not carry ${key}`)
		}

		assert.deepEqual(labels_current, ['Fake target A (3)'], 'targets render with their counts')
		assert.deepEqual(labels_found, ['Fake target A (3)', 'Fake target B (1234)'],
			'the flip re-renders with the new answer')
	})

	// The census request's transport timeout is the exported constant the server
	// gate (relation_targets_native) orders after the server's budget + margin —
	// asserted on what data_manager.request actually RECEIVES, per request, so a
	// constant nothing passes cannot satisfy the ordering on its own.
	it(`every relation_targets request hands data_manager RELATION_TARGETS_TIMEOUT_MS`, async function() {

		this.timeout(5000)

		let seen = []
		try {
			await with_stubbed_request(
				() => ok_targets(TWO_TARGETS),
				async (_captured, _signals, timeouts) => {
					const modal = await open_modal(make_dialog_options(make_pinned_sqo()))
					flip_scope(modal, 'found')
					await tick()
					seen = timeouts
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(seen.length, 2, 'one census request per scope shown')
		assert.ok(Number.isFinite(RELATION_TARGETS_TIMEOUT_MS) && RELATION_TARGETS_TIMEOUT_MS > 0,
			'the exported constant is a positive number of ms')
		for (const timeout of seen) {
			assert.strictEqual(timeout, RELATION_TARGETS_TIMEOUT_MS,
				'the census transport waits exactly RELATION_TARGETS_TIMEOUT_MS')
		}
	})

	// a slow answer for the scope the user already left must not overwrite the
	// newer one
	it(`a stale answer from the previous scope is discarded`, async function() {

		this.timeout(5000)

		let labels = null
		try {
			await with_stubbed_request(
				(body) => body.options.source.filter
					? ok_targets(TWO_TARGETS)
					// the 'current' answer arrives AFTER the flip's
					: new Promise(resolve => setTimeout(() => resolve(ok_targets([{ tipo:'test9', label:'Stale', total:1 }])), 200)),
				async () => {
					render_open_list_with_direct_relations(make_dialog_options(make_pinned_sqo()))
					const modal = document.querySelector('.open_relations_modal')
					flip_scope(modal, 'found')
					await tick(400)
					labels = [...modal.querySelectorAll('.target_section_label')].map(el => el.textContent)
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.deepEqual(labels, ['Fake target A (3)', 'Fake target B (1234)'])
	})

	// held_answer — a census that only settles when its request is aborted (the
	// real data_manager then resolves client.aborted), or after a long fallback
	// so a broken abort cannot leave a promise pending past the test.
	const held_answer = (signal) => new Promise(resolve => {
		const settle = () => resolve({ ok : false, error : { is_api_error:true, code:'client.aborted', message:'aborted' } })
		signal?.addEventListener('abort', settle, { once:true })
		setTimeout(settle, 1000)
	})

	// Discarding a stale answer is not enough: the superseded request itself must
	// be aborted, or every flip leaves a census running.
	it(`a scope flip aborts the superseded census request`, async function() {

		this.timeout(5000)

		let first_aborted_after_flip	= null
		let second_aborted_after_flip	= null
		let signal_count				= null
		try {
			await with_stubbed_request(
				(body, signal) => body.options.source.filter
					? ok_targets(TWO_TARGETS)
					: held_answer(signal),
				async (captured, signals) => {
					render_open_list_with_direct_relations(make_dialog_options(make_pinned_sqo()))
					const modal = document.querySelector('.open_relations_modal')
					flip_scope(modal, 'found')
					await tick()
					signal_count				= signals.length
					first_aborted_after_flip	= signals[0]?.aborted ?? null
					second_aborted_after_flip	= signals[1]?.aborted ?? null
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(signal_count, 2, 'one signalled request per scope')
		assert.strictEqual(first_aborted_after_flip, true, 'the superseded \'current\' request is aborted')
		assert.strictEqual(second_aborted_after_flip, false, 'the live \'found\' request is not')
	})

	// Closing the modal abandons the census in flight: its request is aborted.
	it(`closing the modal aborts the in-flight census request`, async function() {

		this.timeout(5000)

		let aborted_before_close	= null
		let aborted_after_close		= null
		try {
			await with_stubbed_request(
				(body, signal) => held_answer(signal),
				async (captured, signals) => {
					await with_stubbed_dialogs(async () => {
						render_open_list_with_direct_relations(make_dialog_options(make_pinned_sqo()))
						const modal = document.querySelector('.open_relations_modal')
						await tick()
						aborted_before_close = signals[0]?.aborted ?? null
						await modal.close()
						aborted_after_close = signals[0]?.aborted ?? null
					})
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(aborted_before_close, false, 'the census is in flight while the modal is open')
		assert.strictEqual(aborted_after_close, true, 'closing the modal aborts it')
	})

	// Zero targets: the empty state, INSIDE the modal — not a blind alert after
	// it closed — and nothing to open.
	it(`zero targets show the empty state inside the modal`, async function() {

		this.timeout(5000)

		let messages	= []
		let empty_node	= null
		let disabled	= null
		try {
			await with_stubbed_request(
				() => ok_targets([]),
				async () => {
					messages = await with_stubbed_dialogs(async () => {
						const modal = await open_modal(make_dialog_options(make_pinned_sqo()))
						empty_node	= modal.querySelector('.target_sections_empty.no_targets')
						disabled	= modal.querySelector('button.success').disabled
					})
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.notStrictEqual(empty_node, null, 'the no_target_sections empty state is rendered in the modal')
		assert.strictEqual(disabled, true, 'nothing to open')
		assert.strictEqual(messages.length, 0, 'no alert')
	})

	// a refused census (perm.denied, index_unavailable…) is shown in the modal
	it(`a failed relation_targets answer is reported inside the modal`, async function() {

		this.timeout(5000)

		let error_node	= null
		let disabled	= null
		try {
			await with_stubbed_request(
				() => ({ ok : false, error : { is_api_error:true, code:'perm.denied', message:'Fake denial' } }),
				async () => {
					const modal = await open_modal(make_dialog_options(make_pinned_sqo()))
					error_node	= modal.querySelector('.target_sections_empty.error')
					disabled	= modal.querySelector('button.success').disabled
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.notStrictEqual(error_node, null)
		assert.strictEqual(error_node.textContent, 'Fake denial')
		assert.strictEqual(disabled, true)
	})

	// SUPERSEDED: the census is single-flight per SESSION, so the modal in another
	// tab of the same session replaces this one's request (409 resource.conflict)
	// without this modal having aborted it. Shown as superseded — not as a
	// failure — with a reload that asks again.
	it(`a superseded census (resource.conflict) offers a reload that asks again`, async function() {

		this.timeout(5000)

		let superseded_node	= null
		let error_node		= null
		let after_reload	= null
		let requests		= 0
		try {
			await with_stubbed_request(
				() => {
					requests++
					return requests===1
						? { ok : false, error : { is_api_error:true, code:'resource.conflict', message:'Fake superseded' } }
						: ok_targets(TWO_TARGETS)
				},
				async () => {
					const modal = await open_modal(make_dialog_options(make_pinned_sqo()))
					superseded_node	= modal.querySelector('.target_sections_empty.superseded')
					error_node		= modal.querySelector('.target_sections_empty.error')
					modal.querySelector('button.button_reload_targets')
						.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}))
					await tick()
					after_reload = modal.querySelectorAll('input[name=target_section]').length
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.notStrictEqual(superseded_node, null, 'the superseded state is rendered')
		assert.strictEqual(error_node, null, 'not reported as a failure')
		assert.strictEqual(requests, 2, 'the reload asked relation_targets again')
		assert.strictEqual(after_reload, TWO_TARGETS.length, 'the new answer is shown')
	})

	// Section mode end to end: the picked target's window is filtered by the
	// leaf, and the leaf's source is EXACTLY the one the counts came from.
	it(`section mode opens the picked target filtered by the referenced_by leaf`, async function() {

		this.timeout(10000)

		let captured	= []
		let urls		= []
		let disabled_before_pick = null
		try {
			captured = await with_stubbed_request(
				() => ok_targets(TWO_TARGETS),
				async () => {
					urls = await with_stubbed_open(async () => {
						await with_stubbed_dialogs(async () => {
							const modal = await open_modal(make_dialog_options(make_navigated_sqo()))
							disabled_before_pick = modal.querySelector('button.success').disabled
							pick_target(modal, 'test5')
							press_open(modal)
							// fire-and-forget window chain: this wait is the only join
							// point; it must outlast the dummy section build
							await tick(2000)
						})
					})
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(disabled_before_pick, true, 'Open waits for a target pick')
		assert.deepEqual(window_tipos(urls), ['test5'])

		const census_source	= targets_requests(captured).at(-1).options.source
		const reads			= captured.filter(el => el?.action!=='relation_targets' && leaf_of(el))
		assert.ok(reads.length > 0, 'the dummy section request carries the leaf')
		const read = reads[0]
		assert.deepEqual(leaf_of(read), census_source, 'the window filter reuses the census source verbatim')
		assert.deepEqual(read.sqo.filter.$and[0], { referenced_by : census_source },
			'the leaf holds exactly one key')
		assert.strictEqual(read.sqo.section_tipo[0], 'test5')
		for (const key of ['limit','offset','order']) {
			assert.strictEqual(key in leaf_of(read), false, `the leaf source must not carry ${key}`)
		}
		assert.strictEqual(captured.some(el => /"component_tipo":"section_id"/.test(JSON.stringify(el?.sqo?.filter ?? ''))), false,
			'no section_id list filter travels any more')
	})

	// Portal mode: no radios, from_component_tipo in the source, one window per
	// listed target.
	it(`portal mode opens one window per target, narrowed by from_component_tipo`, async function() {

		this.timeout(10000)

		let captured	= []
		let urls		= []
		let had_radios	= null
		try {
			captured = await with_stubbed_request(
				() => ok_targets(TWO_TARGETS),
				async () => {
					urls = await with_stubbed_open(async () => {
						await with_stubbed_dialogs(async () => {
							const modal = await open_modal(make_portal_options(make_pinned_sqo()))
							had_radios = modal.querySelector('input[name=target_section]')
							press_open(modal)
							await tick(3000)
						})
					})
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(had_radios, null, 'portal mode lists targets, it does not pick one')
		assert.strictEqual(targets_requests(captured)[0].options.source.from_component_tipo, 'test80')
		assert.deepEqual(window_tipos(urls), ['test4','test5'], 'one window per listed target')

		const leaves = captured.filter(el => el?.action!=='relation_targets').map(leaf_of).filter(Boolean)
		assert.ok(leaves.length >= 2)
		assert.ok(leaves.every(el => el.from_component_tipo==='test80'),
			'every window keeps the component narrowing')
	})

	// A source naming a whole section (no pins, no active filter value) asks
	// first; a filtered one does not.
	it(`an unfiltered found source asks for confirmation before opening`, async function() {

		this.timeout(10000)

		const sqo = make_navigated_sqo()
		sqo.filter = { '$and' : [] }

		let messages = []
		try {
			await with_stubbed_request(
				() => ok_targets(TWO_TARGETS),
				async () => {
					await with_stubbed_open(async () => {
						messages = await with_stubbed_dialogs(async () => {
							const modal = await open_modal(make_dialog_options(sqo))
							flip_scope(modal, 'found')
							await tick()
							pick_target(modal, 'test4')
							press_open(modal)
							await tick(2000)
						})
					})
				}
			)
		} finally {
			cleanup_modals()
		}

		assert.strictEqual(messages.length, 1, 'one confirm for the whole-section source')
	})
})


// @license-end
