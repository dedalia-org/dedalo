// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RENDER_DOWNLOAD_LINE
 * What every download button shares: the line under it where a failure is
 * shown, and a click that allows one attempt at a time. Used by the object
 * console's three downloads and by the map image panel.
 *
 * @module render_download_line
 */

import { ui } from '../../../core/common/js/ui.js';

/**
 * RENDER_DOWNLOAD_MESSAGE
 * The line under a download button where a failure is shown with its reason,
 * which the page toast does not carry. Each new attempt clears it.
 *
 * @param {HTMLElement} parent
 * @param {string} [class_name]
 * @returns {HTMLElement}
 */
export const render_download_message = (parent, class_name = 'uca-maps-download-message') => {
	const message = ui.create_dom_element({
		element_type: 'div',
		class_name: class_name,
		parent: parent,
	});
	message.hidden = true;

	return message;
}; //end render_download_message

/**
 * BIND_DOWNLOAD_BUTTON
 * The button stays disabled until the answer is in: two attempts in flight
 * could answer out of order, and a slow refusal would land under a later
 * download that worked.
 *
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} message - render_download_message's line
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
