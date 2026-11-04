// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/
'use strict';



import {request_failed, response_data} from '../../../core/common/js/api_error.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {
	get_columns_map,
	select_by_caller_chain,
	caller_chains_compatible,
	get_caller_chain_tipos,
	root_caller_chains,
	section_injects_children
} from '../../../core/common/js/common.js'
import {component_common} from '../../../core/component_common/js/component_common.js'
import {
	sends_own_show,
	attach_show_maps,
	merge_fixed_filter_sqo
} from '../../../core/component_portal/js/component_portal.js'
import {section_record} from '../../../core/section_record/js/section_record.js'
import {get_instance, add_instance, delete_instance, key_instances_builder} from '../../../core/common/js/instances.js'
import {ui} from '../../../core/common/js/ui.js'



/**
* TEST_NESTED_PORTAL
* The client half of the nested-ddo_map plan, phase W5 (owner decisions (a) and
* (b), 2026-11-03; server: src/core/section/node_contexts.ts,
* src/core/relations/request_config/from_rqo.ts, src/core/relations/caller_chain.ts).
*
*   (b) PER OCCURRENCE — backend-free. When one context key (tipo, section_tipo,
*       mode) occurs under two parents with different effective configs, the
*       server ships one entry per occurrence and stamps `caller_chain` on the
*       entries AND their data items. Each cell takes the entry / item of ITS
*       ancestry (select_by_caller_chain: the read's root, tagged at intake by
*       root_caller_chains, plus the stamped chain must EQUAL the row's
*       component path — a repeated tipo (test80 under test80) included; an
*       untagged item falls back to the longest stamped suffix), in list
*       columns, in the edit child set (judged by the chain's direct parent, not
*       `parent`, which an absorbed copy inherits), and the shared datum keeps
*       both occurrences apart (update_datum, caller_chains_compatible).
*
*   (a) CONSISTENT PAGING — on the SUITE server. A NESTED portal (a component
*       stands above it) sends its context's show / search ddo_map on its own
*       reads, beside `source.callers`, so page 2 and a refresh resolve the map
*       its caller injected, not the portal's own. The ancestry is REAL: the
*       nested test80 sits under `zzcnp2`, a portal of the scratch section
*       `zzcnp1` whose map declares test80 → [test211, test52] — a situation
*       the runner installs before its server starts and sweeps after
*       (src/core/test_data/nested_portal_fixture.ts) — so the chain the client
*       sends is one the server VERIFIES (caller_chain.ts). Two proofs: the
*       paging leg (the sent show + the verified chain hold the columns), and a
*       read with the chain ALONE (no show) that still brings test211 on page 2,
*       against a forged chain (test80 above test80, refused: test80's own map
*       does not declare test80) that resolves the portal's own map. Grant
*       inheritance and the read floor of a verified chain are gated in
*       test/unit/subdatum_permission_native.test.ts. The situation is BUILT: one
*       host test3 record and three test3 records linked into the host's test80
*       (the generic self-portal, own show [test52]) — created through the engine's
*       create door and swept after (links first, then records, proved by a
*       count). The "injected" context is built client side, as a caller would
*       hand it down: show [test211 number, test52 text] — a column the portal's
*       OWN map does not have, in an order it does not have. records[0] and
*       records[2] get a test211 value, records[1] none (its test211 cell must
*       still be there, EMPTY: columns never shift). Page limit 2, so page 2 is
*       records[2] alone — and its test211 value can only come back if the
*       server honoured the sent show (the own map has no test211).
*
*   fixed_filter refresh (plan E11): a refresh whose answer carries a
*       `fixed_filter` sqo merges ONLY the sqo (per api_engine + type) — the
*       injected show stays. The answer is the REAL server read, with the
*       fixed_filter and the own-order show grafted onto its context through a
*       data_manager.request spy (no suite portal declares a fixed_filter; the
*       graft makes the old whole-request_config replacement observable). The
*       graft tests the CLIENT merge only; that the server answers a FRESH sqo
*       at all is proved on the real answer by the next case (the refresh
*       re-sends the context's stale sqo, and the server must not echo it —
*       its own sqo, re-expanded per read, stays: element_node.ts
*       mergeComponentStageOne; server gate nested_ddo_data_native.test.ts
*       "never echoes the client's sqo").
*/



// ---------------------------------------------------------------- (b) backend-free

// fake instances linked through `.caller` (the fields the chain walk reads)
	const fake = (model, tipo, section_tipo, caller=null, extra={}) => Object.assign({
		model,
		type			: model.startsWith('component_') ? 'component' : model,
		tipo,
		section_tipo,
		section_id		: 1,
		mode			: 'list',
		permissions		: 2,
		caller
	}, extra)

// registry hygiene — every fake child planted in the shared instances map
	const registered_keys = []
	const register_child = (key) => {
		const child = {
			id			: key,
			build_calls	: 0,
			build		: async function(){ this.build_calls++; return true }
		}
		registered_keys.push(key)
		add_instance(key, child)
		return child
	}

// the exact key build_instance asks get_instance for (test_section_record child_key_of)
	const child_key_of = (sr, o) => key_instances_builder({
		model			: o.model,
		tipo			: o.tipo,
		section_tipo	: o.section_tipo,
		section_id		: sr.section_id,
		mode			: o.mode ?? sr.mode,
		lang			: o.lang,
		parent			: sr.tipo,
		id_variant		: `${sr.tipo}_${sr.section_tipo}_${sr.section_id}_${sr.caller.section_tipo}_${sr.caller.section_id}`,
		column_id		: o.column_id
	})

// a section_record under `caller` (the portal instance whose row it is)
	const make_row = async (caller, options) => {
		const sr = new section_record()
		await sr.init(Object.assign({
			model			: 'section_record',
			tipo			: caller.tipo,
			section_tipo	: 'st_n',
			section_id		: 5,
			mode			: 'list',
			lang			: 'lg-eng',
			context			: {},
			datum			: {context:[], data:[]}
		}, options, {caller}))
		return sr
	}

	const N_TIPO = 'c_n'
	const N_MODEL = 'component_input_text'



describe(`NESTED PORTAL — per-occurrence caller_chain (b)`, async () => {

	after(function(){
		for (const key of registered_keys) {
			delete_instance(key)
		}
		registered_keys.length = 0
	})

	it(`select_by_caller_chain: unstamped candidates keep first-wins`, function() {
		const a = {tipo:'x'}, b = {tipo:'x'}
		assert.strictEqual(select_by_caller_chain([a, b], ['P1']), a)
		assert.strictEqual(select_by_caller_chain([], ['P1']), undefined)
		assert.strictEqual(select_by_caller_chain([b], ['P1']), b)
	})

	it(`select_by_caller_chain: each path takes its own stamped occurrence`, function() {
		const p1 = {caller_chain:'P1'}
		const p2 = {caller_chain:'P2'}
		assert.strictEqual(select_by_caller_chain([p1, p2], ['P2']), p2)
		assert.strictEqual(select_by_caller_chain([p1, p2], ['P1']), p1)
		// a response rooted below the page's top: its chains are SUFFIXES of the path
		assert.strictEqual(select_by_caller_chain([p1, p2], ['OUTER', 'P2']), p2)
		// the longest matching suffix wins
		const deep = {caller_chain:'OUTER>P1'}
		assert.strictEqual(select_by_caller_chain([p1, deep, p2], ['OUTER', 'P1']), deep)
		// '' (a top-level occurrence) only for a top-level path when a longer one exists
		const top = {caller_chain:''}
		assert.strictEqual(select_by_caller_chain([top, p1], []), top)
		assert.strictEqual(select_by_caller_chain([top, p1], ['P1']), p1)
		// the chain is computed lazily, only when a choice is needed
		let calls = 0
		select_by_caller_chain([{}], () => { calls++; return [] })
		select_by_caller_chain([{}, {}], () => { calls++; return [] })
		assert.equal(calls, 0, 'no chain is needed without stamped candidates')
		select_by_caller_chain([p1, p2], () => { calls++; return ['P1'] })
		assert.equal(calls, 1)
	})

	it(`select_by_caller_chain: no matching occurrence → never another parent's entry`, function() {
		// The server gives every chain of a split key its own entry
		// (node_contexts.ts NodeContextSet.absorb), so a path that matches none is a
		// defect — the old `|| candidates[0]` handed it the FIRST parent's config.
		const z = {caller_chain:'Z'}
		const x = {caller_chain:'X'}
		const original_warn = console.warn
		console.warn = () => {}
		try {
			assert.strictEqual(select_by_caller_chain([z, x], ['Y']), undefined, 'a cell of Y must not borrow Z\'s config')
		} finally {
			console.warn = original_warn
		}
		// an unstamped candidate (the pre-(b) identity) is still taken
		const plain = {}
		assert.strictEqual(select_by_caller_chain([z, plain, x], ['Y']), plain)
		// the client sees LESS of the ancestry than the response was rooted at
		// (a tool between the cell and its section): the ONE chain the path ends
		const deep_x = {caller_chain:'OUTER>X'}
		assert.strictEqual(select_by_caller_chain([z, deep_x], ['X']), deep_x)
	})

	it(`server split + absorbed chain: the third parent's cell takes ITS entry, not the first one`, async function() {
		// rsc1400-style key under Z (config B), X (config A) and Y (config A again):
		// the server ships Y its own copy of X's entry (NodeContextSet.absorb)
		const section	= fake('section', 'host', 'host')
		const parents	= ['Z', 'X', 'Y'].map(tipo => fake('component_portal', tipo, 'host', section))
		const datum = {
			context : [
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL, lang:'lg-cat', caller_chain:'Z'},
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL, lang:'lg-fra', caller_chain:'X'},
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL, lang:'lg-fra', caller_chain:'Y'}
			],
			data : []
		}
		const ddo_of = (parent) => ({parent, column_id:'col1', tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL})
		const row_y = await make_row(parents[2], {
			context		: {request_config:[{show:{ddo_map:[ddo_of('Y')]}}]},
			columns_map	: [{id:'col1'}],
			datum
		})
		const child_y = register_child(child_key_of(row_y, {model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', lang:'lg-fra', column_id:'col1'}))
		const built_y = await row_y.get_ar_columns_instances_list()
		assert.equal(built_y.length, 1)
		assert.strictEqual(built_y[0], child_y, 'the Y row must build from its own (X-config) entry, never Z\'s (lg-cat)')
	})

	it(`caller_chains_compatible: suffix-related chains are one occurrence, different parents are two`, function() {
		assert.equal(caller_chains_compatible(undefined, 'P1'), true)
		assert.equal(caller_chains_compatible('P1', undefined), true)
		assert.equal(caller_chains_compatible('P1', 'P1'), true)
		assert.equal(caller_chains_compatible('OUTER>P1', 'P1'), true)
		assert.equal(caller_chains_compatible('P1', 'OUTER>P1'), true)
		assert.equal(caller_chains_compatible('P1', 'P2'), false)
		assert.equal(caller_chains_compatible('OUTER>P1', 'OUTER>P2'), false)
	})

	it(`get_caller_chain_tipos: the component path above a row, outermost first`, function() {
		const section	= fake('section', 'host', 'host', null, {mode:'edit'})
		const group		= fake('section_group', 'g1', 'host', section, {type:'grouper'})
		const outer		= fake('component_portal', 'OUTER', 'host', group)
		const row1		= fake('section_record', 'OUTER', 'st_o', outer)
		const inner		= fake('component_portal', 'P1', 'st_o', row1)
		const row2		= fake('section_record', 'P1', 'st_n', inner)
		assert.deepEqual(get_caller_chain_tipos(row2), ['OUTER', 'P1'])
		const top_row = fake('section_record', 'host', 'host', section)
		assert.deepEqual(get_caller_chain_tipos(top_row), [], 'a section column is top level')
	})

	it(`list columns: two occurrences of one key — each row builds its OWN context and data`, async function() {

		const section	= fake('section', 'host', 'host')
		const p1		= fake('component_portal', 'P1', 'host', section)
		const p2		= fake('component_portal', 'P2', 'host', section)

		// one shared datum, the server's split: the same key under P1 and P2
		// (distinct langs make the chosen context observable in the child key)
		const datum = {
			context : [
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL, lang:'lg-eng', caller_chain:'P1'},
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL, lang:'lg-spa', caller_chain:'P2'}
			],
			data : [
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', section_id:5, caller_chain:'P1', entries:[{value:'under P1'}]},
				{tipo:N_TIPO, mode:'list', section_tipo:'st_n', section_id:5, caller_chain:'P2', entries:[{value:'under P2'}]}
			]
		}
		const ddo_of = (parent) => ({parent, column_id:'col1', tipo:N_TIPO, mode:'list', section_tipo:'st_n', model:N_MODEL})

		const row_p1 = await make_row(p1, {
			context		: {request_config:[{show:{ddo_map:[ddo_of('P1')]}}]},
			columns_map	: [{id:'col1'}],
			datum
		})
		const row_p2 = await make_row(p2, {
			context		: {request_config:[{show:{ddo_map:[ddo_of('P2')]}}]},
			columns_map	: [{id:'col1'}],
			datum
		})

		const child_p1 = register_child(child_key_of(row_p1, {model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', lang:'lg-eng', column_id:'col1'}))
		const child_p2 = register_child(child_key_of(row_p2, {model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', lang:'lg-spa', column_id:'col1'}))

		const built_p1 = await row_p1.get_ar_columns_instances_list()
		const built_p2 = await row_p2.get_ar_columns_instances_list()

		assert.equal(built_p1.length, 1)
		assert.strictEqual(built_p1[0], child_p1, 'the P1 row must build from the P1 context (first-wins would also give it, so see P2)')
		assert.equal(built_p2.length, 1)
		assert.strictEqual(built_p2[0], child_p2, 'the P2 row must build from the P2 context, not borrow P1\'s (first-wins)')

		// the data item pairs by the same key
		const ddo = {tipo:N_TIPO, mode:'list', model:N_MODEL}
		assert.equal(row_p1.get_component_data({ddo, section_tipo:'st_n', section_id:5}).entries[0].value, 'under P1')
		assert.equal(row_p2.get_component_data({ddo, section_tipo:'st_n', section_id:5}).entries[0].value, 'under P2')
	})

	it(`edit children: one entry per key, the occurrence of this row's grandparent`, async function() {

		// X → row → P and Y → row → P: the SAME direct parent tipo P, two grandparents
		const section	= fake('section', 'host', 'host', null, {mode:'edit'})
		const x			= fake('component_portal', 'X', 'host', section, {mode:'edit'})
		const x_row		= fake('section_record', 'X', 'st_p', x)
		const p_under_x	= fake('component_portal', 'P', 'st_p', x_row, {mode:'edit', section_id:2})
		const y			= fake('component_portal', 'Y', 'host', section, {mode:'edit'})
		const y_row		= fake('section_record', 'Y', 'st_p', y)
		const p_under_y	= fake('component_portal', 'P', 'st_p', y_row, {mode:'edit', section_id:3})

		const entry = (lang, chain) => ({tipo:N_TIPO, section_tipo:'st_n', parent:'P', type:'component', model:N_MODEL, mode:'edit', lang, caller_chain:chain})
		const datum = {
			context	: [entry('lg-eng', 'X>P'), entry('lg-spa', 'Y>P')],
			data	: []
		}

		const row_x = await make_row(p_under_x, {mode:'edit', datum})
		const row_y = await make_row(p_under_y, {mode:'edit', datum})

		const child_x = register_child(child_key_of(row_x, {model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', lang:'lg-eng', mode:'edit'}))
		const child_y = register_child(child_key_of(row_y, {model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', lang:'lg-spa', mode:'edit'}))

		const built_x = await row_x.get_ar_instances_edit()
		const built_y = await row_y.get_ar_instances_edit()

		assert.deepEqual(built_x, [child_x], 'under X: exactly one child, from the X>P entry (never both occurrences)')
		assert.deepEqual(built_y, [child_y], 'under Y: exactly one child, from the Y>P entry')
	})

	it(`edit children: an ABSORBED copy (parent says X, chain says Y) builds in the Y row`, async function() {

		// rsc1400-style key under Z (config B), X (config A), Y (config A): the
		// server ships Y a COPY of X's entry (node_contexts.ts #materialiseAbsorbed),
		// stamped parent Y since WC-2026-11-04-caller-chain-per-occurrence. This
		// hand-built copy keeps X's `parent` on purpose: the chain is authoritative,
		// so a stale `parent` must not misplace the cell
		const section	= fake('section', 'host', 'host', null, {mode:'edit'})
		const parents	= ['Z', 'X', 'Y'].map(tipo => fake('component_portal', tipo, 'host', section, {mode:'edit'}))
		const entry = (lang, parent, chain) => ({tipo:N_TIPO, section_tipo:'st_n', parent, type:'component', model:N_MODEL, mode:'edit', lang, caller_chain:chain})
		const datum = {
			context	: [entry('lg-cat', 'Z', 'Z'), entry('lg-fra', 'X', 'X'), entry('lg-fra', 'X', 'Y')],
			data	: []
		}
		const rows = await Promise.all(parents.map(parent => make_row(parent, {mode:'edit', datum})))
		const children = rows.map((row, i) => register_child(child_key_of(row, {
			model:N_MODEL, tipo:N_TIPO, section_tipo:'st_n', mode:'edit', lang: i===0 ? 'lg-cat' : 'lg-fra'
		})))

		const built = await Promise.all(rows.map(row => row.get_ar_instances_edit()))
		assert.deepEqual(built[0], [children[0]], 'Z row: its own entry')
		assert.deepEqual(built[1], [children[1]], 'X row: its own entry (exactly one)')
		assert.deepEqual(built[2], [children[2]], 'Y row: the absorbed copy (parent X) must build — the cell was missing')
	})

	it(`root_caller_chains: chains of a nested read are matched EXACTLY on the page path (repeated tipo)`, function() {

		// a self-portal A under A: the nested portal's OWN page-2 read is rooted at
		// it — its entry '', its rows' cells 'A', an inner A's cells 'A>A'
		const section	= fake('section', 'host', 'host')
		const outer		= fake('component_portal', 'A', 'host', section)
		const outer_row	= fake('section_record', 'A', 'host', outer)
		const nested	= fake('component_portal', 'A', 'host', outer_row)
		const nested_row = fake('section_record', 'A', 'host', nested)
		assert.deepEqual(get_caller_chain_tipos(nested), ['A'])
		assert.deepEqual(get_caller_chain_tipos(nested_row), ['A', 'A'])

		const own		= {tipo:'A', caller_chain:''}
		const own_cells	= {tipo:'c', caller_chain:'A'}
		const inner_cells = {tipo:'c', caller_chain:'A>A'}
		const portal_child = {tipo:'A', caller_chain:'A'}
		const datum = {context:[own, portal_child, own_cells, inner_cells], data:[]}
		assert.strictEqual(root_caller_chains(datum, nested), datum)

		// tagged with the reader's path (non-enumerable: never back on the wire)
		assert.equal(own.caller_root, 'A')
		assert.equal(Object.keys(own).includes('caller_root'), false)
		assert.equal(JSON.stringify(own).includes('caller_root'), false)

		// the nested portal's OWN entry ('' rooted at [A] = [A]), not its child occurrence
		assert.strictEqual(select_by_caller_chain([own, portal_child], get_caller_chain_tipos(nested)), own,
			'the suffix guess took the child occurrence (A) for the portal itself')
		// its rows' cells: 'A' rooted at [A] = [A, A] — never the inner occurrence
		assert.strictEqual(select_by_caller_chain([own_cells, inner_cells], get_caller_chain_tipos(nested_row)), own_cells,
			'the longest suffix took the INNER parent\'s config')

		// the same cells from the SECTION's read (root ''): 'A>A' is [A, A]
		const section_cells	= {tipo:'c', caller_chain:'A>A'}
		const section_outer	= {tipo:'c', caller_chain:'A'}
		root_caller_chains({context:[section_cells, section_outer]}, section)
		assert.equal(section_cells.caller_root, '')
		assert.strictEqual(select_by_caller_chain([section_outer, section_cells], ['A', 'A']), section_cells)
		assert.strictEqual(select_by_caller_chain([section_outer, section_cells], ['A']), section_outer)

		// idempotent: a later reader never re-roots an item
		root_caller_chains({context:[own]}, section)
		assert.equal(own.caller_root, 'A')

		// the merge identity: one occurrence seen from two roots, a repeated tipo two
		assert.equal(caller_chains_compatible('A>A', 'A', '', 'A'), true, 'section-rooted A>A = nested-rooted A')
		assert.equal(caller_chains_compatible('A', 'A', '', 'A'), false, '[A] and [A, A] are two occurrences')
	})

	it(`update_datum keeps two occurrences apart and updates the matching one in place`, async function() {

		const item = (chain, value) => ({tipo:N_TIPO, section_tipo:'st_n', section_id:5, mode:'list', caller_chain:chain, entries:[{value}]})
		const ctx = (chain) => ({tipo:N_TIPO, section_tipo:'st_n', mode:'list', lang:'lg-eng', caller_chain:chain})
		const p1_item = item('OUTER>P1', 'old P1')
		const self = {
			tipo: 'P1', section_tipo:'host', section_id:1, mode:'list', data:{},
			datum: {data:[p1_item], context:[ctx('OUTER>P1')]}
		}

		// a P2 occurrence of the same key is NEW (not an overwrite of P1's)
		await component_common.prototype.update_datum.call(self, {data:[item('P2', 'P2 value')], context:[ctx('P2')]})
		assert.equal(self.datum.data.length, 2, 'the P2 item was merged INTO the P1 one')
		assert.equal(p1_item.entries[0].value, 'old P1', 'the P1 item was overwritten by another occurrence')
		assert.equal(self.datum.context.length, 2, 'the P2 context was deduped into the P1 one')

		// the P1 occurrence seen from a response rooted lower ('P1') is the SAME one
		await component_common.prototype.update_datum.call(self, {data:[item('P1', 'new P1')], context:[ctx('P1')]})
		assert.equal(self.datum.data.length, 2, 'a compatible chain must update in place, not append')
		assert.equal(p1_item.entries[0].value, 'new P1')
		assert.equal(self.datum.context.length, 2)

		// unstamped items keep the previous identity (match regardless of chain)
		await component_common.prototype.update_datum.call(self, {data:[Object.assign(item('x', 'all'), {caller_chain:undefined})], context:[]})
		assert.equal(self.datum.data.length, 2)
	})

	it(`update_datum: a split that first shows up in a LATER read is not swallowed by the unstamped entry`, async function() {

		// the section read shipped K UNSTAMPED (one occurrence then); P's page 2
		// (rooted at P) ships K split as 'P' and 'P>Q' (node_contexts.ts stamps a
		// key only when it splits within ONE response)
		const section	= fake('section', 'host', 'host')
		const p			= fake('component_portal', 'P', 'host', section)
		const ctx = (chain, marker) => Object.assign(
			{tipo:N_TIPO, section_tipo:'st_n', mode:'list', lang:'lg-eng', model:N_MODEL, marker},
			chain===undefined ? {} : {caller_chain:chain}
		)
		const item = (chain, value) => Object.assign(
			{tipo:N_TIPO, section_tipo:'st_n', section_id:5, mode:'list', entries:[{value}]},
			chain===undefined ? {} : {caller_chain:chain}
		)
		const stale_ctx		= ctx(undefined, 'stale')
		const stale_item	= item(undefined, 'stale')
		const datum = {context:[stale_ctx], data:[stale_item]}
		Object.assign(p, {data:{}, datum})

		await component_common.prototype.update_datum.call(p, {
			context	: [ctx('P', 'own P'), ctx('P>Q', 'under Q')],
			data	: [item('P', 'under P'), item('P>Q', 'under P>Q')]
		})

		const markers = datum.context.map(el => el.marker)
		assert.deepEqual(markers, ['stale', 'own P', 'under Q'], 'both stamped context entries must land beside the unstamped one')
		assert.deepEqual(datum.data.map(el => el.entries[0].value), ['stale', 'under P', 'under P>Q'],
			'both stamped data items must land, the unstamped one untouched')

		// a row under [P, Q] builds from the P>Q occurrence (context and data)
		const p_row		= fake('section_record', 'P', 'host', p)
		const q			= fake('component_portal', 'Q', 'st_q', p_row)
		const q_row		= await make_row(q, {datum})
		assert.deepEqual(get_caller_chain_tipos(q_row), ['P', 'Q'])
		assert.equal(select_by_caller_chain(datum.context, () => get_caller_chain_tipos(q_row)).marker, 'under Q')
		assert.equal(select_by_caller_chain(datum.context, ['P']).marker, 'own P')
		const ddo = {tipo:N_TIPO, mode:'list', model:N_MODEL}
		assert.equal(q_row.get_component_data({ddo, section_tipo:'st_n', section_id:5}).entries[0].value, 'under P>Q')

		// an UNSTAMPED incoming item keeps the pre-(b) identity: updates in place
		await component_common.prototype.update_datum.call(p, {context:[ctx(undefined, 'again')], data:[]})
		assert.equal(datum.context.length, 3, 'an unstamped entry must dedupe, not append')
	})
})



// ---------------------------------------------------------------- (a) + E11, pure helpers

describe(`NESTED PORTAL — add_show / fixed_filter helpers`, async () => {

	it(`sends_own_show: an injected (nested or section-injected) get_data in a cell mode only`, function() {
		const section	= fake('section', 'test3', 'test3', null, {mode:'edit'})
		const outer		= fake('component_portal', 'test80', 'test3', section, {mode:'edit'})
		const row		= fake('section_record', 'test80', 'test3', outer)
		const nested	= fake('component_portal', 'test80', 'test3', row, {mode:'list'})
		assert.equal(sends_own_show(nested, 'get_data'), true)
		assert.equal(sends_own_show(outer, 'get_data'), false, 'a top-level portal its section does not inject into resolves its own config')
		// a top-level portal whose SECTION map declares its children: injected too
		section.request_config_object = {api_engine:'dedalo', type:'main', show:{ddo_map:[
			{tipo:'test80', section_tipo:'test3', parent:'test3'},
			{tipo:'test211', section_tipo:'test3', parent:'test80'}
		]}}
		assert.equal(sends_own_show(outer, 'get_data'), true, 'a section-injected top-level portal must send its show (decision (a))')
		// a show map never travels without its verifying chain: a virtual-section
		// mismatch (no root the server can derive) sends none
		const virtual_section	= Object.assign({}, section, {section_tipo:'test999'})
		const virtual_outer		= fake('component_portal', 'test80', 'test3', virtual_section, {mode:'edit'})
		assert.equal(sends_own_show(virtual_outer, 'get_data'), false, 'no chain → no show')
		assert.equal(sends_own_show(nested, 'resolve_data'), false, 'search mode sends the entries, not a map')
		assert.equal(sends_own_show(Object.assign({}, nested, {mode:'search'}), 'get_data'), false, 'only an edit / list cell sends a map')
		assert.equal(sends_own_show(Object.assign({}, nested, {model:'component_dataframe'}), 'get_data'), false)
	})

	it(`attach_show_maps: only the ddo_maps travel, cloned`, function() {
		const request_config_object = {
			show	: {ddo_map:[{tipo:'b', parent:'p'}, {tipo:'a', parent:'p'}], sqo_config:{limit:1e9}},
			search	: {ddo_map:[{tipo:'b', parent:'p'}]}
		}
		const rqo = attach_show_maps({show:request_config_object.show}, request_config_object)
		assert.deepEqual(rqo.show, {ddo_map:[{tipo:'b', parent:'p'}, {tipo:'a', parent:'p'}]}, 'no sqo_config on the wire')
		assert.deepEqual(rqo.search, {ddo_map:[{tipo:'b', parent:'p'}]})
		assert.notStrictEqual(rqo.show.ddo_map, request_config_object.show.ddo_map, 'the context map is never shared with the wire object')
		const without_search = attach_show_maps({}, {show:{ddo_map:[]}})
		assert.equal(Object.prototype.hasOwnProperty.call(without_search, 'search'), false)
	})

	it(`merge_fixed_filter_sqo: only the sqo is taken, per api_engine + type`, function() {
		const injected_show = {ddo_map:[{tipo:'b'}, {tipo:'a'}]}
		const context = {request_config:[
			{api_engine:'dedalo', type:'main', show:injected_show, hide:{ddo_map:[{tipo:'h'}]}, sqo:{section_tipo:['t'], limit:10}},
			{api_engine:'zenon', type:'main', show:{ddo_map:[{tipo:'z'}]}, sqo:{section_tipo:['zt']}}
		]}
		const fresh = [
			{api_engine:'dedalo', type:'main', show:{ddo_map:[{tipo:'a'}, {tipo:'b'}]}, sqo:{section_tipo:['t'], limit:10, fixed_filter:[{q:'fresh'}]}},
			{api_engine:'other', type:'main', sqo:{section_tipo:['o']}}
		]
		assert.equal(merge_fixed_filter_sqo(context, fresh), true)
		assert.strictEqual(context.request_config[0].show, injected_show, 'the injected show stays (E11)')
		assert.deepEqual(context.request_config[0].show.ddo_map.map(el => el.tipo), ['b', 'a'])
		assert.deepEqual(context.request_config[0].hide, {ddo_map:[{tipo:'h'}]}, 'hide stays')
		assert.deepEqual(context.request_config[0].sqo.fixed_filter, [{q:'fresh'}])
		assert.notStrictEqual(context.request_config[0].sqo, fresh[0].sqo, 'the fresh sqo is cloned in')
		assert.deepEqual(context.request_config[1].sqo, {section_tipo:['zt']}, 'another engine is untouched')
		assert.equal(context.request_config.length, 2, 'an engine the context lacks is not added')
	})
})



// ---------------------------------------------------------------- (a) + E11 on the suite server

	const HOST_SECTION	= 'test3'
	const PORTAL_TIPO	= 'test80'	// generic self-portal test3 → test3, own show [test52]
	const TEXT_TIPO		= 'test52'	// component_input_text (the own column)
	const NUMBER_TIPO	= 'test211'	// component_number (the column only the "caller" declares)
	const PAGE_LIMIT	= 2
	// the REAL caller (runner-installed situation, src/core/test_data/nested_portal_fixture.ts):
	// a portal of a scratch section whose map declares test80 → [test211, test52]
	const NESTING_SECTION	= 'zzcnp1'
	const NESTING_PORTAL	= 'zzcnp2'
	const VERIFIED_CHAIN	= [{tipo:NESTING_PORTAL, section_tipo:NESTING_SECTION, mode:'edit'}]
	// a chain the server REFUSES: test80's own map does not declare test80 (caller_chain.ts step 3)
	const FORGED_CHAIN		= [{tipo:PORTAL_TIPO, section_tipo:HOST_SECTION, mode:'edit'}]

	const container = document.getElementById('content')
	const test_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container nested_portal',
		parent			: container
	})

	const api = async (body) => {
		const api_response = await data_manager.request({body})
		if (request_failed(api_response)) {
			throw new Error(`test_nested_portal: ${body.action} refused: ${api_response.error.code}`)
		}
		return response_data(api_response)
	}

	const section_source = (section_tipo, section_id=null) => ({
		typo			: 'source',
		type			: 'section',
		model			: 'section',
		tipo			: section_tipo,
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: 'edit',
		lang			: page_globals?.dedalo_data_lang ?? 'lg-eng'
	})

	const create_record = async (section_tipo) => {
		const section_id = Number(await api({action:'create', source:section_source(section_tipo)}))
		if (!Number.isInteger(section_id) || section_id < 1) {
			throw new Error(`test_nested_portal: create returned no section_id for ${section_tipo}`)
		}
		return section_id
	}

	const delete_record = (section_tipo, section_id) => api({
		action	: 'delete',
		source	: Object.assign(section_source(section_tipo, section_id), {delete_mode:'delete_record'})
	})

	const count_records = async (section_tipo, section_ids) => {
		const answer = await api({
			action			: 'count',
			prevent_lock	: true,
			source			: section_source(section_tipo),
			sqo				: {
				section_tipo		: [section_tipo],
				filter_by_locators	: section_ids.map(section_id => ({section_tipo, section_id:String(section_id)}))
			}
		})
		const total = Number(answer?.total)
		if (!Number.isInteger(total)) {
			throw new Error(`test_nested_portal: count answered no total for ${section_tipo}`)
		}
		return total
	}

	let variant_seq	= 0
	let host_id		= null
	const record_ids = []

	// a top-level test80 on the host record (own config); `caller` = its section
	// instance when the case judges what a section-hosted portal sends
	const build_top_portal = async (caller=null) => {
		const instance = await get_instance(Object.assign({
			model			: 'component_portal',
			tipo			: PORTAL_TIPO,
			section_tipo	: HOST_SECTION,
			section_id		: host_id,
			mode			: 'edit',
			view			: 'default',
			id_variant		: `nested_portal_top_${++variant_seq}`
		}, caller ? {caller} : {}))
		await instance.build(true)
		return instance
	}

	// the host SECTION as a top-level portal's caller: section-shaped, carrying
	// the server's OWN test3 edit context (get_element_context) — the map
	// section_injects_children reads
	const host_section_caller = async () => {
		const answer = await api({
			action			: 'get_element_context',
			prevent_lock	: true,
			source			: {
				model			: 'section',
				tipo			: HOST_SECTION,
				section_tipo	: HOST_SECTION,
				mode			: 'edit'
			}
		})
		const context = (Array.isArray(answer) ? answer : [answer]).find(el => el && el.tipo===HOST_SECTION)
		if (!context) {
			throw new Error(`test_nested_portal: get_element_context served no ${HOST_SECTION} context`)
		}
		return {
			model			: 'section',
			type			: 'section',
			tipo			: HOST_SECTION,
			section_tipo	: HOST_SECTION,
			section_id		: host_id,
			mode			: 'edit',
			context			: context,
			caller			: null
		}
	}

	// set a test211 value on a record (the engine's own save door)
	const set_number = async (section_id, value) => {
		const instance = await get_instance({
			model			: 'component_number',
			tipo			: NUMBER_TIPO,
			section_tipo	: HOST_SECTION,
			section_id		: section_id,
			mode			: 'edit',
			lang			: page_globals?.dedalo_data_nolan ?? 'lg-nolan',
			id_variant		: `nested_portal_number_${++variant_seq}`
		})
		await instance.build(true)
		await instance.change_value({
			changed_data	: [Object.freeze({action:'insert', id:null, value:{id:1, value}})],
			refresh			: false
		})
		await instance.destroy(true, true, true)
	}

	// the INJECTED context: the server's own test80 context with the show map a
	// caller would declare for it — [test211, test52], the portal's own map being [test52]
	const injected_context_of = (own_context) => {
		const context	= JSON.parse(JSON.stringify(own_context))
		const main		= context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
		const text_ddo	= main.show.ddo_map.find(el => el.tipo===TEXT_TIPO && el.parent===PORTAL_TIPO)
		if (!text_ddo) {
			throw new Error(`test_nested_portal: the own ${PORTAL_TIPO} context has no ${TEXT_TIPO} column`)
		}
		const number_ddo = Object.assign({}, text_ddo, {tipo:NUMBER_TIPO, model:'component_number', label:NUMBER_TIPO})
		delete number_ddo.column_id
		delete text_ddo.column_id
		main.show.ddo_map = [number_ddo, text_ddo]
		main.sqo.limit = PAGE_LIMIT
		delete context.columns_map
		return context
	}

	// a NESTED test80 under the REAL nesting portal (+ its row): the injected
	// context handed down, as the outer portal's own render would hand it
	const build_nested_portal = async (own_context) => {
		const section	= {model:'section', type:'section', tipo:NESTING_SECTION, section_tipo:NESTING_SECTION, mode:'edit'}
		const outer		= {model:'component_portal', type:'component', tipo:NESTING_PORTAL, section_tipo:NESTING_SECTION, section_id:1, mode:'edit', permissions:2, caller:section}
		const row		= {model:'section_record', type:'section_record', tipo:NESTING_PORTAL, section_tipo:HOST_SECTION, section_id:host_id, mode:'edit', permissions:2, caller:outer}
		const context	= injected_context_of(own_context)
		const instance	= await get_instance({
			model			: 'component_portal',
			tipo			: PORTAL_TIPO,
			section_tipo	: HOST_SECTION,
			section_id		: host_id,
			mode			: 'edit',
			view			: 'default',
			lang			: context.lang,
			id_variant		: `nested_portal_nested_${++variant_seq}`,
			context			: context,
			request_config	: context.request_config,
			caller			: row
		})
		await instance.build(true)
		const node = await instance.render()
		test_container.appendChild(node)
		return instance
	}

	// a data_manager.request spy recording every read of the portal; `graft(answer)` may edit an answer
	const spy_reads = (graft=null) => {
		const original = data_manager.request
		const spy = {reads:[]}
		data_manager.request = async (options) => {
			const body = options?.body
			const answer = await original.call(data_manager, options)
			if (body?.source?.tipo===PORTAL_TIPO && body?.sqo) {
				spy.reads.push(JSON.parse(JSON.stringify(body)))
				if (graft) {
					graft(answer)
				}
			}
			return answer
		}
		spy.restore = () => { data_manager.request = original }
		return spy
	}

	const main_show_tipos = (instance) => instance.context.request_config
		.find(el => el.api_engine==='dedalo' && el.type==='main')
		.show.ddo_map.filter(el => el.parent===PORTAL_TIPO).map(el => el.tipo)

	const component_column_ids = (instance) => (instance.columns_map || [])
		.map(el => el.id)
		.filter(id => id===NUMBER_TIPO || id===TEXT_TIPO)

	// the content rows (section_record nodes) of the portal's current page
	const rows_of = (instance) => {
		const content = instance.node.list_body?.querySelector('.content_data') || instance.node.content_data || instance.node.querySelector('.content_data')
		return [...content.querySelectorAll(':scope > .section_record')]
	}
	const row_column_ids = (row) => [...row.querySelectorAll('.column')]
		.map(node => node.column_id)
		.filter(id => id===NUMBER_TIPO || id===TEXT_TIPO)

	const number_item_of = (instance, section_id) => instance.datum.data.find(el =>
		el.tipo===NUMBER_TIPO && String(el.section_id)===String(section_id) && el.section_tipo===HOST_SECTION
	)



describe(`NESTED PORTAL — consistent paging (a) on the suite server`, function() {

	this.timeout(120000)

	let own_context = null

	before(async () => {
		host_id = await create_record(HOST_SECTION)
		for (let i = 0; i < 3; i++) {
			record_ids.push(await create_record(HOST_SECTION))
		}
		await set_number(record_ids[0], 101)
		await set_number(record_ids[2], 303)
		const top = await build_top_portal()
		try {
			const outcome = await top.link_records(record_ids.map(section_id => ({section_tipo:HOST_SECTION, section_id})))
			if (outcome.linked.length!==record_ids.length) {
				throw new Error(`test_nested_portal: linked ${outcome.linked.length} of ${record_ids.length} records`)
			}
			own_context = JSON.parse(JSON.stringify(top.context))
		} finally {
			await top.destroy(true, true, true)
		}
	})

	after(async () => {
		const top = await build_top_portal()
		await top.change_value({
			changed_data	: [Object.freeze({action:'set_data', id:null, value:null})],
			refresh			: false
		})
		await top.destroy(true, true, true)
		for (const section_id of record_ids) {
			await delete_record(HOST_SECTION, section_id)
		}
		if (host_id) {
			await delete_record(HOST_SECTION, host_id)
		}
		test_container.innerHTML = ''
		const ids = [...record_ids, ...(host_id ? [host_id] : [])]
		assert.equal(await count_records(HOST_SECTION, ids), 0, `scratch records left in ${HOST_SECTION}`)
	})

	it(`precondition: the portal's OWN map has no ${NUMBER_TIPO}, and a top-level read under the REAL ${HOST_SECTION} section sends no show`, async () => {
		// the section caller carries the server's own test3 EDIT context: whether
		// its map injects test80's children (section_injects_children) is the real
		// answer, not a caller-less shortcut
		const section = await host_section_caller()
		assert.ok(
			Array.isArray(section.context?.request_config) && section.context.request_config.some(el => el.api_engine==='dedalo' && el.type==='main'),
			`the ${HOST_SECTION} edit context has no main request_config — the precondition would be vacuous`
		)
		assert.equal(section_injects_children(section, PORTAL_TIPO), false,
			`the ${HOST_SECTION} edit map declares ${PORTAL_TIPO} children — a top-level ${PORTAL_TIPO} is injected there, and this gate's baseline is gone`)
		const spy = spy_reads()
		try {
			const top = await build_top_portal(section)
			try {
				assert.strictEqual(top.caller, section, 'the portal was not built under the section')
				assert.deepEqual(main_show_tipos(top), [TEXT_TIPO], `test80's own show changed — this gate's discrimination rests on it`)
				assert.ok(spy.reads.length > 0, 'the top-level build sent no read')
				for (const read of spy.reads) {
					assert.equal(read.show, undefined, 'a top-level portal must not send a show map')
					assert.equal(read.source.callers, undefined, 'a top-level portal has no caller chain')
				}
			} finally {
				await top.destroy(true, true, true)
			}
		} finally {
			spy.restore()
		}
	})

	it(`page 1 → page 2 → refresh: the injected columns and order hold, and an empty value keeps its column`, async () => {
		const spy = spy_reads()
		let instance = null
		try {
			instance = await build_nested_portal(own_context)

			// page 1: the read carried the injected show + the caller chain
				const first = spy.reads[spy.reads.length - 1]
				assert.ok(first, 'the nested build sent no read')
				assert.deepEqual(first.show.ddo_map.map(el => el.tipo), [NUMBER_TIPO, TEXT_TIPO], 'page 1 must send the injected show, in order')
				// the chain names the real nesting portal (the server verifies it — header)
				assert.deepEqual(first.source.callers, VERIFIED_CHAIN)
				assert.equal(first.show.sqo_config, undefined, 'only the ddo_map travels')

			// columns: number | text, page 1 rows records[0] (value) and records[1] (NO value)
				assert.deepEqual(component_column_ids(instance), [NUMBER_TIPO, TEXT_TIPO])
				const page1_rows = rows_of(instance)
				assert.equal(page1_rows.length, PAGE_LIMIT)
				for (const row of page1_rows) {
					assert.deepEqual(row_column_ids(row), [NUMBER_TIPO, TEXT_TIPO], 'every page-1 row keeps both columns (an empty value renders an empty component)')
				}
				assert.ok(number_item_of(instance, record_ids[0]), `the server did not resolve the sent show (no ${NUMBER_TIPO} item for records[0])`)

			// page 2 (what the paginator does: offset, then navigate → refresh → build(true))
				await instance.navigate({
					callback : async () => {
						instance.rqo.sqo.offset = PAGE_LIMIT
					}
				})
				const second = spy.reads[spy.reads.length - 1]
				assert.notStrictEqual(second, first, 'page 2 sent no read')
				assert.equal(second.sqo.offset, PAGE_LIMIT)
				assert.deepEqual(second.show.ddo_map.map(el => el.tipo), [NUMBER_TIPO, TEXT_TIPO], 'page 2 must send the injected show')
				assert.deepEqual(second.source.callers, VERIFIED_CHAIN, 'page 2 must name the caller chain')
				assert.deepEqual(main_show_tipos(instance), [NUMBER_TIPO, TEXT_TIPO], 'the context is write-once')
				assert.deepEqual(component_column_ids(instance), [NUMBER_TIPO, TEXT_TIPO], 'the columns did not hold on page 2')
				const page2_rows = rows_of(instance)
				assert.equal(page2_rows.length, 1, 'page 2 holds records[2] alone')
				assert.deepEqual(row_column_ids(page2_rows[0]), [NUMBER_TIPO, TEXT_TIPO])
				const page2_number = number_item_of(instance, record_ids[2])
				assert.ok(page2_number, `page 2 came back without ${NUMBER_TIPO}: the server did not honour the sent show and resolved the portal's OWN map (membership lost)`)
				assert.equal(page2_number.entries?.[0]?.value, 303)

			// refresh (no offset change)
				const reads_before_refresh = spy.reads.length
				await instance.refresh({destroy:false})
				assert.ok(spy.reads.length > reads_before_refresh, 'the refresh sent no read')
				const third = spy.reads[spy.reads.length - 1]
				assert.notStrictEqual(third, second, 'the refresh sent no read')
				assert.deepEqual(third.show.ddo_map.map(el => el.tipo), [NUMBER_TIPO, TEXT_TIPO], 'the refresh must send the injected show')
				assert.deepEqual(third.source.callers, VERIFIED_CHAIN, 'the refresh must name the caller chain')
				assert.deepEqual(component_column_ids(instance), [NUMBER_TIPO, TEXT_TIPO], 'the columns did not hold on refresh')
				assert.deepEqual(row_column_ids(rows_of(instance)[0]), [NUMBER_TIPO, TEXT_TIPO])
		} finally {
			spy.restore()
			if (instance) {
				await instance.destroy(true, true, true)
			}
		}
	})

	it(`the VERIFIED chain alone resolves the injected columns on page 2 (no show sent); a forged chain does not`, async () => {
		const spy = spy_reads()
		let instance = null
		let page1 = null
		try {
			instance = await build_nested_portal(own_context)
			page1 = spy.reads[spy.reads.length - 1]
		} finally {
			spy.restore()
			if (instance) {
				await instance.destroy(true, true, true)
			}
		}
		assert.ok(page1, 'the nested build sent no read')
		assert.deepEqual(page1.source.callers, VERIFIED_CHAIN, 'precondition: the build named the real chain')

		// page 2 as the bare chain claim: the client's show removed, so test211
		// can only come back from the caller the server re-derived
		const page2_with = async (callers) => {
			const body = JSON.parse(JSON.stringify(page1))
			delete body.show
			delete body.search
			body.source.callers = callers
			body.sqo.offset = PAGE_LIMIT
			body.sqo.limit = PAGE_LIMIT
			const answer = await api(body)
			return (answer?.data || []).find(el =>
				el.tipo===NUMBER_TIPO && el.section_tipo===HOST_SECTION && String(el.section_id)===String(record_ids[2])
			)
		}
		const verified = await page2_with(VERIFIED_CHAIN)
		assert.ok(verified, `a verified chain resolved no ${NUMBER_TIPO} on page 2 — the server did not take the nesting portal's declared children`)
		assert.equal(verified.entries?.[0]?.value, 303)
		const forged = await page2_with(FORGED_CHAIN)
		assert.equal(forged, undefined, `a forged chain must resolve test80's OWN map (no ${NUMBER_TIPO}) — the server trusted an unverified claim`)
	})

	it(`a fixed_filter refresh merges only the sqo — the injected show stays (E11)`, async () => {
		let instance = null
		let spy = null
		try {
			instance = await build_nested_portal(own_context)
			const marker = [{q:'nested_portal_fixed_filter_marker'}]

			// graft: the refreshed answer's test80 context carries a fixed_filter AND the
			// portal's OWN-order show — the old code replaced the whole request_config
			spy = spy_reads((answer) => {
				const context = response_data(answer)?.context || []
				for (const entry of context) {
					if (entry.tipo!==PORTAL_TIPO || entry.section_tipo!==HOST_SECTION) {
						continue
					}
					for (const item of entry.request_config || []) {
						if (item.api_engine==='dedalo' && item.type==='main') {
							item.sqo = Object.assign({}, item.sqo, {fixed_filter:marker})
							item.show = {ddo_map:[{tipo:TEXT_TIPO, parent:PORTAL_TIPO, section_tipo:HOST_SECTION, mode:'list', model:'component_input_text'}]}
						}
					}
				}
			})

			await instance.refresh({destroy:false})
			assert.ok(spy.reads.length > 0, 'the refresh sent no read')
			const main = instance.context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
			assert.deepEqual(main.sqo.fixed_filter, marker, 'the fresh fixed_filter sqo was not taken')
			assert.deepEqual(main_show_tipos(instance), [NUMBER_TIPO, TEXT_TIPO], 'the refresh replaced the injected show (E11 regression)')
			assert.deepEqual(component_column_ids(instance), [NUMBER_TIPO, TEXT_TIPO])
		} finally {
			if (spy) {
				spy.restore()
			}
			if (instance) {
				await instance.destroy(true, true, true)
			}
		}
	})

	it(`a refresh never gets back the client's stale fixed_filter: the answer's sqo is the server's own`, async () => {
		let instance = null
		let spy = null
		try {
			instance = await build_nested_portal(own_context)
			const stale = [{$and:[{q:'nested_portal_stale_fixed_filter'}]}]
			// the rqo a refresh re-sends carries what the context held — here a
			// fixed_filter expanded on an "earlier read"
			instance.rqo.sqo.fixed_filter = stale
			const answers = []
			spy = spy_reads((answer) => {
				answers.push(JSON.parse(JSON.stringify(response_data(answer)?.context || [])))
			})
			await instance.refresh({destroy:false})
			const read = spy.reads[spy.reads.length - 1]
			assert.ok(read, 'the refresh sent no read')
			assert.deepEqual(read.sqo.fixed_filter, stale, 'precondition: the stale filter travelled')
			assert.ok(read.show, 'precondition: the refresh sent the show (stage 1 applies)')
			const entry = answers[answers.length - 1]?.find(el => el.tipo===PORTAL_TIPO && el.section_tipo===HOST_SECTION)
			assert.ok(entry, 'the answer has no test80 context')
			const main = entry.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
			assert.ok(!JSON.stringify(main.sqo || {}).includes('nested_portal_stale_fixed_filter'), 'the server echoed the client\'s stale fixed_filter back (it must answer its own sqo)')
			assert.deepEqual(main.show.ddo_map.filter(el => el.parent===PORTAL_TIPO).map(el => el.tipo), [NUMBER_TIPO, TEXT_TIPO], 'the sent show still governs')
		} finally {
			if (spy) {
				spy.restore()
			}
			if (instance) {
				await instance.destroy(true, true, true)
			}
		}
	})
})



// @license-end
