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
				service.search_cache = {}

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
				search_cache: {},
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
	})//end describe build_rqo_search

})//end describe SERVICE_AUTOCOMPLETE



// @license-end
