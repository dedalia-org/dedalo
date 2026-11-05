// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

import { safe_url } from './util.js';

/**
 * RENDER_ESCAPE — the ONE escaper at the render boundary
 *
 * Every component value that reaches innerHTML / insertAdjacentHTML / a
 * template literal that is parsed as HTML goes through THIS module and
 * nowhere else (audit P2-6 / CARRY-01, XSS-03; gate: render_escape_tripwire).
 * A renderer never escapes locally and never decides by itself whether a value
 * is markup: the SERVER decides, once, per model, in the component descriptor's
 * `render` facet (src/core/components/<model>/descriptor.ts), and stamps the
 * decision on the wire as `render_class` — on every structure-context component
 * entry (`self.context.render_class`) and on every dd_grid cell
 * (`data_item.render_class`). The client just switches on it:
 *
 *   'text'    plain text  → HTML-escaped (the DEFAULT — an unknown, absent or
 *                           misspelt class escapes; nothing passes through by
 *                           accident)
 *   'html'    trusted markup → passed through. The ONLY class the write engine
 *                           sanitizes on save (save_component.ts, keyed on the
 *                           same facet), so what arrives here already went
 *                           through the sanitizer. Rich text only.
 *   'url'     a link      → the scheme allowlist (util.js safe_url,
 *                           url_sink_allowlist_tripwire) normalizes a web
 *                           scheme, THEN escaped; a refused scheme is escaped
 *                           as text (an IRI is a value, and a text node
 *                           cannot navigate — the href sinks keep their guard)
 *   'number'  a numeral   → String(Number(value)); a non-numeric value is
 *                           escaped as text, never trusted as a number
 *
 * A joined list goes through render_join (values by class, separator as text).
 * The <mark> wrap of a fallback-language value is ALSO built here
 * (render_fallback_value): the value is escaped BEFORE the wrap, so the mark
 * survives and the payload does not. common.js get_fallback_value stays for its
 * non-sink callers; a DOM sink uses this one.
 */

/**
 * ESCAPE_HTML
 * HTML-escapes a value for insertion into markup. The five characters that can
 * open an element, an attribute or an entity are replaced; everything else is
 * left alone (this is an escaper, not a sanitizer).
 * @param {*} value - any value; null/undefined render as ''
 * @return {string}
 */
export const escape_html = (value) => {
	if (value === null || value === undefined) {
		return '';
	}

	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}; //end escape_html

/**
 * RENDER_VALUE
 * Renders ONE value for an HTML sink according to its render class.
 * An array is rendered element-wise (the array comes back, each element
 * rendered) so callers keep their own join separator.
 * @param {*} value - the component value (string, number, array of them, null)
 * @param {string} render_class - 'text' | 'html' | 'url' | 'number' (absent → 'text')
 * @return {string|string[]}
 */
export const render_value = (value, render_class) => {
	if (Array.isArray(value)) {
		return value.map((el) => render_value(el, render_class));
	}

	switch (render_class) {
		case 'html':
			// Sanitized on save (the descriptor's `render:'html'` is what
			// routes the value through security/html_sanitize.ts). Trusted.
			return value === null || value === undefined ? '' : String(value);

		case 'url': {
			// The allowlist normalizes a web scheme; a scheme it refuses
			// (urn:, ark:, doi:, info: — heritage identifiers are IRIs, not
			// links) is still the record's VALUE and renders as escaped TEXT.
			// A text node cannot navigate: the scheme guard that matters sits at
			// the href / window.open sinks (util.js safe_url callers,
			// url_sink_allowlist_tripwire), never here.
			const url = safe_url(value);
			return url === null ? escape_html(value) : escape_html(url);
		}

		case 'number': {
			if (value === null || value === undefined || value === '') {
				return '';
			}
			const number = Number(value);
			return Number.isFinite(number) ? String(number) : escape_html(value);
		}

		default:
			// 'text' and everything else — the safe default. A class this
			// module does not know is NOT a licence to pass markup through.
			return escape_html(value);
	}
}; //end render_value

/**
 * RENDER_JOIN
 * Renders a list of values and joins them with a separator — BOTH rendered:
 * the values by their render class, the separator as text (a separator is
 * ontology configuration, e.g. ' | ', never markup).
 * @param {Array} values - the component values
 * @param {string} separator - the fields/records separator from the context
 * @param {string} render_class - the component's render class
 * @return {string}
 */
export const render_join = (values, separator, render_class) => {
	const list = Array.isArray(values)
		? values
		: values === null || values === undefined
			? []
			: [values];

	// a context without fields_separator must not glue values together ('09/06/162825/06/2024')
	return render_value(list, render_class).join(escape_html(separator ?? ', '));
}; //end render_join

/**
 * RENDER_FALLBACK_VALUE
 * The multi-language fallback merge for a DOM sink: for each position, the
 * entry's value when present, else the fallback-language value wrapped in
 * <mark>. Both are rendered through render_value BEFORE the wrap, so the mark
 * is markup and the value is not.
 * @param {Array} entries - the current-lang values [{value}, ...] (holes allowed)
 * @param {Array|null} fallback_value - the fallback-lang values [{value}, ...]
 * @param {string} render_class - the component's render class
 * @return {string[]} rendered strings, ready for an HTML sink
 */
export const render_fallback_value = (entries, fallback_value, render_class) => {
	const fallback_result = [];
	const value_length = entries.length > 0 ? entries.length : (fallback_value?.length ?? 0);

	for (let i = 0; i < value_length; i++) {
		if (entries[i]) {
			fallback_result.push(render_value(entries[i].value, render_class));
		} else {
			const fv = fallback_value?.[i];
			const marked_value = fv?.value ? `<mark>${render_value(fv.value, render_class)}</mark>` : '';

			fallback_result.push(marked_value);
		}
	}

	return fallback_result;
}; //end render_fallback_value

// @license-end
