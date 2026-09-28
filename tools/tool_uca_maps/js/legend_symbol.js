// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* LEGEND_SYMBOL
* A legend symbol DRAWN from a shape and two colours, instead of an uploaded
* file — "this colour = this period" is most of what a heritage map legend
* says, and one pin for every element says nothing. Not in v6, which only
* uploads images.
*
* Leaf module, no logic imports: `legend.js` (the mutator) and
* `render_legend.js` (the shape previews) both draw with it, and
* `legend.js` already imports the render file.
*
* @module legend_symbol
*/



import {svg_node} from './svg.js'



/** The blue of the default pin (`legend.js` DEFAULT_ELEMENT_ICON) and the
* first colour a symbol editor offers. Named once: a colour spelled in a
* shipped string is counted wherever it is spelled
* (colour_literal_ratchet_tripwire). */
export const DEFAULT_SYMBOL_COLOUR = '#1a73e8'

/** The three geometry kinds a map object has (marker, line, polygon). */
export const LEGEND_SYMBOL_SHAPES = ['point', 'line', 'area']

/** What `<input type="color">` always yields. Checked before a value is set
* on an SVG attribute — the symbol is data from the panel, and the day
* legends persist it will arrive off the wire. */
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/i



/**
* DEFAULT_LEGEND_SYMBOL
* @returns {{shape: string, fill: string, stroke: string}}
*/
export const default_legend_symbol = function() {
	return {shape: 'point', fill: DEFAULT_SYMBOL_COLOUR, stroke: DEFAULT_SYMBOL_COLOUR}
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



/**
* LEGEND_SYMBOL_DATA_URL
* The same `data:` form as an uploaded icon, so the overlay, the image export
* and the stored `icon` field treat a drawn symbol exactly like a file.
*
* @param {{shape: string, fill: string, stroke: string}} symbol - valid (is_legend_symbol)
* @returns {string}
*/
export const legend_symbol_data_url = function(symbol) {

	const markup = new XMLSerializer().serializeToString(legend_symbol_node(symbol))

	return 'data:image/svg+xml;base64,' + btoa(markup)
}//end legend_symbol_data_url



// @license-end
