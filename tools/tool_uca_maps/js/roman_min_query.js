// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * ROMAN_MIN_QUERY
 * The shortest query each Roman source accepts (v6's own `strlen` checks), read
 * by the browser's as-you-type search and by the server's refusal, so the two
 * cannot drift; hence a leaf with no imports and no state.
 *
 * @module roman_min_query
 */

/**
 * @param {'pleiades'|'pelagios'|'dare'} source
 * @param {string} [type] - Pleiades only: 'name' or 'id'
 * @returns {number}
 */
export const roman_min_query = function (source, type) {
	if (source === 'pleiades') {
		return type === 'id' ? 1 : 3;
	}
	return source === 'pelagios' ? 2 : 3;
}; //end roman_min_query
