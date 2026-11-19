// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, L */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS_ROMAN
 * LIVE MAP (tool_uca_maps_fixture.js): the Roman Empire panel, its three gazetteers (Pleiades,
 * Pelagios, DARE) and the suggestions they list as the user types.
 */

import {
	LIVE_SEARCH_DELAY_MS,
	populate_roman_results,
	refresh_roman_sources,
} from '../../../tools/tool_uca_maps/js/render_roman_empire.js';
import {
	add_roman_result,
	create_roman_objects,
	load_roman_capabilities,
	search_roman,
} from '../../../tools/tool_uca_maps/js/roman_empire.js';
import { roman_min_query } from '../../../tools/tool_uca_maps/js/roman_min_query.js';
import {
	roman_feature,
	roman_hit,
	tick,
	two_frames,
	until,
	use_live_map,
	WITH_PLEIADES,
	with_tool_css,
} from './tool_uca_maps_fixture.js';

// without the tool CSS a panel never scrolls: give it the cap it lacks
const make_panel_scrollable = function (panel) {
	panel.style.maxHeight = '160px';
	panel.style.overflowY = 'auto';
};

describe('TOOL_UCA_MAPS (live map: roman)', function () {
	this.timeout(20000);

	let geolocation, tool;
	const {
		wire_tool_by_hand,
		stub_tool_request,
		active_group,
		mount_roman,
		open_roman,
		seed_roman_list,
	} = use_live_map((mounted) => ({ geolocation, tool } = mounted));

	/**
	 * ROMAN EMPIRE (roman_empire.js) — three gazetteers searched from one
	 * centred panel; a hit becomes a REAL object of the record. No gazetteer is
	 * reached: the install's answer (mount_roman) and every search are stubbed.
	 */

	// a stubbed answer settles within SETTLE_MS; a wait shorter than the debounce
	// would pass "nothing travels" without the timer ever having fired
	const SETTLE_MS = 50;
	const AFTER_DEBOUNCE_MS = LIVE_SEARCH_DELAY_MS + SETTLE_MS;

	// a document without focus gets no focus events in Chrome: these gates fail
	// loudly on the runner's state first, never as a silent pending test
	const require_document_focus = function () {
		assert.isTrue(document.hasFocus(), 'the runner page has no focus: the focus gates cannot run');
	};

	it('attach_roman_empire adds exactly one button and one hidden panel, idempotently', function () {
		mount_roman();
		tool.attach_roman_empire(); // second call: a no-op, never a duplicate

		const map_container_node = geolocation.map.getContainer();
		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-roman-control').length,
			1,
			'expected exactly one Roma button',
		);
		assert.isOk(tool.roman_panel, 'expected the panel built');
		assert.equal(tool.roman_panel.hidden, true, 'expected the panel hidden by default');
		assert.equal(tool._roman_source, null, 'expected no list, so no source owning one');
	});

	it('the panel is centred, closes with ×, and shows the three sources AT ONCE in v6 order', function () {
		// all three at once, as v6's modal: a source selector would hide two
		mount_roman();

		const panel = tool.roman_panel;
		assert.isTrue(
			panel.classList.contains('uca-maps-panel-centered'),
			'expected the centred panel',
		);

		const sections = Array.from(panel.querySelectorAll('.uca-maps-roman-source'));
		assert.deepEqual(
			sections.map((one) => one.dataset.source),
			['pleiades', 'pelagios', 'dare'],
			'expected Pleiades, Pelagios, DARE',
		);
		for (const section of sections) {
			assert.equal(
				section.hidden,
				false,
				'expected every source visible: ' + section.dataset.source,
			);
			assert.equal(
				section.querySelectorAll('.uca-maps-roman-input').length,
				1,
				'expected one field per source',
			);
		}

		open_roman();
		assert.equal(panel.hidden, false);
		panel.querySelector('.uca-maps-panel-close').click();
		assert.equal(panel.hidden, true, 'expected × to close the panel');
	});

	it('Pleiades picks name or id with two radios, and the choice reaches the search', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool); // Pleiades enabled BEFORE it is driven

		const section = tool.roman_panel.querySelector('.uca-maps-roman-pleiades');
		const radios = section.querySelectorAll('.uca-maps-roman-pleiades-type input[type="radio"]');
		assert.equal(radios.length, 2, 'expected two radios, not a select');
		assert.isNotOk(section.querySelector('select'), 'expected no select in the Pleiades section');
		assert.equal(radios[0].name, radios[1].name, 'expected ONE radio group');
		assert.equal(radios[0].value, 'name');
		assert.isTrue(radios[0].checked, 'expected "by name" chosen by default, as in v6');

		const sent = [];
		stub_tool_request(async function (options) {
			sent.push(options);
			return { ok: true, data: { results: [] } };
		});

		radios[1].click();
		const input = section.querySelector('.uca-maps-roman-input');
		assert.isFalse(input.disabled, 'expected the Pleiades field enabled by its capability');
		input.value = '7';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick(SETTLE_MS);

		assert.equal(sent.length, 1, 'expected one search: an id of one digit is a query');
		assert.equal(sent[0].action, 'search_pleiades');
		assert.equal(sent[0].options.type, 'id', 'expected the checked radio forwarded');
	});

	it('two Roman panels on one page keep their own Pleiades choice: each radio group has its own name', async function () {
		mount_roman(WITH_PLEIADES);
		// a second tool on the same page, as when two records' maps are open at once
		const other = wire_tool_by_hand(geolocation);
		other.get_capabilities = async () => ({
			ok: true,
			data: { gazetteers: structuredClone(WITH_PLEIADES) },
		});
		other.attach_roman_empire();
		try {
			const radios = (owner) =>
				owner.roman_panel.querySelectorAll('.uca-maps-roman-pleiades-type input[type="radio"]');
			assert.notEqual(
				radios(tool)[0].name,
				radios(other)[0].name,
				'expected one group name per panel',
			);

			radios(other)[1].click();
			assert.isTrue(radios(other)[1].checked, 'expected the second panel searching by id');
			assert.isTrue(radios(tool)[0].checked, 'expected the first panel still searching by name');
		} finally {
			await other.destroy(false, false, false);
		}
	});

	it('search_roman refuses an empty query, and Pelagios with no layer, without asking the server', async function () {
		mount_roman();

		let asked = false;
		stub_tool_request(async function () {
			asked = true;
			return {};
		});

		const empty = await search_roman(tool, 'pleiades', { query: '   ' });
		assert.equal(empty.ok, false, 'expected a caller-fault verdict');
		assert.isOk(empty.error, 'expected a message to show in the panel');

		const no_layer = await search_roman(tool, 'pelagios', { query: 'Gades', datasets: [] });
		assert.equal(no_layer.ok, false, 'expected Pelagios with no layer refused');
		assert.isOk(no_layer.error);

		assert.equal(asked, false, 'expected NO request in either case');
	});

	it('each source sends its OWN action and its own fields', async function () {
		mount_roman();

		const sent = [];
		stub_tool_request(async function (options) {
			sent.push(options);
			return { ok: true, data: { results: [] } };
		});

		await search_roman(tool, 'pleiades', { query: 'Gades', type: 'id' });
		await search_roman(tool, 'pelagios', { query: 'Gades', datasets: ['provinces'] });
		await search_roman(tool, 'dare', {
			query: 'Gades',
			name_type: 'ass',
			type_id: '11',
			country: 'ES',
		});

		assert.deepEqual(
			sent.map((one) => one.action),
			['search_pleiades', 'search_pelagios', 'search_dare'],
		);
		assert.equal(sent[0].options.type, 'id', 'expected the Pleiades search type forwarded');
		assert.equal(sent[0].options.value, 'Gades');
		assert.deepEqual(
			sent[1].options.datasets,
			['provinces'],
			'expected the chosen layers forwarded',
		);
		assert.equal(sent[2].options.name_type, 'ass');
		assert.equal(sent[2].options.type_id, '11');
		assert.equal(sent[2].options.country, 'ES');
	});

	it('the hits render one clickable row each, and a row DRAWS the place on the map', async function () {
		mount_roman();
		// open: a list never shows over a closed panel
		open_roman();

		stub_tool_request(async function () {
			return {
				ok: true,
				data: { results: [roman_hit('Gades', 36.53, -6.29), roman_hit('Gadir', 36.54, -6.3)] },
			};
		});

		const result = await search_roman(tool, 'dare', { query: 'Gad', name_type: 'mss' });
		assert.equal(result.ok, true);
		assert.equal(result.results.length, 2);
		assert.equal(tool._roman_source, 'dare', 'expected the list to know which source found it');

		populate_roman_results(tool, tool.roman_panel);
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button');
		assert.equal(rows.length, 2, 'expected one row per hit');
		assert.include(rows[0].textContent, 'Gades');
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the suggestion list open');

		// unlike the place search (which only moves the view), adding a hit
		// creates a real object through the SAME pm:create door every import
		// in this tool uses
		const feature_group = active_group();
		const before = feature_group.getLayers().length;
		const added = await add_roman_result(tool, 0);
		assert.equal(added.ok, true, 'expected the place added');
		assert.equal(added.created, 1, 'expected exactly one layer created');
		assert.equal(
			feature_group.getLayers().length,
			before + 1,
			'expected one more object in the active FeatureGroup',
		);
	});

	it('a hit whose geometry Leaflet cannot build is reported, never a silent success', async function () {
		mount_roman();

		tool._roman_results = [
			{ name: 'no geometry', feature: { type: 'Feature', properties: {}, geometry: null } },
		];
		const added = await add_roman_result(tool, 0);

		assert.equal(added.ok, false, 'expected a failure verdict');
		assert.isOk(added.error, 'expected a message for the panel');
	});

	it('a Pleiades hit carries only an id, so its geometry is fetched before drawing', async function () {
		mount_roman();

		// captured, asserted after: add_roman_result's catch would swallow an
		// assertion thrown inside the stub
		let asked = null;
		stub_tool_request(async function (options) {
			asked = options;
			return {
				ok: true,
				data: {
					place: {
						type: 'FeatureCollection',
						features: [roman_feature('Gades', 36.53, -6.29)],
					},
				},
			};
		});

		tool._roman_results = [{ name: 'Gades', id: '256135' }];
		const added = await add_roman_result(tool, 0);

		assert.isOk(asked, 'expected the server asked for the geometry');
		assert.equal(asked.action, 'get_pleiades_place', 'expected the geometry fetched by id');
		assert.equal(asked.options.id, '256135', 'expected the hit id forwarded');
		assert.equal(added.ok, true);
		assert.equal(added.created, 1);
	});

	it('create_roman_objects fits the LARGEST geometry of a multi-part place, listed first or last', function () {
		mount_roman();

		const small = {
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[0, 0],
						[0.01, 0],
						[0.01, 0.01],
						[0, 0.01],
						[0, 0],
					],
				],
			},
		};
		const big = {
			type: 'Feature',
			properties: {},
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[10, 10],
						[12, 10],
						[12, 12],
						[10, 12],
						[10, 10],
					],
				],
			},
		};

		// both orders: "the last part wins" and "the first part wins" each fail one
		for (const [label, features] of [
			['first', [big, small]],
			['last', [small, big]],
		]) {
			// far from both parts and more than four zoom steps off either fit: Leaflet
			// then jumps without animating, so getBounds reads the fitted view at once
			geolocation.map.setView([-40, 120], 15, { animate: false });
			const created = create_roman_objects(tool, { type: 'FeatureCollection', features: features });
			assert.equal(created, 2, 'expected both parts created, the bigger listed ' + label);
			assert.isTrue(
				geolocation.map.getBounds().contains(L.latLng(11, 11)),
				'expected the map fitted to the bigger part, listed ' + label,
			);
		}
	});

	it('a source this install cannot serve stays in view, disabled and saying why', function () {
		mount_roman();

		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] };
		refresh_roman_sources(tool, tool.roman_panel);

		for (const source of ['pleiades', 'pelagios']) {
			const section = tool.roman_panel.querySelector('.uca-maps-roman-' + source);
			assert.equal(section.hidden, false, 'expected the section still shown: ' + source);
			assert.equal(
				section.querySelector('.uca-maps-roman-input').disabled,
				true,
				'expected its field disabled: ' + source,
			);
			assert.equal(
				section.querySelector('.uca-maps-roman-unavailable').hidden,
				false,
				'expected the missing-data reason shown, not silence: ' + source,
			);
		}
		const dare = tool.roman_panel.querySelector('.uca-maps-roman-dare');
		assert.equal(
			dare.querySelector('.uca-maps-roman-input').disabled,
			false,
			'expected DARE always available',
		);
		assert.equal(dare.querySelector('.uca-maps-roman-unavailable').hidden, true);
	});

	it('the layer checkboxes come from the INSTALL, never from a client-side copy of the list', async function () {
		mount_roman({ configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] });

		await load_roman_capabilities(tool);

		const boxes = tool.roman_panel.querySelectorAll('.uca-maps-roman-dataset-checkbox');
		assert.equal(boxes.length, 2, 'expected exactly the layers the install reported');
		assert.deepEqual(
			Array.from(boxes).map((box) => box.value),
			['provinces', 'roads_high'],
		);
		assert.isTrue(
			Array.from(boxes).every((box) => box.checked),
			'expected every layer selected by default',
		);
		const inputs = tool.roman_panel.querySelectorAll('.uca-maps-roman-input');
		assert.lengthOf(inputs, 3, 'expected one field per source: Pleiades, Pelagios, DARE');
		assert.isTrue(
			Array.from(inputs).every((input) => !input.disabled),
			'expected every source enabled when the install serves them all',
		);
	});

	// SUGGESTIONS AS YOU TYPE — v6 searches on every keyup in the three blocks
	// (`special_tools_roman_empire.js`); here a debounced input does.

	it('each source declares its minimum query: Pleiades 3 by name and 1 by id, Pelagios 2, DARE 3', function () {
		assert.equal(roman_min_query('pleiades', 'name'), 3, 'Pleiades by name: 3 (v6 strlen > 2)');
		assert.equal(roman_min_query('pleiades', 'id'), 1, 'an id is exact, one digit is a query');
		assert.equal(roman_min_query('pelagios'), 2, 'Pelagios: 2 (v6 strlen >= 2)');
		assert.equal(roman_min_query('dare'), 3, 'DARE: 3 (v6 strlen >= 3)');
	});

	it('typing searches by itself, and below the minimum nothing travels', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);
		open_roman(); // a list shows only over an open panel

		let asked = 0;
		stub_tool_request(async function () {
			asked++;
			return { ok: true, data: { results: [roman_hit('Gades', 36.53, -6.29)] } };
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');

		// below the minimum: no request, not even after the debounce window
		input.value = 'Ga';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 0, 'expected NO request for a query under the minimum');

		// at the minimum: one request, and the list renders itself
		input.value = 'Gades';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);

		assert.equal(asked, 1, 'expected exactly one request after typing');
		assert.equal(
			tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button').length,
			1,
			'expected the suggestion rendered without pressing anything',
		);
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open by itself');
	});

	// core's DARE service is a third party's, whose provider asks for no
	// as-you-type search: Enter is the gesture
	it('DARE searches on Enter only: typing sends nothing and closes an older list', async function () {
		mount_roman();
		open_roman(); // a list shows only over an open panel

		const asked = [];
		stub_tool_request(async function (options) {
			asked.push(options);
			return { ok: true, data: { results: [roman_hit('Gades', 36.53, -6.29)] } };
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		assert.equal(
			input.placeholder,
			'Place name, then Enter',
			'expected the field to say how it searches',
		);
		seed_roman_list('dare', [roman_hit('older', 0, 0)]);
		input.value = 'Gades';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);
		assert.deepEqual(asked, [], 'expected NO request while typing');
		assert.isNull(tool._roman_search_timer, 'expected no search waiting either');
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected the older list closed: it answers another name',
		);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick(SETTLE_MS);
		assert.equal(asked.length, 1, 'expected Enter to search, once');
		assert.equal(asked[0].action, 'search_dare');
		assert.equal(asked[0].options.query, 'Gades');
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the hits listed');
	});

	it("DARE's Search button searches like Enter, once, and hands the keys back to the field", async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const asked = [];
		stub_tool_request(async function (options) {
			asked.push(options);
			return { ok: true, data: { results: [roman_hit('Gades', 36.53, -6.29)] } };
		});

		for (const source of ['pleiades', 'pelagios']) {
			// the block must exist, or "no button in it" holds of nothing
			assert.isOk(
				tool.roman_panel.querySelector('.uca-maps-roman-' + source + ' .uca-maps-roman-input'),
				'expected the ' + source + ' block with its field',
			);
			assert.isNull(
				tool.roman_panel.querySelector(
					'.uca-maps-roman-' + source + ' .uca-maps-roman-search-button',
				),
				'expected no button on the as-you-type source ' + source,
			);
		}
		const block = tool.roman_panel.querySelector('.uca-maps-roman-dare');
		const input = block.querySelector('.uca-maps-roman-input');
		const button = block.querySelector('.uca-maps-roman-search-button');
		assert.isOk(button, "expected DARE's Search button");
		assert.equal(button.textContent, 'Search');
		assert.equal(button.type, 'button', 'expected a plain button, never a form submit');
		assert.equal(
			button.parentNode,
			input.parentNode,
			"expected the button on the field's own line",
		);

		input.value = 'Gades';
		button.click();
		await tick(SETTLE_MS);
		assert.equal(asked.length, 1, 'expected the button to search, once');
		assert.equal(asked[0].action, 'search_dare');
		assert.equal(asked[0].options.query, 'Gades');
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the hits listed');
		assert.equal(
			document.activeElement,
			input,
			'expected the focus back on the field, whose arrows walk the list',
		);
	});

	// a select's natural width (width auto) is its longest option plus its own
	// chrome: the real one at least that wide shows every option whole
	it('with the tool CSS, every DARE filter shows its longest option whole, on one line', async function () {
		await with_tool_css(async () => {
			mount_roman();
			open_roman();
			// the Spanish labels, the longest the tool ships for this select
			for (const option of tool.roman_panel.querySelectorAll(
				'.uca-maps-roman-dare-name-type option',
			)) {
				option.textContent =
					option.value === 'ass' ? 'Nombre de lugar antiguo' : 'Nombre de lugar moderno';
			}

			const selects = Array.from(
				tool.roman_panel.querySelectorAll('.uca-maps-roman-dare-filters select'),
			);
			assert.equal(selects.length, 3, 'expected name type, site type and country');
			for (const select of selects) {
				const natural = select.cloneNode(true);
				natural.style.cssText = 'flex: none; width: auto; position: absolute; visibility: hidden';
				select.parentNode.appendChild(natural);
				const needed = natural.offsetWidth;
				natural.remove();
				assert.isAbove(needed, 0, 'expected the probe laid out, or the comparison proves nothing');
				assert.isAtLeast(
					select.offsetWidth,
					needed,
					'expected ' +
						select.className +
						' wide enough for its longest option (needs ' +
						needed +
						'px)',
				);
			}
			const tops = new Set(selects.map((one) => one.offsetTop));
			assert.equal(tops.size, 1, 'expected the three filters on one line');
		});
	});

	it('a burst of keystrokes is ONE request, not one per character (v6 fires per keyup)', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);

		let asked = 0;
		stub_tool_request(async function () {
			asked++;
			return { ok: true, data: { results: [] } };
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		for (const value of ['Gad', 'Gade', 'Gades', 'Gadesx']) {
			input.value = value;
			input.dispatchEvent(new Event('input'));
			await tick(LIVE_SEARCH_DELAY_MS / 4); // well inside the debounce window
		}
		await tick(AFTER_DEBOUNCE_MS);

		assert.equal(asked, 1, 'expected the burst collapsed into a single request');
	});

	it('a slow early search never overwrites the results of the last one typed', async function () {
		mount_roman();

		let release_first;
		let call = 0;
		stub_tool_request(function () {
			call++;
			if (call === 1) {
				return new Promise((resolve) => {
					release_first = () =>
						resolve({ ok: true, data: { results: [roman_hit('STALE', 0, 0)] } });
				});
			}
			return Promise.resolve({ ok: true, data: { results: [roman_hit('FRESH', 1, 1)] } });
		});

		const first = search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' });
		const second = await search_roman(tool, 'pelagios', {
			query: 'Gadir',
			datasets: ['provinces'],
		});
		assert.equal(second.ok, true);
		assert.equal(second.results[0].name, 'FRESH');

		release_first();
		const stale = await first;

		assert.equal(stale.ok, false, 'expected the overtaken search to report nothing');
		assert.equal(tool._roman_results[0].name, 'FRESH', 'expected the newest results kept');
		assert.equal(
			tool._roman_source,
			'pelagios',
			'expected the list owned by the newest search, across fields',
		);
	});

	// THE TYPEAHEAD — the hits are a list anchored to the field, not a block
	// inside the panel, and choosing one IS adding it.

	it('the suggestion list hangs from the MAP, not from the panel (the panel would clip it)', function () {
		mount_roman();

		const map_container_node = geolocation.map.getContainer();
		assert.isOk(tool.roman_dropdown, 'expected the list built');
		assert.equal(tool.roman_dropdown.hidden, true, 'expected it closed until something is typed');
		assert.equal(
			tool.roman_dropdown.parentNode,
			map_container_node,
			'expected it parented to the map container',
		);
		assert.isNotOk(
			tool.roman_panel.querySelector('.uca-maps-roman-dropdown'),
			'expected it OUTSIDE the panel, whose overflow would clip it',
		);
	});

	it('the arrows walk the list and Enter draws the highlighted place', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);
		open_roman(); // a list shows only over an open panel

		stub_tool_request(async function () {
			return {
				ok: true,
				data: { results: [roman_hit('first', 36.5, -6.2), roman_hit('second', 39.9, -0.2)] },
			};
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		input.value = 'Gades';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);

		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button');
		assert.equal(rows.length, 2);
		assert.equal(
			tool._roman_active_index,
			-1,
			'expected nothing highlighted until the user walks the list',
		);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(tool._roman_active_index, 1, 'expected the second row highlighted');
		assert.isTrue(
			rows[1].classList.contains('is-active'),
			'expected the highlight in the DOM, not only in a flag',
		);

		const feature_group = active_group();
		const before = feature_group.getLayers();

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick(SETTLE_MS);

		const drawn = feature_group.getLayers().filter((layer) => !before.includes(layer));
		assert.equal(drawn.length, 1, 'expected Enter to draw one place');
		const at = drawn[0].getLatLng();
		assert.closeTo(
			at.lat,
			39.9,
			1e-6,
			'expected the highlighted "second" drawn, not the first row',
		);
		assert.closeTo(
			at.lng,
			-0.2,
			1e-6,
			'expected the highlighted "second" drawn, not the first row',
		);
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed after choosing');
	});

	it('Escape closes the list without clearing what was typed', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);
		open_roman(); // a list shows only over an open panel

		stub_tool_request(async function () {
			return { ok: true, data: { results: [roman_hit('Gades', 36.5, -6.2)] } };
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		input.value = 'Gades';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(tool.roman_dropdown.hidden, false);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed');
		assert.equal(input.value, 'Gades', 'expected the typed text untouched');
		assert.equal(tool._roman_active_index, -1, 'expected the highlight forgotten');
	});

	it('a click on the map closes the list, and closing the panel takes it with it', async function () {
		mount_roman();
		const map_container_node = geolocation.map.getContainer();
		map_container_node.querySelector('.uca-maps-roman-control').click(); // open the panel, as a user would
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)]);
		assert.equal(tool.roman_dropdown.hidden, false);

		map_container_node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a click outside to close it');

		// and a SIBLING panel forcing the Roma panel shut must close it too —
		// that path is toolbar.js's on_hide, not the click-outside listener:
		// Leaflet stops mousedown propagation inside its own controls, so the
		// map-level listener never sees a click on another tool button
		populate_roman_results(tool, tool.roman_panel);
		assert.equal(tool.roman_dropdown.hidden, false);
		tool.attach_object_viewer();
		map_container_node.querySelector('.uca-maps-object-viewer-control').click();
		assert.equal(
			tool.roman_panel.hidden,
			true,
			'expected the Roma panel forced shut by its sibling',
		);
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected the sibling panel to close the list as well',
		);
	});

	it('teardown cancels a pending as-you-type search instead of firing it into a dead panel', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);

		let asked = 0;
		stub_tool_request(async function () {
			asked++;
			return { ok: true, data: { results: [] } };
		});

		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		input.value = 'Gades';
		input.dispatchEvent(new Event('input'));

		assert.isOk(tool._roman_search_timer, 'expected the search waiting out the debounce');
		await tool.destroy(false, false, false); // BEFORE the debounce window elapses
		// the dead tool also refuses a late search, so only the timer shows the cancel
		assert.isNull(tool._roman_search_timer, 'expected teardown to clear the waiting timer');
		await tick(AFTER_DEBOUNCE_MS);

		assert.equal(asked, 0, 'expected the pending search cancelled by teardown');
	});

	it('scrolling the panel carries the list with its field, and closes it once the field leaves the view', function () {
		mount_roman();
		open_roman();
		const panel = tool.roman_panel;
		make_panel_scrollable(panel);

		// DARE's field in the middle of the view, then the list opened under it
		const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		panel.scrollTop +=
			input.getBoundingClientRect().top -
			panel.getBoundingClientRect().top -
			panel.clientHeight / 2;
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)]);
		const anchored_top = tool.roman_dropdown.style.top;

		panel.scrollTop -= 20;
		panel.dispatchEvent(new Event('scroll'));
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			'expected a scroll that keeps the field in view to keep the list',
		);
		assert.notEqual(
			tool.roman_dropdown.style.top,
			anchored_top,
			'expected the list moved with its field',
		);
		const container_top = tool.roman_dropdown.parentNode.getBoundingClientRect().top;
		assert.equal(
			tool.roman_dropdown.style.top,
			Math.round(input.getBoundingClientRect().bottom - container_top + 2) + 'px',
			'expected the list right under its field',
		);

		panel.scrollTop = 0; // DARE is the last source: its field is now below the view
		panel.dispatchEvent(new Event('scroll'));
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected the list closed once its field left the view',
		);
	});

	// the panel is centred: a new map width moves it, and the list must follow its field
	it('the map changing size moves the centred panel and the open list follows its field', async function () {
		await with_tool_css(async () => {
			mount_roman();
			open_roman();
			await two_frames(); // the capabilities answer resets the panel: the list opens after it
			const panel = tool.roman_panel;
			// DARE: always served, and the field the panel opens on. A source without local
			// data is disabled, so a short panel scrolls past it and its list rightly stays shut
			const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
			seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)]);
			await two_frames();
			assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open under its field');
			const before = tool.roman_dropdown.style.left;

			const container = tool.roman_dropdown.parentNode;
			const width = container.style.width;
			try {
				// wider, not narrower: below the panel's own width it spans the map at a fixed margin
				container.style.width = container.getBoundingClientRect().width + 400 + 'px';
				await until(() => tool.roman_dropdown.style.left !== before);
				assert.equal(tool.roman_dropdown.hidden, false, 'expected the list kept open');
				assert.notEqual(
					tool.roman_dropdown.style.left,
					before,
					'expected the wider map to move the list',
				);
				assert.equal(
					tool.roman_dropdown.style.left,
					Math.round(input.getBoundingClientRect().left - container.getBoundingClientRect().left) +
						'px',
					'expected the list right under its field again',
				);
			} finally {
				container.style.width = width;
			}
		});
	});

	// hiding a message at the panel's bottom makes the browser clamp scrollTop
	// and fire `scroll`, which must not close the list nor drop its search
	it('a scroll the layout causes by itself never closes the list it just opened', async function () {
		mount_roman();
		open_roman();
		const panel = tool.roman_panel;
		make_panel_scrollable(panel);

		const block = panel.querySelector('.uca-maps-roman-dare');
		const input = block.querySelector('.uca-maps-roman-input');
		const message = block.querySelector('.uca-maps-roman-message');
		stub_tool_request(async function () {
			return { ok: true, data: { results: [roman_hit('Gades', 36.5, -6.2)] } };
		});

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); // empty: an error under DARE
		await tick(SETTLE_MS);
		assert.equal(message.hidden, false, 'expected the empty-query message under DARE');

		panel.scrollTop = panel.scrollHeight; // at the bottom: hiding that message has to clamp
		const bottom = panel.scrollTop;
		let scrolls = 0;
		panel.addEventListener('scroll', () => scrolls++);

		input.value = 'Gades';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick(SETTLE_MS);
		await two_frames();

		assert.equal(message.hidden, true, 'expected the message cleared by the hits');
		assert.isBelow(
			panel.scrollTop,
			bottom,
			'expected the browser to clamp scrollTop — else this gate proves nothing',
		);
		assert.isAbove(scrolls, 0, 'expected the clamp to fire scroll — else this gate proves nothing');
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			'expected the list still open after the layout scroll',
		);
	});

	// the panel swallows mousedown before it bubbles to the map's listener, so a
	// click inside it needs its own check
	it("a click inside the panel, on another source's field, closes the list", async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool); // Pleiades enabled BEFORE it is driven
		open_roman();
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);

		const own_input = tool.roman_panel.querySelector(
			'.uca-maps-roman-pleiades .uca-maps-roman-input',
		);
		const other_input = tool.roman_panel.querySelector(
			'.uca-maps-roman-dare .uca-maps-roman-input',
		);

		own_input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			"expected a click in the list's own field to keep it open",
		);

		other_input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			"expected a click in another source's field to close it",
		);
	});

	it('a search still in flight never opens its list once the user has moved to another field', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman(); // open: a closed panel hides any list anyway

		let release_first;
		stub_tool_request(function () {
			return new Promise((resolve) => {
				release_first = () =>
					resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } });
			});
		});

		const pleiades_input = tool.roman_panel.querySelector(
			'.uca-maps-roman-pleiades .uca-maps-roman-input',
		);
		const dare_input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');

		pleiades_input.value = 'Rom';
		pleiades_input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS); // the Pleiades search is now in flight

		dare_input.value = 'V'; // below DARE's minimum: nothing travels, the list is closed
		dare_input.dispatchEvent(new Event('input'));

		release_first();
		await tick(SETTLE_MS);

		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected the late Pleiades answer NOT to open its list',
		);
		assert.equal(tool._roman_results, null, 'expected the late answer discarded');
	});

	it('a search refused before travelling still outdates the older one in flight', async function () {
		mount_roman();

		let release_first;
		stub_tool_request(function () {
			return new Promise((resolve) => {
				release_first = () => resolve({ ok: true, data: { results: [roman_hit('STALE', 0, 0)] } });
			});
		});

		const first = search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' });
		const refused = await search_roman(tool, 'pelagios', { query: 'Gadir', datasets: [] });
		assert.equal(refused.ok, false, 'expected Pelagios with no layer refused');

		release_first();
		const stale = await first;

		assert.equal(stale.ok, false, 'expected the older search outdated by the refused one');
		assert.equal(tool._roman_results, null, 'expected no stale list kept');
	});

	// every opening starts clean, as v6 rebuilds its modal on every click
	// (special_tools_roman_empire.js)
	it('reopening the panel starts clean: fields, messages, list and filters', async function () {
		mount_roman({ configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] });
		await load_roman_capabilities(tool);

		const control = geolocation.map.getContainer().querySelector('.uca-maps-roman-control');
		const panel = tool.roman_panel;
		control.click(); // open

		for (const input of panel.querySelectorAll('.uca-maps-roman-input')) {
			input.value = 'Gades';
		}
		panel.querySelector('.uca-maps-roman-pleiades-type input[value="id"]').checked = true;
		for (const select of panel.querySelectorAll('.uca-maps-roman-dare-filters select')) {
			select.selectedIndex = 1;
		}
		panel.querySelector('.uca-maps-roman-dataset-checkbox').checked = false;
		const message = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-message');
		message.textContent = 'an old error';
		message.hidden = false;
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)]);

		control.click(); // close
		control.click(); // reopen

		const inputs = panel.querySelectorAll('.uca-maps-roman-input');
		assert.lengthOf(inputs, 3, 'expected the three source fields');
		for (const input of inputs) {
			assert.equal(input.value, '', 'expected every field empty on reopening');
		}
		assert.isTrue(
			panel.querySelector('.uca-maps-roman-pleiades-type input[value="name"]').checked,
			'expected Pleiades back to "by name"',
		);
		const selects = panel.querySelectorAll('.uca-maps-roman-dare-filters select');
		assert.lengthOf(selects, 3, 'expected the three DARE filters');
		for (const select of selects) {
			assert.equal(select.selectedIndex, 0, 'expected every DARE filter back to its first option');
		}
		const boxes = panel.querySelectorAll('.uca-maps-roman-dataset-checkbox');
		assert.lengthOf(boxes, 2, 'expected the two Pelagios layers the install reported');
		for (const box of boxes) {
			assert.isTrue(box.checked, 'expected every Pelagios layer checked again');
		}
		assert.equal(message.hidden, true, 'expected the old message gone');
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list open');
		assert.equal(tool._roman_results, null, 'expected the old hits forgotten');
	});

	// a label stretched across its grid cell turns the blank space beside the
	// name into a click that toggles the layer
	it('the twelve Pelagios layers show with no inner scroll, each on one line and only as wide as its box and name', async function () {
		// with the tool CSS or not at all: without it the list is a plain block that
		// never scrolls, and a <label> is inline and already this narrow
		await with_tool_css(async () => {
			mount_roman({
				configured: true,
				pleiades: true,
				pelagios: [
					'places_high',
					'places_medium',
					'places_low',
					'places_subsites',
					'fortifications',
					'provinces',
					'provinces_label',
					'roads_high',
					'roads_low',
					'10m_lakes',
					'10m_lakes_label',
					'10m_rivers_lake_centerlines',
				],
			});
			await load_roman_capabilities(tool);

			open_roman();

			const container = tool.roman_panel.querySelector('.uca-maps-roman-datasets');
			assert.equal(
				getComputedStyle(container).display,
				'grid',
				'expected the tool CSS applied — else this gate proves nothing',
			);
			const rows = Array.from(container.querySelectorAll('.uca-maps-roman-dataset-row'));
			assert.equal(
				rows.length,
				12,
				'expected the twelve layers rendered — zero rows would pass the loops below',
			);

			assert.isAtMost(
				container.scrollHeight,
				container.clientHeight + 1,
				'expected every layer visible without scrolling inside the list',
			);
			// a wrapped identifier reads as two layers: no row taller than the shortest
			const one_line = Math.min(...rows.map((row) => row.getBoundingClientRect().height));
			for (const row of rows) {
				assert.isAtMost(
					row.getBoundingClientRect().height,
					one_line + 1,
					'expected the layer name on a single line: ' + row.textContent,
				);
				assert.isBelow(
					row.scrollWidth,
					row.clientWidth + 2,
					'expected the layer name not overflowing its row: ' + row.textContent,
				);
				const box = row.querySelector('input').getBoundingClientRect().width;
				const name = row.querySelector('span').getBoundingClientRect().width;
				assert.isAtMost(
					row.getBoundingClientRect().width,
					box + name + 12,
					'expected no clickable blank space beside the layer: ' + row.textContent,
				);
			}
		});
	});

	it('detach_roman_empire removes the button and panel', async function () {
		mount_roman();
		const map_container_node = geolocation.map.getContainer();

		await tool.destroy(false, false, false);

		assert.equal(tool.roman_control, null, 'expected roman_control cleared');
		assert.equal(tool.roman_panel, null, 'expected roman_panel cleared');
		assert.equal(tool.roman_dropdown, null, 'expected the suggestion list cleared');
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-dropdown'),
			'expected the suggestion list removed from the map container',
		);
		assert.equal(tool._roman_results, null, 'expected the session hits cleared');
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-control'),
			'expected the button removed from the DOM',
		);
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-panel'),
			'expected the panel removed from the DOM',
		);
	});

	// the Pleiades geometry is fetched AFTER choosing, so its error can arrive
	// once the panel was closed and reopened clean
	it('a late error from drawing a Pleiades hit never lands in the panel reopened clean', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);

		const control = geolocation.map.getContainer().querySelector('.uca-maps-roman-control');
		const panel = tool.roman_panel;
		const message = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message');
		let release;
		let asked = 0;
		stub_tool_request(function () {
			asked++;
			return new Promise((resolve) => {
				release = () => resolve({ ok: true, data: { place: null } });
			});
		});
		const choose_roma = () => {
			seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);
			tool.roman_dropdown
				.querySelector('.uca-maps-roman-result-button')
				.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		};
		control.click(); // open

		// control half: with the panel left alone, the error IS shown
		choose_roma();
		release();
		await tick(SETTLE_MS);
		assert.equal(message.hidden, false, 'expected a geometry-less place reported under Pleiades');

		choose_roma();
		assert.equal(
			asked,
			2,
			'expected the second geometry request sent — else release() replays the first',
		);
		control.click(); // close
		control.click(); // reopen: clean
		release();
		await tick(SETTLE_MS);
		assert.equal(message.hidden, true, 'expected the late error dropped by the reopened panel');
	});

	it("↑/↓ and Enter in one source's field never walk nor pick another source's list", async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const panel = tool.roman_panel;
		const pleiades_input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const dare_input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		const asked = [];
		stub_tool_request(async function (options) {
			asked.push(options.action);
			return { ok: true, data: { results: [] } };
		});
		seed_roman_list('pleiades', [
			{ name: 'Roma', id: '423025' },
			{ name: 'Roma Vecchia', id: '423026' },
		]);

		// control: the list's OWN field walks it
		pleiades_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(tool._roman_active_index, 0, 'expected ↓ in its own field to walk the list');

		// two ↓: walking the two-row Pleiades list from 0 would end on 1
		dare_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		dare_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(tool._roman_active_index, 0, 'expected ↓ in DARE not to walk the Pleiades list');

		pleiades_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(tool._roman_active_index, 1, 'expected ↓ in its own field to reach the last row');
		dare_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		assert.equal(tool._roman_active_index, 1, 'expected ↑ in DARE not to walk the Pleiades list');

		dare_input.value = 'Gades';
		dare_input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick(SETTLE_MS);
		assert.deepEqual(
			asked,
			['search_dare'],
			'expected Enter in DARE to search DARE, never to draw the active Pleiades row',
		);
	});

	it('detach_roman_empire removes the capture listener it put on the map container', async function () {
		const container = geolocation.map.getContainer();
		const is_capture = (opts) => opts === true || Boolean(opts && opts.capture);
		const added = [];
		const removed = [];
		container.addEventListener = function (type, fn, opts) {
			if (type === 'mousedown' && is_capture(opts)) {
				added.push(fn);
			}
			return EventTarget.prototype.addEventListener.call(this, type, fn, opts);
		};
		container.removeEventListener = function (type, fn, opts) {
			if (type === 'mousedown' && is_capture(opts)) {
				removed.push(fn);
			}
			return EventTarget.prototype.removeEventListener.call(this, type, fn, opts);
		};

		try {
			mount_roman();
			assert.equal(added.length, 1, 'expected ONE capture mousedown listener on the map container');
			await tool.destroy(false, false, false);
			assert.include(
				removed,
				added[0],
				'expected teardown to remove that same listener, in capture',
			);
		} finally {
			// biome-ignore lint/performance/noDelete: drops the stub so the prototype's own method shows through again
			delete container.addEventListener;
			// biome-ignore lint/performance/noDelete: drops the stub so the prototype's own method shows through again
			delete container.removeEventListener;
		}
	});

	// a keystroke still waiting out the debounce would take a NEWER token than the
	// cancelled search and reopen the list after Esc, or over a closed panel
	it('closing the list cancels a keystroke still waiting out the debounce', async function () {
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);
		const control = geolocation.map.getContainer().querySelector('.uca-maps-roman-control');
		control.click(); // open

		let asked = 0;
		stub_tool_request(async function () {
			asked++;
			return { ok: true, data: { results: [roman_hit('Gades', 36.5, -6.2)] } };
		});
		const input = tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const type_gades = () => {
			input.value = 'Gades';
			input.dispatchEvent(new Event('input'));
		};

		// control half: left alone, the keystroke DOES search and open the list
		type_gades();
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 1, 'expected the debounced search sent');
		assert.equal(tool.roman_dropdown.hidden, false);

		type_gades();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 1, 'expected Esc to cancel the waiting search');
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list to stay closed after Esc');

		type_gades();
		tool.roman_panel.querySelector('.uca-maps-panel-close').click(); // the ×
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 1, 'expected the × to cancel the waiting search');
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list over a closed panel');
	});

	it('Tab into another field closes the list, as a click there does', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const panel = tool.roman_panel;
		const pleiades_input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const dare_input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);

		pleiades_input.focus(); // its own field: the list stays
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			"expected focus on the list's own field to keep it open",
		);

		dare_input.focus();
		assert.equal(
			document.activeElement,
			dare_input,
			'expected DARE focused — else no focusin happened',
		);
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected focus moving to another field to close the list',
		);
	});

	it('opening the panel focuses the first ENABLED field', async function () {
		require_document_focus();
		// only DARE needs no local data: with none, Pleiades and Pelagios are disabled
		mount_roman();
		await load_roman_capabilities(tool);
		const control = geolocation.map.getContainer().querySelector('.uca-maps-roman-control');
		control.click();
		assert.equal(
			document.activeElement,
			tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input'),
			'expected the focus on DARE, the only enabled field',
		);
		control.click(); // close

		// control half: with Pleiades available, it is the first field
		tool._roman_gazetteers = { configured: true, pleiades: true, pelagios: [] };
		refresh_roman_sources(tool, tool.roman_panel);
		control.click();
		assert.equal(
			document.activeElement,
			tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input'),
			'expected the focus on Pleiades, the first field',
		);
	});

	// the list is owned from the moment a field ARMS a search, so going elsewhere
	// cancels it waiting, in flight or open
	it('leaving the field cancels its search, whether waiting or in flight', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const panel = tool.roman_panel;
		const pleiades_input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const dare_input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		let asked = 0;
		let release = null;
		stub_tool_request(function () {
			asked++;
			return new Promise((resolve) => {
				release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } });
			});
		});
		const type_roma = () => {
			pleiades_input.value = 'Roma';
			pleiades_input.dispatchEvent(new Event('input'));
		};

		// waiting out the debounce, then Tab into DARE
		type_roma();
		dare_input.focus();
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 0, 'expected Tab away to cancel the waiting search');

		// waiting, then a click in DARE
		type_roma();
		dare_input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 0, 'expected a click away to cancel the waiting search');

		// in flight, then Tab into DARE
		pleiades_input.focus();
		type_roma();
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 1, 'expected the search sent — else the next check proves nothing');
		dare_input.focus();
		release();
		await tick(SETTLE_MS);
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected no Pleiades list under a field the user left',
		);
	});

	it("pressing the panel's scrollbar keeps the list; pressing a control closes it", function () {
		mount_roman();
		open_roman();
		const panel = tool.roman_panel;
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)]);
		assert.equal(tool.roman_dropdown.hidden, false);

		// Chrome targets the scrolling element itself when its scrollbar is pressed
		panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			'expected the scrollbar press to leave the list to the scroll',
		);

		panel
			.querySelector('.uca-maps-roman-dare-filters select')
			.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a press on a filter to close it');
	});

	it('a late answer never opens the list under a field scrolled out of view', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();
		const panel = tool.roman_panel;
		make_panel_scrollable(panel);

		const input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		let release = null;
		stub_tool_request(function () {
			return new Promise((resolve) => {
				release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } });
			});
		});
		const search_roma = async () => {
			release = null;
			input.value = 'Roma';
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			await until(() => release !== null);
			assert.isNotNull(release, 'expected the search sent');
		};

		// control half: the field in view, the answer opens the list
		await search_roma();
		release();
		await tick(SETTLE_MS);
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open under a field in view');
		tool.close_roman_suggestions();

		await search_roma();
		panel.scrollTop = panel.scrollHeight; // Pleiades, the first source, leaves the view
		assert.isBelow(
			input.getBoundingClientRect().top,
			panel.getBoundingClientRect().top + 1,
			'expected the field scrolled out of view — else this gate proves nothing',
		);
		// let that scroll's event pass FIRST: dispatched after the answer, it would
		// close the list on its own and this gate would never see the open-time check
		await two_frames();
		release();
		await tick(SETTLE_MS);
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list under a field out of view');
	});

	it('a source that turns out unavailable takes its open list with it', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();
		const seed_pleiades = () => {
			seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);
			assert.equal(tool.roman_dropdown.hidden, false);
		};

		// control half: still available, the list stays
		seed_pleiades();
		refresh_roman_sources(tool, tool.roman_panel);
		assert.equal(
			tool.roman_dropdown.hidden,
			false,
			'expected the list kept while its source is available',
		);

		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] };
		refresh_roman_sources(tool, tool.roman_panel);
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed');
		assert.equal(tool._roman_results, null, 'expected the hits forgotten');
		assert.equal(tool._roman_source, null, 'expected no owner left');
	});

	it('a Pleiades error lands under Pleiades even after DARE took the list', async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();
		const panel = tool.roman_panel;

		let release = null;
		stub_tool_request(function (options) {
			if (options.action === 'search_dare') {
				return Promise.resolve({ ok: true, data: { results: [] } });
			}
			return new Promise((resolve) => {
				release = () => resolve({ ok: true, data: { place: null } });
			});
		});
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);
		tool.roman_dropdown
			.querySelector('.uca-maps-roman-result-button')
			.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		assert.isFunction(release, 'expected the Pleiades geometry request in flight');

		await search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' });
		assert.equal(tool._roman_source, 'dare', 'expected DARE to own the list now');

		release();
		await tick(SETTLE_MS);
		assert.equal(
			panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message').hidden,
			false,
			'expected the error under Pleiades',
		);
		assert.equal(
			panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-message').hidden,
			true,
			'expected nothing under DARE',
		);
	});

	// with the list open, Tab walks the list instead of closing it and wandering
	// off through the panel
	it('with its list open, Tab walks from the field into the list and through it', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const panel = tool.roman_panel;
		const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		const key = (target, name, shift) => {
			const event = new KeyboardEvent('keydown', {
				key: name,
				shiftKey: Boolean(shift),
				bubbles: true,
				cancelable: true,
			});
			target.dispatchEvent(event);
			return event;
		};
		const seed = () => {
			seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2), roman_hit('Gadir', 36.6, -6.3)]);
			input.focus();
		};

		// control half: no list, Tab is the browser's own
		input.focus();
		assert.isFalse(key(input, 'Tab').defaultPrevented, 'expected Tab left alone with no list open');

		seed();
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button');
		assert.isTrue(key(input, 'Tab').defaultPrevented);
		assert.equal(document.activeElement, rows[0], 'expected Tab from the field onto the first row');
		assert.equal(tool._roman_active_index, 0, 'expected the focused row to be the highlighted one');

		key(rows[0], 'Tab');
		assert.equal(document.activeElement, rows[1], 'expected Tab to the next row');
		key(rows[1], 'Tab', true);
		assert.equal(document.activeElement, rows[0], 'expected Shift+Tab back one row');
		key(rows[0], 'Tab', true);
		assert.equal(
			document.activeElement,
			input,
			'expected Shift+Tab on the first row back to the field',
		);
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open all along');

		// past the last row: the list closes, the focus goes on after the field
		key(input, 'Tab');
		key(rows[0], 'ArrowDown');
		assert.equal(document.activeElement, rows[1], 'expected ↓ to walk the focused rows too');
		key(rows[1], 'Tab');
		assert.equal(
			tool.roman_dropdown.hidden,
			true,
			'expected Tab past the last row to close the list',
		);
		assert.equal(
			document.activeElement,
			panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-search-button'),
			"expected the focus on the control right after the field: DARE's Search button",
		);

		// Esc in a row: closed, back in the field
		seed(); // rebuilds the rows: query them again
		key(input, 'Tab');
		key(tool.roman_dropdown.querySelector('.uca-maps-roman-result-button'), 'Escape');
		assert.equal(tool.roman_dropdown.hidden, true, 'expected Esc to close the list');
		assert.equal(document.activeElement, input, 'expected Esc to hand the focus back to the field');

		// Enter in a row draws it and hands the focus back to the field
		seed();
		const feature_group = active_group();
		const before = feature_group.getLayers().length;
		key(input, 'Tab');
		const fresh_rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button');
		key(fresh_rows[0], 'Enter');
		await until(() => feature_group.getLayers().length === before + 1);
		assert.equal(
			feature_group.getLayers().length,
			before + 1,
			'expected Enter on the focused row to draw it',
		);
		assert.equal(tool.roman_dropdown.hidden, true);
		assert.equal(
			document.activeElement,
			input,
			'expected the focus back in the field, not lost on <body>',
		);
	});

	it('walking the list by keyboard freezes it: no waiting or in-flight search rebuilds it', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES); // a local source: DARE searches on Enter only
		await load_roman_capabilities(tool);
		open_roman();
		const panel = tool.roman_panel;
		const input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const tab = (target) =>
			target.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
			);

		let asked = 0;
		let release = null;
		stub_tool_request(function () {
			asked++;
			return new Promise((resolve) => {
				release = () => resolve({ ok: true, data: { results: [roman_hit('NEW', 0, 0)] } });
			});
		});
		const seed = () => {
			seed_roman_list('pleiades', [roman_hit('Gades', 36.5, -6.2)]);
			input.focus();
		};

		// a keystroke still waiting out the debounce, then Tab into the list
		seed();
		input.value = 'Gadesx';
		input.dispatchEvent(new Event('input'));
		tab(input);
		const row = document.activeElement;
		assert.isTrue(
			row.classList.contains('uca-maps-roman-result-button'),
			'expected the focus on a row',
		);
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 0, 'expected the waiting search cancelled by entering the list');
		assert.equal(document.activeElement, row, 'expected the focus still on its row');

		// a search already in flight, then Tab into the list
		seed();
		input.value = 'Gadesy';
		input.dispatchEvent(new Event('input'));
		await tick(AFTER_DEBOUNCE_MS);
		assert.equal(asked, 1, 'expected the search in flight — else the next check proves nothing');
		tab(input);
		const held = document.activeElement;
		release();
		await tick(SETTLE_MS);
		assert.isTrue(
			document.contains(held),
			'expected the focused row not rebuilt by the late answer',
		);
		assert.equal(document.activeElement, held, 'expected the focus kept, not dropped to <body>');
		assert.notInclude(tool.roman_dropdown.textContent, 'NEW', 'expected the late hits discarded');
	});

	// the capability answer can land with the panel already open: disabling the
	// focused field must not drop the focus to <body>, nor move it when the
	// focused control stays usable
	it('a capability answer that disables the focused field moves the focus to the first usable one', async function () {
		require_document_focus();
		let answer = null;
		tool.get_capabilities = function () {
			return new Promise((resolve) => {
				answer = resolve;
			});
		};
		tool.attach_roman_empire();
		open_roman();
		const panel = tool.roman_panel;
		const pleiades = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		assert.equal(
			document.activeElement,
			pleiades,
			'expected the panel opened on Pleiades — else the answer disables nothing focused',
		);

		answer({
			ok: true,
			data: { gazetteers: { configured: false, pleiades: false, pelagios: [] } },
		});
		await tick();

		assert.isTrue(pleiades.disabled, 'expected Pleiades disabled by the answer');
		assert.equal(
			document.activeElement,
			panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input'),
			'expected the focus on DARE, the first field still usable, not on <body>',
		);
	});

	it('a capability answer leaves alone a focused control that stays usable', async function () {
		require_document_focus();
		let answer = null;
		tool.get_capabilities = function () {
			return new Promise((resolve) => {
				answer = resolve;
			});
		};
		tool.attach_roman_empire();
		open_roman();
		const select = tool.roman_panel.querySelector('.uca-maps-roman-dare-filters select');
		select.focus();
		assert.equal(document.activeElement, select);

		answer({
			ok: true,
			data: { gazetteers: { configured: false, pleiades: false, pelagios: [] } },
		});
		await tick();

		assert.isTrue(
			tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input').disabled,
			'expected the answer applied',
		);
		assert.equal(document.activeElement, select, 'expected the focus kept on the DARE filter');
	});

	it('whatever closes the list, a focused row hands the focus back to its field', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();
		const panel = tool.roman_panel;
		make_panel_scrollable(panel);
		const dare = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		const focus_a_row = (source) => {
			seed_roman_list(source, [roman_hit('Gades', 36.5, -6.2)]);
			const row = tool.roman_dropdown.querySelector('.uca-maps-roman-result-button');
			row.focus();
			assert.equal(
				document.activeElement,
				row,
				'expected a row focused — else nothing below is lost',
			);
		};

		// the panel's scroll takes the field out of view: the focus goes back
		// to it WITHOUT scrolling the panel back, which would undo the user's scroll
		panel.scrollTop +=
			dare.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2;
		focus_a_row('dare');
		panel.scrollTop = 0; // DARE is the last source: its field is now below the view
		panel.dispatchEvent(new Event('scroll'));
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the scroll to close the list');
		assert.equal(document.activeElement, dare, 'expected the focus back in DARE, not on <body>');
		assert.equal(panel.scrollTop, 0, "expected the user's scroll kept");

		// the owning source turns unavailable: its field is disabled, so the
		// focus goes on to the first usable one
		focus_a_row('pleiades');
		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] };
		refresh_roman_sources(tool, panel);
		assert.equal(tool.roman_dropdown.hidden, true, "expected the unavailable source's list closed");
		assert.equal(document.activeElement, dare, 'expected the focus on DARE, not on <body>');
	});

	it('Tab past the last row enters a radio group at its CHECKED radio', async function () {
		require_document_focus();
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();
		const panel = tool.roman_panel;
		const input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input');
		const by_id = panel.querySelector('.uca-maps-roman-pleiades-type input[value="id"]');
		by_id.checked = true;

		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }]);
		input.focus();
		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
		);
		document.activeElement.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
		);

		assert.equal(
			document.activeElement,
			by_id,
			'expected the checked "by id" radio, as native Tab would',
		);
		assert.isTrue(by_id.checked, 'expected the search type untouched');
	});

	it('while the keyboard is in the list, the pointer moves the focus with the highlight', async function () {
		require_document_focus();
		mount_roman();
		open_roman();
		const panel = tool.roman_panel;
		const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input');
		seed_roman_list('dare', [
			roman_hit('Gades', 36.5, -6.2),
			roman_hit('Gadir', 36.6, -6.3),
			roman_hit('Gadara', 32.6, 35.7),
		]);
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button');

		// control half: typing in the field, hovering only highlights
		input.focus();
		rows[1].dispatchEvent(new MouseEvent('mouseenter'));
		assert.equal(
			document.activeElement,
			input,
			'expected the field to keep the focus while typing',
		);
		assert.equal(tool._roman_active_index, 1);

		// ↓ twice in the field, then Tab: onto the row ALREADY highlighted
		tool._roman_active_index = -1;
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(tool._roman_active_index, 1);
		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
		);
		assert.equal(
			document.activeElement,
			rows[1],
			'expected Tab onto the highlighted row, not the first',
		);

		rows[2].dispatchEvent(new MouseEvent('mouseenter'));
		assert.equal(document.activeElement, rows[2], 'expected the hovered row to take the focus');
		assert.equal(tool._roman_active_index, 2, 'expected the highlight on the focused row');
		assert.isTrue(rows[2].classList.contains('is-active'));
	});

	// the Roma block's own line of an earlier failure would stand beside core's
	// notice as if it were the answer to the refused search
	it("a refused Roma search takes the block's earlier line away", async function () {
		mount_roman(WITH_PLEIADES);
		await load_roman_capabilities(tool);
		open_roman();

		const block = tool.roman_panel.querySelector('.uca-maps-roman-pleiades');
		const input = block.querySelector('.uca-maps-roman-input');
		const line = block.querySelector('.uca-maps-roman-message');
		const enter = () =>
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		input.value = '';
		enter();
		await tick(50);
		assert.isFalse(line.hidden, "expected the empty search's own line first");

		stub_tool_request(async () => ({
			ok: false,
			error: {
				is_api_error: true,
				code: 'tool.source_unavailable',
				details: { reason_key: 'gazetteer_service_unavailable' },
				message: 'The gazetteer service did not answer properly.',
				transport: false,
			},
		}));
		input.value = 'Roma';
		enter();
		await tick(50);
		assert.isTrue(line.hidden, "expected no line beside core's notice");
	});
});

// @license-end
