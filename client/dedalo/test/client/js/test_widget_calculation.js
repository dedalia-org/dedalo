// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_WIDGET_CALCULATION
 * The calculation widget renders a computed value as TEXT (T1-18).
 *
 * A calculation output is DATA — a number, a day/month/year string — never
 * markup (the server's CalculationValue type admits only number | date parts |
 * null). The renderer used to parse it (`inner_html: value` on the first render,
 * `element_value.innerHTML = value` on every update_widget_value event) and
 * parsed the ontology label_before the same way. Driven for real: the widget's
 * own constructor + init + edit render, and the live-update event it subscribes.
 * Backend-free: the value is handed in, as the component_info caller does.
 */

import { event_manager } from '../../../core/common/js/event_manager.js';
import { calculation } from '../../../core/widgets/calculation/js/calculation.js';

describe('WIDGET CALCULATION: values render as text', () => {
	const build_widget = async (id, value) => {
		const widget = new calculation();
		await widget.init({
			id: id,
			section_tipo: 'test3',
			section_id: 1,
			lang: 'lg-eng',
			mode: 'edit',
			value: value,
			ipo: [{ output: [{ id: 'total', label_before: '<i id="t118_label">L</i>' }] }],
			name: 'calculation',
			properties: null,
			caller: null,
		});
		const content_data = await widget.edit({ render_level: 'content' });
		return { widget, content_data };
	};

	it('the first render shows the value and label_before literally', async () => {
		const { widget, content_data } = await build_widget('t118_calc_a', [
			{ widget_id: 'total', key: 0, value: '<img src=x id=t118_calc>' },
		]);

		assert.equal(
			content_data.querySelector('#t118_calc'),
			null,
			'the value must not become an element',
		);
		assert.equal(
			content_data.querySelector('#t118_label'),
			null,
			'label_before must not become an element',
		);
		assert.equal(content_data.querySelector('.value').textContent, '<img src=x id=t118_calc>');
		assert.equal(
			content_data.querySelector('label.before').textContent,
			'<i id="t118_label">L</i>',
		);

		await widget.destroy(true, true, true);
	});

	it('a live update (update_widget_value) shows the value literally', async () => {
		const { widget, content_data } = await build_widget('t118_calc_b', [
			{ widget_id: 'total', key: 0, value: 3 },
		]);
		assert.equal(
			content_data.querySelector('.value').textContent,
			'3',
			'a number renders as its digits',
		);

		event_manager.publish('update_widget_value_0_t118_calc_b', [
			{ widget_id: 'total', key: 0, value: '<img src=x id=t118_calc_upd>' },
		]);

		assert.equal(
			content_data.querySelector('#t118_calc_upd'),
			null,
			'the updated value must not become an element',
		);
		assert.equal(content_data.querySelector('.value').textContent, '<img src=x id=t118_calc_upd>');

		event_manager.publish('update_widget_value_0_t118_calc_b', [
			{ widget_id: 'total', key: 0, value: 0 },
		]);
		assert.equal(
			content_data.querySelector('.value').textContent,
			'0',
			'zero is shown, not blanked',
		);

		await widget.destroy(true, true, true);
	});
}); //end describe
