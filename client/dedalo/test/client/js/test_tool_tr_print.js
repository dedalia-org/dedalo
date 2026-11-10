// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, before, after */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_TR_PRINT
 * Client-side coverage for the transcription print tool.
 *
 * The tool's deeper render/open path needs a host section with a live
 * component_text_area (the transcription component), the caller instance, and
 * page_globals.dedalo_projects_default_langs, none of which is guaranteed in the
 * headless harness. This suite therefore asserts the reliable, fixture-free
 * contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 */

import {tool_tr_print} from '../../../tools/tool_tr_print/js/tool_tr_print.js'
import {render_build_error} from '../../../tools/tool_tr_print/js/render_tool_tr_print.js'
import {component_text_area} from '../../../core/component_text_area/js/component_text_area.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {ApiError} from '../../../core/common/js/api_error.js'



describe('TOOL_TR_PRINT CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_tr_print, 'function', 'expected tool_tr_print to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_tr_print()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.source_lang, null, 'expected source_lang null')
		assert.equal(instance.target_lang, null, 'expected target_lang null')
		assert.equal(instance.langs, null, 'expected langs null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.transcription_component, null, 'expected transcription_component null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_tr_print.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_tr_print.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_tr_print.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_tr_print
		assert.equal(typeof tool_tr_print.prototype.edit, 'function', 'expected edit wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_tr_print.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_tr_print.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_tr_print.prototype.load_relation_list, 'function', 'expected load_relation_list defined')
		assert.equal(typeof tool_tr_print.prototype.tags_to_html, 'function', 'expected tags_to_html defined')
		assert.equal(typeof tool_tr_print.prototype.build_subtitles, 'function', 'expected build_subtitles defined')
	})

	/**
	 * THE REFUSED FEED IS SHOWN, NEVER A HANG (T0-3, 2026-11-10). get_tags_info
	 * used to never settle on a failed call, so a user the server refused saw
	 * a blank tool forever. The request is stubbed (no server): the refusal is
	 * the envelope data_manager hands back for a 403.
	 */
	describe('a refused get_tags_info', function() {

		const refusal = new ApiError({
			code		: 'perm.denied',
			status		: 403,
			message		: 'Permission denied',
			request_id	: 'req-tr-print-test',
			source		: 'envelope'
		})

		let original_request = null
		before(() => {
			original_request = data_manager.request
		})
		after(() => {
			data_manager.request = original_request
		})

		it('get_tags_info REJECTS with the ApiError (it does not hang)', async function() {
			data_manager.request = async () => ({ok: false, error: refusal, data: null})
			const text_area = new component_text_area()
			Object.assign(text_area, {section_tipo: 'test3', section_id: 1, tipo: 'test17', lang: 'lg-spa'})

			// a hang would time out the race; a resolve would be wrong
			const outcome = await Promise.race([
				text_area.get_tags_info(['index']).then(
					(value) => ({settled: 'resolved', value}),
					(error) => ({settled: 'rejected', error})
				),
				new Promise((resolve) => setTimeout(() => resolve({settled: 'hung'}), 2000))
			])
			assert.equal(outcome.settled, 'rejected', 'expected the refused call to reject')
			assert.equal(outcome.error, refusal, 'expected the response ApiError itself')
		})

		it('get_tags_info still RESOLVES with the payload on success (control)', async function() {
			data_manager.request = async () => ({ok: true, data: {tags_index: []}})
			const text_area = new component_text_area()
			Object.assign(text_area, {section_tipo: 'test3', section_id: 1, tipo: 'test17', lang: 'lg-spa'})
			const value = await text_area.get_tags_info(['index'])
			assert.deepEqual(value, {tags_index: []})
		})

		it('the tool renders the refusal (error text + request id), not a transcript', function() {
			const tool = new tool_tr_print()
			tool.error = refusal
			const node = render_build_error(tool)
			const alert = node.querySelector('.error_alert')
			assert.ok(alert, 'expected an .error_alert node')
			assert.ok(alert.textContent.length > 0, 'expected a message')
			assert.ok(node.classList.contains('build_error'), 'expected the build_error marker')
			assert.equal(node.querySelector('.right_container_text'), null, 'expected no transcript body')
		})

		it('edit() with a build error returns the error content (render_level content)', async function() {
			const tool = new tool_tr_print()
			tool.error = new Error('boom')
			const node = await tool.edit({render_level: 'content'})
			assert.ok(node.classList.contains('build_error'), 'expected the error content')
			assert.equal(node.querySelector('.error_alert').textContent, 'boom')
		})
	})

})

// @license-end
