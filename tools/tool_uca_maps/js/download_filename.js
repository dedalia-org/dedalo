// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* DOWNLOAD_FILENAME
*
* The ONE rule that turns a user-typed download name into a safe one. Both
* sides import it — the browser sets the result on `link.download`
* (`map_image_download.js`, PNG branch) and the server puts it in the
* envelope's `filename` (`server/raster_download.ts`) — because a security
* rule with two copies is a rule with two behaviours. A leaf module with no
* imports and no DOM is what makes that possible: the same shape
* `tsconfig.json`'s `allowJs` already carries for client leaf modules a unit
* test imports directly.
*
* The sanitized string NEVER becomes a path. The server's scratch file keeps
* its own fixed name, so nothing here reaches `join()`; what it does reach is
* a download attribute in a browser, which is why separators, control
* characters and edge dots go, and why the extension is appended by
* `with_extension` and never read out of the user's text.
*
* @module download_filename
*/



/** Base name used when no name was supplied at all (NOT when an empty one
* was: see `download_map_image`, which refuses that the way v6 does). */
export const DEFAULT_MAP_IMAGE_NAME = 'uca_maps_map'

/** Longest base name kept. Well under every filesystem's own limit, so the
* extension a caller appends can never be what pushes it over. */
const MAX_LENGTH = 100

/** Path separators plus the set Windows refuses in a file name. A primitive
* string, not a Set: this module is imported by the SERVER, where a
* module-level mutable object is the thing `module_state_tripwire` exists to
* catch — and its census reads `**\/*.ts`, so a .js file would slip past it
* (review-diff, 2026-09-22). Nothing to mutate is better than a gate. */
const UNSAFE_CHARS = '\\/<>:"|?*'



/**
* IS_UNSAFE_CODE
* C0 controls and DEL, plus the Cf format characters that let a name DISPLAY
* one way and land on disk another — a right-to-left override turns
* "photo\u202Egnp.exe" into something that reads as a .png. Excluded by code
* point rather than by a regex class: a literal control character inside one
* is unreadable, and every linter flags it for that reason.
*
* @param {number} code
* @returns {boolean}
*/
const is_unsafe_code = function(code) {

	return code<0x20 || code===0x7f ||
		(code>=0x200b && code<=0x200f) ||
		(code>=0x202a && code<=0x202e) ||
		(code>=0x2066 && code<=0x2069) ||
		code===0xfeff
}//end is_unsafe_code



/**
* STRIP_UNSAFE
* Drops, never substitutes: a download name is the user's own text minus what
* cannot travel, not their text with surprise characters in it.
*
* @param {string} value
* @returns {string}
*/
const strip_unsafe = function(value) {

	let out = ''
	for (const character of value) {
		if (is_unsafe_code(character.codePointAt(0)) || UNSAFE_CHARS.includes(character)) {
			continue
		}
		out += character
	}

	return out
}//end strip_unsafe



/**
* SANITIZE_DOWNLOAD_NAME
* Returns a safe base name, or '' when nothing usable survives — which every
* caller must treat as a refusal, never as "use the default": a name that
* sanitizes to nothing means the user typed something we cannot honour, and
* silently downloading under another name is exactly the kind of quiet
* substitution this tool does not do.
*
* @param {string} raw
* @returns {string} safe base name, or '' if nothing usable survives
*/
export const sanitize_download_name = function(raw) {

	if (typeof raw!=='string') {
		return ''
	}

	// Truncated by CODE POINT (`Array.from`), never by `.slice` — the string
	// was filtered by code point, and cutting UTF-16 units instead can leave a
	// lone surrogate at the end (review-diff, 2026-09-22).
	const cleaned = Array.from(strip_unsafe(raw).replace(/\s+/g, ' '))
		.slice(0, MAX_LENGTH)
		.join('')

	// Edge dots last, and on the already-truncated string: a leading one
	// hides the file on unix, a trailing one is dropped by Windows, and the
	// slice above can have created either.
	return cleaned.replace(/^[\s.]+|[\s.]+$/g, '')
}//end sanitize_download_name



/**
* WITH_EXTENSION
* Appends the format's extension unless the base already carries it — a user
* who types "map.png" gets `map.png`, not `map.png.png` (v6 always appended).
*
* @param {string} base - an ALREADY sanitized base name
* @param {string} extension - without the dot ('png', 'tif', …)
* @returns {string}
*/
export const with_extension = function(base, extension) {

	const suffix = `.${extension}`

	return base.toLowerCase().endsWith(suffix.toLowerCase())
		? base
		: base + suffix
}//end with_extension



// @license-end
