// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* THESAURUS_PICKER
* THE one definition of "this thesaurus picks terms for that component".
*
* Before this module the pick was published from TWO places
* (ts_object/js/render_ts_id_column.js and section/js/view_thesaurus_list_section.js)
* and wired from TWO more (tools/tool_indexation, tools/tool_cataloging), each with its
* own copy of the window resolution and its own idea of who may be picked. That fork is
* why a SEARCH RESULT could never be picked outside the indexation tool. This module
* replaces all four with one wiring call, one publisher and one term control.
*
* THE MODEL IS tool_indexation's, deliberately. The thesaurus is not a widget this
* module builds: it is an ordinary area_thesaurus INSTANCE, built and rendered by the
* standard element machinery, mounted inside whatever surface hosts it (the tool's left
* pane; the component's own tree view). This module never constructs an area, never owns
* a modal and never manages a lifecycle — everything that tried to do so was the cost of
* leaving that machinery, and it is gone.
*
* ONE STEP. A click on a selectable term publishes it immediately; the locator lands in
* the caller and the operator sees it there. There is no tray, no pending selection and
* no confirm: batching bought nothing (the server re-resolves the remaining capacity on
* every insert, so N sequential picks are capped exactly as a batch of N would be), and a
* pending selection only ever existed to replace the feedback an occluding modal took
* away. Picking several terms is several clicks.
*
* THE AUTHORITY LINE (do not blur it):
*  - The SERVER decides whether a read is a picker at all: `context[0].thesaurus_mode`
*    ('relation' | 'default') is derived from the caller declared in
*    `rqo.source.caller`, never from a client string. This module NEVER upgrades a
*    server 'default' to 'relation'.
*  - The SERVER decides how many terms may be linked: `context[0].picker` carries
*    `{selection_limit, remaining, targets}` — the resolved `properties.data_limit` of
*    the caller and its remaining capacity. This module NEVER re-derives that cap.
*  - The SERVER decides whether a given term may be linked, per node: root terms carry
*    `root_terms_selectable:[{section_tipo, section_id, selectable}]` on the area data
*    item, deeper nodes carry the same answer in the node's own `is_indexable` flag.
*    This module evaluates NO selectability predicate of its own; it renders the answer.
*  - The CALLER decides insert-versus-replace. A single-valued component (`data_limit:1`)
*    replaces its locator on a new pick; that belongs to the component, which owns its
*    value, not to the picker, which only reports what the operator chose.
*
* WHAT A NON-SELECTABLE NODE LOOKS LIKE: NO link control at all. The arrow means "this
* term can be linked", so it is drawn only where that is true — structural/grouping
* levels stay walkable and stay clean. A control that IS drawn may still be disabled and
* titled (already linked, or the caller is at capacity), but it is never a dead click.
*
* Exported functions:
*   attach_picker            — wire an area_thesaurus instance as a picker for a caller
*   publish_link_terms       — the ONE publisher of a pick
*   render_term_pick_control — the ONE builder of a term's link affordance
*   term_selectability       — read the server's per-node answer (never compute one)
*   get_picker               — resolve the picker from a ts_object/section instance
*   PICKER_LINK_CHANNEL_PREFIX — the event_manager channel prefix
*
* Contract with the server: engineering/AREA_SPEC.md §5 (picker contract).
*/

// imports
	import {ui} from '../../common/js/ui.js'



/**
* PICKER_LINK_CHANNEL_PREFIX
* event_manager channel a pick is published on: `<prefix><linker.id>`.
*
* The payload is an ARRAY. One-step picking always publishes length 1 — but the array is
* the wire, not a concession to a retired tray: the import and maintenance doors
* legitimately hand over several locators at once, and one shape for both keeps a single
* subscriber in the caller.
*/
export const PICKER_LINK_CHANNEL_PREFIX = 'link_terms_'



/**
* WARNED_LABEL_KEYS
* Label keys already reported as missing from the catalog. A missing key is a defect
* (the catalog is repo-owned and gated by test/unit/labels_tripwire.test.ts), so it is
* reported once per page instead of on every render.
*/
const warned_label_keys = new Set()



/**
* PICKER_LABEL
* Resolve a user-visible string from the repo-owned label catalog.
*
* No English fallback literal: an untranslated key must be visible as the KEY (so it is
* greppable and obviously wrong) and reported, never silently replaced by a hard-coded
* string that would then outlive the catalog entry. Console diagnostics are developer
* text and stay in English; only DOM/title strings come through here.
*
* @param {string} key - Catalog key, e.g. 'picker_term_not_selectable'.
* @returns {string} The catalog value, or the key itself when the catalog lacks it.
*/
const picker_label = function(key) {

	const value = get_label[key]
	if (typeof value==='string' && value.length>0) {
		return value
	}

	if (!warned_label_keys.has(key)) {
		warned_label_keys.add(key)
		console.error(`(!) [thesaurus_picker] missing label catalog key: ${key}. Define it in src/core/labels/master.json`);
	}

	return key
}//end picker_label



/**
* TERM_KEY
* Canonical, index-independent identity of a term (section_tipo + section_id).
* Positional identity is never used: the server addresses selectability by locator, and
* the rendered state must survive a re-render that reorders the tree.
*
* section_id is stringified — the same rule utils' same_section_id applies — because the
* wire mixes numbers (server data) and strings (DOM datasets) for the same record.
*
* @param {Object} term - Object carrying section_tipo and section_id.
* @returns {string} e.g. 'hierarchy1_66'
*/
const term_key = function(term) {

	return String(term?.section_tipo ?? '') + '_' + String(term?.section_id ?? '')
}//end term_key



/**
* NORMALIZE_TERM
* Reduce any node-ish object (ts_object instance, root_term descriptor, list row) to the
* three fields the pick channel carries. Nothing else travels: the caller resolves the
* locator's `type`, `from_component_tipo` and friends server-side.
*
* @param {Object} term - Source object with at least section_tipo and section_id.
* @returns {Object|null} {section_tipo, section_id, label} or null when unaddressable.
*/
const normalize_term = function(term) {

	if (!term || !term.section_tipo || term.section_id===undefined || term.section_id===null) {
		return null
	}

	return {
		section_tipo	: term.section_tipo,
		section_id		: term.section_id,
		label			: term.label ?? ''
	}
}//end normalize_term



/**
* READ_LINKED_TERMS
* Read the caller component's CURRENT locators so already-linked terms render as such.
*
* THE SHAPE IS `data.entries`. `self.data` is an OBJECT, not an array
* (component_portal.js:659 `self.data = self.data || {}`, :776), and `entries` is the
* locator array every relation model answers with (:695, :1231, :1379). An earlier
* version of this read used `data[0].value`, which is `undefined` on every real
* component: the picker then believed nothing was linked, showed active arrows on
* already-held terms, and reset `remaining` to the full limit on every reopen.
*
* It reads only that universal field and deliberately does NOT reach into
* component_portal internals: this module must stay usable by any linker component.
*
* @param {Object} linker - The component instance the pick will be published to.
* @returns {Array} Array of {section_tipo, section_id} (possibly empty).
*/
const read_linked_terms = function(linker) {

	const entries = linker?.data?.entries
	if (!Array.isArray(entries)) {
		return []
	}

	return entries
		.map(locator => normalize_term(locator))
		.filter(term => term!==null)
}//end read_linked_terms



/**
* BUILD_ROOT_SELECTABILITY_MAP
* Index the server's per-root-term selectability answer by locator.
*
* Shape on the wire (relation mode only, area read):
*   data[i].value[j].root_terms_selectable = [{section_tipo, section_id, selectable}]
*
* Absent in default mode, and absent for the deeper nodes this read does not serve —
* those carry their own answer in the node's `is_indexable` flag.
*
* @param {Object} area_instance - The built area_thesaurus instance.
* @returns {Map} Map<term_key, boolean>
*/
const build_root_selectability_map = function(area_instance) {

	const map = new Map()

	const data = Array.isArray(area_instance?.data)
		? area_instance.data
		: []

	for (const data_item of data) {

		const hierarchy_nodes = Array.isArray(data_item?.value)
			? data_item.value
			: []

		for (const hierarchy_node of hierarchy_nodes) {

			const declared = hierarchy_node?.root_terms_selectable
			if (!Array.isArray(declared)) {
				continue
			}

			for (const item of declared) {
				map.set(term_key(item), item.selectable===true)
			}
		}
	}

	return map
}//end build_root_selectability_map



/**
* TERM_SELECTABILITY
* The server's answer to "may this term be linked?", read — never computed.
*
* Three server channels, in precedence order:
*  1. `root_terms_selectable` from the area read (root terms of each hierarchy).
*  2. the node's own `is_indexable` flag (every deeper node, from get_node_data /
*     get_children_data, and list rows via the section read).
*  3. `selectability_declared:false` — the row's section declares NO per-term
*     contract at all, so there is nothing to be selectable ABOUT and the write
*     gate already exempts it (relations/save.ts gate 3). Selectable.
*
* Channel 3 is not a guess, and this is the distinction the whole function turns on:
* the server states "this section has no is_indexable component", the same predicate
* the write gate reads (ontology/section_map.declaresTermSelectability). Without it a
* People row — a legitimate, gate-authorized pick — answered nothing on channels 1-2
* and silently lost its link arrow. Withholding an affordance on silence is the same
* defect as offering one on a guess.
*
* A term that NO channel answers for is still UNKNOWN and still refused: that means a
* section which DOES declare the contract failed to answer for this row.
*
* @param {Object} picker - The picker returned by attach_picker.
* @param {Object} node - {section_tipo, section_id, is_indexable?, selectability_declared?}
* @returns {boolean|null} true | false | null (unknown)
*/
export const term_selectability = function(picker, node) {

	if (!picker || !node) {
		return null
	}

	// root terms. The area read answers these by locator
		const declared = picker.root_selectability.get(term_key(node))
		if (declared!==undefined) {
			return declared
		}

	// deeper nodes. The node itself carries the answer
		if (node.is_indexable===true || node.is_indexable===false) {
			return node.is_indexable
		}

	// no contract. The section has no selectable-term flag, which the write gate
	// treats as "nothing to re-ask" — so the affordance is offered, on the server's
	// own statement and not on an inference from a missing key.
		if (node.selectability_declared===false) {
			return true
		}

	return null
}//end term_selectability



/**
* GET_PICKER
* Resolve the picker from any instance that holds the linker pointer (ts_object rows and
* the thesaurus list section both carry `linker`). One hop, no caller-chain walk and no
* DOM ancestry: the picker is stored on the linker by attach_picker.
*
* @param {Object} instance - ts_object / section instance carrying `linker`.
* @returns {Object|null} The picker, or null when this tree is not a picker.
*/
export const get_picker = function(instance) {

	return instance?.linker?.picker ?? null
}//end get_picker



/**
* ATTACH_PICKER
* Wire a BUILT area_thesaurus instance as a term picker for one caller.
*
* This is the wiring tool_indexation performs inline today (three assignments: mode,
* caller, linker). It is a FUNCTION taking its caller as an argument precisely so any
* surface can reuse it — nothing here reads the DOM, the caller chain, or the portal.
*
* MODE GRANT. Two paths, and only two:
*  - The read declared a caller (`area_instance.picker_caller`, folded into
*    `rqo.source.caller` by area_thesaurus.generate_rqo): the SERVER's
*    `context.thesaurus_mode` is the answer, whatever it says. A server 'default' means
*    the picker was not granted — the tree browses and says why.
*  - The read declared no caller (tool_indexation / tool_cataloging, which open the
*    thesaurus as their own indexing surface and have no caller ddo to derive from):
*    the tool declares relation mode itself. This is the ONE client-side assignment of
*    thesaurus_mode = 'relation' in the codebase, and it is a named exemption, not a
*    loophole: no caller-declared read exists to contradict.
*
* @param {Object} area_instance - Built area_thesaurus (or area_ontology) instance.
* @param {Object} options
*   @param {Object} options.linker - Component instance the pick is published to. Must
*     carry `id`; its own `.caller` decides the target window (see publish_link_terms).
*   @param {Object} options.caller - The instance that owns this picker (tool, component
*     view, list cell). Passed in, never discovered.
*   @param {Object} [options.constraint] - `{selection_limit, remaining, targets}` from
*     `context.picker`. Defaults to the area's own context.picker.
*   @param {Array}  [options.linked] - Already-linked terms. Defaults to the linker's
*     current `data[0].value`.
* @returns {Object|null} The picker, or null when the wiring is incomplete (loud).
*/
export const attach_picker = function(area_instance, options={}) {

	// mandatory wiring. A missing piece is a defect in the host, not a degraded mode
		if (!area_instance || !area_instance.context) {
			console.error('(!) [attach_picker] refused: area_instance must be BUILT (context is required)', area_instance);
			return null
		}
		const linker = options.linker
		if (!linker || !linker.id) {
			console.error('(!) [attach_picker] refused: options.linker with an id is mandatory', options);
			return null
		}
		const caller = options.caller
		if (!caller) {
			console.error('(!) [attach_picker] refused: options.caller is mandatory (the picker never discovers its caller)', options);
			return null
		}

	// mode. Server-derived when the read declared a caller; tool-declared otherwise
		const caller_declared	= !!area_instance.picker_caller
		const server_mode		= area_instance.context.thesaurus_mode ?? null
		const mode				= caller_declared
			? (server_mode==='relation' ? 'relation' : 'default')
			: 'relation'
		// (!) the ONE client-side thesaurus_mode assignment (see the MODE GRANT note).
		area_instance.context.thesaurus_mode = mode

	// constraint. The resolved cap, verbatim from the server. Never re-derived here
		const constraint = options.constraint ?? area_instance.context.picker ?? null
		// selection_limit: null = uncapped. 0 = nothing may be linked (honoured as such)
		const selection_limit = (constraint && constraint.selection_limit!==undefined)
			? constraint.selection_limit
			: null
		// remaining: room LEFT, not the raw limit. null = uncapped
		const remaining = (constraint && constraint.remaining!==undefined && constraint.remaining!==null)
			? constraint.remaining
			: null
		const targets = Array.isArray(constraint?.targets)
			? constraint.targets
			: []

	// picker
		const picker = {
			// identity
			area				: area_instance,
			linker				: linker,
			caller				: caller,
			// server answers
			mode				: mode,
			selection_limit		: selection_limit,
			targets				: targets,
			// Is a term's ADDRESS its whole identity for this linker?
			// True for a caller-declared picker: the component holds a set of
			// locators, so the same address twice is a duplicate. False for a
			// tool-declared one (indexation, cataloguing), where the same term is
			// linked once per tag and only the server's key ([section_id,
			// section_tipo, type, tag_id]) can judge a duplicate. Derived from the
			// SAME fact that grants the mode, so there is no second declaration.
			address_is_identity	: caller_declared,
			root_selectability	: build_root_selectability_map(area_instance),
			// live state. `remaining` moves as the operator picks, so the affordance
			// stops being offered at the cap instead of failing at the write
			remaining			: remaining,
			linked				: (options.linked ?? read_linked_terms(linker))
									.map(term => normalize_term(term))
									.filter(term => term!==null),
			// subscribers of state changes (the term controls repaint themselves)
			subscribers			: new Set()
		}

	/**
	* NOTIFY
	* Fire every subscriber after a state change. Subscribers re-render their own node;
	* the picker never touches DOM it does not own.
	*/
		const notify = function() {
			for (const subscriber of picker.subscribers) {
				try {
					subscriber(picker)
				} catch (error) {
					console.error('Error in thesaurus_picker subscriber:', error);
				}
			}
		}

	/**
	* SUBSCRIBE
	* @param {Function} subscriber - called with the picker on every change.
	* @returns {Function} unsubscribe
	*/
		picker.subscribe = function(subscriber) {
			picker.subscribers.add(subscriber)
			return () => picker.subscribers.delete(subscriber)
		}

	/**
	* IS_LINKED
	* @param {Object} term - {section_tipo, section_id}
	* @returns {boolean}
	*/
		picker.is_linked = function(term) {

			const key = term_key(term)
			return picker.linked.some(item => term_key(item)===key)
		}

	/**
	* HAS_ROOM
	* Whether one more term fits. Read by the term controls to stop offering an
	* affordance BEFORE the click, instead of refusing after it.
	*
	* A SINGLE-VALUED caller (`selection_limit === 1`) always has room: its next pick
	* REPLACES, which is what "one value" means. The caller performs that replacement —
	* it owns its value — so the picker must not withhold the affordance.
	*
	* @returns {boolean}
	*/
		picker.has_room = function() {

			if (picker.mode!=='relation') {
				return false
			}
			if (picker.selection_limit===1) {
				return true
			}
			return picker.remaining===null || picker.remaining>0
		}

	/**
	* NOT_LINKABLE_KEY
	* The named reason the picker is not offering links at all, or null when it is.
	* @returns {string|null}
	*/
		picker.not_linkable_key = function() {

			if (picker.mode!=='relation') {
				return 'picker_browse_only'
			}
			if (!picker.has_room()) {
				return 'picker_no_capacity'
			}

			return null
		}

	/**
	* PICK
	* THE action: publish one term to the caller, now.
	*
	* Optimistically records the term as linked and decrements the remaining room so the
	* tree repaints immediately. The SERVER remains the authority — it re-resolves the cap
	* and the target on the insert and may still refuse — and the caller re-reads its own
	* value on the save response, which corrects this optimism either way.
	*
	* @param {Object} raw_term - {section_tipo, section_id, label?}
	* @param {boolean|null} [selectable] - the server's answer for this node.
	* @returns {Object} {status:'linked'|'refused', reason_key:string|null}
	*/
		picker.pick = function(raw_term, selectable=true) {

			const term = normalize_term(raw_term)
			if (!term) {
				return { status: 'refused', reason_key: 'picker_term_not_addressable' }
			}

			// state refusals, each named
				const blocked = picker.not_linkable_key()
				if (blocked!==null) {
					return { status: 'refused', reason_key: blocked }
				}
				// (!) ALREADY-LINKED IS ONLY A REFUSAL WHERE THE ADDRESS IS THE WHOLE
				// IDENTITY. In indexation the same term is legitimately linked many
				// times over — once per TAG — and the server's dedup key carries that
				// dimension ([section_id, section_tipo, type, tag_id]) while this
				// client-side set does not. Refusing here on the address alone would
				// make "tag person X at fragment 2 after tagging them at fragment 1"
				// impossible until a page reload, which is the indexation tool's
				// central workflow. So the refusal applies only when the picker is
				// caller-declared (a component holding a locator SET, where a second
				// identical address really is a duplicate); an indexation-style linker
				// publishes and lets the server's fuller key decide.
				if (picker.address_is_identity && picker.is_linked(term)) {
					return { status: 'refused', reason_key: 'picker_term_already_linked' }
				}
				if (selectable!==true) {
					return {
						status		: 'refused',
						reason_key	: selectable===false
							? 'picker_term_not_selectable'
							: 'picker_term_selectability_unknown'
					}
				}

			// publish. The pick reaches the caller now — one step, no confirm
				const published = publish_link_terms(linker, [term])
				if (published!==true) {
					return { status: 'refused', reason_key: 'picker_link_failed' }
				}

			// optimistic local state
				if (picker.selection_limit===1) {
					// single-valued: the caller replaces, so the tree shows one linked term
					picker.linked = [term]
				} else {
					picker.linked.push(term)
					if (picker.remaining!==null) {
						picker.remaining = picker.remaining - 1
					}
				}
				notify()

			return { status: 'linked', reason_key: null }
		}

	/**
	* SYNC_LINKED
	* Re-read the caller's locators and repaint. Called by the host after the caller's
	* save response lands, so the optimistic state above is replaced by the stored truth
	* (a server refusal, a dedup, or a replacement the caller performed).
	*
	* @param {Array} [terms] - explicit list; defaults to re-reading the linker.
	* @returns {boolean}
	*/
		picker.sync_linked = function(terms) {

			picker.linked = (terms ?? read_linked_terms(linker))
				.map(term => normalize_term(term))
				.filter(term => term!==null)

			// remaining is derived again from the cap the server gave us
			if (picker.selection_limit!==null && picker.selection_limit!==1) {
				picker.remaining = Math.max(0, picker.selection_limit - picker.linked.length)
			}
			notify()

			return true
		}

	/**
	* DESTROY
	* Drop the subscribers and the back-pointers. The AREA's own lifecycle is not this
	* module's business — it belongs to the instance machinery that built it.
	*/
		picker.destroy = function() {

			picker.subscribers.clear()

			if (linker.picker===picker) {
				linker.picker = null
			}
			if (area_instance.picker===picker) {
				area_instance.picker = null
			}

			return true
		}

	// wiring. The three assignments tool_indexation performs inline today
		area_instance.caller	= caller
		area_instance.linker	= linker
		area_instance.picker	= picker
		// the tree rows reach the picker through the linker they already carry
		linker.picker			= picker

	// debug
		if (SHOW_DEBUG===true) {
			console.log('[attach_picker] wired picker:', {
				mode			: mode,
				caller_declared	: caller_declared,
				selection_limit	: selection_limit,
				remaining		: remaining,
				targets			: targets
			});
		}


	return picker
}//end attach_picker



/**
* PUBLISH_LINK_TERMS
* THE publisher of a pick. One channel, one array payload.
*
* Window resolution (the line duplicated verbatim in the two retired publishers):
* `!linker.caller ? window.opener : window`. Note it reads the LINKER COMPONENT's
* `.caller`, NOT the area's — two different objects. A linker with no caller was opened
* through a separate browser window (the DS deep-link), so its event_manager lives on
* the opener; an in-page linker (indexation, a component's own tree view) owns the
* current window's. A linker whose node lives in THIS document is in-page too,
* caller or not (tree-row components are built caller-less).
*
* @param {Object} linker - Component instance waiting for the pick (needs `id`).
* @param {Array} terms - Array of {section_tipo, section_id, label}, length >= 1.
* @returns {boolean} true when the message reached at least one subscriber.
*/
export const publish_link_terms = function(linker, terms) {

	// linker
		if (!linker || !linker.id) {
			console.error('(!) [publish_link_terms] refused: a linker with an id is mandatory', linker);
			return false
		}

	// terms. An array, always — a one-step pick is the length-1 case
		if (!Array.isArray(terms) || terms.length<1) {
			console.error('(!) [publish_link_terms] refused: terms must be a non-empty array', terms);
			return false
		}
		const payload = terms
			.map(term => normalize_term(term))
			.filter(term => term!==null)
		if (payload.length!==terms.length) {
			console.error('(!) [publish_link_terms] refused: every term must carry section_tipo and section_id', terms);
			return false
		}

	// window_base. Reads the LINKER's caller, never the area's. A linker rendered in
	// THIS document is in-page even without a caller: components opened inline in a
	// ts_object row (Ontology/Thesaurus tree) are built caller-less, and sending their
	// pick to window.opener lost it.
		const in_page = !!linker.caller || linker.node?.ownerDocument===document
		const window_base = in_page
			? window // default case (in-page tree view, indexation, tree-row component)
			: window.opener // the linker lives in the window that opened this one
		if (!window_base || !window_base.event_manager) {
			console.error('(!) [publish_link_terms] refused: no event_manager on the target window (opener closed?)', linker);
			return false
		}

	// publish. Two ways the pick can fail to land, and BOTH must be loud:
	//  - `false`        : nothing is subscribed to the channel.
	//  - empty array [] : subscribers existed but every one of them THREW. The bus
	//                     isolates subscribers (each runs in its own try/catch), so
	//                     a failing handler no longer propagates an exception up to
	//                     here — the empty result set is the only evidence left.
	//                     Without this branch a thrown-away pick reported SUCCESS.
		const result = window_base.event_manager.publish(PICKER_LINK_CHANNEL_PREFIX + linker.id, payload)
		if (result===false || result.length===0) {
			console.error(
				`(!) [publish_link_terms] no subscriber took the pick on ${PICKER_LINK_CHANNEL_PREFIX}${linker.id}`
				+ (result===false
					? ' (nothing is subscribed).'
					: ' (every subscriber threw — see the [event_manager] error above).')
				+ ' The pick was LOST.'
			);
			return false
		}

	// debug
		if (SHOW_DEBUG===true) {
			console.log('[publish_link_terms] published:', PICKER_LINK_CHANNEL_PREFIX + linker.id, payload);
		}


	return true
}//end publish_link_terms



/**
* RENDER_TERM_PICK_CONTROL
* THE builder of a term's link affordance — used by the tree row (id column) and by the
* thesaurus list row alike, so both surfaces offer exactly the same thing. That shared
* definition is what makes a SEARCH RESULT pickable: before it, the list row's link
* button was gated on the caller being tool_indexation.
*
* Three outcomes, and no fourth:
*   - not selectable / unknown→ NO control (returns null). The arrow means "linkable";
*                               drawing it everywhere would bury the terms that are.
*   - selectable + room       → an active control; one click links the term
*   - selectable, but already linked or the caller is at capacity
*                             → a disabled, titled control: the operator sees WHY,
*                               and a linked term stays visible as linked.
*
* @param {Object} options
*   @param {Object} options.picker - from attach_picker.
*   @param {Object} options.term - {section_tipo, section_id, label}
*   @param {boolean|null} [options.selectable] - the server's answer; when omitted it is
*     read with term_selectability from the term itself.
*   @param {HTMLElement} [options.parent] - append target.
* @returns {HTMLElement|null} The control node; null when the term is not selectable or
*                              the wiring is incomplete.
*/
export const render_term_pick_control = function(options={}) {

	const picker = options.picker
	if (!picker) {
		console.error('(!) [render_term_pick_control] refused: options.picker is mandatory', options);
		return null
	}

	const term = normalize_term(options.term)
	if (!term) {
		console.error('(!) [render_term_pick_control] refused: options.term must carry section_tipo and section_id', options);
		return null
	}

	const selectable = options.selectable!==undefined
		? options.selectable
		: term_selectability(picker, options.term)

	// NO ANSWER, NO ARROW. A term the thesaurus does not declare linkable gets NO
	// control at all — not a disabled one. This is the established behaviour of the id
	// column (`if (is_indexable===false) break`) and it is the right one: the link arrow
	// MEANS "this term can be indexed", so painting a dimmed arrow on every structural
	// level turns a clean tree into a wall of arrows and makes the operator hunt for the
	// few that work. Absence is the signal.
	// `null` (the server answered for neither channel) is treated the same way: an
	// affordance must never be offered on a guess.
		if (selectable!==true) {
			return null
		}

	// control. Same classes as the retired publishers so the CSS is unchanged
		const control = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'id_column_link ts_object_related',
			parent			: options.parent
		})
		// payload on the node, for consumers that read the DOM (drag, tests)
		control.data = term

	// icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button arrow_link',
			parent			: control
		})

	/**
	* UPDATE
	* Paint the control from the picker's current state. Called on build and on every
	* change, so a term that becomes unreachable (cap reached) stops offering the
	* affordance immediately instead of failing on click.
	*/
		let was_connected = false
		const update = function() {

			// self-healing: a row removed by a re-render (collapse, search, pagination)
			// would otherwise keep this closure — and its detached node — alive for the
			// whole life of the picker. The tree re-renders a lot; this must not grow.
			// (!) `was_connected` guards the build-time call, when the control is still
			// in a fragment and legitimately not connected yet.
			if (control.isConnected===true) {
				was_connected = true
			} else if (was_connected===true && typeof control.picker_unsubscribe==='function') {
				control.picker_unsubscribe()
				control.picker_unsubscribe = null
				return
			}

			// Mirrors pick()'s rule: the address is the whole identity only for a
			// caller-declared picker. An indexation term already tagged elsewhere must
			// keep an ACTIVE arrow — it can be tagged again, under another tag.
			const is_linked = picker.address_is_identity && picker.is_linked(term)

			// reason. null = the control is active.
			// Selectability is NOT a case here: a non-selectable term never reached this
			// point (the early return above gave it no control at all), so the only
			// reasons a rendered arrow is inert are "already linked" and "no capacity".
			const reason_key = is_linked
				? 'picker_term_already_linked'
				: picker.not_linkable_key()

			control.classList.toggle('disabled', reason_key!==null)
			control.classList.toggle('linked', is_linked)

			control.title = reason_key!==null
				? picker_label(reason_key)
				: picker_label('link_resource')
		}
		update()

	// click. One step: the term is linked now. A refusal is named on the control itself
		const click_handler = (e) => {
			e.stopPropagation()

			const result = picker.pick(term, selectable)
			if (result.status==='refused') {
				control.title = picker_label(result.reason_key)
				return false
			}
		}
		control.addEventListener('click', click_handler)

	// keep the control in sync with the picker's state
		const unsubscribe = picker.subscribe(update)
		control.picker_unsubscribe = unsubscribe


	return control
}//end render_term_pick_control



// @license-end
