// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert */
/*eslint no-undef: "error"*/

import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';

/**
 * PINNED RECORD VIEW — ONE SELECTOR PER READ
 *
 * An edit read can select its record in exactly one of two ways:
 *   - the PIN: `filter_by_locators` holding one locator — "this record";
 *   - the POSITION: `limit`/`offset` — "the K-th row of the found set".
 *
 * Both together are contradictory, not merely redundant: the pin narrows the
 * WHERE to one row, so `OFFSET >= 1` skips it and the edit form comes up EMPTY.
 * Measured on the suite database before the fix: a reload of
 * `?tipo=test3&id=<record>&mode=edit` sent `{limit:1, offset:2, pins:[record]}`
 * and answered zero rows ("No se han encontrado registros"), because
 * section.build restored the stored `${tipo}_edit` pagination (left behind by a
 * list→edit navigation) INTO the pinned sqo.
 *
 * The rule now: a single-pin sqo IS a record view — limit 1, offset 0, total 1,
 * and the stored pagination is neither read nor written. A page view (no pin) is
 * untouched. The same rule has two exits: `goto_list` drops the pin that names
 * the open record, and the session-SQO adoption must never erase a caller's
 * result set (a semantic search's ranked hits live in the same sqo).
 *
 * Real reads on the suite database (test3), so records come from the fixture
 * rather than hardcoded ids.
 */

describe('PINNED RECORD VIEW — pin and offset are exclusive', function () {
	this.timeout(60000);

	// the position a list→edit navigation stores under `${tipo}_edit`
	const STORED_PAGINATION = { limit: 1, offset: 3 };

	let list_instance = null;
	let record_id = null;
	let previous_pagination = null;

	before(async () => {
		// the record: the section's own list read names real records
		list_instance = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'list',
			id_variant: 'pinned_record_view_list',
		});
		await list_instance.build(true);

		record_id = list_instance.data?.entries?.[0]?.section_id ?? null;
		if (record_id === null) {
			throw new Error('test3 list returned no records — the suite fixture is missing');
		}

		// the stale position the section must NOT inject into a pinned read.
		// Saved and restored: this suite must not depend on run order.
		previous_pagination = await data_manager.get_local_db_data('test3_edit', 'pagination');
		await data_manager.set_local_db_data(
			{ id: 'test3_edit', value: STORED_PAGINATION },
			'pagination',
		);
	});

	after(async () => {
		if (previous_pagination) {
			await data_manager.set_local_db_data(
				{ id: 'test3_edit', value: previous_pagination.value },
				'pagination',
			);
		} else {
			await data_manager.delete_local_db_data('test3_edit', 'pagination');
		}

		if (list_instance) {
			await list_instance.destroy(true, true, true);
		}
	});

	it('a read that names its record ignores the stored pagination and resolves it', async () => {
		const instance = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			section_id: record_id,
			mode: 'edit',
			id_variant: 'pinned_record_view_edit',
		});

		try {
			await instance.build(true);

			assert.deepEqual(
				instance.rqo.sqo.filter_by_locators,
				[{ section_tipo: 'test3', section_id: record_id }],
				'the read must be pinned to the record',
			);
			assert.equal(
				instance.rqo.sqo.offset,
				0,
				'a record view has no position: offset must not be restored',
			);
			assert.equal(instance.rqo.sqo.limit, 1);
			assert.equal(instance.total, 1, 'a record view reports 1/1');
			assert.equal(
				String(instance.section_id),
				String(record_id),
				'the pinned record must resolve — a pin plus a restored offset comes back EMPTY',
			);
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('control — the same stored pagination IS applied to a page view', async () => {
		const instance = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'edit',
			id_variant: 'pinned_record_view_control',
		});

		try {
			await instance.build(true);

			assert.equal(
				instance.rqo.sqo.offset,
				STORED_PAGINATION.offset,
				'an unpinned edit view still restores its stored position (the seed is read)',
			);
			assert.isNotOk(
				instance.rqo.sqo.filter_by_locators?.length,
				'an unpinned view carries no pin',
			);
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it('a pin that arrives in the request_config (mini-record pen) is a record view too', async () => {
		// the shape view_mini_section_record.js publishes: the pin travels in the
		// sqo, and the source does NOT name the record
		const instance = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			mode: 'edit',
			id_variant: 'pinned_record_view_mini',
			request_config: [
				{
					api_engine: 'dedalo',
					type: 'main',
					sqo: {
						section_tipo: ['test3'],
						limit: 1,
						filter_by_locators: [{ section_tipo: 'test3', section_id: record_id }],
					},
				},
			],
		});

		try {
			await instance.build(true);

			assert.equal(
				instance.rqo.sqo.offset,
				0,
				'a pin in the sqo is a record view: the stored offset must not be injected beside it',
			);
			assert.equal(instance.total, 1);
			assert.equal(
				String(instance.section_id),
				String(record_id),
				'the pinned record must resolve (the source never named it)',
			);
		} finally {
			await instance.destroy(true, true, true);
		}
	});

	it("a caller's RESULT SET survives the rebuild (it is not a record pin)", async () => {
		// the shape search.js writes before navigating: the ranked hits as pins
		const hits = (list_instance.data?.entries ?? [])
			.slice(0, 3)
			.map((entry) => ({ section_tipo: 'test3', section_id: entry.section_id }));
		assert.equal(hits.length, 3, 'the fixture must hold at least 3 records');

		list_instance.rqo.sqo.filter_by_locators = hits;
		await list_instance.build(true);

		if (list_instance.context?.sqo_session) {
			assert.equal(
				list_instance.rqo.sqo,
				list_instance.context.sqo_session,
				"the session sqo IS the instance's live sqo — pagination mutates it in place, so it must stay the same object",
			);
		}
		assert.deepEqual(
			list_instance.rqo.sqo.filter_by_locators,
			hits,
			'a page view must never lose the result set it was asked to show',
		);
		assert.equal(
			(list_instance.data?.entries ?? []).length,
			hits.length,
			'the read must return exactly the pinned result set',
		);
	});

	it('goto_list drops the pin that names the open record', async () => {
		const instance = await get_instance({
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			section_id: record_id,
			mode: 'edit',
			id_variant: 'pinned_record_view_goto_list',
		});

		let published = null;
		const token = event_manager.subscribe('user_navigation', (options) => {
			published = options;
		});

		try {
			await instance.build(true);
			await instance.goto_list();

			assert.isOk(published, 'goto_list must publish a user_navigation');
			assert.isNotOk(
				published.sqo.filter_by_locators?.length,
				'the list is a different view: the record pin must not ride along (a one-row list)',
			);
			assert.equal(published.sqo.limit, 10, 'the list restores its own page size');
		} finally {
			event_manager.unsubscribe(token);
			await instance.destroy(true, true, true);
		}
	});

	it('a Time Machine read is a page view: its one locator names a HISTORY (inspector component history)', async () => {
		// the shape render_inspector.js load_component_history sends. Taken as a
		// pin, build forced limit 1 and the next refresh (closing a TM note) listed
		// only the newest row.
		const instance = await get_instance({
			model: 'section',
			tipo: 'dd15',
			section_tipo: 'dd15',
			mode: 'list',
			id_variant: 'pinned_record_view_tm',
			session_save: false,
			request_config: [
				{
					api_engine: 'dedalo',
					type: 'main',
					sqo: {
						mode: 'tm',
						section_tipo: ['test3'],
						limit: 10,
						offset: 0,
						filter_by_locators: [
							{ section_tipo: 'test3', section_id: record_id, tipo: 'test17', lang: 'lg-spa' },
						],
					},
					show: {},
				},
			],
		});

		try {
			// two reads: the second is what a refresh sends
			await instance.build(true);
			await instance.build(true);

			assert.equal(instance.rqo.sqo.limit, 10, 'a re-read must keep the history page size');
			assert.equal(instance.rqo.sqo.offset, 0);
		} finally {
			await instance.destroy(true, true, true);
		}
	});
});

// @license-end
