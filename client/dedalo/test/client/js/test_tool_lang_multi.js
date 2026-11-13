// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_TOOL_LANG_MULTI
 * Client-side coverage for the multi-language translation tool.
 *
 * The tool's deeper render/open path needs a host section with the ddo_map
 * 'main_element' role plus live per-language component instances and the
 * lazily-imported browser translation worker (ONNX model), none of which are
 * guaranteed in the headless harness. This suite therefore asserts the
 * reliable, fixture-free contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 */

import {tool_lang_multi} from '../../../tools/tool_lang_multi/js/tool_lang_multi.js'



describe('TOOL_LANG_MULTI CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_lang_multi, 'function', 'expected tool_lang_multi to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_lang_multi()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.source_lang, null, 'expected source_lang null')
		assert.equal(instance.target_lang, null, 'expected target_lang null')
		assert.equal(instance.langs, null, 'expected langs null')
		assert.equal(instance.caller, null, 'expected caller null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_lang_multi.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_lang_multi.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_lang_multi.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_lang_multi
		assert.equal(typeof tool_lang_multi.prototype.edit, 'function', 'expected edit wired')
		// tool-specific methods defined on the module
		assert.equal(typeof tool_lang_multi.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_lang_multi.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_lang_multi.prototype.get_component, 'function', 'expected get_component defined')
		assert.equal(typeof tool_lang_multi.prototype.automatic_translation, 'function', 'expected automatic_translation defined')
		assert.equal(typeof tool_lang_multi.prototype.set_source_lang, 'function', 'expected set_source_lang defined')
		assert.equal(typeof tool_lang_multi.prototype.resolve_engine, 'function', 'expected resolve_engine defined')
		assert.equal(typeof tool_lang_multi.prototype.run_browser_translation, 'function', 'expected run_browser_translation defined')
		assert.equal(typeof tool_lang_multi.prototype.translate_target, 'function', 'expected translate_target defined')
		assert.equal(typeof tool_lang_multi.prototype.automatic_translation_all, 'function', 'expected automatic_translation_all defined')
	})

})



/**
* TRANSLATE ALL — the per-language outcome (T1-P01)
* automatic_translation_all counts a language as translated only when its run
* says the value is stored. Driven on a bare prototype instance (no section, no
* worker, no modal: event.altKey selects 'overwrite'), with the engine call
* stubbed, so what is measured is exactly the counting.
*/
describe('TOOL_LANG_MULTI TRANSLATE ALL OUTCOME', function() {

	const make_instance = (engine_name, stubs) => Object.assign(Object.create(tool_lang_multi.prototype), {
		context						: {config: {translator_engine: {value: [
			{name: 'browser_transformer', type: 'browser'},
			{name: 'babel', type: 'server'}
		]}}},
		translator_engine_select	: {value: engine_name},
		translator_device_checkbox	: null,
		langs						: [{value: 'lg-eng', label: 'English'}, {value: 'lg-spa', label: 'Spanish'}],
		lang						: 'lg-eng',
		source_lang					: 'lg-eng',
		lang_components				: {
			'lg-eng' : {data: {entries: [{id: 1, value: '<p>Hi</p>'}]}},
			'lg-spa' : {data: {entries: []}}
		},
		lang_containers				: {},
		status_container			: null,
		get_tool_label				: () => null
	}, stubs)

	const run_all = async (instance) => {
		const results = await instance.automatic_translation_all({event: {altKey: true}})
		assert.isArray(results, 'expected the run to reach the targets')
		assert.equal(results.length, 1, 'expected exactly the one non-source target')
		assert.equal(results[0].lang, 'lg-spa')
		return results[0]
	}

	it('browser engine: a run resolving result:false (cancelled, nothing saved) is NOT counted ok', async function() {
		const result = await run_all(make_instance('browser_transformer', {
			run_browser_translation : () => Promise.resolve({result: false, msg: 'Translation cancelled'})
		}))
		assert.equal(result.ok, false, 'a run that saved nothing was counted as translated')
	})

	it('browser engine: a run resolving result:true (stored) is counted ok', async function() {
		const result = await run_all(make_instance('browser_transformer', {
			run_browser_translation : () => Promise.resolve({result: true, msg: 'OK. Translation completed'})
		}))
		assert.equal(result.ok, true, 'a stored translation was not counted')
	})

	it('browser engine: a rejected run (refused, or its save did not land) is NOT counted ok', async function() {
		const result = await run_all(make_instance('browser_transformer', {
			run_browser_translation : () => Promise.reject(new Error('Translation not saved: the save failed'))
		}))
		assert.equal(result.ok, false)
	})

	it('server engine: a refusal envelope is NOT counted ok', async function() {
		const result = await run_all(make_instance('babel', {
			automatic_translation : () => Promise.resolve({
				ok		: false,
				error	: {is_api_error: true, code: 'translation.empty_result'}
			})
		}))
		assert.equal(result.ok, false)
	})

})

// @license-end
