// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* UCA_MAPS_DATA
* Read-only access to the tool's per-object namespace,
* `layer.feature.properties.uca_maps`. A leaf module — no imports — so the
* render_*.js modules, which may not import their logic modules, read it
* through the same copy as everyone else.
*
* @module uca_maps_data
*/



/**
* READ_UCA_MAPS
* Never seeds `.feature`: a layer without the namespace answers null.
*
* @param {Object} layer
* @returns {Object|null} layer.feature.properties.uca_maps
*/
export const read_uca_maps = function(layer) {
	return layer?.feature?.properties?.uca_maps || null
}//end read_uca_maps



/**
* CARRIER_IMAGE
* The image descriptor an image carrier rectangle holds (`image_upload.js`).
*
* @param {Object} layer
* @returns {Object|null} the descriptor, or null when the layer carries none
*/
export const carrier_image = function(layer) {
	return read_uca_maps(layer)?.image || null
}//end carrier_image



// @license-end
