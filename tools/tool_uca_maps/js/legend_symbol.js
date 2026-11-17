// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* LEGEND_SYMBOL
* A legend symbol DRAWN from a shape and two colours: "this colour = this period" is
* most of what a heritage legend says. Not in v6, which only uploads images. A leaf:
* `legend.js` and `render_legend.js` both draw with it, and the first imports the second.
* What is SAVED is always a PNG (`legend_symbol_data_url`, `pin_data_url`); the SVG
* nodes only draw the editor's buttons.
*
* @module legend_symbol
*/



import {svg_node} from './svg.js'
import {ICON_RASTER_FORMATS, LEGEND_LIMITS} from './core_limits.js'



/** The blue of the default pin (`pin_data_url`) and the
* first colour a symbol editor offers: Leaflet's own default path colour, so a
* new pin matches a new object on the map (v6's editor used that blue too,
* `special_tools.js`). Read when used: Leaflet is the map's global, loaded with it. */
export const default_symbol_colour = function() {
	return L.Path.prototype.options.color
}//end default_symbol_colour

/** The three geometry kinds a map object has (marker, line, polygon). */
export const LEGEND_SYMBOL_SHAPES = ['point', 'line', 'area']

/** What `<input type="color">` always yields. Checked before a value is set
* on a drawing — the symbol is data from the panel. */
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/i



/**
* DEFAULT_LEGEND_SYMBOL
* @returns {{shape: string, fill: string, stroke: string}}
*/
export const default_legend_symbol = function() {
	const colour = default_symbol_colour()
	return {shape: 'point', fill: colour, stroke: colour}
}//end default_legend_symbol



/**
* IS_LEGEND_SYMBOL
* @param {*} symbol
* @returns {boolean}
*/
export const is_legend_symbol = function(symbol) {
	return Boolean(symbol)
		&& LEGEND_SYMBOL_SHAPES.includes(symbol.shape)
		&& typeof symbol.fill==='string' && HEX_COLOUR_RE.test(symbol.fill)
		&& typeof symbol.stroke==='string' && HEX_COLOUR_RE.test(symbol.stroke)
}//end is_legend_symbol



/**
* LEGEND_SYMBOL_NODE
* A line has no fill: its one colour is the stroke.
*
* @param {{shape: string, fill: string, stroke: string}} symbol - valid (is_legend_symbol)
* @returns {SVGElement}
*/
export const legend_symbol_node = function(symbol) {

	const {fill, stroke} = symbol

	const shape_node = symbol.shape==='line'
		? svg_node('line', {x1: 3, y1: 12, x2: 21, y2: 12, stroke: stroke, 'stroke-width': 3, 'stroke-linecap': 'round'})
		: symbol.shape==='area'
			? svg_node('rect', {x: 3, y: 6, width: 18, height: 12, fill: fill, stroke: stroke, 'stroke-width': 2})
			: svg_node('circle', {cx: 12, cy: 12, r: 6, fill: fill, stroke: stroke, 'stroke-width': 2})

	return svg_node('svg', {viewBox: '0 0 24 24', width: 24, height: 24}, [shape_node])
}//end legend_symbol_node



/** What a saved icon may be: the core's raster `data:` URIs. Checked before a value
* read from the record reaches an `<img>`. */
const RASTER_ICON_RE = new RegExp('^data:image\\/(?:' + ICON_RASTER_FORMATS.join('|') + ');base64,[A-Za-z0-9+/]+={0,2}$')

/**
* IS_RASTER_ICON
* @param {*} icon
* @returns {boolean}
*/
export const is_raster_icon = function(icon) {
	return typeof icon==='string' && icon.length<=LEGEND_LIMITS.maxIconChars && RASTER_ICON_RE.test(icon)
}//end is_raster_icon

/** The side of a legend icon, in pixels: twice the 18px it is shown at, under the
* core's ceiling (256). Small on purpose: a legend's icons share 256 KiB in the record. */
export const LEGEND_ICON_SIDE = 36

/** The icon types v6 accepts (`special_tools_legend.js` change_icon). Every one is
* redrawn as a small PNG before it is kept (`legend.js` raster_icon): the record
* admits only png, jpeg or webp icons of at most 64 KiB, never SVG. */
export const ALLOWED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

/** The default pin (`legend.js` default_symbol_icon), in the 24px box of the symbols. */
const PIN_PATH = 'M12 2c-3.9 0-7 3.1-7 7 0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z'



/**
* ICON_CANVAS
* A LEGEND_ICON_SIDE square canvas whose context draws in the symbols' 24px box.
*
* @returns {{canvas: HTMLCanvasElement, context: CanvasRenderingContext2D}}
*/
const icon_canvas = function() {

	const canvas	= Object.assign(document.createElement('canvas'), {width: LEGEND_ICON_SIDE, height: LEGEND_ICON_SIDE})
	const context	= canvas.getContext('2d')
	context.scale(LEGEND_ICON_SIDE / 24, LEGEND_ICON_SIDE / 24)

	return {canvas, context}
}//end icon_canvas



/**
* LEGEND_SYMBOL_DATA_URL
* The symbol as a PNG `data:` URL, the form a saved legend icon must take (the core
* refuses SVG there). Drawn with the canvas API, synchronously, in the same geometry
* as `legend_symbol_node`, which still draws the editor's shape buttons.
*
* @param {{shape: string, fill: string, stroke: string}} symbol - valid (is_legend_symbol)
* @returns {string}
*/
export const legend_symbol_data_url = function(symbol) {

	const {canvas, context}	= icon_canvas()
	const {fill, stroke}	= symbol

	context.strokeStyle = stroke
	if (symbol.shape==='line') {
		context.lineWidth	= 3
		context.lineCap		= 'round'
		context.beginPath()
		context.moveTo(3, 12)
		context.lineTo(21, 12)
		context.stroke()
	} else if (symbol.shape==='area') {
		context.fillStyle	= fill
		context.lineWidth	= 2
		context.fillRect(3, 6, 18, 12)
		context.strokeRect(3, 6, 18, 12)
	} else {
		context.fillStyle	= fill
		context.lineWidth	= 2
		context.beginPath()
		context.arc(12, 12, 6, 0, 2 * Math.PI)
		context.fill()
		context.stroke()
	}

	return canvas.toDataURL('image/png')
}//end legend_symbol_data_url



/**
* PIN_DATA_URL
* The default pin as a PNG `data:` URL.
*
* @param {string} colour - any CSS colour
* @returns {string}
*/
export const pin_data_url = function(colour) {

	const {canvas, context} = icon_canvas()
	context.fillStyle = colour
	context.fill(new Path2D(PIN_PATH))

	return canvas.toDataURL('image/png')
}//end pin_data_url



// @license-end
