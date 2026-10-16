// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* ONEXONE_FLAGS
* What marks each half of a 1x1 pair. A leaf module because both `object_console.js`
* and `render_object_console.js` ask, and render may not import logic: one rule, one
* copy. v6 stores `is_oneXone`/`oneXone_type`; this port reads the uid link it keeps.
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
