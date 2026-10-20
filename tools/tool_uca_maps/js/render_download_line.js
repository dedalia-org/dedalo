// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RENDER_DOWNLOAD_LINE
 * What every download button shares: the line under it where a failure is shown,
 * and a click that allows one attempt at a time. Every other panel's in-flow line
 * is built and shown by the same two helpers.
 *
 * @module render_download_line
 */

import { ui } from '../../../core/common/js/ui.js';

/**
 * CREATE_PANEL_MESSAGE
 * A panel's hidden in-flow line — under a download button, where a failure is
 * shown with the reason the page toast does not carry. Each new attempt clears it.
 *
 * @param {HTMLElement} parent
 * @param {string} class_name
 * @returns {HTMLElement}
 */
export const create_panel_message = (parent, class_name) => {
	const message = ui.create_dom_element({
		element_type: 'div',
		class_name: class_name,
		parent: parent,
	});
	message.hidden = true;

	return message;
}; //end create_panel_message

/**
 * SHOW_PANEL_MESSAGE
 * Shows `text` on a panel's in-flow line, tinted by `type`.
 *
 * @param {HTMLElement} message - the line create_panel_message built
 * @param {string} text
 * @param {string} [type='error'] - 'error' | 'warning' (nothing found) | 'ok' | 'info' (working)
 * @returns {void}
 */
export const show_panel_message = (message, text, type = 'error') => {
	message.textContent = text;
	message.dataset.type = type;
	message.hidden = false;
}; //end show_panel_message

/**
 * RENDER_NEW_TAB_LINK
 * A link that opens in a new tab without handing the opened page
 * `window.opener`.
 *
 * @param {string} class_name
 * @param {string|undefined} text
 * @param {string} href
 * @param {HTMLElement} parent
 * @returns {HTMLAnchorElement}
 */
export const render_new_tab_link = (class_name, text, href, parent) => {
	const link = ui.create_dom_element({
		element_type: 'a',
		class_name: class_name,
		text_content: text,
		parent: parent,
	});
	link.href = href;
	link.target = '_blank';
	link.rel = 'noopener noreferrer';

	return link;
}; //end render_new_tab_link

/**
 * BIND_DOWNLOAD_BUTTON
 * The button stays disabled until the answer is in: two attempts in flight
 * could answer out of order, and a slow refusal would land under a later
 * download that worked.
 *
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} message - create_panel_message's line
 * @param {function(): Promise<{ok: boolean, error?: string}|undefined>} run
 * @returns {void}
 */
export const bind_download_button = (button, message, run) => {
	button.addEventListener('click', async () => {
		// the button's own state, never a JS flag
		if (button.disabled) {
			return;
		}
		button.disabled = true;
		message.hidden = true;
		try {
			const result = await run();
			if (result?.error) {
				message.textContent = result.error;
				message.hidden = false;
			}
		} finally {
			if (button.isConnected) {
				button.disabled = false;
			}
		}
	});
}; //end bind_download_button

// @license-end
