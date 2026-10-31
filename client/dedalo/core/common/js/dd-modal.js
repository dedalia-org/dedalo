// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global Promise, page_globals, SHOW_DEBUG, get_label */
/**
 * DD_MODAL — Custom Element (<dd-modal>)
 *
 * A Web Component that provides a draggable, minimizable modal dialog.
 * Uses Shadow DOM with named slots (header, body, footer) for content projection.
 * Registered as the custom element 'dd-modal' via customElements.define.
 *
 * Sizes (set via the `data-size` attribute or the open() method):
 *   'normal' — centered, 80% width (default)
 *   'big'    — 97vw × 97vh; suitable for full-screen editing views
 *   'small'  — fit-content, max 32vw, viewport-centered, max 90vh; suitable for
 *              confirmation dialogs and option pickers
 *
 * Features:
 *   - Drag by header: on first mousedown over .dragger, the modal-content is
 *     pinned from CSS centering to inline position:absolute so drag offsets are
 *     stable. Movement is clamped to the overlay container bounds.
 *   - Minimize to a bottom strip: clicking the '_' button toggles the .mini class
 *     and stacks minimized modals at the bottom-right with computed offsets. A
 *     minimized modal is PARKED, not open: its background isolation (aria-modal,
 *     the inert sweep, the focus trap) is released while it is in the strip and
 *     re-armed when it is restored, because the whole point of the strip is that
 *     the page behind stays usable.
 *   - Modality is DECLARED by the caller (`modality`, set by ui.attach_to_modal
 *     before connect): 'non_modal' (a `remove_overlay` panel) is announced as a
 *     dialog and manages its own focus, but never isolates the page.
 *   - Close via the '×' button, overlay click, or Escape key (topmost stack entry).
 *   - Self-detaching: a closed modal removes itself from the DOM, so listener
 *     de-registration and modal_stack removal always happen (never delegated to
 *     a caller-supplied on_close, which callers routinely overwrite).
 *   - Unsaved-data guard: _closeModal() awaits check_unsaved_data() before hiding.
 *     A caller that owns editors inside the modal may set `before_close`: it is
 *     awaited FIRST, so the modal's own rows commit their typed values before the
 *     page-wide guard judges (and, on OK, resets) the unsaved registry.
 *     Concurrent closes are serialised — the guard returns the in-flight promise.
 *   - Modal stack: window.modal_stack[] tracks all mounted dd-modal elements;
 *     Escape always targets the topmost (last) entry.
 *   - window.modal getter: always returns the topmost dd-modal or null.
 *
 * Public API:
 *   open(type)          — show modal; type is 'normal'|'big'|'small'
 *   close()             — async; checks unsaved data, then hides; returns {Promise<boolean>}
 *   get_modal_node()    — returns the .modal shadow <div> (the full-screen overlay)
 *   get_modal_content() — returns the .modal-content shadow <div> (the dialog box)
 *   remove_miniModal()  — removes the '_' minimize button from the shadow DOM
 *
 * Properties set externally (typically by attach_to_modal callers):
 *   before_close  {Function|null} — awaited with (this) BEFORE the unsaved-data guard,
 *                                   while the modal is still shown; resolving to false
 *                                   keeps the modal open (nothing else runs). Unset →
 *                                   the close sequence is exactly the guard-first one.
 *   on_close      {Function|null} — called with (this) after modal visibility is removed;
 *                                   also triggers service_autocomplete.destroy if present
 *   publish_close {Function|null} — called with (this) to fire the 'modal_close' event
 *                                   via event_manager before on_close runs
 *   transient     {boolean}       — when true, close() skips the page-wide unsaved-data
 *                                   guard. Set by ui.confirm() for transient yes/no dialogs.
 *   modality      {string}        — 'modal' (default) | 'non_modal'. Set by
 *                                   ui.attach_to_modal BEFORE the element is connected;
 *                                   'non_modal' suppresses aria-modal, the ancestor-chain
 *                                   inert sweep and the Tab trap (see _apply_isolation).
 *
 * DOM events dispatched:
 *   'dd-modal-close' — on the element itself (bubbles:false), after on_close and
 *                      before self-removal. on_close is a single slot that callers
 *                      overwrite wholesale; this event is the seam the framework
 *                      (ui.attach_to_modal) uses for teardown that must always run.
 *
 * Shadow DOM slots:
 *   slot[name="header"] — header bar content (projected inside .modal-header)
 *   slot[name="body"]   — main dialog content (projected inside .modal-body)
 *   slot[name="footer"] — footer content (projected inside .modal-footer)
 *
 * CSS custom properties consumed (all have defaults):
 *   --modal_overlay_bg, --modal_overlay_bg_weak
 *   --modal_content_bg, --modal_content_shadow, --modal_radius
 *   --modal_header_bg, --modal_header_color (--modal_header_shadow: layout.less only)
 *   --modal_btn_color, --modal_btn_hover_color, --modal_btn_hover_bg, --focus_ring
 *
 * Additional styles are applied from layout.less → dd-modal (light DOM side).
 */


// imports
import {check_unsaved_data} from '../../component_common/js/component_common.js'
import {a11y} from './a11y.js'



// (!) Guard: HTMLElement is undefined in non-browser environments (Node.js, some test runners).
// The entire class definition is skipped there; customElements.define is never called.
if (typeof HTMLElement!=='undefined') {
class DDModal extends HTMLElement {

	/**
	 * OBSERVEDATTRIBUTES
	 * Declares which HTML attributes the browser should observe for changes.
	 * When data-size changes on a mounted element, attributeChangedCallback fires
	 * and routes to the appropriate _showModal* size variant.
	 * @returns {Array} list of observed attribute names
	 */
	static get observedAttributes() {
		return ['data-size'];
	}

	/**
	 * CONSTRUCTOR
	 * Initialises instance state, creates the Shadow DOM from the template string,
	 * and pre-binds all event handler references so they can be added and removed
	 * by name (bound methods are not equal-by-reference, so storing them is required
	 * for removeEventListener to work correctly).
	 *
	 * Instance properties initialised here:
	 *   _modalVisible {boolean} — whether the overlay is currently shown
	 *   mini          {boolean} — whether the modal is in minimized strip mode
	 *   on_close      {Function|null} — caller-supplied callback, run after hide
	 *   publish_close {Function|null} — caller-supplied event publisher, run before on_close
	 *   drag_data     {Object}  — transient drag state (see _onHeaderMousedown)
	 *
	 * Bound handler properties (prefixed _bound*):
	 *   All are method references bound to `this`. Stored so the same function object
	 *   can be passed to both addEventListener and removeEventListener.
	 */
	constructor() {
		super();
		this._modalVisible = false;
		this.mini = false;
		this.on_close = null;
		this.before_close = null;
		this.publish_close = null;
		this._closing = null; // in-flight close promise; see _closeModal()
		this.attachShadow({ mode: 'open' });
		this.shadowRoot.innerHTML = this._template();

		// Pre-bind event handlers to `this` so removeEventListener can de-register them.
		this._boundHideModal	= this._hideModal.bind(this);
		this._boundHeaderSlotchange = () => this._apply_dialog_name();
		this._boundMiniModal	= this._miniModal.bind(this);
		this._boundDetectKey	= this.detect_key.bind(this);
		this._boundMousemove	= this.mousemove.bind(this);
		this._boundMouseup		= this.mouseup.bind(this);
		this._boundOverlayClick	= this._hideModal.bind(this);
		this._boundHeaderMousedown	= this._onHeaderMousedown.bind(this);
		this._boundChromeKeydown	= this._onChromeKeydown.bind(this);
		// Focus management state (CLI-22): the trap's release function and the
		// background-isolation release, so both are undone exactly once.
		this._release_focus	= null;
		this._release_inert	= null;
		// The element that really had focus when the dialog opened. Captured ONCE,
		// because isolation is applied and released more than once in a dialog's
		// life (minimize parks it, restore re-arms it) and the opener must not be
		// re-read from a page the dialog itself is holding focus in.
		this._restore_focus_to = null;
		// MODALITY, declared by the caller BEFORE connect (ui.attach_to_modal), not
		// inferred from construction. 'modal' isolates the page; 'non_modal' does
		// not — `remove_overlay` dialogs are documented as leaving the surface
		// behind them usable, so aria-modal, the inert sweep and the Tab trap would
		// each be a lie about them.
		this.modality = 'modal';

		// Transient drag state. Reset to null on mouseup. x/y store the cursor-to-element
		// offset computed at drag start so mousemove can move cleanly.
		this.drag_data = {
			target		: null,  // the .modal-content element being dragged
			x			: null,  // cursor clientX minus element left at drag start
			y			: null,  // cursor clientY minus element top at drag start
			margin_left	: null,  // computed margin-left used in boundary clamping
			margin_top	: null   // computed margin-top used in boundary clamping
		};
	}

	/**
	 * _TEMPLATE
	 * Returns the Shadow DOM HTML string, including all scoped styles and the
	 * structural markup. Called once inside the constructor before connectedCallback.
	 *
	 * The template exposes three named slots (header, body, footer) and uses CSS
	 * custom properties so host pages can theme colors without piercing the shadow.
	 * Part attributes (overlay, content, header, body, footer) allow additional
	 * external styling via ::part().
	 *
	 * Size variants are implemented via modifier classes on .modal:
	 *   .modal_big   — applied by _showModalBig(); full-viewport mode
	 *   .modal_small — applied by _showModalSmall(); compact dialog mode
	 *   .mini        — applied by _miniModal(); minimized strip at bottom-right
	 *
	 * @returns {string} the complete Shadow DOM HTML with embedded <style>
	 */
	_template() {
		return `
		<style>
			:host {
				// color-scheme: normal;
			}

			.modal {
				font-size: inherit;
				display: none;
				position: fixed;
				z-index: 4;
				left: 0;
				top: 0;
				width: 100%;
				height: 100%;
				background-color: var(--modal_overlay_bg, rgba(0,0,0,0.4));
				transition: opacity 0.2s ease;
				opacity: 0;
			}
			.remove_overlay {
				background-color: var(--modal_overlay_bg_weak, rgba(0,0,0,0.075));
			}
			.modal_show {
				display: block;
				opacity: 1;
			}

			.modal-content {
				display: grid;
				/* row 1 = .modal-header: max-content, never auto. A manual resize
				   (resize: auto below) gives this box an explicit height, and an
				   auto row then shrinks to the item's min-height (the header's
				   3.66rem floor), clipping a taller header. The body and footer
				   rows stay auto: the overflow scrolls under the sticky header. */
				grid-template-rows: max-content;
				position: relative;
				background-color: var(--modal_content_bg, #fefefe);
				margin: auto;
				top: 3.5vh;
				padding: 0;
				width: 80%;
				max-width: 100%;
				min-width: 15rem;
				max-height: 93.5vh;
				box-shadow: var(--modal_content_shadow, 0 4px 8px 0 rgba(0,0,0,0.2), 0 6px 20px 0 rgba(0,0,0,0.19));
				font-size: inherit;
				border-radius: var(--modal_radius, 7px);
				overflow: auto;
				resize: auto;
				z-index: 2;
			}
			@media screen and (max-width: 1024px) {
				.modal-content {
					width: 96%;
				}
			}
			.modal-content.center {
				position: absolute;
				left: 50%;
				top: 50%;
				transform: translate(-50%, -50%);
			}
			.dragging {
				cursor: move;
				user-select: none;
				-moz-user-select: none;
				-webkit-user-select: none;
			}

			@-webkit-keyframes animatetop {
				from {top:-300px; opacity:0}
				to {top:0; opacity:1}
			}
			@keyframes animatetop {
				from {top:-300px; opacity:0}
				to {top:0; opacity:1}
			}

			/* window buttons: a 2.5rem (~32px at the 13px root) hit target each, not the bare glyph;
			   theme ink from the host (--modal_btn_*), a faint wash on hover and a
			   VISIBLE ring for keyboard focus (they are role=button tabindex=0) */
			.mini_modal,
			.close_modal {
				color: var(--modal_btn_color, var(--fg_muted));
				font-size: 1.75rem;
				font-weight: bold;
				line-height: 1;
				position: absolute;
				top: 0.6rem;
				z-index: 3;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 2.5rem;
				height: 2.5rem;
				border-radius: 5px;
				cursor: pointer;
				transition: background-color 0.15s ease, color 0.15s ease;
			}
			.close_modal { right: 0.5rem; }
			.mini_modal {
				right: 3.25rem;
				align-items: flex-start; /* the "_" glyph sits on the baseline */
			}
			.mini_modal:hover,
			.close_modal:hover {
				color: var(--modal_btn_hover_color, var(--fg_default));
				background-color: var(--modal_btn_hover_bg);
			}
			.mini_modal:focus,
			.close_modal:focus { outline: none; }
			.mini_modal:focus-visible,
			.close_modal:focus-visible {
				color: var(--modal_btn_hover_color, var(--fg_default));
				outline: 2px solid var(--focus_ring, var(--color_input_focus));
				outline-offset: 1px;
			}

			.modal-header {
				position: sticky;
				top: 0;
				z-index: 4;
				background-color: var(--modal_header_bg, var(--bg_surface_alt));
				color: var(--modal_header_color, var(--fg_default));
				/* no shadow of its own: the slotted .header carries the one shadow
				   (layout.less / tool_common) */
				box-shadow: none;
				/* brand accent stripe on top edge; painted, so height is unchanged */
				background-image: linear-gradient(var(--modal_header_accent, transparent) 0 4px, transparent 4px);
				/* a FLOOR, never a fixed height: a slotted header that wraps (a long
				   tool name/description, a narrow screen) grows the bar, and the
				   sticky in-flow bar pushes the body down. A fixed height let the
				   taller header overflow it and paint over the body's first rows.
				   flex: the slotted header stretches to the bar's full height (the
				   window buttons are absolute, so it is the only flex item) */
				display: flex;
				min-height: 3.66rem;
			}
			.modal-header > slot[name="header"]::slotted(*) {
				flex: 1 1 auto;
				min-width: 0;
			}

			.modal-body {
			}

			.modal-footer {
				margin-top: 1.5rem;
			}

			.modal_big {
				padding: 0;
				z-index: 9999;
			}
			.modal_big > .modal-content {
				width: 97vw;
				height: 97vh;
				overflow: auto;
			}

			.modal_small {
				padding: 0;
				z-index: 9999;
			}
			/* Centered in the viewport instead of pushed down by a fixed margin-top:
			   a tall small modal (e.g. a long list of options) used to start at 20vh
			   and overflow below the fold, hiding its own action buttons. */
			.modal_small.modal_show:not(.mini) {
				display: flex;
				align-items: center;
				justify-content: center;
			}
			.modal_small > .modal-content {
				width: fit-content;
				max-width: 32vw;
				height: auto;
				margin: 0;
				top: 0;
				max-height: 90vh;
				overflow: auto;
			}
			@media screen and (max-width: 1024px) {
				.modal_small > .modal-content {
					max-width: unset;
				}
			}
			/* PHONE: every modal (not the minimised dock chip) is a full-viewport
			   sheet. 600px mirrors @width_break_point_phone (vars.less) — a shadow
			   root cannot read LESS; test/unit/tool_phone_tripwire.test.ts pins
			   the two equal. */
			@media screen and (max-width: 600px) {
				.modal:not(.mini) > .modal-content,
				.modal_big:not(.mini) > .modal-content,
				.modal_small:not(.mini) > .modal-content {
					width: 100vw;
					max-width: 100vw;
					min-width: 0;
					height: 100dvh;
					max-height: 100dvh;
					top: 0;
					left: 0;
					transform: none;
					margin: 0;
					border-radius: 0;
					resize: none;
					padding-bottom: env(safe-area-inset-bottom);
				}
			}

			.mini {
				position: fixed;
				z-index: 9999;
				width: 15rem;
				height: 60px;
				overflow: hidden;
				left: unset;
				top: unset;
				right: 5px;
				margin: 0;
				background: none;
			}
			.mini > .modal-content {
				margin: 0;
				box-shadow: none;
				overflow: hidden;
				position: relative;
				width: 15rem;
				height: 60px;
				display: contents;
			}
			.mini > .modal-body, .mini > .modal-footer {
				display: none;
			}
			.mini .mini_modal {
				position: absolute;
				right: 10px;
				top: calc((60px - 2.5rem) / 2); /* centred in the 60px mini bar */
			}
			.mini .close_modal {
				right: 0;
				display: none;
			}

			/* (!) See layout.less -> dd-modal for more styles of current element */
		</style>
		<div class="modal" part="overlay">
			<div class="modal-content draggable" part="content">
				<div class="modal-header dragger" part="header">
					<span class="mini_modal" role="button" tabindex="0" aria-label="Minimize dialog">_</span>
					<span class="close_modal" role="button" tabindex="0" aria-label="Close dialog">&times;</span>
					<slot name="header" class="header">Modal box default header</slot>
				</div>
				<div class="modal-body" part="body">
					<slot name="body">Modal box default body</slot>
				</div>
				<div class="modal-footer" part="footer">
					<slot name="footer">Modal box default footer</slot>
				</div>
			</div>
		</div>
		`;
	}

	/**
	 * CONNECTEDCALLBACK
	 * Standard custom-element lifecycle hook, called when the element is inserted
	 * into the document. Caches shadow DOM references, attaches all event listeners,
	 * and registers this instance in the global modal stack.
	 *
	 * Event listeners are attached here (not in the constructor) because the
	 * shadow DOM nodes are available but the element is not yet in a live document
	 * during construction — document-level listeners should not be active then.
	 *
	 * Modal stack registration:
	 *   window.modal_stack is created on first use. The window.modal getter is
	 *   (re-)defined as configurable each time so it always points to the current
	 *   topmost entry. The setter is a no-op to silently absorb legacy assignments.
	 */
	connectedCallback() {
		// Cache shadow DOM references used across multiple methods.
		this._modal			= this.shadowRoot.querySelector(".modal");
		this.modal_content	= this.shadowRoot.querySelector(".modal-content");

		// Attach shadow-internal button and overlay listeners.
		this.shadowRoot.querySelector(".mini_modal").addEventListener('mousedown', this._boundMiniModal);
		this.shadowRoot.querySelector(".close_modal").addEventListener('mousedown', this._boundHideModal);
		this._modal.addEventListener('mousedown', this._boundOverlayClick);

		// Keyboard (Escape) and drag listeners are document-level because they must
		// fire regardless of where focus or the pointer currently is.
		document.addEventListener('keyup', this._boundDetectKey);
		document.addEventListener('mousemove', this._boundMousemove);
		document.addEventListener('mouseup', this._boundMouseup);

		const header = this.shadowRoot.querySelector(".modal-header");
		header.addEventListener('mousedown', this._boundHeaderMousedown);

		// DIALOG SEMANTICS + FOCUS MANAGEMENT (audit P1-18 / CLI-22).
		// Before this, the application's single dialog primitive had no role, no
		// accessible name, no focus move, no trap and no restore: the destructive
		// delete confirmation opened and announced nothing, with the virtual cursor
		// left behind on the record list.
		this._apply_dialog_semantics();

		// The keyboard activation of the two shadow chrome controls. They are spans
		// (their styling is the '×' and '_' glyph, not a button box), so they get
		// the same treatment every non-native control in the client gets: ONE
		// callback reached by pointer AND by Enter/Space.
		this.shadowRoot.querySelector(".mini_modal").addEventListener('keydown', this._boundChromeKeydown);
		this.shadowRoot.querySelector(".close_modal").addEventListener('keydown', this._boundChromeKeydown);

		// Register in global stack so Escape always targets the topmost modal.
		if (!window.modal_stack) window.modal_stack = [];
		window.modal_stack.push(this);

		// (!) Redefine window.modal as a getter every time a new modal mounts.
		// configurable:true ensures subsequent definitions don't throw.
		Object.defineProperty(window, 'modal', {
			get : () => window.modal_stack?.[window.modal_stack.length - 1] || null,
			set : () => {},
			configurable : true
		});
	}

	/**
	 * _APPLY_DIALOG_SEMANTICS
	 * Everything a dialog owes its user, applied at mount (audit P1-18 / CLI-22):
	 *   role="dialog" + aria-modal, so it is announced AS a dialog;
	 *   an accessible NAME taken from the slotted header — LAZILY, see below;
	 *   focus moved INTO the dialog and trapped across BOTH its trees;
	 *   everything outside the dialog made `inert` along the whole ancestor
	 *   chain, so Tab, the pointer and the virtual cursor cannot leave it.
	 *
	 * (!) THE NAME CANNOT BE READ AT CONNECT TIME. `ui.attach_to_modal` — the ONE
	 * caller that creates a `<dd-modal>` in this client — appends the element to
	 * its parent FIRST (which is when this runs) and slots the header, body and
	 * footer AFTERWARDS. Reading `[slot="header"]` here therefore always found
	 * null in production and the dialog was permanently named the literal string
	 * "Dialog"; only the gate's own hand-built surface, which slotted first and
	 * appended last, ever saw a header. The name is now (re)applied on every
	 * `slotchange` of the header slot, which is the event the platform raises
	 * exactly when that content arrives.
	 *
	 * @return {void}
	 */
	_apply_dialog_semantics() {

		this.setAttribute('role', 'dialog');

		// name now (a caller that slotted first) and again when the header arrives
		this._apply_dialog_name();
		const header_slot = this.shadowRoot.querySelector('slot[name="header"]');
		if (header_slot) {
			header_slot.addEventListener('slotchange', this._boundHeaderSlotchange);
		}

		// The opener, read BEFORE anything of this dialog takes focus.
		this._restore_focus_to = a11y.deep_active_element();

		this._apply_isolation();
	}

	/**
	 * _APPLY_ISOLATION
	 * The MODAL half of the dialog contract, applied on open and RE-applied when a
	 * minimized dialog is restored: `aria-modal`, the ancestor-chain inert sweep
	 * and the Tab trap across both trees.
	 *
	 * (!) A NON-MODAL dialog gets none of the three. `attach_to_modal` declares the
	 * modality; `remove_overlay:true` callers (the text editor's find-and-replace,
	 * tool_diffusion's panel) exist precisely so the user can keep working on the
	 * surface behind them. Focus is still moved IN and restored on release, because
	 * a panel opened from the keyboard that leaves focus behind is unusable too —
	 * that is `trap:false`, not "no focus management".
	 * @return {void}
	 */
	_apply_isolation() {

		if (this._release_inert || this._release_focus) return; // already armed

		const is_modal = this.modality!=='non_modal';

		if (is_modal) {
			this.setAttribute('aria-modal', 'true');
			// Background isolation, ANCESTOR-CHAIN wide (a body-children sweep is a
			// no-op here: the modal is appended inside `.wrapper.page`).
			this._release_inert = a11y.inert_background(this);
		}else{
			this.removeAttribute('aria-modal');
		}

		// Focus in (+ trap, when modal). `restore_to` is the element that REALLY
		// had focus when the dialog opened — the old code saved a component-
		// activation pointer instead, so even its restore path restored the wrong
		// thing. BOTH roots: the slotted light DOM (every content control lives
		// there) and the shadow chrome (close / minimize).
		this._release_focus = a11y.trap_focus(this, {
			roots		: [this.shadowRoot, this],
			restore_to	: this._restore_focus_to,
			trap		: is_modal
		});
	}

	/**
	 * _RELEASE_ISOLATION
	 * Lift the inert sweep and the trap. Called on close (focus restored to the
	 * opener) and on MINIMIZE (`restore_focus:false`).
	 *
	 * (!) MINIMIZE IS A RELEASE. `.mini` shrinks the overlay to a 15rem strip in
	 * the corner: the feature exists so the page behind is usable while the dialog
	 * is parked. Leaving the whole application inert behind a parked dialog makes
	 * the record surface unclickable, unfocusable and absent from the accessibility
	 * tree until the dialog is restored or closed — the isolation must follow the
	 * dialog's STATE, not merely its lifetime.
	 * @param {Object} [options] - {boolean} [restore_focus=true]
	 * @return {void}
	 */
	_release_isolation(options={}) {

		// UN-INERT FIRST, RESTORE SECOND. An inert element cannot take focus, and
		// the element that opened the dialog is behind it — so restoring before
		// lifting the inert leaves focus on <body>.
		if (typeof this._release_inert==='function') {
			this._release_inert();
			this._release_inert = null;
		}
		this.removeAttribute('aria-modal');

		if (typeof this._release_focus==='function') {
			this._release_focus({restore: options.restore_focus!==false});
			this._release_focus = null;
		}
	}

	/**
	 * _APPLY_DIALOG_NAME
	 * Take the accessible name from the slotted header once there is one to take.
	 * A modal with no header (or an empty placeholder one — `attach_to_modal`
	 * slots a hidden empty div when the caller gave no header) keeps a generic
	 * `aria-label`, which is REPLACED as soon as a real title is slotted: an
	 * unnamed dialog and a permanently mis-named one are the same defect.
	 * @return {boolean} true when the name comes from the header
	 */
	_apply_dialog_name() {

		const header_node	= this.querySelector('[slot="header"]');
		const header_text	= header_node ? (header_node.textContent || '').trim() : '';

		if (header_node && header_text!=='') {
			if (!header_node.id) {
				header_node.id = a11y.generate_id('dd_modal_title');
			}
			this.removeAttribute('aria-label');
			this.setAttribute('aria-labelledby', header_node.id);
			return true;
		}

		if (!this.getAttribute('aria-labelledby')) {
			this.setAttribute('aria-label', 'Dialog');
		}
		return false;
	}

	/**
	 * _RELEASE_DIALOG_SEMANTICS
	 * Undo of the above: release the trap (restoring focus to the opener) and
	 * un-inert exactly the elements this modal inerted. Idempotent.
	 * @return {void}
	 */
	_release_dialog_semantics() {

		this._release_isolation();
		this._restore_focus_to = null;
	}

	/**
	 * _ONCHROMEKEYDOWN
	 * Enter/Space on the shadow '×' / '_' controls. They carry mousedown
	 * listeners and keyboard activation dispatches `click`, never `mousedown`, so
	 * without this the two controls are unreachable without a pointer.
	 * @param {KeyboardEvent} e
	 * @return {void}
	 */
	_onChromeKeydown(e) {
		if (e.key!=='Enter' && e.key!==' ' && e.key!=='Spacebar') return;
		e.preventDefault();
		if (e.target && e.target.classList.contains('mini_modal')) {
			this._miniModal(e);
		} else {
			this._hideModal(e);
		}
	}

	/**
	 * DISCONNECTEDCALLBACK
	 * Standard custom-element lifecycle hook, called when the element is removed
	 * from the document. Removes all event listeners (using the same bound
	 * references stored in connectedCallback) and removes this instance from
	 * window.modal_stack.
	 *
	 * Guards are applied to .mini_modal and .modal-header because remove_miniModal()
	 * may have already detached those nodes before disconnection.
	 */
	disconnectedCallback() {
		// .mini_modal may have been removed by remove_miniModal(); guard before de-registering.
		const mini_modal = this.shadowRoot.querySelector(".mini_modal");
		if (mini_modal) {
			mini_modal.removeEventListener('mousedown', this._boundMiniModal);
		}
		this.shadowRoot.querySelector(".close_modal").removeEventListener('mousedown', this._boundHideModal);
		this._modal.removeEventListener('mousedown', this._boundOverlayClick);
		document.removeEventListener('keyup', this._boundDetectKey);
		document.removeEventListener('mousemove', this._boundMousemove);
		document.removeEventListener('mouseup', this._boundMouseup);

		const header = this.shadowRoot.querySelector(".modal-header");
		if (header) {
			header.removeEventListener('mousedown', this._boundHeaderMousedown);
		}

		const mini_modal_key = this.shadowRoot.querySelector(".mini_modal");
		if (mini_modal_key) {
			mini_modal_key.removeEventListener('keydown', this._boundChromeKeydown);
		}
		this.shadowRoot.querySelector(".close_modal").removeEventListener('keydown', this._boundChromeKeydown);

		const header_slot = this.shadowRoot.querySelector('slot[name="header"]');
		if (header_slot) {
			header_slot.removeEventListener('slotchange', this._boundHeaderSlotchange);
		}

		// Release the focus trap and un-inert the page (CLI-22). Both are
		// idempotent, and both run here — the element removes itself on close, so
		// this is the one exit every close path shares.
		this._release_dialog_semantics();

		// Remove from global stack so Escape no longer targets this closed modal.
		if (window.modal_stack) {
			const idx = window.modal_stack.indexOf(this);
			if (idx > -1) window.modal_stack.splice(idx, 1);
		}

		// A disconnected modal frees its slot in the minimized strip: restack the
		// survivors so no gap is left behind.
		this._restack_minis();
	}

	/**
	 * ATTRIBUTECHANGEDCALLBACK
	 * Observed attribute: data-size. Fires when the attribute is set or changed on
	 * the element, even before connectedCallback (in which case this._modal is not
	 * yet set — the guard ensures no-op in that window).
	 * Delegates to the appropriate _showModal* size variant.
	 * @param {string} name - attribute name (always 'data-size' given observedAttributes)
	 * @param {string|null} oldVal - previous attribute value
	 * @param {string|null} newVal - new attribute value ('big'|'small'|anything else → normal)
	 */
	attributeChangedCallback(name, oldVal, newVal) {
		if (name === 'data-size' && this._modal) {
			if (newVal === 'big') {
				this._showModalBig();
			} else if (newVal === 'small') {
				this._showModalSmall();
			} else {
				this._showModal();
			}
		}
	}

	/**
	 * _SHOWMODAL
	 * Shows the modal at normal size (80% width, centered via CSS margin:auto).
	 * Removes any .modal_big class that may have been applied by a previous call to
	 * _showModalBig(), ensuring the size reverts cleanly when switching modes.
	 * Sets _modalVisible to true so callers can query visibility state.
	 */
	_showModal() {
		this._modalVisible = true;
		this._modal.classList.add('modal_show');
		if (this._modal.classList.contains("modal_big")) {
			this._modal.classList.remove("modal_big");
		}
		this._focus_initial();
	}

	/**
	 * _SHOWMODALBIG
	 * Shows the modal at full viewport size (97vw × 97vh) by applying .modal_big
	 * to the shadow .modal overlay. The sticky .modal-header is in normal flow,
	 * so slotted content (including iframe.fixed bodies) already starts below it
	 * — no offset compensation is needed here.
	 */
	_showModalBig() {
		this._modalVisible = true;
		this._modal.classList.add('modal_show');
		this._modal.classList.add("modal_big");
		this._focus_initial();
	}

	/**
	 * _SHOWMODALSMALL
	 * Shows the modal at compact size (fit-content width, max 32vw, auto height,
	 * centered in the viewport, never taller than 90vh) by applying .modal_small.
	 * Also removes any .modal_big class so the two size modifiers don't coexist.
	 * On narrow viewports (≤ 1024 px) the max-width constraint is lifted via media
	 * query in the template style so the small modal still fits the screen.
	 */
	_showModalSmall() {
		this._modalVisible = true;
		this._modal.classList.add('modal_show');
		this._modal.classList.add('modal_small');
		if (this._modal.classList.contains('modal_big')) {
			this._modal.classList.remove('modal_big');
		}
		this._focus_initial();
	}

	/**
	 * _FOCUS_INITIAL
	 * Move focus onto the first real control once the dialog is SHOWN.
	 *
	 * (!) The trap arms at connect time, when `.modal` is still display:none and
	 * `ui.attach_to_modal` has not slotted anything yet, so its only candidate is
	 * the host itself: focus lands on `<dd-modal>` (an in-flow element at the END
	 * of the page). Once shown, the content is laid out and focusable — hand focus
	 * to the first content control (light DOM first: a confirm's own buttons, not
	 * the '_' chrome). Only while focus is still parked on the host: a caller that
	 * already focused something inside keeps it. Never scrolls
	 * (a11y.focus_without_scroll).
	 *
	 * (!) NEVER A DESTRUCTIVE CONTROL. Focus on a button means Enter/Space fires
	 * it, and several confirmations put their `.danger` action FIRST (the
	 * all-languages remove in component_input_text: Delete, then Cancel). The
	 * first NON-`.danger` content control wins; with only destructive ones, focus
	 * goes to the close chrome '×', which is always safe.
	 * @return {void}
	 */
	_focus_initial() {
		if (this.mini || !this._release_focus) return; // not armed (parked / closed)
		if (a11y.deep_active_element()!==this) return;
		const safe_content	= a11y.list_focusables([this]).find(el => !el.classList.contains('danger'));
		const target		= safe_content || this.shadowRoot.querySelector('.close_modal');
		if (target) {
			a11y.focus_without_scroll(target);
		}
	}

	/**
	 * OPEN
	 * Public entry point to display the modal. Routes to the appropriate private
	 * _showModal* variant based on `type`. Callers that set the `data-size` attribute
	 * on the element trigger the same path through attributeChangedCallback; `open()`
	 * is the imperative alternative for code-only callers.
	 * @param {string} type - size variant: 'big' | 'small' | (any other → 'normal')
	 */
	open(type) {
		switch(type) {
			case 'big':		return this._showModalBig();
			case 'small':	return this._showModalSmall();
			default:		return this._showModal();
		}
	}

	/**
	 * _HIDEMODAL
	 * Shared mousedown handler used for both the '×' close button and the
	 * semi-transparent overlay. Stops event propagation to prevent the click
	 * from reaching parent components, then delegates to _closeModal().
	 *
	 * When triggered by .close_modal (the '×' button), the mini flag is cleared
	 * first so the unsaved-data guard in _closeModal is not short-circuited.
	 * When triggered by .modal (the overlay), the modal closes only if the click
	 * hit the overlay directly — clicks on modal-content bubble up to .modal but
	 * e.target will be the content element, not .modal, so they are ignored.
	 * @param {MouseEvent} e - the mousedown event
	 */
	_hideModal(e) {
		if (e.target.matches('.close_modal')) {
			e.stopPropagation();
			this.mini = false;
		}
		if (e.target.matches('.modal') || e.target.matches('.close_modal')) {
			e.stopPropagation();
			this._closeModal();
		}
	}

	/**
	 * _MINIMODAL
	 * Toggles minimized strip mode for this modal. When minimizing, the .mini
	 * class is applied to the shadow .modal and to the light-DOM header slot
	 * element (so slot-projected header styles can also react), and the mini
	 * flag is set to true. When restoring, the class and flag are removed.
	 *
	 * Stack positioning is delegated to _restack_minis(), called on BOTH branches:
	 * minimizing appends a strip, restoring frees one, and either way the surviving
	 * strips must be re-indexed so no gap or overlap is left at the bottom-right.
	 *
	 * (!) A minimized modal returns true from _closeModal without checking unsaved
	 * data, so the user must first restore it before closing.
	 * @param {MouseEvent} e - the mousedown event (expected target: .mini_modal)
	 */
	_miniModal(e) {
		e.stopPropagation();
		if (e.target.matches('.mini_modal')) {

			if (this.mini) {
				this.shadowRoot.querySelector('.modal').classList.remove('mini');
				const header = this.querySelector("[slot='header']");
				if (header) header.classList.remove('mini');
				this.mini = false;
				// Un-parked: the dialog is a dialog again, so its isolation is
				// re-armed (aria-modal, inert, trap) before the strip is restacked.
				this._apply_isolation();
				// This modal just left the strip: close the gap it leaves behind.
				this._restack_minis();

			}else{
				this.shadowRoot.querySelector('.modal').classList.add('mini');
				const header = this.querySelector("[slot='header']");
				if (header) header.classList.add('mini');
				this.mini = true;
				// PARKED: minimize exists so the page behind is usable. Lift the
				// inert sweep, the trap and aria-modal — but do NOT move focus,
				// which stays where the user just put it (the strip's own control).
				this._release_isolation({restore_focus: false});
				this._restack_minis();
			}
		}
	}

	/**
	 * _RESTACK_MINIS
	 * Re-indexes every CURRENTLY minimized dd-modal so their strips stack
	 * vertically at the bottom-right without overlapping and without reserving a
	 * slot for a modal that is not minimized. Each strip is 60 px tall with a 5 px
	 * gap; position formula: bottom = (60 * i) + (5 * i + 5).
	 *
	 * (!) Filtering on `el.mini` is load-bearing: indexing over ALL dd-modal
	 * elements makes an open modal that precedes a minimized one in DOM order
	 * reserve a slot, leaving a visible hole under the strip.
	 * Called from both branches of _miniModal() and from disconnectedCallback(),
	 * so restoring or closing a modal also closes its gap.
	 */
	_restack_minis() {
		const minis = Array.from(document.querySelectorAll('dd-modal')).filter(el => el.mini === true);
		for (let i = 0; i < minis.length; i++) {
			const modal = minis[i].shadowRoot?.querySelector('.modal');
			if (!modal) continue;
			modal.style.bottom = ((60 * i) + (5 * i + 5)) + "px";
		}
	}

	/**
	 * _CLOSEMODAL
	 * Core async close sequence. Performs the following steps in order:
	 *
	 *   1. Guard: if the modal is minimized (this.mini === true), return true
	 *      immediately — minimized modals cannot be closed without restoring first.
	 *   1b. before_close: if set, awaited with (this) while the modal is still shown;
	 *      false keeps it open. It lets the modal's own editors commit BEFORE step 2:
	 *      check_unsaved_data is page-wide and its OK runs reset_unsaved_data, so a
	 *      typed-not-blurred value of an editor inside the modal would otherwise be
	 *      judged unsaved and discarded by the very close that should commit it
	 *      (the mosaic alt table, view_mosaic_edit_portal).
	 *   2. Unsaved-data check: unless this.transient===true, awaits check_unsaved_data(),
	 *      which shows a browser confirm dialog if any component in the page has pending
	 *      changes. Returns false without closing if the user cancels. A transient modal
	 *      (ui.confirm) owns no editable data and skips the guard entirely.
	 *   3. Hide: removes .modal_show from the shadow .modal and sets _modalVisible
	 *      to false.
	 *   4. publish_close callback: if set, called with (this) to fire the
	 *      'modal_close' event through event_manager for any subscribers.
	 *   5. on_close callback: if set, called with (this); also destroys the
	 *      autocomplete service (service_autocomplete.destroy) when present to
	 *      prevent stale dropdown overlays after the modal is gone.
	 *   6. 'dd-modal-close' event: dispatched on the element itself so framework
	 *      teardown can run even when a caller has overwritten on_close (several
	 *      components replace it wholesale). See ui.attach_to_modal.
	 *   7. Self-removal: the element detaches itself from the DOM, which fires
	 *      disconnectedCallback (listener de-registration + modal_stack splice).
	 *
	 * (!) Re-entrancy: the await in step 2 suspends this method, so a second
	 * trigger (Escape twice, Escape + ×) would otherwise run the whole tail a
	 * second time and double-fire publish_close/on_close. _closeModal is a guard
	 * that returns the in-flight promise; the sequence lives in _doCloseModal.
	 *
	 * @returns {Promise<boolean>} true when the modal was successfully closed,
	 *   false when the user cancelled the unsaved-data prompt
	 */
	_closeModal() {

		// In-flight guard. A close already awaiting check_unsaved_data owns the
		// sequence; every concurrent caller shares its result instead of re-running it.
		if (this._closing) {
			return this._closing;
		}

		this._closing = this._doCloseModal().finally(() => {
			this._closing = null;
		});

		return this._closing;
	}

	/**
	 * _DOCLOSEMODAL
	 * The actual close sequence. Never call directly — go through _closeModal(),
	 * which serialises concurrent closes.
	 * @returns {Promise<boolean>} true when closed, false when the user cancelled
	 */
	async _doCloseModal() {

		// A minimized modal is not closed — the user must restore it first.
		if (this.mini) {
			return true;
		}

		// The modal's own editors commit first (before_close), so the page-wide
		// guard below sees only what they could not commit. Awaited while the
		// modal is still shown; false keeps it open.
		// A throwing hook is logged and the close falls through to the guard,
		// which still sees whatever the hook did not commit.
		if (typeof this.before_close === 'function') {
			let proceed = true;
			try {
				proceed = await this.before_close(this);
			} catch (error) {
				console.error('dd-modal: before_close failed:', error);
			}
			if (proceed === false) {
				return false;
			}
		}

		// Prompt the user if there are unsaved changes anywhere on the page.
		// check_unsaved_data resolves to false if the user clicks "cancel".
		// (!) Skipped for transient dialogs (ui.confirm). A yes/no dialog owns no
		// editable data, and this guard is PAGE-wide: running it here would flush
		// every dirty component through save_unsaved_components as a side effect of
		// dismissing the dialog, and could raise a native confirm on top of it.
		// It can also return false, which leaves the modal open — a transient dialog
		// whose caller is awaiting a close must always be dismissable.
		if (this.transient!==true) {
			const result = await check_unsaved_data({
				confirm_msg : 'dd-modal: ' + (get_label.discard_changes || 'Discard unsaved changes?')
			});
			if (!result) {
				return false;
			}
		}

		this._modalVisible = false;
		this._modal.classList.remove('modal_show');

		// publish_close runs before on_close so event subscribers see the close
		// before the caller's own teardown logic fires.
		if (typeof this.publish_close === "function") {
			this.publish_close(this);
		}

		if (typeof this.on_close === 'function') {
			this.on_close(this);
			// Destroy the autocomplete overlay if one is open; leaving it alive
			// after the modal closes would leave a stale dropdown in the page.
			if (window.page_globals?.service_autocomplete) {
				window.page_globals.service_autocomplete.destroy(true, true, true);
			}
		}

		// (!) on_close is a single caller-owned slot that several components
		// overwrite wholesale, so the framework cannot rely on it. This event is
		// the unclobberable seam: ui.attach_to_modal listens on it for the teardown
		// that must run on every close (options.on_close, selection restore).
		this.dispatchEvent(new CustomEvent('dd-modal-close', {
			detail		: { modal : this },
			bubbles		: false,
			composed	: false
		}));

		// (!) The element owns its own detachment. It used to depend on the
		// caller-supplied on_close calling remove() — every caller that replaced
		// on_close left the modal mounted forever: three leaked document listeners,
		// a permanent window.modal_stack entry, and a truthy window.modal that
		// dead-ends the page-level Escape handler. Removing here fires
		// disconnectedCallback, which de-registers and unstacks.
		// No caller re-opens a closed modal — attach_to_modal builds a fresh one.
		if (this.isConnected) {
			this.remove();
		}

		return true;
	}

	/**
	 * CLOSE
	 * Public alias for _closeModal(). Exposed so external callers can close
	 * the modal programmatically with the same unsaved-data guard as UI triggers.
	 * @returns {Promise<boolean>} resolves to true on success, false if cancelled
	 */
	close() {
		return this._closeModal();
	}

	/**
	 * DETECT_KEY
	 * Document-level keyup handler. Closes the topmost modal on Escape (keyCode 27).
	 * Only one modal is closed per keypress — the last entry in window.modal_stack —
	 * so stacked modals are dismissed one at a time, outermost last.
	 * preventDefault() suppresses any browser default behavior tied to Escape
	 * (e.g. cancelling fullscreen or stopping page load).
	 * @param {KeyboardEvent} e - the keyup event from document
	 */
	detect_key(e) {
		if (e.keyCode === 27 && window.modal_stack?.length > 0) {
			const top_modal = window.modal_stack[window.modal_stack.length - 1];
			// (!) Each modal instance registers its own document keyup listener, so a
			// single Escape runs N listeners. Act ONLY from the top modal's own
			// listener: without this guard every listener called top_modal._closeModal(),
			// and since that method awaits check_unsaved_data before touching state,
			// all N continuations ran the full tail (publish_close + on_close × N).
			if (top_modal !== this) {
				return;
			}
			e.preventDefault();
			this._closeModal();
			return;
		}
	}

	/**
	 * GET_MODAL_NODE
	 * Returns the shadow .modal <div>, which is the full-screen overlay container.
	 * Used by callers that need to manipulate the overlay directly (e.g. removing
	 * the semi-transparent background by adding .remove_overlay).
	 * @returns {HTMLElement} the .modal shadow element
	 */
	get_modal_node() {
		return this._modal;
	}

	/**
	 * GET_MODAL_CONTENT
	 * Returns the shadow .modal-content <div>, which is the visible dialog box
	 * (contains header, body, footer). Callers use this to append custom content
	 * outside of the named-slot mechanism, or to inspect dialog dimensions.
	 * @returns {HTMLElement} the .modal-content shadow element
	 */
	get_modal_content() {
		return this.shadowRoot.querySelector(".modal-content");
	}

	/**
	 * _ONHEADERMOUSEDOWN
	 * Initiates drag mode when the user presses down inside .modal-header.
	 *
	 * Position pinning (first drag only):
	 *   CSS centers the dialog via `margin:auto` and `top:3.5vh`. Drag code reads
	 *   `style.left` / `style.top` as pixel offsets, which are empty strings until
	 *   set inline. Without pinning, the first drag jump would be large. The fix:
	 *   read the current rendered rect, convert to parent-relative pixels, set them
	 *   as inline styles, then switch `position` to `absolute` and clear `margin`.
	 *   The `.center` class is also removed so its `transform:translate` does not
	 *   shift the element away from the pinned position.
	 *
	 * Dragger detection uses e.composedPath() to walk the shadow+light DOM event
	 * path. The walk looks for a .dragger ancestor first, then checks whether the
	 * next ancestor is .draggable. This allows nested interactive elements inside
	 * the header to opt out of dragging (clicks on buttons inside the header will
	 * not find a .draggable after the .dragger boundary).
	 *
	 * drag_data is populated when a valid drag target is found:
	 *   target     — the .modal-content element to move
	 *   x / y      — cursor position minus current element offset (used in mousemove)
	 *   margin_left/top — computed margins for boundary clamping in mousemove
	 *
	 * @param {MouseEvent} e - the mousedown event from the .modal-header
	 */
	_onHeaderMousedown(e) {
		// (!) A minimized modal is not draggable and must NOT be pinned: .mini >
		// .modal-content is display:contents, so getBoundingClientRect() returns an
		// all-zero rect while parentElement is the 15rem × 60px bottom-right strip.
		// Pinning against that pair writes large negative left/top plus
		// position:absolute, and the dialog surfaces off-screen when restored.
		// The strip's whole clickable surface is the slotted header, whose mousedown
		// reaches this listener, so the case is trivially reachable.
		if (this.mini) {
			return;
		}

		// Pin current rendered position to inline styles before drag starts.
		// Without this, the modal jumps because CSS positions it (margin: auto, top: 3.5vh)
		// but the drag offset calc reads empty inline style.left/top as 0.
		if (!this.modal_content.style.left || !this.modal_content.style.top) {
			const rect = this.modal_content.getBoundingClientRect();
			const parentRect = this.modal_content.parentElement.getBoundingClientRect();

			// Pin current position
			this.modal_content.style.left = (rect.left - parentRect.left) + 'px';
			this.modal_content.style.top = (rect.top - parentRect.top) + 'px';

			// Remove margins, centering and set absolute position to prevent jumps
			// and ensure drag offsets are relative to the modal container.
			this.modal_content.style.position = 'absolute';
			this.modal_content.style.margin = '0';
			this.modal_content.classList.remove('center');
		}

		const path = e.composedPath();
		let clickedDragger = false;
		// bound the loop by path.length and skip nodes without classList (document,
		// window, text nodes): relying solely on `path[i] !== document` can run off
		// the end and dereference undefined.classList if document is not in the path.
		for (let i = 0; path[i] !== document; i++) {
			if (path[i].classList.contains('dragger')) {
				clickedDragger = true;
			}
			else if (clickedDragger === true && path[i].classList.contains('draggable')) {
				this.drag_data.target = path[i];
				this.drag_data.target.classList.add('dragging');
				this.drag_data.x = e.clientX - (parseInt(this.drag_data.target.style.left, 10) || 0);
				this.drag_data.y = e.clientY - (parseInt(this.drag_data.target.style.top, 10) || 0);

				const compStyles			= window.getComputedStyle(this.drag_data.target);
				this.drag_data.margin_left	= parseInt(compStyles.getPropertyValue('margin-left')) || 0;
				this.drag_data.margin_top	= parseInt(compStyles.getPropertyValue('margin-top')) || 0;

				return;
			}
		}
	}

	/**
	 * MOUSEMOVE
	 * Document-level mousemove handler. Translates the dragged .modal-content by
	 * updating its inline `style.left` and `style.top` based on the cursor position
	 * and the offset recorded in drag_data at mousedown.
	 *
	 * After each move, the element's bounding rect is compared to the parent's
	 * (the .modal overlay, which is full-screen) and clamped so the dialog cannot
	 * be dragged fully outside the viewport. Margin values from drag_data are
	 * subtracted from the clamped boundaries to account for any residual computed
	 * margins on .modal-content.
	 *
	 * No-ops if drag_data.target is null (no drag in progress).
	 * @param {MouseEvent} e - the mousemove event from document
	 */
	mousemove(e) {
		if (!this.drag_data || !this.drag_data.target) {
			return;
		}

		this.drag_data.target.style.left	= e.clientX - this.drag_data.x + 'px';
		this.drag_data.target.style.top		= e.clientY - this.drag_data.y + 'px';

		const pRect		= this.drag_data.target.parentElement.getBoundingClientRect();
		const tgtRect	= this.drag_data.target.getBoundingClientRect();
		if (tgtRect.left < pRect.left) {
			this.drag_data.target.style.left = (0 - this.drag_data.margin_left) + 'px';
		}
		if (tgtRect.top < pRect.top) {
			this.drag_data.target.style.top = (0 - this.drag_data.margin_top) + 'px';
		}
		if (tgtRect.right > pRect.right) {
			this.drag_data.target.style.left = (pRect.width - tgtRect.width - this.drag_data.margin_left) + 'px';
		}
		if (tgtRect.bottom > pRect.bottom) {
			this.drag_data.target.style.top = (pRect.height - tgtRect.height - this.drag_data.margin_top - 1) + 'px';
		}
	}

	/**
	 * MOUSEUP
	 * Document-level mouseup handler. Ends the current drag session by removing the
	 * .dragging class from the target (which restores the default cursor and
	 * re-enables text selection) and clearing drag_data.target so that subsequent
	 * mousemove events are no-ops.
	 * @param {MouseEvent} e - the mouseup event from document
	 */
	mouseup(e) {
		if (this.drag_data.target) {
			this.drag_data.target.classList.remove('dragging');
		}
		this.drag_data.target = null;
	}

	/**
	 * REMOVE_MINIMODAL
	 * Permanently removes the '_' minimize button from the Shadow DOM. Used when
	 * the caller decides that a particular modal instance should not be minimizable
	 * (e.g. blocking confirmation dialogs). The disconnectedCallback guard ensures
	 * that the removed node does not cause an error when de-registering its listener.
	 * After this call, _miniModal will never fire for this instance.
	 */
	remove_miniModal() {
		const mini_modal = this.shadowRoot.querySelector(".mini_modal");
		if (mini_modal) mini_modal.remove();
	}
}
customElements.define('dd-modal', DDModal);
}//end if (typeof HTMLElement!=='undefined')

// @license-end
