// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';



import {common, create_callers, create_search_callers} from '../../../core/common/js/common.js'
import {picker_caller} from '../../../core/component_portal/js/component_portal.js'
import {get_picker_caller} from '../../../core/ts_object/js/ts_object.js'



/**
* TEST_CALLER_CHAIN
* The client half of the server-verified caller chain (`rqo.source.callers`,
* src/core/relations/caller_chain.ts — nested-ddo_map plan W4, owner decisions
* (a), (d), (f)). A NESTED component's own reads — page 2 of a portal cell
* (build_rqo_show) and the autocomplete search inside that cell
* (build_rqo_search) — name the component instances the cell sits under, so the
* server resolves the element UNDER its caller: the children its caller
* injected keep their inherited read on page 2, and the search read floor
* admits them. Without this producer the server half is reachable only by
* hand-built rqos (the server gate test/unit/subdatum_permission_native.test.ts
* sends the chain by hand; this suite proves the client sends the same shape).
*
* Backend-free: plain instance-shaped objects linked through `.caller`, and the
* shipped build_rqo_show / build_rqo_search called on them.
*/



// A fake instance: the fields create_source / create_callers / the rqo builders read.
	const make = (model, tipo, section_tipo, mode, caller=null, extra={}) => ({
		id				: `${model}_${tipo}_${section_tipo}_${mode}`,
		model,
		type			: model.startsWith('component_') ? 'component' : model,
		tipo,
		section_tipo,
		section_id		: 1,
		mode,
		lang			: 'lg-nolan',
		caller,
		...extra
	})

// test3/1 edit → grouper → test180 (portal) → row → test181 (nested portal)
	const edit_tree = () => {
		const section	= make('section', 'test3', 'test3', 'edit')
		const group		= make('section_group', 'test2', 'test3', 'edit', section, {type:'grouper'})
		const outer		= make('component_portal', 'test180', 'test3', 'edit', group)
		const row		= make('section_record', 'test180', 'test38', 'edit', outer)
		const nested	= make('component_portal', 'test181', 'test38', 'list', row)
		return {section, outer, nested}
	}

// test3 list → row → test180 (list column) → row → test181
	const list_tree = () => {
		const section	= make('section', 'test3', 'test3', 'list')
		const row1		= make('section_record', 'test3', 'test3', 'list', section)
		const outer		= make('component_portal', 'test180', 'test3', 'list', row1)
		const row2		= make('section_record', 'test180', 'test38', 'list', outer)
		const nested	= make('component_portal', 'test181', 'test38', 'list', row2)
		return {section, outer, nested}
	}



describe(`CALLER_CHAIN`, async () => {

	it(`a top-level component sends no chain`, async function() {
		const {outer} = edit_tree()
		assert.strictEqual(create_callers(outer), null)
	})

	it(`a nested cell in EDIT names its outermost component as the root, with its mode`, async function() {
		const {nested} = edit_tree()
		assert.deepEqual(create_callers(nested), [
			{tipo:'test180', section_tipo:'test3', mode:'edit'}
		])
	})

	it(`a nested cell in a LIST names the section as the root (the column map is the section's)`, async function() {
		const {nested} = list_tree()
		assert.deepEqual(create_callers(nested), [
			{tipo:'test3', section_tipo:'test3', mode:'list'},
			{tipo:'test180', section_tipo:'test3'}
		])
	})

	it(`three levels: every component link, outermost first`, async function() {
		const {nested} = edit_tree()
		const row	= make('section_record', 'test181', 'test39', 'list', nested)
		const deep	= make('component_input_text', 'test183', 'test39', 'list', row)
		assert.deepEqual(create_callers(deep), [
			{tipo:'test180', section_tipo:'test3', mode:'edit'},
			{tipo:'test181', section_tipo:'test38'}
		])
	})

	it(`a root mode the server refuses (tm, search) sends no chain`, async function() {
		const section	= make('section', 'test3', 'test3', 'tm')
		const outer		= make('component_portal', 'test180', 'test3', 'tm', section)
		const row		= make('section_record', 'test180', 'test38', 'tm', outer)
		const nested	= make('component_portal', 'test181', 'test38', 'tm', row)
		assert.strictEqual(create_callers(nested), null)
	})

	it(`a tool between the cell and the section ends the walk`, async function() {
		const {section} = edit_tree()
		const tool		= make('tool_time_machine', 'tool_time_machine', 'test3', 'edit', section)
		const outer		= make('component_portal', 'test180', 'test3', 'edit', tool)
		const row		= make('section_record', 'test180', 'test38', 'edit', outer)
		const nested	= make('component_portal', 'test181', 'test38', 'list', row)
		assert.deepEqual(create_callers(nested), [
			{tipo:'test180', section_tipo:'test3', mode:'edit'}
		], 'only the components below the tool are the cell\'s chain')
	})

	it(`a circular caller chain terminates (tool_common's new-window path)`, async function() {
		const {outer, nested} = edit_tree()
		outer.caller = nested // cycle
		const chain = create_callers(nested)
		assert.ok(Array.isArray(chain) || chain===null)
	})

	it(`a dataframe sends no chain (paired to its main component, not nested)`, async function() {
		const {outer} = edit_tree()
		const frame = make('component_dataframe', 'test182', 'test3', 'edit', outer)
		assert.strictEqual(create_callers(frame), null)
	})

	it(`page 2 (build_rqo_show) of a nested cell carries source.callers`, async function() {
		const {nested} = edit_tree()
		const rqo = await common.prototype.build_rqo_show.call(nested, {
			sqo		: {section_tipo:['test39'], limit:10, offset:10},
			show	: {ddo_map:[]}
		}, 'get_data')
		assert.deepEqual(rqo.source.callers, [
			{tipo:'test180', section_tipo:'test3', mode:'edit'}
		])
		assert.strictEqual(rqo.source.tipo, 'test181')
	})

	it(`the in-cell autocomplete search (build_rqo_search) carries source.callers`, async function() {
		const {nested} = list_tree()
		const rqo = await common.prototype.build_rqo_search.call(nested, {
			sqo		: {section_tipo:['test39']},
			show	: {ddo_map:[]}
		}, 'search')
		assert.deepEqual(rqo.source.callers, [
			{tipo:'test3', section_tipo:'test3', mode:'list'},
			{tipo:'test180', section_tipo:'test3'}
		])
	})

	// SECTION-INJECTED (W5 review 2026-11-03): the section's own map declares the
	// component's children, so the section is the caller the server resolves
	// it under (relations/element_node.ts rootNodeFor) — in either mode.
	const injecting = (section, portal_tipo) => {
		section.request_config_object = {
			api_engine	: 'dedalo',
			type		: 'main',
			show		: {ddo_map:[
				{tipo:portal_tipo, section_tipo:section.tipo, parent:section.tipo},
				{tipo:'test52', section_tipo:'test38', parent:portal_tipo}
			]}
		}
		return section
	}

	it(`a top-level component its SECTION map injects into is rooted at the section (edit and list)`, async function() {
		const edit = edit_tree()
		injecting(edit.section, 'test180')
		assert.deepEqual(create_callers(edit.outer), [
			{tipo:'test3', section_tipo:'test3', mode:'edit'}
		])
		const list = list_tree()
		injecting(list.section, 'test180')
		assert.deepEqual(create_callers(list.outer), [
			{tipo:'test3', section_tipo:'test3', mode:'list'}
		])
		// a map that declares only OTHER components' children injects nothing here
		const other = edit_tree()
		injecting(other.section, 'test999')
		assert.strictEqual(create_callers(other.outer), null)
	})

	// The root is the READ the occurrence came from, never the cell's current
	// render mode (W5 review 2026-11-03): a list column whose ddo declares mode
	// 'edit', or a list cell switched inline to edit (component_common
	// change_mode keeps the list read's context), still sits in the LIST map.
	it(`a list column rendering in 'edit' (ddo mode / inline change_mode) is still rooted at the LIST section`, async function() {
		// top level, section-injected
		const top = list_tree()
		injecting(top.section, 'test180')
		top.outer.mode = 'edit'
		assert.deepEqual(create_callers(top.outer), [
			{tipo:'test3', section_tipo:'test3', mode:'list'}
		])
		const rqo = await common.prototype.build_rqo_show.call(top.outer, {
			sqo		: {section_tipo:['test38'], limit:10, offset:0},
			show	: {ddo_map:[]}
		}, 'get_data')
		assert.deepEqual(rqo.source.callers, [{tipo:'test3', section_tipo:'test3', mode:'list'}], 'show and callers must describe the same occurrence')
		// nested, its outermost column rendering in 'edit'
		const nested = list_tree()
		nested.outer.mode = 'edit'
		assert.deepEqual(create_callers(nested.nested), [
			{tipo:'test3', section_tipo:'test3', mode:'list'},
			{tipo:'test180', section_tipo:'test3'}
		])
	})

	it(`an EDIT nested cell under a section-injected outermost is rooted at the section (DECL → DREL → REL4)`, async function() {
		const {section, nested} = edit_tree()
		injecting(section, 'test180')
		assert.deepEqual(create_callers(nested), [
			{tipo:'test3', section_tipo:'test3', mode:'edit'},
			{tipo:'test180', section_tipo:'test3'}
		])
	})

	it(`a top-level component's rqo has no callers key at all`, async function() {
		const {outer} = edit_tree()
		const rqo = await common.prototype.build_rqo_show.call(outer, {
			sqo		: {section_tipo:['test38'], limit:10, offset:0},
			show	: {ddo_map:[]}
		}, 'get_data')
		assert.strictEqual(Object.prototype.hasOwnProperty.call(rqo.source, 'callers'), false)
	})

	// PICKING READS (owner decisions (h)/(i), W4b 2026-11-03): a WRITER may pick
	// from a target section the user holds no grant on, ONLY through a verified
	// chain (src/core/security/writer_chain_scope.ts). A top-level component's
	// chain is its section — so its autocomplete search names it, while its
	// paging read (above) still sends none.
	it(`a top-level component's autocomplete search names its SECTION as the chain`, async function() {
		const {outer} = edit_tree()
		assert.deepEqual(create_search_callers(outer), [
			{tipo:'test3', section_tipo:'test3', mode:'edit'}
		])
		const rqo = await common.prototype.build_rqo_search.call(outer, {
			sqo		: {section_tipo:['test38']},
			show	: {ddo_map:[]}
		}, 'search')
		assert.deepEqual(rqo.source.callers, [{tipo:'test3', section_tipo:'test3', mode:'edit'}])
	})

	it(`create_search_callers keeps a nested cell's create_callers chain, and sends none outside a section`, async function() {
		const {nested} = list_tree()
		assert.deepEqual(create_search_callers(nested), create_callers(nested))
		// a search-panel component (its caller is the search service, not a section)
		const panel = make('component_portal', 'test180', 'test3', 'search', make('search', 'test3', 'test3', 'search'))
		assert.strictEqual(create_search_callers(panel), null)
		// a dataframe never names a chain
		const {section} = edit_tree()
		const frame = make('component_dataframe', 'test999', 'test3', 'edit', section)
		assert.strictEqual(create_search_callers(frame), null)
	})

	// THE TREE PICKER (owner decision (i)): the picker declaration a writer's
	// view:'tree' component opens the thesaurus with names its chain, and every
	// tree NODE read the picker makes carries that same declaration as
	// source.caller (src/core/area/read.ts pickerTreeReadAllowed — the server
	// gate is test/unit/subdatum_permission_native.test.ts + the area door in
	// test/unit/area_picker_mode_native.test.ts).
	it(`the picker declaration (component_portal picker_caller) carries the component's chain`, async function() {
		const {outer, nested} = edit_tree()
		assert.deepEqual(picker_caller(outer), {
			section_tipo	: 'test3',
			section_id		: 1,
			tipo			: 'test180',
			callers			: [{tipo:'test3', section_tipo:'test3', mode:'edit'}]
		})
		assert.deepEqual(picker_caller(nested).callers, create_search_callers(nested))
		// a search-panel component names no chain: the declaration keeps its plain shape
		const panel = make('component_portal', 'test180', 'test3', 'search', make('search', 'test3', 'test3', 'search'))
		assert.strictEqual(Object.prototype.hasOwnProperty.call(picker_caller(panel), 'callers'), false)
	})

	it(`a tree node finds the area's picker declaration up its .caller chain (ts_object get_picker_caller)`, async function() {
		const {outer} = edit_tree()
		const declaration	= picker_caller(outer)
		const area			= {model:'area_thesaurus', picker_caller:declaration}
		const root_node		= {model:'ts_object', caller:area}
		const child_node	= {model:'ts_object', caller:root_node}
		assert.strictEqual(get_picker_caller(child_node), declaration)
		assert.deepEqual(get_picker_caller(child_node).callers, [{tipo:'test3', section_tipo:'test3', mode:'edit'}])
		// a plain browse tree (no picker) sends none
		const plain_root = {model:'ts_object', caller:{model:'area_thesaurus'}}
		assert.strictEqual(get_picker_caller({model:'ts_object', caller:plain_root}), null)
	})
})



// @license-end
