// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';

import {
	section_tipo,
	section_id,
	lang
} from './elements.js'
import {get_instance, get_instance_by_id} from '../../../core/common/js/instances.js'
import {
	service_autocomplete,
	is_full_list_selection
} from '../../../core/services/service_autocomplete/js/service_autocomplete.js'
import {
	render_datalist,
	execute_search_render,
	render_search_notice,
	run_search
} from '../../../core/services/service_autocomplete/js/view_default_autocomplete.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {response_data} from '../../../core/common/js/api_error.js'
import {common} from '../../../core/common/js/common.js'
import {
	SEARCH_PATHS_OWNER,
	show_ddo_map,
	search_paths,
	expected_filter_paths,
	relation_leaf_path
} from './search_paths_fixture.js'
import {open_css_frame} from './css_fixture_frame.js'



describe("SERVICE_AUTOCOMPLETE", function() {

	this.timeout(30000)



	// ───────────────────────────────────────────────────────────
	// HIGH-SEVERITY #1 — instance registry leak on re-render
	// render_datalist must destroy the previous batch of section_record
	// instances (unique timestamp id_variant ⇒ never reused) instead of
	// dropping them, which would leave them forever in the global registry.
	// ───────────────────────────────────────────────────────────

	describe("render_datalist cleans up the previous instance batch", function() {

		it("destroys prior ar_instances and removes them from the registry", async function() {

			// create two real instances registered in the global instances_map
			const make = async (suffix) => get_instance({
				model			: 'component_input_text',
				tipo			: 'test52',
				section_tipo	: section_tipo,
				section_id		: section_id,
				mode			: 'list',
				lang			: lang,
				id_variant		: 'sa_leak_' + suffix
			})
			const i1 = await make('a')
			const i2 = await make('b')
			const id1 = i1.id
			const id2 = i2.id

			// sanity: both are in the registry
			assert.notEqual(get_instance_by_id(id1), null, 'precondition: i1 registered')
			assert.notEqual(get_instance_by_id(id2), null, 'precondition: i2 registered')

			// minimal service-like object holding the previous batch
			const self = {
				datalist		: document.createElement('ul'),
				ar_instances	: [i1, i2]
			}

			try {
				// empty result ⇒ render returns early, but the previous batch must
				// still be destroyed before the early-return
				await render_datalist(self, { data: [] })

				assert.equal(self.ar_instances.length, 0, 'ar_instances must be emptied')
				assert.equal(get_instance_by_id(id1), null, 'prior instance i1 must be removed from registry')
				assert.equal(get_instance_by_id(id2), null, 'prior instance i2 must be removed from registry')
			} finally {
				// safety net: if the fix is not in place, destroy survivors so the
				// registry is not polluted for other suites
				if (get_instance_by_id(id1)) { await i1.destroy(true, true, true) }
				if (get_instance_by_id(id2)) { await i2.destroy(true, true, true) }
			}
		})
	})//end describe render_datalist cleanup



	// ───────────────────────────────────────────────────────────
	// HIGH-SEVERITY #1b — the open list must never be a band of EMPTY rows
	// The old render_datalist appended every <li> immediately and filled it in a
	// .then(); it resolved while all rows were still empty, so a slow record
	// render painted a tall blank dropdown over the form (the "results out of
	// layout" report). The function must resolve with every appended row already
	// rendered, in result order.
	// ───────────────────────────────────────────────────────────

	describe("render_datalist appends a row only when its record is rendered", function() {

		it("returns with every row complete (no empty placeholder band)", async function() {

			let portal	= null
			let service	= null
			try {
				// real suite portal (test80): its request_config targets test3 and
				// carries test52, whose records contain the searched word.
				portal = await get_instance({
					model			: 'component_portal',
					tipo			: 'test80',
					section_tipo	: section_tipo,
					section_id		: 2,
					mode			: 'edit',
					lang			: lang,
					id_variant		: 'sa_rows_portal_' + Math.random()
				})
				await portal.build(true)

				service = await get_instance({
					model			: 'service_autocomplete',
					caller			: portal,
					tipo			: 'test80',
					section_tipo	: section_tipo,
					request_config	: portal.context.request_config,
					id_variant		: 'sa_rows_service_' + Math.random()
				})
				assert.equal(await service.build(), true, 'precondition: the service builds from the portal request_config')

				service.operator = '$or'
				service.ar_search_section_tipo = [section_tipo]
				service.rqo_search.sqo.section_tipo = [section_tipo]
				for (const clause of Object.values(service.rqo_search.sqo_options.filter_free).flat()) {
					clause.q = 'one' // test3 test52 = 'input text content of one'
				}
				service.search_cache = new Map()

				await service.render()
				const response = await service.autocomplete_search()
				assert.equal(response.ok, true, 'precondition: the suite search answers')

				const data = response_data(response)
				await render_datalist(service, data)

				const rows = [...service.datalist.querySelectorAll('.autocomplete_data_li')]
				assert.ok(rows.length > 0, 'the search must return rows')
				for (const li of rows) {
					assert.equal(li.children.length, 1, 'a row carries exactly its section_record')
					assert.ok(li.querySelector('.section_record'), 'and that section_record is already rendered')
				}

				// order is the API's order, not the render resolution order
				const entries = data.data.find(el => el.typo==='sections').entries
				assert.deepEqual(
					rows.map(li => li.title),
					entries.map(entry => ' [' + entry.section_tipo + '-' + entry.section_id + ']'),
					'rows keep the result order'
				)

				// a superseded render must not append its rows over the newer list
				await Promise.all([
					render_datalist(service, data),
					render_datalist(service, data)
				])
				const after_superseded = service.datalist.querySelectorAll('.autocomplete_data_li')
				assert.equal(
					after_superseded.length,
					entries.length,
					'a superseded render must not append its rows'
				)
			} finally {
				if (service) {
					await service.destroy(true, true, true)
				}
				if (portal) {
					await portal.destroy(true, true, true)
				}
			}
		})
	})//end describe render_datalist complete rows



	// ───────────────────────────────────────────────────────────
	// HIGH-SEVERITY #2 — the external search must go through the ENGINE
	// (2026-08-06). external_engine used to be zenon_engine and issued a
	// cross-origin XHR at the DAI search endpoint from this browser: outside
	// every server-side control, impossible for an authenticated service, and
	// dead since the app CSP dropped third-party origins from connect-src.
	// It now calls dd_external_api::search through data_manager, and says
	// only WHO is asking and WHAT was typed.
	// ───────────────────────────────────────────────────────────

	describe("external_engine asks the Dédalo engine, never the service", function() {

		it("posts dd_external_api::search with the caller source and the typed q, and nothing else", async function() {

			const dirty_q = 'Smith & Co = 100%'

			const self = new service_autocomplete()
			self.tipo			= 'test61'
			self.section_tipo	= 'test3'
			self.limit			= 20
			self.rqo_search		= {
				sqo_options : {
					filter_free : { $and: [ { q: dirty_q } ] }
				}
			}

			// capture the request instead of sending it
			const real_request = data_manager.request
			let captured_body = null
			data_manager.request = async function(options) {
				captured_body = options.body
				return { ok : true, data : { data: [] } }
			}

			try {
				await self.external_engine()
			} finally {
				data_manager.request = real_request
			}

			assert.notEqual(captured_body, null, 'the request body must be captured')
			assert.equal(captured_body.dd_api, 'dd_external_api', 'the engine action must be the external API')
			assert.equal(captured_body.action, 'search')
			assert.equal(captured_body.source.tipo, 'test61', 'the CALLER component identifies the binding')
			assert.equal(captured_body.source.section_tipo, 'test3')
			// The query travels as data, so nothing has to be percent-encoded here:
			// the engine builds the remote URL (and encodes it) server-side.
			assert.equal(captured_body.options.q, dirty_q, 'the raw typed query is sent as data')

			// Nothing about WHERE to go may come from this browser.
			const serialized = JSON.stringify(captured_body)
			assert.equal(serialized.indexOf('http'), -1, 'no url may leave the browser')
			assert.equal(serialized.indexOf('lng'), -1, 'no remote language may leave the browser')
			assert.equal(serialized.indexOf('field'), -1, 'no remote field list may leave the browser')
		})

		it("refuses an empty query without any request, and says so", async function() {

			const self = new service_autocomplete()
			self.tipo			= 'test61'
			self.section_tipo	= 'test3'
			self.rqo_search		= {
				sqo_options : {
					filter_free : { $and: [ { q: '' } ] }
				}
			}

			const real_request = data_manager.request
			let called = 0
			data_manager.request = async function() {
				called++
				return { ok : true, data : { data: [] } }
			}

			let response
			try {
				response = await self.external_engine()
			} finally {
				data_manager.request = real_request
			}

			assert.equal(called, 0, 'an empty query must cost no round trip')
			assert.deepEqual(response_data(response).data, [], 'and it must answer with no rows')
			assert.equal(response.source_status.state, 'empty_query')
			assert.equal(response.source_status.label_key, 'external_search_empty_query',
				'the message must be a labels-catalog key, never prose')
		})

		it("zenon_engine stays a resolvable name, and IS external_engine", function() {
			// autocomplete_search resolves api_engine + '_engine'; an ontology may
			// carry api_engine:'zenon'. The name resolves — to the service-agnostic
			// engine, because nothing about Zenon is left in this client.
			assert.equal(
				service_autocomplete.prototype.zenon_engine,
				service_autocomplete.prototype.external_engine,
				'zenon_engine must be the external_engine alias'
			)
		})
	})//end describe external_engine



	// ───────────────────────────────────────────────────────────
	// HIGH-SEVERITY #2b — a failed search must be NAMED, not swallowed
	// The engine answers a dead / blocked / disabled source with a typed
	// source_status. Rendering only an empty datalist told the curator "no
	// matches" for every one of them.
	// ───────────────────────────────────────────────────────────

	describe("render_search_notice names why the datalist is empty", function() {

		it("renders the label key the server chose, with its state class", function() {

			const self = { datalist : document.createElement('ul') }

			// Envelope v2: a DEGRADED external search is a SUCCESS carrying the
			// typed `source_status` extension key and a coded `notices[]` entry —
			// the finer-grained token an operator quotes.
			const notice = render_search_notice(self, {
				ok				: true,
				data			: { data : [] },
				notices			: [{code: 'external_blocked_host', label_key: 'external_source_misconfigured', retryable: false}],
				source_status	: {
					service		: 'zenon',
					state		: 'misconfigured',
					label_key	: 'external_source_misconfigured',
					retryable	: false
				}
			})

			assert.notEqual(notice, null, 'a failed search must say something')
			assert.ok(notice.classList.contains('state_misconfigured'),
				'the state must be visible as a class, so states do not share a look')
			assert.ok(notice.textContent.length > 0, 'the notice must never be an empty box')
			assert.ok(notice.title.indexOf('external_blocked_host') !== -1,
				'the finer-grained error token must survive as diagnostics')
			assert.equal(self.datalist.querySelectorAll('.search_notice').length, 1)
		})

		it("names a failure with NO envelope too (a 4xx body never reaches us)", function() {

			const self = { datalist : document.createElement('ul') }

			const notice = render_search_notice(self, null)

			assert.notEqual(notice, null, 'a thrown search must still be named')
			assert.ok(notice.classList.contains('state_failed'))
		})

		it("says nothing on a plain successful search", function() {

			const self = { datalist : document.createElement('ul') }

			const notice = render_search_notice(self, { ok : true, data : { data : [] } })

			assert.equal(notice, null, 'a working search must not grow a permanent warning')
			assert.equal(self.datalist.querySelectorAll('.search_notice').length, 0)
		})
	})//end describe render_search_notice



	// ───────────────────────────────────────────────────────────
	// HIGH-SEVERITY #3 — a failed search leaves the widget stuck on "Searching.."
	// execute_search_render must clear the loading UI and never raise an
	// unhandled rejection when the underlying search throws.
	// ───────────────────────────────────────────────────────────

	describe("execute_search_render survives a rejected search", function() {

		it("clears the loading UI and does not throw when the search rejects", async function() {

			const datalist = document.createElement('ul')
			const loading_label = document.createElement('div')
			loading_label.className = 'loading_label'
			datalist.appendChild(loading_label)

			const search_input = document.createElement('input')
			search_input.classList.add('searching')

			const spinner = document.createElement('div')
			spinner.className = 'spinner'

			const self = {
				_search_seq	: 7,
				search_cache: new Map(),
				datalist	: datalist,
				autocomplete_search : async function() {
					throw new Error('simulated network failure')
				}
			}

			let threw = false
			try {
				await execute_search_render(self, {
					q				: 'abc',
					my_seq			: 7,
					loading_label	: loading_label,
					spinner			: spinner,
					search_input	: search_input
				})
			} catch (e) {
				threw = true
			}

			assert.equal(threw, false, 'execute_search_render must not throw on a failed search')
			assert.equal(loading_label.parentNode, null, 'loading_label must be removed (no stuck "Searching..")')
			assert.equal(search_input.classList.contains('searching'), false, 'searching class must be cleared')
		})
	})//end describe execute_search_render rejection



	// ───────────────────────────────────────────────────────────
	// MEDIUM #5 — rebuild_search_query_object must not lose filter groups
	// When self.operator is set, multiple filter_free operator groups collapse
	// onto the same operator key; the merge must keep ALL terms (not clobber
	// earlier groups), and only return null when nothing has a value.
	// ───────────────────────────────────────────────────────────

	describe("rebuild_search_query_object merges multiple operator groups", function() {

		it("keeps terms from every group when self.operator forces one operator", async function() {

			const self = new service_autocomplete()
			self.operator	= '$and'
			self.limit		= 10

			const rqo_search = {
				sqo			: {},
				sqo_options	: {
					fixed_filter	: false,
					filter_free		: {
						$or		: [ { q: 'alpha', path: [] } ],
						$and	: [ { q: 'beta',  path: [] } ]
					}
				}
			}

			const result = await self.rebuild_search_query_object({
				rqo_search		: rqo_search,
				search_sections	: ['sec1'],
				filter_by_list	: null
			})

			assert.notEqual(result, null, 'result must not be null when terms exist')
			const parse = result.sqo.filter.$and[0]
			assert.ok(parse && Array.isArray(parse.$and), 'terms must be merged under the forced $and operator')
			const qs = parse.$and.map(it => it.q)
			assert.ok(qs.includes('alpha'), 'first group term (alpha) must be preserved')
			assert.ok(qs.includes('beta'), 'second group term (beta) must be preserved')
		})

		it("returns null only when no group has a value", async function() {

			const self = new service_autocomplete()
			self.operator	= '$and'
			self.limit		= 10

			const rqo_search = {
				sqo			: {},
				sqo_options	: {
					fixed_filter	: false,
					filter_free		: {
						$or		: [ { q: '',    path: [] } ],
						$and	: [ { q: 'beta', path: [] } ]
					}
				}
			}

			const result = await self.rebuild_search_query_object({
				rqo_search		: rqo_search,
				search_sections	: ['sec1'],
				filter_by_list	: null
			})

			assert.notEqual(result, null, 'a non-empty group must not be discarded because another group is empty')
			const parse = result.sqo.filter.$and[0]
			const qs = parse.$and.map(it => it.q)
			assert.ok(qs.includes('beta'), 'the non-empty term must survive')
		})
	})//end describe rebuild_search_query_object merge



	// ───────────────────────────────────────────────────────────
	// MEDIUM #4 — "all selected" optimization must span every filter_by_list group
	// (dropping the list filter only when the selection covers the WHOLE list).
	// ───────────────────────────────────────────────────────────

	describe("is_full_list_selection spans all filter_by_list groups", function() {

		it("is true only when the selection count equals the total across groups", async function() {

			// single group, all selected
			assert.equal(is_full_list_selection([{ datalist: [1, 2, 3] }], 3), true)
			// two groups: total 5, only 3 selected — must NOT be treated as full
			// (the old single-group comparison wrongly returned true here)
			assert.equal(is_full_list_selection([{ datalist: [1, 2, 3] }, { datalist: [4, 5] }], 3), false)
			// two groups: all 5 selected
			assert.equal(is_full_list_selection([{ datalist: [1, 2, 3] }, { datalist: [4, 5] }], 5), true)
			// no groups / empty
			assert.equal(is_full_list_selection([], 0), false)
		})
	})//end describe is_full_list_selection



	// ───────────────────────────────────────────────────────────
	// MEDIUM #7 — out-of-order guard for non-main controls
	// All controls (operator, limit, checkboxes, per-field inputs) route through
	// run_search, which uses the shared self._search_seq token so a slower older
	// request can't overwrite a newer one.
	// ───────────────────────────────────────────────────────────

	describe("run_search drops out-of-order (stale) responses", function() {

		it("does not render a response that a newer search superseded", async function() {

			const datalist = document.createElement('ul')
			const sentinel = document.createElement('li')
			datalist.appendChild(sentinel)

			const self = {
				_search_seq	: 5,
				ar_instances: [],
				datalist	: datalist,
				autocomplete_search : async function() {
					// a newer search starts and bumps the token before this resolves
					self._search_seq = 99
					return { ok: true, data: { data: [] } }
				}
			}

			await run_search(self)

			assert.equal(datalist.childNodes.length, 1, 'stale response must not touch the datalist')
			assert.equal(datalist.firstChild, sentinel, 'datalist must be left untouched on a stale response')
		})

		it("renders when its response is the latest", async function() {

			const datalist = document.createElement('ul')
			datalist.appendChild(document.createElement('li')) // stale row that must be cleared

			const self = {
				_search_seq	: 0,
				ar_instances: [],
				datalist	: datalist,
				autocomplete_search : async function() {
					// empty result ⇒ render_datalist clears and returns (no get_section_records)
					return { ok: true, data: { data: [] } }
				}
			}

			await run_search(self)

			assert.equal(datalist.childNodes.length, 0, 'latest (empty) response clears the datalist')
		})
	})//end describe run_search stale guard


	// ───────────────────────────────────────────────────────────
	// build_rqo_search — the CLIENT half of the relation-column search
	// (WC-2026-10-01-relation-search-display-paths). The server writes a
	// relation column's display ddos into the item's `search_paths`; the
	// SHIPPED common.prototype.build_rqo_search must mint the filter_free
	// paths from them — the deep [relation, display leaf] path, server order.
	// Walking show/search.ddo_map instead sends the typed word to the
	// relation's locator column, which the server refuses (request.invalid,
	// WC-2026-09-23). The fixture is shared with the server half
	// (test/unit/search_paths_client_fixture_native.test.ts), which proves
	// the engine emits `search_paths` and answers `expected_filter_paths`.
	// Backend-free: a plain caller object, nothing is sent.
	// ───────────────────────────────────────────────────────────

	describe("build_rqo_search mints the filter paths from search_paths", function() {

		const clone = (value) => JSON.parse(JSON.stringify(value))

		// the picker that owns the column (the component instance shape
		// build_rqo_search reads through create_source)
		const picker = () => ({
			id				: 'zz_build_rqo_search',
			type			: 'component',
			model			: 'component_portal',
			tipo			: SEARCH_PATHS_OWNER,
			section_tipo	: 'test3',
			section_id		: 1,
			mode			: 'edit',
			lang			: lang
		})

		const request_config_object = (extra={}) => ({
			api_engine	: 'dedalo',
			type		: 'main',
			sqo			: {section_tipo: [{tipo: 'test3'}]},
			show		: {ddo_map: clone(show_ddo_map)},
			search		: null,
			choose		: null,
			...extra
		})

		// the minted paths, on the fixture's keys
		const minted_paths = (rqo) => rqo.sqo_options.filter_free.$or.map(
			(clause) => clause.path.map((ddo) => ({
				tipo			: ddo.tipo,
				section_tipo	: ddo.section_tipo,
				component_tipo	: ddo.component_tipo,
				model			: ddo.model
			}))
		)

		it("mints the deep [relation, display leaf] path in server order", async function() {
			const rco = request_config_object({search_paths: clone(search_paths)})
			const rqo = await common.prototype.build_rqo_search.call(picker(), rco, 'search')

			assert.deepEqual(minted_paths(rqo), expected_filter_paths, 'the fixture path, exactly')
			for (const clause of rqo.sqo_options.filter_free.$or) {
				assert.strictEqual(clause.q, '', 'the caller fills q')
				assert.isTrue(clause.path.every((ddo) => ddo.mode==='list'), 'every hop in list mode (lang fallback)')
			}
			// the result columns still come from choose → search → show
			assert.deepEqual(rqo.show.ddo_map, show_ddo_map, 'show.ddo_map is the column source, not search_paths')
			assert.deepEqual(
				rqo.show.columns.map((column) => column.map((ddo) => ddo.tipo)),
				[['test54']],
				'one result column: the relation column itself'
			)
			// the caller's config is not touched
			assert.deepEqual(rco.search_paths, search_paths, 'search_paths left as received')
		})

		it("without search_paths: the relation column alone is the leaf (positive control)", async function() {
			const rqo = await common.prototype.build_rqo_search.call(picker(), request_config_object(), 'search')
			assert.deepEqual(minted_paths(rqo), [relation_leaf_path], 'the show map, walked as before')
		})

		it("an empty search_paths falls back to the declared search map", async function() {
			const declared = [{tipo: 'test52', parent: SEARCH_PATHS_OWNER, section_tipo: ['test3'], model: 'component_input_text', mode: 'list'}]
			const rqo = await common.prototype.build_rqo_search.call(
				picker(),
				request_config_object({search: {ddo_map: declared}, search_paths: []}),
				'search'
			)
			assert.deepEqual(
				minted_paths(rqo),
				[[{tipo: 'test52', section_tipo: 'test3', component_tipo: 'test52', model: 'component_input_text'}]]
			)
		})

		// result rows are a PICK LIST: a column the caller's table pins to edit
		// (in-cell editing: fixed_mode + mode 'edit' + view 'line') rendered a whole
		// editable portal — label, tools, pen/remove — inside every result row
		it("result columns pinned to edit come back read-only (list), the rest untouched", async function() {
			const pinned = {tipo: 'test54', parent: SEARCH_PATHS_OWNER, section_tipo: ['test3'], model: 'component_portal', mode: 'edit', view: 'line', fixed_mode: true}
			const plain = {tipo: 'test52', parent: SEARCH_PATHS_OWNER, section_tipo: ['test3'], model: 'component_input_text', mode: 'list'}
			const rco = request_config_object({show: {ddo_map: [clone(pinned), clone(plain)]}})
			const rqo = await common.prototype.build_rqo_search.call(picker(), rco, 'search')

			assert.deepEqual(rqo.show.ddo_map, [{...pinned, mode: 'list'}, plain], 'only the mode of the edit column changes')
			assert.isTrue(rqo.show.columns.flat().every((ddo) => ddo.mode!=='edit'), 'no result column renders as an editor')
			assert.strictEqual(rco.show.ddo_map[0].mode, 'edit', "the caller's own map keeps its edit column")
		})
	})//end describe build_rqo_search



	// ───────────────────────────────────────────────────────────
	// SEARCH CARD GEOMETRY — options panel (gear) + results list
	// On the search canvas a portal card is ONE 16rem track of the group's
	// auto-fill grid. With the options open the panel got ~190px, and the
	// results overlay (fixed under the main input) painted over the whole
	// panel — including the option input being typed in — and ran past the
	// card's right edge. The option rows (fixed 1.7rem around a 2rem input)
	// overlapped each other. This builds the search-page skeleton with the
	// SHIPPED main.css and the render's own class names
	// (view_default_autocomplete.js get_content_data / render_inputs_list /
	// render_operator_selector) and measures the outcome, not a selector.
	// ───────────────────────────────────────────────────────────
	describe("search card: options panel and results list do not collide", function() {

		const el = (tag, class_name, parent, text) => {
			const node = parent.ownerDocument.createElement(tag)
			if (class_name) node.className = class_name
			if (text) node.textContent = text
			parent.appendChild(node)
			return node
		}

		/**
		 * BUILD
		 * The search page chain the group grid rule is scoped to
		 * (search.less: .wrapper_search > .search_global_container >
		 * .search_container_selection .search_group_container .search_group)
		 * in its own frame: the suite frame is under the 1024px breakpoint,
		 * where the compact tier collapses the group to ONE track.
		 * @param {Object} [options]
		 * @param {number} [options.frame_width=1200] - the viewport (breakpoint tier)
		 * @param {number|null} [options.host_width=null] - the group's own room
		 *   (side panels / nesting shrink it on a desktop window), null = the frame
		 * @param {number} [options.rows=3] - results in the list
		 * @param {boolean} [options.tooltip_shown=false] - the help tooltip in its
		 *   HOVERED state (no hidden_tooltip; transition off: read at first layout)
		 * @param {boolean} [options.open=false] - the options panel open (gear)
		 */
		const build = async ({frame_width = 1200, host_width = null, rows = 3, tooltip_shown = false, open = false} = {}) => {
			const opened = await open_css_frame(frame_width, 'search_card_fixture')
			try {
				const host = opened.container
				if (host_width) {
					host.style.width = host_width + 'px'
				}
				const wrapper_search	= el('div', 'wrapper_search', host)
				const global_container	= el('div', 'search_global_container', wrapper_search)
				const selection			= el('div', 'search_container_selection', global_container)
				const group_container	= el('div', 'search_group_container', selection)
				const group				= el('div', 'search_group', group_container)

				// the portal card + a sibling card (so the group has a row to share)
				const card		= el('div', 'search_component', group)
				const sibling	= el('div', 'search_component', group)
				el('div', 'wrapper_component component_input_text search tooltip_toggle', sibling)

				const component = el('div', 'wrapper_component component_portal search tooltip_toggle active', card)
				el('div', 'label', component, 'portal')
				// the real portal body carries the q_operator box
				// (render_search_component_portal.js), which moves the overlay's
				// left inset (--ac_inset_left)
				const content_data = el('div', 'content_data', component)
				el('input', 'q_operator', content_data)
				const tooltip = el('div', tooltip_shown ? 'tooltip' : 'tooltip hidden_tooltip', component, 'Search options')
				if (tooltip_shown) {
					tooltip.style.transition = 'none'
				}

				const service = el('div', 'wrapper_service_autocomplete search active', component)
				const options = el('div', open ? 'options_hidden visible' : 'options_hidden', service)
				const source = el('div', 'source_selector', options)
				el('label', 'css_label label', source, 'Source')
				el('select', 'select_source_selector', source)
				const filters = el('div', 'filters_container', options)
				const filter_node = el('ul', 'filter_node', filters)
				el('li', 'all_selector', filter_node, 'All sections')
				el('li', '', filter_node, 'A section with a long name')
				const inputs_list = el('div', 'inputs_list', options)
				const input_groups = ['Name', 'Surname', 'Name'].map((label) => {
					const group_node = el('div', 'input_group', inputs_list)
					const input = el('input', '', group_node)
					input.type = 'text'
					el('label', '', group_node, label)
					return group_node
				})
				const operators = el('div', 'search_operators_div', options)
				const select_container = el('div', 'select_container', operators)
				el('label', 'css_label label', select_container, 'Search operators')
				const operator_select = el('select', 'operator_selector', select_container)
				el('option', '', operator_select, 'or')
				const max_container = el('div', 'max_container', operators)
				el('label', 'css_label label_max', max_container, 'Max')
				el('input', 'input_max', max_container)

				const search_input = el('input', 'autocomplete_input', service)
				search_input.type = 'text'
				el('span', 'button_options button gear', service)
				const datalist = el('ul', 'autocomplete_data', service)
				for (let i = 0; i < rows; i++) {
					el('li', 'autocomplete_data_li', datalist, 'Museu Nacional d’Art de Catalunya. Barcelona. ' + i)
				}

				return {
					frame: opened.frame,
					style: opened.win.getComputedStyle.bind(opened.win),
					group, card, sibling, options, tooltip, input_groups, operators, select_container, datalist, search_input
				}
			} catch (error) {
				opened.frame.remove()
				throw error
			}
		}

		const rect = (node) => node.getBoundingClientRect()
		const tracks_of = (f) => f.style(f.group).gridTemplateColumns.split(' ').map(parseFloat)

		// shared by every open-panel case: list under the panel and inside the
		// card, option rows whole, operator label + select on one line
		const assert_open_panel = (f, context) => {
			assert.isAtLeast(rect(f.options).top, rect(f.search_input).bottom - 1, `${context}: the panel sits below the main input`)

			const panel_rect	= rect(f.options)
			const list_rect		= rect(f.datalist)
			const card_rect		= rect(f.card)
			assert.isAtLeast(list_rect.top, panel_rect.bottom - 1, `${context}: the results list starts below the options panel`)
			assert.isAtLeast(list_rect.left, card_rect.left - 1, `${context}: the list does not leave the card on the left`)
			assert.isAtMost(list_rect.right, card_rect.right + 1, `${context}: the list does not leave the card on the right`)
			assert.isAtMost(card_rect.right, rect(f.group).right + 1, `${context}: the card does not leave its group`)

			f.input_groups.forEach((group_node, i) => {
				const input_rect = rect(group_node.querySelector('input'))
				assert.isAtLeast(rect(group_node).height, input_rect.height - 1, `${context}: row ${i} is as tall as its input`)
				if (i > 0) {
					const previous = rect(f.input_groups[i - 1])
					assert.isAtLeast(rect(group_node).top, previous.bottom - 1, `${context}: row ${i} does not overlap row ${i - 1}`)
				}
			})

			const label_rect	= rect(f.select_container.querySelector('.css_label'))
			const select_rect	= rect(f.select_container.querySelector('select'))
			assert.isBelow(Math.abs(label_rect.top + label_rect.height / 2 - (select_rect.top + select_rect.height / 2)), 4, `${context}: the operator label and its select share a line`)
			assert.isAtMost(rect(f.operators).right, panel_rect.right + 1, `${context}: the operators row stays inside the panel`)
		}

		it("desktop, roomy group: the open card takes exactly two tracks; the list hangs below the panel", async function() {
			const f = await build()
			try {
				// precondition, measured: at least THREE tracks, or "two tracks,
				// not the whole row" cannot be told apart
				const track_sizes = tracks_of(f)
				assert.isAtLeast(track_sizes.length, 3, 'the fixture group lays out at least three tracks')
				const gap = parseFloat(f.style(f.group).columnGap) || 0
				const sibling_closed_top = rect(f.sibling).top

				f.options.classList.add('visible')

				// `span 2`: wide enough for the panel, never the whole row —
				// the sibling keeps its place in the same row (third track)
				const two_tracks = track_sizes[0] + gap + track_sizes[1]
				assert.isBelow(Math.abs(rect(f.card).width - two_tracks), 2, 'the open card is two tracks wide')
				assert.isBelow(Math.abs(rect(f.sibling).top - sibling_closed_top), 1, 'the sibling stays in the same row')
				assert.isAtLeast(rect(f.sibling).left, rect(f.card).right - 1, 'the sibling sits after the two-track card')

				assert_open_panel(f, 'desktop')
			} finally {
				f.frame.remove()
			}
		})

		it("desktop window, ONE-track group (side panels / nesting): the open card mints no implicit column", async function() {
			// a desktop viewport (the media tier is desktop) but a group with
			// room for one 16rem track only: what the window says is irrelevant
			const f = await build({host_width: 420})
			try {
				assert.strictEqual(tracks_of(f).length, 1, 'precondition: the narrow group lays out one track')

				f.options.classList.add('visible')

				assert.strictEqual(tracks_of(f).length, 1, 'still one track with the panel open (no implicit column)')
				assert.isBelow(Math.abs(rect(f.sibling).width - rect(f.card).width), 1, 'the sibling keeps the full track')
				assert_open_panel(f, 'one-track group')
			} finally {
				f.frame.remove()
			}
		})

		it("compact tier (800px window): the open card stays inside its one-track group", async function() {
			const f = await build({frame_width: 800, open: true})
			try {
				assert.strictEqual(tracks_of(f).length, 1, 'the compact group lays out one track, open panel included')
				assert_open_panel(f, 'compact')
			} finally {
				f.frame.remove()
			}
		})

		it("options closed: the card keeps its track and the list stays inside it (positive control)", async function() {
			const f = await build()
			try {
				const track = tracks_of(f)[0]
				assert.isBelow(Math.abs(rect(f.card).width - track), 2, 'the closed card is one track wide')

				const card_rect = rect(f.card)
				const list_rect = rect(f.datalist)
				assert.isAtLeast(list_rect.top, rect(f.search_input).bottom - 1, 'the list hangs under the main input')
				assert.isAtMost(list_rect.right, card_rect.right + 1, 'the list does not leave the card on the right')
			} finally {
				f.frame.remove()
			}
		})

		it("the search-options help (hovered) hides while the list has rows, and shows without them", async function() {
			// the tooltip in its HOVERED state (general.less .tooltip_toggle:hover
			// drops hidden_tooltip's visibility): only the results rule can hide it
			const with_rows = await build({tooltip_shown: true, rows: 3})
			try {
				assert.strictEqual(with_rows.style(with_rows.tooltip).visibility, 'hidden', 'hidden while the results list has rows')
			} finally {
				with_rows.frame.remove()
			}
			const without_rows = await build({tooltip_shown: true, rows: 0})
			try {
				assert.strictEqual(without_rows.style(without_rows.tooltip).visibility, 'visible', 'control: visible with an empty list')
			} finally {
				without_rows.frame.remove()
			}
		})
	})//end describe search card geometry

})//end describe SERVICE_AUTOCOMPLETE



// @license-end
