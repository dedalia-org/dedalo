// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/

import { svg_node } from './svg.js'



/**
* SCALE_BAR
* Permanent map furniture, bottom-right: v6's two-row checker scale and the compass
* rose its hand-patched `leaflet-graphicscale` adds. Own code, not that unmaintained
* 2015 plugin plus an undocumented patch: no dependency, no binary asset, nothing to
* fail to load. The rounding is Leaflet's own `_getRoundNum` criterion.
*
* @module scale_bar
*/



/** Widest the bar may draw, in px — the round distance is fitted under this. */
const MAX_WIDTH = 150



/**
* ATTACH_SCALE_BAR
* Idempotent. Metric only, as v6's `graphicScale`.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_scale_bar = function(self) {

	if (self.scale_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	const ScaleControl = L.Control.extend({
		options : { position: 'bottomright' },
		onAdd : function(map) {

			const container = L.DomUtil.create('div', 'uca-maps-scale')
			container.appendChild(compass_node())

			const scale = L.DomUtil.create('div', 'uca-maps-scale-graphic', container)
			L.DomUtil.create('div', 'uca-maps-scale-rows', scale)
			L.DomUtil.create('div', 'uca-maps-scale-labels', scale)

			this._scale_node = scale
			// 'move', not 'moveend': the bar must track a pan/zoom as it
			// happens, exactly as Leaflet's own scale control does — a bar
			// that only catches up when the gesture ends reads as frozen
			map.on('move', this._redraw, this)
			map.whenReady(this._redraw, this)

			return container
		},
		onRemove : function(map) {
			map.off('move', this._redraw, this)
			// whenReady on a map not loaded yet queues a 'load' listener: left
			// behind, it would redraw a removed control (null _map) on load
			map.off('load', this._redraw, this)
		},
		_redraw : function() {
			render_scale(this._map, this._scale_node)
		}
	})

	self.scale_control = new ScaleControl()
	self.scale_control.addTo(self.geolocation.map)

}//end attach_scale_bar



/**
* ROUND_DISTANCE
* Leaflet's own `_getRoundNum` criterion: the largest 1/2/3/5/10 × 10^n that
* still fits. Exported for the client gate: the whole bar is wrong if this is.
* this is, and it is pure arithmetic.
*
* @param {number} max_meters - what MAX_WIDTH px is worth on the ground
* @returns {number} the round distance the bar will represent, in metres
*/
export const round_distance = function(max_meters) {

	const pow		= 10 ** Math.floor(Math.log(max_meters) / Math.LN10)
	const leading	= max_meters / pow

	const rounded = leading>=10 ? 10
		: leading>=5 ? 5
		: leading>=3 ? 3
		: leading>=2 ? 2
		: 1

	return pow * rounded
}//end round_distance



/**
* FORMAT_DISTANCE
* Metres under 1 km, kilometres above — and never a trailing '.0' (a scale
* reading "2.0 km" is noise, not precision).
*
* @param {number} meters
* @returns {string}
*/
// exported for the client gate
export const format_distance = function(meters) {
	if (meters>=1000) {
		const km = meters / 1000
		return (Number.isInteger(km) ? km : km.toFixed(1)) + ' km'
	}
	return Math.round(meters) + ' m'
}//end format_distance



/**
* RENDER_SCALE
* Two offset rows of alternating divisions (v6's `doubleLine`, `fill:'hollow'`),
* labelled 0 / half / full. A leading 3 splits in 3, the rest in 4: four divisions
* of 0.75 would label numbers no one reads off a map.
*
* @param {Object} map - the live Leaflet map
* @param {HTMLElement} scale_node - .uca-maps-scale-graphic
* @returns {void}
*/
const render_scale = function(map, scale_node) {

	const center	= map.getSize().divideBy(2)
	const y			= center.y
	// what MAX_WIDTH px is worth on the ground AT THE MAP'S CENTRE — measured,
	// not derived from the zoom level, so Mercator's latitude distortion is
	// already in the answer
	const left		= map.containerPointToLatLng([0, y])
	const right		= map.containerPointToLatLng([MAX_WIDTH, y])
	const max_meters	= map.distance(left, right)

	if (!Number.isFinite(max_meters) || max_meters<=0) {
		return
	}

	const meters		= round_distance(max_meters)
	const width			= Math.round(MAX_WIDTH * (meters / max_meters))
	const divisions		= (meters / 10 ** Math.floor(Math.log(meters) / Math.LN10))===3 ? 3 : 4

	const rows = scale_node.querySelector('.uca-maps-scale-rows')
	rows.replaceChildren()
	rows.style.width = width + 'px'

	// two rows, the second offset by one division — the checker pattern that
	// makes a graphic scale readable at a glance (v6 `doubleLine`)
	for (const row_index of [0, 1]) {
		const row = document.createElement('div')
		row.className = 'uca-maps-scale-row'
		for (let i=0; i<divisions; i++) {
			const division = document.createElement('div')
			const filled = ((i + row_index) % 2)===0
			division.className = 'uca-maps-scale-division' + (filled ? ' filled' : '')
			row.appendChild(division)
		}
		rows.appendChild(row)
	}

	const labels = scale_node.querySelector('.uca-maps-scale-labels')
	labels.replaceChildren()
	labels.style.width = width + 'px'
	// 0 / half / full, and only when the halfway point falls on a division
	// boundary (it does not with 3 divisions)
	const stops = divisions%2===0 ? [0, meters/2, meters] : [0, meters]
	for (const stop of stops) {
		const label = document.createElement('span')
		label.className		= 'uca-maps-scale-label'
		label.textContent	= stop===0 ? '0' : format_distance(stop)
		labels.appendChild(label)
	}

}//end render_scale



/**
* COMPASS_NODE
* v6's 128px PNG rose as inline SVG: sharp at any DPI, no asset to keep in step with
* the CSS, and it takes the control's colour, also in the exported map image.
*
* @returns {SVGElement}
*/
const compass_node = function() {

	const strokes = svg_node('g', {
		fill				: 'none',
		stroke				: 'currentColor',
		'stroke-width'		: 2,
		'stroke-linejoin'	: 'round'
	}, [
		// diagonal kites (shorter), built first so the cardinal ones read on top
		svg_node('polygon', {points: '71,29 53.5,53.5 29,71 46.5,46.5'}),
		svg_node('polygon', {points: '29,29 46.5,53.5 71,71 53.5,46.5'}),
		// cardinal kites
		svg_node('polygon', {points: '50,14 56,50 50,86 44,50'}),
		svg_node('polygon', {points: '86,50 50,56 14,50 50,44'}),
		svg_node('circle', {cx: 50, cy: 50, r: 5})
	])

	const letters = svg_node('g', {
		fill			: 'currentColor',
		'font-size'		: 15,
		'font-family'	: 'sans-serif',
		'text-anchor'	: 'middle'
	}, [
		svg_node('text', {x: 50, y: 11}, ['N']),
		svg_node('text', {x: 50, y: 98}, ['S']),
		svg_node('text', {x: 95, y: 55}, ['E']),
		svg_node('text', {x: 5, y: 55}, ['W'])
	])

	return svg_node('svg', {
		class			: 'uca-maps-scale-compass',
		viewBox			: '0 0 100 100',
		width			: 46,
		height			: 46,
		'aria-hidden'	: 'true',
		focusable		: 'false'
	}, [strokes, letters])
}//end compass_node



/**
* DETACH_SCALE_BAR
* The 'move' and 'load' listeners come off in the control's `onRemove`. Not a toolbar
* node: a scale bar belongs in the exported map image (`keep_in_map_image`).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_scale_bar = function(self) {

	if (self.scale_control) {
		try {
			self.scale_control.remove()
		} catch (error) {
			console.warn('tool_uca_maps detach_scale_bar: error removing the scale control', error)
		}
	}
	self.scale_control = null

}//end detach_scale_bar



// @license-end
