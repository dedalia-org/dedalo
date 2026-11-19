// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * WINDOW_FEATURES (module)
 * The CLOSED, declarative grammar of a tool's `windowFeatures` property — the
 * size and position a tool asks for when it opens (`properties.windowFeatures`
 * of its registration, or `open_tool({windowFeatures})`).
 *
 * The value is DATA: it comes from the tool registry (a database record) and
 * from callers. Until 2026-11-19 a string value starting with `return` was run
 * as code (`Function(value)()`), so whoever could write a tool registration
 * could run script in every user's page. Nothing here evaluates anything: a
 * value is PARSED against the grammar below, and whatever does not fit is
 * refused with an error that names the key (WC-2026-11-19-window-features-grammar).
 *
 * No imports on purpose: the module is pure, so its unit gate
 * (test/unit/client_window_features.test.ts) loads it as it is served.
 *
 * WINDOW form (`open_as: 'window'`) — `window.open` features:
 *   keys    left, top, width, height (aliases screenX, screenY, innerWidth,
 *           innerHeight); popup, noopener, noreferrer
 *   values  for a position/size key:
 *             - a finite number, or a string of digits ("760");
 *             - the legacy relative form, PARSED:
 *                 return (screen|window).<dimension> [(+|-) <integer>]
 *               with <dimension> one of the names in READABLE below, e.g.
 *               "return screen.width -760" (tool_upload).
 *           for a flag key: true/false, 1/0, "yes"/"no".
 *   A string 'left=100,top=100,width=320' is the same pairs written inline and
 *   passes the same grammar.
 *
 * MODAL form (`open_as: 'modal'`) — the size of the modal box:
 *   keys    width, minWidth, maxWidth, height, minHeight, maxHeight
 *   values  a number (pixels) or a CSS length/percentage/sizing keyword.
 */

/** Position / size keys of `window.open`. */
const WINDOW_NUMBER_KEYS = [
	'left',
	'top',
	'width',
	'height',
	'screenX',
	'screenY',
	'innerWidth',
	'innerHeight',
];

/** Flag keys of `window.open`. */
const WINDOW_FLAG_KEYS = ['popup', 'noopener', 'noreferrer'];

/** What the legacy relative form may READ, per object. Numbers, all of them. */
const READABLE = {
	screen: ['width', 'height', 'availWidth', 'availHeight', 'availLeft', 'availTop'],
	window: [
		'innerWidth',
		'innerHeight',
		'outerWidth',
		'outerHeight',
		'screenX',
		'screenY',
		'screenLeft',
		'screenTop',
	],
};

/** `return screen.width -760` — the whole legacy grammar. */
const RELATIVE_FORM = /^return\s+(screen|window)\.([A-Za-z]+)\s*(?:([+-])\s*(\d{1,6}))?\s*;?$/;

/** The modal box's size properties (CSSOM names). */
const MODAL_STYLE_KEYS = ['width', 'minWidth', 'maxWidth', 'height', 'minHeight', 'maxHeight'];

/** A CSS length, a percentage, or a sizing keyword — nothing with a parenthesis. */
const MODAL_STYLE_VALUE =
	/^(?:\d+(?:\.\d+)?(?:px|rem|em|ch|vw|vh|dvw|dvh|svw|svh|lvw|lvh|vmin|vmax|%)|0|auto|none|fit-content|max-content|min-content)$/;

/**
 * REFUSE
 * Every refusal goes through here: the KEY is named, the value is not echoed
 * (it is the thing being refused).
 * @param {string} key
 * @param {string} why
 * @throws {Error}
 */
const refuse = (key, why) => {
	throw new Error(`tool windowFeatures: '${key}' ${why}`);
}; //end refuse

/**
 * RESOLVE_WINDOW_NUMBER
 * One position/size value → a finite number, by the grammar; never by evaluation.
 * @param {string} key
 * @param {*} value
 * @param {{screen?: Object, window?: Object}} env - where the relative form reads from
 * @return {number}
 */
const resolve_window_number = (key, value, env) => {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) refuse(key, 'is not a finite number');
		return value;
	}

	if (typeof value !== 'string') {
		refuse(key, 'must be a number or the form "return screen.width - 760"');
	}

	const text = value.trim();

	if (/^-?\d{1,6}(?:\.\d{1,3})?$/.test(text)) {
		return Number(text);
	}

	const match = RELATIVE_FORM.exec(text);
	if (!match) {
		refuse(
			key,
			'is not a number nor the form "return (screen|window).<dimension> [+|-] <integer>"',
		);
	}

	const [, object_name, dimension, sign, amount] = match;
	if (!READABLE[object_name].includes(dimension)) {
		refuse(key, `reads '${object_name}.${dimension}', which is not a readable dimension`);
	}

	const source = env ? env[object_name] : null;
	const base = source ? source[dimension] : undefined;
	if (typeof base !== 'number' || !Number.isFinite(base)) {
		refuse(key, `reads '${object_name}.${dimension}', which is not available here`);
	}

	const offset = amount === undefined ? 0 : Number(amount);

	return sign === '-' ? base - offset : base + offset;
}; //end resolve_window_number

/**
 * RESOLVE_WINDOW_FLAG
 * @param {string} key
 * @param {*} value
 * @return {string} 'yes' | 'no'
 */
const resolve_window_flag = (key, value) => {
	if (value === true || value === 1 || value === '1' || value === 'yes' || value === 'true')
		return 'yes';
	if (value === false || value === 0 || value === '0' || value === 'no' || value === 'false')
		return 'no';

	refuse(key, 'must be true/false, 1/0 or "yes"/"no"');
}; //end resolve_window_flag

/**
 * PARSE_WINDOW_FEATURES
 * A tool's `windowFeatures` → the feature string `window.open` takes, or null
 * when the tool declares none (the caller opens a tab).
 * @param {Object|string|null|undefined} window_features
 * @param {{screen?: Object, window?: Object}} [env] - defaults to the page's own
 * @return {string|null} e.g. 'top=0,left=1160,width=760,height=708'
 * @throws {Error} naming the offending key
 */
export const parse_window_features = (window_features, env) => {
	if (window_features === null || window_features === undefined || window_features === '') {
		return null;
	}

	const sources = env || {
		screen: typeof screen === 'undefined' ? null : screen,
		window: typeof window === 'undefined' ? null : window,
	};

	// pairs. The inline string is the same pairs, written 'key=value,key=value'
	const pairs = [];
	if (typeof window_features === 'string') {
		for (const chunk of window_features.split(',')) {
			const text = chunk.trim();
			if (text === '') continue;
			const cut = text.indexOf('=');
			// a bare flag ('popup') is 'popup=yes'
			pairs.push(
				cut === -1 ? [text, true] : [text.slice(0, cut).trim(), text.slice(cut + 1).trim()],
			);
		}
	} else if (typeof window_features === 'object' && !Array.isArray(window_features)) {
		for (const key of Object.keys(window_features)) {
			pairs.push([key, window_features[key]]);
		}
	} else {
		refuse('windowFeatures', 'must be an object, a "key=value,…" string or null');
	}

	const parsed_pairs = [];
	for (const [key, value] of pairs) {
		if (WINDOW_NUMBER_KEYS.includes(key)) {
			parsed_pairs.push(`${key}=${resolve_window_number(key, value, sources)}`);
		} else if (WINDOW_FLAG_KEYS.includes(key)) {
			parsed_pairs.push(`${key}=${resolve_window_flag(key, value)}`);
		} else {
			refuse(String(key).slice(0, 40), 'is not a window feature this client accepts');
		}
	}

	return parsed_pairs.length > 0 ? parsed_pairs.join(',') : null;
}; //end parse_window_features

/**
 * PARSE_MODAL_FEATURES
 * A modal tool's `windowFeatures` → the size styles to set on the modal box.
 * @param {Object|null|undefined} window_features
 * @return {Object} e.g. {width: '40rem', maxWidth: '100%'} — empty when none
 * @throws {Error} naming the offending key
 */
export const parse_modal_features = (window_features) => {
	const styles = {};

	if (window_features === null || window_features === undefined) {
		return styles;
	}
	// The inline string is the WINDOW form's; a modal has no use for it.
	if (typeof window_features !== 'object' || Array.isArray(window_features)) {
		return styles;
	}

	for (const key of Object.keys(window_features)) {
		if (!MODAL_STYLE_KEYS.includes(key)) {
			refuse(String(key).slice(0, 40), 'is not a modal size property this client accepts');
		}
		const value = window_features[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
			styles[key] = `${value}px`;
		} else if (typeof value === 'string' && MODAL_STYLE_VALUE.test(value.trim())) {
			styles[key] = value.trim();
		} else {
			refuse(key, 'must be a number of pixels, a CSS length or percentage, or a sizing keyword');
		}
	}

	return styles;
}; //end parse_modal_features

// @license-end
