// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, Promise */
/*eslint no-undef: "error"*/



/**
* TR
* Client-side counterpart of the PHP `TR` class: manages inline markup tags
* embedded in Dédalo transcription text fields.
*
* Transcription text stored in component_text_area uses a custom tag syntax
* (not standard HTML) for structured annotations such as timecodes, index
* markers, geographic anchors, and speaker identifications. These tags survive
* round-trips through the database and the CKEditor rich-text editor without
* being parsed as HTML.
*
* This module provides two responsibilities:
*   1. `get_mark_pattern` — canonical regex factory for every supported tag
*      type; used both here and by external callers that need to detect or
*      strip tags from raw text.
*   2. `add_tag_img_on_the_fly` — converts embedded tags to `<img>` (or
*      `<reference>`) elements for in-browser rendering, applying XSS escaping
*      on all capture-group values before attribute interpolation (SEC-028).
*
* Tag wire format overview (most types):
*   `[TYPE-STATE-ID-LABEL-data:DATA:data]`
*   e.g. `[index-n-42-MyLabel-data:{"k":"v"}:data]`
*   Timecode format differs: `[TC_HH:MM:SS.mmm_TC]`
*
* Server-side equivalent: shared/class.TR.php
*/
export const tr = {



	/**
	* TAG_BADGE_VERSION
	* Fingerprint of the SERVER-SIDE badge drawing
	* (src/core/components/component_text_area/tag_render.ts), appended to every
	* deterministic badge `<img>` src as `&v=`.
	*
	* Why it exists: the badge URL is otherwise version-free (`?id=[index-n-1-x]`),
	* while the bytes it returns are a function of the renderer — and the renderer
	* DOES change (WC-2026-08-11-vector-tag-badges redrew every badge). Without a
	* token in the URL, a browser that already cached a badge keeps the old drawing
	* for as long as its cached response is fresh, so a rendering fix never reaches
	* the very users who reported it. The token changes the CACHE KEY only: the
	* endpoint answers on `?id=` alone and ignores this param (it only uses its
	* PRESENCE to decide it may answer `immutable`).
	*
	* BUMPING IT IS NOT OPTIONAL AND NOT MANUAL GUESSWORK: the value is the
	* fingerprint of the rendered badge set, computed and pinned by
	* test/unit/text_area_tag_grammar.test.ts ("badge renderer fingerprint"). Change
	* any pill, icon or label geometry and that gate goes red with the new value to
	* paste here.
	*
	* @type {string}
	*/
	tag_badge_version : 'b948b27e',



	/**
	* GET_MARK_PATTERN
	* Returns the canonical compiled RegExp for a named Dédalo transcription
	* tag type. Centralising patterns here ensures that detection, stripping,
	* and replacement all use identical rules — the same expressions are also
	* used by the PHP TR class on the server side.
	*
	* All returned patterns use the `g` (global) flag so they can be passed
	* directly to `String.prototype.replace`.
	*
	* Supported mark keys and the tag shapes they match:
	*
	*   'tc'              — timecode value: `[TC_HH:MM:SS[.mmm]_TC]`
	*                       capture 1 = full tag, capture 2 = time string
	*   'tc_full'         — full timecode tag (strict, requires milliseconds)
	*   'tc_value'        — bare time digits inside a TC value string
	*   'index'           — both open and close index markers
	*   'indexIn'         — opening index marker only
	*   'indexOut'        — closing index marker only
	*   'reference'       — both open and close reference markers
	*   'referenceIn'     — opening reference marker only
	*   'referenceOut'    — closing reference marker only
	*   'svg'             — SVG annotation tag (since v4.9.0 / 2018-05-18)
	*   'draw'            — legacy Draw tag (pre-v4.9.0 name for SVG; still parsed)
	*   'geo'             — geographic anchor tag
	*   'geo_full'        — complete geographic anchor tag (looser variant)
	*   'page'            — PDF page reference tag
	*   'person'          — transcription speaker tag (note: group 5 = label,
	*                       not group 6, because the optional outer group is absent)
	*   'note'            — transcription annotation tag
	*   'lang'            — transcription language-change tag
	*   'p'               — bare `<p>` / `</p>` HTML elements
	*   'strong'          — `<strong>` / `</strong>`
	*   'em'              — `<em>` / `</em>`
	*   'i'               — `<i>` / `</i>`
	*   'u'               — `<u>` / `</u>`
	*   'html_style'      — any of strong/em/i/u (open or close)
	*   'apertium-notrans'— Apertium machine-translation suppression element
	*
	* Common capture-group layout for structured tags (index, svg, geo, …):
	*   g1 = full match wrapper, g2 = type, g3 = state letter (a-z),
	*   g4 = numeric tag_id, g5 = outer optional group,
	*   g6 = label (≤22 chars, no hyphens), g7 = embedded data payload
	*
	* (!) Returns an empty string `''` and logs a console error for unknown keys,
	* so callers must not assume a RegExp is always returned.
	*
	* @param {string} mark - named tag type (see list above)
	* @returns {RegExp|string} compiled global RegExp, or `''` for unknown marks
	*/
	get_mark_pattern : (mark) => {

		let reg_ex = ''

		switch(mark) {

			// TC . Select timecode from tag like '00:01:25.627'
			case 'tc' :
				reg_ex = /(\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]{1,3})?)_TC\])/g;
				break;

			// TC_FULL . Select complete tag like '[TC_00:01:25.627_TC]'
			case 'tc_full' :
				reg_ex = /(\[TC_[0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}\.[0-9]{1,3}_TC\])/g;
				break;

			// TC_VALUE . Select elements from value tc like '00:01:25.627'. Used by OptimizeTC
			case 'tc_value' :
				reg_ex = /([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(\.([0-9]{1,3}))?/g;
				break;

			// INDEX
			case 'index' :
				reg_ex = /\[\/{0,1}(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]/g;
				break;

			case 'indexIn' :
				reg_ex = /(\[(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;
				break;

			case 'indexOut':
				reg_ex = /(\[\/(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;
				break;

			// REFERENCE
			case 'reference' :
				reg_ex = /\[\/{0,1}(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\]/g;
				break;

			case 'referenceIn' :
				reg_ex = /(\[(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;
				break;

			case 'referenceOut' :
				reg_ex = /(\[\/(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;
				break;

			// SVG (From now 18-05-2018 v4.9.0, will be used to manage tags from the component component_svg)
			case 'svg' :
				reg_ex = /(\[(svg)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;
				break;

			// DRAW (Old svg renamed 18-05-2018. Pre 4.9.0 . Until 01-02-2024 manage images over draws js paper data. now only layer id is referred)
			case 'draw' :
				reg_ex = /(\[(draw)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;
				break;

			// GEO
			case 'geo' :
				reg_ex = /(\[(geo)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;
				break;

			// GEO_FULL . Select complete tag
			case 'geo_full' :
				reg_ex = /(\[geo-[a-z]-[0-9]{1,6}(-[^-]{0,22})?-data:(.*?):data\])/g;
				break;

			// PAGE (pdf) [page-n-1--1-data:[1]:data]
			case 'page' :
				reg_ex = /(\[(page)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g;
				break;

			// PERSON (transcription spoken person) like [person-a-number-data:{"section_tipo":"dd15","section_id":"5"}:data]
			case 'person' :
				reg_ex = /(\[(person)-([a-z])-([0-9]{0,6})-([^-]{0,22})-data:(.*?):data\])/g;
				break;

			// NOTE (transcription annotations) like [note-n-number-data:{"section_tipo":"dd15","section_id":"5"}:data]
			case 'note' :
				reg_ex = /(\[(note)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;
				break;

			// LANG (transcription languages) like [lang-n-number-data:"lg-spa":data]
			case 'lang' :
				reg_ex = /(\[(lang)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;
				break;

			// OTHERS
			case 'p' :
				reg_ex = /(\<\/?p\>)/g;
				break;

			case 'strong' :
				reg_ex = /(\<\/?strong\>)/g;
				break;

			case 'em' :
				reg_ex = /(\<\/?em\>)/g;
				break;

			case 'i' :
				reg_ex = /(\<\/?i\>)/g;
				break;
			
			case 'u' :
				reg_ex = /(\<\/?u\>)/g;
				break;

			case 'html_style' :
				reg_ex = /(\<\/?(strong|em|i|u)\>)/g;
				break;

			case 'apertium-notrans' :
				reg_ex = /(\<apertium-notrans\>|\<\/apertium-notrans\>)/g;
				break;

			default :
				console.error(" Exception; Error Processing Request. Error: mark: 'mark' is not valid !");
		}


		return reg_ex
	},//end get_mark_pattern



	/**
	* ADD_TAG_IMG_ON_THE_FLY
	* Converts all Dédalo inline markup tags in a transcription string into
	* renderable HTML elements (`<img>` or `<reference>`) for in-browser display.
	*
	* Each tag type is replaced by a self-closing `<img>` whose `src` points to
	* the tag-thumbnail endpoint (`core/component_text_area/tag/?id=<TAG_ID>`),
	* carrying structured metadata as `data-*` attributes. The resulting elements
	* are later wired up by the component's JS to show tooltips, seek video, etc.
	*
	* Example transformation:
	*   `[TC_00:00:25.684_TC]`
	*   → `<img id="[TC_00:00:25.684_TC]" src="../../core/component_text_area/tag/?id=[TC_00:00:25.684_TC]"
	*         width="82" height="15" loading="lazy" class="tc" data-type="tc" ...>`
	*
	* Processing order matters: tags are replaced sequentially (indexIn before
	* indexOut, etc.) so that overlapping patterns do not interfere.
	*
	* Server-side equivalent: TR::add_tag_img_on_the_fly() in shared/class.TR.php.
	*
	* SEC-028: capture groups (label `[^-]{0,22}`, data `(.*?)`) can carry `"`,
	* `<`, `>`, `&` and other attribute-breaking characters originating from
	* CKEditor content or direct API writes. Interpolating them raw into template
	* strings allows stored XSS via attribute injection, e.g.:
	*   `[index-n-1-x" onerror="alert(1)" x-data:foo:data]`
	* All capture groups are HTML-attribute-escaped through the internal `esc`
	* helper before interpolation. Do not bypass `esc` when adding new tag types.
	*
	* @param {string} text - raw transcription text containing Dédalo markup tags
	* @returns {string} text with all recognised tags replaced by HTML elements;
	*   unrecognised or malformed tags are left unchanged. Returns the original
	*   value unchanged (including null/undefined) when the input is falsy or empty.
	*/
	add_tag_img_on_the_fly : (text) => {

		if (!text || text.length < 1) {
			return text
		}

		// Relative path from the browser document to the tag-thumbnail endpoint.
		// The endpoint returns a small preview image for a given tag ID string.
		const tag_url = '../../core/component_text_area/tag/?id=';

		/**
		* BADGE_SRC
		* src for a DETERMINISTIC badge (tc/index/geo/page/person/note/lang/draw):
		* the id plus the renderer fingerprint, so a redrawn badge is a new cache
		* entry instead of a year-old one (see tr.tag_badge_version).
		* The locator/`svg` tag does NOT use it: that src is a media redirect whose
		* bytes do not come from the badge renderer.
		* @param {string} id - already-escaped bracket tag id
		* @returns {string} versioned badge URL
		*/
		const badge_src = (id) => `${tag_url}${id}&v=${tr.tag_badge_version}`

		// SEC-028: escape attribute-context interpolation.
		// (!) All capture-group values MUST pass through esc() before being
		// placed inside an HTML attribute. Skipping this step re-opens the
		// stored-XSS vector described in the function doc-block.
		/**
		* ESC
		* Escapes a value for safe use inside an HTML attribute (double-quoted).
		* Converts null/undefined to an empty string, then replaces the five
		* HTML special characters: & " ' < >
		* @param {*} s - value to escape
		* @returns {string} HTML-attribute-safe representation
		*/
		const esc = (s) => {
			if (s === undefined || s === null) return ''
			return String(s)
				.replace(/&/g, '&amp;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
		}

		// a11y (WCAG 1.1.1): every badge <img> carries alt = its tag token (the
		// already-escaped id) — the text the badge draws, read out instead of a URL.

		// INDEX IN. captures: 2=type, 3=state, 4=tag_id, 6=label, 7=data
			const pattern_indexIn = tr.get_mark_pattern('indexIn');
			text = text.replace(pattern_indexIn, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="34" height="15" loading="lazy" class="index" data-type="indexIn" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// INDEX OUT
			const pattern_indexOut = tr.get_mark_pattern('indexOut');
			text = text.replace(pattern_indexOut, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[/${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="34" height="15" loading="lazy" class="index" data-type="indexOut" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// REFERENCE IN
			const pattern_referenceIn = tr.get_mark_pattern('referenceIn');
			text = text.replace(pattern_referenceIn, (_m, _g1, _g2, g3, g4, _g5, g6, g7) => {
				return `<reference id="reference_${esc(g4)}" class="reference" data-type="reference" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// REFERENCE OUT
			const pattern_referenceOut = tr.get_mark_pattern('referenceOut');
			text = text.replace(pattern_referenceOut, "</reference>");

		// TC. [TC_00:00:25.091_TC] — captures: 1=full_tag, 2=tc_value (digits/colons only)
			const pattern_tc = tr.get_mark_pattern('tc');
			text = text.replace(pattern_tc, (_m, g1, g2) => {
				return `<img id="${esc(g1)}" alt="${esc(g1)}" src="${badge_src(esc(g1))}" width="82" height="15" loading="lazy" class="tc" data-type="tc" data-tag_id="${esc(g1)}" data-state="n" data-label="${esc(g2)}" data-data="${esc(g2)}">`
			});

		// SVG. captures: 2=type, 3=state, 4=tag_id, 6=label, 7=data
			const pattern_svg = tr.get_mark_pattern('svg');
			text = text.replace(pattern_svg, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${tag_url}${esc(g7)}" height="15" loading="lazy" class="svg" data-type="svg" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// DRAW
			const pattern_draw = tr.get_mark_pattern('draw');
			text = text.replace(pattern_draw, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" height="15" loading="lazy" class="draw" data-type="draw" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// GEO
			const pattern_geo = tr.get_mark_pattern('geo');
			text = text.replace(pattern_geo, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="38" height="15" loading="lazy" class="geo" data-type="geo" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// PAGE. captures: 2=type, 3=state, 4=tag_id, 5=outer optional, 6=label, 7=data
			const pattern_page = tr.get_mark_pattern('page');
			text = text.replace(pattern_page, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="38" height="15" loading="lazy" class="page" data-type="page" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// PERSON. pattern: /(\[(person)-([a-z])-([0-9]{0,6})-([^-]{0,22})-data:(.*?):data\])/
		// captures: 1=full, 2=type, 3=state, 4=tag_id, 5=label, 6=data
			const pattern_person = tr.get_mark_pattern('person');
			text = text.replace(pattern_person, (_m, _g1, g2, g3, g4, g5, g6) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g5)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="72" height="15" loading="lazy" class="person" data-type="person" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g5)}" data-data="${esc(g6)}">`
			});

		// NOTE
			const pattern_note = tr.get_mark_pattern('note');
			text = text.replace(pattern_note, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="22" height="15" loading="lazy" class="note" data-type="note" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		// LANG
			const pattern_lang = tr.get_mark_pattern('lang');
			text = text.replace(pattern_lang, (_m, _g1, g2, g3, g4, _g5, g6, g7) => {
				const id = `[${esc(g2)}-${esc(g3)}-${esc(g4)}-${esc(g6)}]`
				return `<img id="${id}" alt="${id}" src="${badge_src(id)}" width="50" height="15" loading="lazy" class="lang" data-type="lang" data-tag_id="${esc(g4)}" data-state="${esc(g3)}" data-label="${esc(g6)}" data-data="${esc(g7)}">`
			});

		return text
	}//end add_tag_img_on_the_fly



}//end tr



// @license-end
