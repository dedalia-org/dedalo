// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/

/**
 * TEST_UPDATE_DATA_VERSION
 * The Update-data panel never says "updated" about a database it cannot update
 * (T2 D08-b, WC-2026-11-19-data-version-unreachable).
 *
 * A Dédalo v6 database matches no update rung, so the server's value has
 * `update_version: null` — which the panel used to read as "nothing to do" and
 * render as "Data format is updated: 6.9.1". The server now adds `notice` to
 * that value; the panel must show it as an error, mark the widget card as
 * danger, and NOT print the "updated" sentence. Control: the same value without
 * `notice` is the genuine up-to-date state and keeps its bytes.
 *
 * Backend-free: the server's value shape is set on the instance; no get_value
 * round-trip. The widget card (the grandparent of the widget node, the element
 * set_widget_label_style paints) is built here.
 */

import { update_data_version } from '../../../core/area_maintenance/widgets/update_data_version/js/update_data_version.js';

// DOM container
const container = document.getElementById('content');

const NOTICE =
	'Not updated: the database is on data version 6.9.1, a Dédalo v6 database: this engine (7.0.0) has no update that starts from it';

/** The facts of that sentence (boot_state.ts dataVersionAdviceFacts). */
const NOTICE_DATA = {
	code: 'data_version_unreachable',
	installed: '6.9.1',
	engine: '7.0.0',
	installed_major: '6',
	engine_major: '7',
	doc: 'docs/install/migrating_from_v6.md',
};

/** Run `fn` with one label swapped in the served dictionary (restored after). */
const with_label = async (key, text, fn) => {
	const had = Object.hasOwn(get_label, key);
	const before = get_label[key];
	if (text === undefined) {
		delete get_label[key];
	} else {
		get_label[key] = text;
	}
	try {
		return await fn();
	} finally {
		if (had) {
			get_label[key] = before;
		} else {
			delete get_label[key];
		}
	}
};

/** The server's panel value when no rung matches (updateDataVersionPanel). */
const no_rung_value = (extra) => {
	return {
		update_version: null,
		current_version_in_db: [6, 9, 1],
		dedalo_version: [7, 0, 0],
		updates: null,
		...extra,
	};
};

/**
 * Render the panel's content inside a widget card:
 * card > body > widget node > content_data.
 */
const render_in_card = async (value) => {
	const card = document.createElement('div');
	const body = document.createElement('div');
	const node = document.createElement('div');
	card.appendChild(body);
	body.appendChild(node);
	container.appendChild(card);

	const self = new update_data_version();
	self.id = 'test_update_data_version';
	self.value = value;
	self.caller = null;
	self.events_tokens = [];
	self.node = node;

	const content_data = await self.list({ render_level: 'content' });
	node.appendChild(content_data);
	// the label style is applied in the next animation frame
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

	return { card, content_data };
};

describe('UPDATE_DATA_VERSION WIDGET', function () {
	this.timeout(10000);

	it('a database this engine cannot update: the notice as an error, the card danger, never "updated"', async () => {
		const { card, content_data } = await render_in_card(no_rung_value({ notice: NOTICE }));

		const error = content_data.querySelector('.info_text.error_text');
		assert.ok(error, 'the notice renders as an error text');
		assert.strictEqual(error.textContent, NOTICE, 'the server sentence, verbatim');
		assert.strictEqual(content_data.querySelector('.success_text'), null, 'no success text at all');
		assert.notInclude(
			content_data.textContent,
			'Data format is updated',
			'the panel must not say the data format is updated',
		);
		assert.isTrue(card.classList.contains('danger'), 'the widget card is marked danger');
		// the way out of the session stays
		assert.ok(content_data.querySelector('button.quit_button'), 'the Quit button renders');

		card.remove();
	});

	it('the notice is worded from the label catalog, in the reader language, with the server facts in its placeholders', async () => {
		// The served dictionary carries the key (labels_tripwire: defined in the master).
		assert.isString(get_label.update_data_notice_unreachable, 'the label is served');
		for (const slot of ['installed', 'engine', 'installed_major', 'engine_major', 'doc']) {
			assert.include(get_label.update_data_notice_unreachable, `\${${slot}}`, slot);
		}
		// A translated catalog entry: the panel prints THAT sentence, never the
		// server's English one, with every placeholder filled.
		const translated =
			'Sin actualizar: datos ${installed} (Dédalo v${installed_major}); este motor es ${engine} (v${engine_major}). Ver ${doc}';
		await with_label('update_data_notice_unreachable', translated, async () => {
			const { card, content_data } = await render_in_card(
				no_rung_value({ notice: NOTICE, notice_data: NOTICE_DATA }),
			);
			const error = content_data.querySelector('.info_text.error_text');
			assert.strictEqual(
				error.textContent,
				'Sin actualizar: datos 6.9.1 (Dédalo v6); este motor es 7.0.0 (v7). Ver docs/install/migrating_from_v6.md',
			);
			assert.isTrue(card.classList.contains('danger'), 'still danger');
			card.remove();
		});
	});

	it('no label for the notice (an older dictionary): the server sentence, verbatim', async () => {
		await with_label('update_data_notice_unreachable', undefined, async () => {
			const { card, content_data } = await render_in_card(
				no_rung_value({ notice: NOTICE, notice_data: NOTICE_DATA }),
			);
			assert.strictEqual(content_data.querySelector('.info_text.error_text').textContent, NOTICE);
			card.remove();
		});
	});

	it('facts without a sentence are no notice (the server sends both or neither)', async () => {
		const { card, content_data } = await render_in_card(
			no_rung_value({ notice_data: NOTICE_DATA }),
		);
		assert.ok(content_data.querySelector('.info_text.success_text'), 'the success text renders');
		card.remove();
	});

	it('control — no notice: the genuine up-to-date state keeps its sentence and is not danger', async () => {
		const value = no_rung_value({});
		value.current_version_in_db = [7, 0, 0];
		const { card, content_data } = await render_in_card(value);

		const success = content_data.querySelector('.info_text.success_text');
		assert.ok(success, 'the success text renders');
		// the served catalog sentence (whatever the reader's language), its version filled
		assert.strictEqual(
			success.textContent,
			get_label.update_data_format_updated.replace('${version}', '7.0.0'),
		);
		assert.include(success.textContent, '7.0.0');
		assert.notInclude(success.textContent, '${');
		assert.strictEqual(content_data.querySelector('.error_text'), null, 'no error text');
		assert.isFalse(card.classList.contains('danger'), 'the widget card is not danger');

		card.remove();
	});

	// The panel's own sentences come from the label catalog (owner ruling
	// 2026-11-20, follow-up 6): a swapped catalog entry is what prints.
	it('the three panel strings are served labels, with their placeholders', () => {
		assert.isString(get_label.update_data_format_updated, 'update_data_format_updated is served');
		assert.include(get_label.update_data_format_updated, '${version}');
		assert.isString(get_label.update_data_pending, 'update_data_pending is served');
		assert.include(get_label.update_data_pending, '${from}');
		assert.include(get_label.update_data_pending, '${to}');
		assert.isString(get_label.quit, 'quit is served');
	});

	it('up to date: the sentence and the Quit button print the catalog entries', async () => {
		const value = no_rung_value({});
		value.current_version_in_db = [7, 0, 0];
		await with_label('update_data_format_updated', 'Formato de datos al día (${version})', async () => {
			await with_label('quit', 'Salir de aquí', async () => {
				const { card, content_data } = await render_in_card(value);
				assert.strictEqual(
					content_data.querySelector('.info_text.success_text').textContent,
					'Formato de datos al día (7.0.0)',
				);
				assert.strictEqual(
					content_data.querySelector('button.quit_button').textContent,
					'Salir de aquí',
				);
				assert.notInclude(content_data.textContent, 'Data format is updated');
				assert.notInclude(content_data.textContent, 'Quit');
				card.remove();
			});
		});
	});

	it('an update is pending: the from → to sentence prints the catalog entry, both versions filled', async () => {
		const value = {
			update_version: [7, 0, 1],
			current_version_in_db: [7, 0, 0],
			dedalo_version: [7, 0, 1],
			updates: {},
		};
		await with_label('update_data_pending', 'Pendiente: de ${from} a ${to}', async () => {
			const { card, content_data } = await render_in_card(value);
			const info = content_data.querySelector('.info_text.error_text');
			assert.ok(info, 'the pending sentence renders as an error text');
			assert.strictEqual(info.textContent, 'Pendiente: de 7.0.0 a 7.0.1');
			assert.notInclude(content_data.textContent, 'To update data version');
			assert.isTrue(card.classList.contains('danger'), 'a pending update marks the card danger');
			card.remove();
		});
		// CONTROL: the served entry (no swap) — the same two versions, in the catalog's sentence.
		const { card, content_data } = await render_in_card(value);
		const info = content_data.querySelector('.info_text.error_text');
		assert.include(info.textContent, '7.0.0');
		assert.include(info.textContent, '7.0.1');
		assert.notInclude(info.textContent, '${');
		card.remove();
	});

	it('an empty notice is no notice (the key is a sentence or absent)', async () => {
		const value = no_rung_value({ notice: '' });
		const { card, content_data } = await render_in_card(value);

		assert.ok(content_data.querySelector('.info_text.success_text'), 'the success text renders');
		assert.strictEqual(content_data.querySelector('.error_text'), null, 'no error text');

		card.remove();
	});
});
