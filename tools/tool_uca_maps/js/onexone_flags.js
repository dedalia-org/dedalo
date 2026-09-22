// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* ONEXONE_FLAGS
* What marks each half of a 1x1 pair (functionality #7, `onexone.js`). A leaf
* module — no imports — because `object_console.js` and
* `render_object_console.js` both ask, and the render/logic split forbids the
* second importing the first: one rule with two copies is two behaviours
* (same reason as `download_filename.js`). v6 stores an explicit
* `is_oneXone`/`oneXone_type` pair; this port reads the uid link it already
* keeps (`docs/hitos/hito_7.md`).
*
* @module onexone_flags
*/



/**
* IS_ONEXONE_MARKER
* The marker a 1x1 rectangle was built around — v6's `oneXone_type: 'Marker'`.
*
* @param {Object} layer
* @returns {boolean}
*/
export const is_onexone_marker = function(layer) {
	const properties = layer && layer.feature && layer.feature.properties
	return Boolean(properties && properties.uca_maps && properties.uca_maps.onexone_uid)
}//end is_onexone_marker



/**
* IS_ONEXONE_RECTANGLE
* The 1 m² rectangle itself — v6's `oneXone_type: 'Rectangle'`.
*
* @param {Object} layer
* @returns {boolean}
*/
export const is_onexone_rectangle = function(layer) {
	const properties = layer && layer.feature && layer.feature.properties
	return Boolean(properties && properties.uca_maps && properties.uca_maps.onexone_of)
}//end is_onexone_rectangle



// @license-end
