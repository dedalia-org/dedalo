// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_TOOL_IMPORT_ZOTERO
 * Client-side coverage for the Zotero bibliographic-import tool.
 *
 * The tool's deeper build/render path needs a live caller section plus the
 * service_upload (multi-file queue mode) and service_tmp_section instances, none of which are
 * guaranteed in the headless harness. This suite therefore asserts the
 * reliable, fixture-free contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 */

import { render_import_report } from '../../../tools/tool_import_zotero/js/render_tool_import_zotero.js';
import { tool_import_zotero } from '../../../tools/tool_import_zotero/js/tool_import_zotero.js';

describe('TOOL_IMPORT_ZOTERO CLIENT TEST', function () {
	this.timeout(10000);

	it('module exports the tool constructor', () => {
		assert.equal(
			typeof tool_import_zotero,
			'function',
			'expected tool_import_zotero to be a constructor function',
		);
	});

	it('construct seeds the documented instance properties', () => {
		const instance = new tool_import_zotero();

		assert.equal(typeof instance, 'object', 'expected instance to be an object');
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null');
		assert.equal(instance.model, null, 'expected model null');
		assert.equal(instance.mode, null, 'expected mode null');
		assert.equal(instance.node, null, 'expected node null');
		assert.equal(instance.caller, null, 'expected caller null');
		assert.equal(instance.key_dir, null, 'expected key_dir null');
		assert.equal(instance.service_upload, null, 'expected service_upload null');
		assert.equal(instance.service_tmp_section, null, 'expected service_tmp_section null');
		// files_data is seeded as an empty array
		assert.ok(Array.isArray(instance.files_data), 'expected files_data to be an array');
	});

	it('prototype is wired with the lifecycle methods', () => {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_import_zotero.prototype.render, 'function', 'expected render wired');
		assert.equal(typeof tool_import_zotero.prototype.destroy, 'function', 'expected destroy wired');
		assert.equal(typeof tool_import_zotero.prototype.refresh, 'function', 'expected refresh wired');
		// render mode delegated to render_tool_import_zotero
		assert.equal(typeof tool_import_zotero.prototype.edit, 'function', 'expected edit wired');
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_import_zotero.prototype.init, 'function', 'expected init defined');
		assert.equal(typeof tool_import_zotero.prototype.build, 'function', 'expected build defined');
	});

	it('the import report renders every line as TEXT (T1-7)', () => {
		const parent = document.createElement('div');
		const node = render_import_report(
			{
				summary: 'Zotero import done. Created 1, updated 0, 1 failed.',
				failed: [
					{
						section_id: 7,
						component_tipo: 'test91',
						msg: "IGNORED: the CSL type '<b>x</b>' has no entry",
					},
				],
				errors: ['broken.json: not valid JSON'],
				attachments: ['missing.pdf: not imported'],
				notices: ['K1: call-number not applied'],
			},
			parent,
		);
		assert.ok(node, 'expected a report node');
		assert.equal(
			parent.querySelector('.import_summary').textContent,
			'Zotero import done. Created 1, updated 0, 1 failed.',
		);
		assert.equal(parent.querySelectorAll('.import_failed li').length, 1);
		assert.equal(parent.querySelectorAll('.import_errors li').length, 1);
		assert.equal(parent.querySelectorAll('.import_attachments li').length, 1);
		assert.equal(parent.querySelectorAll('.import_notices li').length, 1);
		// a value quoted from the file is text, never markup
		assert.equal(
			parent.querySelector('.import_failed b'),
			null,
			'expected no element from report text',
		);
		assert.ok(parent.querySelector('.import_failed li').textContent.includes('<b>x</b>'));
	});

	it('the call-number addresses are three separate lists, every line TEXT', () => {
		const parent = document.createElement('div');
		render_import_report(
			{
				summary: 'Zotero import done. Created 2, updated 1, 1 refused.',
				created_at_id: [12, 15],
				updated_at_id: [9],
				refused: [
					{
						item: 'K<i>9</i>',
						code: 'request.invalid_data',
						message: "call-number '<b>x</b>' is not a record number",
					},
				],
				failed: [],
				errors: [],
				attachments: [],
				notices: [],
			},
			parent,
		);
		assert.equal(
			parent.querySelector('.import_created_at_id li').textContent,
			'Created at their call-number id: 12, 15',
		);
		assert.equal(
			parent.querySelector('.import_updated_at_id li').textContent,
			'Updated at their call-number id: 9',
		);
		const refused = parent.querySelectorAll('.import_refused li');
		assert.equal(refused.length, 1);
		assert.equal(
			refused[0].textContent,
			"K<i>9</i>: call-number '<b>x</b>' is not a record number",
		);
		assert.equal(parent.querySelector('.import_refused b, .import_refused i'), null);
		// an empty list renders no group at all
		assert.equal(parent.querySelector('.import_failed'), null);
		assert.equal(parent.querySelector('.import_errors'), null);
	});

	it('no report (a refused or background response) renders nothing', () => {
		const parent = document.createElement('div');
		assert.equal(render_import_report(null, parent), null);
		assert.equal(render_import_report({ ok: true }, parent), null);
		assert.equal(parent.childNodes.length, 0);
	});
});

// @license-end
