// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

/**
 * TOUCH_PICK
 * The touch-screen twin of an HTML5 drag-and-drop: TAP TO PICK, TAP TO PLACE.
 *
 * HTML5 `dragstart`/`drop` never fire from a finger, so on a touch screen a
 * drag-only gesture is not merely uncomfortable — the task cannot be done
 * (tool_cataloging: a record tile dropped onto a thesaurus term). This module
 * holds ONE picked payload — the SAME string the dragstart handler would have
 * put in `dataTransfer` — and the drop target hands it to its existing drop
 * handler through `as_drop_event`, so the drop logic stays single: this is a
 * second gesture, not a second implementation.
 *
 * While a payload is picked, `body.touch_pick_active` is set (drop targets can
 * hint) and a bottom bar names what is carried and offers cancel.
 *
 * Use `is_touch()` to decide whether to offer the tap gesture: a coarse
 * pointer (a finger), not a width — a narrow desktop window still drags.
 */

// the one picked payload for this page (a page, not a request: client state)
let picked = null;

/**
 * IS_TOUCH
 * @return {boolean} true when the primary pointer is coarse (a finger)
 */
export const is_touch = function () {
	return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}; //end is_touch

/**
 * PICK
 * Holds `data` (the dragstart payload string) until a target consumes it.
 * @param {string} data - exactly what dragstart puts in dataTransfer 'text/plain'
 * @param {string} label - what is carried, shown in the bar
 * @return {void}
 */
export const pick = function (data, label) {
	cancel();

	const bar = document.createElement('div');
	bar.className = 'touch_pick_bar';
	bar.setAttribute('role', 'status');

	const text = document.createElement('span');
	text.className = 'touch_pick_text';
	const labels = typeof get_label !== 'undefined' ? get_label : {};
	text.textContent =
		(labels.tap_term_to_place || 'Tap a term to place it') + (label ? ': ' + label : '');
	bar.appendChild(text);

	const cancel_button = document.createElement('button');
	cancel_button.type = 'button';
	cancel_button.className = 'touch_pick_cancel';
	cancel_button.textContent = labels.cancel || 'Cancel';
	cancel_button.addEventListener('click', (e) => {
		e.stopPropagation();
		cancel();
	});
	bar.appendChild(cancel_button);

	document.body.appendChild(bar);
	document.body.classList.add('touch_pick_active');

	picked = { data, bar };
}; //end pick

/**
 * ACTIVE
 * @return {boolean} a payload is waiting for a target
 */
export const active = function () {
	return picked !== null;
}; //end active

/**
 * CANCEL
 * Drops the picked payload without placing it.
 * @return {void}
 */
export const cancel = function () {
	if (picked) {
		picked.bar.remove();
		picked = null;
	}
	document.body.classList.remove('touch_pick_active');
}; //end cancel

/**
 * PEEK
 * Reads the picked payload WITHOUT consuming it. A delegated tap receiver
 * (component_portal drag_and_drop.js bind_row_drag) must first decide whether
 * the pick is its own: only then does it call `as_drop_event()`, which
 * consumes. A receiver that consumed a FOREIGN pick (a cataloging card, a
 * coin) would cancel it before the tap reached the receiver it was meant for
 * (the ts_object term, the coins slot), so the decision reads through here.
 * @return {string|null} the picked data string, or null when nothing is picked
 */
export const peek = function () {
	return picked ? picked.data : null;
}; //end peek

/**
 * AS_DROP_EVENT
 * Consumes the picked payload as the minimal DragEvent shape a drop handler
 * reads (`preventDefault`, `stopPropagation`, `dataTransfer.getData`).
 * @return {Object|null} null when nothing is picked
 */
export const as_drop_event = function () {
	if (!picked) {
		return null;
	}
	const data = picked.data;
	cancel();
	return {
		preventDefault: () => {},
		stopPropagation: () => {},
		dataTransfer: {
			getData: () => data,
		},
	};
}; //end as_drop_event

// @license-end
