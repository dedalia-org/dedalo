// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/

import { svg_node } from './svg.js'



/**
* SCALE_BAR
* Hito 15, functionality #2 ("Barra de escala"). A graphic scale bar plus a
* compass rose, bottom-right. Not a toolbar button and not a panel — the
* audit says so ("no es un icono clicable de la lista vertical de la
* izquierda"); it is permanent map furniture, like the attribution line.
*
* WHAT v6 ACTUALLY HAS (and my first pass got wrong): a `leaflet-graphicscale`
* control with `fill:'hollow', doubleLine:true` — a two-row checker bar, NOT
* Leaflet core's single line — AND a compass rose. The compass is not in the
* tool's own code at all: v6's vendored copy of the library is PATCHED BY HAND
* (`external-lib/leaflet-graphicscale/src/Leaflet.GraphicScale.js` `onAdd`
* builds a `leaflet-control-compass` div; its CSS points that div at
* `compass_.png`). Sergio caught the omission on the hito-15 validation.
*
* WHY THIS IS OWN CODE AND NOT THE VENDORED PLUGIN. Porting v6 here would
* mean vendoring an unmaintained 2015 plugin AND somebody's undocumented local
* patch to it, into installs that live for decades. What the plugin actually
* does — round the width to a nice number, draw divisions, draw a compass — is
* the ~150 lines below, with no dependency, no binary asset (the rose is
* inline SVG: crisp at any DPI, and it inherits its colour), and no silent
* `try/catch` (audit bug #3) because there is no library that can fail to load.
*
* The rounding is Leaflet's own `_getRoundNum` criterion (1/2/3/5/10 × 10^n),
* which is also what the plugin's `_possibleUnitsNum`/`_possibleDivisions`
* tables approximate — same answers, a tenth of the machinery.
*
* @module scale_bar
*/



/** Widest the bar may draw, in px — the round distance is fitted under this. */
const MAX_WIDTH = 150



/**
* ATTACH_SCALE_BAR
* Idempotent. Metric only — v6's `graphicScale` has no imperial half either,
* and a heritage record measured in miles is not a case this serves.
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
* still fits. Exported for direct unit coverage — the whole bar is wrong if
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
export const format_distance = function(meters) {
	if (meters>=1000) {
		const km = meters / 1000
		return (Number.isInteger(km) ? km : km.toFixed(1)) + ' km'
	}
	return Math.round(meters) + ' m'
}//end format_distance



/**
* RENDER_SCALE
* Rebuilds the bar for the map's current scale: a round distance, split into
* divisions drawn as TWO offset rows (v6's `doubleLine`) with alternating
* fill (v6's `fill:'hollow'`), labelled 0 / half / full.
*
* A distance whose leading digit is 3 is split in 3, everything else in 4 —
* four divisions of 0.75 would put labels on numbers no one reads off a map.
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
* COMPASS_SVG
* The rose v6 ships as a 128px PNG, as inline SVG instead: four long cardinal
* kites, four short diagonal ones, a centre ring and the N/E/S/W letters. No
* binary asset to keep in step with the CSS, sharp on a retina screen, and it
* takes its colour from the control (so the exported map image gets it too).
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
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* tool_uca_maps.prototype.destroy(). The 'move' listener comes off in the
* control's own `onRemove`.
*
* NOT registered in `self._toolbar_nodes`: that registry is the map-image
* screenshot's exclusion list (`map_image_download.js`), and a scale bar and a
* north arrow are the two pieces of map chrome that most BELONG in an exported
* map image. Same reasoning that already leaves Leaflet's attribution and
* Geoman's own toolbar in the capture — the filter excludes what this TOOL
* adds as its own UI, not what the map legitimately shows.
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
