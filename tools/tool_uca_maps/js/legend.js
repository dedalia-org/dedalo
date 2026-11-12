// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* LEGEND
* A MANUAL legend editor (title, columns of icon+text items) and its overlay, as v6:
* nothing is generated from the WMS layers. It is kept in the record, as the geolocation
* entry's `legend` ({title, groups: [{name, symbols: [{label, icon}]}]}): every edit is
* written to the component's buffer and marks it dirty, and the component's save button
* commits it with the map, as a drawing (none of v6's 3 s autosaves). The overlay is map
* content, not a toolbar node, so the map image download includes it.
*
* @module legend
*/



import {strip_tags} from '../../../core/common/js/utils/util.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {
	render_legend_panel,
	populate_legend_columns,
	clear_legend_message,
	show_legend_message,
	create_legend_overlay,
	render_legend_overlay,
	remove_legend_overlay
} from './render_legend.js'
import {
	default_symbol_colour,
	is_legend_symbol,
	legend_symbol_data_url,
	pin_data_url,
	is_raster_icon,
	LEGEND_ICON_SIDE
} from './legend_symbol.js'
import {LEGEND_LIMITS, LEGEND_TAG_START, is_control_code} from './core_limits.js'



/** The icon types v6 accepts (`special_tools_legend.js` change_icon). Every one is
* redrawn as a small PNG before it is kept (`raster_icon`): the record admits only
* png, jpeg or webp icons of at most 64 KiB, never SVG. */
// exported for the client gate
export const ALLOWED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

/** v6's cap on the file picked, verbatim: what is kept is the redrawn icon. */
// exported for the client gate
export const MAX_ICON_BYTES = 2000000

/** A new item's default pin, a PNG drawn here (v6 serves `img/pin.svg`). */
// exported for the client gate
export const default_element_icon = function() {
	return pin_data_url(default_symbol_colour())
}//end default_element_icon



/**
* EMPTY_LEGEND
* The same shape v6 writes to its JSON the first time
* (`{"legend":"", "enable":true, "columns":[]}`): the editor's own model, which
* `to_entry_legend` turns into the record's.
*
* @returns {Object}
*/
// exported for the client gate
export const empty_legend = function() {
	return {legend: '', enable: true, columns: []}
}//end empty_legend



/**
* FROM_ENTRY_LEGEND
* The editor's model of a saved legend. An icon that is not a raster `data:` URI is
* dropped (the item shows none), never handed to an `<img>`. `enable` is not saved: a
* reopened legend is shown.
*
* @param {*} entry_legend - the entry's `legend`
* @returns {Object} {legend, enable, columns}
*/
// exported for the client gate
export const from_entry_legend = function(entry_legend) {

	const legend = empty_legend()
	if (!entry_legend || typeof entry_legend!=='object') {
		return legend
	}

	legend.legend	= typeof entry_legend.title==='string' ? entry_legend.title : ''
	legend.columns	= (Array.isArray(entry_legend.groups) ? entry_legend.groups : []).map((group) => ({
		name		: typeof group?.name==='string' ? group.name : '',
		elements	: (Array.isArray(group?.symbols) ? group.symbols : []).map((symbol) => ({
			name	: typeof symbol?.label==='string' ? symbol.label : '',
			icon	: is_raster_icon(symbol?.icon) ? symbol.icon : null
		}))
	}))

	return legend
}//end from_entry_legend



/**
* LEGEND_TEXT
* A text as the core keeps it: a control character as a space, trimmed.
*
* @param {string} text
* @returns {string}
*/
const legend_text = function(text) {
	return Array.from(String(text ?? ''), (char) => is_control_code(char.codePointAt(0)) ? ' ' : char).join('').trim()
}//end legend_text



/**
* ICON_PIXELS
* The pixels an icon declares: a PNG's own header (every icon the tool makes is one); for
* another format, the core's largest icon, so the total is never under-counted.
*
* @param {string} icon - a raster data URI (is_raster_icon)
* @returns {number}
*/
const icon_pixels = function(icon) {

	const prefix = 'data:image/png;base64,'
	if (icon.startsWith(prefix)) {
		// signature (8) + IHDR length and type (8) + width (4) + height (4): 32 base64 characters
		const head = atob(icon.slice(prefix.length, prefix.length + 32))
		const read = (at) => ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0
		if (head.length===24) {
			return read(16) * read(20)
		}
	}

	return LEGEND_LIMITS.maxIconSide * LEGEND_LIMITS.maxIconSide
}//end icon_pixels



/**
* LEGEND_REFUSAL
* Why the core would refuse this legend (`map_legend.ts`), or null: the panel says so and
* the legend is not written, since a refused legend fails the whole geolocation save.
*
* @param {Object} value - to_entry_legend's value
* @returns {'too_long'|'markup'|'too_big'|null}
*/
// exported for the client gate
export const legend_refusal = function(value) {

	const limits	= LEGEND_LIMITS
	const texts		= [value.title, ...value.groups.flatMap((group) => [group.name, ...group.symbols.map((symbol) => symbol.label)])]
	if (value.title.length>limits.maxTitle
		|| value.groups.length>limits.maxGroups
		|| value.groups.some((group) => group.name.length>limits.maxName
			|| group.symbols.length>limits.maxSymbolsPerGroup
			|| group.symbols.some((symbol) => symbol.label.length>limits.maxLabel))) {
		return 'too_long'
	}
	if (texts.some((text) => LEGEND_TAG_START.test(text))) {
		return 'markup'
	}

	const icons = value.groups.flatMap((group) => group.symbols).map((symbol) => symbol.icon).filter(Boolean)
	if (icons.reduce((total, icon) => total + icon.length, 0)>limits.maxIconCharsTotal
		|| icons.reduce((total, icon) => total + icon_pixels(icon), 0)>limits.maxIconPixelsTotal) {
		return 'too_big'
	}

	return null
}//end legend_refusal



/**
* TO_ENTRY_LEGEND
* The record's form of the editor's legend. The core requires a group's name and an
* item's text, so a group without a name and an item without text are left out (and
* counted: the panel says so). Nothing to keep is null: the entry then carries no key.
*
* @param {Object} legend - the editor's model
* @returns {{value: Object|null, skipped: number}}
*/
// exported for the client gate
export const to_entry_legend = function(legend) {

	let skipped		= 0
	const groups	= []
	for (const column of legend.columns) {
		const name = legend_text(column.name)
		if (!name) {
			skipped += column.elements.length + 1
			continue
		}
		const symbols = []
		for (const element of column.elements) {
			const label = legend_text(element.name)
			if (!label) {
				skipped++
				continue
			}
			if (is_raster_icon(element.icon)) {
				symbols.push({label, icon: element.icon})
			} else {
				symbols.push({label})
			}
		}
		groups.push({name, symbols})
	}

	const title = legend_text(legend.legend)
	const value = (title || groups.length)
		? {title, groups}
		: null

	return {value, skipped}
}//end to_entry_legend



/**
* LEGEND_CHANGED
* Every edit of the legend's content: the overlay repaints, the record's form is written
* to the component's buffer and the component is marked dirty (nothing saves: the
* component's button does, as for a drawing). A legend the core would refuse
* (`legend_refusal`) is not written, since the save would be refused whole: the panel says
* so instead.
*
* @param {Object} self
* @returns {void}
*/
const legend_changed = function(self) {

	render_legend_overlay(self)

	const geolocation	= self.geolocation
	const {value, skipped} = to_entry_legend(self.legend)

	const refusal = value ? legend_refusal(value) : null
	if (refusal) {
		const refusals = {
			too_long	: self.get_tool_label('legend_error_too_long') || 'The legend cannot be saved: at most 16 groups of 64 items, and 200 characters per text.',
			markup		: self.get_tool_label('legend_error_markup') || 'The legend cannot be saved: a text may not hold markup (a < followed by a letter).',
			too_big		: self.get_tool_label('legend_error_too_big') || 'The legend\'s images are too large to save: remove some of them.'
		}
		show_legend_message(self.legend_panel, refusals[refusal])
		return
	}

	const buffer = geolocation.get_entry_buffer(0)
	if (value) {
		buffer.legend = value
	} else {
		delete buffer.legend
	}
	geolocation.is_data_changed = true
	geolocation.set_changed_data(geolocation.build_changed_data_item(0))

	if (skipped > 0) {
		// a warning, not a note: on save, what the user typed there is lost
		show_legend_message(self.legend_panel, self.get_tool_label('legend_note_unsaved') || 'A group without a name, and an item without text, are not saved.', 'warning')
	} else {
		clear_legend_message(self.legend_panel)
	}
}//end legend_changed



/**
* ATTACH_LEGEND
* The overlay goes 'bottomleft', the only free corner: this tool's buttons, Geoman's
* toolbar and the scale bar hold the other three. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_legend = function(self) {

	if (self.legend_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	// what the user is editing (an unsaved buffer) or else what the record keeps
	const entry = self.geolocation.current_value?.[0] || self.geolocation.get_stored_entry(0)
	self.legend = from_entry_legend(entry && entry.legend)

	const title = self.get_tool_label('legend_control_title') || 'Legend'

	self.legend_control = create_toolbar_button(self, {
		title		: title,
		icon		: 'legend',
		class_name	: 'uca-maps-legend-control',
		on_click	: () => toggle_legend_panel(self)
	})

	// centered and wide (the WMS variant): three nesting levels do not fit
	// the 18rem anchored panel, and the overlay stays in view as a preview
	self.legend_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-legend-panel',
		centered	: true,
		title		: title
	})
	render_legend_panel(self, self.legend_panel)

	create_legend_overlay(self)
	render_legend_overlay(self)

}//end attach_legend



/**
* TOGGLE_LEGEND_PANEL
* Reads the panel's real state, never a flag: a sibling opening closes this one
* without passing here.
*
* @param {Object} self
* @returns {void}
*/
const toggle_legend_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.legend_panel)

	if (next_visible) {
		clear_legend_message(self.legend_panel)
		populate_legend_columns(self, self.legend_panel)
	}

	set_toolbar_panel_visible(self, self.legend_panel, self.legend_control, next_visible)

}//end toggle_legend_panel



/**
* SET_LEGEND_TITLE
* @param {Object} self
* @param {string} text
* @returns {void}
*/
export const set_legend_title = function(self, text) {

	self.legend.legend = strip_tags(String(text || ''))
	legend_changed(self)

}//end set_legend_title



/**
* SET_LEGEND_VISIBLE
* v6's "Show legend" checkbox. Only hides the overlay: the columns stay editable,
* as in v6.
*
* @param {Object} self
* @param {boolean} visible
* @returns {void}
*/
export const set_legend_visible = function(self, visible) {

	self.legend.enable = Boolean(visible)
	render_legend_overlay(self)

}//end set_legend_visible



/**
* ADD_LEGEND_COLUMN
* @param {Object} self
* @returns {{ok: boolean, index: number}}
*/
export const add_legend_column = function(self) {

	self.legend.columns.push({name: '', elements: []})
	legend_changed(self)

	return {ok: true, index: self.legend.columns.length - 1}
}//end add_legend_column



/**
* DELETE_LEGEND_COLUMN
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean}}
*/
export const delete_legend_column = function(self, index) {

	if (index<0 || index>=self.legend.columns.length) {
		return {ok: false}
	}

	self.legend.columns.splice(index, 1)
	legend_changed(self)

	return {ok: true}
}//end delete_legend_column



/**
* SET_LEGEND_COLUMN_NAME
* @param {Object} self
* @param {number} index
* @param {string} text
* @returns {{ok: boolean}}
*/
export const set_legend_column_name = function(self, index, text) {

	const column = self.legend.columns[index]
	if (!column) {
		return {ok: false}
	}

	column.name = strip_tags(String(text || ''))
	legend_changed(self)

	return {ok: true}
}//end set_legend_column_name



/**
* MOVE_LEGEND_COLUMN
* @param {Object} self
* @param {number} index
* @param {number} offset - -1 up, +1 down
* @returns {{ok: boolean, index?: number}}
*/
export const move_legend_column = function(self, index, offset) {

	const result = move_item(self.legend.columns, index, offset)
	if (result.ok) {
		legend_changed(self)
	}

	return result
}//end move_legend_column



/**
* ADD_LEGEND_ELEMENT
* @param {Object} self
* @param {number} column_index
* @returns {{ok: boolean, index?: number}}
*/
export const add_legend_element = function(self, column_index) {

	const column = self.legend.columns[column_index]
	if (!column) {
		return {ok: false}
	}

	column.elements.push({name: '', icon: default_element_icon()})
	legend_changed(self)

	return {ok: true, index: column.elements.length - 1}
}//end add_legend_element



/**
* DELETE_LEGEND_ELEMENT
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @returns {{ok: boolean}}
*/
export const delete_legend_element = function(self, column_index, element_index) {

	const column = self.legend.columns[column_index]
	if (!column || element_index<0 || element_index>=column.elements.length) {
		return {ok: false}
	}

	column.elements.splice(element_index, 1)
	legend_changed(self)

	return {ok: true}
}//end delete_legend_element



/**
* MOVE_LEGEND_ELEMENT
* Within its own group only.
*
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {number} offset - -1 up, +1 down
* @returns {{ok: boolean, index?: number}}
*/
export const move_legend_element = function(self, column_index, element_index, offset) {

	const column = self.legend.columns[column_index]
	if (!column) {
		return {ok: false}
	}

	const result = move_item(column.elements, element_index, offset)
	if (result.ok) {
		legend_changed(self)
	}

	return result
}//end move_legend_element



/**
* MOVE_ITEM
* @param {Array} list - mutated in place
* @param {number} index
* @param {number} offset
* @returns {{ok: boolean, index?: number}}
*/
const move_item = function(list, index, offset) {

	const target = index + offset
	if (offset!==-1 && offset!==1) {
		return {ok: false}
	}
	if (index<0 || index>=list.length || target<0 || target>=list.length) {
		return {ok: false}
	}

	const [item] = list.splice(index, 1)
	list.splice(target, 0, item)

	return {ok: true, index: target}
}//end move_item



/**
* SET_LEGEND_ELEMENT_NAME
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {string} text
* @returns {{ok: boolean}}
*/
export const set_legend_element_name = function(self, column_index, element_index, text) {

	const column	= self.legend.columns[column_index]
	const element	= column && column.elements[element_index]
	if (!element) {
		return {ok: false}
	}

	element.name = strip_tags(String(text || ''))
	legend_changed(self)

	return {ok: true}
}//end set_legend_element_name



/**
* SET_LEGEND_ELEMENT_SYMBOL
* A drawn symbol (`legend_symbol.js`). The element keeps v6's `icon` as the
* thing drawn — a PNG `data:` URL like an upload — and `symbol` only so the
* editor can reopen on its values this session (the record keeps the icon).
* An invalid symbol changes nothing.
*
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {{shape: string, fill: string, stroke: string}} symbol
* @returns {{ok: boolean}}
*/
export const set_legend_element_symbol = function(self, column_index, element_index, symbol) {

	const column	= self.legend.columns[column_index]
	const element	= column && column.elements[element_index]
	if (!element || !is_legend_symbol(symbol)) {
		return {ok: false}
	}

	element.symbol	= {
		shape	: symbol.shape,
		fill	: symbol.fill.toLowerCase(),
		stroke	: symbol.stroke.toLowerCase()
	}
	element.icon	= legend_symbol_data_url(element.symbol)
	legend_changed(self)

	return {ok: true}
}//end set_legend_element_symbol



/**
* SET_LEGEND_ELEMENT_ICON
* The picked image is redrawn, in the browser, as a PNG at most LEGEND_ICON_SIDE on a
* side (`raster_icon`): the record keeps it as a `data:` URI, and only a small raster
* one. Type and size are checked BEFORE reading, so a 30 MB file is never loaded only
* to be refused.
*
* @param {Object} self
* @param {number} column_index
* @param {number} element_index
* @param {File} file
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const set_legend_element_icon = async function(self, column_index, element_index, file) {

	// the only mutator with an await in it: the OS file chooser can outlive
	// the tool (teardown nulls self.legend), and the picker's handler is on a
	// detached input detach cannot reach — same guard shape as
	// render_file_upload.js's post-await panel check
	const column	= self.legend && self.legend.columns[column_index]
	const element	= column && column.elements[element_index]
	if (!element || !file) {
		return {ok: false}
	}

	if (!ALLOWED_ICON_TYPES.includes(file.type)) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_type') || 'Icon file type not allowed (PNG, JPEG, GIF, WebP or SVG only).'
		}
	}
	if (file.size > MAX_ICON_BYTES) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_size') || 'The icon must not exceed 2 MB.'
		}
	}

	const data_url = await raster_icon(file)
	if (!self.legend) {
		return {ok: false}
	}
	if (!data_url) {
		return {
			ok		: false,
			error	: self.get_tool_label('legend_error_icon_read') || 'The icon could not be read.'
		}
	}

	element.icon = data_url
	// an uploaded image replaces the drawn symbol: nothing left to reopen
	delete element.symbol
	legend_changed(self)

	return {ok: true}
}//end set_legend_element_icon



/**
* RASTER_ICON
* The image of `file` redrawn as a PNG that fits LEGEND_ICON_SIDE (never enlarged), or
* null when it cannot be decoded or drawn (a file that is not the image it claims, an
* SVG the browser will not rasterize). A non-Blob still throws.
*
* @param {File} file - type already checked against ALLOWED_ICON_TYPES
* @returns {Promise<string|null>}
*/
const raster_icon = async function(file) {

	const url = URL.createObjectURL(file)
	try {
		const image = new Image()
		image.src = url
		await image.decode()

		// an SVG without its own size decodes at 0x0: drawn at the icon's side
		const width		= image.naturalWidth || LEGEND_ICON_SIDE
		const height	= image.naturalHeight || LEGEND_ICON_SIDE
		const scale		= Math.min(1, LEGEND_ICON_SIDE / Math.max(width, height))
		const canvas	= Object.assign(document.createElement('canvas'), {
			width	: Math.max(1, Math.round(width * scale)),
			height	: Math.max(1, Math.round(height * scale))
		})
		canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)

		const data_url = canvas.toDataURL('image/png')
		return is_raster_icon(data_url) ? data_url : null
	} catch {
		return null
	} finally {
		URL.revokeObjectURL(url)
	}
}//end raster_icon



/**
* DETACH_LEGEND
* Button, panel and overlay off the map; state to null.
*
* @param {Object} self
* @returns {void}
*/
export const detach_legend = function(self) {

	remove_toolbar_button(self, self.legend_control)
	remove_toolbar_panel(self, self.legend_panel)
	remove_legend_overlay(self)

	self.legend			= null
	self.legend_control	= null
	self.legend_panel	= null

}//end detach_legend



// @license-end
