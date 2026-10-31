// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RECORD_WINDOW — the row box of a section list / portal, bounded and edit-safe
 *
 * The section and portal row views turn page entries into section_record rows.
 * This module is the ONE engine that places those rows into a `content_data`
 * (WC-2026-10-30-section-record-row-box). It replaces, for sections and
 * portals, the spacer-based `row_window.js` (which stays for the thesaurus
 * tree and tool_export's constants import).
 *
 * THE ROW INVARIANT (holds at every moment and every N, N=0 included)
 *   `content_data.children` holds exactly N `.section_record` elements in index
 *   order: `children[i]` is row i and carries `data-index="i"`. Nothing else
 *   sits inside `content_data` — no spacer, no no_records node, no references,
 *   no footer (those live in the `.list_after` sibling, built by the views).
 *   A row that is not built is a PLACEHOLDER: the same `.section_record` class
 *   plus `.placeholder`, a childless, listener-free, `aria-hidden` leaf. So node
 *   lookup is always `container.children[i]` or `row_of()`, both exact.
 *
 * PLACEHOLDERS EXIST ONLY WHEN N > ROW_WINDOW_MAX_ROWS. At N ≤ the bound every
 * row is built at fill and no observer of any kind is created; the one
 * exception is a FAILED build (null instance, a throw, or an instance destroyed
 * mid-render), which stays a placeholder with `data-failed="<reason>"`, is
 * logged, and is retried by `reveal(i)`. Indexes never shift.
 *
 * PURE BY CONSTRUCTION. The import set is the three `row_window.js` constants
 * and nothing else (pinned by the gates): no section.js, no ui.js, no events.js,
 * no page_globals. Every edit-safety operation arrives INJECTED (`edit_safety`).
 * Which doors bind `edit_safety` to the real ui.js / events.js /
 * component_common operations, and which suites gate those bindings, is
 * staging state: see WC-2026-10-30-section-record-row-box (Date / Decision).
 * Every DOM global is read from `container.ownerDocument` / its `defaultView`
 * — so the module runs on a counting fake DOM in the hermetic gate and has no
 * import cycle.
 *
 * Contract
 *   create_record_window({
 *     owner,          the section / portal that owns the rows. Used for log
 *                     context only: the DOOR stores the handle as
 *                     `owner.record_windows[slot]`; this module never writes it.
 *     slot,           'rows' | 'alt' | … (log context; supersession is per slot)
 *     generation,     owner-monotonic number supplied by the door
 *                     (`owner.record_window_generation[slot]`). The window never
 *                     starts its own count; it only bumps its own copy on
 *                     retire/destroy, so a drag payload stamped with it goes
 *                     stale the moment the window does.
 *     container,      the `content_data` node rows go into (must be empty: a
 *                     non-empty one THROWS — leftover children would shift
 *                     every index)
 *     rows,           the page's locator entries (frozen into the window)
 *     build,          async (entry, index) → {instance, node} | null. Builds the
 *                     row's section_record AND renders it (the door pushes the
 *                     instance into `owner.ar_instances`). Never called twice for
 *                     a live index.
 *     layout,         'table' (role=table/rowgroup/row/cell) | 'list'
 *                     (role=list/listitem). Default 'table'.
 *     draggable_rows, stamp `draggable=true` on built rows (mosaic/line sources)
 *     decorate,       optional (node, index) → void, run on every built row
 *                     (fill AND later swaps), e.g. TM's active-row marker
 *     edit_safety     {deactivate, settle, orphan, unsaved_instances,
 *                      uncommitted_nodes, register_uncommitted, commit_seq,
 *                      instance_of_node, owned_elsewhere, component_active,
 *                      service_autocomplete} — ALL required functions:
 *       deactivate(instance)        → Promise   (ui.component.deactivate)
 *       settle(instance)            → Promise<boolean> (component_common settle;
 *                                     true = no registered unsaved change left)
 *       orphan(instance)            → void (component_common orphan_unsaved_instance)
 *       unsaved_instances()         → Array (events.js get_unsaved_instances)
 *       uncommitted_nodes()         → Array (events.js uncommitted_nodes_snapshot)
 *       register_uncommitted(node)  → void (events.js register_uncommitted_input)
 *       commit_seq(instance)        → number (instance.commit_seq)
 *       instance_of_node(wrapper)   → instance|null — given the editor's nearest
 *                                     `.wrapper_component` (or null)
 *       owned_elsewhere(node)       → boolean — the node belongs to another
 *                                     controller (a mosaic hover overlay), never
 *                                     judged against this window's rows
 *       component_active()          → instance|null (page_globals.component_active)
 *       service_autocomplete()      → instance|null (page_globals.service_autocomplete)
 *   }) → Promise<handle>   (resolves once the fill is in the container)
 *
 *   handle — data and instances only, NO node getter:
 *     size, generation (getter), signal (AbortSignal of the delegated listeners)
 *     entry_of(i)          the frozen entry the window was filled with
 *     record_at(i)         the built row's instance, or null
 *     is_built(i)
 *     reveal(i)            → Promise<void>: resolves once children[i] is the built
 *                          row (retries a failed placeholder)
 *     ensure_built(from,to)→ Promise<void>
 *     rebuild(i)           → Promise<boolean>: the ONE legal re-render of a
 *                          windowed row (flush, placeholder, destroy, build, swap)
 *     hold(i,reason) / unhold(i,reason)   explicit pin (drag source, modal anchor)
 *     commit_uncommitted(indexes?) → {pending}: commit typed-not-committed editor
 *                          nodes of those rows (see EDIT SAFETY)
 *     freeze() / thaw()    `inert` on the container (the owner row lock)
 *     flush(indexes?)      → Promise<{failed, pending}>
 *     retire(new_window)   → Promise<{failed, pending}> (supersession, same slot)
 *     destroy()            → Promise<{failed, pending}> (owner destroy)
 *     idle()               → Promise<void>: resolves when the serialized step
 *                          queue drains (tests and the browser suite await it)
 *
 * LIFECYCLE
 *   fill     builds min(N, bound) rows from index 0 in parallel, assembles them
 *            with the placeholders in ONE DocumentFragment, appends once.
 *   arming   on the first animation frame in which `container.isConnected`
 *            (re-polled each frame until the window dies): sync semantics,
 *            measure `--placeholder_size` from up to SIZE_SAMPLE_ROWS built rows
 *            and, ONLY when N > bound, create the one IntersectionObserver. This
 *            solves the detached fill of `common.render('content')` (the new
 *            content_data is swapped in after render resolves) by construction.
 *   build    intersecting placeholders ± ROW_WINDOW_MARGIN/2, started in index
 *            order, each swapped in with `placeholder.replaceWith(node)` only if
 *            the placeholder is still there and the generation still matches.
 *   release  above the bound: unpinned, non-intersecting rows, farthest first,
 *            down to bound − ROW_WINDOW_MARGIN: measure, flush([i]) (a failed or
 *            pending flush keeps the row built), replace with a placeholder carrying
 *            `--row_size`, then `instance.destroy(true, true, false)`.
 *   Every per-index step runs on ONE serialized queue: no row is built twice
 *   and no row that is building can be released. A step that throws is
 *   logged once and leaves no row half-released (a throwing flush puts the row
 *   back to built AND pins it). A build that completes after
 *   retire/destroy or a generation change has its instance destroyed (unless
 *   the successor window holds it) and is never inserted.
 *
 * PINS (computed at release time — before the release flush AND again after
 *   it, since the flush awaits — never tracked). Row i with instance R is
 *   pinned when: it contains document.activeElement; it has a hold; the active
 *   component is in_row; an unsaved instance is in_row; an uncommitted node is
 *   inside it; the live service_autocomplete is in_row; an instance under R is
 *   saving / changing / has a change_value_pool; it matches :hover or carries
 *   `.dragging`; or an edit-safety binding THREW during its last flush (sticky:
 *   the window never retries a throwing binding on its own; a clean flush(i) /
 *   rebuild(i) by the door lifts it). `in_row(x)` walks `x.caller`
 *   (IN_ROW_MAX_DEPTH steps) and reaches R. A row back in reach after the
 *   flush is kept too. `rebuild(i)` re-checks the edit pins (active,
 *   unsaved, uncommitted, autocomplete, saving / changing) after its flush
 *   and refuses on one.
 *   A flush that FAILED or left a PENDING node is not a standing pin: it is a
 *   verdict re-judged at every release attempt. The row stays built because the
 *   live checks above still see the pending node / the unsaved instance; when
 *   they clear, release re-flushes the row (re-settling every instance whose
 *   settle failed there, even one that left the unsaved registry) and releases
 *   it only if that flush is clean. So a transiently dirty row becomes
 *   releasable again once its value is committed and saved.
 *
 * EDIT SAFETY. flush(indexes) = (a) deactivate + settle the active component
 *   when it is in a flushed row; (b) commit_uncommitted: snapshot the
 *   uncommitted editor nodes BEFORE any dispatch (events.js's capture listener
 *   drops a node on every `change`), skip `owned_elsewhere` nodes, and for each
 *   node inside a flushed row read `commit_seq` of its in-row instance,
 *   dispatch `change` then `blur`, and judge the OUTCOME: a node is PENDING iff
 *   its instance does not resolve in-row or its `commit_seq` did not advance —
 *   never by Set membership. A pending node is re-registered (the capture
 *   listener just removed it); (c) settle every in-row unsaved instance and
 *   every instance committed in (b); (d) return {failed, pending}. retire and
 *   destroy hand every FAILED instance to `edit_safety.orphan` exactly once and
 *   never destroy it: no path in this module destroys a dirty instance. A
 *   flush that THROWS has no verdict: retire and destroy then clear the
 *   window's instance map and destroy no row (the owner's cascade owns them).
 *
 * Gates: test/unit/client_record_window_native.test.ts (hermetic, fake DOM —
 * every leg of the contract above); the served-file census
 * test/parity/dedalo_files_differential.test.ts.
 */

import {
	ROW_WINDOW_MAX_ROWS,
	ROW_WINDOW_MARGIN,
	ROW_WINDOW_ROOT_MARGIN
} from '../../common/js/row_window.js'



/**
 * IN_ROW_MAX_DEPTH
 * How many `caller` steps `in_row` walks before giving up. A component's
 * caller chain inside one row is short (component → section_record, or
 * component → modal/portal → … → section_record); the bound only stops a
 * malformed cycle from hanging a release.
 * @type {number}
 */
const IN_ROW_MAX_DEPTH = 32

/**
 * SIZE_SAMPLE_ROWS
 * How many built rows the arming step measures for `--placeholder_size`.
 * @type {number}
 */
const SIZE_SAMPLE_ROWS = 8

/**
 * EDIT_SAFETY_KEYS
 * Every injected edit-safety binding. All are required: a window that silently
 * skipped one would release rows holding unsaved edits.
 * @type {string[]}
 */
const EDIT_SAFETY_KEYS = [
	'deactivate',
	'settle',
	'orphan',
	'unsaved_instances',
	'uncommitted_nodes',
	'register_uncommitted',
	'commit_seq',
	'instance_of_node',
	'owned_elsewhere',
	'component_active',
	'service_autocomplete'
]



/**
* ROW_OF
* Resolve the row an event target belongs to. Maps a Text node to its parent,
* then walks up until the node is a DIRECT child of `content_data` carrying
* `.section_record`. This resolves correctly through nested hover records and
* nested-portal rows, which a `closest('.section_record')` would stop at.
* @param {HTMLElement} content_data - The window's container
* @param {Node} target - Usually event.target
* @returns {{node: HTMLElement, index: number}|null}
*/
export const row_of = function(content_data, target) {

	if (!content_data || !target) {
		return null
	}

	let node = target.nodeType===3 // Text
		? target.parentElement
		: target
	while (node && node!==content_data) {
		if (node.parentElement===content_data && node.classList && node.classList.contains('section_record')) {
			const index = Number(node.dataset.index)
			return Number.isInteger(index)
				? { node : node, index : index }
				: null
		}
		node = node.parentElement
	}

	return null
}//end row_of



/**
* CARRY_ROW_ATTRIBUTES
* Copy the window-owned row attributes from a row node to its replacement, so
* an event-driven full re-render of a windowed row (common.render's
* replaceWith) keeps its index, role and draggable stamp.
* @param {HTMLElement} old_node
* @param {HTMLElement} new_node
* @returns {void}
*/
export const carry_row_attributes = function(old_node, new_node) {

	if (!old_node || !new_node || old_node===new_node) {
		return
	}

	const names = ['data-index', 'role', 'aria-rowindex', 'aria-posinset', 'aria-setsize', 'draggable']
	for (const name of names) {
		if (old_node.hasAttribute(name)) {
			new_node.setAttribute(name, old_node.getAttribute(name))
		}
	}
}//end carry_row_attributes



/**
* APPLY_TABLE_SEMANTICS
* The static half of the table semantics, applied by a `layout_table` view's
* full render: `role=table` on the list_body and, when the view has a header
* row, `role=row` on it and `role=columnheader` on each of its direct
* `.head_column` children. The DYNAMIC half (rowgroup, rows, cells,
* aria-rowcount, dropping `role=table` from a header-less table with no rows)
* belongs to the window (sync_semantics).
* `role=table`, not `grid`: there is no arrow-key navigation to promise.
* @param {HTMLElement} list_body
* @param {HTMLElement|null} header - `.header_wrapper_list`, optional
* @param {string} [label_id] - id of the portal / section label, when one exists
* @returns {void}
*/
export const apply_table_semantics = function(list_body, header, label_id) {

	if (!list_body) {
		return
	}

	list_body.setAttribute('role', 'table')
	if (label_id) {
		list_body.setAttribute('aria-labelledby', label_id)
	}

	if (header) {
		header.setAttribute('role', 'row')
		for (const child of Array.from(header.children)) {
			if (child.classList.contains('head_column')) {
				child.setAttribute('role', 'columnheader')
			}
		}
	}
}//end apply_table_semantics



/**
* CREATE_RECORD_WINDOW
* @param {Object} options - See the module header.
* @returns {Promise<Object>} The window handle, filled.
*/
export const create_record_window = async function(options) {

	const owner				= options.owner || null
	const slot				= options.slot || 'rows'
	const container			= options.container
	const build				= options.build
	const layout			= options.layout==='list' ? 'list' : 'table'
	const draggable_rows	= options.draggable_rows===true
	const decorate			= typeof options.decorate==='function' ? options.decorate : null
	const edit_safety		= options.edit_safety || {}

	if (!container || typeof build!=='function') {
		throw new Error('[record_window] container and build are required')
	}
	if (!Number.isInteger(options.generation)) {
		throw new Error('[record_window] generation must be supplied by the door (owner-monotonic)')
	}
	const missing = EDIT_SAFETY_KEYS.filter(key => typeof edit_safety[key]!=='function')
	if (missing.length > 0) {
		throw new Error('[record_window] edit_safety bindings missing: ' + missing.join(', '))
	}
	if (container.children.length > 0) {
		// the invariant owns the container: rows and placeholders only. Every
		// lookup is `container.children[index]`, so k leftover children would
		// shift every index by k (a release would replace a foreign node and
		// destroy the wrong row) — refused, never run on a broken invariant
		throw new Error('[record_window] the container must be empty (row invariant): '
			+ container.children.length + ' child(ren) present — slot ' + slot)
	}

	const rows	= Object.freeze(Array.isArray(options.rows) ? options.rows.slice() : [])
	const size	= rows.length
	const doc	= container.ownerDocument
	const view	= (doc && doc.defaultView) || globalThis
	const row_role = layout==='table' ? 'row' : 'listitem'

	// state
		let generation		= options.generation
		let dead			= false			// retired or destroyed: nothing is inserted any more
		let successor		= null			// the window that superseded this one (retire)
		let queue			= Promise.resolve()
		let observer		= null
		let raf_id			= null
		let warned_bound	= false
		let placeholder_count = 0
		let size_sum		= 0				// running mean of measured row block-sizes
		let size_count		= 0
		const controller	= new AbortController()
		// per-index state: 'placeholder' | 'building' | 'built' | 'releasing'
		const state			= new Array(size).fill('placeholder')
		const instances		= new Map()		// index → built instance
		const holds			= new Map()		// index → Set(reason)
		const throw_pins	= new Set()		// indexes whose last flush threw (sticky, see PINS)
		const failed_settles = new Map()	// index → Set(instance whose settle failed in that row)
		const intersecting	= new Set()		// indexes the observer reports in reach

	// serialize every per-index step: builds, releases, reveals and rebuilds
	// never interleave (build is async and the observer fires at will).
	// A failed step is logged ONCE, here. `step.catch` subscribes to `step`
	// itself, so a caller that drops the returned promise (observer callback,
	// focusin) leaves no unhandled rejection; one that awaits it still sees
	// the failure (reveal / rebuild / idle).
		const run = (fn) => {
			const step = queue.then(fn)
			queue = step.catch((error) => {
				console.error('[record_window] step failed:', error);
			})
			return step
		}

	// helpers
		const has_placeholders = () => placeholder_count > 0

		/**
		 * IN_ROW
		 * x reaches row instance R through its caller chain (x itself included).
		 */
		const in_row = (x, row_instance) => {
			let node = x
			for (let depth = 0; node && depth <= IN_ROW_MAX_DEPTH; depth++) {
				if (node===row_instance) {
					return true
				}
				node = node.caller
			}
			return false
		}

		/** The built row index whose instance x belongs to, or -1. */
		const row_index_of_instance = (x, indexes) => {
			for (const i of indexes) {
				const row_instance = instances.get(i)
				if (row_instance && in_row(x, row_instance)) {
					return i
				}
			}
			return -1
		}

		/** Every instance under R (R.ar_instances, recursively, bounded). */
		const instances_under = (row_instance) => {
			const found = []
			const seen = new Set()
			const walk = (instance, depth) => {
				if (!instance || seen.has(instance) || depth > IN_ROW_MAX_DEPTH) {
					return
				}
				seen.add(instance)
				found.push(instance)
				const children = Array.isArray(instance.ar_instances) ? instance.ar_instances : []
				for (const child of children) {
					walk(child, depth + 1)
				}
			}
			walk(row_instance, 0)
			return found
		}

		const built_indexes = () => {
			const list = []
			for (let i = 0; i < size; i++) {
				if (state[i]==='built') {
					list.push(i)
				}
			}
			return list
		}

		const create_placeholder = (index) => {
			const node = doc.createElement('div')
			node.className = 'section_record placeholder'
			node.setAttribute('data-index', String(index))
			node.setAttribute('role', row_role)
			node.setAttribute('aria-hidden', 'true')
			return node
		}

		const mark_failed = (index, node, reason, error) => {
			node.setAttribute('data-failed', reason)
			console.error('[record_window] row build failed:', {
				owner_id	: owner?.id,
				slot		: slot,
				index		: index,
				reason		: reason
			}, error || '');
		}

		/**
		 * STAMP_ROW
		 * The window-owned attributes of one built row: class, index, role, the
		 * cell roles of a table row, position attributes while placeholders
		 * exist, draggable.
		 */
		const stamp_row = (node, index) => {
			node.classList.add('section_record')
			node.classList.remove('placeholder')
			node.removeAttribute('aria-hidden')
			node.removeAttribute('data-failed')
			node.setAttribute('data-index', String(index))
			node.setAttribute('role', row_role)
			if (layout==='table') {
				for (const child of Array.from(node.children)) {
					if (child.classList.contains('column')) {
						child.setAttribute('role', 'cell')
					}
				}
			}
			stamp_position(node, index)
			if (draggable_rows) {
				node.setAttribute('draggable', 'true')
			}
		}

		/** aria position attributes: only while placeholders exist. */
		const stamp_position = (node, index) => {
			const header_offset = layout==='table' ? header_rows() : 0
			if (layout==='table') {
				if (has_placeholders()) {
					node.setAttribute('aria-rowindex', String(index + 1 + header_offset))
				}else{
					node.removeAttribute('aria-rowindex')
				}
			}else{
				if (has_placeholders()) {
					node.setAttribute('aria-posinset', String(index + 1))
					node.setAttribute('aria-setsize', String(size))
				}else{
					node.removeAttribute('aria-posinset')
					node.removeAttribute('aria-setsize')
				}
			}
		}

		/** The list_body of a table layout (the container's parent), or null. */
		const list_body_of = () => {
			const parent = container.parentElement
			return parent && parent.classList && parent.classList.contains('list_body')
				? parent
				: null
		}

		/** 1 when the table has a header row (`.header_wrapper_list` sibling), else 0. */
		const header_rows = () => {
			const list_body = list_body_of()
			if (!list_body) {
				return 0
			}
			for (const child of Array.from(list_body.children)) {
				if (child.classList.contains('header_wrapper_list')) {
					return 1
				}
			}
			return 0
		}

		/**
		 * SYNC_SEMANTICS
		 * The dynamic a11y semantics, owned by the window: container role, row
		 * roles and positions, and — once attached — the list_body's
		 * aria-rowcount (or the removal of a header-less table's role at N=0:
		 * a table owning no row fails aria-required-children).
		 */
		const sync_semantics = () => {
			if (size===0) {
				container.removeAttribute('role')
				container.removeAttribute('aria-rowcount')
				if (layout==='table') {
					const list_body = list_body_of()
					if (list_body) {
						list_body.removeAttribute('aria-rowcount')
						if (header_rows()===0) {
							list_body.removeAttribute('role')
						}
					}
				}
				return
			}
			container.setAttribute('role', layout==='table' ? 'rowgroup' : 'list')
			if (layout==='table') {
				const list_body = list_body_of()
				if (list_body) {
					if (has_placeholders()) {
						list_body.setAttribute('aria-rowcount', String(size + header_rows()))
					}else{
						list_body.removeAttribute('aria-rowcount')
					}
				}
			}
			const children = container.children
			for (let i = 0; i < children.length; i++) {
				const node = children[i]
				if (node.classList.contains('placeholder')) {
					node.setAttribute('role', row_role)
					node.setAttribute('aria-hidden', 'true')
				}else{
					stamp_position(node, i)
				}
			}
		}

		/** Placeholder count changed: a presence flip re-syncs every row. */
		const set_placeholder_count = (count) => {
			const had = has_placeholders()
			placeholder_count = count
			if (had!==has_placeholders()) {
				sync_semantics()
			}
		}

		/** Mean block-size bookkeeping; written only while connected. */
		const record_size = (height) => {
			if (!(height > 0)) {
				return
			}
			size_sum += height
			size_count++
			if (container.isConnected) {
				container.style.setProperty('--placeholder_size', (size_sum / size_count).toFixed(1) + 'px')
			}
		}

		const measure = (node) => {
			if (!node || typeof node.getBoundingClientRect!=='function') {
				return 0
			}
			const rect = node.getBoundingClientRect()
			return rect && rect.height > 0 ? rect.height : 0
		}

		/**
		 * DISCARD_LATE
		 * A build that resolved after the window died, or after a generation
		 * change: destroy its instance unless the successor window holds it
		 * (the instance cache can hand the SAME section_record to both).
		 */
		const discard_late = (instance) => {
			if (!instance || instance.status==='destroyed') {
				return
			}
			if (successor && successor_holds(instance)) {
				return
			}
			if (typeof instance.destroy==='function') {
				instance.destroy(true, true, false)
			}
		}

		const successor_holds = (instance) => {
			for (let i = 0; i < successor.size; i++) {
				if (successor.record_at(i)===instance) {
					return true
				}
			}
			return false
		}

		/**
		 * CALL_BUILD
		 * One guarded call of the injected build. Resolves {instance, node} or
		 * {failed: reason, error}.
		 */
		const call_build = async (index) => {
			let result
			try {
				result = await build(rows[index], index)
			} catch (error) {
				return { failed : 'throw', error : error }
			}
			if (!result || !result.instance || !result.node) {
				if (result && result.instance) {
					discard_late(result.instance)
				}
				return { failed : 'null' }
			}
			if (result.instance.status==='destroyed') {
				return { failed : 'destroyed' }
			}
			return { instance : result.instance, node : result.node }
		}

		/** A built row enters the window (state, stamp, decorate). */
		const adopt_built = (index, instance, node) => {
			instances.set(index, instance)
			state[index] = 'built'
			stamp_row(node, index)
			if (decorate) {
				try {
					decorate(node, index)
				} catch (error) {
					console.error('[record_window] decorate failed:', error);
				}
			}
		}

		/**
		 * BUILD_ONE
		 * Build the placeholder at `index` and swap it in — only when the
		 * placeholder is still in place and the generation still matches.
		 */
		const build_one = async (index) => {
			if (dead || state[index]!=='placeholder') {
				return
			}
			const placeholder = container.children[index]
			if (!placeholder || !placeholder.classList.contains('placeholder')) {
				return
			}
			state[index] = 'building'
			const generation_at_start = generation
			const result = await call_build(index)
			if (dead || generation!==generation_at_start) {
				if (!dead) {
					state[index] = 'placeholder'
				}
				discard_late(result.instance)
				return
			}
			const current = container.children[index]
			if (current!==placeholder) {
				state[index] = 'placeholder'
				discard_late(result.instance)
				return
			}
			if (result.failed) {
				state[index] = 'placeholder'
				mark_failed(index, placeholder, result.failed, result.error)
				return
			}
			placeholder.replaceWith(result.node)
			if (observer) {
				observer.unobserve(placeholder)
				observer.observe(result.node)
			}
			adopt_built(index, result.instance, result.node)
			set_placeholder_count(placeholder_count - 1)
		}

		/**
		 * EDIT_PINNED
		 * The edit-state pins of row `index` (pins 3-7 of the header): an edit
		 * that lives in the row and would be lost with its instance. The one
		 * check `rebuild` re-runs after its flush (holds, focus, hover and
		 * reach do not refuse an explicit rebuild; a new edit does).
		 */
		const edit_pinned = (index, row_instance) => {
			const node = container.children[index]
			// 3. the active component (edit modal, inline edit) is in the row
			const active = edit_safety.component_active()
			if (active && in_row(active, row_instance)) {
				return true
			}
			// 4. an unsaved instance is in the row
			for (const instance of edit_safety.unsaved_instances()) {
				if (in_row(instance, row_instance)) {
					return true
				}
			}
			// 5. an uncommitted editor node is inside the row
			for (const uncommitted of edit_safety.uncommitted_nodes()) {
				if (uncommitted && node.contains(uncommitted)) {
					return true
				}
			}
			// 6. the live autocomplete service belongs to the row
			const autocomplete = edit_safety.service_autocomplete()
			if (autocomplete && autocomplete.status!=='destroyed' && in_row(autocomplete, row_instance)) {
				return true
			}
			// 7. an instance under the row is saving / changing
			for (const instance of instances_under(row_instance)) {
				if (instance.saving===true || instance.changing===true
					|| (Array.isArray(instance.change_value_pool) && instance.change_value_pool.length > 0)) {
					return true
				}
			}
			return false
		}

		/**
		 * IS_PINNED
		 * The release-time pin verdict for row `index` (see the header). Run
		 * before the release flush AND again after it (`release_one`): the
		 * flush awaits, and a pin can appear while it does.
		 */
		const is_pinned = (index) => {
			const node = container.children[index]
			const row_instance = instances.get(index)
			if (!node || !row_instance) {
				return true
			}
			// 1. focus inside the row
			const active_element = doc ? doc.activeElement : null
			if (active_element && node.contains(active_element)) {
				return true
			}
			// 2. explicit hold
			if (holds.has(index) && holds.get(index).size > 0) {
				return true
			}
			// an edit-safety binding threw during the row's last flush
			if (throw_pins.has(index)) {
				return true
			}
			// 3-7. the edit-state pins
			if (edit_pinned(index, row_instance)) {
				return true
			}
			// 8. hovered or being dragged
			if (node.classList.contains('dragging')) {
				return true
			}
			try {
				if (node.matches(':hover')) {
					return true
				}
			} catch (error) {
				// a DOM without :hover support pins nothing here
			}
			// a failed / pending last flush is NOT a pin here: release_one
			// re-flushes the row (re-settling `failed_settles`) and keeps it
			// built unless that flush is clean (see PINS)
			return false
		}

		/**
		 * RELEASE_ONE
		 * measure → flush([i]) → replace with a sized placeholder → destroy.
		 * A failed or pending flush pins the row instead.
		 */
		const release_one = async (index) => {
			const node = container.children[index]
			const row_instance = instances.get(index)
			state[index] = 'releasing'
			const height = measure(node)
			let flushed
			try {
				flushed = await flush_indexes([index])
			} catch (error) {
				// a throwing edit-safety binding: the row stays built AND pinned
				// (never stuck in 'releasing', which would drop it out of every
				// later flush, drag and rebuild); the step fails loudly
				state[index] = 'built'
				throw_pins.add(index)
				throw error
			}
			if (dead) {
				// the retire / destroy that set `dead` flushes this row too (it
				// iterates `instances`, 'releasing' rows included) and orphans
				// ITS failures: orphaning here as well would orphan twice
				return
			}
			if (flushed.failed.length > 0 || flushed.pending.length > 0) {
				// flush_indexes recorded the failed settles; the row stays built
				// and the next release attempt re-judges it
				state[index] = 'built'
				return
			}
			// the pin verdict is stale by the length of the flush (a settle can
			// be a network save): a row the user came back to meanwhile (focus,
			// a hold, a new active / unsaved / uncommitted edit, back in reach)
			// is kept, never destroyed under that edit
			let pinned_now
			try {
				pinned_now = is_pinned(index) || intersecting.has(index)
			} catch (error) {
				// a throwing binding in the re-check: built AND pinned, as above
				state[index] = 'built'
				throw_pins.add(index)
				throw error
			}
			if (pinned_now) {
				state[index] = 'built'
				return
			}
			const placeholder = create_placeholder(index)
			if (height > 0) {
				placeholder.style.setProperty('--row_size', height + 'px')
				record_size(height)
			}
			node.replaceWith(placeholder)
			if (observer) {
				observer.unobserve(node)
				observer.observe(placeholder)
			}
			instances.delete(index)
			state[index] = 'placeholder'
			set_placeholder_count(placeholder_count + 1)
			if (row_instance && row_instance.status!=='destroyed' && typeof row_instance.destroy==='function') {
				await row_instance.destroy(true, true, false)
			}
		}

		/**
		 * RELEASE_EXCESS
		 * Above the bound: release unpinned, non-intersecting rows, farthest
		 * first by index distance from the nearest intersecting index, down to
		 * bound − margin. Bound: built ≤ ROW_WINDOW_MAX_ROWS + pinned.
		 * @param {Set<number>|null} keep - rows just asked for (reveal /
		 *   ensure_built): never released by the same step that built them
		 */
		const release_excess = async (keep = null) => {
			const built = built_indexes()
			if (built.length <= ROW_WINDOW_MAX_ROWS) {
				return
			}
			const target = ROW_WINDOW_MAX_ROWS - ROW_WINDOW_MARGIN
			const reach = Array.from(intersecting)
			const distance = (i) => {
				if (reach.length===0) {
					return i
				}
				let best = Infinity
				for (const r of reach) {
					const d = Math.abs(i - r)
					if (d < best) {
						best = d
					}
				}
				return best
			}
			const candidates = built
				.filter(i => !intersecting.has(i) && !(keep && keep.has(i)))
				.sort((a, b) => distance(b) - distance(a))
			let count = built.length
			for (const index of candidates) {
				if (count <= target || dead) {
					break
				}
				if (is_pinned(index)) {
					continue
				}
				await release_one(index)
				if (state[index]==='placeholder') {
					count--
				}
			}
			if (count > ROW_WINDOW_MAX_ROWS && !warned_bound) {
				warned_bound = true
				console.warn('[record_window] no releasable row: the window holds more than the bound (pinned rows)', {
					owner_id	: owner?.id,
					slot		: slot,
					built		: count
				});
			}
		}

		/**
		 * STEP
		 * Build the placeholders in reach (± margin/2), then release above the bound.
		 */
		const step = async () => {
			if (dead) {
				return
			}
			const half = Math.floor(ROW_WINDOW_MARGIN / 2)
			const wanted = new Set()
			for (const index of intersecting) {
				const from = Math.max(0, index - half)
				const to = Math.min(size - 1, index + half)
				for (let i = from; i <= to; i++) {
					if (state[i]==='placeholder' && !container.children[i]?.hasAttribute('data-failed')) {
						wanted.add(i)
					}
				}
			}
			const ordered = Array.from(wanted).sort((a, b) => a - b)
			await Promise.all(ordered.map(i => build_one(i)))
			await release_excess()
		}

		/**
		 * COMMIT_UNCOMMITTED_INDEXES
		 * Edit-safety step (b): commit typed-not-committed editor nodes of the
		 * given rows by dispatching `change` + `blur` on them, judged by outcome.
		 * @returns {{pending: Array<{node, instance, index}>, committed: Set}}
		 */
		const commit_uncommitted_indexes = (indexes) => {
			const pending = []
			const committed = new Set()
			const flushed = new Set(indexes.filter(i => state[i]==='built' || state[i]==='releasing'))
			if (flushed.size===0) {
				return { pending, committed }
			}
			// snapshot BEFORE any dispatch: the capture listener removes every
			// node from the live Set on `change`, committed or not
			const snapshot = edit_safety.uncommitted_nodes()
			for (const node of snapshot) {
				if (!node) {
					continue
				}
				const row = row_of(container, node)
				if (!row || !flushed.has(row.index)) {
					continue
				}
				if (edit_safety.owned_elsewhere(node)) {
					// the hover controller owns it (its instance's caller is the
					// portal, so in_row would misjudge a committed value as pending)
					continue
				}
				const row_instance = instances.get(row.index)
				const wrapper = typeof node.closest==='function' ? node.closest('.wrapper_component') : null
				const instance = edit_safety.instance_of_node(wrapper)
				const resolved = !!(instance && row_instance && in_row(instance, row_instance))
				const seq_before = resolved ? edit_safety.commit_seq(instance) : null
				// the editor's own listeners, closed over their own instance, commit it
				node.dispatchEvent(new view.Event('change', { bubbles : true }))
				node.dispatchEvent(new view.Event('blur'))
				const advanced = resolved && edit_safety.commit_seq(instance) > seq_before
				if (advanced) {
					committed.add(instance)
				}else{
					// its value lives only in the node: keep the guard counting it
					edit_safety.register_uncommitted(node)
					pending.push({ node : node, instance : instance || null, index : row.index })
				}
			}
			return { pending, committed }
		}

		/**
		 * FLUSH_INDEXES
		 * Edit-safety steps (a)-(d) over the given rows. Never destroys anything.
		 */
		const flush_indexes = async (indexes) => {
			const failed = []
			const settled = new Set()
			const live = indexes.filter(i => instances.has(i))
			if (live.length===0) {
				return { failed, pending : [] }
			}
			// (a) the active component in a flushed row: deactivate, then settle
			const active = edit_safety.component_active()
			if (active && row_index_of_instance(active, live)!==-1) {
				await edit_safety.deactivate(active)
				settled.add(active)
				if (await edit_safety.settle(active)!==true) {
					failed.push(active)
				}
			}
			// (b) commit the uncommitted editor nodes first
			const { pending, committed } = commit_uncommitted_indexes(live)
			// (c) settle every in-row unsaved instance, every committed one, and
			// every instance whose settle failed in a flushed row before (it may
			// have left the unsaved registry without being saved)
			const to_settle = new Set(committed)
			for (const instance of edit_safety.unsaved_instances()) {
				if (row_index_of_instance(instance, live)!==-1) {
					to_settle.add(instance)
				}
			}
			for (const index of live) {
				for (const instance of failed_settles.get(index) || []) {
					if (instance.status!=='destroyed' && row_index_of_instance(instance, [index])!==-1) {
						to_settle.add(instance)
					}
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
			// record each row's failed settles (re-settled by the next flush of
			// that row); a flushed row with none loses its record, and a clean
			// flush (no failed, no pending) also lifts a throw pin (see PINS)
			const failed_by_row = new Map()
			for (const instance of failed) {
				const index = row_index_of_instance(instance, live)
				if (!failed_by_row.has(index)) {
					failed_by_row.set(index, new Set())
				}
				failed_by_row.get(index).add(instance)
			}
			const pending_rows = new Set(pending.map(item => item.index))
			for (const index of live) {
				if (failed_by_row.has(index)) {
					failed_settles.set(index, failed_by_row.get(index))
				}else{
					failed_settles.delete(index)
				}
				if (!failed_by_row.has(index) && !pending_rows.has(index)) {
					throw_pins.delete(index)
				}
			}
			// (d)
			return { failed, pending }
		}

		/**
		 * Hand every failed instance to edit_safety.orphan. Exactly once each by
		 * construction: a flush settles an instance at most once (`settled`),
		 * and only the one retire or destroy of a live window orphans.
		 */
		const orphan_failed = (failed) => {
			for (const instance of failed) {
				edit_safety.orphan(instance)
			}
		}

		/** Stop the window acting: abort listeners, observer, arming frame. */
		const stop = () => {
			controller.abort()
			if (observer) {
				observer.disconnect()
				observer = null
			}
			if (raf_id!==null && typeof view.cancelAnimationFrame==='function') {
				view.cancelAnimationFrame(raf_id)
			}
			raf_id = null
			holds.clear()
			intersecting.clear()
		}

		/**
		 * ARM
		 * The first frame in which the container is connected: sync the
		 * semantics, measure the placeholder size and, only above the bound,
		 * create the one IntersectionObserver.
		 */
		const arm = () => {
			// 1. read the layout (forces style resolution once, for the measure below)
			sync_semantics()
			// 3. measure --placeholder_size from up to SIZE_SAMPLE_ROWS built rows
			let sampled = 0
			for (let i = 0; i < size && sampled < SIZE_SAMPLE_ROWS; i++) {
				if (state[i]==='built') {
					record_size(measure(container.children[i]))
					sampled++
				}
			}
			// 4. the observer, only above the bound
			if (size > ROW_WINDOW_MAX_ROWS && typeof view.IntersectionObserver==='function') {
				observer = new view.IntersectionObserver((entries) => {
					if (dead) {
						return
					}
					for (const entry of entries) {
						const index = Number(entry.target.dataset.index)
						if (!Number.isInteger(index) || container.children[index]!==entry.target) {
							continue
						}
						if (entry.isIntersecting) {
							intersecting.add(index)
						}else{
							intersecting.delete(index)
						}
					}
					run(step)
				}, { root : null, rootMargin : ROW_WINDOW_ROOT_MARGIN })
				for (const child of Array.from(container.children)) {
					observer.observe(child)
				}
			}
		}

		const arm_tick = () => {
			raf_id = null
			if (dead) {
				return
			}
			if (!container.isConnected) {
				raf_id = view.requestAnimationFrame(arm_tick)
				return
			}
			arm()
		}

	// fill. Build min(N, bound) rows from index 0, assemble once.
		const fill_count = Math.min(size, ROW_WINDOW_MAX_ROWS)
		for (let i = 0; i < fill_count; i++) {
			state[i] = 'building'
		}
		const results = await Promise.all(
			Array.from({ length : fill_count }, (_, i) => call_build(i))
		)
		const fragment = doc.createDocumentFragment()
		let placeholders = 0
		for (let i = 0; i < size; i++) {
			const result = i < fill_count ? results[i] : null
			if (result && !result.failed) {
				fragment.appendChild(result.node)
				adopt_built(i, result.instance, result.node)
			}else{
				const placeholder = create_placeholder(i)
				if (result && result.failed) {
					mark_failed(i, placeholder, result.failed, result.error)
				}
				state[i] = 'placeholder'
				fragment.appendChild(placeholder)
				placeholders++
			}
		}
		placeholder_count = placeholders
		container.appendChild(fragment)
		sync_semantics()

	// keyboard: Tab never skips past unbuilt rows (only placeholders can be unbuilt)
		if (size > ROW_WINDOW_MAX_ROWS) {
			container.addEventListener('focusin', (event) => {
				const row = row_of(container, event.target)
				if (row) {
					handle.ensure_built(row.index - ROW_WINDOW_MARGIN, row.index + ROW_WINDOW_MARGIN)
				}
			}, { signal : controller.signal })
		}

	const handle = {
		size	: size,
		get generation() {
			return generation
		},
		signal	: controller.signal,

		entry_of : (index) => rows[index],

		record_at : (index) => (state[index]==='built' || state[index]==='releasing')
			? (instances.get(index) || null)
			: null,

		is_built : (index) => state[index]==='built',

		reveal : (index) => run(async () => {
			if (dead || !Number.isInteger(index) || index < 0 || index >= size) {
				return
			}
			if (state[index]==='placeholder') {
				const node = container.children[index]
				if (node) {
					node.removeAttribute('data-failed')
				}
				await build_one(index)
			}
			await release_excess(new Set([index]))
		}),

		ensure_built : (from, to) => run(async () => {
			if (dead) {
				return
			}
			const start = Math.max(0, Math.floor(from))
			const end = Math.min(size - 1, Math.floor(to))
			const wanted = []
			for (let i = start; i <= end; i++) {
				if (state[i]==='placeholder' && !container.children[i]?.hasAttribute('data-failed')) {
					wanted.push(i)
				}
			}
			await Promise.all(wanted.map(i => build_one(i)))
			await release_excess(new Set(wanted))
		}),

		rebuild : (index) => run(async () => {
			if (dead || state[index]!=='built') {
				return false
			}
			let flushed
			try {
				flushed = await flush_indexes([index])
			} catch (error) {
				// state is still 'built'; pin it (sticky, see PINS), fail loudly
				throw_pins.add(index)
				throw error
			}
			if (dead) {
				// a retire / destroy ran while the flush awaited: the row now
				// belongs to that verdict (the successor may hold this instance,
				// or destroy may have orphaned a failed one in it), never destroyed here
				return false
			}
			if (flushed.failed.length > 0 || flushed.pending.length > 0) {
				// refused; the failed settles are recorded for the next flush
				return false
			}
			const node = container.children[index]
			const row_instance = instances.get(index)
			// an edit that appeared while the flush awaited lives in this row
			// instance: refused, exactly like a failed flush
			if (edit_pinned(index, row_instance)) {
				return false
			}
			const placeholder = create_placeholder(index)
			node.replaceWith(placeholder)
			if (observer) {
				observer.unobserve(node)
				observer.observe(placeholder)
			}
			instances.delete(index)
			state[index] = 'placeholder'
			set_placeholder_count(placeholder_count + 1)
			// destroyed BEFORE the build, so the instance cache cannot hand it back
			if (row_instance && row_instance.status!=='destroyed' && typeof row_instance.destroy==='function') {
				await row_instance.destroy(true, true, false)
			}
			await build_one(index)
			return state[index]==='built'
		}),

		hold : (index, reason) => {
			if (!holds.has(index)) {
				holds.set(index, new Set())
			}
			holds.get(index).add(reason || 'hold')
		},

		unhold : (index, reason) => {
			const reasons = holds.get(index)
			if (!reasons) {
				return
			}
			reasons.delete(reason || 'hold')
			if (reasons.size===0) {
				holds.delete(index)
			}
		},

		commit_uncommitted : (indexes) => {
			const list = Array.isArray(indexes) ? indexes : built_indexes()
			const { pending } = commit_uncommitted_indexes(list)
			return { pending }
		},

		freeze : () => {
			container.inert = true
		},

		thaw : () => {
			if (container.isConnected) {
				container.inert = false
			}
		},

		flush : (indexes) => flush_indexes(Array.isArray(indexes) ? indexes : built_indexes()),

		/**
		 * RETIRE
		 * Supersession by `new_window` in the same slot. Order matters (see
		 * the module header): abort, inert, stop, generation++, flush what the
		 * new window does not hold, THEN compute the destroy set (a build of the
		 * new window during the flush may have adopted an old instance from the
		 * cache), orphan the failed, destroy the rest without touching the DOM
		 * (the old container leaves wholesale at the content swap). A throwing
		 * flush clears the map, destroys nothing, logs and rejects (see EDIT
		 * SAFETY).
		 */
		retire : async (new_window) => {
			if (dead) {
				return { failed : [], pending : [] }
			}
			dead = true
			successor = new_window || null
			// 1. delegated listeners off
			// 3. observer, arming frame, holds
			stop()
			// 2. no stray event resolves an index against the new window
			container.inert = true
			// 4.
			generation++
			const holds_instance = (instance) => !!successor && successor_holds(instance)
			// 5. flush the rows the new window does not hold
			const to_flush = []
			for (const [index, instance] of instances) {
				if (!holds_instance(instance)) {
					to_flush.push(index)
				}
			}
			let flushed
			try {
				flushed = await flush_indexes(to_flush)
			} catch (error) {
				// a throwing edit-safety binding: no verdict, so nothing can be
				// judged clean. The dead window lets go of every row (the map is
				// cleared, like destroy) but DESTROYS NONE of them — one may hold
				// a dirty instance; they stay in the owner's ar_instances for its
				// cascade. Logged here with the kept count, then rejected.
				const kept = Array.from(instances.values()).filter(instance => !holds_instance(instance)).length
				instances.clear()
				console.error('[record_window] retire flush threw: superseded rows kept undestroyed (no verdict)', {
					owner_id	: owner?.id,
					slot		: slot,
					kept		: kept,
					error		: error
				});
				throw error
			}
			// 6. the destroy set, computed NOW
			orphan_failed(flushed.failed)
			const destroy_set = []
			for (const instance of instances.values()) {
				if (!holds_instance(instance)) {
					destroy_set.push(instance)
				}
			}
			instances.clear()
			for (const instance of destroy_set) {
				if (instance.status!=='destroyed' && typeof instance.destroy==='function') {
					await instance.destroy(true, true, false)
				}
			}
			return flushed
		},

		/**
		 * DESTROY
		 * Owner destroy: flush (incl. commit) → stop → generation++. The rows
		 * themselves are destroyed by the owner's cascade (they live in its
		 * ar_instances); failed instances are orphaned first so the cascade
		 * cannot reach them. A returned `pending` is the owner's to log.
		 * A throwing flush still tears the window down (stop, generation++,
		 * instance map cleared) before the error propagates: there is no
		 * verdict to orphan by, and a live observer / listener / generation on
		 * a dead window would outlive its owner.
		 */
		destroy : async () => {
			if (dead) {
				return { failed : [], pending : [] }
			}
			// dead FIRST: a build resolving while the flush awaits is discarded,
			// never inserted (and never left out of the flush)
			dead = true
			// every row that still holds an instance, 'releasing' included: a
			// release awaiting its own flush returns on `dead` without orphaning,
			// so this verdict is the only one that can orphan its failures
			let flushed
			try {
				flushed = await flush_indexes(Array.from(instances.keys()))
			} finally {
				stop()
				generation++
				if (!flushed) {
					instances.clear()
				}
			}
			orphan_failed(flushed.failed)
			instances.clear()
			return flushed
		},

		idle : () => run(async () => {})
	}

	// arming waits for the container to be connected
		raf_id = view.requestAnimationFrame(arm_tick)


	return handle
}//end create_record_window



// @license-end
