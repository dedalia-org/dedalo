// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

// imports
	import {get_all_instances} from '../../common/js/instances.js'
	import {ApiError, request_failed} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'
	import * as touch_pick from '../../common/js/touch_pick.js'
	import {row_of} from '../../section_record/js/record_window.js'


/**
* DRAG_AND_DROP
* Native HTML5 drag-and-drop for `component_portal` rows (and the two tool mosaics
* that drag portal rows out to their own targets).
*
* Two operations are supported:
*   REORDER  — dragging a record within the SAME portal instance repositions it by
*              calling `component_portal.prototype.sort_data`, which persists the new
*              order via the change_value → API pipeline.
*   MOVE     — dragging a record from one portal to a compatible portal LINKS it into
*              the target first and unlinks it from the source ONLY when the target
*              actually accepted it (see perform_drop for why that order is load-bearing).
*
* Compatibility between portals is governed by `properties.draggable_to`, an
* array of tipo strings (e.g. ['dd1234', 'dd1235']) declared on the source portal.
*
* ── THE DELEGATED CONTRACT (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, stage-3 addendum) ──
* One listener set per `content_data`, registered with the row window's AbortSignal
* (`self.record_windows.rows.signal`), never one per row — and never two: a second
* bind on the same content_data under the same live window is refused loudly
* (`claim_row_binding`), so one gesture is never handled twice:
*   bind_row_drag(self, content_data, {source})  — portal-owned rows ('handle' | 'row')
*   bind_tool_row_drag(self, content_data)       — the tool mosaics (text/plain payload)
*   bind_portal_drop(self, wrapper)              — the wrapper MOVE zone (no row needed)
* Every decision goes through ONE pure function, `decide_drop`, which answers
*   {kind:'reorder', value, source_key, target_key} | {kind:'move', locator}
*   | {kind:'stale'} | null
* and the ONE executor `perform_drop`. `on_drop` is the adapter both the touch path
* and the legacy per-node listeners call.
*
* KEY LAW: write keys are ABSOLUTE. `source_key` is the payload's `paginated_key`
* (= the dragged entry's `paginated_key`, stamped absolute by the server,
* relation_core.ts) and `target_key` the target entry's `paginated_key`.
* The paginator's offset is NEVER added (it was, and counted the offset twice on
* page 2+). The section_record instance fields (its paginated key / row key /
* locator) are never read: they go stale on cache reuse; entries come from the
* window's frozen `entry_of(i)`.
*
* FOREIGN GUARD: a dragover/drop whose `dataTransfer.types` lacks the portal MIME
* type, or that `decide_drop` answers null for, is never STOPPED (no
* stopPropagation), so it bubbles on to whoever owns it (a thesaurus ts_object term,
* a file drop zone, an outer portal). Only an accepted decision is consumed.
* One split on DROP: a payload this module RECOGNISES as its own (the portal MIME
* type, or a parse that passes is_portal_payload / legacy_portal_payload) but whose
* decision is null (same row, declared order, view_order, unwritable target, no
* row under the pointer) still gets `preventDefault` — without it the browser runs
* the default text drop and inserts the payload JSON into whatever editable control
* (an <input> of a component in the row) is under the pointer, which the component
* then saves. preventDefault without stopPropagation blocks only that insertion:
* ancestors still receive the drop and decide for themselves. A foreign payload is
* left wholly alone (its owner, not us, decides what its drop does).
*
* The `tmp` module-level object is an out-of-band channel for the payload, because
* `event.dataTransfer.getData()` is blocked by browsers during dragover.
*
* LEGACY (kept until the views move onto the window — stage 5 of the row-box WC,
* which deletes them together with the legacy payload upgrade in `on_drop`): the
* per-node on_dragstart / on_dragstart_mosaic / on_dragover / on_dragleave /
* on_dragend and get_mosaic_transfer_data, plus legacy_portal_payload /
* legacy_target_index. The set is pinned shrink-only by
* test/unit/client_relation_move_native.test.ts (LEGACY_DRAG_SYMBOLS): growth is
* red, and each removal must shrink that list in the same change.
*/



// Temporary object to provide access to `dataTransfer`` object that is not available in all events
	const tmp = {}



/**
* PORTAL_ROW_MIME
* The drag type that identifies a portal-row payload. Its PRESENCE in
* `dataTransfer.types` (readable during dragover, unlike the data) is the first
* half of the foreign guard; a tool-mosaic drag never sets it.
*/
export const PORTAL_ROW_MIME = 'application/x-dedalo-portal-row'

/** The payload `kind` discriminator (second half of the guard: the shape). */
export const PORTAL_ROW_KIND = 'dedalo_portal_row'



/**
* TOOL_ROW_SOURCES
* SHRINK-ONLY: the views whose rows are a drag SOURCE for a tool's own drop target
* (never a portal MOVE target named in `draggable_to`, so the portal source rule
* does not apply to them). Each entry carries the reason it exists. Read only
* through `can_tool_source`.
*/
export const TOOL_ROW_SOURCES = Object.freeze(new Map([
	['tool_cataloging_mosaic', 'tool_cataloging: a record card is dropped (or tap-placed) on a thesaurus ts_object term, whose handler validates the payload'],
	['coins_mosaic', 'tool_numisdata_order_coins: a coin tile is dropped (or tap-placed) into the tool\'s own ordered-coins slots, whose handler validates the payload']
]))



/**
* HAS_DECLARED_ORDER
* The server emits `context.declared_order` ([{tipo, direction}], absent when none):
* the ONE authority for "this portal's order is the ontology's". It is read ONLY
* here: every client caller asks this function, never `declared_order` itself
* (census in test/unit/client_relation_move_native.test.ts: a read of
* `declared_order` anywhere else under client/ or tools/ ** /js is red).
* @param {Object} self - component_portal instance
* @returns {boolean}
*/
const has_declared_order = function(self) {
	const declared = self?.context?.declared_order
	return Array.isArray(declared)
		? declared.length > 0
		: Boolean(declared)
}//end has_declared_order



/**
* DRAGGABLE_TO_OF
* @param {Object} self - component_portal instance
* @returns {string[]} the portal's `properties.draggable_to` (never null)
*/
const draggable_to_of = function(self) {
	const draggable_to = self?.properties?.draggable_to
	return Array.isArray(draggable_to)
		? draggable_to.filter(el => typeof el==='string')
		: []
}//end draggable_to_of



/**
* CAN_REORDER
* Same-portal reorder gate. Drag is ON only while the portal shows its SAVED order:
* never under a declared (ontology) order, never while a temporary `view_order`
* is active, never for a model whose order is not a position in this list
* (`reorderable===false`: component_relation_children).
* @param {Object} self - component_portal instance
* @returns {boolean}
*/
export const can_reorder = function(self) {
	return self?.mode==='edit'
		&& Boolean(self.paginator)
		&& self.permissions>=2
		&& self.reorderable!==false
		&& !has_declared_order(self)
		&& !self.view_order
}//end can_reorder



/**
* CAN_VIEW_SORT
* The header TEMPORARY sort buttons: any column declaring `sort_by_column:true`
* (a declared-order portal included — a temporary `view_order` is allowed there).
* @param {Object} self - component_portal instance (unused: the column decides)
* @param {Object} column - a columns_map entry
* @returns {boolean}
*/
export const can_view_sort = function(self, column) {
	return column?.sort_by_column===true
}//end can_view_sort



/**
* CAN_SAVE_VIEW_ORDER
* The "save current order" button: only while a temporary `view_order` is active,
* never on a declared-order portal (the server refuses `sort_by_column` /
* `sort_data` there, reason `declared_order`).
* @param {Object} self - component_portal instance
* @returns {boolean}
*/
export const can_save_view_order = function(self) {
	return Boolean(self?.view_order)
		&& !has_declared_order(self)
		&& self.permissions>=2
}//end can_save_view_order



/**
* CAN_DRAG_OUT
* Cross-portal MOVE source gate: the portal names at least one target in
* `draggable_to`. OFF on a declared-order portal (with or without a view_order)
* and on any portal while a `view_order` is active, MOVE included.
* @param {Object} self - component_portal instance
* @returns {boolean}
*/
export const can_drag_out = function(self) {
	return self?.mode==='edit'
		&& self.permissions>=2
		&& self.reorderable!==false
		&& draggable_to_of(self).length > 0
		&& !has_declared_order(self)
		&& !self.view_order
}//end can_drag_out



/**
* CAN_TOOL_SOURCE
* The named tool-source gate (bind_tool_row_drag only): the view is listed in
* TOOL_ROW_SOURCES. Never `can_reorder` / `can_drag_out`: the tool mosaics need no
* edit mode, paginator or `draggable_to`, and their own drop target validates.
* @param {Object} self - the section/portal instance rendering the tool mosaic
* @returns {boolean}
*/
export const can_tool_source = function(self) {
	return TOOL_ROW_SOURCES.has(self?.view)
}//end can_tool_source



/**
* IS_PORTAL_PAYLOAD
* Shape validation of a parsed portal-row payload. Everything that is not exactly
* this shape is FOREIGN (a ts_object node, a tool-mosaic card, a file, text).
* @param {*} payload
* @returns {boolean}
*/
export const is_portal_payload = function(payload) {
	if (!payload || typeof payload!=='object' || Array.isArray(payload)) {
		return false
	}
	const locator = payload.locator
	const optional_integer = (value) => value===undefined || value===null || (Number.isInteger(value) && value>=0)
	return payload.kind===PORTAL_ROW_KIND
		&& Boolean(locator) && typeof locator==='object' && !Array.isArray(locator)
		&& (typeof locator.section_tipo==='string' && locator.section_tipo.length > 0)
		&& (typeof locator.section_id==='string' || typeof locator.section_id==='number')
		&& String(locator.section_id).length > 0
		&& typeof payload.source_id==='string' && payload.source_id.length > 0
		&& Array.isArray(payload.draggable_to) && payload.draggable_to.every(el => typeof el==='string')
		&& optional_integer(payload.paginated_key)
		&& optional_integer(payload.index)
		&& (payload.window_generation===undefined || payload.window_generation===null || Number.isInteger(payload.window_generation))
}//end is_portal_payload



/**
* PARSE_PAYLOAD
* JSON.parse inside a guard: a foreign drop's text is not ours to throw on.
* @param {string|null|undefined} text
* @returns {*} the parsed value, or null
*/
const parse_payload = function(text) {
	if (typeof text!=='string' || text.length===0) {
		return null
	}
	try {
		return JSON.parse(text)
	} catch (error) {
		return null
	}
}//end parse_payload



/**
* HAS_PORTAL_TYPE
* @param {DataTransfer|Object|null} data_transfer
* @returns {boolean} the drag carries the portal MIME type
*/
const has_portal_type = function(data_transfer) {
	const types = data_transfer?.types
	if (!types) {
		return false
	}
	return typeof types.includes==='function'
		? types.includes(PORTAL_ROW_MIME)
		: Array.prototype.indexOf.call(types, PORTAL_ROW_MIME) !== -1 // DOMStringList
}//end has_portal_type



/**
* ROW_WINDOW_OF
* The owner's row window (`record_windows.rows`): drag, generation and `entry_of`
* always read that slot (never the mosaic `'alt'` slot).
* @param {Object} self
* @returns {Object|null} the window handle
*/
const row_window_of = function(self) {
	return self?.record_windows?.rows ?? null
}//end row_window_of



/**
* TARGET_ENTRY
* The target row's entry, read from the window's frozen entry array when the owner
* has one. LEGACY owners (views not yet on the window, until stage 5 of the row-box WC) read the
* page entries of `self.data.entries`, whose index is the same page position.
* @param {Object} self
* @param {number|undefined} target_index - page position 0..N-1
* @returns {Object|null} the target locator entry
*/
const target_entry = function(self, target_index) {
	if (!Number.isInteger(target_index) || target_index < 0) {
		return null
	}
	const record_window = row_window_of(self)
	if (record_window) {
		return target_index < record_window.size
			? (record_window.entry_of(target_index) ?? null)
			: null
	}
	return self?.data?.entries?.[target_index] ?? null
}//end target_entry



/**
* DECIDE_DROP
* THE pure decision of every drop path (mouse, touch, legacy). Reads no DOM.
*
* REORDER iff the payload came from THIS instance (`source_id === self.id` — never
* `tipo`: two instances of one portal tipo are two lists), `can_reorder(self)`,
* the target row exists and its key differs. A payload whose `window_generation`
* is not the live window's is `{kind:'stale'}`: accepted (so it does not bubble to
* an ancestor) but never sent — the rows it addressed were replaced. Generations
* are owner-monotonic per slot, so a payload from ANY superseded window is stale.
*
* MOVE iff the payload came from ANOTHER instance whose `draggable_to` names this
* portal's tipo and this portal is writable. No target row is needed: link appends
* (and the record-write chokepoint sorts a declared-order portal).
*
* @param {Object} self - the TARGET component_portal instance
* @param {Object} payload - a parsed portal-row payload
* @param {number|undefined} target_index - page position of the target row
* @returns {Object|null} {kind:'reorder', value, source_key, target_key}
*   | {kind:'move', locator} | {kind:'stale'} | null (not ours: let it bubble)
*/
export const decide_drop = function(self, payload, target_index) {

	if (!self || !is_portal_payload(payload)) {
		return null
	}

	// REORDER (same instance)
		if (payload.source_id===self.id) {
			if (!can_reorder(self)) {
				return null
			}
			const record_window = row_window_of(self)
			if (record_window && payload.window_generation!==record_window.generation) {
				return {kind : 'stale'}
			}
			const source_key = payload.paginated_key
			const entry = target_entry(self, target_index)
			const target_key = entry?.paginated_key
			if (!Number.isInteger(source_key) || !Number.isInteger(target_key) || source_key===target_key) {
				return null
			}
			return {
				kind		: 'reorder',
				value		: payload.locator,
				source_key	: source_key,
				target_key	: target_key
			}
		}

	// MOVE (another instance names this portal)
		if (payload.draggable_to.includes(self.tipo) && self.permissions>=2) {
			return {
				kind	: 'move',
				locator	: payload.locator
			}
		}

	return null
}//end decide_drop



/**
* BUILD_ROW_PAYLOAD
* The portal-row payload of row `index`, read from the window at the event.
* @param {Object} self - source component_portal instance
* @param {Object} record_window - its row window
* @param {number} index - page position
* @returns {Object|null}
*/
const build_row_payload = function(self, record_window, index) {
	const locator = record_window.entry_of(index)
	if (!locator) {
		return null
	}
	return {
		kind				: PORTAL_ROW_KIND,
		locator				: locator,
		paginated_key		: locator.paginated_key,
		index				: index,
		source_id			: self.id,
		source_tipo			: self.tipo,
		draggable_to		: draggable_to_of(self),
		window_generation	: record_window.generation
	}
}//end build_row_payload



/**
* GET_ROW_TRANSFER_DATA
* The TOOL-mosaic payload of row `index` (renames get_mosaic_transfer_data): what
* the tools' own drop targets read (the ts_object term, the coins slot). It is
* deliberately NOT a portal payload (no `kind`, never the portal MIME type), so
* every portal drop handler treats it as foreign and lets it bubble.
* @param {Object} options - {caller, index}
* @returns {Object|null}
*/
export const get_row_transfer_data = function(options) {
	const self			= options.caller
	const record_window	= row_window_of(self)
	const locator		= record_window?.entry_of(options.index) ?? null
	if (!locator) {
		return null
	}
	return {
		locator			: locator,
		paginated_key	: locator.paginated_key,
		source_tipo		: self.tipo || null,
		source_id		: self.id || null,
		draggable_to	: draggable_to_of(self)
	}
}//end get_row_transfer_data



/**
* EVENT_ELEMENT
* @param {Event} event
* @returns {Element|null} the event target, a Text node mapped to its parent
*/
const event_element = function(event) {
	const target = event?.target ?? null
	if (!target) {
		return null
	}
	return target.nodeType===3
		? target.parentElement
		: target
}//end event_element



/**
* CLEAR_MARKS
* Removes the drag marks (`.dragging`, `.dragover`) from the rows of one
* content_data — ONE query, no per-row bookkeeping.
* @param {HTMLElement} content_data
* @returns {void}
*/
const clear_marks = function(content_data) {
	const marked = content_data.querySelectorAll(':scope > .dragging, :scope > .dragover')
	for (let i = 0; i < marked.length; i++) {
		marked[i].classList.remove('dragging', 'dragover')
	}
}//end clear_marks



/**
* SET_DRAG_SOURCE
* Records the drag in progress: the payload for dragover (getData is blocked
* there) and the held row, so dragend/retire can release it.
* @param {Object} self - owner
* @param {Object} payload
* @param {Object} record_window
* @param {number} index
* @returns {void}
*/
const set_drag_source = function(self, payload, record_window, index) {
	release_drag_source()
	record_window.hold(index, 'drag')
	tmp.data	= payload
	tmp.owner	= self
	tmp.held	= {record_window, index}
}//end set_drag_source



/**
* RELEASE_DRAG_SOURCE
* Ends the drag in progress: unholds its row and clears `tmp`. With `self`, only
* when that owner is the source (the binders' dragend calls it this way). A window
* retired mid-drag releases through `release_window_drag` (its signal's abort).
* @param {Object} [self] - when given, release only if it is the drag's source
* @returns {boolean} true when something was released
*/
export const release_drag_source = function(self) {
	if (self && tmp.owner!==self) {
		return false
	}
	const held = tmp.held
	delete tmp.data
	delete tmp.owner
	delete tmp.held
	if (held) {
		held.record_window.unhold(held.index, 'drag')
	}
	return Boolean(held)
}//end release_drag_source



/**
* RELEASE_WINDOW_DRAG
* The retire/destroy path of a source window. Retiring aborts `record_window.signal`,
* which removes the binders' dragend listener: without this, a window retired
* mid-drag would leave `tmp` (payload, owner, a reference to the dead window) set
* until the next dragstart. Releases only a drag held BY THAT WINDOW, so the
* successor window of the same owner keeps its own drag.
* @param {Object} record_window
* @returns {boolean} true when something was released
*/
const release_window_drag = function(record_window) {
	if (!record_window || tmp.held?.record_window!==record_window) {
		return false
	}
	return release_drag_source()
}//end release_window_drag



/**
* NOTIFY_STALE
* The ONE notice of a stale drop (raised from the drop path only, never per
* dragover tick). Code `resource.conflict`; its own label (`drag_list_changed`,
* translated): every drag notice passes `label_key` explicitly, because
* `error_text` renders the label BEFORE the English message
* (engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, stage 3).
* @param {Object} self
* @returns {void}
*/
const notify_stale = function(self) {
	handle_api_error(new ApiError({
		code		: 'resource.conflict',
		label_key	: 'drag_list_changed',
		severity	: 'warning',
		message		: 'The list changed while the row was being dragged: nothing was moved. Drag it again.'
	}), {wrapper: self.node})
}//end notify_stale



/**
* PERFORM_DROP
* The ONE executor of an accepted decision (decide_drop). Never decides anything.
* @param {Object} self - target component_portal instance
* @param {Object} decision - a non-null decide_drop answer
* @param {Object} payload - the validated portal payload
* @returns {Promise<boolean>} true when the drop was applied
*/
const perform_drop = async function(self, decision, payload) {

	// STALE: accepted, never sent
		if (decision.kind==='stale') {
			notify_stale(self)
			return false
		}

	// REORDER (same portal): absolute keys, the offset is never added
		if (decision.kind==='reorder') {
			self.node?.classList.add('loading')
			try {
				// the locator is checked in the server against the source position:
				// a mismatch (or an out-of-range key) is refused there, not here
				const api_response = await self.sort_data({
					value		: decision.value,
					source_key	: decision.source_key,
					target_key	: decision.target_key
				})
				if (api_response?.ok===true) {
					return true
				}
				// an envelope error was already shown by the save path
				// (component_common.save → handle_api_error); anything else (save
				// guard `false`, a pre-flight refusal, an unreadable answer) was
				// silent until now — the user dropped a row and nothing moved.
				if (!request_failed(api_response)) {
					handle_api_error(new ApiError({
						code		: 'record.save_failed',
						label_key	: 'drag_order_not_saved',
						message		: 'The new order was not saved',
						raw			: api_response ?? null
					}), {wrapper: self.node})
				}
				return false
			} catch (error) {
				// (!) A THROW IS NOT "NOT SAVED". sort_data awaits change_value (the
				// save, which answers rather than throws) and THEN its own refresh,
				// which it does not catch: a rebuild failing after a COMMITTED save
				// lands here too. Claiming "not saved" would invite the user to
				// repeat a move the database already holds (the same false-failure
				// change_value refuses to report, engineering/CONVENTIONS.md §1).
				// This catch cannot tell the two apart, so it says what is TRUE in
				// both: the outcome is unconfirmed and the list must be reloaded.
				// (A repeated reorder is still refused server-side: the locator is
				// checked against the source position.)
				// Code `idempotency.outcome_unknown` (the registry's "may already have
				// been applied") with its OWN label: never a `client.*` code, whose
				// derived label would replace this sentence with a transport one.
				console.error('[drag_and_drop.perform_drop] sort_data threw (the order may or may not be saved):', error)
				handle_api_error(new ApiError({
					code		: 'idempotency.outcome_unknown',
					label_key	: 'drag_order_unconfirmed',
					severity	: 'warning',
					message		: 'The new order could not be confirmed (it may have been saved). Reload the list before reordering again.',
					raw			: error
				}), {wrapper: self.node})
				return false
			} finally {
				self.node?.classList.remove('loading')
			}
		}

	// MOVE (cross-portal): link here, then unlink there
		if (decision.kind!=='move') {
			return false
		}

		// (!) LINK FIRST, UNLINK ONLY ON A CLEAN LANDING. THE ORDER IS THE FIX.
		// Until 2026-08-30 this called link_record() WITHOUT awaiting it, discarded
		// its answer, and then unlinked the source UNCONDITIONALLY. link_records
		// never throws — it ANSWERS {linked, refused, total} and names every locator
		// that did not land (data_limit, duplicate, api_error, not_stored,
		// refused_by_server). None of that was read, so on any refusal the curated
		// relation was gone from the source portal and had never been created in the
		// target one, and the operator was shown nothing at all. A destructive step
		// must never precede the step that can fail.
		// The pristine copy is taken before the call because link_records mutates the
		// locator it is given (it stamps from_component_tipo with the TARGET's tipo).
			const source_locator	= Object.assign({}, decision.locator)
			const link_locator		= Object.assign({}, decision.locator)

			const outcome = await self.link_records([link_locator])
			if (outcome.linked.length===0) {
				// nothing landed: the source keeps its record, untouched.
				// alert(), like the picker's refusal path (component_portal.js
				// link_terms handler): the operator just made a gesture that looks
				// like a move and must not be left believing it happened.
				const reasons = outcome.refused.map(item => item.reason).filter(Boolean)
				alert(
					(get_label.error || 'Error') + ':\n'
					+ (reasons.length>0 ? reasons.join('\n') : 'refused')
				);
				return false
			}

		// remove the locator from the source portal — the target holds it now
			const source_id		= payload.source_id
			const ar_instances	= get_all_instances()

			const source_instance = ar_instances.find(el => el.id === source_id)
			if(!source_instance){
				// the record is linked in BOTH portals now. Say so: a silent return
				// here leaves a duplicate the operator never asked for and cannot
				// explain later.
				console.error(
					'(!) [drag_and_drop.perform_drop] the record was linked into the target portal but the'
					+ ' source instance is gone, so it could not be unlinked there. It is now linked in'
					+ ' BOTH portals. source_id:', source_id
				);
				return false
			}

		// (!) NEVER UNLINK WITHOUT AN id. component_portal.unlink_record sends
		// {action:'remove', id: locator.id}, and save_component.ts reads
		// `change.id ?? null` where null does not mean "remove nothing" — the server
		// now refuses it (unnamedRemoveRefusal), and an id-less locator here would
		// otherwise ask to empty the whole SOURCE portal instead of moving one record.
			const source_locator_id = source_locator.id
			if (!Number.isFinite(Number(source_locator_id)) || Number(source_locator_id)<=0) {
				console.error(
					'(!) [drag_and_drop.perform_drop] refused to unlink from the source portal: the dragged'
					+ ' locator carries no usable id, and a remove without an id clears the whole'
					+ ' component. The record is now linked in BOTH portals. locator:', source_locator
				);
				return false
			}

		// the answer is READ: a refused unlink (already surfaced by the save
		// path) leaves the record linked in BOTH portals, and a move that
		// half-happened must not be reported as a move.
			const removed = await source_instance.unlink_record(source_locator)
			if (removed!==true) {
				console.error(
					'(!) [drag_and_drop.perform_drop] the record was linked into the target portal but the'
					+ ' source portal refused to unlink it. It is now linked in BOTH portals. locator:',
					source_locator
				);
				return false
			}

	return true
}//end perform_drop



/**
* IS_TAP_ON_CONTROL
* A row-source tap that lands on a real control (an input in a line row, a tile
* button, the mosaic hover overlay) belongs to that control, never to the pick.
* @param {Element} element
* @returns {boolean}
*/
const is_tap_on_control = function(element) {
	return element.closest('input, textarea, select, button, a, [contenteditable="true"], .sr_mosaic_hover') !== null
}//end is_tap_on_control



/**
* RESOLVE_SOURCE_ROW
* The built row a drag/tap starts from, or null when the event is not a source
* gesture of this content_data (a placeholder never is: it is not built).
* @param {HTMLElement} content_data
* @param {Object} record_window
* @param {Event} event
* @param {string} source - 'handle' | 'row'
* @returns {Object|null} {node, index}
*/
const resolve_source_row = function(content_data, record_window, event, source) {
	const element = event_element(event)
	if (!element) {
		return null
	}
	const hit = row_of(content_data, element)
	if (!hit || hit.node.classList.contains('placeholder') || !record_window.is_built(hit.index)) {
		return null
	}
	if (source==='handle' && !own_handle(hit.node, element)) {
		return null
	}
	return hit
}//end resolve_source_row



/**
* OWN_HANDLE
* The `.drag` handle the event element sits in, provided it belongs to THIS row
* and not to a nested list rendered inside it. Walks from the element up to
* `row_node`: crossing another `.section_record` or `.content_data` on the way
* means the element (and any handle it found) is owned by a nested list, which
* decides its own gestures — even when it refuses them without stopping the event.
* `row_node` itself may be the handle.
* @param {HTMLElement} row_node - the row row_of resolved (direct child of content_data)
* @param {HTMLElement} element - the event element
* @returns {HTMLElement|null}
*/
const own_handle = function(row_node, element) {
	let handle = null
	for (let node = element; node; node = node.parentElement) {
		if (!handle && node.classList?.contains('drag')) {
			handle = node
		}
		if (node===row_node) {
			return handle
		}
		if (node.classList?.contains('section_record') || node.classList?.contains('content_data')) {
			return null // a nested list's row / container: not ours
		}
	}
	return null
}//end own_handle



/**
* CLAIM_ROW_BINDING
* One delegated binder per content_data per row window. A second bind under the
* same live window would add a second listener set: one drop saved twice, one tap
* picked twice. Refused loudly (a render path binding twice is a bug to see).
* A replaced window (re-render) aborted the old set, so its re-bind is allowed.
* @param {HTMLElement} content_data
* @param {Object} record_window
* @param {string} binder - name for the error line
* @returns {boolean} true when this bind may proceed
*/
const bound_row_windows = new WeakMap()
const claim_row_binding = function(content_data, record_window, binder) {
	const previous = bound_row_windows.get(content_data)
	if (previous===record_window && !record_window.signal?.aborted) {
		console.error(`[drag_and_drop.${binder}] content_data already bound under this row window: refused (one listener set only).`)
		return false
	}
	bound_row_windows.set(content_data, record_window)
	return true
}//end claim_row_binding



/**
* BIND_ROW_DRAG
* Delegated drag/drop for the rows of one portal `content_data`: ONE listener set,
* registered with the row window's AbortSignal (retire/destroy removes it).
*
* SOURCES: `source:'handle'` (default view: the `.drag` handle inside the row —
* rows stay non-draggable so their inputs keep text selection) or `source:'row'`
* (mosaic / line edit: the window stamps `draggable`). A dragstart is accepted only
* from a built row and only while `can_reorder || can_drag_out` holds AT THE EVENT
* (a view_order set after render turns the source off without a re-stamp).
*
* TARGETS: every row, placeholders included (their entry exists in the window).
*
* @param {Object} self - component_portal instance owning the rows
* @param {HTMLElement} content_data
* @param {Object} [options]
* @param {string} [options.source='handle'] - 'handle' | 'row'
* @param {Function} [options.open_position] - (index, {entry, total, release}) opens
*   the move-to-position modal (render layer); dblclick and Enter on the handle call
*   it with the row resolved and HELD at the event, `release` unholds it.
* @returns {boolean} false when nothing was bound (no row window, or already bound
*   under this window)
*/
export const bind_row_drag = function(self, content_data, options={}) {

	const source			= options.source==='row' ? 'row' : 'handle'
	const open_position		= typeof options.open_position==='function' ? options.open_position : null
	const record_window		= row_window_of(self)
	if (!record_window || !content_data) {
		console.error('[drag_and_drop.bind_row_drag] no row window on the owner: nothing bound.', self?.id)
		return false
	}
	if (!claim_row_binding(content_data, record_window, 'bind_row_drag')) {
		return false
	}
	const listener_options = {signal: record_window.signal}
	record_window.signal?.addEventListener('abort', () => release_window_drag(record_window), {once: true})

	const source_allowed = () => can_reorder(self) || can_drag_out(self)

	// dragstart (source)
		content_data.addEventListener('dragstart', function(event) {
			const hit = resolve_source_row(content_data, record_window, event, source)
			if (!hit) {
				return // not a row drag of this list (text selection, nested list…)
			}
			event.stopPropagation()
			if (!source_allowed()) {
				event.preventDefault() // the source was switched off after render
				return
			}
			const payload = build_row_payload(self, record_window, hit.index)
			if (!payload) {
				event.preventDefault()
				return
			}
			const json = JSON.stringify(payload)
			event.dataTransfer.effectAllowed = 'move'
			event.dataTransfer.setData(PORTAL_ROW_MIME, json)
			event.dataTransfer.setData('text/plain', json)
			set_drag_source(self, payload, record_window, hit.index)
			hit.node.classList.add('dragging')
		}, listener_options)

	// dragover (target)
		content_data.addEventListener('dragover', function(event) {
			if (!has_portal_type(event.dataTransfer) || !tmp.data) {
				return // foreign: bubble on
			}
			const element	= event_element(event)
			const hit		= element ? row_of(content_data, element) : null
			if (!hit) {
				return // no row under the pointer: the wrapper zone decides (MOVE)
			}
			const decision = decide_drop(self, tmp.data, hit.index)
			if (!decision) {
				return
			}
			event.preventDefault()
			event.stopPropagation()
			event.dataTransfer.dropEffect = 'move'
			if (!hit.node.classList.contains('dragover')) {
				const previous = content_data.querySelectorAll(':scope > .dragover')
				for (let i = 0; i < previous.length; i++) {
					previous[i].classList.remove('dragover')
				}
				hit.node.classList.add('dragover')
			}
		}, listener_options)

	// dragleave: clear only when the pointer left the list
		content_data.addEventListener('dragleave', function(event) {
			const related = event.relatedTarget
			if (related && content_data.contains(related)) {
				return
			}
			const previous = content_data.querySelectorAll(':scope > .dragover')
			for (let i = 0; i < previous.length; i++) {
				previous[i].classList.remove('dragover')
			}
		}, listener_options)

	// drop (target)
		content_data.addEventListener('drop', function(event) {
			if (!has_portal_type(event.dataTransfer)) {
				return
			}
			// ours (the portal MIME type): never the browser's default text drop,
			// accepted or not (FOREIGN GUARD split); no stopPropagation, so the
			// wrapper zone / an outer portal still decide a drop that is not ours here
			event.preventDefault()
			const element	= event_element(event)
			const hit		= element ? row_of(content_data, element) : null
			if (!hit) {
				return
			}
			const payload	= parse_payload(event.dataTransfer.getData(PORTAL_ROW_MIME))
			const decision	= decide_drop(self, payload, hit.index)
			if (!decision) {
				return
			}
			event.preventDefault()
			event.stopPropagation()
			clear_marks(content_data)
			perform_drop(self, decision, payload)
		}, listener_options)

	// dragend (source): marks, hold and tmp go, whatever the outcome
		content_data.addEventListener('dragend', function() {
			clear_marks(content_data)
			release_drag_source(self)
		}, listener_options)

	// move-to-position: dblclick on the handle (primary, v6) and Enter on a handle
	// reached by Tab (secondary). Entry and total are read WHEN THE EVENT FIRES.
		const open_position_at = function(event) {
			if (!open_position) {
				return
			}
			const element	= event_element(event)
			const hit		= element ? row_of(content_data, element) : null
			// the handle must be THIS row's own, not a nested list's (own_handle)
			if (!hit || !own_handle(hit.node, element)) {
				return
			}
			if (!record_window.is_built(hit.index) || !can_reorder(self)) {
				return
			}
			event.stopPropagation()
			event.preventDefault()
			record_window.hold(hit.index, 'position')
			let released = false
			const release = () => {
				if (!released) {
					released = true
					record_window.unhold(hit.index, 'position')
				}
			}
			open_position(hit.index, {
				entry	: record_window.entry_of(hit.index),
				total	: self.total,
				release	: release
			})
		}
		content_data.addEventListener('dblclick', open_position_at, listener_options)
		content_data.addEventListener('keydown', function(event) {
			if (event.key==='Enter') {
				open_position_at(event)
			}
		}, listener_options)

	// touch: tap to pick, tap to place (touch_pick.js)
		content_data.addEventListener('click', function(event) {
			if (!touch_pick.is_touch()) {
				return
			}
			const element = event_element(event)
			if (!element) {
				return
			}
			// PLACE: a pick is held. Decide on a PEEK: consuming a foreign pick here
			// would cancel it before it reached its own receiver (coins slot, term).
			if (touch_pick.active()) {
				const hit = row_of(content_data, element)
				if (!hit) {
					return
				}
				const payload	= parse_payload(touch_pick.peek())
				const decision	= decide_drop(self, payload, hit.index)
				if (!decision) {
					return
				}
				event.preventDefault()
				event.stopPropagation()
				on_drop(hit.node, touch_pick.as_drop_event(), {caller: self, index: hit.index})
				return
			}
			// PICK: a tap on a source
			const hit = resolve_source_row(content_data, record_window, event, source)
			if (!hit || (source==='row' && is_tap_on_control(element)) || !source_allowed()) {
				return
			}
			const payload = build_row_payload(self, record_window, hit.index)
			if (!payload) {
				return
			}
			event.stopPropagation()
			touch_pick.pick(JSON.stringify(payload), String(payload.locator.section_id))
		}, listener_options)

	return true
}//end bind_row_drag



/**
* BIND_TOOL_ROW_DRAG
* The tool-mosaic source binder (view_tool_cataloging_mosaic, view_coins_mosaic_portal):
* delegated dragstart + touch_pick tap, registered with the row window's signal.
* The payload is `get_row_transfer_data` JSON as `text/plain` ONLY — what the tools'
* own targets read — never the portal MIME type, so portal drop handlers treat it
* as foreign. Gate: `can_tool_source(self)`, re-checked at the event.
* @param {Object} self - instance rendering the tool mosaic
* @param {HTMLElement} content_data
* @returns {boolean} false when nothing was bound (no row window, or already bound
*   under this window)
*/
export const bind_tool_row_drag = function(self, content_data) {

	const record_window = row_window_of(self)
	if (!record_window || !content_data) {
		console.error('[drag_and_drop.bind_tool_row_drag] no row window on the owner: nothing bound.', self?.id)
		return false
	}
	if (!claim_row_binding(content_data, record_window, 'bind_tool_row_drag')) {
		return false
	}
	const listener_options = {signal: record_window.signal}
	record_window.signal?.addEventListener('abort', () => release_window_drag(record_window), {once: true})

	content_data.addEventListener('dragstart', function(event) {
		const hit = resolve_source_row(content_data, record_window, event, 'row')
		if (!hit) {
			return
		}
		event.stopPropagation()
		const transfer_data = can_tool_source(self)
			? get_row_transfer_data({caller: self, index: hit.index})
			: null
		if (!transfer_data) {
			event.preventDefault()
			return
		}
		event.dataTransfer.effectAllowed = 'move'
		event.dataTransfer.setData('text/plain', JSON.stringify(transfer_data))
		// tmp.data stays unset: no portal reads a tool payload
		release_drag_source()
		record_window.hold(hit.index, 'drag')
		tmp.owner	= self
		tmp.held	= {record_window, index: hit.index}
		hit.node.classList.add('dragging')
	}, listener_options)

	content_data.addEventListener('dragend', function() {
		clear_marks(content_data)
		release_drag_source(self)
	}, listener_options)

	content_data.addEventListener('click', function(event) {
		if (!touch_pick.is_touch() || touch_pick.active()) {
			return
		}
		const element	= event_element(event)
		const hit		= resolve_source_row(content_data, record_window, event, 'row')
		if (!hit || is_tap_on_control(element) || !can_tool_source(self)) {
			return
		}
		const transfer_data = get_row_transfer_data({caller: self, index: hit.index})
		if (!transfer_data) {
			return
		}
		event.stopPropagation()
		touch_pick.pick(JSON.stringify(transfer_data), String(transfer_data.locator.section_id ?? ''))
	}, listener_options)

	return true
}//end bind_tool_row_drag



/**
* BIND_PORTAL_DROP
* Wrapper-level MOVE zone: a record dragged from another portal may be dropped
* anywhere on this portal (an empty portal has no rows). MOVE ONLY — a reorder
* needs a target row and is decided by bind_row_drag. The wrapper lives as long as
* the instance's full render (it is not a row), so these listeners are not on the
* window's signal; a second bind on the same wrapper is a no-op.
* @param {Object} self - component_portal instance
* @param {HTMLElement} wrapper
* @returns {boolean} true when bound now
*/
const bound_drop_wrappers = new WeakSet()
export const bind_portal_drop = function(self, wrapper) {

	if (!wrapper || bound_drop_wrappers.has(wrapper)) {
		return false
	}
	bound_drop_wrappers.add(wrapper)

	const move_decision = (payload) => {
		const decision = decide_drop(self, payload, undefined)
		return decision?.kind==='move' ? decision : null
	}

	wrapper.addEventListener('dragover', function(event) {
		if (!has_portal_type(event.dataTransfer) || !move_decision(tmp.data)) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = 'move'
		wrapper.classList.add('drop_target')
	})
	wrapper.addEventListener('dragleave', function(event) {
		const related = event.relatedTarget
		if (related && wrapper.contains(related)) {
			return
		}
		wrapper.classList.remove('drop_target')
	})
	wrapper.addEventListener('drop', function(event) {
		if (!has_portal_type(event.dataTransfer)) {
			return
		}
		// ours: never the default text drop, even when not a MOVE here (FOREIGN
		// GUARD split); not stopped, an outer portal may still take it
		event.preventDefault()
		const payload	= parse_payload(event.dataTransfer.getData(PORTAL_ROW_MIME))
		const decision	= move_decision(payload)
		if (!decision) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		wrapper.classList.remove('drop_target')
		perform_drop(self, decision, payload)
	})

	return true
}//end bind_portal_drop



/**
* MOVE_TO_POSITION_DECISION
* The move-to-position modal's write keys (dblclick / Enter on the handle): the
* typed 1-based position is clamped to [0, total-1] and both keys are ABSOLUTE
* (the dragged entry's `paginated_key`; the offset is never added). Pure.
* @param {Object} self - component_portal instance (reads `total` at the call)
* @param {Object} entry - the row's entry (window `entry_of(i)` at the event)
* @param {number|string} position - what the user typed, 1-based
* @returns {Object|null} {value, source_key, target_key} or null (no move)
*/
export const move_to_position_decision = function(self, entry, position) {
	const total			= Number(self?.total)
	const source_key	= entry?.paginated_key
	const typed			= Number.parseInt(position, 10)
	if (!Number.isInteger(source_key) || !Number.isInteger(total) || total < 1 || !Number.isFinite(typed)) {
		return null
	}
	const target_key = Math.min(Math.max(typed - 1, 0), total - 1)
	if (target_key===source_key) {
		return null
	}
	return {
		value		: entry,
		source_key	: source_key,
		target_key	: target_key
	}
}//end move_to_position_decision

/**
* ON_DRAGSTART
* Initialises a drag operation from the list view of a component_portal.
* Serialises the record's locator and position into `event.dataTransfer` as JSON
* text (readable on drop), and also stores it in the `tmp` module object so that
* `on_dragover` can inspect the source tipo without triggering browser security
* restrictions on getData().
*
* Also resizes and reveals all `.drop` overlay nodes so they span their parent
* section-record row, providing visible drop targets across the full grid width.
*
* @param {HTMLElement} node - the drag-handle icon node that received the dragstart event
* @param {DragEvent} event - native browser DragEvent
* @param {Object} options - context injected by the render layer
*   @param {Object} options.locator - full locator object for the dragged record
*   @param {number} options.paginated_key - zero-based position of the record in the current page
*   @param {Object} options.caller - the component_portal instance owning this list
* @returns {boolean} always true
*/
export const on_dragstart = function(node, event, options) {
	event.stopPropagation();

	// transfer_data. Will be necessary the original locator of the section_record and
	// the paginated_key (the position in the array of data)
		const draggable_to = options.caller.properties.draggable_to || []
		const transfer_data = {
			locator			: options.locator,
			paginated_key	: options.paginated_key,
			source_tipo		: options.caller.tipo || null,
			source_id		: options.caller.id || null,
			draggable_to 	: draggable_to
		}
		// console.log('>> on_dragstart transfer_data:', transfer_data);

	// set tmp data to be used by the `dragover`
		tmp.data = transfer_data

	// data. The data will be transfer to drop in text format
		const data = JSON.stringify(transfer_data)

		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', data);


	// style the drag element to be showed in drag mode
		node.classList.add('dragging')
		// node.firstChild.classList.remove('hide')

	// get the content_data of the component_portal, it has the all section records nodes
		const content_data		= options.caller.node.content_data
		const ar_section_record	= content_data.childNodes

	// it's necessary set every drop node with the view boundaries of the grid
	// drop nodes will resize to cover the section_record
		for (let i = ar_section_record.length - 1; i >= 0; i--) {

			const section_record_node	= ar_section_record[i]
			const current_drop			= section_record_node.querySelector('.drop')

			// first node . Get the boundaries of the last node of the section_record
			// drop nodes will be resize with the height of this last_node
				const first_node		= section_record_node.firstChild // usually column 'id'
				const rect_first_node	= first_node.getBoundingClientRect();

			// last_node. Get the boundaries of the last node of the section_record
			// drop nodes will be resize with the height of this last_node
				const last_node			= section_record_node.lastChild // usually column 'remove'
				const rect_last_node	= last_node.getBoundingClientRect();

			// set height and width, width remove the padding of the grid
				const height = Math.round( rect_last_node.height )
				const width	 = Math.round( (rect_last_node.x + rect_last_node.width) - rect_first_node.x )

				current_drop.style.height	= height + 'px'
				current_drop.style.width	= width + 'px'

			// show the drop in DOM
				current_drop.classList.remove('hide')
		}


	return true
}//end on_dragstart



/**
* GET_MOSAIC_TRANSFER_DATA
* The drop payload of a mosaic tile — one builder for both gestures that carry
* it: the mouse drag (on_dragstart_mosaic) and the touch pick (touch_pick.js).
* @param {Object} options - {locator, paginated_key, caller}
* @returns {Object}
*/
export const get_mosaic_transfer_data = function(options) {
	return {
		locator			: options.locator,
		paginated_key	: options.paginated_key,
		source_tipo		: options.caller.tipo || null,
		source_id		: options.caller.id || null,
		draggable_to 	: options.caller.properties.draggable_to || []
	}
}//end get_mosaic_transfer_data



/**
* ON_DRAGSTART_MOSAIC
* Initialises a drag operation from the mosaic view of a component_portal.
* Functionally equivalent to `on_dragstart` but operates on the section-record
* node directly (the draggable tile), rather than a dedicated drag-icon handle.
* Does NOT resize drop overlays — mosaic view manages drop targets differently.
*
* @param {HTMLElement} node - the mosaic tile (section_record node) being dragged
* @param {DragEvent} event - native browser DragEvent
* @param {Object} options - context injected by the render layer
*   @param {Object} options.locator - full locator object for the dragged record
*   @param {number} options.paginated_key - zero-based position of the record in the current page
*   @param {Object} options.caller - the component_portal instance owning this mosaic
* @returns {boolean} always true
*/
export const on_dragstart_mosaic = function(node, event, options) {
	// event.preventDefault();
	event.stopPropagation();

	// will be necessary the original locator of the section_record and the paginated_key (the position in the array of data)
	const transfer_data = get_mosaic_transfer_data(options)

	// set tmp data to be used by the `dragover`
		tmp.data = transfer_data

	// the data will be transfer to drop in text format
		const data = JSON.stringify(transfer_data)

		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', data);


	// style the drag element to be showed in drag mode
	node.classList.add('dragging')

	return true
}//end on_dragstart_mosaic



/**
* ON_DRAGOVER
* Fires repeatedly while a dragged element passes over a `.drop` target node.
* Validates that the drag source is compatible with this portal (same portal, or
* the target's tipo appears in the source's `draggable_to` list), then adds the
* visual `dragover` highlight to the node.
*
* Uses `tmp.data` rather than `event.dataTransfer.getData()` because browsers
* block getData() calls during dragover for cross-origin security reasons.
*
* (!) Must call `event.preventDefault()` to signal that this is a valid drop
* target; omitting it causes the browser to reject the subsequent `drop` event.
*
* @param {HTMLElement} node - the `.drop` overlay node currently under the pointer
* @param {DragEvent} event - native browser DragEvent
* @param {Object} options - context injected by the render layer
*   @param {Object} options.caller - the component_portal instance that owns this drop node
* @returns {boolean} true when the drop is permitted; false when rejected
*/
export const on_dragover = function(node, event, options) {

	const self = options?.caller ?? null

	// foreign guard: a drag this module did not start (a thesaurus node, a file,
	// text) leaves `tmp.data` unset. It is not ours — it used to throw a TypeError
	// here AFTER preventDefault had already swallowed it. Nothing is touched before
	// the decision: a refused dragover bubbles on, ancestors still decide.
	// THE SAME DECISION AS THE DROP (drop_decision_of → decide_drop): a target the
	// drop would refuse (declared order, view_order, another instance of the same
	// tipo, no target row) is never highlighted as accepting it.
	const {decision} = drop_decision_of(self, tmp.data, options)
	if (!decision) {
		return false
	}

	event.preventDefault();
	event.stopPropagation();

	node.classList.add('dragover')

	return true
}//end on_dragover



/**
* ON_DRAGLEAVE
* Removes the `dragover` visual highlight when the dragged element leaves a
* `.drop` target node. Paired with `on_dragover`.
*
* @param {HTMLElement} node - the `.drop` overlay node the pointer left
* @param {DragEvent} event - native browser DragEvent
* @returns {void}
*/
export const on_dragleave = function(node, event) {
	event.preventDefault()
	event.stopPropagation();

	node.classList.remove('dragover')
}//end on_dragleave



/**
* ON_DRAGEND
* Cleans up after a drag operation finishes (whether or not a successful drop
* occurred). Removes the `dragging` CSS class from the drag source, resets all
* `.drop` overlay nodes back to zero size, hides them, and clears `tmp.data`.
*
* Called on the original drag source node, NOT on the drop target.
*
* @param {HTMLElement} node - the drag-handle node (same node passed to on_dragstart)
* @param {DragEvent} event - native browser DragEvent
* @param {Object} options - context injected by the render layer
*   @param {Object} options.caller - the component_portal instance that owns this list
* @returns {void}
*/
export const on_dragend = function(node, event, options) {
	event.preventDefault();
	event.stopPropagation();

	// style the drag element to be showed in drag mode
		node.classList.remove('dragging')

	// get content data, it has the section_records nodes with the drop nodes.
	// const content_data		= node.parentNode.parentNode.parentNode
	const content_data		= options.caller.node.content_data
	const ar_section_record	= content_data.childNodes

	for (let i = ar_section_record.length - 1; i >= 0; i--) {

		const section_record_node	= ar_section_record[i]
		const current_drop			= section_record_node.querySelector('.drop')
		// set the drop nodes to the original size and hide it.
		current_drop.style.height	= 0
		current_drop.style.width	= 0
		current_drop.classList.add('hide')
	}

	// clear tmp data
	delete tmp.data
}//end on_dragend



/**
* ON_DROP
* The drop ADAPTER: reads the payload from the event, decides with `decide_drop`
* and executes with `perform_drop`. Called by the delegated touch path (with the
* consumed `touch_pick.as_drop_event()`, after a peek was accepted) and by the
* legacy per-node listeners still wired by the views (until stage 5 of the row-box WC).
*
* (!) A drop that is not ours (unparseable, foreign shape, `decide_drop` null)
* returns false WITHOUT preventDefault/stopPropagation, so it reaches whoever owns
* it. Only an accepted decision is consumed.
*
* LEGACY (deleted in stage 5 together with on_dragstart / on_dragstart_mosaic):
*   - the legacy payload shape {locator, paginated_key, source_tipo, source_id,
*     draggable_to} (no `kind`) is upgraded to a portal payload whose
*     `paginated_key` is the LOCATOR's (absolute, server-stamped) key — never the
*     view's own `options.paginated_key`, which the mosaic/line views set to the
*     page index;
*   - `options.paginated_key` (no `options.index`) names the target row: the
*     page entry carrying that ABSOLUTE key when there is one (default view),
*     else the page position (mosaic/line pass the page index; on page 1 both
*     coincide and on page 2+ absolute keys are ≥ the page length, so the two
*     readings never collide outside a declared/view order, where REORDER is off).
*
* @param {HTMLElement} node - the node that received the drop (its `dragover` mark is cleared)
* @param {DragEvent|Object} event - native DragEvent, or the touch_pick drop-event shape
* @param {Object} options
*   @param {Object} options.caller - the TARGET component_portal instance
*   @param {number} [options.index] - page position of the target row
*   @param {number} [options.paginated_key] - LEGACY: see above
* @returns {Promise<boolean>} true when the drop was applied
*/
export const on_drop = async function(node, event, options) {

	const self = options?.caller ?? null
	if (!self || !event?.dataTransfer) {
		return false
	}

	// payload: the portal MIME type first, the text/plain twin second
		const data_transfer	= event.dataTransfer
		const parsed		= parse_payload(data_transfer.getData(PORTAL_ROW_MIME))
			?? parse_payload(data_transfer.getData('text/plain'))

	const {payload, decision} = drop_decision_of(self, parsed, options)
	if (!decision) {
		// ours but refused (same row, declared order, view_order…): block the
		// browser's default text drop into an editable control under the pointer,
		// but do NOT stop it — ancestors still decide. Foreign: left wholly alone.
		if (payload || has_portal_type(data_transfer)) {
			event.preventDefault?.()
		}
		return false
	}

	event.preventDefault() // Necessary. Allows us to drop.
	event.stopPropagation()
	node?.classList?.remove('dragover')

	return perform_drop(self, decision, payload)
}//end on_drop



/**
* DROP_DECISION_OF
* The adapters' ONE path to decide_drop (on_drop AND the legacy on_dragover, so a
* highlighted target is exactly a target the drop accepts): the payload upgraded
* when kind-less, the target row from `options.index` or the legacy
* `options.paginated_key`.
* @param {Object|null} self - TARGET component_portal instance
* @param {*} parsed - a parsed payload (or `tmp.data`)
* @param {Object} [options] - {index?, paginated_key?}
* @returns {{payload: Object|null, decision: Object|null}}
*/
const drop_decision_of = function(self, parsed, options) {
	const payload = is_portal_payload(parsed)
		? parsed
		: legacy_portal_payload(parsed)
	if (!self || !payload) {
		return {payload, decision: null}
	}
	const index = Number.isInteger(options?.index)
		? options.index
		: legacy_target_index(self, options?.paginated_key)
	return {payload, decision: decide_drop(self, payload, index)}
}//end drop_decision_of



/**
* LEGACY_PORTAL_PAYLOAD
* Upgrades the pre-window payload (on_dragstart / on_dragstart_mosaic) to the
* portal payload shape, or null when it is not even that. Deleted in stage 5.
* @param {*} parsed
* @returns {Object|null}
*/
const legacy_portal_payload = function(parsed) {
	if (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || 'kind' in parsed) {
		return null
	}
	const locator = parsed.locator
	if (!locator || typeof locator!=='object') {
		return null
	}
	const upgraded = {
		kind			: PORTAL_ROW_KIND,
		locator			: locator,
		paginated_key	: Number.isInteger(locator.paginated_key) ? locator.paginated_key : undefined,
		source_id		: parsed.source_id,
		source_tipo		: parsed.source_tipo,
		draggable_to	: parsed.draggable_to
	}
	return is_portal_payload(upgraded) ? upgraded : null
}//end legacy_portal_payload



/**
* LEGACY_TARGET_INDEX
* `options.paginated_key` of a legacy listener → the target page position.
* Deleted in stage 5.
* @param {Object} self
* @param {number|undefined} key
* @returns {number|undefined}
*/
const legacy_target_index = function(self, key) {
	if (!Number.isInteger(key) || key < 0) {
		return undefined
	}
	const entries = Array.isArray(self?.data?.entries) ? self.data.entries : []
	const by_key = entries.findIndex(entry => entry?.paginated_key===key)
	if (by_key !== -1) {
		return by_key
	}
	return key < entries.length ? key : undefined
}//end legacy_target_index



// @license-end
