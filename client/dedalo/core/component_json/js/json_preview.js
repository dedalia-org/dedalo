// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0



/**
* JSON_PREVIEW
* First `max` chars of JSON.stringify(value), built without serializing the
* whole value (a list cell of a large JSON value only shows 100 chars).
* Same output as `JSON.stringify(value).substring(0, max)` for JSON data.
* @param {*} value - JSON-compatible value
* @param {number} max - Character budget
* @returns {string}
*/
export const json_preview = function(value, max) {

	let out = ''
	const walk = (v) => {
		if (out.length >= max) return
		if (v===null || typeof v!=='object') {
			// cut long strings before quoting them; the final substring trims the rest
			out += JSON.stringify(typeof v==='string' ? v.slice(0, max) : v) ?? 'null'
			return
		}
		const is_array = Array.isArray(v)
		out += is_array ? '[' : '{'
		let first = true
		for (const k of Object.keys(v)) {
			if (out.length >= max) return
			if (!first) out += ','
			first = false
			if (!is_array) out += JSON.stringify(k) + ':'
			walk(v[k])
		}
		out += is_array ? ']' : '}'
	}
	walk(value)

	return out.substring(0, max)
}//end json_preview




// @license-end
