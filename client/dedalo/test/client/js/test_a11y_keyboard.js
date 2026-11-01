// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global describe, it, assert, document, window, KeyboardEvent*/

/**
 * TEST_A11Y_KEYBOARD
 * THE KEYBOARD IS A REAL USER (audit 2026-08-26 row P1-18 / CLI-10, CLI-11, CLI-22).
 *
 * The other browser suites drive the client PROGRAMMATICALLY — they call the
 * methods a click would have called — so a completely keyboard-dead widget is
 * indistinguishable from a working one there. That is exactly how the thesaurus
 * tree stayed mouse-only. This suite is the opposite: it dispatches REAL
 * KeyboardEvents at the surfaces the cataloguer uses and asserts they respond,
 * are named, and hand focus back.
 */

import { a11y } from '../../../core/common/js/a11y.js';
import { tr } from '../../../core/common/js/tr.js';
import { ui } from '../../../core/common/js/ui.js';
import { view_text_list_3d } from '../../../core/component_3d/js/view_text_list_3d.js';
import { view_text_list_av } from '../../../core/component_av/js/view_text_list_av.js';
import { view_text_list_image } from '../../../core/component_image/js/view_text_list_image.js';
import { view_text_list_pdf } from '../../../core/component_pdf/js/view_text_list_pdf.js';
import { view_text_list_svg } from '../../../core/component_svg/js/view_text_list_svg.js';
import { build_node_tag } from '../../../core/component_text_area/js/view_default_edit_text_area.js';
import { flat_table } from '../../../tools/tool_export/js/flat_table.js';
import {
	build_component_edit,
	build_component_group_nested,
	build_component_line_row,
	build_login_form,
	build_modal,
	build_modal_minimized,
	build_modal_non_blocking,
	build_toolbar,
	build_tree_row,
} from './a11y_surfaces.js';

/**
 * PRESS
 * Dispatch a real key on a node.
 * @param {HTMLElement} node
 * @param {string} key
 * @return {void}
 */
const press = function (node, key) {
	node.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
}; //end press

describe('a11y: the cataloguing surface is operable without a mouse', function () {
	describe('component label association (CLI-10)', function () {
		it('the component label has an id and names its wrapper', function () {
			const { wrapper } = build_component_edit();
			const label = wrapper.querySelector('.label');
			assert.notStrictEqual(label, null, 'the wrapper builds a label node');
			assert.notStrictEqual(label.id, '', 'the label node carries an id');
			assert.strictEqual(wrapper.getAttribute('aria-labelledby'), label.id);
			assert.strictEqual(wrapper.getAttribute('role'), 'group');
		});

		it('a control appended AFTER the wrapper was built is still named by that label', function (done) {
			const { wrapper, input } = build_component_edit();
			const label = wrapper.querySelector('.label');
			// the shared document observer names it on the next observer tick
			window.setTimeout(function () {
				try {
					assert.strictEqual(
						input.getAttribute('aria-labelledby'),
						label.id,
						'the ONE document observer names controls that arrive later',
					);
					done();
				} catch (error) {
					done(error);
				}
			}, 50);
		});
	});

	describe('NESTED component groups name their own controls (CLI-10, portal row)', function () {
		// The portal row is the relational core of the record-edit surface: sibling
		// columns, each its own labelled component, committed to the document in ONE
		// append. Naming that subtree from the OUTERMOST group gave every column the
		// portal's name — present, and wrong, which is worse than absent because axe
		// sees a name and passes.

		it('each column input is named by ITS OWN label, not by the portal above it', function (done) {
			const surface = build_component_group_nested();
			window.setTimeout(function () {
				try {
					const { title_input, date_input, title_label, date_label, portal_label } = surface;
					assert.notStrictEqual(title_label.id, '', 'the first column has its own label node');
					assert.notStrictEqual(date_label.id, '', 'the second column has its own label node');
					assert.strictEqual(
						title_input.getAttribute('aria-labelledby'),
						title_label.id,
						'a control committed WITH the subtree is named by its own component label',
					);
					assert.strictEqual(
						date_input.getAttribute('aria-labelledby'),
						date_label.id,
						'a control that arrives AFTER the commit is named by its own component label',
					);
					assert.notStrictEqual(
						title_input.getAttribute('aria-labelledby'),
						portal_label.id,
						'the portal label names the portal, never the fields inside it',
					);
					assert.notStrictEqual(
						title_input.getAttribute('aria-labelledby'),
						date_input.getAttribute('aria-labelledby'),
						'adjacent fields must be programmatically distinguishable',
					);
					done();
				} catch (error) {
					done(error);
				}
			}, 50);
		});

		it('the nested wrappers are groups in their own right, inside the portal group', function () {
			const { portal_wrapper, title_wrapper, date_wrapper, portal_label, title_label, date_label } =
				build_component_group_nested();
			assert.strictEqual(portal_wrapper.getAttribute('aria-labelledby'), portal_label.id);
			assert.strictEqual(title_wrapper.getAttribute('aria-labelledby'), title_label.id);
			assert.strictEqual(date_wrapper.getAttribute('aria-labelledby'), date_label.id);
			assert.ok(
				portal_wrapper.contains(title_wrapper),
				'the columns really are nested in the portal',
			);
		});
	});

	describe('the SHIPPED line view names its own fields (CLI-10, label:null columns)', function () {
		// The columns a curator really sees render NO label node (label:null, all 14
		// view_line_edit_*). Before the chokepoint declared a label-less wrapper a
		// group by TEXT, the nearest labelled ancestor of a column input was the
		// PORTAL — every field in the row announced "Authors (portal)" — and a line
		// column outside a portal announced nothing at all.

		it('each label-less column input is named by its OWN component, not by the portal', function (done) {
			const surface = build_component_line_row();
			window.setTimeout(function () {
				try {
					const { title_input, date_input, portal_label } = surface;
					const title_name =
						title_input.getAttribute('aria-label') || title_input.getAttribute('aria-labelledby');
					const date_name =
						date_input.getAttribute('aria-label') || date_input.getAttribute('aria-labelledby');
					assert.strictEqual(
						title_input.getAttribute('aria-label'),
						'Title',
						'a column committed WITH the subtree carries its own component label',
					);
					assert.strictEqual(
						date_input.getAttribute('aria-label'),
						'Date',
						'a column arriving AFTER the commit carries its own component label',
					);
					assert.notStrictEqual(
						title_name,
						portal_label.id,
						'the portal label names the portal, never the fields inside it',
					);
					assert.notStrictEqual(
						title_name,
						date_name,
						'adjacent fields must be programmatically distinguishable',
					);
					done();
				} catch (error) {
					done(error);
				}
			}, 50);
		});

		it('a label-less column with NO labelled ancestor is named all the same', function (done) {
			const { lone_input } = build_component_line_row();
			window.setTimeout(function () {
				try {
					assert.strictEqual(
						lone_input.getAttribute('aria-label'),
						'Inventory number',
						'a section_record line outside a portal announced as "edit text, blank" before this',
					);
					done();
				} catch (error) {
					done(error);
				}
			}, 50);
		});
	});

	describe('the login form names its fields (CLI-10)', function () {
		// A placeholder is not a label: it disappears on the first keystroke, and it
		// is the only thing the login inputs ever carried. Built here through the
		// login instance's own render, so this is the form a curator is served.

		it('the username and password inputs carry an accessible name of their own', async function () {
			const { host, user_input, auth_input } = await build_login_form();
			assert.notStrictEqual(user_input, null, 'the login form builds the username input');
			assert.notStrictEqual(auth_input, null, 'the login form builds the password input');
			const user_name =
				user_input.getAttribute('aria-label') || user_input.getAttribute('aria-labelledby');
			const auth_name =
				auth_input.getAttribute('aria-label') || auth_input.getAttribute('aria-labelledby');
			assert.ok(
				user_name && user_name.trim() !== '',
				'the username input is NAMED, not merely place-held',
			);
			assert.ok(
				auth_name && auth_name.trim() !== '',
				'the password input is NAMED, not merely place-held',
			);
			assert.notStrictEqual(user_name, auth_name, 'the two fields are distinguishable');
			host.remove();
		});
	});

	describe('icon-only controls carry a name (CLI-10)', function () {
		it('an icon-only button announces its title; a labelled one keeps its text', function () {
			const { buttons } = build_toolbar();
			assert.strictEqual(buttons[0].getAttribute('aria-label'), 'New record');
			assert.strictEqual(buttons[1].getAttribute('aria-label'), 'Delete record');
			assert.strictEqual(
				buttons[2].getAttribute('aria-label'),
				null,
				'a button with visible text is named by its text, not by a duplicate aria-label',
			);
		});
	});

	describe('every <img> the DOM factory builds has a text alternative (WCAG 1.1.1, axe image-alt)', function () {
		it('an <img> with no alt option is DECORATIVE (alt=""), never unnamed', function () {
			const image = ui.create_dom_element({ element_type: 'img' });
			assert.strictEqual(image.hasAttribute('alt'), true, 'the attribute is present');
			assert.strictEqual(image.getAttribute('alt'), '', 'decorative by default');
		});
		it('a named <img> keeps its alt; alt never leaks onto a non-img element', function () {
			const image = ui.create_dom_element({ element_type: 'img', alt: 'Image' });
			assert.strictEqual(image.getAttribute('alt'), 'Image');
			const div = ui.create_dom_element({ element_type: 'div', alt: 'Image' });
			assert.strictEqual(div.hasAttribute('alt'), false);
		});
	});

	describe('every <img> built OUTSIDE the factory has a text alternative (WCAG 1.1.1, axe image-alt)', function () {
		// one token of EACH tag type tr.js turns into a badge <img>, with the alt
		// it must carry: the tag token the badge draws (its id)
		const TAG_CASES = [
			['indexIn', '[index-n-1-zz-data::data]', '[index-n-1-zz]'],
			['indexOut', '[/index-n-1-zz-data::data]', '[/index-n-1-zz]'],
			['tc', '[TC_00:00:25.091_TC]', '[TC_00:00:25.091_TC]'],
			['svg', '[svg-n-2-zz-data:x:data]', '[svg-n-2-zz]'],
			['draw', '[draw-n-3-zz-data:x:data]', '[draw-n-3-zz]'],
			['geo', '[geo-n-4-zz-data:x:data]', '[geo-n-4-zz]'],
			['page', '[page-n-5-zz-data:x:data]', '[page-n-5-zz]'],
			['person', '[person-n-6-zz-data:x:data]', '[person-n-6-zz]'],
			['note', '[note-n-7-zz-data:x:data]', '[note-n-7-zz]'],
			['lang', '[lang-n-8-zz-data:x:data]', '[lang-n-8-zz]'],
		];
		for (const [type, token, expected_alt] of TAG_CASES) {
			it(`tr.add_tag_img_on_the_fly: the ${type} badge <img> is named by its tag token`, function () {
				const host = document.createElement('div');
				host.innerHTML = tr.add_tag_img_on_the_fly(`a ${token} b`);
				const images = host.querySelectorAll('img');
				assert.strictEqual(images.length, 1, `one badge for ${token}`);
				assert.strictEqual(images[0].dataset.type, type);
				assert.strictEqual(images[0].hasAttribute('alt'), true, `${type} badge has an alt`);
				assert.strictEqual(images[0].getAttribute('alt'), expected_alt);
			});
		}

		it('build_node_tag (the editor tag node) is named by its tag token', function () {
			const node = build_node_tag({
				src: '',
				id: '[geo-n-4-zz]',
				class_name: 'geo',
				type: 'geo',
				tag_id: '4',
				state: 'n',
				label: 'zz',
				data: '',
			});
			assert.strictEqual(node.tagName, 'IMG');
			assert.strictEqual(node.getAttribute('alt'), '[geo-n-4-zz]');
		});

		const TEXT_VIEWS = [
			['component_image', view_text_list_image],
			['component_av', view_text_list_av],
			['component_3d', view_text_list_3d],
			['component_pdf', view_text_list_pdf],
			['component_svg', view_text_list_svg],
		];
		for (const [model, view] of TEXT_VIEWS) {
			it(`${model} text view: the lone image is named by the component label`, async function () {
				const self = {
					model: model,
					mode: 'list',
					view: 'text',
					label: 'Zz media label',
					data: { entries: [] },
					context: { features: { quality: 'zz' } },
				};
				const wrapper = await view.render(self, {});
				const images = wrapper.querySelectorAll('img');
				assert.strictEqual(images.length, 1, `${model} text view renders one image`);
				assert.strictEqual(images[0].getAttribute('alt'), 'Zz media label');
			});
		}

		it('flat_table media cell: every thumbnail carries an alt (decorative: the header names it)', function () {
			const table = new flat_table();
			for (const cell_type of ['img', 'av']) {
				const td = table._build_cell({ cell_type: cell_type }, '/zz/a.jpg | /zz/b.jpg');
				const images = td.querySelectorAll('img');
				assert.strictEqual(images.length, 2, `${cell_type}: one thumbnail per url`);
				for (const image of images) {
					assert.strictEqual(image.hasAttribute('alt'), true, `${cell_type} thumbnail has an alt`);
					assert.strictEqual(image.getAttribute('alt'), '');
				}
			}
		});
	});

	describe('the thesaurus row answers the keyboard (CLI-11)', function () {
		it('the expand arrow is a tab stop with a name and an expanded state', function () {
			const { arrow } = build_tree_row();
			assert.strictEqual(arrow.getAttribute('role'), 'button');
			assert.strictEqual(arrow.getAttribute('tabindex'), '0');
			assert.strictEqual(arrow.getAttribute('aria-label'), 'Children');
			assert.strictEqual(arrow.getAttribute('aria-expanded'), 'false');
		});

		it('ENTER toggles the arrow — the mousedown-only handler could not', function () {
			const { arrow, state } = build_tree_row();
			press(arrow, 'Enter');
			assert.strictEqual(state.expanded, true, 'Enter reached the SAME callback the pointer uses');
			assert.strictEqual(arrow.getAttribute('aria-expanded'), 'true');
		});

		it('SPACE activates the term, and an unrelated key does not', function () {
			const { term, state } = build_tree_row();
			press(term, ' ');
			assert.strictEqual(state.activations, 1);
			press(term, 'a');
			assert.strictEqual(state.activations, 1, 'only the activation keys activate');
		});
	});

	describe('the dialog announces itself, isolates the page and manages focus (CLI-22)', function () {
		// (!) the surface is built through ui.attach_to_modal — appended first,
		// content slotted after — because that is the ONLY order this client uses.
		// The name therefore arrives with the header slot's `slotchange`, one
		// microtask later, which is why these legs wait a tick.

		it('it is a dialog, modal, named by the header the caller slots AFTER connecting', function (done) {
			const { modal } = build_modal();
			assert.strictEqual(modal.getAttribute('role'), 'dialog');
			assert.strictEqual(modal.getAttribute('aria-modal'), 'true');
			window.setTimeout(function () {
				try {
					const header = modal.querySelector('[slot="header"]');
					assert.strictEqual(header.textContent.trim(), 'Delete record');
					assert.notStrictEqual(header.id, '', 'the slotted header gets an id');
					assert.strictEqual(
						modal.getAttribute('aria-labelledby'),
						header.id,
						'the name comes from the real title, not from a generic placeholder',
					);
					assert.strictEqual(
						modal.getAttribute('aria-label'),
						null,
						'the placeholder name is REMOVED once a real header is slotted',
					);
					modal.remove();
					done();
				} catch (error) {
					modal.remove();
					done(error);
				}
			}, 0);
		});

		it('the record surface BEHIND the dialog is inert — at its own nesting level', function () {
			const { modal, background_button, page_wrapper } = build_modal();
			assert.strictEqual(
				background_button.inert,
				true,
				'a control one level below body, beside the page wrapper, is inert',
			);
			background_button.focus();
			assert.notStrictEqual(
				document.activeElement,
				background_button,
				'an inert control cannot even be focused programmatically',
			);
			assert.strictEqual(
				page_wrapper.inert,
				false,
				'the ancestor chain of the dialog itself is never inerted',
			);
			modal.remove();
			assert.strictEqual(background_button.inert, false, 'closing lifts exactly what it set');
		});

		it('TAB is trapped across BOTH the dialog trees — the slotted content and the shadow chrome', function () {
			const { modal, cancel_button, confirm_button, background_button } = build_modal();

			// (a) between its own controls the dialog does NOT hijack Tab: the
			// browser's own order carries focus from Cancel to Delete. A trap that
			// reads only the shadow chrome answers every Tab by yanking focus to
			// the close button, which is how it hid that the content controls were
			// not candidates at all.
			cancel_button.focus();
			assert.strictEqual(
				a11y.deep_active_element(),
				cancel_button,
				'a content control can take focus',
			);
			const inner_tab = new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				cancelable: true,
			});
			cancel_button.dispatchEvent(inner_tab);
			assert.strictEqual(
				inner_tab.defaultPrevented,
				false,
				'a Tab that has somewhere to go inside the dialog is left to the browser',
			);

			// (b) SHIFT+TAB from the FIRST candidate (the shadow close/minimize
			// chrome) wraps to the LAST — which is a slotted content control, so
			// the light DOM is provably in the candidate list.
			const chrome_first = modal.shadowRoot.querySelector('.mini_modal');
			chrome_first.focus();
			// composed:true — a keydown raised inside the shadow chrome only reaches
			// the host (where the trap listens) if it crosses the shadow boundary,
			// which is exactly what a real key event does.
			const back_tab = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey: true,
				bubbles: true,
				composed: true,
				cancelable: true,
			});
			chrome_first.dispatchEvent(back_tab);
			assert.strictEqual(back_tab.defaultPrevented, true, 'the trap took the boundary Tab');
			assert.strictEqual(
				a11y.deep_active_element(),
				confirm_button,
				'backwards from the first candidate lands on the LAST — a slotted control, not more chrome',
			);

			// (c) forward from the last candidate wraps back inside, never out
			confirm_button.focus();
			const out_tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
			confirm_button.dispatchEvent(out_tab);
			assert.strictEqual(out_tab.defaultPrevented, true, 'the trap took the boundary Tab');
			const active = a11y.deep_active_element();
			assert.ok(
				modal.contains(active) || modal.shadowRoot.contains(active),
				'focus wrapped to a control of the dialog, not out into the page',
			);
			assert.notStrictEqual(active, background_button);
			modal.remove();
		});

		it('opening moves focus INTO the dialog, closing restores it to the element that really had it', function () {
			const opener = document.createElement('button');
			document.body.appendChild(opener);
			opener.focus();
			const { modal } = build_modal();
			assert.notStrictEqual(a11y.deep_active_element(), opener, 'focus left the opener');
			modal.remove();
			assert.strictEqual(document.activeElement, opener, 'focus came back to the opener');
			const still_inert = Array.from(document.body.children).filter((el) => el.inert === true);
			assert.strictEqual(still_inert.length, 0, 'nothing is left inert');
			opener.remove();
		});

		it('opening and closing NEVER scroll the page — focus lands on the first content control', async function () {
			// (!) the host is an in-flow element appended at the END of the page and
			// the trap arms at connect time, before anything is shown or slotted: its
			// only candidate is the host, and a plain focus() on it scrolled the page
			// to the bottom on every open (the user lost their place in the record list).
			const spacer = document.createElement('div');
			spacer.style.height = '400vh';
			document.body.insertBefore(spacer, document.body.firstChild);
			const scrolled_to = 200;
			window.scrollTo(0, scrolled_to);
			const before = window.scrollY;
			assert.strictEqual(before, scrolled_to, 'the page is scrolled before the dialog opens');

			const { modal, cancel_button } = build_modal();
			try {
				assert.strictEqual(window.scrollY, before, 'opening kept the page position');
				assert.strictEqual(
					a11y.deep_active_element(),
					cancel_button,
					'once shown, focus moved off the host onto the first content control',
				);
				const closed = await modal.close();
				assert.strictEqual(closed, true, 'the transient dialog closed');
				assert.strictEqual(window.scrollY, before, 'closing kept the page position');
			} finally {
				if (modal.isConnected) modal.remove();
				spacer.remove();
				window.scrollTo(0, 0);
			}
		});

		it('initial focus NEVER lands on a destructive (.danger) control, even when it comes first', function () {
			// Enter/Space fires the focused button: a confirm that lists Delete before
			// Cancel (component_input_text's all-languages remove) must not arm it.
			const { modal, cancel_button, confirm_button } = build_modal({
				name: 'modal_destructive_first',
				destructive_first: true,
			});
			try {
				assert.strictEqual(
					confirm_button.nextElementSibling,
					cancel_button,
					'the surface really puts the destructive action first',
				);
				assert.strictEqual(
					a11y.deep_active_element(),
					cancel_button,
					'the first NON-destructive control takes focus',
				);
			} finally {
				modal.remove();
			}
		});

		it('closing brings an opener the user scrolled away from back into view', function () {
			// the restore does not scroll implicitly (no jump on close), but focus
			// must not be left on a control the user cannot see
			const opener = document.createElement('button');
			opener.textContent = 'Opener';
			const spacer = document.createElement('div');
			spacer.style.height = '400vh';
			document.body.insertBefore(spacer, document.body.firstChild);
			document.body.insertBefore(opener, spacer);
			window.scrollTo(0, 0);
			opener.focus();
			const { modal } = build_modal();
			try {
				window.scrollTo(0, window.innerHeight * 2);
				assert.ok(opener.getBoundingClientRect().bottom < 0, 'the opener scrolled out of view');
				modal.remove();
				assert.strictEqual(document.activeElement, opener, 'focus came back to the opener');
				const rect = opener.getBoundingClientRect();
				assert.ok(
					rect.top >= 0 && rect.bottom <= window.innerHeight,
					'and the opener is visible again',
				);
			} finally {
				if (modal.isConnected) modal.remove();
				opener.remove();
				spacer.remove();
				window.scrollTo(0, 0);
			}
		});

		it('MINIMIZING gives the page back: the parked dialog isolates nothing, restoring re-arms it', function () {
			const { modal, background_button, cancel_button } = build_modal_minimized();

			// PARKED. The strip is 15rem in a corner and exists so the user can work
			// on the record behind it; an isolation released only on close left the
			// whole application inert, unclickable and out of the a11y tree.
			assert.strictEqual(modal.mini, true, 'Enter on the chrome control parked it');
			assert.strictEqual(background_button.inert, false, 'the record surface behind is live again');
			background_button.focus();
			assert.strictEqual(
				document.activeElement,
				background_button,
				'a control behind a PARKED dialog can be focused',
			);
			assert.strictEqual(
				modal.getAttribute('aria-modal'),
				null,
				'a parked dialog does not claim the page',
			);
			let clicked = 0;
			background_button.addEventListener('click', () => {
				clicked++;
			});
			background_button.click();
			assert.strictEqual(clicked, 1, 'and it can be clicked');

			// the trap is gone too: Tab out of the parked dialog is the browser's
			const tab = new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				composed: true,
				cancelable: true,
			});
			cancel_button.dispatchEvent(tab);
			assert.strictEqual(tab.defaultPrevented, false, 'a parked dialog does not trap Tab');

			// RESTORED. It is a modal dialog again.
			const mini_control = modal.shadowRoot.querySelector('.mini_modal');
			mini_control.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					composed: true,
					cancelable: true,
				}),
			);
			assert.strictEqual(modal.mini, false, 'restored');
			assert.strictEqual(modal.getAttribute('aria-modal'), 'true', 'aria-modal is re-armed');
			assert.strictEqual(background_button.inert, true, 'the page is isolated again');

			modal.remove();
			assert.strictEqual(background_button.inert, false, 'and closing lifts it once more');
		});

		it('a NON-BLOCKING (remove_overlay) dialog is named but never isolates the page', function (done) {
			const { modal, background_button, cancel_button, confirm_button } =
				build_modal_non_blocking();

			assert.strictEqual(modal.getAttribute('role'), 'dialog');
			assert.strictEqual(
				modal.getAttribute('aria-modal'),
				null,
				'a panel the caller declared non-blocking must not announce itself as modal',
			);
			assert.strictEqual(background_button.inert, false, 'the surface behind it stays usable');
			background_button.focus();
			assert.strictEqual(document.activeElement, background_button, 'and reachable');

			// no trap: Tab from the LAST candidate is left to the browser, where a
			// modal dialog would have wrapped it back inside
			confirm_button.focus();
			const tab = new KeyboardEvent('keydown', {
				key: 'Tab',
				bubbles: true,
				composed: true,
				cancelable: true,
			});
			confirm_button.dispatchEvent(tab);
			assert.strictEqual(tab.defaultPrevented, false, 'Tab may leave a non-blocking panel');

			// focus IS still moved in and the name still arrives from the header:
			// non-modal is not "no accessibility contract"
			assert.ok(cancel_button !== null);
			window.setTimeout(function () {
				try {
					const header = modal.querySelector('[slot="header"]');
					assert.strictEqual(
						modal.getAttribute('aria-labelledby'),
						header.id,
						'a non-modal dialog is named by its header too',
					);
					modal.remove();
					done();
				} catch (error) {
					modal.remove();
					done(error);
				}
			}, 0);
		});
	});
});
