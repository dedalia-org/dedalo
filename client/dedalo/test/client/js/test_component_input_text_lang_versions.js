// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_COMPONENT_INPUT_TEXT_LANG_VERSIONS
 * The client half of a TRANSLITERABLE component (`with_lang_versions`): a
 * non-translatable component_input_text whose value lives in an lg-nolan BASE
 * and may keep a VERSION per language beside it, edited through tool_lang
 * (WC-2026-10-31-transliterate-value-emitted).
 *
 * The client carries no rule of its own here: it builds every instance in the
 * lang the server's context gives it, offers whatever `context.tools` lists,
 * and the views show `data.transliterate_value` when
 * `context.properties.with_lang_versions` is set. So the suite drives the REAL
 * client paths against the REAL server and pins what they end up doing:
 *   - a model-less get_instance (get_element_context, no lang sent) builds the BASE;
 *   - the base instance offers tool_lang and carries the raw property;
 *   - the tool_lang TARGET (model known, lang = the version's) builds in that
 *     lang, and its save files the version beside the base, never over it;
 *   - each side shows the other as transliterate_value — the edit view's
 *     `.transliterate_value` line, the list view's " (…)" suffix.
 *
 * Fixture: test166 (test TLD, component_input_text in the test3 playground,
 * properties {with_lang_versions:true}). The suite OWNS its record: created
 * through the engine's create door, deleted (delete_record) after — never a
 * canonical test3 record. Server-side contract: test/unit/with_lang_versions_native.test.ts.
 */

import {get_instance} from '../../../core/common/js/instances.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {response_data, request_failed} from '../../../core/common/js/api_error.js'



// configuration
	const model			= 'component_input_text'
	const tipo			= 'test166'
	const section_tipo	= 'test3'
	const nolan			= page_globals?.dedalo_data_nolan ?? 'lg-nolan'
	// the request DATA lang: the base instance's counterpart is the version in it
	const data_lang		= page_globals?.dedalo_data_lang ?? 'lg-eng'

	const base_value	= 'Augustus'
	const version_value	= 'Αύγουστος'



const api = async (body) => {
	const api_response = await data_manager.request({ body })
	if (request_failed(api_response)) {
		throw new Error(`lang_versions: ${body.action} refused: ${api_response.error.code}`)
	}
	return response_data(api_response)
}

const section_source = (section_id = null) => ({
	typo			: 'source',
	type			: 'section',
	model			: 'section',
	tipo			: section_tipo,
	section_tipo	: section_tipo,
	section_id		: section_id,
	mode			: 'edit',
	lang			: data_lang
})

/**
* BUILD_INSTANCE
* A fresh, built test166 instance (never a cached one)
* @param {object} options - overrides (lang, mode, view, model, id_variant)
* @return {Promise<object>} built instance
*/
const build_instance = async (section_id, options={}) => {
	const instance = await get_instance(Object.assign({
		model			: model,
		tipo			: tipo,
		section_tipo	: section_tipo,
		section_id		: section_id,
		mode			: 'edit',
		view			: 'default',
		lang			: nolan,
		id_variant		: 'lang_versions_' + Math.random()
	}, options))
	await instance.build(true)
	return instance
}

const values_of = (items) => (items || []).map(el => el?.value)



describe('COMPONENT_INPUT_TEXT WITH_LANG_VERSIONS (test166)', function() {

	this.timeout(30000)

	let section_id = null

	before(async function() {
		section_id = Number(await api({action: 'create', source: section_source()}))
		assert.ok(section_id > 0, 'a fresh scratch record was created')
		// the counterpart of the base is the data-lang version: a data lang that
		// IS the base would make every assertion below compare a slice with itself
		assert.notEqual(data_lang, nolan, 'the page data lang is a real language')
	})

	after(async function() {
		if (section_id > 0) {
			await api({
				action	: 'delete',
				source	: Object.assign(section_source(section_id), {delete_mode: 'delete_record'})
			})
		}
	})

	it('the base instance: lg-nolan context, the raw property, tool_lang offered', async function() {
		const instance = await build_instance(section_id)
		assert.equal(instance.lang, nolan, 'instance lang')
		assert.equal(instance.context.lang, nolan, 'context lang')
		assert.equal(instance.context.properties?.with_lang_versions, true, 'the views gate on the raw property')
		assert.ok(
			(instance.context.tools || []).some(el => el.model==='tool_lang' || el.name==='tool_lang'),
			'tool_lang is offered on a transliterable component'
		)
		await instance.destroy(true, true, true)
	})

	it('a model-less get_instance (get_element_context, no lang sent) builds the BASE', async function() {
		const instance = await get_instance({
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			mode			: 'edit',
			id_variant		: 'lang_versions_modelless_' + Math.random()
		})
		assert.equal(instance.model, model, 'the model came from the element context')
		assert.equal(instance.lang, nolan, 'the session data lang does not move it off the base')
		await instance.destroy(true, true, true)
	})

	it('saves file each lang in its own lane: the base from the form, the version from the tool_lang target', async function() {
		// the form instance saves in its own lang: the base
		const base = await build_instance(section_id)
		const base_response = await base.change_value({
			changed_data	: [Object.freeze({action: 'update', id: 1, value: {id: 1, lang: base.lang, value: base_value}})],
			refresh			: false
		})
		assert.ok(response_data(base_response), 'the base save succeeded')
		await base.destroy(true, true, true)

		// the tool_lang target: model known, lang = the version's (tool_common load_component)
		const target = await build_instance(section_id, {lang: data_lang, id_variant: 'target_component'})
		assert.equal(target.context.lang, data_lang, 'the target context runs in the version lang')
		assert.deepEqual(target.data.entries || [], [], 'no version yet')
		assert.deepEqual(values_of(target.data.transliterate_value), [base_value], 'the base beside the empty version')
		const target_response = await target.change_value({
			changed_data	: [Object.freeze({action: 'update', id: 1, value: {id: 1, lang: target.lang, value: version_value}})],
			refresh			: false
		})
		assert.ok(response_data(target_response), 'the version save succeeded')
		await target.destroy(true, true, true)

		// read back, both sides
		const base_again = await build_instance(section_id)
		assert.deepEqual(values_of(base_again.data.entries), [base_value], 'the base is untouched by the version save')
		assert.deepEqual(values_of(base_again.data.transliterate_value), [version_value], 'the data-lang version beside the base')
		await base_again.destroy(true, true, true)

		const target_again = await build_instance(section_id, {lang: data_lang, id_variant: 'target_component'})
		assert.deepEqual(values_of(target_again.data.entries), [version_value], 'the version reads in its own lane')
		assert.deepEqual(values_of(target_again.data.transliterate_value), [base_value], 'the base beside the version')
		await target_again.destroy(true, true, true)
	})

	it('the views show the counterpart: edit `.transliterate_value` line, list " (…)" suffix', async function() {
		const edit = await build_instance(section_id)
		const edit_node = await edit.render()
		const line = edit_node.querySelector('.transliterate_value')
		assert.ok(line, 'the edit view renders the transliterate_value line')
		assert.equal(line.textContent, version_value, 'with the version')
		await edit.destroy(true, true, true)

		const list = await build_instance(section_id, {mode: 'list'})
		const list_node = await list.render()
		assert.include(list_node.textContent, `${base_value} (${version_value})`, 'the list cell shows "base (version)"')
		await list.destroy(true, true, true)
	})
})

// @license-end
