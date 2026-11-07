// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global assert */
/*eslint no-undef: "error"*/

/**
 * CSS_FIXTURE_FRAME
 * Shared by the backend-free LAYOUT suites that measure the REAL main.css at a
 * viewport of their choosing. The suite iframe is narrower than the desktop
 * breakpoint (@width_break_point_0, 1024px), so every rule scoped to the
 * desktop tier (the section list table, the search canvas's multi-track group
 * grid…) is OFF there: a desktop fixture needs its own wider frame.
 */

// the compiled stylesheet, resolved from this module
// (js/ → client/ → test/ → dedalo/ → core/page/css/main.css)
export const STYLESHEET_HREF = new URL('../../../core/page/css/main.css', import.meta.url).href;

/**
 * WAIT_FOR
 * Poll a predicate until true or the timeout elapses. Used instead of the
 * link's `load` event: a stylesheet already served from cache can fire before
 * the listener is attached.
 * @param {Function} predicate
 * @param {number} [timeout_ms]
 * @returns {Promise<boolean>}
 */
export const wait_for = async (predicate, timeout_ms = 3000) => {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		if (predicate()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	return predicate();
}; //end wait_for

/**
 * OPEN_CSS_FRAME
 * An off-screen iframe of the given width loading the REAL main.css. Off-screen,
 * NOT display:none: a hidden frame skips layout. The caller removes `frame`.
 * @param {number} width - px
 * @param {string} container_class - class name(s) of the body's fixture container
 * @returns {Promise<{frame: HTMLIFrameElement, doc: Document, win: Window, container: HTMLElement}>}
 */
export const open_css_frame = async (width, container_class) => {
	const new_frame = document.createElement('iframe');
	new_frame.style.cssText =
		`position:absolute;left:-10000px;top:0;width:${width}px;height:800px;border:0;`;
	// listener BEFORE append: an about:blank load event can fire in the
	// append itself, and a listener attached afterwards would never hear it
	const frame_loaded = new Promise((resolve) =>
		new_frame.addEventListener('load', resolve, { once: true }),
	);
	document.body.appendChild(new_frame);
	if (new_frame.contentDocument?.readyState !== 'complete') {
		await Promise.race([frame_loaded, new Promise((resolve) => setTimeout(resolve, 5000))]);
	}

	const doc = new_frame.contentDocument;
	const win = new_frame.contentWindow;
	doc.open();
	doc.write(
		'<!doctype html><html><head><meta charset="utf-8">' +
			`<link rel="stylesheet" href="${STYLESHEET_HREF}">` +
			'</head><body></body></html>',
	);
	doc.close();

	const ready = await wait_for(() => {
		try {
			return doc.styleSheets.length > 0 && doc.styleSheets[0].cssRules.length > 0;
		} catch (_error) {
			return false;
		}
	}, 8000);
	if (!ready) {
		// the caller never receives the frame on a failed open: remove it here
		new_frame.remove();
	}
	assert.equal(ready, true, `the ${width}px suite frame loaded main.css`);

	const container = doc.createElement('div');
	container.className = container_class;
	doc.body.appendChild(container);

	return { frame: new_frame, doc, win, container };
}; //end open_css_frame

// @license-end
