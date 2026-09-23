// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, get_label */
/*eslint no-undef: "error"*/



/**
* TOOLBAR
*
* Shared substrate for the "one button = one functionality" left-toolbar
* pattern this tool follows for EVERY functionality from now on (Sergio,
* 2026-09-04 — see CLAUDE.local.md "Left toolbar: un botón por
* funcionalidad"). Before this file, the hito-2/3 "UCA" button opened ONE
* panel that bundled the object console, server capabilities AND the
* map-image-download picker together in collapsible sections — the audit
* (`docs/Funcionalidades de tool_leaflet_special_tools.md`) lists 15
* SEPARATE functionalities, not one growing drawer, and Sergio confirmed
* live (2026-09-04) that the bundled panel read as an incorrect approach,
* not as "features still landing". From this revision onward every
* functionality this tool adds gets its OWN 'topleft' toggle button + its
* OWN anchored panel, built through this module — never appended as a
* section inside another functionality's panel.
*
* What lives here (the identical boilerplate every button+panel pair would
* otherwise repeat, hito after hito): building the L.Control toggle button,
* building the floating panel shell and anchoring it to ITS OWN button (so N
* independently-openable panels never start life stacked on top of each
* other, however many buttons end up in the corner by hito 7), show/hide —
* opening one panel closes every OTHER one this tool owns first (Sergio,
* 2026-09-04: only one open at a time, see SET_TOOLBAR_PANEL_VISIBLE below) —
* and teardown. What does NOT live here: a panel's actual content — that
* stays in each functionality's own render_X.js, exactly like
* render_object_console.js / render_map_image_download.js already did.
*
* A panel can instead open CENTERED across the map, near its top, with a × to
* close it (`centered: true`, Sergio 2026-09-23, first used by "WMS" and meant
* for the rest): v6's own modals sat there, and a list row needs more width
* than a column beside the buttons leaves.
*
* Every node this module builds is also pushed onto `self._toolbar_nodes` —
* the ONE registry `map_image_download.js`'s screenshot capture filters out
* (previously two hardcoded node references, `self.map_control`/
* `self.panel_node` — correct for exactly one button, silently wrong the
* moment a second one existed; fixed here rather than left to rot further
* once a third/fourth button lands).
*
* @module toolbar
*/



/**
* REGISTER_TOOLBAR_NODE
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} node
* @returns {void}
*/
export const register_toolbar_node = function(self, node) {
	self._toolbar_nodes = self._toolbar_nodes || []
	self._toolbar_nodes.push(node)
}//end register_toolbar_node



/**
* UNREGISTER_TOOLBAR_NODE
* @param {Object} self
* @param {HTMLElement} node
* @returns {void}
*/
const unregister_toolbar_node = function(self, node) {
	if (!self._toolbar_nodes) {
		return
	}
	const index = self._toolbar_nodes.indexOf(node)
	if (index!==-1) {
		self._toolbar_nodes.splice(index, 1)
	}
}//end unregister_toolbar_node



/**
* IS_TOOLBAR_NODE
* Used by `map_image_download.js`'s screenshot `filter` to exclude every DOM
* node this tool owns, generically, instead of naming each one — see file
* header.
*
* @param {Object} self
* @param {Node} node
* @returns {boolean}
*/
export const is_toolbar_node = function(self, node) {
	return Boolean(self._toolbar_nodes && self._toolbar_nodes.includes(node))
}//end is_toolbar_node



/**
* CREATE_TOOLBAR_BUTTON
* Builds and adds a 'topleft' L.Control toggle button. 'topleft' (not
* 'topright', which Geoman's own draw toolbar already owns —
* `component_geolocation.js` `map.pm.addControls({position: 'topright', ...})`)
* matches v6's own `special_tools` control position and keeps every one of
* this tool's own buttons in the same corner, stacking automatically via
* Leaflet's own corner layout — no manual offset bookkeeping needed here.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} options
* @param {string} options.title - hover title (get_tool_label result)
* @param {string} options.text - the button's own visible text
* @param {string} options.class_name - identity class, e.g. 'uca-maps-control'
* @param {Function} options.on_click
* @returns {Object} the L.Control instance (self.geolocation.map already has it added)
*/
export const create_toolbar_button = function(self, {title, text, class_name, on_click}) {

	const ToolbarButtonControl = L.Control.extend({
		options : { position: 'topleft' },
		onAdd : function() {
			const container = L.DomUtil.create('div', 'leaflet-bar uca-maps-toolbar-button ' + class_name)
			container.title		= title
			container.textContent	= text
			container.addEventListener('click', on_click)
			// prevent map drag/zoom/click from reaching the map through this control
			L.DomEvent.disableClickPropagation(container)
			L.DomEvent.disableScrollPropagation(container)
			return container
		}
	})

	const control = new ToolbarButtonControl()
	control.addTo(self.geolocation.map)
	register_toolbar_node(self, control.getContainer())

	return control
}//end create_toolbar_button



/**
* CREATE_TOOLBAR_PANEL
* Builds a floating panel appended directly to the map's own DOM container
* (never another L.Control — a bare div holds arbitrary interactive content
* without fighting Leaflet's control-corner layout, same reasoning as the
* original object-console panel). Hidden by default. Needs
* disableClickPropagation/disableScrollPropagation explicitly (unlike an
* L.Control, which Leaflet wraps with this same guard via its own
* container) — missing it is why hito 2a's opacity slider dragged the MAP
* instead of the control the first time this shell was built.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} options
* @param {string} options.class_name - identity class, e.g. 'uca-maps-console'
* @param {Function} [options.on_hide] - called when THIS panel is force-closed
*   by a SIBLING panel opening (close_other_toolbar_panels, below) — never
*   called for the panel's own toggle-off (that path already runs whatever
*   its own toggle_X handler does). Needed by any functionality whose
*   "armed" state is tied to panel visibility (administrative_units.js:
*   without this, a sibling panel forcing UA's panel hidden left its overlay
*   tile layer and map 'click' listener running with no panel visible to
*   show for it — review-diff finding, hito 11). A centered panel's × is
*   the same kind of close and fires it too.
* @param {boolean} [options.centered] - open centred across the map near its
*   top, not beside the button;
*   toolbar.js then builds the header itself (title + ×)
* @param {string} [options.title] - the header title of a centered panel
* @returns {HTMLElement} panel, already appended to the map container
*/
export const create_toolbar_panel = function(self, {class_name, on_hide, centered, title}) {

	const panel = document.createElement('div')
	panel.className	= 'uca-maps-panel ' + class_name
	panel.hidden	= true
	panel._on_hide	= on_hide || null

	if (centered) {
		panel.classList.add('uca-maps-panel-centered')
		render_centered_panel_header(panel, title)
	}

	L.DomEvent.disableClickPropagation(panel)
	L.DomEvent.disableScrollPropagation(panel)

	self.geolocation.map.getContainer().appendChild(panel)
	register_toolbar_node(self, panel)

	return panel
}//end create_toolbar_panel



/**
* RENDER_CENTERED_PANEL_HEADER
* Same header shape every render_X.js builds for itself, plus the ×. Built
* here so the × cannot differ between centered panels.
*
* @param {HTMLElement} panel
* @param {string} title
* @returns {void}
*/
const render_centered_panel_header = function(panel, title) {

	const header = document.createElement('div')
	header.className = 'uca-maps-panel-header'

	const title_node = document.createElement('span')
	title_node.className	= 'uca-maps-panel-title'
	title_node.textContent	= title

	const close_label = get_label.close || 'Close'
	const close_button = document.createElement('button')
	close_button.type			= 'button'
	close_button.className		= 'uca-maps-panel-close'
	close_button.textContent	= '×'
	close_button.title			= close_label
	close_button.setAttribute('aria-label', close_label)
	close_button.addEventListener('click', () => close_toolbar_panel(panel))

	header.append(title_node, close_button)
	panel.appendChild(header)
}//end render_centered_panel_header



/**
* ANCHOR_PANEL_TO_BUTTON
* Positions `panel` directly to the right of `control`'s own button, top-
* aligned with it — measured live against the DOM (getBoundingClientRect)
* rather than a hardcoded rem offset, so it stays correct regardless of how
* many buttons end up stacked above it in the corner (the pre-refactor CSS
* pinned a single `top`/`left` for the one button that existed then; that
* value was already wrong the moment a second button existed — this
* replaces it). Re-run every time the panel is SHOWN (see
* set_toolbar_panel_visible), not on every resize — matches the level of
* robustness the rest of this tool's own UI already assumes (e.g. the
* transient modal's fixed visible window) and keeps this module simple; a
* panel already open when the map resizes/reflows is a known, accepted gap,
* not a regression this refactor introduces (the previous hardcoded CSS
* offset had the exact same gap).
*
* @param {HTMLElement} panel
* @param {Object} control - the L.Control returned by create_toolbar_button
* @returns {void}
*/
export const anchor_panel_to_button = function(panel, control) {

	const button_container	= control && control.getContainer && control.getContainer()
	const map_container		= panel.parentNode
	if (!button_container || !map_container) {
		return
	}

	const button_rect	= button_container.getBoundingClientRect()
	const map_rect		= map_container.getBoundingClientRect()

	panel.style.top		= Math.round(button_rect.top - map_rect.top) + 'px'
	panel.style.left		= Math.round(button_rect.right - map_rect.left + 8) + 'px'

}//end anchor_panel_to_button



/**
* IS_TOOLBAR_PANEL_VISIBLE
* The authoritative "is this panel currently open" read — the DOM `hidden`
* attribute itself, never a separate JS boolean a caller might keep (see
* SET_TOOLBAR_PANEL_VISIBLE below: opening one panel force-closes every
* other one directly in the DOM, so a per-functionality flag mirroring
* "visible" would desync the instant a SIBLING panel closes it). Every
* toggle_X function (object_console.js/map_image_download.js/
* capabilities_panel.js) computes its next state from this, not from a
* cached flag.
*
* @param {HTMLElement|null} panel
* @returns {boolean}
*/
export const is_toolbar_panel_visible = function(panel) {
	return Boolean(panel && !panel.hidden)
}//end is_toolbar_panel_visible



/**
* SET_TOOLBAR_PANEL_VISIBLE
* Opening a panel closes every OTHER panel this tool owns first — Sergio,
* 2026-09-04: only one functionality's panel should be open at a time, the
* same way v6's own separate modals never stacked several open at once.
* Generic over every current AND future functionality: it walks
* `self._toolbar_nodes` (toolbar.js's own registry, populated by
* create_toolbar_panel) and hides every node carrying the shared
* `.uca-maps-panel` class other than the one being opened — no
* per-functionality wiring needed as hitos 4-7 add more buttons.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {Object} control - the panel's own toggle button
* @param {boolean} visible
* @returns {void}
*/
export const set_toolbar_panel_visible = function(self, panel, control, visible) {
	if (visible) {
		close_other_toolbar_panels(self, panel)
		// a centered panel is placed by CSS alone
		if (!panel.classList.contains('uca-maps-panel-centered')) {
			anchor_panel_to_button(panel, control)
		}
	}
	panel.hidden = !visible
}//end set_toolbar_panel_visible



/**
* CLOSE_OTHER_TOOLBAR_PANELS
* Fires each hidden panel's own `on_hide` (create_toolbar_panel option), if
* it has one — the only way a functionality whose "armed" state is tied to
* panel visibility (administrative_units.js) learns it was force-closed by a
* SIBLING instead of by its own toggle.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel_to_keep_open
* @returns {void}
*/
const close_other_toolbar_panels = function(self, panel_to_keep_open) {
	const nodes = self._toolbar_nodes || []
	for (const node of nodes) {
		if (node!==panel_to_keep_open && node.classList && node.classList.contains('uca-maps-panel')) {
			close_toolbar_panel(node)
		}
	}
}//end close_other_toolbar_panels



/**
* CLOSE_TOOLBAR_PANEL
* Every close that is not the panel's own toggle — a sibling opening, or a
* centered panel's × — so `on_hide` fires on each of them alike.
*
* @param {HTMLElement} panel
* @returns {void}
*/
const close_toolbar_panel = function(panel) {
	if (panel.hidden) {
		return
	}
	panel.hidden = true
	if (typeof panel._on_hide==='function') {
		panel._on_hide()
	}
}//end close_toolbar_panel



/**
* REMOVE_TOOLBAR_BUTTON
* @param {Object} self
* @param {Object} control
* @returns {void}
*/
export const remove_toolbar_button = function(self, control) {
	if (!control) {
		return
	}
	try {
		if (self.geolocation && self.geolocation.map) {
			unregister_toolbar_node(self, control.getContainer())
			self.geolocation.map.removeControl(control)
		}
	} catch (error) {
		console.warn('tool_uca_maps toolbar: error removing a toolbar button', error)
	}
}//end remove_toolbar_button



/**
* REMOVE_TOOLBAR_PANEL
* @param {Object} self
* @param {HTMLElement} panel
* @returns {void}
*/
export const remove_toolbar_panel = function(self, panel) {
	if (!panel) {
		return
	}
	unregister_toolbar_node(self, panel)
	if (panel.parentNode) {
		panel.parentNode.removeChild(panel)
	}
}//end remove_toolbar_panel



// @license-end
