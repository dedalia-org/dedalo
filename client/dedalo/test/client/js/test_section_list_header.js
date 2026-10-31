// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_SECTION_LIST_HEADER
 * The section list header survives pagination in BOTH list shapes, and the
 * row-box TABLE layout (`list.less` 'layout_table'; contract:
 * engineering/wire_contract/WC-2026-10-30-section-record-row-box.md) holds.
 *
 * Two shapes, both gated until the legacy CSS is removed:
 *   - LEGACY (no marker) — the shape every live list renders today: ONE grid,
 *     `.list_body` owns the header cells and every row cell because
 *     `.header_wrapper_list`, `.content_data` and each `.section_record.list`
 *     are `display: contents`; the header cells are ROW 1 of that grid.
 *   - TABLE (`.list_body.layout_table`): the list_body owns the column tracks;
 *     its children are full-span (`grid-column: 1 / -1`) column SUBGRIDS —
 *     `.header_wrapper_list` (row 1) and `.content_data`, whose every row box
 *     (`.section_record`, built row or `.placeholder`) is itself a full-span
 *     column subgrid. Each row is ONE box (hover ring, drop target,
 *     placeholder) while every cell still sits on the shared tracks.
 * Pagination replaces the whole `.content_data` node (`common.render`
 * render_level 'content').
 *
 * The TABLE half pins the stylesheet against the fixture below (which views
 * carry the marker, and which suite asserts it on real views: the row-box WC
 * entry, engineering/wire_contract/WC-2026-10-30-section-record-row-box.md).
 * The placeholder it uses is NOT hand-made — it is cloned from a real
 * `create_record_window` fill (record_window.js), so a change to the window's
 * placeholder shape reaches these asserts.
 *
 * THE WEBKIT TRAP (the bug this suite was written for):
 *   `.head_column` must NOT clip its VERTICAL overflow. With
 *   `overflow: hidden` WebKit (Safari) keeps a WRONG intrinsic height for row 1
 *   after the content_data swap: the header row collapses to a sliver and every
 *   cell clips its title to ~2px. Reproduced and measured in WebKit on oh1 in
 *   the legacy `display: contents` shape — 48.1px → 22.1px on page 1 and 35.1px
 *   on page 2 — persisting across every subsequent swap; Chrome/Gecko are
 *   unaffected. `overflow-x: clip; overflow-y: visible` keeps the horizontal
 *   clip (the label ellipsis itself lives on `.name`, truncate_text) while
 *   leaving the row height intrinsic. The subgrid header keeps the same law;
 *   the WebKit probe of that shape after pagination: the row-box WC entry's
 *   addenda (status and result).
 *
 * The clipping/alignment asserts pass in Chrome either way (Chromium sizes the
 * row correctly); they pin the BEHAVIOUR. The CSSOM/computed asserts pin the
 * DECLARATIONS — the overflow law and the subgrid table — and they are the half
 * that fails if either is dropped. Chrome cannot reproduce the WebKit failure
 * itself; it is verified in a WebKit/Safari probe.
 *
 * VIEWPORT: the list view is responsive — at ≤ 1024px the table block does not
 * apply (`.list_body` drops to `display: block`, the header is hidden and the
 * rows become phone cards), so the suite iframe (narrower than the desktop
 * breakpoint) cannot host the desktop fixture. The desktop fixture lives in its
 * own 1200px iframe loading the REAL main.css; the phone card branch gets a
 * 360px iframe of its own.
 *
 * Backend-free: a synthetic grid with the real classes and the real stylesheet.
 */

import { create_record_window } from '../../../core/section_record/js/record_window.js';
import { ROW_WINDOW_MAX_ROWS, create_row_window } from '../../../core/common/js/row_window.js';

// the compiled stylesheet the suite frame must load, resolved from this module
// (js/ → client/ → test/ → dedalo/ → core/page/css/main.css)
const STYLESHEET_HREF = new URL('../../../core/page/css/main.css', import.meta.url).href;

// The two content generations deliberately have DIFFERENT row heights — the
// trigger condition for the WebKit track re-size.
const FIRST_GENERATION_HEIGHTS = [
	[36, 36, 36],
	[120, 90, 120],
	[36, 36, 36],
];
const SECOND_GENERATION_HEIGHTS = [
	[90, 36, 90],
	[36, 36, 36],
	[150, 120, 150],
];

// the desktop (1200px) and phone (360px) frames, see VIEWPORT above
let frame = null;
let frame_doc = null;
let frame_win = null;
let test_container = null;
let phone_frame = null;
let phone_doc = null;
let phone_win = null;
let phone_container = null;
// one REAL placeholder produced by create_record_window, cloned per fixture
let placeholder_template = null;

/**
 * WAIT_FOR
 * Poll a predicate until true or the timeout elapses. Used instead of the
 * link's `load` event: a stylesheet already served from cache can fire before
 * the listener is attached.
 * @param {Function} predicate
 * @param {number} [timeout_ms]
 * @returns {Promise<boolean>}
 */
const wait_for = async (predicate, timeout_ms = 3000) => {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		if (predicate()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	return predicate();
}; //end wait_for

/**
 * MAKE_HEADER_CELL
 * One `.head_column`, optionally the two-line sub-header shape used by the
 * Audiovisual column (a nested grid inside the header cell).
 * @param {Document} doc
 * @param {string} label
 * @param {Array<string>} [sub_labels]
 * @returns {HTMLElement}
 */
const make_header_cell = (doc, label, sub_labels) => {
	const cell = doc.createElement('div');
	cell.className = 'head_column' + (sub_labels ? ' with_sub_header' : '');

	const name = doc.createElement('span');
	name.className = 'name';
	name.textContent = label;
	cell.appendChild(name);

	if (sub_labels) {
		const sub_header = doc.createElement('div');
		sub_header.className = 'sub_header';
		// set_element_css would inject this through rAF; inline keeps the
		// fixture synchronous and is what the rendered page ends up with.
		sub_header.style.gridTemplateColumns = '1fr 1fr';
		for (const sub_label of sub_labels) {
			const sub_cell = doc.createElement('div');
			sub_cell.className = 'head_column';
			const sub_name = doc.createElement('span');
			sub_name.className = 'name';
			sub_name.textContent = sub_label;
			sub_cell.appendChild(sub_name);
			sub_header.appendChild(sub_cell);
		}
		cell.appendChild(sub_header);
	}

	return cell;
}; //end make_header_cell

/**
 * MAKE_ROW
 * A built `.section_record.list` row with one `.column` per height. The
 * inline-height block is the cell's content; the columns themselves stay
 * `height:auto` as in the real renderer.
 * @param {Document} doc
 * @param {Array<number>} heights
 * @param {number} index - the row's page position (`data-index`)
 * @returns {HTMLElement}
 */
const make_row = (doc, heights, index) => {
	const row = doc.createElement('div');
	row.className = 'section_record list';
	row.dataset.index = String(index);

	for (const height of heights) {
		const column = doc.createElement('div');
		column.className = 'column';
		const content = doc.createElement('div');
		content.className = 'list_cell_content';
		content.style.height = `${height}px`;
		column.appendChild(content);
		row.appendChild(column);
	}

	return row;
}; //end make_row

/**
 * FAKE_EDIT_SAFETY
 * Inert edit-safety bindings for a fill that holds no editor: nothing unsaved,
 * nothing uncommitted, nothing active (record_window requires every key).
 * @type {Object}
 */
const FAKE_EDIT_SAFETY = Object.freeze({
	deactivate: async () => {},
	settle: async () => true,
	orphan: () => {},
	unsaved_instances: () => [],
	uncommitted_nodes: () => [],
	register_uncommitted: () => {},
	commit_seq: () => 0,
	instance_of_node: () => null,
	owned_elsewhere: () => false,
	component_active: () => null,
	service_autocomplete: () => null,
});

/**
 * WINDOW_PLACEHOLDER
 * Fill a detached table `content_data` through the REAL record window with one
 * row above its bound and return the placeholder it wrote (the window is
 * destroyed). The fixture's placeholders are clones of this node, so the CSS is
 * proved against what the window emits, not against a hand-made copy.
 * @param {Document} doc
 * @returns {Promise<HTMLElement>}
 */
const window_placeholder = async (doc) => {
	const content_data = doc.createElement('div');
	content_data.className = 'content_data list section';
	const handle = await create_record_window({
		owner: null,
		slot: 'rows',
		generation: 1,
		container: content_data,
		rows: Array.from({ length: ROW_WINDOW_MAX_ROWS + 1 }, (_, i) => ({ section_id: i + 1 })),
		build: async (entry, index) => ({
			instance: { status: 'built', destroy: async () => {} },
			node: make_row(doc, [36, 36, 36], index),
		}),
		layout: 'table',
		edit_safety: FAKE_EDIT_SAFETY,
	});
	const placeholder = content_data.querySelector(':scope > .section_record.placeholder');
	await handle.destroy();

	return placeholder;
}; //end window_placeholder

/**
 * MAKE_PLACEHOLDER
 * An unbuilt row: a clone of the record window's own placeholder (see
 * window_placeholder), re-indexed.
 * @param {number} index - the row's page position (`data-index`)
 * @returns {HTMLElement}
 */
const make_placeholder = (index) => {
	assert.ok(placeholder_template, 'create_record_window wrote the placeholder template');
	const placeholder = placeholder_template.cloneNode(true);
	placeholder.dataset.index = String(index);

	return placeholder;
}; //end make_placeholder

/**
 * MAKE_CONTENT_DATA
 * One content generation: the built rows in index order, then one placeholder
 * (the window's first unbuilt index), so every generation carries both kinds
 * of row box (unless `with_placeholder` is false: an N ≤ 200 window, all built).
 * @param {Document} doc
 * @param {Array<Array<number>>} rows_heights
 * @param {boolean} [with_placeholder]
 * @returns {HTMLElement}
 */
const make_content_data = (doc, rows_heights, with_placeholder = true) => {
	const content_data = doc.createElement('div');
	content_data.className = 'content_data list section';
	rows_heights.forEach((heights, index) => {
		content_data.appendChild(make_row(doc, heights, index));
	});
	if (with_placeholder) {
		content_data.appendChild(make_placeholder(rows_heights.length));
	}

	return content_data;
}; //end make_content_data

/**
 * MAKE_GRID
 * A list DOM shape (see the file header):
 *   TABLE  (layout_table: true, default): section > list_body.layout_table >
 *          [header_wrapper_list | content_data > (section_record.list… ,
 *          section_record.placeholder)] — header, content_data and every row
 *          box are column subgrids of the list_body grid;
 *   LEGACY (layout_table: false): the same nodes without the marker, all
 *          built (no live legacy view has a record window, so no placeholder)
 *          — the wrappers are `display: contents`.
 * @param {Document} doc
 * @param {HTMLElement} container - where the section is appended
 * @param {Array<Array<number>>} rows_heights
 * @param {Object} [options]
 * @param {boolean} [options.layout_table] - default true
 * @param {boolean} [options.with_placeholder] - default: layout_table
 * @returns {Object} { section, list_body, header, content_data, layout_table }
 */
const make_grid = (doc, container, rows_heights, options = {}) => {
	const layout_table = options.layout_table !== false;
	const with_placeholder = options.with_placeholder ?? layout_table;

	const section = doc.createElement('section');
	section.className = 'wrapper_section section list view_default';

	const list_body = doc.createElement('div');
	list_body.className = layout_table ? 'list_body layout_table' : 'list_body';
	// what view_default_list_section sets from ui.flat_column_items
	list_body.style.gridTemplateColumns = '1fr 1fr 1fr';

	const header = doc.createElement('div');
	header.className = 'header_wrapper_list section';
	header.appendChild(make_header_cell(doc, 'Id'));
	header.appendChild(make_header_cell(doc, 'Title'));
	header.appendChild(make_header_cell(doc, 'Audiovisual', ['Transcribed', 'Indexed']));

	const content_data = make_content_data(doc, rows_heights, with_placeholder);

	list_body.appendChild(header);
	list_body.appendChild(content_data);
	section.appendChild(list_body);
	container.appendChild(section);

	return { section, list_body, header, content_data, layout_table };
}; //end make_grid

/**
 * HEADER_CELLS / BUILT_ROWS / ROW_CELLS / PLACEHOLDERS
 * @param {Object} grid
 * @returns {Array<HTMLElement>}
 */
const header_cells = (grid) => Array.from(grid.header.querySelectorAll(':scope > .head_column'));
const built_rows = (grid) =>
	Array.from(grid.content_data.querySelectorAll(':scope > .section_record:not(.placeholder)'));
const row_cells = (grid, row_index = 0) =>
	Array.from(built_rows(grid)[row_index].querySelectorAll(':scope > .column'));
const placeholders = (grid) =>
	Array.from(grid.content_data.querySelectorAll(':scope > .section_record.placeholder'));

/**
 * ASSERT_HEADER_INTACT
 * The header is fully painted, does not overlap the first row, and stays
 * column-aligned with it.
 * @param {Object} grid
 * @param {string} context - assertion label
 * @returns {void}
 */
const assert_header_intact = (grid, context) => {
	const cells = header_cells(grid);
	const first_row = row_cells(grid);
	assert.equal(cells.length, 3, `${context}: three header cells`);
	assert.equal(first_row.length, 3, `${context}: three cells in the first row`);

	for (let i = 0; i < cells.length; i++) {
		const cell = cells[i];
		const name = cell.querySelector(':scope > .name');

		// not clipped by the cell's own overflow:hidden
		assert.equal(
			cell.scrollHeight <= cell.clientHeight + 1,
			true,
			`${context}: header cell ${i} content (${cell.scrollHeight}px) fits its box (${cell.clientHeight}px)`,
		);

		// the box carries the label line, not a sliver of it
		assert.equal(
			cell.getBoundingClientRect().height >= name.getBoundingClientRect().height - 1,
			true,
			`${context}: header cell ${i} is at least as tall as its name line`,
		);

		// shared grid columns: the header cell and the row cell line up
		const header_rect = cell.getBoundingClientRect();
		const row_rect = first_row[i].getBoundingClientRect();
		assert.equal(
			Math.abs(header_rect.left - row_rect.left) <= 1,
			true,
			`${context}: header cell ${i} left aligns with its row cell (${header_rect.left} vs ${row_rect.left})`,
		);
		assert.equal(
			Math.abs(header_rect.width - row_rect.width) <= 1,
			true,
			`${context}: header cell ${i} width matches its row cell (${header_rect.width} vs ${row_rect.width})`,
		);

		// no vertical overlap with the first data row
		assert.equal(
			first_row[i].getBoundingClientRect().top >= header_rect.bottom - 1,
			true,
			`${context}: header cell ${i} does not overlap the first row`,
		);
	}
}; //end assert_header_intact

/**
 * FIND_RULES
 * Walk every style rule (media queries and CSS nesting included) and collect
 * the declarations whose selectorText matches `selector` exactly.
 * (!) Modern Chrome exposes `cssRules` on plain CSSStyleRule objects too (CSS
 * nesting), so a rule must be matched on its selectorText BEFORE deciding
 * whether it is a container — treating `cssRules` alone as "container" skips
 * every style rule.
 * @param {Array<CSSStyleSheet>} style_sheets
 * @param {string} selector
 * @returns {Array<CSSStyleDeclaration>}
 */
const find_rules = (style_sheets, selector) => {
	const found = [];
	const walk = (rules) => {
		for (const rule of rules) {
			if (rule.selectorText === selector && rule.style) {
				found.push(rule.style);
			}
			if (rule.cssRules && rule.cssRules.length > 0) {
				walk(rule.cssRules);
			}
		}
	};
	for (const sheet of style_sheets) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch (error) {
			continue; // cross-origin sheet: nothing of ours
		}
		if (rules) {
			walk(rules);
		}
	}

	return found;
}; //end find_rules

/**
 * FIND_MEDIA_RULES
 * Like find_rules, but returns `{ style, media }` for every style rule whose
 * selector LIST contains `selector`, where `media` is the mediaText of the
 * closest enclosing @media rule ('' at top level).
 * @param {Array<CSSStyleSheet>} style_sheets
 * @param {string} selector
 * @returns {Array<{style: CSSStyleDeclaration, media: string}>}
 */
const find_media_rules = (style_sheets, selector) => {
	const found = [];
	const walk = (rules, media) => {
		for (const rule of rules) {
			const own_media = rule.media && typeof rule.media.mediaText === 'string'
				? rule.media.mediaText
				: media;
			if (rule.selectorText && rule.style) {
				const selectors = rule.selectorText.split(',').map((item) => item.trim());
				if (selectors.includes(selector)) {
					found.push({ style: rule.style, media: own_media });
				}
			}
			if (rule.cssRules && rule.cssRules.length > 0) {
				walk(rule.cssRules, own_media);
			}
		}
	};
	for (const sheet of style_sheets) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch (error) {
			continue; // cross-origin sheet: nothing of ours
		}
		if (rules) {
			walk(rules, '');
		}
	}

	return found;
}; //end find_media_rules

/**
 * SPLIT_SELECTOR_LIST
 * Split a selector list on its TOP-LEVEL commas only (`:is(a, b)` stays whole).
 * @param {string} selector_text
 * @returns {Array<string>}
 */
const split_selector_list = (selector_text) => {
	const parts = [];
	let depth = 0;
	let current = '';
	for (const char of selector_text) {
		if (char === '(') depth++;
		if (char === ')') depth--;
		if (char === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim() !== '') {
		parts.push(current.trim());
	}

	return parts;
}; //end split_selector_list

/**
 * HOVER_RING_SOURCES
 * Chrome cannot force `:hover` from script, so resolve the hover CASCADE
 * instead. Every style rule APPLYING in `win` (its enclosing @media matches)
 * is examined, part by part, when the part says `:hover` ANYWHERE (on the
 * element, an ancestor, inside `:is()` / `:where()` / `:not()`):
 *   - a part ending in a pseudo-element (`::after`, `::before`, `:after`,
 *     `:before`) counts when the rule draws content;
 *   - any other part counts when it rings the element itself (a `box-shadow`
 *     or an `outline-style` other than none).
 * The part is kept when the element matches it with the pseudo-element removed
 * and every `:hover` replaced by `:is(*)` (always true; `:not(:hover)` thereby
 * matches nothing, which is right: it is not a hover ring). The decision is by
 * MATCHING, not by how the selector is spelled — the planted controls in the
 * ring test prove the non-canonical spellings are found.
 * @param {Window} win
 * @param {HTMLElement} element
 * @returns {Array<string>} the matching selectors
 */
const hover_ring_sources = (win, element) => {
	const found = [];
	const pseudo_element = /(::?(?:after|before))$/;
	const is_set = (value) => value !== '' && value !== 'none' && value !== 'normal';
	const walk = (rules, media_ok) => {
		for (const rule of rules) {
			const own_media_ok = rule.media && typeof rule.media.mediaText === 'string'
				? media_ok && win.matchMedia(rule.media.mediaText).matches
				: media_ok;
			if (own_media_ok && rule.selectorText && rule.style) {
				const draws = is_set(rule.style.getPropertyValue('content'));
				const rings_self = is_set(rule.style.getPropertyValue('box-shadow'))
					|| is_set(rule.style.getPropertyValue('outline-style'));
				for (const part of split_selector_list(rule.selectorText)) {
					if (!/:hover\b/.test(part)) {
						continue;
					}
					const on_pseudo = pseudo_element.test(part);
					if (on_pseudo ? !draws : !rings_self) {
						continue;
					}
					const base = part.replace(pseudo_element, '').replace(/:hover\b/g, ':is(*)');
					try {
						if (element.matches(base)) {
							found.push(part);
						}
					} catch (error) {
						// a selector the element API cannot evaluate is no ring of ours
					}
				}
			}
			if (rule.cssRules && rule.cssRules.length > 0) {
				walk(rule.cssRules, own_media_ok);
			}
		}
	};
	for (const sheet of Array.from(win.document.styleSheets)) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch (error) {
			continue; // cross-origin sheet: nothing of ours
		}
		if (rules) {
			walk(rules, true);
		}
	}

	return found;
}; //end hover_ring_sources

/**
 * OPEN_FRAME
 * An off-screen iframe of the given width loading the REAL main.css. Off-screen,
 * NOT display:none: a hidden frame skips layout.
 * @param {number} width - px
 * @returns {Promise<{frame: HTMLIFrameElement, doc: Document, win: Window, container: HTMLElement}>}
 */
const open_frame = async (width) => {
	const new_frame = document.createElement('iframe');
	new_frame.style.cssText =
		`position:absolute;left:-10000px;top:0;width:${width}px;height:800px;border:0;`;
	// listener BEFORE append: an about:blank load event can fire in the
	// append itself, and a listener attached afterwards would never hear it
	const frame_loaded = new Promise((resolve) =>
		new_frame.addEventListener('load', resolve, { once: true }),
	);
	document.body.appendChild(new_frame);
	if (!new_frame.contentDocument || new_frame.contentDocument.readyState !== 'complete') {
		await Promise.race([frame_loaded, new Promise((resolve) => setTimeout(resolve, 5000))]);
	}

	const doc = new_frame.contentDocument;
	const win = new_frame.contentWindow;
	doc.open();
	doc.write(
		'<!doctype html><html><head><meta charset="utf-8">' +
			`<link rel="stylesheet" href="${STYLESHEET_HREF}">` +
			'</head><body></body></html>',
	);
	doc.close();

	const ready = await wait_for(() => {
		try {
			return doc.styleSheets.length > 0 && doc.styleSheets[0].cssRules.length > 0;
		} catch (error) {
			return false;
		}
	}, 8000);
	assert.equal(ready, true, `the ${width}px suite frame loaded main.css`);

	const container = doc.createElement('div');
	container.className = 'container section_list_header';
	doc.body.appendChild(container);

	return { frame: new_frame, doc, win, container };
}; //end open_frame

/**
 * IS_SUBGRID
 * A computed `grid-template-columns` that is a column subgrid. The resolved
 * value of a subgrid is the keyword `subgrid` (plus any line names), never the
 * parent's track sizes.
 * @param {string} value
 * @returns {boolean}
 */
const is_subgrid = (value) => typeof value === 'string' && value.trim().startsWith('subgrid');

/**
 * ASSERT_NO_STACKING_CONTEXT
 * The ring law (list.less 'layout_table'): a row box or content_data creates no
 * stacking context and paints nothing of its own, or the autocomplete panel, the
 * hover buttons and the field tint get trapped beneath the next row.
 * @param {Window} win
 * @param {HTMLElement} node
 * @param {string} context - assertion label
 * @returns {void}
 */
const assert_no_stacking_context = (win, node, context) => {
	const style = win.getComputedStyle(node);
	const expected = {
		zIndex: 'auto',
		transform: 'none',
		opacity: '1',
		filter: 'none',
		willChange: 'auto',
		contain: 'none',
		isolation: 'auto',
		mixBlendMode: 'normal',
		contentVisibility: 'visible',
		overflowX: 'visible',
		overflowY: 'visible',
		backgroundColor: 'rgba(0, 0, 0, 0)',
		backgroundImage: 'none',
	};
	for (const [property, value] of Object.entries(expected)) {
		assert.equal(style[property], value, `${context}: ${property} is ${value}`);
	}
}; //end assert_no_stacking_context

/**
 * EMULATE_PRINT
 * Chrome cannot switch a page to print media from inside it, so resolve the
 * print CASCADE instead: copy every top-level `@media print` rule of the loaded
 * stylesheet into a `<style>` (media all) appended to the frame. The desktop
 * frame already matches the table block (`not screen, screen and
 * (min-width…)`), so the computed styles are those of a printed table — the
 * print rules competing on specificity / importance with the rules that really
 * apply in print. Returns the element; remove it when done.
 * @param {Document} doc
 * @returns {HTMLStyleElement}
 */
const emulate_print = (doc) => {
	const css = [];
	for (const sheet of Array.from(doc.styleSheets)) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch (error) {
			continue; // cross-origin sheet: nothing of ours
		}
		for (const rule of Array.from(rules || [])) {
			if (rule.media && rule.media.mediaText === 'print') {
				for (const inner of Array.from(rule.cssRules)) {
					css.push(inner.cssText);
				}
			}
		}
	}
	assert.equal(css.length > 0, true, 'main.css carries @media print rules to emulate');
	const style = doc.createElement('style');
	style.textContent = css.join('\n');
	doc.head.appendChild(style);

	return style;
}; //end emulate_print

describe('SECTION LIST HEADER — the overflow law and the row-box table', () => {
	before(async function () {
		// the default 2000ms is not enough for a cold iframe + stylesheet load
		// in the run's own browser: a hook timeout here aborts the suite before
		// any it() runs (the card then reads "registered zero tests")
		this.timeout(30000);

		// wide enough that the desktop table path applies inside it
		const desktop = await open_frame(1200);
		frame = desktop.frame;
		frame_doc = desktop.doc;
		frame_win = desktop.win;
		test_container = desktop.container;

		// narrow enough that the phone card path applies inside it
		const phone = await open_frame(360);
		phone_frame = phone.frame;
		phone_doc = phone.doc;
		phone_win = phone.win;
		phone_container = phone.container;

		// the placeholder every TABLE fixture uses, written by the real window
		placeholder_template = await window_placeholder(frame_doc);
	});

	// every it() builds its fixture into these two containers: empty them after
	// EACH test, so a failing assert (which skips that test's own trailing
	// remove()) never leaves a section behind for the next test to lay out under
	afterEach(() => {
		test_container?.replaceChildren();
		phone_container?.replaceChildren();
	});

	after(() => {
		if (frame) {
			frame.remove();
		}
		if (phone_frame) {
			phone_frame.remove();
		}
	});

	it("keeps the header cells' vertical overflow visible (the WebKit row-height trap)", () => {
		const cell_rules = find_rules(frame_doc.styleSheets, '.header_wrapper_list .head_column');
		const sub_header_rules = find_rules(
			frame_doc.styleSheets,
			'.header_wrapper_list .head_column.with_sub_header',
		);
		assert.equal(cell_rules.length >= 1, true, 'main.css has a .head_column rule');
		assert.equal(
			sub_header_rules.length >= 1,
			true,
			'main.css has a .head_column.with_sub_header rule',
		);

		const declares_visible = (styles) => styles.some((style) => style.overflowY === 'visible');
		assert.equal(
			declares_visible(cell_rules),
			true,
			'.head_column declares `overflow-y: visible` — WebKit collapses the header row after pagination when the vertical axis is clipped',
		);
		assert.equal(
			declares_visible(sub_header_rules),
			true,
			'.head_column.with_sub_header declares `overflow-y: visible` too (it re-declares overflow)',
		);

		const declares_hidden = (styles) => styles.some((style) => style.overflowY === 'hidden');
		assert.equal(
			declares_hidden(cell_rules),
			false,
			'no .head_column rule clips the vertical axis',
		);
		assert.equal(
			declares_hidden(sub_header_rules),
			false,
			'no .with_sub_header rule clips the vertical axis',
		);

		// the horizontal clip (and with it the label truncation) is kept
		assert.equal(
			cell_rules.some((style) => style.overflowX === 'clip' || style.overflowX === 'hidden'),
			true,
			'.head_column still clips horizontally',
		);
		const name_rules = find_rules(
			frame_doc.styleSheets,
			'.header_wrapper_list .head_column > .name',
		);
		assert.equal(
			name_rules.some(
				(style) => style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap',
			),
			true,
			'the label ellipsis lives on .name and stays enabled',
		);
	});

	it('declares the table block for desktop AND print, and the print-only notice', () => {
		// the row rule lives in a media rule that also matches print
		// (`not screen`), so print renders the table, not the
		// `display: contents` fallback
		const row_rules = find_media_rules(
			frame_doc.styleSheets,
			'.list_body.layout_table > .content_data > .section_record',
		).filter(({ style }) => style.gridTemplateColumns === 'subgrid');
		assert.equal(row_rules.length >= 1, true, 'main.css has the subgrid row rule');
		assert.equal(
			row_rules.every(({ media }) => media.includes('not screen') && media.includes('min-width')),
			true,
			`the subgrid row rule applies to desktop and print (media: ${row_rules.map(({ media }) => media).join(' | ')})`,
		);

		const notice_rules = find_media_rules(frame_doc.styleSheets, '.list_after > .print_notice');
		assert.equal(
			notice_rules.some(({ style, media }) => media === '' && style.display === 'none'),
			true,
			'the print notice is hidden on screen',
		);
		assert.equal(
			notice_rules.some(({ style, media }) => media === 'print' && style.display === 'block'),
			true,
			'the print notice is shown in print',
		);
	});

	it('prints no placeholder and shows the notice (the resolved print cascade)', () => {
		// unbuilt rows are neither printed nor findable (row-box WC entry). The
		// table block applies in print too and gives every row — placeholders
		// included — `display: grid` at a higher specificity than the print hide,
		// so only the RESOLVED cascade proves the hide wins.
		const table = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS);
		const notice = frame_doc.createElement('div');
		notice.className = 'list_after';
		const print_notice = frame_doc.createElement('span');
		print_notice.className = 'print_notice';
		print_notice.textContent = 'rows not rendered';
		notice.appendChild(print_notice);
		table.section.appendChild(notice);
		// a list-layout content_data (no table marker) holding a placeholder
		const list_content = make_content_data(frame_doc, [[36, 36, 36]]);
		test_container.appendChild(list_content);

		const placeholder = placeholders(table)[0];
		assert.equal(
			frame_win.getComputedStyle(placeholder).display,
			'grid',
			'screen: the placeholder is a table row box',
		);
		assert.equal(frame_win.getComputedStyle(print_notice).display, 'none', 'screen: notice hidden');

		const print_sheet = emulate_print(frame_doc);
		try {
			assert.equal(
				frame_win.getComputedStyle(placeholder).display,
				'none',
				'print: a table placeholder is not printed (beats the table row rule)',
			);
			assert.equal(
				frame_win.getComputedStyle(list_content.querySelector(':scope > .placeholder')).display,
				'none',
				'print: a list-layout placeholder is not printed',
			);
			assert.equal(
				frame_win.getComputedStyle(built_rows(table)[0]).display,
				'grid',
				'print: built rows still print as table rows',
			);
			assert.equal(frame_win.getComputedStyle(print_notice).display, 'block', 'print: the notice shows');
		} finally {
			print_sheet.remove();
			table.section.remove();
			list_content.remove();
		}
	});

	it("uses the record window's own placeholder (not a hand-made copy)", () => {
		assert.ok(placeholder_template, 'create_record_window wrote a placeholder above its bound');
		assert.equal(placeholder_template.classList.contains('section_record'), true, 'it is a .section_record');
		assert.equal(placeholder_template.classList.contains('placeholder'), true, 'it is a .placeholder');
		assert.equal(placeholder_template.childElementCount, 0, 'it is childless');
		assert.equal(placeholder_template.getAttribute('aria-hidden'), 'true', 'it is aria-hidden');
		assert.equal(placeholder_template.dataset.index, String(ROW_WINDOW_MAX_ROWS), 'it is the first unbuilt index');
	});

	it('lays the table out as full-span column subgrids, placeholder included', () => {
		assert.equal(
			frame_win.matchMedia('(min-width: 1025px)').matches,
			true,
			'fixture viewport is the desktop breakpoint (table block active)',
		);

		const grid = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS);
		const list_body_style = frame_win.getComputedStyle(grid.list_body);
		assert.equal(list_body_style.display, 'grid', 'list_body is a grid');
		assert.equal(list_body_style.alignContent, 'start', 'list_body tracks never stretch');

		const boxes = [
			['header_wrapper_list', grid.header],
			['content_data', grid.content_data],
			...built_rows(grid).map((row, i) => [`built row ${i}`, row]),
			...placeholders(grid).map((row, i) => [`placeholder ${i}`, row]),
		];
		assert.equal(placeholders(grid).length, 1, 'fixture: one placeholder row');
		for (const [name, node] of boxes) {
			const style = frame_win.getComputedStyle(node);
			assert.equal(style.display, 'grid', `${name} computes display: grid`);
			assert.equal(
				is_subgrid(style.gridTemplateColumns),
				true,
				`${name} is a column subgrid (grid-template-columns: ${style.gridTemplateColumns})`,
			);
			assert.equal(style.gridColumnStart, '1', `${name} starts at line 1`);
			assert.equal(style.gridColumnEnd, '-1', `${name} ends at line -1 (full span)`);
		}

		// every built row's cells sit on the header's tracks (1px)
		const cells = header_cells(grid);
		built_rows(grid).forEach((row, row_index) => {
			row_cells(grid, row_index).forEach((cell, i) => {
				const header_rect = cells[i].getBoundingClientRect();
				const cell_rect = cell.getBoundingClientRect();
				assert.equal(
					Math.abs(header_rect.left - cell_rect.left) <= 1 &&
						Math.abs(header_rect.right - cell_rect.right) <= 1,
					true,
					`row ${row_index} cell ${i} is on header track ${i} (${cell_rect.left}–${cell_rect.right} vs ${header_rect.left}–${header_rect.right})`,
				);
			});
		});

		// the placeholder spans exactly the table's columns (1px)
		const placeholder = placeholders(grid)[0];
		const placeholder_rect = placeholder.getBoundingClientRect();
		const first_rect = cells[0].getBoundingClientRect();
		const last_rect = cells[cells.length - 1].getBoundingClientRect();
		assert.equal(
			Math.abs(placeholder_rect.left - first_rect.left) <= 1,
			true,
			`placeholder left (${placeholder_rect.left}) aligns with the first column (${first_rect.left})`,
		);
		assert.equal(
			Math.abs(placeholder_rect.right - last_rect.right) <= 1,
			true,
			`placeholder right (${placeholder_rect.right}) aligns with the last column (${last_rect.right})`,
		);
		// the placeholder follows the last built row: index order, no gap, no overlap
		const last_built_rect = built_rows(grid).at(-1).getBoundingClientRect();
		assert.equal(
			Math.abs(placeholder_rect.top - last_built_rect.bottom) <= 1,
			true,
			'the placeholder sits right under the last built row',
		);

		// placeholder size: --row_size (released row) > --placeholder_size
		// (running mean, on content_data) > 2.5rem
		const rem = parseFloat(frame_win.getComputedStyle(frame_doc.documentElement).fontSize);
		const height_of = () => placeholder.getBoundingClientRect().height;
		assert.equal(
			Math.abs(height_of() - rem * 2.5) <= 1,
			true,
			`placeholder defaults to 2.5rem (${height_of()}px vs ${rem * 2.5}px)`,
		);
		grid.content_data.style.setProperty('--placeholder_size', '55px');
		assert.equal(Math.abs(height_of() - 55) <= 1, true, `--placeholder_size sizes it (${height_of()}px)`);
		placeholder.style.setProperty('--row_size', '77px');
		assert.equal(Math.abs(height_of() - 77) <= 1, true, `--row_size wins (${height_of()}px)`);

		// a failed build keeps its slot and shows a stripe, not a background
		placeholder.dataset.failed = 'build_threw';
		const failed_style = frame_win.getComputedStyle(placeholder);
		assert.notEqual(failed_style.boxShadow, 'none', '[data-failed] draws the error stripe');
		assert.equal(failed_style.backgroundColor, 'rgba(0, 0, 0, 0)', '[data-failed] paints no background');

		grid.section.remove();
	});

	it('is not flattened by the view-level overrides once the marker is present', () => {
		const grid = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS);

		// view_base_section.less: its 0,5,0 `display: contents` on content_data
		// would beat the table rule and flatten every row into list_body
		grid.section.className = 'wrapper_section section list view_base';
		assert.equal(
			frame_win.getComputedStyle(grid.content_data).display,
			'grid',
			'view_base list: content_data stays a subgrid under .layout_table',
		);
		assert_header_intact(grid, 'view_base table');

		// view_content_portal.less: the legacy fixed 1.8rem header track would
		// cut the subgrid header row; under the marker the row is `auto`. The
		// OUTCOME is measured on the header CELLS: the header wrapper is a grid
		// item stretched into row 1, so its own box always equals the track and
		// proves nothing.
		grid.section.className = 'wrapper_component component_portal edit view_content';
		void grid.list_body.offsetHeight;
		const first_track = parseFloat(
			frame_win.getComputedStyle(grid.list_body).gridTemplateRows.split(' ')[0],
		);
		const tallest_cell = Math.max(
			...header_cells(grid).map((cell) => cell.getBoundingClientRect().height),
		);
		assert.equal(
			first_track >= tallest_cell - 1,
			true,
			`view_content portal: row 1 (${first_track}px) holds the tallest header cell (${tallest_cell}px)`,
		);
		const cells_bottom = Math.max(
			...header_cells(grid).map((cell) => cell.getBoundingClientRect().bottom),
		);
		assert.equal(
			grid.content_data.getBoundingClientRect().top >= cells_bottom - 1,
			true,
			'view_content portal: the header cells do not overflow onto the rows',
		);
		assert_header_intact(grid, 'view_content portal table');

		grid.section.remove();
	});

	it('keeps the LEGACY view_base list flat and its last row clipped (no marker)', () => {
		// the shape every live base list renders until the views adopt the
		// marker. What this proves is the OUTCOME — the legacy list stays flat
		// (the `display: contents` comes from list.less's base `.list_body`
		// rule, so this does not pin view_base_section.less's own opt-out; its
		// meaningful half, not flattening the TABLE, is pinned by the test
		// above) — and that scoping the legacy rounded-and-clipped last-row rule
		// `:not(.layout_table)` still reaches the legacy list
		const grid = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS, {
			layout_table: false,
		});
		grid.section.className = 'wrapper_section section list view_base';
		assert.equal(placeholders(grid).length, 0, 'fixture: legacy lists have no placeholder');
		assert.equal(
			frame_win.getComputedStyle(grid.content_data).display,
			'contents',
			'legacy view_base list: content_data is display: contents',
		);
		assert.equal(
			frame_win.getComputedStyle(grid.header).display,
			'contents',
			'legacy view_base list: the header wrapper is display: contents',
		);
		for (const [i, row] of built_rows(grid).entries()) {
			assert.equal(frame_win.getComputedStyle(row).display, 'contents', `legacy row ${i} is display: contents`);
		}
		assert_header_intact(grid, 'legacy view_base');

		// the legacy last row still rounds AND clips (list.less: the rule is
		// scoped to the unmarked list_body, so the table never meets it)
		const last_cells = Array.from(built_rows(grid).at(-1).querySelectorAll(':scope > .column'));
		assert.equal(frame_win.getComputedStyle(last_cells[0]).overflowX, 'clip', 'legacy last row: first cell clips');
		assert.equal(frame_win.getComputedStyle(last_cells.at(-1)).overflowX, 'clip', 'legacy last row: last cell clips');
		assert.notEqual(
			frame_win.getComputedStyle(last_cells[0]).borderBottomLeftRadius,
			'0px',
			'legacy last row: first cell rounded',
		);

		grid.section.remove();
	});

	it('rounds and clips the LEGACY last row of a WINDOWED list only once the window ends', async () => {
		// a live legacy list is filled by the REAL row window (section.js
		// window_section_rows → create_row_window), which appends its bottom
		// spacer AFTER the rows: the last row is never :last-child, so its corners
		// come only from list.less's `:has(+ .row_window_spacer.bottom[hidden])`
		// arm. The spacer is the module's own (not a hand-made copy), so a class
		// rename in row_window.js reds here too
		const legacy_last_row = async (max_rows) => {
			const grid = make_grid(frame_doc, test_container, [], { layout_table: false });
			grid.section.className = 'wrapper_section section list view_base';
			const handle = create_row_window({
				owner: null,
				container: grid.content_data,
				items: FIRST_GENERATION_HEIGHTS,
				spacer: 'grid',
				max_rows,
				materialize: async (heights, index) => make_row(frame_doc, heights, index),
			});
			await handle.fill();
			const spacer = grid.content_data.lastElementChild;
			const rows = built_rows(grid);
			const cells = Array.from(rows.at(-1).querySelectorAll(':scope > .column'));
			const computed = {
				spacer_is_last: spacer.matches('.row_window_spacer.bottom'),
				spacer_hidden: spacer.hidden,
				rows: rows.length,
				first_overflow: frame_win.getComputedStyle(cells[0]).overflowX,
				last_overflow: frame_win.getComputedStyle(cells.at(-1)).overflowX,
				first_radius: frame_win.getComputedStyle(cells[0]).borderBottomLeftRadius,
				last_radius: frame_win.getComputedStyle(cells.at(-1)).borderBottomRightRadius,
			};
			handle.destroy();
			grid.section.remove();

			return computed;
		};

		// the window reached the end: the bottom spacer is the last child, hidden
		const ended = await legacy_last_row(FIRST_GENERATION_HEIGHTS.length);
		assert.ok(ended.spacer_is_last, 'fixture: the row window bottom spacer is the last child');
		assert.ok(ended.spacer_hidden, 'fixture: the window reached the end (spacer hidden)');
		assert.equal(ended.rows, FIRST_GENERATION_HEIGHTS.length, 'fixture: every row built');
		assert.equal(ended.first_overflow, 'clip', 'windowed legacy last row: first cell clips');
		assert.equal(ended.last_overflow, 'clip', 'windowed legacy last row: last cell clips');
		assert.notEqual(ended.first_radius, '0px', 'windowed legacy last row: first cell rounded');
		assert.notEqual(ended.last_radius, '0px', 'windowed legacy last row: last cell rounded');

		// negative control: rows remain beyond the window (spacer visible), so
		// the last BUILT row is not the list's last row and must stay square
		const open = await legacy_last_row(FIRST_GENERATION_HEIGHTS.length - 1);
		assert.ok(open.spacer_is_last, 'control: the row window bottom spacer is the last child');
		assert.ok(!open.spacer_hidden, 'control: rows remain beyond the window (spacer visible)');
		assert.equal(open.rows, FIRST_GENERATION_HEIGHTS.length - 1, 'control: the window holds max_rows rows');
		assert.equal(open.first_radius, '0px', 'open window: the last built row is not rounded');
		assert.equal(open.last_radius, '0px', 'open window: the last built row is not rounded (right)');
		assert.notEqual(open.first_overflow, 'clip', 'open window: the last built row does not clip');
	});

	it('keeps rows free of stacking contexts and rings them through ::after', () => {
		// all built (no placeholder): the last row is a built row
		const grid = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS, { with_placeholder: false });

		assert_no_stacking_context(frame_win, grid.content_data, 'content_data');
		for (const [i, row] of built_rows(grid).entries()) {
			assert_no_stacking_context(frame_win, row, `row ${i}`);
			assert.equal(
				frame_win.getComputedStyle(row).position,
				'relative',
				`row ${i} is the ring's containing block`,
			);
			// the row's own bottom rule replaces the per-cell shadow
			for (const cell of row.querySelectorAll(':scope > .column')) {
				assert.equal(frame_win.getComputedStyle(cell).boxShadow, 'none', `row ${i}: cells carry no shadow`);
			}
			assert.equal(
				frame_win.getComputedStyle(row).borderBottomWidth,
				'1px',
				`row ${i} draws its own bottom rule`,
			);
		}

		// at rest no row paints a ring
		const row = built_rows(grid)[1];
		assert.equal(frame_win.getComputedStyle(row, '::after').content, 'none', 'no ring at rest');

		// hover (resolved cascade, see hover_ring_sources): a built row is
		// ringed under the pointer, a placeholder never is (it is not a record)
		assert.equal(hover_ring_sources(frame_win, row).length > 0, true, 'a hovered built row draws the ring');
		const hover_placeholder = placeholder_template.cloneNode(true);
		grid.content_data.appendChild(hover_placeholder);
		assert.deepEqual(hover_ring_sources(frame_win, hover_placeholder), [], 'a hovered placeholder draws no ring');

		// planted controls: the search decides by matching, not by spelling —
		// each non-canonical ring, planted for this element alone, is found
		const PLANTED = [
			'.list_body.layout_table > .content_data > .section_record:is(:hover)::before { content: ""; }',
			'.list_body.layout_table > .content_data > .section_record:hover:not(.zz_none)::after { content: ""; }',
			'.list_body.layout_table:hover > .content_data > .section_record::after { content: ""; }',
			'.list_body.layout_table > .content_data > .section_record:hover { box-shadow: 0 0 1px red; }',
		];
		for (const planted of PLANTED) {
			const style = frame_doc.createElement('style');
			style.textContent = planted;
			frame_doc.head.appendChild(style);
			try {
				assert.equal(
					hover_ring_sources(frame_win, hover_placeholder).length,
					1,
					`control: a planted ring is found (${planted})`,
				);
			} finally {
				style.remove();
			}
		}
		assert.deepEqual(hover_ring_sources(frame_win, hover_placeholder), [], 'control: planted rings removed');
		hover_placeholder.remove();

		// a drag state under hover keeps its OWN ring: Chrome freezes `:hover`
		// on the drag source, so no hover rule may apply to a dragging or
		// dragover row (a hover arm outranking the state overrides would paint
		// the grey glow under them) — with none applying, the state rings
		// asserted below ARE the hovered rendering
		for (const state of ['dragging', 'dragover']) {
			row.classList.add(state);
			assert.deepEqual(hover_ring_sources(frame_win, row), [], `a hovered ${state} row keeps its own ring`);
			row.classList.remove(state);
		}

		// drop target: the ring is an absolutely placed, click-through ::after
		// at z-index 1 (above the cells, below wrapper stacking)
		row.classList.add('dragover');
		const ring = frame_win.getComputedStyle(row, '::after');
		assert.equal(ring.content, '""', 'dragover draws the ring');
		assert.equal(ring.position, 'absolute', 'ring is positioned on the row');
		assert.equal(ring.zIndex, '1', 'ring paints at z-index 1');
		assert.equal(ring.pointerEvents, 'none', 'ring never takes a click');
		assert.notEqual(ring.boxShadow, 'none', 'dragover ring is drawn');
		assert_no_stacking_context(frame_win, row, 'dragover row');
		row.classList.remove('dragover');

		// drag source: a dashed ring, never opacity
		row.classList.add('dragging');
		const source_ring = frame_win.getComputedStyle(row, '::after');
		assert.equal(source_ring.content, '""', 'dragging draws a ring');
		assert.equal(source_ring.borderTopStyle, 'dashed', 'dragging ring is dashed');
		assert_no_stacking_context(frame_win, row, 'dragging row');
		row.classList.remove('dragging');

		// the legacy per-cell edge / hilite pseudo is off under the marker
		const first_cell = row.querySelector(':scope > .column');
		assert.equal(
			frame_win.getComputedStyle(first_cell, '::after').content,
			'none',
			'no per-cell ::after under .layout_table',
		);

		// the last row rounds the corners without clipping (the drag handle
		// hangs in the left gutter, autocomplete panels open out of cells).
		// Honest because the legacy rounded-AND-clipped rule is scoped
		// `:not(.layout_table)`: drop that scope and its higher specificity
		// clips these cells again
		const last_cells = Array.from(built_rows(grid).at(-1).querySelectorAll(':scope > .column'));
		const first_last_style = frame_win.getComputedStyle(last_cells[0]);
		const last_last_style = frame_win.getComputedStyle(last_cells.at(-1));
		assert.notEqual(first_last_style.borderBottomLeftRadius, '0px', 'last row: first cell rounded');
		assert.notEqual(last_last_style.borderBottomRightRadius, '0px', 'last row: last cell rounded');
		assert.equal(first_last_style.overflowX, 'visible', 'last row: first cell does not clip');
		assert.equal(last_last_style.overflowX, 'visible', 'last row: last cell does not clip');

		grid.section.remove();
	});

	it('draws no row rule in a nested table and frames a portal table once', () => {
		// a list nested in a cell: its rows draw no rule of their own, the
		// outer rows keep theirs
		const outer = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS, { with_placeholder: false });
		const host_cell = row_cells(outer, 0)[1];
		const nested = make_grid(frame_doc, host_cell, FIRST_GENERATION_HEIGHTS, { with_placeholder: false });
		assert.equal(built_rows(nested).length > 0, true, 'fixture: the nested list has rows');
		for (const [i, row] of built_rows(nested).entries()) {
			assert.equal(frame_win.getComputedStyle(row).borderBottomWidth, '0px', `nested row ${i}: no row rule`);
		}
		for (const [i, row] of built_rows(outer).entries()) {
			assert.equal(frame_win.getComputedStyle(row).borderBottomWidth, '1px', `outer row ${i}: keeps its row rule`);
		}
		outer.section.remove();

		// a portal table: ONE left and ONE right rule, drawn by the header and
		// content_data subgrids; the legacy first/last head_column side borders
		// are reset so no rule is drawn twice
		const portal = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS, { with_placeholder: false });
		portal.section.className = 'wrapper_component component_portal edit view_default';
		for (const [name, node] of [['header', portal.header], ['content_data', portal.content_data]]) {
			const style = frame_win.getComputedStyle(node);
			assert.equal(style.borderLeftWidth, '1px', `portal table: ${name} draws the left rule`);
			assert.equal(style.borderRightWidth, '1px', `portal table: ${name} draws the right rule`);
		}
		const cells = header_cells(portal);
		assert.equal(frame_win.getComputedStyle(cells[0]).borderLeftWidth, '0px', 'portal table: first head cell has no left border');
		assert.equal(
			frame_win.getComputedStyle(cells.at(-1)).borderRightWidth,
			'0px',
			'portal table: last head cell has no right border',
		);
		portal.section.remove();
	});

	/**
	 * ASSERT_PAGINATION_SWAP
	 * The header stays unclipped, column-aligned and of constant height across
	 * a whole-node content_data swap with mixed row heights, in one shape.
	 * @param {boolean} layout_table - TABLE (true) or LEGACY (false) shape
	 * @returns {void}
	 */
	const assert_pagination_swap = (layout_table) => {
		const shape = layout_table ? 'table' : 'legacy';
		// the fixture must really be in the desktop branch the bug needs
		assert.equal(
			frame_win.matchMedia('(min-width: 1025px)').matches,
			true,
			'fixture viewport is the desktop breakpoint (responsive list grid active)',
		);

		const grid = make_grid(frame_doc, test_container, FIRST_GENERATION_HEIGHTS, { layout_table });

		// the trigger condition is really in the fixture: the two data rows
		// do NOT share a height
		const first_row_cells = row_cells(grid, 0);
		const second_row_cells = row_cells(grid, 1);
		assert.equal(
			Math.abs(
				first_row_cells[0].getBoundingClientRect().height -
					second_row_cells[0].getBoundingClientRect().height,
			) > 10,
			true,
			'fixture: data rows have different heights',
		);

		// computed declarations on the live element (the CSSOM asserts above
		// prove the source; this proves they reach the element)
		assert.equal(frame_win.getComputedStyle(grid.list_body).display, 'grid', 'list_body is a grid');
		if (layout_table) {
			assert.equal(
				is_subgrid(frame_win.getComputedStyle(grid.header).gridTemplateColumns),
				true,
				'the header is a column subgrid',
			);
		} else {
			// the live shape: the wrappers flatten into the list_body grid
			assert.equal(frame_win.getComputedStyle(grid.header).display, 'contents', 'legacy header is display: contents');
			assert.equal(
				frame_win.getComputedStyle(grid.content_data).display,
				'contents',
				'legacy content_data is display: contents',
			);
		}
		const cell_style = frame_win.getComputedStyle(header_cells(grid)[0]);
		assert.equal(cell_style.overflowY, 'visible', 'header cells compute overflow-y: visible');
		assert.equal(cell_style.overflowX, 'clip', 'header cells compute overflow-x: clip');

		assert_header_intact(grid, `${shape} first page`);

		const header_height = header_cells(grid)[0].getBoundingClientRect().height;

		// PAGINATION: replace the whole content_data node, exactly as
		// common.render render_level 'content' does (TABLE: placeholder included).
		const next_content_data = make_content_data(frame_doc, SECOND_GENERATION_HEIGHTS, layout_table);
		grid.content_data.replaceWith(next_content_data);
		grid.content_data = next_content_data;

		// force the grid to resolve the new tracks before measuring
		void grid.list_body.offsetHeight;

		assert_header_intact(grid, `${shape} after pagination`);

		assert.equal(
			Math.abs(header_cells(grid)[0].getBoundingClientRect().height - header_height) <= 1,
			true,
			`the header row keeps its height across pagination (${header_height}px)`,
		);

		grid.section.remove();
	}; //end assert_pagination_swap

	it('keeps the LEGACY header unclipped and column-aligned across a pagination swap with mixed row heights', () => {
		assert_pagination_swap(false);
	});

	it('keeps the TABLE header unclipped and column-aligned across a pagination swap with mixed row heights', () => {
		assert_pagination_swap(true);
	});

	it('falls back to phone cards at ≤ 1024px (the table block does not apply)', () => {
		assert.equal(
			phone_win.matchMedia('(max-width: 1024px)').matches,
			true,
			'phone fixture viewport is below the desktop breakpoint',
		);

		const grid = make_grid(phone_doc, phone_container, FIRST_GENERATION_HEIGHTS);

		assert.equal(phone_win.getComputedStyle(grid.list_body).display, 'block', 'list_body is a block');
		assert.equal(phone_win.getComputedStyle(grid.header).display, 'none', 'the header is hidden');
		assert.equal(
			phone_win.getComputedStyle(grid.content_data).display,
			'block',
			'content_data is a block of cards',
		);
		for (const [i, row] of built_rows(grid).entries()) {
			const style = phone_win.getComputedStyle(row);
			assert.equal(style.display, 'grid', `card ${i} is a one-column grid`);
			assert.equal(is_subgrid(style.gridTemplateColumns), false, `card ${i} is not a subgrid`);
			assert.equal(style.gridColumnStart, 'auto', `card ${i} takes no table span`);
		}
		const placeholder = placeholders(grid)[0];
		const placeholder_style = phone_win.getComputedStyle(placeholder);
		assert.equal(placeholder_style.display, 'block', 'the placeholder is a plain block');
		const rem = parseFloat(phone_win.getComputedStyle(phone_doc.documentElement).fontSize);
		assert.equal(
			Math.abs(placeholder.getBoundingClientRect().height - rem * 2.5) <= 1,
			true,
			'the placeholder keeps its block size on phone',
		);

		grid.section.remove();
	});
});
