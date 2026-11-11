// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, beforeEach, afterEach, page_globals */
/*eslint no-undef: "error"*/

import { ApiError } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { component_text_area } from '../../../core/component_text_area/js/component_text_area.js';
import { view_note_text_area } from '../../../core/component_text_area/js/view_note_text_area.js';

/**
 * TEST_TM_NOTE_CREATE
 * The Time Machine note view creates its note through ONE server request (T0-4):
 * dd_component_text_area_api 'create_tm_note' carrying only the TM row's
 * matrix_id. The server creates the notes record AND binds it (the Code = the
 * TM row id) in one transaction; the client never sends a generic `create` nor
 * a `save` of the Code, and never names the notes section.
 *
 * The author comparison stays in the client as UX only (the server enforces it):
 * a non-author sends nothing. The author is the served `tm_user_id` — the TM
 * row's author, NOT `created_by_user_id` (the NOTE record's creator, F5).
 *
 * Backend-free: data_manager.request patched on the shared singleton.
 */

describe(`TM NOTE CREATE (one create_tm_note request)`, function () {
	this.timeout(10000);

	let original_request = null;
	let original_user_id;
	let requests = [];
	let answer = null;

	const ME = 947201;
	const SOMEONE_ELSE = 947202;
	const MATRIX_ID = 123456;

	/** A note-view-shaped component_text_area (view 'note', a TM list cell). */
	const make_self = (data) => {
		const self = new component_text_area();
		self.model = 'component_text_area';
		self.mode = 'list';
		self.view = 'note';
		self.section_tipo = 'dd15';
		self.data = data;
		self.caller = { locator: { user_id: data.tm_user_id } };
		return self;
	};

	beforeEach(() => {
		original_request = data_manager.request;
		original_user_id = page_globals.user_id;
		page_globals.user_id = ME;
		requests = [];
		answer = { ok: true, request_id: 'rq-tm-note', data: { section_id: 77 }, created: true };
		data_manager.request = async (options) => {
			requests.push(options.body);
			return answer;
		};
	});
	afterEach(() => {
		data_manager.request = original_request;
		page_globals.user_id = original_user_id;
	});

	it(`the author: ONE create_tm_note request with the matrix_id, nothing else`, async () => {
		const self = make_self({ matrix_id: MATRIX_ID, tm_user_id: ME, created_by_user_id: null });
		const section_id = await self.add_component_history_note({ matrix_id: MATRIX_ID });
		assert.equal(section_id, 77, 'the server-answered note id');
		assert.equal(requests.length, 1, 'exactly one request');
		const body = requests[0];
		assert.equal(body.action, 'create_tm_note');
		assert.equal(body.dd_api, 'dd_component_text_area_api');
		assert.deepEqual(body.options, { matrix_id: MATRIX_ID });
		assert.isUndefined(body.source, 'no section is named — the server owns the notes section');
		assert.isUndefined(body.data, 'no value is written by the client — the Code is the server’s');
		assert.notInclude(
			requests.map((r) => r.action),
			'save',
			'the old client save of the Code is gone',
		);
	});

	it(`a non-author sends nothing (UX guard; the server refuses anyway)`, async () => {
		const self = make_self({
			matrix_id: MATRIX_ID,
			tm_user_id: SOMEONE_ELSE,
			created_by_user_id: null,
		});
		const section_id = await self.add_component_history_note({ matrix_id: MATRIX_ID });
		assert.isNull(section_id);
		assert.equal(requests.length, 0, 'no request reached the server');
	});

	it(`the author is tm_user_id, never created_by_user_id (F5)`, async () => {
		// The served note-creator key names someone else: the TM row's author decides.
		const self = make_self({
			matrix_id: MATRIX_ID,
			tm_user_id: ME,
			created_by_user_id: SOMEONE_ELSE,
		});
		assert.equal(await self.add_component_history_note({ matrix_id: MATRIX_ID }), 77);
		assert.equal(requests.length, 1);
	});

	it(`a refused create answers null (never a fabricated id)`, async () => {
		answer = {
			ok: false,
			request_id: 'rq-tm-note',
			error: new ApiError({
				code: 'perm.denied',
				status: 403,
				request_id: 'rq-tm-note',
				source: 'envelope',
			}),
		};
		const self = make_self({ matrix_id: MATRIX_ID, tm_user_id: ME, created_by_user_id: null });
		assert.isNull(await self.add_component_history_note({ matrix_id: MATRIX_ID }));
		assert.equal(requests.length, 1);
	});

	it(`the note view's click sends ONE create_tm_note when the row has no note`, async () => {
		// Refused, so the view stops before building the modal — the request is the assertion.
		answer = {
			ok: false,
			request_id: 'rq-tm-note',
			error: new ApiError({
				code: 'perm.denied',
				status: 403,
				request_id: 'rq-tm-note',
				source: 'envelope',
			}),
		};
		const self = make_self({
			entries: [],
			matrix_id: MATRIX_ID,
			parent_section_id: null,
			tm_user_id: ME,
			created_by_user_id: null,
		});
		const wrapper = await view_note_text_area.render(self, {});
		const button = wrapper.querySelector('.button.note');
		assert.isOk(button, 'the note icon');
		button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// the handler is async: let the patched request resolve
		for (let i = 0; i < 20 && requests.length === 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(
			requests.map((r) => r.action),
			['create_tm_note'],
			'one create_tm_note — no generic create, no save',
		);
		assert.deepEqual(requests[0].options, { matrix_id: MATRIX_ID });
	});
});
