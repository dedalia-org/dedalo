// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/
'use strict';



/**
* TEST_THESAURUS_PICKER
* The client gate for "open a thesaurus as a term picker for a caller component"
* (engineering/AREA_SPEC.md §5). It covers two surfaces:
*
*   1. thesaurus_picker.js       — THE picker: mode grant, capacity, one-step picking,
*                                  the ONE publisher, the ONE term control.
*   2. area_thesaurus.js         — the caller declaration rides the FIRST read.
*
* The inline SURFACE (component_portal build_thesaurus_pane / toggle_thesaurus_pane)
* is gated separately in `test_thesaurus_pane.js`, which imports component_portal —
* this file's NOT importing it is one of its own assertions.
*
* WHY THESE ASSERTIONS AND NOT OTHERS. Every rule below is one the engine states
* somewhere and could otherwise regress silently:
*
*  - "the caller rides the FIRST rqo" is the whole handshake. The server derives the
*    mode, the hierarchy narrowing and the cap from `rqo.source.caller`; a boot page
*    performs exactly ONE read, so a caller folded in afterwards changes nothing. The
*    assertion is therefore on the FIRST captured request body, never on a later one.
*  - "self.context still comes from the server" guards the trap the plan names by
*    name: pre-stamping `self.context` makes area_thesaurus.build discard the whole
*    server context (label, permissions, request_config, widgets).
*  - "a refused node renders a DISABLED, TITLED control" is the difference between a
*    structural level a curator can walk through and a row that looks broken. Rendering
*    nothing is the regression; rendering an enabled control that fails on click is
*    worse. Both are asserted against, in both directions.
*  - The capacity rules are the CLIENT half of a server-owned cap. The picker must
*    never re-derive `properties.data_limit`; it consumes `{selection_limit, remaining}`
*    verbatim, and `remaining` (not the raw limit) is what bounds the tray.
*  - Teardown is asserted by COUNTING (document keydown listeners, ts_object instances)
*    across three open/close cycles, because a leak of one is invisible and a leak of
*    N is a page that stops responding to Ctrl+S / Ctrl+M and a tree that serves another
*    picker's rows from cache.
*
* NO BACKEND, BY CONSTRUCTION. `data_manager.request` is a method on a shared singleton,
* so it is patched in place: the area then builds from a canned context/data pair and the
* outgoing rqo is captured verbatim. A live thesaurus would make the capacity and
* selectability assertions depend on operator-mutable records, which is exactly what the
* scratch-twin law forbids.
*
* NO component_portal IS IMPORTED HERE, deliberately: `attach_picker` takes its caller as
* an argument and reads nothing from DOM ancestry or portal internals. That constraint is
* what lets a second host (edit-in-list) be added without a second picker, so this file
* proves it by constructing every caller and linker as a plain object.
*/

// imports
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {
		attach_picker,
		get_picker,
		publish_link_terms,
		render_term_pick_control,
		term_selectability,
		PICKER_LINK_CHANNEL_PREFIX
	} from '../../../core/area_thesaurus/js/thesaurus_picker.js'



// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

// AREA_TIPO / PICKER_CALLER — the thesaurus area and the ddo that declares itself
// as the picker's caller. Both are inert here (nothing is read from the ontology):
// the canned response below is what the "server" answers.
	const AREA_TIPO = 'dd100'
	const PICKER_CALLER = {
		section_tipo	: 'test3',
		section_id		: 1,
		tipo			: 'test111'
	}

// make_linker — the component the pick is published to. `caller` MUST be truthy:
// publish_link_terms resolves the target window from the LINKER's own caller
// (`!linker.caller ? window.opener : window`), and an iframe has no opener.
	// (!) `data` MUST be the REAL component shape: an OBJECT carrying `entries`
	// (component_portal.js:659 `self.data = self.data || {}`, :695, :1231). A mock
	// that invents `[{value}]` is how a picker reading `data[0].value` shipped green
	// while being dead against every real component — the suite asserted the mock.
	const make_linker = (id, linked_value=[]) => ({
		id		: id,
		caller	: { id: 'synthetic_host' },
		data	: { entries: linked_value },
		picker	: null
	})

// make_caller — the instance that OWNS the picker (a tool, a host, a list cell).
// A plain object on purpose: the picker never discovers it.
	const make_caller = (id='synthetic_caller') => ({ id })

// make_area — a BUILT area_thesaurus, reduced to the three fields attach_picker
// reads: the caller declaration, the server's context, and the boot data (which
// carries the per-root-term selectability answer).
	const make_area = (options={}) => ({
		picker_caller	: options.picker_caller===undefined ? PICKER_CALLER : options.picker_caller,
		context			: {
			thesaurus_mode	: options.thesaurus_mode ?? 'relation',
			picker			: options.constraint ?? null
		},
		data			: options.data ?? [],
		caller			: null,
		linker			: null,
		picker			: null
	})

// make_root_selectability_data — the area read's per-root-term answer, in the wire
// shape the server emits in relation mode only:
//   data[i].value[j].root_terms_selectable = [{section_tipo, section_id, selectable}]
	const make_root_selectability_data = (entries) => ([
		{
			tipo	: AREA_TIPO,
			value	: [{ root_terms_selectable: entries }]
		}
	])

// terms used across the blocks. `hierarchy1` is the structural root a thesaurus
// always has and which is never selectable; the rest are ordinary terms.
	const TERM_A		= { section_tipo:'test3', section_id:11, label:'Term A' }
	const TERM_B		= { section_tipo:'test3', section_id:12, label:'Term B' }
	const TERM_C		= { section_tipo:'test3', section_id:13, label:'Term C' }
	const TERM_ROOT		= { section_tipo:'hierarchy1', section_id:1, label:'Structural root' }
	const TERM_UNKNOWN	= { section_tipo:'test3', section_id:99, label:'Not answered for' }

// SELECTABLE_DATA — the answer used by most blocks: A/B/C linkable, the structural
// root not, and TERM_UNKNOWN deliberately absent (the server answered nothing for it).
	const SELECTABLE_DATA = () => make_root_selectability_data([
		{ section_tipo:TERM_A.section_tipo,    section_id:TERM_A.section_id,    selectable:true },
		{ section_tipo:TERM_B.section_tipo,    section_id:TERM_B.section_id,    selectable:true },
		{ section_tipo:TERM_C.section_tipo,    section_id:TERM_C.section_id,    selectable:true },
		{ section_tipo:TERM_ROOT.section_tipo, section_id:TERM_ROOT.section_id, selectable:false }
	])

// with_link_subscription — subscribe to the ONE pick channel, run fn, always
// unsubscribe. Returns every payload the channel carried, so "ONE array of 3" is
// asserted as a message COUNT plus a length, never as a length alone.
	const with_link_subscription = async (linker, fn) => {
		const messages	= []
		const token		= event_manager.subscribe(
			PICKER_LINK_CHANNEL_PREFIX + linker.id,
			(payload) => { messages.push(payload) }
		)
		try {
			await fn(messages)
		} finally {
			event_manager.unsubscribe(token)
		}
		return messages
	}

// build_area_response — the canned server answer an area_thesaurus build consumes.
// It carries exactly the context fields build() distributes onto the instance, so
// "the context still comes from the server" is a real assertion and not a tautology.
	const build_area_response = (options={}) => ({
		ok : true,
		data : {
			context : [{
				tipo			: AREA_TIPO,
				parent			: null,
				typo			: 'area',
				model			: 'area_thesaurus',
				section_tipo	: AREA_TIPO,
				label			: 'Fake thesaurus (client gate)',
				permissions		: 2,
				request_config	: [{
					api_engine	: 'dedalo',
					type		: 'main',
					sqo			: { section_tipo: [] }
				}],
				thesaurus_mode	: options.thesaurus_mode ?? 'relation',
				picker			: options.constraint ?? {
					selection_limit	: null,
					remaining		: null,
					targets			: []
				}
			}],
			data : [{
				tipo	: AREA_TIPO,
				value	: []
			}]
		}
	})

// with_stubbed_request — patch the shared data_manager, run fn, always restore.
// Every outgoing body is captured IN ORDER: the first element is the boot read, and
// that is the one the caller handshake must already be on.
	const with_stubbed_request = async (response, fn) => {
		const original	= data_manager.request
		const captured	= []
		data_manager.request = async (options) => {
			captured.push(options?.body ? JSON.parse(JSON.stringify(options.body)) : null)
			return response
		}
		try {
			await fn(captured)
		} finally {
			data_manager.request = original
		}
		return captured
	}


// settle — let MutationObserver callbacks, idle callbacks and the area's own async
// renders land before asserting on the DOM or on the instance registry.
	const settle = (ms=120) => new Promise(resolve => setTimeout(resolve, ms))



describe('THESAURUS PICKER CLIENT TEST', function() {

	this.timeout(30000)



	// ─────────────────────────────────────────────────────────────────────────
	describe('labels — every picker string resolves from the repo catalog', function() {

		/**
		* The picker modules render NO English literal: a missing key shows as the key
		* and is console.error'd. That makes the catalog part of the feature's wire, so
		* it is gated here against the SERVED dictionary (the labels resource → get_label),
		* not against the repo files — which proves the definitions actually reach the
		* browser.
		*/
			const PICKER_LABEL_KEYS = [
				'picker_browse_only',
				'picker_link_failed',
				'picker_no_capacity',
				'picker_term_already_linked',
				'picker_term_not_addressable',
				'picker_term_not_selectable',
				'picker_term_selectability_unknown',
				'picker_view_not_supported',
				// chrome reused from the pre-existing catalog
				'cancel',
				'empty_selection',
				'link_resource'
			]

		it('every key the picker renders is served and non-empty', function() {
			const missing = PICKER_LABEL_KEYS.filter(key =>
				typeof get_label[key]!=='string' || get_label[key].length===0
			)
			assert.deepEqual(missing, [], 'label catalog keys missing from the served dictionary')
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('mode grant — the server decides, the client never upgrades', function() {

		it('a caller-declared read granted relation mode is a linkable picker', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('grant_relation')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.notEqual(picker, null, 'expected a picker')
			assert.equal(picker.mode, 'relation')
			assert.equal(picker.has_room(), true)
			assert.equal(picker.not_linkable_key(), null)
			// one hop from any tree row / list row that carries the linker
			assert.equal(get_picker({ linker }), picker, 'get_picker must resolve through the linker')
		})

		it('a caller-declared read answered `default` is NEVER upgraded, and says why', function() {
			const area		= make_area({ thesaurus_mode:'default', data: SELECTABLE_DATA() })
			const linker	= make_linker('grant_default')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.mode, 'default', 'a server default must not become relation')
			assert.equal(picker.has_room(), false)
			assert.equal(picker.not_linkable_key(), 'picker_browse_only')

			// a SELECTABLE term in a browse-only tree still renders its arrow, disabled and
			// titled: the term does accept links, this read just was not granted a picker
			const control = render_term_pick_control({ picker, term: TERM_A, selectable: true })
			assert.notEqual(control, null, 'a browse-only tree still renders the control')
			assert.equal(control.classList.contains('disabled'), true)
			assert.equal(control.title, get_label.picker_browse_only)
		})

		it('a read with NO caller takes the tool exemption (indexation / cataloging)', function() {
			// tool_indexation and tool_cataloging open the thesaurus as their own
			// indexing surface: there is no caller ddo for the server to derive from, so
			// the tool declares relation mode itself. The exemption is named, not silent.
			const area		= make_area({ picker_caller:null, thesaurus_mode:null, data: SELECTABLE_DATA() })
			const linker	= make_linker('tool_exemption')
			const picker	= attach_picker(area, { linker, caller: make_caller('tool_indexation_1') })

			assert.equal(picker.mode, 'relation')
			assert.equal(picker.has_room(), true)
		})

		it('incomplete wiring is refused, never degraded to a half-picker', function() {
			const area = make_area({})
			assert.equal(attach_picker(area, { caller: make_caller() }), null, 'no linker → refused')
			assert.equal(attach_picker(area, { linker: make_linker('x') }), null, 'no caller → refused')
			assert.equal(attach_picker(null, { linker: make_linker('y'), caller: make_caller() }), null,
				'an unbuilt area → refused')
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('selectability — the server answers per node, the client renders it', function() {

		it('a NON-SELECTABLE term renders NO control — the arrow means "linkable"', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('not_selectable')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(term_selectability(picker, TERM_ROOT), false, 'the server said false')

			// NO arrow. The link arrow means "this term can be indexed"; painting a
			// dimmed one on every structural/grouping level buries the terms that accept
			// a link. This is the id column's long-standing behaviour
			// (`if (is_indexable===false) break`) and it is the correct one.
			const control = render_term_pick_control({ picker, term: TERM_ROOT })
			assert.equal(control, null, 'a non-selectable term gets no link affordance at all')

			// and the click is refused with the same named reason, not silently ignored
			const result = picker.pick(TERM_ROOT, false)
			assert.equal(result.status, 'refused')
			assert.equal(result.reason_key, 'picker_term_not_selectable')
			assert.equal(picker.is_linked(TERM_ROOT), false)
		})

		it('a term NO channel answered for is UNKNOWN — no affordance on a guess', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('unknown_selectability')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(term_selectability(picker, TERM_UNKNOWN), null, 'neither channel answered')

			// unknown is not "yes": an affordance is never offered on a guess, and the
			// pick itself still refuses with its own named reason if one is forced.
			const control = render_term_pick_control({ picker, term: TERM_UNKNOWN })
			assert.equal(control, null)
			assert.equal(picker.pick(TERM_UNKNOWN, null).reason_key, 'picker_term_selectability_unknown')
		})

		it('a deeper node carries its own answer (is_indexable) when the read has none', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('deep_node')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(term_selectability(picker, { ...TERM_UNKNOWN, is_indexable:true }), true)
			assert.equal(term_selectability(picker, { ...TERM_UNKNOWN, is_indexable:false }), false)
		})

		it('a section that declares NO contract answers SELECTABLE, not unknown', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('no_contract')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			// The section list read stamps `selectability_declared:false` on every row
			// of a section whose section_map names no `is_indexable` component (People,
			// browsed as a picker by the indexation tool). That is a server ANSWER —
			// "there is no per-term flag here" — and the save path already exempts such
			// a target, so the row must be pickable. Before this channel existed the
			// read said nothing and the row was indistinguishable from UNKNOWN, which
			// withheld the arrow from records the save would have accepted.
			const row = { ...TERM_UNKNOWN, selectability_declared:false }
			assert.equal(term_selectability(picker, row), true)

			const control = render_term_pick_control({ picker, term: row })
			assert.notEqual(control, null, 'a no-contract row gets the link affordance')
		})

		it('the exemption never overrides an answer the server DID give', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('contract_wins')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			// The two keys are mutually exclusive on the wire, but precedence is pinned
			// here anyway: a term explicitly flagged NOT indexable stays unpickable, or
			// the exclusion control would be silently defeated by a stale key.
			assert.equal(
				term_selectability(picker, { ...TERM_UNKNOWN, is_indexable:false, selectability_declared:false }),
				false
			)
			// and a root term the area read answered for keeps that answer
			assert.equal(
				term_selectability(picker, { ...TERM_ROOT, selectability_declared:false }),
				term_selectability(picker, TERM_ROOT)
			)
		})

		it('a SELECTABLE term renders an active control and publishes ON THE CLICK', async function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('selectable_publish')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			const control = render_term_pick_control({ picker, term: TERM_A })
			assert.equal(control.classList.contains('disabled'), false)
			assert.equal(control.title, get_label.link_resource)

			const messages = await with_link_subscription(linker, async () => {
				control.dispatchEvent(new MouseEvent('click', { bubbles:true }))
			})

			// ONE step: the click IS the link. There is no tray and no confirm — the
			// locator reaches the caller now, and the operator sees it land there.
			assert.equal(messages.length, 1, 'exactly ONE message per click')
			assert.equal(messages[0].length, 1)
			assert.equal(messages[0][0].section_tipo, TERM_A.section_tipo)
			assert.equal(String(messages[0][0].section_id), String(TERM_A.section_id))
			assert.equal(picker.is_linked(TERM_A), true, 'the term repaints as linked')
			assert.equal(control.classList.contains('linked'), true)
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('the pick channel — one publisher, one array', function() {

		it('picking 3 terms publishes THREE messages — one step each', async function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('batch_of_three')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			const messages = await with_link_subscription(linker, async () => {
				assert.equal(picker.pick(TERM_A, true).status, 'linked')
				assert.equal(picker.pick(TERM_B, true).status, 'linked')
				assert.equal(picker.pick(TERM_C, true).status, 'linked')
			})

			// Three picks, three messages, each an array of one. Batching them bought
			// nothing: the server re-resolves the remaining capacity on every insert, so
			// N sequential picks are capped exactly as one batch of N would be.
			assert.equal(messages.length, 3, 'one message per pick')
			assert.deepEqual(messages.map(payload => payload.length), [1,1,1])
			assert.deepEqual(
				messages.map(payload => String(payload[0].section_id)),
				[TERM_A, TERM_B, TERM_C].map(term => String(term.section_id))
			)
		})

		it('the payload carries only {section_tipo, section_id, label} — no client type stamp', async function() {
			// The server owns `type` (getRelationTypeByTipo → the model descriptor's own
			// default: dd48/dd47/dd96/dd89/dd98/dd490, NOT dd151). A client stamp here
			// would write wrong-typed rows and break the server's dedup key.
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('no_type_stamp')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			const messages = await with_link_subscription(linker, async () => {
				picker.pick({ ...TERM_A, type:'dd151', from_component_tipo:'test111' }, true)
			})

			assert.deepEqual(Object.keys(messages[0][0]).sort(), ['label', 'section_id', 'section_tipo'])
		})

		it('a pick that reaches nobody is REFUSED loudly, never silently lost', function() {
			const linker = make_linker('nobody_subscribed')
			assert.equal(publish_link_terms(linker, [TERM_A]), false,
				'no subscriber on the channel → false')
			assert.equal(publish_link_terms(linker, []), false, 'an empty selection → false')
			assert.equal(publish_link_terms(null, [TERM_A]), false, 'no linker → false')
			assert.equal(publish_link_terms(linker, [{ label:'unaddressable' }]), false,
				'a term with no locator → false')
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('already-linked terms — selected and locked', function() {

		it('the caller current value renders as locked, and cannot be picked again', function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			// the universal component wire shape: data[0].value = [locator, …]
			const linker	= make_linker('already_linked', [
				{ section_tipo:TERM_A.section_tipo, section_id:TERM_A.section_id, type:'dd151' }
			])
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.linked.length, 1, 'read from the linker, not from the portal')
			assert.equal(picker.is_linked(TERM_A), true)

			const control = render_term_pick_control({ picker, term: TERM_A })
			assert.equal(control.classList.contains('linked'), true)
			assert.equal(control.classList.contains('disabled'), true, 'locked, not hidden')
			assert.equal(control.title, get_label.picker_term_already_linked)

			const result = picker.pick(TERM_A, true)
			assert.equal(result.status, 'refused')
			assert.equal(result.reason_key, 'picker_term_already_linked')
			assert.equal(picker.linked.length, 1, 'no double-add')
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('capacity — the server resolves it, the picker obeys `remaining`', function() {

		it('selection_limit 1 keeps offering the affordance: the CALLER replaces', async function() {
			const area		= make_area({
				data		: SELECTABLE_DATA(),
				constraint	: { selection_limit:1, remaining:1, targets:['test3'] }
			})
			const linker	= make_linker('single_select')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.selection_limit, 1)

			// (!) pick() PUBLISHES, so a subscriber must be attached or the publish
			// finds nobody and the pick is refused 'picker_link_failed' — the rule this
			// same suite pins above. A capacity test without a subscriber asserts the
			// publish failure, not the capacity.
			await with_link_subscription(linker, async () => {
				// A single-valued component always has room: its next pick REPLACES.
				// The replacement itself is the CALLER's (it owns its value); the picker
				// must not withhold the affordance on its behalf.
				assert.equal(picker.pick(TERM_A, true).status, 'linked')
				assert.equal(picker.has_room(), true, 'one value means the next pick supersedes')
				assert.equal(picker.pick(TERM_B, true).status, 'linked')
			})
			assert.equal(picker.linked.length, 1, 'the local view holds one term')
			assert.equal(String(picker.linked[0].section_id), String(TERM_B.section_id))
		})

		it('a data_limit:2 caller already holding 1 accepts exactly 1 more, then offers nothing', async function() {
			// The session cap is REMAINING capacity, never the raw limit: the server
			// resolved 2 − 1 held = 1. After that one pick the affordance must be gone —
			// a further pick is neither accepted nor silently swapped for the first.
			//
			// (!) REPLACE BELONGS TO selection_limit === 1, NOT TO a remaining of 1. They
			// coincide for a single-value component and diverge exactly here: a
			// multi-value component whose remaining capacity has fallen to 1 must REFUSE
			// the overflow, because dropping the operator's first pick to make room is a
			// scope narrowing they never asked for.
			const area		= make_area({
				data		: SELECTABLE_DATA(),
				constraint	: { selection_limit:2, remaining:1, targets:['test3'] }
			})
			const linker	= make_linker('remaining_one', [
				{ section_tipo:TERM_C.section_tipo, section_id:TERM_C.section_id }
			])
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.selection_limit, 2, 'the limit is reported verbatim')
			assert.equal(picker.remaining, 1, 'bounded by remaining, not by the limit')

			let refused
			await with_link_subscription(linker, async () => {
				assert.equal(picker.pick(TERM_A, true).status, 'linked')
				assert.equal(picker.has_room(), false, 'the cap is reached — no further affordance')
				refused = picker.pick(TERM_B, true)
			})
			assert.equal(refused.status, 'refused')
			assert.equal(refused.reason_key, 'picker_no_capacity')
			assert.equal(picker.is_linked(TERM_A), true,
				'the first pick must survive: dropping it silently is a scope narrowing')
			assert.equal(picker.is_linked(TERM_B), false)

			// and the control for an unpicked term says so, before the click
			const control = render_term_pick_control({ picker, term: TERM_B })
			assert.equal(control.classList.contains('disabled'), true)
			assert.equal(control.title, get_label.picker_no_capacity)
		})

		it('remaining <= 0 opens a BROWSABLE, non-linkable tree with a labelled reason', function() {
			const area		= make_area({
				data		: SELECTABLE_DATA(),
				constraint	: { selection_limit:2, remaining:0, targets:['test3'] }
			})
			const linker	= make_linker('at_capacity')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.has_room(), false)
			assert.equal(picker.not_linkable_key(), 'picker_no_capacity')

			const control = render_term_pick_control({ picker, term: TERM_A })
			assert.notEqual(control, null, 'the tree is still browsable')
			assert.equal(control.classList.contains('disabled'), true)
			assert.equal(control.title, get_label.picker_no_capacity,
				'the reason is a label, not a dead click')

			const result = picker.pick(TERM_A, true)
			assert.equal(result.status, 'refused')
			assert.equal(result.reason_key, 'picker_no_capacity')
		})

		it('an absent data_limit is uncapped — absent is not zero', async function() {
			const area		= make_area({
				data		: SELECTABLE_DATA(),
				constraint	: { selection_limit:null, remaining:null, targets:[] }
			})
			const linker	= make_linker('uncapped')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			assert.equal(picker.selection_limit, null)
			assert.equal(picker.remaining, null)
			await with_link_subscription(linker, async () => {
				assert.equal(picker.pick(TERM_A, true).status, 'linked')
				assert.equal(picker.pick(TERM_B, true).status, 'linked')
				assert.equal(picker.pick(TERM_C, true).status, 'linked')
			})
			assert.equal(picker.has_room(), true)
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('search results link through the SAME publish path', function() {

		/**
		* The thesaurus LIST (the primary way into a large thesaurus) used to gate its
		* link button on `initiator.indexOf('tool_indexation_')!==-1`, while a picker's
		* initiator is the CALLER COMPONENT's id — so searching could never pick. The
		* gate is now "a picker is attached", resolved through the same one hop.
		*
		* `render_column_id` is module-private in view_thesaurus_list_section.js, so what
		* is exercised here is the composition it performs: get_picker on the list
		* section's own caller chain, then the SHARED control + the SHARED publisher.
		*/
		it('a list row resolves the picker and publishes on the one channel', async function() {
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('search_result_row')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			// the list section's shape: section.caller is the area_thesaurus holder
			const list_section = { model:'section', caller: { area_thesaurus: area } }
			assert.equal(get_picker(list_section.caller.area_thesaurus), picker,
				'the row must reach the picker without a caller-chain walk')

			const fragment	= new DocumentFragment()
			const control	= render_term_pick_control({
				picker		: picker,
				term		: TERM_A,
				selectable	: term_selectability(picker, TERM_A),
				parent		: fragment
			})
			assert.notEqual(control, null)
			assert.equal(control.classList.contains('disabled'), false,
				'a search hit the server answered for is pickable')

			const messages = await with_link_subscription(linker, async () => {
				control.dispatchEvent(new MouseEvent('click', { bubbles:true }))
			})
			assert.equal(messages.length, 1, 'the SAME publisher, not a second one')
			assert.equal(messages[0].length, 1)
		})

		it('a row the server answered nothing for offers no link affordance', function() {
			// The honest current state: the section LIST read emits no per-row
			// selectability, so a non-root search hit is UNKNOWN and gets no arrow —
			// the same answer the tree gives an unanswered node.
			const area		= make_area({ data: SELECTABLE_DATA() })
			const linker	= make_linker('search_result_unanswered')
			const picker	= attach_picker(area, { linker, caller: make_caller() })

			const control = render_term_pick_control({
				picker		: picker,
				term		: TERM_UNKNOWN,
				selectable	: term_selectability(picker, TERM_UNKNOWN)
			})
			assert.equal(control, null)
		})
	})



	// ─────────────────────────────────────────────────────────────────────────
	describe('the caller declaration rides the FIRST read', function() {

		it('the FIRST outgoing rqo already carries source.caller', async function() {
			let area = null
			const captured = await with_stubbed_request(build_area_response(), async () => {
				const {get_instance} = await import('../../../core/common/js/instances.js')
				area = await get_instance({
					model			: 'area_thesaurus',
					tipo			: AREA_TIPO,
					section_tipo	: AREA_TIPO,
					section_id		: null,
					mode			: 'list',
					id_variant		: 'gate_first_rqo',
					config			: { picker_caller: PICKER_CALLER }
				})
				assert.notEqual(area, null, 'expected an area instance')
				assert.deepEqual(area.picker_caller, PICKER_CALLER, 'init must read config.picker_caller')
				await area.build(true)
			})

			assert.equal(captured.length > 0, true, 'the area must have read')
			assert.deepEqual(captured[0].source?.caller, PICKER_CALLER,
				'the caller must ride the FIRST request — a boot page performs exactly one read')

			// the server context survived: build() must NOT discard it (the pre-stamp trap)
			assert.equal(area.context.label, 'Fake thesaurus (client gate)')
			assert.equal(area.context.permissions, 2)
			assert.equal(Array.isArray(area.context.request_config), true)
			assert.equal(area.context.thesaurus_mode, 'relation')
			assert.deepEqual(area.context.picker, { selection_limit:null, remaining:null, targets:[] })

			await area.destroy(true, true, true)
		})

		it('an ordinary browse sends NO source.caller (the frozen fixture shape)', async function() {
			let area = null
			const captured = await with_stubbed_request(build_area_response({thesaurus_mode:'default'}), async () => {
				const {get_instance} = await import('../../../core/common/js/instances.js')
				area = await get_instance({
					model			: 'area_thesaurus',
					tipo			: AREA_TIPO,
					section_tipo	: AREA_TIPO,
					section_id		: null,
					mode			: 'list',
					id_variant		: 'gate_no_caller'
				})
				await area.build(true)
			})

			assert.equal(area.picker_caller, null, 'no declaration, no field')
			assert.equal(captured[0].source?.caller, undefined,
				'adding the key unconditionally would be a hard miss against the frozen store')

			await area.destroy(true, true, true)
		})
	})
})

// @license-end
