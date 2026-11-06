// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/

/**
* EVENTS
* Page-level event helpers for the Dédalo application shell.
*
* Responsibilities:
* - Bootstrap global DOM event listeners (visibilitychange, save) via events_init().
* - Derive the page-wide unsaved-data flag (window.unsaved_data) from the
*   unsaved-instances registry (register_unsaved_instance /
*   deregister_unsaved_instance / reset_unsaved_data), the uncommitted-typing
*   node registry (armed by the document-level 'input' listener in events_init,
*   for views that only commit on blur) plus the coarse instance-less
*   set_before_unload() assertion.
* - Provide DOM-readiness utilities (when_in_dom, when_in_viewport) used by
*   components such as maps and media players that require the node to be in
*   layout before they can initialise.
* - Expose scheduling helpers (dd_request_idle_callback, yield_to_main) that
*   defer low-priority work so the browser stays responsive during heavy renders.
* - Attach keyboard shortcuts and other global event bindings defined in tool
*   configuration objects via set_tool_event().
*
* - Expose read-only SNAPSHOTS of both registries (get_unsaved_instances,
*   uncommitted_nodes_snapshot) and a read-only VIEW of the ORPHANED-UNSAVED
*   set (orphaned_unsaved) for the row window's edit-safety pass
*   (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
*   addendum "edit-safety primitives"): a row may only be released/retired once
*   nothing in it is pending, and a dirty instance that outlives its row is
*   kept here until it is saved, superseded or the user discards it.
*
* Exports: events_init, set_before_unload, register_unsaved_instance,
*          deregister_unsaved_instance, register_uncommitted_input,
*          deregister_uncommitted_input, reset_unsaved_data,
*          get_unsaved_instances, uncommitted_nodes_snapshot, orphaned_unsaved,
*          claim_orphaned_unsaved_writers (a once-only capability),
*          when_in_dom, when_in_viewport, dd_request_idle_callback,
*          set_tool_event.
*          yield_to_main is a module-private helper (not exported).
*/

// import
	import {event_manager} from './event_manager.js'



/**
* unsaved_data set default
* Initialise the global flag only once; avoids overwriting state if the module
* is evaluated more than once in a multi-frame context.
*/
if (typeof window!=='undefined' && typeof window.unsaved_data==='undefined') {
	window.unsaved_data = false
}



/**
* UNSAVED-DATA REGISTRY
* (!) window.unsaved_data is DERIVED state: after module init its ONLY writer
* is update_unsaved_data() below. It used to be a single page-wide boolean
* assigned directly by every component, so ANY component could set it to false
* purely because ITS OWN current value matched its db_data snapshot
* (set_changed_data's revert branch) — silently disarming the unsaved-work
* guard for every OTHER dirty component on the page. Concretely: edit a
* debounced component_text_area, type-and-delete one character in a second
* field, close the tab — the text_area edit was dropped with no save, no
* prompt and no log line. Now each component instance registers itself while
* it holds a genuine unsaved change and can only deregister ITSELF (on
* revert, save success or destroy); the boolean is recomputed from the
* registry plus the coarse instance-less assertion, so one component's revert
* cannot disarm another's guard.
*/

// unsaved_instances. Component instances currently holding a genuine unsaved
// change, keyed by instance identity and driven by the EQUALITY VERDICT in
// component_common.set_changed_data (NOT by changed_data.length). A plain Set
// — a WeakSet cannot be counted — with explicit removal on instance teardown
// (common.js do_delete_self), so a destroyed dirty instance cannot pin the
// flag forever.
	const unsaved_instances = new Set()

// unsaved_asserted. The coarse instance-less "something is dirty" assertion,
// kept for callers that guard raw keystrokes without a component registration
// (view_default_edit_filter_records, view_default_edit_security_access) via
// set_before_unload(true). Cleared by set_before_unload(false) — called on
// every component save completion — and by reset_unsaved_data().
	let unsaved_asserted = false

// uncommitted_nodes. Edit-mode form fields the user is TYPING INTO RIGHT NOW,
// before the field committed its value to its component instance. Components
// only learn about an edit when their own commit event fires: component_text_area
// debounces on keystrokes (500ms) and therefore registers itself, but
// component_input_text (and every other view built on the native 'change' event:
// input_text line/colorpicker, select, date parts, …) commits ONLY on blur.
// Reloading or closing the tab does NOT blur the focused input in Chrome, so the
// component never registered, window.unsaved_data stayed false, and the typed
// text was dropped with no prompt — the exact data loss this registry exists to
// prevent. Keyed by the DOM node (identity), armed by the document-level 'input'
// listener in events_init and retired on 'change'/'focusout' (by then the
// component either registered itself as dirty or the value was back at db_data).
	const uncommitted_nodes = new Set()

// orphaned_unsaved_set. Component instances that still hold an unsaved change
// but whose ROW was torn down (released, retired or destroyed by the row
// window — engineering/wire_contract/WC-2026-10-30-section-record-row-box.md,
// addendum "edit-safety primitives"). component_common.orphan_unsaved_instance
// is the one door that adds to it (the writer capability): the orphan is spliced
// out of its caller's ar_instances (so no destroy cascade can deregister it)
// and removed from the instance cache (so a rebuilt row gets a FRESH instance
// from the server value and can never re-adopt the orphan with its stale
// caller). Because the orphan is no longer in the instance cache,
// save_unsaved_components sweeps THIS set as well as get_all_instances(). An
// orphan leaves it (the writer capability, component_common only) in exactly
// three ways — a successful save of its own, SUPERSESSION (a live instance of
// the same field sent a newer save, or the orphan has nothing left to send),
// or the user's explicit discard (reset_unsaved_data below) — and is destroyed
// then.
// (!) MODULE-PRIVATE. Other modules get the read-only view `orphaned_unsaved`
// (no add/delete/clear exists on it). The two writers are module-private too:
// they leave this module only as a capability handed out ONCE
// (claim_orphaned_unsaved_writers), which component_common.js claims at load —
// a second claimant throws (test/unit/component_settle_native.test.ts, W-legs).
	const orphaned_unsaved_set = new Set()

/**
* ORPHANED_UNSAVED
* Read-only view of orphaned_unsaved_set: membership, size and iteration only.
* A frozen object, so no caller can mutate the set through it.
*/
export const orphaned_unsaved = Object.freeze({
	has		: (instance) => orphaned_unsaved_set.has(instance),
	get size() { return orphaned_unsaved_set.size },
	values	: () => orphaned_unsaved_set.values(),
	[Symbol.iterator] : () => orphaned_unsaved_set.values()
})

/**
* PRUNE_UNCOMMITTED_NODES
* Drop entries whose node left the document (a save or a refresh re-renders the
* component and throws the old input away). Without this a detached node would
* pin the guard armed forever. Called from update_unsaved_data, so every
* recompute sees only live nodes.
*/
const prune_uncommitted_nodes = function() {

	if (uncommitted_nodes.size===0 || typeof document==='undefined' || !document.contains) {
		return
	}
	for (const node of uncommitted_nodes) {
		if (node && node.nodeType===1 && !document.contains(node)) {
			uncommitted_nodes.delete(node)
		}
	}
}//end prune_uncommitted_nodes



/**
* REGISTER_UNCOMMITTED_INPUT
* Arm the guard for a field being typed into whose value has not reached its
* component instance yet. Exported for tests and for any view that owns an
* editor the document-level listener cannot see (e.g. a shadow-DOM editor).
*
* @param {HTMLElement} node - The form field holding uncommitted typing
* @returns {boolean} The recomputed window.unsaved_data value (true here)
*/
export const register_uncommitted_input = function(node) {

	uncommitted_nodes.add(node)

	return update_unsaved_data()
}//end register_uncommitted_input



/**
* DEREGISTER_UNCOMMITTED_INPUT
* Retire ONE field's uncommitted-typing entry — its value just committed
* ('change') or it lost focus ('focusout'), so from here on the component
* instance registry owns the verdict. Never touches other entries.
*
* @param {HTMLElement} node - The form field to retire
* @returns {boolean} The recomputed window.unsaved_data value
*/
export const deregister_uncommitted_input = function(node) {

	uncommitted_nodes.delete(node)

	return update_unsaved_data()
}//end deregister_uncommitted_input



/**
* UPDATE_UNSAVED_DATA
* Recompute the derived window.unsaved_data boolean: true while at least one
* instance is registered as unsaved OR the coarse assertion is active.
* Every registry/assertion mutation funnels through here, so no code path can
* write the boolean behind the registry's back. Readers (page.js beforeunload,
* component_common check_unsaved_data, events_init) keep reading a plain
* boolean, unchanged.
*
* @returns {boolean} The recomputed window.unsaved_data value
*/
const update_unsaved_data = function() {

	prune_uncommitted_nodes()

	// (!) orphans count on their own: an orphan normally stays registered in
	// unsaved_instances too, but the guard must not depend on that coincidence —
	// an orphan IS an unsaved edit with no row left on screen.
	window.unsaved_data = (
		unsaved_instances.size > 0 ||
		uncommitted_nodes.size > 0 ||
		orphaned_unsaved_set.size > 0 ||
		unsaved_asserted===true
	)

	return window.unsaved_data
}//end update_unsaved_data



/**
* REGISTER_UNSAVED_INSTANCE
* Mark the given component instance as holding a genuine unsaved change (its
* current value differs from its db_data snapshot, per the is_equal verdict
* in component_common.set_changed_data) and re-derive window.unsaved_data.
* Registering an already registered instance is a no-op (Set semantics).
*
* @param {Object} instance - The component instance with unsaved data
* @returns {boolean} The recomputed window.unsaved_data value (true here)
*/
export const register_unsaved_instance = function(instance) {

	unsaved_instances.add(instance)

	return update_unsaved_data()
}//end register_unsaved_instance



/**
* DEREGISTER_UNSAVED_INSTANCE
* Retire the given instance's own unsaved registration — because its value is
* back to the db_data snapshot, its save succeeded, or it is being destroyed —
* and re-derive window.unsaved_data. (!) This only ever removes the CALLER'S
* entry: other registered instances keep the guard armed, which is the whole
* point of the registry (see the header above). An unregistered instance is a
* no-op.
*
* @param {Object} instance - The component instance to deregister
* @returns {boolean} The recomputed window.unsaved_data value
*/
export const deregister_unsaved_instance = function(instance) {

	unsaved_instances.delete(instance)

	return update_unsaved_data()
}//end deregister_unsaved_instance



/**
* RESET_UNSAVED_DATA
* Clear the WHOLE registry and the coarse assertion, then re-derive
* window.unsaved_data (false). This is the deliberate page-wide reset for
* check_unsaved_data's ONE resolution: "the user explicitly accepted losing
* the remaining changes". (The auto-save sweep does NOT reset: each save
* retires its own entry, and what remains was not flushed.) Nothing else may
* clear state it does not own.
*
* ORPHANS (orphaned_unsaved) are part of "the remaining changes": they are
* dropped from the set and DESTROYED here — nothing else holds them (they left
* their caller's ar_instances and the instance cache when they were orphaned),
* so without this sweep a discarded orphan would leak for the page's lifetime.
* The destroy is asynchronous and not awaited (this reset is synchronous for
* all its callers); a failing destroy is reported, never thrown.
*
* @returns {boolean} The recomputed window.unsaved_data value (false here)
*/
export const reset_unsaved_data = function() {

	const orphans = [...orphaned_unsaved_set]

	unsaved_instances.clear()
	uncommitted_nodes.clear()
	orphaned_unsaved_set.clear()
	unsaved_asserted = false

	// destroy the discarded orphans (their edit is the one the user accepted to lose)
	for (const orphan of orphans) {
		if (orphan && typeof orphan.destroy==='function' && orphan.status!=='destroyed') {
			Promise.resolve()
				.then(() => orphan.destroy(true, true, false))
				.catch((error) => {
					console.error('[events] reset_unsaved_data: could not destroy a discarded orphan', orphan?.id, error)
				})
		}
	}

	return update_unsaved_data()
}//end reset_unsaved_data



/**
* GET_UNSAVED_INSTANCES
* Snapshot of the component instances currently registered as holding a
* genuine unsaved change. An ARRAY COPY: callers (the row window's pinning and
* flush passes, component_common.settle) iterate it while saves retire
* entries, and must never be able to mutate the registry through it.
*
* @returns {Array<Object>} The registered instances (copy)
*/
export const get_unsaved_instances = function() {

	return [...unsaved_instances]
}//end get_unsaved_instances



/**
* ADD_ORPHANED_UNSAVED (module-private)
* Writer door of orphaned_unsaved_set. Reached only through the capability
* claim_orphaned_unsaved_writers hands out (component_common.js holds it).
* Re-derives window.unsaved_data: an orphan is an unsaved edit on its own.
*
* @param {Object} instance - The orphaned component instance
* @returns {boolean} The recomputed window.unsaved_data value (true here)
*/
const add_orphaned_unsaved = function(instance) {

	orphaned_unsaved_set.add(instance)

	return update_unsaved_data()
}//end add_orphaned_unsaved



/**
* DELETE_ORPHANED_UNSAVED (module-private)
* Writer door of orphaned_unsaved_set: an orphan was released (its save
* succeeded) or superseded. Reached only through the capability (see
* claim_orphaned_unsaved_writers); the caller destroys the instance.
* Re-derives window.unsaved_data.
*
* @param {Object} instance - The orphan to drop
* @returns {boolean} true when the instance was an orphan
*/
const delete_orphaned_unsaved = function(instance) {

	const was_orphan = orphaned_unsaved_set.delete(instance)
	update_unsaved_data()

	return was_orphan
}//end delete_orphaned_unsaved



// orphaned_unsaved_writers_claimed. The writer capability is handed out ONCE.
	let orphaned_unsaved_writers_claimed = false

/**
* CLAIM_ORPHANED_UNSAVED_WRITERS
* THE one way to obtain the orphaned_unsaved_set writers: a frozen
* {add, delete} capability, handed out exactly ONCE per page (per module
* instance). component_common.js claims it while it is evaluated, so any later
* claim — from a tool, a view, anything — THROWS; and a module that claimed it
* first makes component_common.js throw at load. Either way a second writer is
* loud, whatever spelling (alias, namespace, bracket access) it reaches the
* export through. Gate: test/unit/component_settle_native.test.ts (W-legs).
*
* @returns {{add: function(Object): boolean, delete: function(Object): boolean}}
* @throws {Error} when the capability was already claimed
*/
export const claim_orphaned_unsaved_writers = function() {

	if (orphaned_unsaved_writers_claimed===true) {
		throw new Error('[events] the orphaned_unsaved writers were already claimed (component_common.js owns them)')
	}
	orphaned_unsaved_writers_claimed = true

	return Object.freeze({
		add		: add_orphaned_unsaved,
		delete	: delete_orphaned_unsaved
	})
}//end claim_orphaned_unsaved_writers



/**
* UNCOMMITTED_NODES_SNAPSHOT
* Snapshot of the form fields being typed into whose value has not reached
* its component instance yet (see uncommitted_nodes above). Pruned first, so
* only nodes still in the document are listed. An ARRAY COPY, taken by the row
* window BEFORE it dispatches a synthetic 'change' — the document-level capture
* listener (events_init commit_handler) removes a node from the live Set on
* EVERY 'change', so the live Set cannot be iterated across a dispatch.
*
* @returns {Array<HTMLElement>} The uncommitted nodes (copy)
*/
export const uncommitted_nodes_snapshot = function() {

	prune_uncommitted_nodes()

	return [...uncommitted_nodes]
}//end uncommitted_nodes_snapshot



/**
* EVENTS_INIT  (!) WORK IN PROGRESS
* Attach global document-level event listeners at application startup.
*
* Called once from the main page initialisation (/page/index.html). Registers:
* - A 'visibilitychange' listener to detect tab-switch with unsaved changes
*   (the await-save path is stubbed, pending full implementation).
* - A subscription to the 'save' event_manager channel so this module can react
*   when any component successfully persists its data.
*
* (!) This function is intentionally incomplete. The visibilitychange handler
* currently does nothing when unsaved_data is true — the real save-on-hide flow
* is deferred.
*
* @returns {boolean} Always returns true after listeners are attached.
*/
export const events_init = function() {

	// (!) WORK IN PROGRESS

	// add visibility change to control if the user change the tab without save
		const visibility_change = async () => {

			if (document.visibilityState==='hidden' && window.unsaved_data===true) {
				// await saving
			}
		}
		document.addEventListener('visibilitychange', visibility_change);

	// uncommitted typing guard (data-loss protection)
	// Document-level, capture phase, so ONE pair of listeners covers every
	// edit-mode field of every component — including the ones whose views only
	// commit on the native 'change' event (blur). Reload/close does not blur, so
	// without this the typed-but-not-blurred value was lost silently.
		const is_guarded_edit_field = (node) => {

			if (!node || node.nodeType!==1 || typeof node.closest!=='function') {
				return false
			}
			// only real editors, and never a disabled/read-only one
			const tag = node.tagName
			const is_editor = tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT' ||
							  node.isContentEditable===true
			if (!is_editor || node.disabled===true || node.readOnly===true) {
				return false
			}
			// only fields inside a component rendered in EDIT mode: search forms,
			// list filters and tool inspectors are not unsaved record data.
			// (!) The NEAREST component wrapper decides, not the nearest EDIT one:
			// an autocomplete/search field nested inside an edit-mode portal sits
			// in its own search-mode wrapper and is NOT record data — matching
			// '.wrapper_component.edit' directly would skip past it and arm the
			// guard on every keystroke of a lookup box.
			// The relation lookup box (service_autocomplete) is rendered straight
			// into the edit-mode portal wrapper: its query is never record data.
			if (node.closest('.wrapper_service_autocomplete')!==null) {
				return false
			}
			const wrapper = node.closest('.wrapper_component')
			return wrapper!==null && wrapper.classList.contains('edit')
		}
		const input_handler = (e) => {
			if (is_guarded_edit_field(e.target)) {
				register_uncommitted_input(e.target)
			}
		}
		const commit_handler = (e) => {
			// 'change' → the view's own handler (running after this capture-phase
			// listener) hands the verdict to the component registry;
			// 'focusout'  → covers type-then-revert, where 'change' never fires.
			deregister_uncommitted_input(e.target)
		}
		document.addEventListener('input', input_handler, {capture: true})
		document.addEventListener('change', commit_handler, {capture: true})
		document.addEventListener('focusout', commit_handler, {capture: true})

	// save
		const save_handler = (result) => {
			if(SHOW_DEBUG===true) {
				console.log('events_init save result:', result)
			}
			// saved = true
		}
		event_manager.subscribe('save', save_handler)


	return true
}//end events_init



/**
* SET_BEFORE_UNLOAD
* Toggle the coarse instance-less unsaved-data assertion and re-derive
* window.unsaved_data.
*
* (!) This no longer assigns window.unsaved_data directly: the flag is DERIVED
* (see the unsaved-data registry above), so set_before_unload(false) clears
* only the coarse assertion — it CANNOT disarm the guard while component
* instances are still registered as dirty. Components no longer call this for
* their own edit state (they register/deregister themselves via
* register_unsaved_instance / deregister_unsaved_instance); the remaining
* callers are keystroke guards with no component registration
* (view_default_edit_filter_records, view_default_edit_security_access) with
* true, and component_common.save() with false once a save completed. The flag
* stays on window.unsaved_data so other parts of the application (e.g.
* events_init's visibilitychange handler) can read it without importing this
* module.
*
* The beforeunload listener block is currently commented out (see dead code below);
* only the derived flag is maintained. When the listener is re-enabled it will
* show the browser's native "leave page?" dialog on navigation while unsaved
* data exists.
*
* @param {boolean} value - true to assert unsaved changes exist outside any
*   component registration; false to retract that assertion.
* @returns {boolean|undefined} The recomputed window.unsaved_data value when the
*   assertion changed; undefined when it already matched value (no-op fast path).
*/
export const set_before_unload = function(value) {
	if(SHOW_DEBUG===true) {
		console.warn("///////////////////// set_before_unload value:", value);
	}

	// already fixed current value (true/false)
		if (value===unsaved_asserted) {
			return
		}

	// fix value. The derived window.unsaved_data is recomputed at the return below
		unsaved_asserted = value

	// add/remove listener
		// if (value===true) {
		// 	// window dialog will be shown when user leaves the page
		// 	addEventListener('beforeunload', before_unload_listener, {capture: true});
		// 	// window.unsaved_data = true
		// }else if(value===false){
		// 	// restore the normal page exit status
		// 	removeEventListener('beforeunload', before_unload_listener, {capture: true});
		// 	// window.unsaved_data = false
		// }

	return update_unsaved_data()
}//end set_before_unload



/**
* BEFORE_UNLOAD_LISTENER  (dead code — disabled, kept for future re-activation)
* Intercept the browser's beforeunload event when unsaved changes are present.
*
* Sets event.returnValue to trigger the native "leave page?" confirmation dialog.
* Falls back to a hardcoded English string if the localised label is unavailable.
* Re-enable by restoring the listener registration inside set_before_unload above.
*
* @param {BeforeUnloadEvent} event - The native beforeunload event.
*/
	// const before_unload_listener = function(event) {
	// 	event.preventDefault();

	// 	// document.activeElement.blur()
	// 	if (window.unsaved_data===false) {
	// 		return
	// 	}

	// 	return event.returnValue = get_label.discard_changes || 'Discard unsaved changes?';
	// }//end before_unload_listener




// pending registry: node -> array of callbacks awaiting that node's insertion
	const when_in_dom_pending = new Map()

// shared observer: lazily created, disconnected whenever the registry is empty
	let when_in_dom_observer = null

/**
* WHEN_IN_DOM_CHECK_PENDING
* Shared-observer callback: on each mutation batch, sweep the pending registry
* ONCE, fire and remove the entries whose node is now in the document, and
* disconnect the observer when nothing remains pending. A throwing callback is
* isolated (try/catch + console.error) so it cannot block the other pending
* callbacks or corrupt the registry.
*/
const when_in_dom_check_pending = function() {

	for (const [node, callbacks] of when_in_dom_pending) {
		if (document.contains(node)) {
			// remove BEFORE firing so a callback that mutates the DOM
			// (triggering a re-entrant batch) cannot fire the entry twice
			when_in_dom_pending.delete(node)
			const callbacks_length = callbacks.length
			for (let i = 0; i < callbacks_length; i++) {
				try {
					callbacks[i]()
				} catch (error) {
					console.error('when_in_dom callback error. node:', node, error);
				}
			}
		}
	}

	// disconnect when idle; re-connected by the next deferred registration
	if (when_in_dom_pending.size===0 && when_in_dom_observer) {
		when_in_dom_observer.disconnect()
	}
}//end when_in_dom_check_pending



/**
* WHEN_IN_DOM
* Execute a callback the first time the given node is attached to the document.
*
* Many third-party components (Leaflet maps, canvas renderers, media players)
* must query layout metrics that are only available once the element is part of
* the live DOM. This helper either fires the callback immediately (if the node
* is already present) or defers until a shared MutationObserver detects insertion.
*
* All deferred registrations share ONE module-level MutationObserver watching the
* document subtree (a per-call observer made a 200-row list render quadratic:
* every observer was notified of every mutation of the same render). The shared
* observer is created lazily on the first pending registration and disconnected
* as soon as the pending registry empties; it re-connects on the next pending
* registration. Registering the same node twice with different callbacks fires
* both. Fired entries are removed immediately; a node that is NEVER inserted
* into the document stays pending (and retained) by design — exactly as the old
* per-call observer did — so only register nodes that will be attached.
*
* @param {HTMLElement} node - The element to watch for DOM insertion.
* @param {Function} callback - Called with no arguments once the node is in the DOM.
*   When the node is already present, the callback's own return value is forwarded.
* @returns {*} The callback's return value when the node was already in the DOM;
*   undefined when deferred. (Previously returned the per-call MutationObserver;
*   no caller used it and it no longer exists.)
*/
export const when_in_dom = function(node, callback) {

	if (document.contains(node)) {
		return callback()
	}

	// register pending callback (same node may accumulate several callbacks)
		const existing = when_in_dom_pending.get(node)
		if (existing) {
			existing.push(callback)
			return
		}
		when_in_dom_pending.set(node, [callback])

	// (re)connect the shared observer. Calling observe() again on an already
	// observing observer with the same target/options is a no-op, so this is
	// safe on every first-registration-after-idle path.
		if (!when_in_dom_observer) {
			when_in_dom_observer = new MutationObserver(when_in_dom_check_pending)
		}
		when_in_dom_observer.observe(document, {attributes: false, childList: true, characterData: false, subtree:true});
}//end when_in_dom



/**
* WHEN_IN_VIEWPORT
* Execute a callback whenever the given node enters the visible viewport.
*
* Uses IntersectionObserver with a threshold of 0, meaning the callback fires
* as soon as even one pixel of the element becomes visible. The callback receives
* the matching IntersectionObserverEntry so callers can inspect intersection
* geometry (e.g. for analytics or progressive loading).
*
* By default (once=true) the observer disconnects after the first intersection,
* making this a one-shot "lazy init" trigger. Pass once=false to keep observing
* for repeated visibility changes (e.g. scroll-driven animations).
*
* The callback is deferred through requestAnimationFrame so the DOM has settled
* and layout properties are safe to read.
*
* @param {HTMLElement} node - The element to observe. Must be an HTMLElement instance.
* @param {Function} callback - Invoked with the IntersectionObserverEntry on visibility.
* @param {boolean} [once=true] - When true, disconnect after the first intersection.
* @param {object} [observer_options={}] - Extra IntersectionObserver options merged over
*   the defaults (e.g. `{ rootMargin: '200px' }` to preload before the node is visible).
* @throws {Error} When node is not an HTMLElement instance.
* @returns {IntersectionObserver|undefined} The active observer, or undefined when callback is invalid.
*/
export const when_in_viewport = function(node, callback, once=true, observer_options={}) {

	if (!(node instanceof HTMLElement)) {
		throw new Error("Invalid node passed to when_in_viewport");
	}

	if (typeof callback !== 'function') {
		console.warn("when_in_viewport: callback is not a function");
		return;
	}

	// observer. Exec the callback when element is in viewport
	const observer = new IntersectionObserver(
		function(entries, observer) {

			const entry = entries[0]
			if (entry.isIntersecting || entry.intersectionRatio > 0) {

				// default is true (executes the callback once)
				if (once) {
					observer.disconnect();
				}

				// Execute callback with proper context
				window.requestAnimationFrame(() => callback(entry));
			}
		},
		{
			rootMargin: '0px',
			threshold: [0],
			...observer_options
		}
	);
	observer.observe(node);


	return observer
}//end when_in_viewport



/**
* LAZY_IN_VIEWPORT
* Convenience wrapper over when_in_viewport with a uniform 200px preload margin,
* so heavy lazily-initialised content (media, json/leaflet/ckeditor editors)
* starts loading just before it becomes visible and feels instant on scroll.
* Shared by media and non-media components to keep the preload margin in one place.
*
* @param {HTMLElement} node - The element to observe.
* @param {Function} on_enter - Invoked once when the node nears the viewport.
* @returns {IntersectionObserver|undefined} The active observer.
*/
export const lazy_in_viewport = function(node, on_enter) {
	return when_in_viewport(node, on_enter, true, { rootMargin: '200px' })
}//end lazy_in_viewport



/**
* FADE_IN_ON_REVEAL
* Generic smooth fade-in for lazily-initialised content (media, json/leaflet/
* ckeditor editors, ...). Adds the `.lazy_fade` class (defined in layout.less) so
* the container starts invisible, and returns a `reveal` function the caller
* invokes once the content is ready (on load / ready / error) to fade it in.
* Centralises what used to be duplicated inline opacity/transition assignments.
*
* @param {HTMLElement} container - The element to fade in.
* @returns {Function} reveal - Call to fade the container in.
*/
export const fade_in_on_reveal = function(container) {
	container.classList.add('lazy_fade')
	return () => container.classList.add('is_loaded')
}//end fade_in_on_reveal



/**
* DD_REQUEST_IDLE_CALLBACK
* Schedule a callback for execution during the browser's idle periods.
*
* Wraps the native requestIdleCallback API with a cross-browser fallback:
* when requestIdleCallback is unavailable (Safari as of early 2024), the
* callback is queued via requestAnimationFrame so it runs at the next paint
* boundary rather than truly idle time. A timeout of 1000 ms is passed to
* requestIdleCallback to guarantee the callback runs even on a busy main thread.
*
* Use this for background, low-priority work that should not interfere with
* animations or user input — for example, pre-computing search indices or
* flushing non-critical log entries.
*
* @param {Function} callback - The function to invoke during an idle period.
*   When called via the native API it receives an IdleDeadline argument;
*   the requestAnimationFrame fallback passes a DOMHighResTimeStamp instead.
* @returns {void}
*/
export const dd_request_idle_callback = function (callback) {

	if (typeof window.requestIdleCallback === 'function') {
		// Use requestIdleCallback to schedule work if available
		requestIdleCallback(callback, { timeout: 1000 })
	} else {
		// Fallback for browsers without requestIdleCallback support (e.g. older Safari).
		// (!) Use setTimeout (a macrotask) instead of requestAnimationFrame so the work
		// is deferred OFF the animation frame: it then runs AFTER the rAF-batched CSS
		// flush (see css.js) instead of interleaving with it. Pass a minimal deadline
		// object to keep the requestIdleCallback contract for callbacks that read it.
		setTimeout(function () {
			callback({
				didTimeout		: false,
				timeRemaining	: function () { return 50 }
			})
		}, 1)
	}
}//end dd_request_idle_callback



/**
* YIELD_TO_MAIN
* Yield control back to the browser's main thread inside a long-running async task.
*
* Breaks up long-running work into smaller chunks so the browser can process user
* input and paint frames between chunks, keeping the UI responsive. Call with
* `await yield_to_main()` at natural breakpoints in loops or sequential operations.
*
* Uses the Prioritized Task Scheduling API (scheduler.yield) when available
* (Chromium 115+). Falls back to a zero-timeout Promise on Safari and Firefox,
* which achieves the same task-queue handoff at the cost of true priority hints.
*
* (!) This function is module-private. It is not exported because callers should
* await it inline; there is no need to pass it as a reference.
*
* @see https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield#browser_compatibility
* @see https://web.dev/articles/optimize-long-tasks?utm_source=devtools
* @returns {Promise<void>} Resolves after the browser has had a chance to run
*   other queued tasks.
*/
function yield_to_main () {
	if (globalThis.scheduler?.yield) {
		return scheduler.yield()
	}

	// Fall back to yielding with setTimeout.
	return new Promise(resolve => {
		setTimeout(resolve, 0);
	})
}//end yield_to_main



/**
* SET_TOOL_EVENT
* Bind a keyboard (or other DOM) shortcut defined in a tool's configuration to
* its toolbar button, so the user can trigger the tool without clicking.
*
* The binding is declared in the tool's ontology JSON under a `tool_event` key:
*
*   {
*     "type": "keyup",
*     "validate": [
*       { "key": "ctrlKey", "value": true },
*       { "key": "key",     "value": "s"  }
*     ],
*     "action": "click"
*   }
*
* Each entry in `validate` checks that a named property on the KeyboardEvent (or
* other event type) matches the expected value. All conditions must pass for the
* action to fire. This makes multi-modifier shortcuts (Ctrl+Shift+S, etc.) easy
* to express without bespoke code per tool.
*
* The handler registers itself on the document and performs a self-cleanup check
* on every invocation: if tool_button is no longer connected to the DOM (e.g. the
* tool panel was closed), the listener is removed automatically, preventing leaks.
*
* Currently the only supported `action` is 'click', which programmatically clicks
* the button element. Unknown actions emit a console warning.
*
* @param {Object} options - Configuration object with the following shape:
*   @param {Object}      options.tool_event  - Event descriptor (type, validate, action).
*   @param {HTMLElement} options.tool_button  - The toolbar button to click on match.
* @returns {boolean} Always true after the document listener has been attached.
*/
export const set_tool_event = function (options) {

	// options
		const tool_event	= options.tool_event
		const tool_button	= options.tool_button

	// tool_event
		// tool_event sample:
		// {
		//   "type": "keyup",
		//   "validate": [
		// 	{
		// 	  "key": "ctrlKey",
		// 	  "value": true
		// 	},
		// 	{
		// 	  "key": "key",
		// 	  "value": "s"
		// 	}
		//   ]
		// }
		const type		= tool_event.type // as keyup
		const validate	= tool_event.validate || [] // array o validations
		const action	= tool_event.action

	// event_handler
		const event_handler = (e) => {
			e.preventDefault()

			// if button is not connected to the DOM, remove the event
			if (!tool_button.isConnected) {
				document.removeEventListener(type, event_handler)
				return
			}

			// validations
			const validate_length = validate.length
			for (let i = 0; i < validate_length; i++) {
				const item = validate[i]
				if (e[item.key]!==item.value) {
					// stop here
					return
				}
			}

			switch (action) {

				case 'click':
					tool_button.click()
					break;

				default:
					console.warn('Undefined action. options:', options);
					break;
			}
		}

	// listener
	document.addEventListener(type, event_handler)


	return true
}//end set_tool_event



// @license-end
