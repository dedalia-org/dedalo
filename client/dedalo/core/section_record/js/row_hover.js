// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * ROW_HOVER — the lazy hover overlay of a mosaic row (portal and tool mosaics)
 *
 * A mosaic tile shows a reduced set of columns; hovering it shows an overlay
 * (`.sr_mosaic_hover`) with the `hover` columns, editable in place. Until the
 * row-box redesign every tile built its overlay record up front; now ONE
 * delegated controller per `content_data` builds it on demand
 * (WC-2026-10-30-section-record-row-box):
 *
 *   delegate_row_hover({caller, content_data, signal, render_hover, slot})
 *
 * - One `pointerover` / `pointerleave` / `focusout` set on `content_data`,
 *   registered with the row window's `signal` (aborted on retire / destroy).
 *   The row is resolved with record_window's `row_of`, never a
 *   `closest('.section_record')`.
 * - `render_hover(index)` → Promise<{instance, node}> builds and renders the
 *   overlay record through section.js `build_section_record_for` (never
 *   get_section_records). `node` IS the overlay box: the hover record's own
 *   node is enough (no extra wrapper; the ontology's tile-overlay selectors
 *   key on `.section_record >.sr_mosaic_hover`, WC-2026-10-30-section-record-row-box).
 *   The controller prepends `node` (marked
 *   `.sr_mosaic_hover`) to the row node and registers the instance in
 *   `caller.ar_instances` (caller = the portal, so the window's in_row pins
 *   never see it). AT MOST ONE live hover instance per content_data.
 * - The controller holds `{index, instance}` — never a node. The overlay is
 *   found again as the row's direct `.sr_mosaic_hover` child.
 * - THE HOVER CONTROLLER OWNS THE OVERLAY EDITORS, NEVER THE WINDOW. Their
 *   nodes sit inside the row while their instances are not in_row, so the
 *   window skips them (edit_safety.owned_elsewhere) and every path that commits
 *   a window's rows runs this controller's `flush()` FIRST: the owner row lock
 *   (common.lock_rows), the door's retire, the owner destroy
 *   (common.destroy_row_windows).
 *
 * flush() → Promise<{failed, pending}> = the record window's edit-safety steps
 *   (a)-(c) on the overlay subtree, with in_row replaced by in_hover (walk
 *   `x.caller` up to IN_HOVER_MAX_DEPTH and reach the live hover instance):
 *   (a) the active component in the overlay: deactivate, then settle;
 *   (b) commit the overlay's uncommitted editor nodes: snapshot BEFORE any
 *       dispatch, read commit_seq, dispatch change + blur, PENDING iff the
 *       instance does not resolve in_hover or its commit_seq did not advance
 *       (never judged by Set membership); a pending node is re-registered;
 *   (c) settle every in_hover unsaved instance and every committed one.
 *   Nothing is destroyed by a flush.
 *
 * TEARDOWN of the live instance (next hover, pointerleave): flush first.
 *   - a PENDING node defers the teardown (pending-node rule): the instance and
 *     its overlay stay (CSS keeps an overlay with :focus-within visible), no
 *     next hover is rendered, and the teardown is retried on the next
 *     pointerleave / focusout of that overlay; a focusout retry that resolves
 *     while the pointer is on another tile shows THAT tile's overlay (its
 *     pointerover was consumed while deferred and does not repeat);
 *   - an instance still dirty after settle is ORPHANED (edit_safety.orphan),
 *     never destroyed; the rest of the overlay record is destroyed.
 *   A render that loses a race (the pointer moved on, the row was replaced,
 *   the controller died) is discarded: it was never inserted, so it holds no
 *   edit.
 *
 * destroy() → Promise<{failed, pending}>: the owner-side teardown (door
 *   supersession, owner destroy). It cannot be refused: a pending node is
 *   returned for the caller to log (log_pending_rows) and the teardown runs.
 *
 * The edit-safety bindings are section.js `row_edit_safety`, the same object
 * the door hands every record window.
 */

import {row_of} from './record_window.js'
import {row_edit_safety} from '../../section/js/section.js'



/**
 * HOVER_OVERLAY_CLASS
 * The overlay box class. section.js row_edit_safety.owned_elsewhere keys on it.
 * @type {string}
 */
export const HOVER_OVERLAY_CLASS = 'sr_mosaic_hover'

/**
 * IN_HOVER_MAX_DEPTH
 * How many `caller` steps in_hover walks (same bound as record_window in_row).
 * @type {number}
 */
const IN_HOVER_MAX_DEPTH = 32



/**
* DELEGATE_ROW_HOVER
* Install the lazy hover controller of one content_data and store it as
* `caller.row_hovers[slot]` (the slot of the row window it decorates). A
* controller already in that slot is torn down (its pending is logged).
* @param {Object} options
* @param {Object} options.caller - The portal / tool view instance that owns the rows
* @param {HTMLElement} options.content_data - The row window's container
* @param {AbortSignal} options.signal - The row window's signal
* @param {Function} options.render_hover - async (index) → {instance, node}|null
* @param {string} [options.slot='rows'] - The window slot it decorates
* @returns {Object|null} The controller
*/
export const delegate_row_hover = function(options) {

	const caller		= options.caller
	const content_data	= options.content_data
	const signal		= options.signal
	const render_hover	= options.render_hover
	const slot			= options.slot || 'rows'
	const edit_safety	= row_edit_safety

	if (!caller || !content_data || typeof render_hover!=='function') {
		console.error('Error: delegate_row_hover requires a caller, a content_data and a render_hover');
		return null
	}

	const view = (content_data.ownerDocument && content_data.ownerDocument.defaultView) || globalThis

	// state
		let current		= null	// {index, instance} of the live hover instance
		let deferred	= false	// the live instance's teardown waits for a pending node
		let dead		= false	// destroyed / signal aborted: nothing new is rendered
		let wanted		= null	// the index the pointer is on now (race guard)
		let queue		= Promise.resolve()

	/** Serialize every step: one render / flush / teardown at a time. */
	const run = (step) => {
		const result = queue.then(step)
		queue = result.catch((error) => {
			console.error('[row_hover] step failed:', error);
		})
		return result
	}

	/** x is the live hover instance or reaches it through its caller chain. */
	const in_hover = (x) => {
		const hover_instance = current?.instance
		if (!hover_instance) {
			return false
		}
		let node = x
		for (let depth = 0; node && depth <= IN_HOVER_MAX_DEPTH; depth++) {
			if (node===hover_instance) {
				return true
			}
			node = node.caller
		}
		return false
	}

	/** The overlay box of row `index` (its direct .sr_mosaic_hover child). */
	const overlay_of = (index) => {
		const row = content_data.children[index]
		if (!row) {
			return null
		}
		for (const child of Array.from(row.children)) {
			if (child.classList.contains(HOVER_OVERLAY_CLASS)) {
				return child
			}
		}
		return null
	}

	/**
	 * FLUSH_CURRENT
	 * Edit-safety steps (a)-(c) on the live overlay. Never destroys anything.
	 * @returns {Promise<{failed: Array, pending: Array<{node, instance, index}>}>}
	 */
	const flush_current = async () => {
		const failed	= []
		const pending	= []
		if (!current) {
			return { failed, pending }
		}
		const index		= current.index
		const settled	= new Set()

		// (a) the active component in the overlay: deactivate, then settle
		const active = edit_safety.component_active()
		if (active && in_hover(active)) {
			await edit_safety.deactivate(active)
			settled.add(active)
			if (await edit_safety.settle(active)!==true) {
				failed.push(active)
			}
		}

		// (b) commit the overlay's uncommitted editor nodes (snapshot first:
		// the events.js capture listener drops a node on every change)
		const committed	= new Set()
		const overlay	= overlay_of(index)
		if (overlay) {
			const snapshot = edit_safety.uncommitted_nodes()
			for (const node of snapshot) {
				if (!node || !overlay.contains(node)) {
					continue
				}
				const wrapper	= typeof node.closest==='function' ? node.closest('.wrapper_component') : null
				const instance	= edit_safety.instance_of_node(wrapper)
				const resolved	= !!(instance && in_hover(instance))
				const seq_before = resolved ? edit_safety.commit_seq(instance) : null
				node.dispatchEvent(new view.Event('change', { bubbles : true }))
				node.dispatchEvent(new view.Event('blur'))
				const advanced = resolved && edit_safety.commit_seq(instance) > seq_before
				if (advanced) {
					committed.add(instance)
				}else{
					// its value lives only in the node: keep the guard counting it
					edit_safety.register_uncommitted(node)
					pending.push({ node : node, instance : instance || null, index : index })
				}
			}
		}

		// (c) settle every in-overlay unsaved instance and every committed one
		const to_settle = new Set(committed)
		for (const instance of edit_safety.unsaved_instances()) {
			if (in_hover(instance)) {
				to_settle.add(instance)
			}
		}
		for (const instance of to_settle) {
			if (settled.has(instance)) {
				continue
			}
			settled.add(instance)
			if (await edit_safety.settle(instance)!==true) {
				failed.push(instance)
			}
		}

		return { failed, pending }
	}

	/**
	 * TEARDOWN
	 * Flush, then remove the live overlay. `force` (owner side) never defers.
	 * @param {boolean} force
	 * @returns {Promise<{failed: Array, pending: Array}>}
	 */
	const teardown = async (force) => {
		if (!current) {
			return { failed : [], pending : [] }
		}
		const flushed = await flush_current()
		if (flushed.pending.length > 0 && !force) {
			// pending-node rule: the overlay stays until the node commits
			deferred = true
			return flushed
		}
		const { index, instance } = current
		current		= null
		deferred	= false
		// still dirty after settle: orphaned, never destroyed
		for (const dirty of flushed.failed) {
			edit_safety.orphan(dirty)
		}
		const overlay = overlay_of(index)
		if (overlay) {
			overlay.remove()
		}
		if (instance && instance.status!=='destroyed' && typeof instance.destroy==='function') {
			await instance.destroy(true, true, false)
		}
		return flushed
	}

	/**
	 * RELEASE_WANTED
	 * A show of `index` that ends WITHOUT an overlay (render failed or returned
	 * nothing, the row was replaced or is a placeholder, no node) forgets that
	 * the tile is wanted: the pointerover guard (`row.index===wanted`) would
	 * otherwise drop every later pointerover on it, and the tile under the
	 * pointer would never get its overlay. Only when it still names `index` — a
	 * newer pointerover owns any other value.
	 * @param {number} index
	 */
	const release_wanted = (index) => {
		if (wanted===index) {
			wanted = null
		}
	}

	/**
	 * SHOW
	 * Make row `index` the live hover: tear the previous one down (unless
	 * deferred), render, and insert only if nothing moved meanwhile.
	 */
	const show = async (index) => {
		if (dead || (current && current.index===index)) {
			return
		}
		if (current) {
			await teardown(false)
			if (deferred) {
				return
			}
		}
		if (dead || wanted!==index) {
			return
		}
		const row = content_data.children[index]
		if (!row || row.classList.contains('placeholder')) {
			release_wanted(index)
			return
		}
		let result = null
		try {
			result = await render_hover(index)
		} catch (error) {
			console.error('[row_hover] render_hover failed:', error);
			release_wanted(index)
			return
		}
		if (!result || !result.instance) {
			release_wanted(index)
			return
		}
		const lost = dead || wanted!==index || content_data.children[index]!==row || !result.node
		if (lost) {
			// never inserted: it holds no edit
			release_wanted(index)
			if (result.instance.status!=='destroyed' && typeof result.instance.destroy==='function') {
				await result.instance.destroy(true, true, true)
			}
			return
		}
		result.node.classList.add(HOVER_OVERLAY_CLASS)
		row.prepend(result.node)
		caller.ar_instances = caller.ar_instances || []
		if (!caller.ar_instances.includes(result.instance)) {
			caller.ar_instances.push(result.instance)
		}
		current = { index : index, instance : result.instance }
	}

	/**
	 * RETRY_DEFERRED
	 * The retry of a deferred teardown (focus left the overlay). When it
	 * resolves and the pointer already sits on ANOTHER tile, that tile's
	 * overlay is shown now: its pointerover arrived while the teardown was
	 * deferred (show() returned early) and will not fire again while the
	 * pointer stays on the tile — `wanted` already names it, so the
	 * pointerover guard drops every repeat.
	 */
	const retry_deferred = async () => {
		if (!deferred || !current || wanted===current.index) {
			return null
		}
		const result = await teardown(false)
		if (!deferred && !current && !dead && wanted!==null) {
			await show(wanted)
		}
		return result
	}

	// delegated listeners (one set per content_data, off with the window)
		const listener_options = signal ? { signal : signal } : {}
		content_data.addEventListener('pointerover', (e) => {
			const row = row_of(content_data, e.target)
			if (!row || row.node.classList.contains('placeholder') || row.index===wanted) {
				return
			}
			wanted = row.index
			run(() => show(row.index))
		}, listener_options)
		content_data.addEventListener('pointerleave', () => {
			wanted = null
			run(() => teardown(false))
		}, listener_options)
		content_data.addEventListener('focusout', (e) => {
			// the retry of a deferred teardown, once focus leaves the overlay
			if (!deferred || !current) {
				return
			}
			const overlay = overlay_of(current.index)
			if (!overlay || !overlay.contains(e.target) || (e.relatedTarget && overlay.contains(e.relatedTarget))) {
				return
			}
			run(() => retry_deferred())
		}, listener_options)
		if (signal) {
			signal.addEventListener('abort', () => {
				dead	= true
				wanted	= null
			}, { once : true })
		}

	const controller = {
		slot : slot,
		get index() {
			return current ? current.index : null
		},
		get instance() {
			return current ? current.instance : null
		},
		get deferred() {
			return deferred
		},
		flush : () => run(() => flush_current()),
		destroy : () => {
			dead	= true
			wanted	= null
			if (caller.row_hovers && caller.row_hovers[slot]===controller) {
				delete caller.row_hovers[slot]
			}
			return run(() => teardown(true))
		},
		idle : () => run(async () => {})
	}

	// one controller per slot
		caller.row_hovers = caller.row_hovers || {}
		const previous = caller.row_hovers[slot]
		caller.row_hovers[slot] = controller
		if (previous && previous!==controller) {
			previous.destroy()
				.then((destroyed) => {
					if (destroyed?.pending?.length > 0) {
						console.error('[row_hover] a replaced hover controller dropped pending editor values', {
							model	: caller.model,
							tipo	: caller.tipo,
							slot	: slot,
							pending	: destroyed.pending.length
						});
					}
				})
				.catch((error) => {
					console.error('[row_hover] replaced controller teardown failed:', error);
				})
		}


	return controller
}//end delegate_row_hover



// @license-end
