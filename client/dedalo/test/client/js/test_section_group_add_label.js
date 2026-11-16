// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, before, after */
/*eslint no-undef: "error"*/

/**
 * TEST_SECTION_GROUP_ADD_LABEL
 * The section_group edit render honours the server's `add_label` (T1-28).
 *
 * The server stamps `add_label` on every section_group context: false iff the
 * stored model is `section_group_div` (structure_context.ts buildCore; bun
 * gate test/unit/section_group_add_label_native.test.ts). Before T1-28 it never
 * did, so the `=== false` branch had never run in the TS era and every div
 * panel rendered WITH a collapse header — a user could collapse it, persisting
 * a 'status' IndexedDB row. Once the div loses its header that stale row must
 * NOT hide the content (there is no toggle left to reopen it).
 * Driven for real: the section_group constructor + init + edit render.
 * Backend-free; the seeded IndexedDB rows are deleted after.
 */

import { data_manager } from '../../../core/common/js/data_manager.js';
import { section_group } from '../../../core/section_group/js/section_group.js';

describe('SECTION_GROUP: add_label', () => {
	const SECTION_TIPO = 'test3';
	const TIPO_DIV = 't128_div';
	const TIPO_GROUP = 't128_group';
	const TABLE = 'status';
	const key_of = (tipo) => `section_group_${SECTION_TIPO}_${tipo}`;

	const render = async (tipo, add_label) => {
		const instance = new section_group();
		instance.init({
			model: 'section_group',
			tipo: tipo,
			section_tipo: SECTION_TIPO,
			section_id: 1,
			mode: 'edit',
			lang: 'lg-eng',
			type: 'section_group',
			context: { label: 'Group ' + tipo, add_label: add_label },
		});
		const wrapper = await instance.edit({});
		return wrapper;
	};

	// collapse_toggle_track applies the persisted state after its own async read
	const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

	before(async () => {
		// a stale 'collapsed' row for both panels (what the TS-era header wrote)
		await data_manager.set_local_db_data({ id: key_of(TIPO_DIV), value: true }, TABLE);
		await data_manager.set_local_db_data({ id: key_of(TIPO_GROUP), value: true }, TABLE);
	});

	after(async () => {
		await data_manager.delete_local_db_data(key_of(TIPO_DIV), TABLE);
		await data_manager.delete_local_db_data(key_of(TIPO_GROUP), TABLE);
	});

	it('add_label false: no header, no_margin, content visible despite a stale collapsed row', async () => {
		const wrapper = await render(TIPO_DIV, false);
		await settle();
		assert.ok(wrapper.classList.contains('no_margin'), 'the div variant has no top margin');
		assert.equal(wrapper.querySelector(':scope > .label'), null, 'the div variant has no header');
		assert.ok(wrapper.content_data, 'content_data is exposed for section_record');
		assert.notOk(
			wrapper.content_data.classList.contains('hide'),
			'a stale collapsed row must not hide the div content',
		);
	});

	it('add_label true: labelled collapsible header, the persisted collapse state is honoured', async () => {
		const wrapper = await render(TIPO_GROUP, true);
		await settle();
		assert.notOk(wrapper.classList.contains('no_margin'));
		const label = wrapper.querySelector(':scope > .label.icon_arrow');
		assert.ok(label, 'a section_group has its collapse header');
		assert.equal(label.textContent, 'Group ' + TIPO_GROUP);
		assert.ok(
			wrapper.content_data.classList.contains('hide'),
			'the collapsed row keeps the group collapsed',
		);
	});
}); //end describe
