// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, get_label */
/*eslint no-undef: "error"*/

/**
 * TOOLBAR
 * One button + one panel per functionality, never a section inside another
 * panel. Builds the shared bar, the panel shells (beside their button, or
 * centred with a ×) and one-panel-at-a-time show/hide; content stays in each
 * render_X.js. Every node goes to `self._toolbar_nodes`, which the screenshot skips.
 *
 * @module toolbar
 */

const TOOLBAR_BUTTON_ACTIVE_CLASS = 'uca-maps-toolbar-button-active';

/**
 * MARK_TOOL_SCOPE
 * Stamps the box-free `data-tool` scope (scripts/tool_colors.ts) on a node that
 * hangs from the map, outside any .wrapper_tool: only there do the generated
 * colour tokens and the checkbox/radio accent reach it.
 *
 * @param {HTMLElement} node
 * @returns {void}
 */
export const mark_tool_scope = function (node) {
	node.setAttribute('data-tool', 'tool_uca_maps');
}; //end mark_tool_scope

/**
 * REGISTER_TOOLBAR_NODE
 * @param {Object} self - tool_uca_maps instance
 * @param {HTMLElement} node
 * @returns {void}
 */
export const register_toolbar_node = function (self, node) {
	self._toolbar_nodes = self._toolbar_nodes || [];
	self._toolbar_nodes.push(node);
}; //end register_toolbar_node

/**
 * UNREGISTER_TOOLBAR_NODE
 * @param {Object} self
 * @param {HTMLElement} node
 * @returns {void}
 */
const unregister_toolbar_node = function (self, node) {
	if (!self._toolbar_nodes) {
		return;
	}
	const index = self._toolbar_nodes.indexOf(node);
	if (index !== -1) {
		self._toolbar_nodes.splice(index, 1);
	}
}; //end unregister_toolbar_node

/**
 * IS_TOOLBAR_NODE
 * Used by `map_image_download.js`'s screenshot `filter` to exclude every DOM node
 * this tool owns, without naming each one.
 *
 * @param {Object} self
 * @param {Node} node
 * @returns {boolean}
 */
export const is_toolbar_node = function (self, node) {
	return Boolean(self._toolbar_nodes && self._toolbar_nodes.includes(node));
}; //end is_toolbar_node

/**
 * GET_TOOLBAR_BAR
 * The ONE 'topleft' L.Control every button lives in, built on first use: v6's
 * position, and Geoman's draw toolbar owns 'topright'. One bar, not one control per
 * button: Leaflet spaces and frames separate controls, so only shared bar markup
 * (`.leaflet-bar > a`) stacks the squares flush with a hairline between them.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {Object} the L.Control (self.geolocation.map already has it added)
 */
const get_toolbar_bar = function (self) {
	if (self._toolbar_bar) {
		return self._toolbar_bar;
	}

	const ToolbarControl = L.Control.extend({
		options: { position: 'topleft' },
		onAdd: function () {
			const container = L.DomUtil.create('div', 'leaflet-bar uca-maps-toolbar');
			mark_tool_scope(container);
			// prevent map drag/zoom/click from reaching the map through the bar
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);
			return container;
		},
	});

	const bar = new ToolbarControl();
	bar.addTo(self.geolocation.map);
	register_toolbar_node(self, bar.getContainer());
	self._toolbar_bar = bar;

	// a panel is placed when it opens; the map changing size under an open one
	// (fullscreen, a window resize, a phone turned) places it again
	self._toolbar_resize_observer = new ResizeObserver(() => reflow_open_panels(self));
	self._toolbar_resize_observer.observe(self.geolocation.map.getContainer());

	return bar;
}; //end get_toolbar_bar

/**
 * CREATE_TOOLBAR_BUTTON
 * Appends one toggle button to the shared bar, so attach order is top-to-bottom
 * order. Leaflet's own bar link (`a[role=button]`), so square, hover and focus match
 * the zoom and Geoman bars. The icon is a glyph only; the title is the
 * accessible name.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} options
 * @param {string} options.title - hover title and accessible name (get_tool_label result)
 * @param {string} options.icon - icon name: a core theme icon ('upload') or one of
 *	the tool's own in img/ ('xyz_basemaps'), each with its `.uca-maps-icon-<name>` rule
 * @param {string} options.class_name - identity class, e.g. 'uca-maps-control'
 * @param {Function} options.on_click
 * @returns {{getContainer: function(): HTMLElement}} the button handle
 */
export const create_toolbar_button = function (self, { title, icon, class_name, on_click }) {
	const bar = get_toolbar_bar(self);

	const button = L.DomUtil.create('a', 'uca-maps-toolbar-button ' + class_name, bar.getContainer());
	button.href = '#';
	button.title = title;
	button.setAttribute('role', 'button');
	button.setAttribute('aria-label', title);
	L.DomUtil.create('span', 'uca-maps-toolbar-glyph uca-maps-icon-' + icon, button);
	button.addEventListener('click', (event) => {
		event.preventDefault(); // the '#' href must not navigate
		on_click(event);
	});
	register_toolbar_node(self, button);

	return {
		getContainer: () => button,
	};
}; //end create_toolbar_button

/**
 * CREATE_TOOLBAR_PANEL
 * A floating panel appended to the map's own container, not another L.Control,
 * so arbitrary content does not fight Leaflet's corner layout. Hidden by default.
 * Unlike an L.Control it needs click/scroll propagation disabled explicitly, or a
 * slider inside drags the map.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} options
 * @param {string} options.class_name - identity class, e.g. 'uca-maps-console'
 * @param {Function} [options.on_hide] - called on every close that is not the
 *   panel's own toggle (a sibling opening, a centered panel's ×): a functionality
 *   armed while its panel is open (administrative_units.js) disarms here
 * @param {boolean} [options.centered] - open centred across the map near its
 *   top, where v6's modals sat: a list row needs more width than a column
 *   beside the buttons leaves. The header (title + ×) is built here
 * @param {string} [options.title] - the header title of a centered panel
 * @param {Function} [options.on_reflow] - called after the open panel is placed
 *   again because the map changed size: what hangs outside it follows
 *   (roman_empire.js's suggestion list)
 * @returns {HTMLElement} panel, already appended to the map container
 */
export const create_toolbar_panel = function (
	self,
	{ class_name, on_hide, centered, title, on_reflow },
) {
	const panel = document.createElement('div');
	panel.className = 'uca-maps-panel ' + class_name;
	mark_tool_scope(panel);
	panel.hidden = true;
	panel._on_hide = on_hide || null;
	panel._on_reflow = on_reflow || null;

	if (centered) {
		panel.classList.add('uca-maps-panel-centered');
		render_centered_panel_header(panel, title);
	}

	L.DomEvent.disableClickPropagation(panel);
	L.DomEvent.disableScrollPropagation(panel);

	self.geolocation.map.getContainer().appendChild(panel);
	register_toolbar_node(self, panel);

	return panel;
}; //end create_toolbar_panel

/**
 * RENDER_CENTERED_PANEL_HEADER
 * Same header shape every render_X.js builds for itself, plus the ×. Built
 * here so the × cannot differ between centered panels.
 *
 * @param {HTMLElement} panel
 * @param {string} title
 * @returns {void}
 */
const render_centered_panel_header = function (panel, title) {
	const header = document.createElement('div');
	header.className = 'uca-maps-panel-header';

	const title_node = document.createElement('span');
	title_node.className = 'uca-maps-panel-title';
	title_node.textContent = title;

	const close_label = get_label.close || 'Close';
	const close_button = document.createElement('button');
	close_button.type = 'button';
	close_button.className = 'uca-maps-panel-close';
	close_button.textContent = '×';
	close_button.title = close_label;
	close_button.setAttribute('aria-label', close_label);
	close_button.addEventListener('click', () => close_toolbar_panel(panel));

	header.append(title_node, close_button);
	panel.appendChild(header);
}; //end render_centered_panel_header

/**
 * ANCHOR_PANEL_TO_BUTTON
 * Places `panel` right of its button, top-aligned, measured live
 * (getBoundingClientRect) so it holds however many buttons sit above. Re-run on
 * every show and by reflow_open_panels when the map changes size.
 *
 * @param {HTMLElement} panel
 * @param {Object} control - the handle create_toolbar_button returned
 * @returns {void}
 */
const anchor_panel_to_button = function (panel, control) {
	const button_container = control && control.getContainer && control.getContainer();
	const map_container = panel.parentNode;
	if (!button_container || !map_container) {
		return;
	}

	const button_rect = button_container.getBoundingClientRect();
	const map_rect = map_container.getBoundingClientRect();

	// custom properties, not top/left: an inline top/left would beat the phone
	// rule that lays every panel beside the bar instead
	panel.style.setProperty(
		'--uca_maps_anchor_top',
		Math.round(button_rect.top - map_rect.top) + 'px',
	);
	panel.style.setProperty(
		'--uca_maps_anchor_left',
		Math.round(button_rect.right - map_rect.left + 8) + 'px',
	);
}; //end anchor_panel_to_button

/**
 * MEASURE_BAR_EDGE
 * Where the toolbar ends, and where the core's view box (`.map_inputs`, a
 * sibling the map cannot stack above) ends, measured live like
 * anchor_panel_to_button. Only the phone rule reads them: there every panel
 * fills the map beside the bar and below that box, so the bar stays reachable
 * to switch panels and the panel's header is never under the box.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {HTMLElement} panel
 * @returns {void}
 */
const measure_bar_edge = function (self, panel) {
	const bar_container = self._toolbar_bar && self._toolbar_bar.getContainer();
	const map_container = panel.parentNode;
	if (!bar_container || !map_container) {
		return;
	}

	const bar_rect = bar_container.getBoundingClientRect();
	const map_rect = map_container.getBoundingClientRect();
	const left = Math.round(bar_rect.right - map_rect.left + 8);
	panel.style.setProperty('--uca_maps_bar_edge', left + 'px');

	let top = 8;
	const view_box =
		map_container.parentNode && map_container.parentNode.querySelector(':scope > .map_inputs');
	if (view_box) {
		const box_rect = view_box.getBoundingClientRect();
		if (
			box_rect.height > 0 &&
			box_rect.right > map_rect.left + left &&
			box_rect.bottom > map_rect.top
		) {
			top = Math.max(top, Math.round(box_rect.bottom - map_rect.top + 8));
		}
	}
	panel.style.setProperty('--uca_maps_panel_top', top + 'px');
}; //end measure_bar_edge

/**
 * REFLOW_OPEN_PANELS
 * The map changed size: the open panel is measured again, as on show, and then
 * told (`on_reflow`), so a list anchored to one of its fields follows a centred
 * panel that the new width moved.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const reflow_open_panels = function (self) {
	for (const node of self._toolbar_nodes || []) {
		if (!node.classList || !node.classList.contains('uca-maps-panel') || node.hidden) {
			continue;
		}
		if (!node.classList.contains('uca-maps-panel-centered')) {
			anchor_panel_to_button(node, node._toolbar_control);
		}
		measure_bar_edge(self, node);
		if (typeof node._on_reflow === 'function') {
			node._on_reflow();
		}
	}
}; //end reflow_open_panels

/**
 * IS_TOOLBAR_PANEL_VISIBLE
 * The authoritative "is this panel open": the DOM `hidden` attribute, never a JS
 * flag, because opening a sibling closes this panel directly in the DOM. Every
 * toggle_X computes its next state from this.
 *
 * @param {HTMLElement|null} panel
 * @returns {boolean}
 */
export const is_toolbar_panel_visible = function (panel) {
	return Boolean(panel && !panel.hidden);
}; //end is_toolbar_panel_visible

/**
 * SET_TOOLBAR_PANEL_VISIBLE
 * Opening a panel first closes every other `.uca-maps-panel` in
 * `self._toolbar_nodes`: one functionality open at a time, as v6's modals never
 * stacked. Generic, so a new functionality needs no wiring here.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {HTMLElement} panel
 * @param {Object} control - the panel's own toggle button
 * @param {boolean} visible
 * @returns {void}
 */
export const set_toolbar_panel_visible = function (self, panel, control, visible) {
	if (visible) {
		close_other_toolbar_panels(self, panel);
		// a centered panel is placed by CSS alone
		if (!panel.classList.contains('uca-maps-panel-centered')) {
			anchor_panel_to_button(panel, control);
		}
		measure_bar_edge(self, panel);
	}
	panel.hidden = !visible;
	// remembered so a close that does not come through here clears it too
	panel._toolbar_control = control;
	set_toolbar_button_active(control, visible);
}; //end set_toolbar_panel_visible

/**
 * SET_TOOLBAR_BUTTON_ACTIVE
 * The pressed look of a button whose panel is open — the same look the
 * toggles without a panel (1x1, Catastro, GPS) wear while armed.
 *
 * @param {Object|null} control
 * @param {boolean} active
 * @returns {void}
 */
const set_toolbar_button_active = function (control, active) {
	set_toolbar_button_armed(control, TOOLBAR_BUTTON_ACTIVE_CLASS, active);
}; //end set_toolbar_button_active

/**
 * IS_TOOLBAR_BUTTON_ARMED / SET_TOOLBAR_BUTTON_ARMED
 * A toggle without a panel (1x1, Catastro, GPS) is armed while its button
 * carries its own class: the DOM is the state, never a JS flag.
 *
 * @param {Object|null} control - the handle create_toolbar_button returned
 * @param {string} class_name - the toggle's own armed class
 * @returns {boolean}
 */
export const is_toolbar_button_armed = function (control, class_name) {
	const container = control?.getContainer?.();
	return Boolean(container && container.classList.contains(class_name));
}; //end is_toolbar_button_armed

/**
 * @param {Object|null} control
 * @param {string} class_name
 * @param {boolean} armed
 * @returns {void}
 */
export const set_toolbar_button_armed = function (control, class_name, armed) {
	const container = control?.getContainer?.();
	if (container) {
		container.classList.toggle(class_name, armed === true);
	}
}; //end set_toolbar_button_armed

/**
 * CLOSE_OTHER_TOOLBAR_PANELS
 * Closes every panel but `panel_to_keep_open` through `close_toolbar_panel`, so
 * each one's `on_hide` learns it was closed by a sibling.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {HTMLElement} panel_to_keep_open
 * @returns {void}
 */
const close_other_toolbar_panels = function (self, panel_to_keep_open) {
	const nodes = self._toolbar_nodes || [];
	for (const node of nodes) {
		if (
			node !== panel_to_keep_open &&
			node.classList &&
			node.classList.contains('uca-maps-panel')
		) {
			close_toolbar_panel(node);
		}
	}
}; //end close_other_toolbar_panels

/**
 * CLOSE_TOOLBAR_PANEL
 * Every close that is not the panel's own toggle — a sibling opening, or a
 * centered panel's × — so `on_hide` fires on each of them alike.
 *
 * @param {HTMLElement} panel
 * @returns {void}
 */
const close_toolbar_panel = function (panel) {
	if (panel.hidden) {
		return;
	}
	panel.hidden = true;
	set_toolbar_button_active(panel._toolbar_control, false);
	if (typeof panel._on_hide === 'function') {
		panel._on_hide();
	}
}; //end close_toolbar_panel

/**
 * REMOVE_TOOLBAR_BUTTON
 * Takes the button out of the bar; the bar goes with its last button.
 *
 * @param {Object} self
 * @param {Object} control - the handle create_toolbar_button returned
 * @returns {void}
 */
export const remove_toolbar_button = function (self, control) {
	if (!control) {
		return;
	}
	const button = control.getContainer();
	unregister_toolbar_node(self, button);
	button.remove();

	const bar = self._toolbar_bar;
	if (bar && !bar.getContainer().querySelector('.uca-maps-toolbar-button')) {
		if (self._toolbar_resize_observer) {
			self._toolbar_resize_observer.disconnect();
			self._toolbar_resize_observer = null;
		}
		unregister_toolbar_node(self, bar.getContainer());
		try {
			if (self.geolocation && self.geolocation.map) {
				self.geolocation.map.removeControl(bar);
			} else {
				bar.getContainer().remove();
			}
		} catch (error) {
			console.warn('tool_uca_maps toolbar: error removing the toolbar', error);
		}
		self._toolbar_bar = null;
	}
}; //end remove_toolbar_button

/**
 * REMOVE_TOOLBAR_PANEL
 * @param {Object} self
 * @param {HTMLElement} panel
 * @returns {void}
 */
export const remove_toolbar_panel = function (self, panel) {
	if (!panel) {
		return;
	}
	unregister_toolbar_node(self, panel);
	if (panel.parentNode) {
		panel.parentNode.removeChild(panel);
	}
}; //end remove_toolbar_panel

// @license-end
