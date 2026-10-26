// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import { clone } from '../../common/js/utils/index.js'
	import { get_instance, get_all_instances } from '../../common/js/instances.js'



/**
* DATAFRAME
* Client-side authority for the dataframe pairing contract.
* See docs/core/components/component_dataframe.md
*
* A dataframe pairs an auxiliary frame record (stored in a dedicated target
* section) with exactly ONE data item of a "main" component, using the item's
* stable server-minted `id` as the pairing key. This lets callers attach
* per-value metadata (uncertainty, sources, ratings, labels) without coupling
* it to array positions or target-record ids.
*
* Exports:
*  - DATAFRAME_TYPE            — relation-type marker constant
*  - get_dataframe_keys        — builds the pairing key object for a data item
*  - is_dataframe_entry        — detects dataframe locators in a relations bag
*  - get_dataframe             — resolves a component_dataframe instance for one item
*  - attach_dataframe_node     — render-glue for main components with explicit keys
*  - attach_item_dataframe     — render-glue for literal/relation main components
*  - delete_dataframe          — unlinks (soft-deletes) a frame from a main item
*
* Pairing contract (match predicate applied by every reader in this file):
*   type === DATAFRAME_TYPE && main_component_tipo && id_key === item.id
*
* id_key only. The legacy `section_id_key` / `section_tipo_key` shape is no longer
* read here (dual-read removed); it survives only in the old-CSV import and the
* v6→v7 update. Run the 7.0.1 dataframe_v7_migration to convert stored data.
*/



// DATAFRAME_TYPE. Ontology tipo used as the `type` field on every dataframe
// pairing locator. Must stay in sync with the PHP constant
// DEDALO_RELATION_TYPE_DATAFRAME (core/base/dd_tipos.php). Readers detect a
// dataframe entry by this marker only (see IS_DATAFRAME_ENTRY below).
export const DATAFRAME_TYPE = 'dd490'



/**
* GET_DATAFRAME_KEYS
* Builds the minimal pairing-key object for one data item of a main component.
* The returned object is spread into the options for GET_DATAFRAME or
* ATTACH_DATAFRAME_NODE so the frame locator can be matched against the
* relations bag.
*
* The pairing key is the item's stable, server-minted `id` — never the array
* index. If the item has no `id` it has not been persisted yet, and attaching
* a frame to it would create a locator that can never be matched on reload.
* Callers must follow the save-then-attach flow and only call this after the
* item has been saved and received its `id` from the server.
*
* (!) Throws instead of returning null so that callers fail visibly rather than
* silently creating orphaned or mismatched frame locators.
* @param {Object} self - main component instance (must have `section_tipo` and `tipo`)
* @param {Object} item - data item of the main component; MUST carry a non-null `id`
* @returns {Object} Pairing-key object: { id_key, main_component_tipo }
* @throws {Error} When item is falsy or has no id
*/
export const get_dataframe_keys = function(self, item) {

	if (!item || typeof item.id==='undefined' || item.id===null) {
		throw new Error('get_dataframe_keys: item without id. The pairing key is the item id, never the array index. Persist the item before attaching a dataframe.')
	}

	return {
		id_key				: item.id,
		main_component_tipo	: self.tipo
	}
}//end get_dataframe_keys



/**
* IS_DATAFRAME_ENTRY
* Returns true when `el` is a dataframe pairing locator as opposed to any
* other entry in a component's relations bag (e.g. a standard portal locator).
*
* Detection is type-only: the `type === DATAFRAME_TYPE` marker ('dd490') is the
* single source of truth (the legacy section_id_key shape is no longer detected).
* Run the 7.0.1 dataframe_v7_migration so every stored entry carries the marker.
* @param {*} el - candidate value from a relations array
* @returns {boolean} true if el is a dataframe pairing locator
*/
export const is_dataframe_entry = function(el) {

	if (!el || typeof el!=='object') {
		return false
	}
	// unified contract: the positive type marker (dd490) is the single source of truth
	return el.type===DATAFRAME_TYPE
}//end is_dataframe_entry



/**
* GET_DATAFRAME
* Resolves and builds a component_dataframe instance that is paired to one
* specific data item of a main component, injecting its data and context from
* the caller's already-loaded datum rather than issuing a separate API call.
*
* Build flow:
*  1. Validate pairing keys; return null on incomplete keys (logged as error).
*  2. Locate the component_dataframe ddo in the caller's request_config.show.ddo_map;
*     return null if not found (the slot is not wired in the ontology).
*  3. Clone the ddo as instance_options and assign a unique id_variant so the
*     instance cache can hold multiple frames for the same slot (one per item).
*  4. Call get_instance() with the cloned options — this registers the instance
*     but does NOT yet run build().
*  5. Find the matching frame locator in self.datum.data using the id_key match
*     predicate. If none exists yet, synthesise a blank locator (no frame record
*     attached but the pairing keys are set).
*  6. Find the context entry from self.datum.context, return null if absent.
*  7. Resolve view/mode from options → ddo → hard-coded defaults ('default'/'edit').
*  8. Inject datum, data, context, and caller reference onto the instance, then
*     call build(false) to produce the rendered DOM tree without a network round-trip.
*
* Time-machine: when self.matrix_id is set (inside a tool_time_machine preview),
* the frame instance is keyed by it; it gets data_source 'tm' only when the main
* itself is the TM read (self.data_source==='tm'). The match predicate is
* the same as the live one: the server never stamps matrix_id on datum items, the
* preview datum is already the grafted snapshot of that TM row.
*
* @param {Object} options - build options
* @param {Object} options.self - main component instance (must have datum, context, tipo, section_tipo, section_id)
* @param {number|string|null} options.section_id - section_id to assign to the frame instance
* @param {number|string} options.id_key - pairing key; the stable server-minted main item id
* @param {string} options.main_component_tipo - the main component's tipo
* @param {string|null} [options.view] - render view; falls back to ddo.view then 'default'
* @param {string|null} [options.mode] - render mode; falls back to ddo.mode then 'edit'
* @param {string|null} [options.lang] - language override passed to the instance
* @returns {Promise<Object|null>} A built component_dataframe instance, or null on any
*   unrecoverable error (incomplete keys, missing ddo, missing context)
*/
export const get_dataframe = async function(options) {

	// options
	const self					= options.self
	const section_id			= options.section_id
	const id_key				= options.id_key
	const main_component_tipo	= options.main_component_tipo
	const view					= options.view
	const mode					= options.mode
	const lang					= options.lang

	// pairing key sanity. A dataframe without a pairing key silently resolves the
	// wrong (or no) data: fail loudly instead
	if (typeof id_key==='undefined' || id_key===null
		|| typeof main_component_tipo==='undefined') {
		console.error('get_dataframe: incomplete pairing keys. Expected id_key (main item id) and main_component_tipo. Received:', {
			id_key				: id_key,
			main_component_tipo	: main_component_tipo,
			caller_tipo			: self?.tipo
		})
		return null
	}

	const request_config = self.context?.request_config || null

	// original_dataframe_ddo. Look up the component_dataframe ddo wired into
	// the caller's ontology request_config. If the ontology does not define a
	// dataframe slot for this main component, there is nothing to build.
	const original_dataframe_ddo = request_config
		? request_config[0]?.show?.ddo_map?.find(el => el.model === 'component_dataframe')
		: null;
	// no ddo found case, stop here
	if(!original_dataframe_ddo){
		return null
	}

	// instance_options. Clone the ddo so mutations do not corrupt the cached
	// request_config. The id_variant must be unique per (slot, item, caller)
	// tuple so the instance registry can hold simultaneous frames without
	// collision. Math.random() is appended as a tiebreaker when several renders
	// of the same item co-exist (e.g. multiple list rows open at once).
	const instance_options = clone(original_dataframe_ddo)
	instance_options.section_id	= section_id
	instance_options.id_variant	= `${instance_options.tipo}_${section_id}_${self.section_tipo}_${self.section_id}_${id_key}_${main_component_tipo}_${Math.random()}`
	instance_options.standalone	= false

	// matrix_id. When the caller lives inside a time-machine preview, propagate
	// matrix_id and include it in the id_variant to avoid cache collisions across
	// snapshots (keying only).
	if (self.matrix_id) {
		instance_options.matrix_id		= self.matrix_id
		instance_options.id_variant		= `${instance_options.id_variant}_${self.matrix_id}`
	}
	// data_source. Forwarded ONLY when the main is itself a TM read (the preview
	// main, data_source 'tm'): its frames live in that TM row, so the frame reads
	// as of it and is not subscribed to live sync_data (a live save or refresh would
	// flip the preview back to the live frames). A nested literal main of a linked
	// record inside a preview portal row also carries matrix_id (keying), but its
	// frame is a DIFFERENT record: the server would refuse the TM row for it
	// (tmRowBelongsToRecord) and answer [], so it stays a live frame, as in
	// section_record build_instance.
	if (self.data_source==='tm') {
		instance_options.data_source	= 'tm'
	}

	// add lang if is defined from options
	instance_options.lang = lang

	// component_dataframe init instance. Registers (or retrieves) the instance
	// from the global instance cache; build() has not run yet at this point.
	const component_dataframe = await get_instance(instance_options)

	// data. Retrieve the frame locator from the caller datum instead of issuing
	// a separate API request — mirrors how section_record.get_component_data()
	// works for portals. Datum.data is the flat relations bag of the main record;
	// we filter it to the entry whose (tipo, section_tipo, section_id, id_key,
	// main_component_tipo) match the target frame slot and item.
	const data = self.datum?.data?.find( function(el) {
		if( el.tipo						=== component_dataframe.tipo
			&& el.section_tipo			=== component_dataframe.section_tipo
			&& parseInt(el.section_id)	=== parseInt(component_dataframe.section_id)
			){
				// pairing predicate. Also the time machine case: the server never stamps
				// matrix_id on items, the preview datum is already the TM row's snapshot
				return (
					parseInt(el.id_key)			=== parseInt(id_key)
					&& el.main_component_tipo	=== main_component_tipo
				)
			}
		return false
	})

	// dataframe_data. If no locator found (the item has no frame yet), synthesise
	// a blank locator so the instance renders with a create-able frame button.
	// Unified contract: only id_key (the main data item id) is set.
	const dataframe_data = data
		? data
		: {
			type				: DATAFRAME_TYPE,
			id_key				: id_key,
			main_component_tipo	: main_component_tipo
		}

	// context. Find the context entry for this dataframe slot from the caller
	// datum; the context carries the component's ontology properties (label,
	// request_config, css, …). Without a context entry the frame cannot resolve
	// its own ontology properties and build() would produce a broken output.
	const context = self.datum?.context?.find( el =>
		el.tipo				=== component_dataframe.tipo
		&& el.section_tipo	=== component_dataframe.section_tipo
	)
	if (!context) {
		console.warn(`Context not found for component ${component_dataframe.tipo} in section ${component_dataframe.section_id}. Cannot proceed.`);
		return null;
	}

	// view. Get view from options. If not defined, get from ddo
	context.view = (view)
		? view
		: instance_options.view
			? instance_options.view
			: 'default'

	// mode. Get mode from options. If not defined, get from ddo
	context.mode = (mode)
		? mode
		: instance_options.mode
			? instance_options.mode
			: 'edit'

	// inject properties before build. The frame instance borrows the caller's
	// full datum so it can resolve related-component data without its own fetch;
	// caller is stored so the frame can trigger updates on its parent (e.g. after
	// creating a new frame record the main component re-renders the frame button).
	component_dataframe.datum	= self.datum
	component_dataframe.data	= dataframe_data
	component_dataframe.context	= context
	component_dataframe.caller	= self

	// build component. false = do not re-fetch data from server
	await component_dataframe.build(false)

	// caller destroyed while the frame was building: nobody will adopt (and later destroy) it
	if (self.status==='destroyed') {
		await component_dataframe.destroy(true, true, false)
		return null
	}

	return component_dataframe
}//end get_dataframe



/**
* ATTACH_DATAFRAME_NODE
* Render glue for main-component edit/list views that already hold the
* explicit pairing keys (item object with a stable `id`). Builds the paired
* frame instance via GET_DATAFRAME, registers it in self.ar_instances (so the
* main component's destroy() cascade reaches it), renders it, and appends the
* resulting node to the given container.
*
* Use this variant when the caller supplies the item directly. For literal and
* relation main components that need the opt-in `has_dataframe` check, use
* ATTACH_ITEM_DATAFRAME instead.
*
* (!) Depends on GET_DATAFRAME_KEYS which throws if item lacks `id`. Callers
* must only call this after the item has been persisted (save-then-attach flow).
* @param {Object} options - build options
* @param {Object} options.self - main component instance
* @param {Object} options.item - main data item with a stable `id`
* @param {HTMLElement} options.container - node to append the rendered frame to
* @param {string|null} [options.view] - render view override
* @param {string|null} [options.mode] - render mode override
* @param {string|null} [options.lang] - language override
* @param {string|null} [options.class_name] - optional CSS class added to the frame node
* @returns {Promise<Object|null>} The built component_dataframe instance, or null on failure
*/
export const attach_dataframe_node = async function(options) {

	const self		= options.self
	const item		= options.item
	const container	= options.container

	const component_dataframe = await get_dataframe({
		self		: self,
		section_id	: self.section_id,
		...get_dataframe_keys(self, item),
		view		: options.view,
		mode		: options.mode,
		lang		: options.lang
	})

	if (!component_dataframe) {
		return null
	}

	// add dataframe instance to component dependencies array
	self.ar_instances.push(component_dataframe)

	// render and append
	const dataframe_node = await component_dataframe.render()
	if (options.class_name) {
		dataframe_node.classList.add(options.class_name)
	}
	container.appendChild(dataframe_node)

	return component_dataframe
}//end attach_dataframe_node



/**
* ATTACH_ITEM_DATAFRAME
* Standard render-glue for literal and relation main components. Checks the
* opt-in `has_dataframe` flag, derives the pairing keys from the item (or from
* self.data.counter for blank rows), builds the frame via GET_DATAFRAME,
* registers it, renders it, and appends the node to the container.
*
* The `has_dataframe` guard (checked against both context.properties and
* self.properties for backward compatibility) ensures components that are not
* wired up to any dataframe slot simply return null without producing errors.
*
* Pairing key resolution:
*  - Persisted items  → item.id (stable server-minted id, never array index)
*  - New blank rows   → self.data.counter + 1 (PROVISIONAL; matches the
*    locator that the JSON controller's build_dataframe_subdatum() creates
*    before the item is saved; will be replaced by the real id on save)
*
* The `has_dataframe` CSS class is added to the container unconditionally once
* the guard passes, so the main component's layout can reserve space for the
* frame button regardless of whether a frame record exists yet.
* @param {Object} options - build options
* @param {Object} options.self - main component instance (must have context.properties or properties, section_id, section_tipo, tipo, view, data.counter)
* @param {Object|null} options.item - data item of the main component; null/undefined for new blank rows
* @param {HTMLElement} options.container - node to receive the dataframe button
* @param {string|null} [options.view] - render view override; falls back to self.view
* @param {string|null} [options.mode] - render mode override
* @param {string|null} [options.lang] - language override
* @param {string|null} [options.class_name] - optional CSS class added to the frame node
* @returns {Promise<Object|null>} The built component_dataframe instance, or null if
*   has_dataframe is not set or the frame cannot be resolved
*/
export const attach_item_dataframe = async function(options) {

	const self		= options.self
	const item		= options.item
	const container	= options.container

	// opt-in: the component instance must declare has_dataframe
	// (self.properties is the init-time alias of context.properties)
	if (!self.context?.properties?.has_dataframe && !self.properties?.has_dataframe) {
		return null
	}

	container.classList.add('has_dataframe')

	// id_key. Pairing key is the data item stable `id`, never the array index.
	// New blank rows use the next counter as provisional render context, matching
	// the subdatum locator created by the JSON controller (build_dataframe_subdatum)
	const id_key = item?.id ?? (self.data.counter + 1)

	const component_dataframe = await get_dataframe({
		self				: self,
		section_id			: self.section_id,
		section_tipo		: self.section_tipo,
		id_key				: id_key,
		main_component_tipo	: self.tipo,
		view				: options.view ?? self.view,
		mode				: options.mode,
		lang				: options.lang
	})

	if (!component_dataframe) {
		return null
	}

	// add dataframe instance to component dependencies array
	self.ar_instances.push(component_dataframe)

	// render and append
	const dataframe_node = await component_dataframe.render()
	if (options.class_name) {
		dataframe_node.classList.add(options.class_name)
	}
	container.appendChild(dataframe_node)

	return component_dataframe
}//end attach_item_dataframe



/**
* DELETE_DATAFRAME
* Unlinks the frame record paired to one data item of a main component by
* calling component_dataframe.unlink_record() on the already-registered
* frame instance. Optionally destroys the instance afterwards.
*
* This is the client-side entry point for the explicit "unlink frame" action
* triggered by the user in the frame modal's delete button. It is NOT the
* path used when a main item is deleted: that cascade runs server-side via
* trait.dataframe_common::remove_dataframe_data_by_id() (the single-writer
* rule). Do not call this from cascade handlers.
*
* The client removes the LOCATOR only. What happens to the frame TARGET record
* is the server's decision, from the slot node's delete policy (unlink /
* delete_target; the v6 `hard_delete: true` is inert — a target row is never
* removed) — applied after the unlink has committed.
*
* Steps:
*  1. Validate pairing keys (id_key, main_component_tipo); return false
*     on failure (logged as error).
*  2. Find the component_dataframe ddo in self.request_config_object.show.ddo_map;
*     return false if absent.
*  3. Find the matching live instance in the global instance registry using the
*     id_key pairing predicate.
*  4. Select the STORED frame entries paired to (id_key, main_component_tipo)
*     — those carrying an `id` — and call instance.unlink_record(entries).
*  5. If delete_instace===true, call instance.destroy() to remove it from the
*     registry and DOM.
*
* (!) Note: `delete_instace` has a typo in the options key (missing 'n'). This
* is intentional preservation of the existing API; do NOT rename it.
* @param {Object} options - delete options
* @param {Object} options.self - main component instance (must have request_config_object)
* @param {number|string} options.section_id - section_id of the HOST record the frame instance renders on
* @param {string} options.section_tipo - section_tipo of the HOST record
* @param {number|string} options.id_key - pairing key; the stable server-minted main item id
* @param {string} options.main_component_tipo - main component's tipo
* @param {boolean} [options.delete_instace=false] - if true, destroy the frame instance after unlink
* @returns {Promise<boolean>} true on success, false on any pre-condition failure
*/
export const delete_dataframe = async function(options) {

	const self = options.self

	// options
		const section_id			= options.section_id
		const section_tipo			= options.section_tipo
		const id_key				= options.id_key
		const main_component_tipo	= options.main_component_tipo
		const delete_instace		= options.delete_instace || false

	// pairing key sanity
	if (typeof id_key==='undefined' || id_key===null
		|| typeof main_component_tipo==='undefined') {
		console.error('delete_dataframe: incomplete pairing keys. Expected id_key (main item id) and main_component_tipo. Received:', {
			id_key				: id_key,
			main_component_tipo	: main_component_tipo,
			caller_tipo			: self?.tipo
		})
		return false
	}

	// ddo_dataframe. Confirm the caller's ontology config actually wires a
	// component_dataframe slot; without it there is no registered instance to
	// unlink from, and the operation cannot proceed.
		const ddo_dataframe = self.request_config_object?.show?.ddo_map?.find(el => el.model==='component_dataframe')

		if(!ddo_dataframe){
			return false
		}

		// Look up the live frame instance by the pairing predicate so we operate
		// on the exact instance that was registered during the current render,
		// not a stale one from a previous render cycle.
		const all_instances = get_all_instances()
		const component_dataframe = all_instances.find(el =>
			el.model							=== 'component_dataframe'
			&& el.tipo							=== ddo_dataframe.tipo
			&& el.section_tipo					=== ddo_dataframe.section_tipo
			&& parseInt(el.section_id)			=== parseInt(section_id)
			&& parseInt(el.data.id_key)			=== parseInt(id_key)
			&& el.data.main_component_tipo		=== main_component_tipo
		)

	if(!component_dataframe){
		return false
	}

	// unlink the frame(s): remove their locators from the slot. The target
	// record's fate is the SERVER's, from the slot node's delete policy
	// (unlink / delete_target —
	// src/core/relations/dataframe.ts). The stored entries are selected by
	// their PAIRING (id_key + main_component_tipo — `section_id` here is the
	// HOST record's, the frame target's id is unknown to the caller), and
	// unlink_record builds each `remove` from `el.id`, so only entries WITH an
	// id can be removed — a locator without one removes nothing (see
	// drag_and_drop.js "NEVER UNLINK WITHOUT AN id").
		const frame_locators = (component_dataframe.data?.entries || []).filter(el =>
			parseInt(el.id_key)===parseInt(id_key)
			&& el.main_component_tipo===main_component_tipo
			&& typeof el.id!=='undefined' && el.id!==null
		)
		if (frame_locators.length===0) {
			const entries = component_dataframe.data?.entries
			if (Array.isArray(entries) && entries.length>0) {
				// entries exist but none paired carries an id — a real defect
				console.error('delete_dataframe: no stored frame entry with an id is paired to', {id_key, main_component_tipo}, component_dataframe.data)
			}
			// else: a frame-less item (nothing attached yet) — nothing to unlink, not an error
			return false
		}
		const removed = await component_dataframe.unlink_record(frame_locators)
		// READ: a refused unlink (already surfaced by the save path) keeps the
		// frame on the record — destroying its instance would leave the screen
		// asserting a deletion that did not happen
		if (removed!==true) {
			return false
		}

	// remove the instance
		if(delete_instace===true){
			await component_dataframe.destroy(
				true, // delete_self
				true, // delete_dependencies
				true // remove_dom
			)
		}

	return true
}//end delete_dataframe



// @license-end
