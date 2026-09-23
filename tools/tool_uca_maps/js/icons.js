// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* ICONS
* The eye v6 draws as `img/view.png` / `img/hide.png`, as inline SVG built
* through `svg.js` — one definition for every panel that shows it (object
* list "centre", WMS show/hide), and `currentColor` leaves the colour to CSS.
*
* @module icons
*/



import {svg_node} from './svg.js'



const EYE_ATTRIBUTES = {
	viewBox				: '0 0 24 24',
	width				: 16,
	height				: 16,
	fill				: 'none',
	stroke				: 'currentColor',
	'stroke-width'		: 2,
	'stroke-linecap'	: 'round',
	'stroke-linejoin'	: 'round',
	'aria-hidden'		: 'true',
	focusable			: 'false'
}

const EYE_PATH = 'M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z'



/**
* EYE_NODE
* A fresh subtree per call: a single shared node would move to whichever row
* was rendered last, because appending a node RE-PARENTS it.
*
* @returns {SVGElement}
*/
export const eye_node = function() {
	return svg_node('svg', EYE_ATTRIBUTES, [
		svg_node('path', {d: EYE_PATH}),
		svg_node('circle', {cx: 12, cy: 12, r: 3})
	])
}//end eye_node



/**
* EYE_OFF_NODE
* The same eye struck through — v6's `hide.png`.
*
* @returns {SVGElement}
*/
export const eye_off_node = function() {
	return svg_node('svg', EYE_ATTRIBUTES, [
		svg_node('path', {d: EYE_PATH}),
		svg_node('circle', {cx: 12, cy: 12, r: 3}),
		svg_node('path', {d: 'M3 3l18 18'})
	])
}//end eye_off_node



// @license-end
