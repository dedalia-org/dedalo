// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* RENDER_LEGEND
* Two halves: the edit PANEL (tool chrome, left out of the map image), whose
* group list is rebuilt only on STRUCTURAL change (typing or a colour repaints
* just the overlay: a rebuild would drop focus or close the colour picker), and
* the OVERLAY, map CONTENT. The code says group/symbol, as the record does; the
* class names keep the old "column"/"element" on purpose: they are the
* stylesheet's and the client tests' contract.
*
* @module render_legend
*/



import {ui} from '../../../core/common/js/ui.js'
import {
	LEGEND_SYMBOL_SHAPES,
	default_legend_symbol,
	legend_symbol_node,
	is_raster_icon,
	ALLOWED_ICON_TYPES
} from './legend_symbol.js'
import {create_panel_message, show_panel_message} from './render_download_line.js'



/**
* RENDER_LEGEND_PANEL
* The header (title + ×) is `toolbar.js`'s: the panel opens centred.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_legend_panel = function(self, panel) {

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-form', parent: panel})

	const title_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-title-row', parent: form})

	const title_field = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-legend-field', parent: title_row})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-legend-field-label',
		text_content	: self.get_tool_label('legend_title_label') || 'Title',
		parent			: title_field
	})
	const title_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-legend-input uca-maps-legend-title-input',
		parent			: title_field
	})
	title_input.type		= 'text'
	title_input.placeholder	= self.get_tool_label('legend_title_placeholder') || 'Legend title'
	title_input.value		= self.legend.title
	title_input.addEventListener('input', () => {
		self.set_legend_title(title_input.value)
	})

	const show_label = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-legend-show-label', parent: title_row})
	const show_checkbox = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-legend-show', parent: show_label})
	show_checkbox.type		= 'checkbox'
	show_checkbox.checked	= self.legend.enable
	show_checkbox.addEventListener('change', () => {
		self.set_legend_visible(show_checkbox.checked)
	})
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('legend_show') || 'Show legend',
		parent			: show_label
	})

	ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-columns', parent: panel})

	// after the list, where the new group appears
	const add_group_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-add-column',
		text_content	: '+ ' + (self.get_tool_label('legend_add_column') || 'Add group'),
		parent			: panel
	})
	add_group_btn.type = 'button'
	add_group_btn.addEventListener('click', () => {
		const result = self.add_legend_group()
		populate_legend_groups(self, panel)
		focus_in_list(panel, result.index, null, '.uca-maps-legend-column-name')
	})

	// last and sticky to the panel's foot: the panel scrolls, and a note at its top
	// was out of sight while the user typed in a group further down
	create_panel_message(panel, 'uca-maps-legend-message')

	return panel
}//end render_legend_panel



/**
* SHOW_LEGEND_MESSAGE
* The panel's in-flow line (`render_download_line.js` show_panel_message). Its
* CLASS is the node `render_legend_panel` builds: renaming either side silently
* breaks the icon upload.
*
* @param {HTMLElement} panel
* @param {string} text
* @param {string} [type='error'] - 'error' | 'warning' (groups and items the save drops)
* @returns {void}
*/
export const show_legend_message = function(panel, text, type='error') {
	show_panel_message(panel.querySelector('.uca-maps-legend-message'), text, type)
}//end show_legend_message



/**
* CLEAR_LEGEND_MESSAGE
* An old refusal still showing on reopen describes something no longer
* happening, so it is cleared on open and before every new attempt.
*
* @param {HTMLElement} panel
* @returns {void}
*/
export const clear_legend_message = function(panel) {
	const message = panel && panel.querySelector('.uca-maps-legend-message')
	if (message) {
		message.hidden = true
	}
}//end clear_legend_message



/**
* POPULATE_LEGEND_GROUPS
* Rebuilds the group list from `self.legend.groups`, on every open and after
* every structural mutation.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_legend_groups = function(self, panel) {

	const list = panel.querySelector('.uca-maps-legend-columns')
	list.replaceChildren()

	if (!self.legend.groups.length) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-empty-state uca-maps-legend-empty',
			text_content	: self.get_tool_label('legend_empty') || 'The legend has no groups yet.',
			parent			: list
		})
		return
	}

	const group_count = self.legend.groups.length

	self.legend.groups.forEach((group, group_index) => {

		const group_node = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-column', parent: list})

		const group_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-column-row', parent: group_node})

		const name_field = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-legend-field', parent: group_row})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-legend-field-label',
			text_content	: self.get_tool_label('legend_column_label') || 'Group',
			parent			: name_field
		})
		const name_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'uca-maps-legend-input uca-maps-legend-column-name',
			parent			: name_field
		})
		name_input.type			= 'text'
		name_input.placeholder	= self.get_tool_label('legend_column_placeholder') || 'Group name'
		name_input.value			= group.name
		name_input.addEventListener('input', () => {
			self.set_legend_group_name(group_index, name_input.value)
		})

		render_move_buttons(self, group_row, group_index, group_count, (offset) => {
			const result = self.move_legend_group(group_index, offset)
			if (result.ok) {
				populate_legend_groups(self, panel)
				focus_move_button(panel, result.index, null, offset)
			}
		})

		const confirm_node = render_delete_group_confirm(self, panel, group_node, group_index)

		const delete_group_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-delete-column',
			text_content	: '✕',
			parent			: group_row
		})
		delete_group_btn.type	= 'button'
		delete_group_btn.title	= self.get_tool_label('legend_delete_column') || 'Delete group'
		delete_group_btn.setAttribute('aria-label', delete_group_btn.title)
		delete_group_btn.addEventListener('click', () => {
			// an empty group goes at once; one with symbols asks first, in
			// the panel — a page dialog would not show over a fullscreen map
			if (!group.symbols.length) {
				self.delete_legend_group(group_index)
				populate_legend_groups(self, panel)
				return
			}
			confirm_node.hidden = false
			confirm_node.querySelector('.uca-maps-legend-confirm-cancel').focus()
		})

		const symbols_list = ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-legend-elements', parent: group_node})

		group.symbols.forEach((symbol, symbol_index) => {
			render_symbol_row(self, panel, symbols_list, group_index, symbol_index, symbol)
		})

		// after the symbols, where the new one appears
		const add_symbol_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-add-element',
			text_content	: '+ ' + (self.get_tool_label('legend_add_element') || 'Add element'),
			parent			: group_node
		})
		add_symbol_btn.type = 'button'
		add_symbol_btn.addEventListener('click', () => {
			const result = self.add_legend_symbol(group_index)
			populate_legend_groups(self, panel)
			focus_in_list(panel, group_index, result.index, '.uca-maps-legend-element-name')
		})

	})

}//end populate_legend_groups



/**
* RENDER_DELETE_GROUP_CONFIRM
* The in-panel "are you sure" of a group that still has symbols: deleting
* it takes all of them.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {HTMLElement} group_node
* @param {number} group_index
* @returns {HTMLElement} the confirm line, hidden
*/
const render_delete_group_confirm = function(self, panel, group_node, group_index) {

	const confirm_node = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-confirm', parent: group_node})
	confirm_node.hidden = true

	ui.create_dom_element({
		element_type	: 'span',
		text_content	: self.get_tool_label('legend_confirm_delete_column') || 'Delete this group and all its elements?',
		parent			: confirm_node
	})

	const accept_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-confirm-delete',
		text_content	: self.get_tool_label('legend_confirm_delete') || 'Delete',
		parent			: confirm_node
	})
	accept_btn.type = 'button'
	accept_btn.addEventListener('click', () => {
		self.delete_legend_group(group_index)
		populate_legend_groups(self, panel)
	})

	const cancel_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-confirm-cancel',
		text_content	: self.get_tool_label('legend_confirm_cancel') || 'Cancel',
		parent			: confirm_node
	})
	cancel_btn.type = 'button'
	cancel_btn.addEventListener('click', () => {
		confirm_node.hidden = true
	})

	return confirm_node
}//end render_delete_group_confirm



/**
* RENDER_MOVE_BUTTONS
* ↑ / ↓, disabled at the ends of their list.
*
* @param {Object} self
* @param {HTMLElement} parent
* @param {number} index
* @param {number} count
* @param {function(number): void} on_move - receives -1 or +1
* @returns {void}
*/
const render_move_buttons = function(self, parent, index, count, on_move) {

	const buttons = [
		{offset: -1, glyph: '↑', class_name: 'uca-maps-legend-move-up', title: self.get_tool_label('legend_move_up') || 'Move up'},
		{offset: 1, glyph: '↓', class_name: 'uca-maps-legend-move-down', title: self.get_tool_label('legend_move_down') || 'Move down'}
	]

	for (const item of buttons) {
		const button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-move ' + item.class_name,
			text_content	: item.glyph,
			parent			: parent
		})
		button.type		= 'button'
		button.title	= item.title
		button.setAttribute('aria-label', item.title)
		button.disabled	= index + item.offset < 0 || index + item.offset >= count
		button.addEventListener('click', () => on_move(item.offset))
	}

}//end render_move_buttons



/**
* FOCUS_IN_LIST
* The list is rebuilt on every structural change, so the node that had focus
* is gone: put it back on the equivalent node of the new list.
*
* @param {HTMLElement} panel
* @param {number} group_index
* @param {number|null} symbol_index - null for the group's own row
* @param {string} selector
* @returns {HTMLElement|null} the node focused
*/
const focus_in_list = function(panel, group_index, symbol_index, selector) {

	const group_node	= panel.querySelectorAll('.uca-maps-legend-column')[group_index]
	const scope			= group_node && symbol_index!==null
		? group_node.querySelectorAll('.uca-maps-legend-element')[symbol_index]
		: group_node && group_node.querySelector('.uca-maps-legend-column-row')
	const node			= scope && scope.querySelector(selector)
	if (node) {
		node.focus()
	}

	return node || null
}//end focus_in_list



/**
* FOCUS_MOVE_BUTTON
* Keyboard users keep moving the same item; at the end of the list the
* button in that direction is disabled, so focus goes to its twin.
*
* @param {HTMLElement} panel
* @param {number} group_index
* @param {number|null} symbol_index
* @param {number} offset
* @returns {void}
*/
const focus_move_button = function(panel, group_index, symbol_index, offset) {

	const selector	= offset<0 ? '.uca-maps-legend-move-up' : '.uca-maps-legend-move-down'
	const twin		= offset<0 ? '.uca-maps-legend-move-down' : '.uca-maps-legend-move-up'
	const node		= focus_in_list(panel, group_index, symbol_index, selector)
	if (node && node.disabled) {
		focus_in_list(panel, group_index, symbol_index, twin)
	}

}//end focus_move_button



/**
* RENDER_SYMBOL_ROW
* Icon (a button opening the symbol editor) + label + ↑/↓ + delete, with
* that editor below it, closed.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {HTMLElement} symbols_list
* @param {number} group_index
* @param {number} symbol_index
* @param {Object} symbol - {label, icon, symbol?}
* @returns {void}
*/
const render_symbol_row = function(self, panel, symbols_list, group_index, symbol_index, symbol) {

	const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-legend-element', parent: symbols_list})

	const row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-element-row', parent: item})

	const symbol_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-symbol-button',
		parent			: row
	})
	symbol_btn.type		= 'button'
	symbol_btn.title	= self.get_tool_label('legend_symbol_button') || 'Change symbol'
	symbol_btn.setAttribute('aria-label', symbol_btn.title)
	symbol_btn.setAttribute('aria-expanded', 'false')

	// `src` assigned AFTER creation on purpose: create_dom_element's safe_url
	// refuses `data:`. A saved icon comes off the wire, so only a raster data
	// URI reaches the sink (is_raster_icon); an item without one shows none.
	const icon = ui.create_dom_element({element_type: 'img', class_name: 'uca-maps-legend-element-icon', parent: symbol_btn})
	set_icon_src(icon, symbol.icon)
	icon.width	= 18
	icon.height	= 18
	icon.alt	= ''

	const name_input = ui.create_dom_element({
		element_type	: 'input',
		class_name		: 'uca-maps-legend-input uca-maps-legend-element-name',
		parent			: row
	})
	name_input.type			= 'text'
	name_input.placeholder	= self.get_tool_label('legend_element_placeholder') || 'Element name'
	name_input.setAttribute('aria-label', name_input.placeholder)
	name_input.value			= symbol.label
	name_input.addEventListener('input', () => {
		self.set_legend_symbol_label(group_index, symbol_index, name_input.value)
	})

	const symbol_count = self.legend.groups[group_index].symbols.length
	render_move_buttons(self, row, symbol_index, symbol_count, (offset) => {
		const result = self.move_legend_symbol(group_index, symbol_index, offset)
		if (result.ok) {
			populate_legend_groups(self, panel)
			focus_move_button(panel, group_index, result.index, offset)
		}
	})

	const delete_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-delete-element',
		text_content	: '✕',
		parent			: row
	})
	delete_btn.type	= 'button'
	delete_btn.title	= self.get_tool_label('legend_delete_element') || 'Delete element'
	delete_btn.setAttribute('aria-label', delete_btn.title)
	delete_btn.addEventListener('click', () => {
		self.delete_legend_symbol(group_index, symbol_index)
		populate_legend_groups(self, panel)
	})

	const editor = render_symbol_editor(self, panel, item, icon, group_index, symbol_index, symbol)

	symbol_btn.addEventListener('click', () => {
		editor.hidden = !editor.hidden
		symbol_btn.setAttribute('aria-expanded', String(!editor.hidden))
	})

}//end render_symbol_row



/**
* RENDER_SYMBOL_EDITOR
* Shape + fill + stroke, or an uploaded image. Every gesture applies the whole
* drawing at once; nothing rebuilds the list, so the native colour picker stays
* open while dragging.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {HTMLElement} item - the symbol's <li>
* @param {HTMLImageElement} row_icon - the row's own symbol image, repainted in place
* @param {number} group_index
* @param {number} symbol_index
* @param {Object} symbol
* @returns {HTMLElement} the editor, hidden
*/
const render_symbol_editor = function(self, panel, item, row_icon, group_index, symbol_index, symbol) {

	// a symbol still on the pin, or on an uploaded image, opens on the defaults
	const current = Object.assign({}, symbol.symbol || default_legend_symbol())

	const editor = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-symbol-editor', parent: item})
	editor.hidden = true

	const shapes = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-legend-symbol-shapes', parent: editor})
	const shape_labels = {
		point	: self.get_tool_label('legend_symbol_point') || 'Point',
		line	: self.get_tool_label('legend_symbol_line') || 'Line',
		area	: self.get_tool_label('legend_symbol_area') || 'Area'
	}
	const shape_buttons = LEGEND_SYMBOL_SHAPES.map((shape) => {
		const button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-legend-symbol-shape',
			parent			: shapes
		})
		button.type				= 'button'
		button.dataset.shape	= shape
		button.addEventListener('click', () => {
			current.shape = shape
			apply()
		})
		return button
	})

	const fill_field = render_colour_field(editor, 'uca-maps-legend-symbol-fill', self.get_tool_label('legend_symbol_fill') || 'Fill', current.fill, (value) => {
		current.fill = value
		apply()
	})
	const stroke_field = render_colour_field(editor, 'uca-maps-legend-symbol-stroke', '', current.stroke, (value) => {
		current.stroke = value
		apply()
	})
	const stroke_text = stroke_field.querySelector('.uca-maps-legend-field-label')

	const upload_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-legend-upload-icon',
		text_content	: self.get_tool_label('legend_upload_icon') || 'Upload image',
		parent			: editor
	})
	upload_btn.type	= 'button'
	upload_btn.title	= self.get_tool_label('legend_upload_icon_title') || 'Upload an image as the symbol (recommended size 36x36)'
	upload_btn.addEventListener('click', () => {
		pick_icon_file(self, panel, group_index, symbol_index)
	})

	// the editor's own look follows `current`, applied or not yet
	const paint = function() {
		for (const button of shape_buttons) {
			const shape = button.dataset.shape
			button.setAttribute('aria-pressed', String(Boolean(symbol.symbol) && shape===current.shape))
			button.replaceChildren(
				legend_symbol_node(Object.assign({}, current, {shape: shape})),
				document.createTextNode(shape_labels[shape])
			)
		}
		// a line is one colour: the stroke
		fill_field.hidden		= current.shape==='line'
		stroke_text.textContent	= current.shape==='line'
			? (self.get_tool_label('legend_symbol_line_colour') || 'Colour')
			: (self.get_tool_label('legend_symbol_stroke') || 'Border')
	}

	const apply = function() {
		const result = self.set_legend_symbol_drawing(group_index, symbol_index, current)
		if (result.ok) {
			set_icon_src(row_icon, symbol.icon)
		}
		paint()
	}

	paint()

	return editor
}//end render_symbol_editor



/**
* RENDER_COLOUR_FIELD
* @param {HTMLElement} parent
* @param {string} class_name - the input's class
* @param {string} text - the visible label ('' to fill in later)
* @param {string} value - #rrggbb
* @param {function(string): void} on_input
* @returns {HTMLElement} the <label>
*/
const render_colour_field = function(parent, class_name, text, value, on_input) {

	const field = ui.create_dom_element({element_type: 'label', class_name: 'uca-maps-legend-field', parent: parent})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-legend-field-label',
		text_content	: text,
		parent			: field
	})
	const input = ui.create_dom_element({element_type: 'input', class_name: class_name, parent: field})
	input.type	= 'color'
	input.value	= value
	input.addEventListener('input', () => on_input(input.value))

	return field
}//end render_colour_field



/**
* PICK_ICON_FILE
* A throwaway file picker (v6's `change_icon` gesture): created, opened and
* dropped with the handler, so detach has nothing to clean.
*
* @param {Object} self
* @param {HTMLElement} panel
* @param {number} group_index
* @param {number} symbol_index
* @returns {void}
*/
const pick_icon_file = function(self, panel, group_index, symbol_index) {

	const file_input = document.createElement('input')
	file_input.type		= 'file'
	file_input.accept	= ALLOWED_ICON_TYPES.join(',')

	file_input.addEventListener('change', async () => {

		const file = file_input.files && file_input.files[0]
		if (!file) {
			return
		}

		clear_legend_message(panel)

		const result = await self.set_legend_symbol_icon(group_index, symbol_index, file)

		// the tool may be gone: the OS chooser can stay open across a teardown
		// (legend.js set_legend_symbol_icon carries the same guard)
		if (!self.legend_panel) {
			return
		}

		if (!result.ok && result.error) {
			show_legend_message(panel, result.error)
			return
		}

		populate_legend_groups(self, panel)

	})

	file_input.click()

}//end pick_icon_file



/**
* SET_ICON_SRC
* The one sink of a legend icon: only a raster `data:` URI is drawn; anything else
* leaves the image empty and hidden.
*
* @param {HTMLImageElement} image
* @param {*} icon
* @returns {void}
*/
const set_icon_src = function(image, icon) {
	if (is_raster_icon(icon)) {
		image.src		= icon
		image.hidden	= false
	} else {
		image.removeAttribute('src')
		image.hidden	= true
	}
}//end set_icon_src



/**
* CREATE_LEGEND_OVERLAY
* The legend on the map, its own L.Control in 'bottomleft' (public API; v6
* hangs from `map._controlCorners.topleft`, where this tool's buttons live).
* NOT a toolbar node, and named in `keep_in_map_image`: it is map content and
* belongs in the image.
*
* @param {Object} self
* @returns {Object} the L.Control
*/
export const create_legend_overlay = function(self) {

	const LegendOverlayControl = L.Control.extend({
		options : { position: 'bottomleft' },
		onAdd : function() {
			const container = L.DomUtil.create('div', 'uca-maps-legend-overlay')
			L.DomEvent.disableClickPropagation(container)
			L.DomEvent.disableScrollPropagation(container)
			return container
		}
	})

	self.legend_overlay = new LegendOverlayControl()
	self.legend_overlay.addTo(self.geolocation.map)

	return self.legend_overlay
}//end create_legend_overlay



/**
* RENDER_LEGEND_OVERLAY
* Repaints the whole overlay from `self.legend`. Hidden when the checkbox is
* off and when there is NOTHING to show (no title, no groups): v6 leaves an
* empty box on the map, which is noise, not information.
*
* @param {Object} self
* @returns {void}
*/
export const render_legend_overlay = function(self) {

	const container = self.legend_overlay && self.legend_overlay.getContainer()
	if (!container) {
		return
	}

	container.replaceChildren()

	const legend	= self.legend
	// emptiness is measured in what would be DRAWN, not in how many groups
	// exist: a group just created, still unnamed and with no symbols, paints
	// a blank white box — which is the noise this branch exists to avoid
	const is_empty	= !legend.title && !legend.groups.some((group) => group.name || group.symbols.length)
	container.hidden = !legend.enable || is_empty
	if (container.hidden) {
		return
	}

	if (legend.title) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-legend-overlay-title',
			text_content	: legend.title,
			parent			: container
		})
	}

	const groups_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-legend-overlay-columns',
		parent			: container
	})

	for (const group of legend.groups) {

		const group_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'uca-maps-legend-overlay-column',
			parent			: groups_node
		})

		if (group.name) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-legend-overlay-column-name',
				text_content	: group.name,
				parent			: group_node
			})
		}

		for (const symbol of group.symbols) {

			const symbol_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'uca-maps-legend-overlay-element',
				parent			: group_node
			})

			// same guarded sink as the panel row above
			const icon = ui.create_dom_element({element_type: 'img', parent: symbol_node})
			set_icon_src(icon, symbol.icon)
			icon.width	= 18
			icon.height	= 18
			icon.alt	= ''

			ui.create_dom_element({
				element_type	: 'span',
				text_content	: symbol.label,
				parent			: symbol_node
			})

		}

	}

}//end render_legend_overlay



/**
* REMOVE_LEGEND_OVERLAY
* @param {Object} self
* @returns {void}
*/
export const remove_legend_overlay = function(self) {

	if (!self.legend_overlay) {
		return
	}

	try {
		if (self.geolocation && self.geolocation.map) {
			self.geolocation.map.removeControl(self.legend_overlay)
		}
	} catch (error) {
		console.warn('tool_uca_maps legend: error removing the legend overlay', error)
	}

	self.legend_overlay = null

}//end remove_legend_overlay



// @license-end
