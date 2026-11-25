// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, afterEach, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_SECTION_COLOR_STRIPE
 * The client half of WC-2026-11-25-section-context-color (the server half:
 * test/unit/section_context_color_native.test.ts). A section context `color`
 * marks the list body (`apply_section_color`, the helper the real
 * view_default_list_section.render calls) and the REAL main.css paints it:
 *   - desktop/print (1200px frame): a 4px border-left on the Id header cell and
 *     on every built row's Id cell — not on placeholders (their red inset stripe
 *     means "build failed");
 *   - phone (360px frame): the 4px border runs down the whole card edge.
 * No colour → no class, no var, no border.
 *
 * Backend-free: a synthetic list body with the real classes.
 */

import { apply_section_color } from '../../../core/section/js/view_default_list_section.js';
import { open_css_frame } from './css_fixture_frame.js';

// A root token, not a hex: test files are in colour_literal_ratchet's JS corpus.
// apply_section_color passes any CSS colour through, so the token proves the same path.
const SECTION_COLOR = 'var(--color_orange_dedalo)';

/** The computed paint of SECTION_COLOR in a frame (resolved by the frame's real main.css). */
const computed_color = (frame) => {
	const probe = frame.doc.createElement('div');
	probe.style.color = SECTION_COLOR;
	frame.container.appendChild(probe);
	const color = frame.win.getComputedStyle(probe).color;
	probe.remove();
	assert.notEqual(color, '', 'token resolves');
	return color;
};

let desktop = null;
let phone = null;

/** A minimal `.list_body.layout_table`: Id header + one built row + one placeholder. */
const make_list = (doc) => {
	const el = (class_name, parent, text) => {
		const node = doc.createElement('div');
		node.className = class_name;
		if (text) node.textContent = text;
		if (parent) parent.appendChild(node);
		return node;
	};
	const list_body = el('list_body layout_table');
	list_body.style.gridTemplateColumns = '4rem 1fr';
	const header = el('header_wrapper_list', list_body);
	const head_id = el('head_column section_id', header, 'Id');
	el('head_column test2', header, 'Title');
	const content_data = el('content_data list section', list_body);
	const row = el('section_record list', content_data);
	const id_cell = el('column column_section_id', row);
	el('button_edit', id_cell, '1');
	el('column column_test2', row, 'A');
	const placeholder = el('section_record placeholder', content_data);
	return { list_body, head_id, row, id_cell, placeholder };
};

const border = (win, node) => {
	const style = win.getComputedStyle(node);
	return {
		width: style.borderLeftWidth,
		color: style.borderLeftColor,
		kind: style.borderLeftStyle,
	};
};

describe('SECTION COLOR STRIPE — the list mark of the section identifying colour', () => {
	before(async function () {
		this.timeout(30000);
		desktop = await open_css_frame(1200, 'container section_color_stripe');
		phone = await open_css_frame(360, 'container section_color_stripe');
	});

	afterEach(() => {
		desktop?.container.replaceChildren();
		phone?.container.replaceChildren();
	});

	after(() => {
		desktop?.frame.remove();
		phone?.frame.remove();
	});

	it('marks the list body with the class and the custom property', () => {
		const list = make_list(desktop.doc);
		apply_section_color(list.list_body, SECTION_COLOR);
		assert.isTrue(list.list_body.classList.contains('has_section_color'));
		assert.equal(list.list_body.style.getPropertyValue('--section_color'), SECTION_COLOR);
	});

	it('leaves the list body untouched without a colour', () => {
		for (const color of [undefined, null, '']) {
			const list = make_list(desktop.doc);
			apply_section_color(list.list_body, color);
			assert.isFalse(list.list_body.classList.contains('has_section_color'), String(color));
			assert.equal(list.list_body.style.getPropertyValue('--section_color'), '', String(color));
		}
	});

	it('desktop: paints a 4px stripe on the Id header and the Id cell, not on placeholders', () => {
		const list = make_list(desktop.doc);
		apply_section_color(list.list_body, SECTION_COLOR);
		desktop.container.appendChild(list.list_body);
		for (const [name, node] of [
			['header', list.head_id],
			['id cell', list.id_cell],
		]) {
			assert.deepEqual(
				border(desktop.win, node),
				{ width: '4px', color: computed_color(desktop), kind: 'solid' },
				name,
			);
		}
		// the stripe follows the list body's rounded top-left corner
		assert.equal(
			desktop.win.getComputedStyle(list.head_id).borderTopLeftRadius,
			desktop.win.getComputedStyle(list.list_body).borderTopLeftRadius,
		);
		assert.notEqual(desktop.win.getComputedStyle(list.head_id).borderTopLeftRadius, '0px');
		// the row card edge is a phone rule only
		assert.equal(border(desktop.win, list.row).width, '0px');
		assert.equal(border(desktop.win, list.placeholder).width, '0px');
	});

	it('phone: paints the whole card edge instead', () => {
		const list = make_list(phone.doc);
		apply_section_color(list.list_body, SECTION_COLOR);
		phone.container.appendChild(list.list_body);
		assert.deepEqual(border(phone.win, list.row), {
			width: '4px',
			color: computed_color(phone),
			kind: 'solid',
		});
		assert.equal(border(phone.win, list.id_cell).width, '0px');
		assert.equal(border(phone.win, list.placeholder).width, '0px');
	});

	it('paints nothing on an uncoloured list (desktop and phone)', () => {
		for (const frame of [desktop, phone]) {
			const list = make_list(frame.doc);
			apply_section_color(list.list_body, null);
			frame.container.appendChild(list.list_body);
			for (const node of [list.head_id, list.id_cell, list.row]) {
				assert.equal(border(frame.win, node).width, '0px', node.className);
			}
		}
	});
});

// @license-end
