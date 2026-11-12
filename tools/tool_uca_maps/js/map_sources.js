// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* MAP_SOURCES
* The XYZ and WMS layers a user adds live in the record, as the geolocation entry's
* `sources`, and the component draws them through the tile proxy (`build_source_layers`).
* The tool only edits that list, through the component's own save path: adding or deleting
* a layer IS the commit ("Add and save"), because the proxy can only serve a source the
* server has numbered.
*
* @module map_sources
*/



import {request_failed} from '../../../core/common/js/api_error.js'
import {MAX_ATTRIBUTION_LENGTH} from './core_limits.js'



/** C0, DEL, C1 and the Unicode line/paragraph separators: what the core's `checkText`
* refuses in an attribution (`src/core/geo/checked.ts` isControlCode). */
const is_control_code = (code) => code<=0x1f || (code>=0x7f && code<=0x9f) || code===0x2028 || code===0x2029



/**
* PLAIN_ATTRIBUTION
* An attribution as the server keeps it: plain text (no `<` or `>`), no control character
* (a line break in a WMS `<Title>` becomes a space), runs of white space as one, trimmed,
* at most MAX_ATTRIBUTION_LENGTH. Normalized here, so the save is not refused and a source
* compares equal to the one the record stores.
*
* @param {*} text
* @returns {string}
*/
export const plain_attribution = function(text) {

	const spaced = Array.from(String(text ?? ''), (char) => is_control_code(char.codePointAt(0)) ? ' ' : char).join('')

	return spaced.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ATTRIBUTION_LENGTH).trim()
}//end plain_attribution



/**
* STORED_SOURCES
* The sources the record stores, numbered by the server, optionally of one `type`. An
* unnumbered source (a refused save left it in the model) has no tile the proxy could serve.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} [type] - 'xyz' | 'wms'
* @returns {Array<Object>} the stored source objects (read-only: never mutate them)
*/
export const stored_sources = function(self, type) {

	const entry		= self.geolocation && self.geolocation.get_stored_entry(0)
	const sources	= entry && Array.isArray(entry.sources) ? entry.sources : []

	return sources.filter((source) => source
		&& Number.isInteger(source.id) && source.id>0
		&& (type===undefined || source.type===type))
}//end stored_sources



/**
* SOURCE_LAYER
* The component's own Leaflet layer for a stored source, or null.
*
* @param {Object} self - tool_uca_maps instance
* @param {number} id - the source's number
* @returns {Object|null} Leaflet TileLayer
*/
export const source_layer = function(self, id) {

	const item = self.geolocation && self.geolocation.source_layers
		? self.geolocation.source_layers['stored:' + id]
		: null

	return item ? item.layer : null
}//end source_layer



/**
* REAPPLY_SOURCE_OPACITY
* A save rebuilds every source layer of the component at full opacity
* (`build_source_layers`): the values this session set (`self._source_opacity`, by source
* number) go back on.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const reapply_source_opacity = function(self) {

	for (const [id, opacity] of Object.entries(self._source_opacity || {})) {
		const layer = source_layer(self, Number(id))
		if (layer) {
			layer.setOpacity(opacity)
		}
	}
}//end reapply_source_opacity



/**
* SAVE_SOURCES
* Replaces the entry's `sources` with `edit(current)` and saves the component. The save
* sends the whole entry buffer, so edits pending in it (view, drawings) are committed with
* it, exactly as the component's own save button does; a refused save puts the previous
* list back in the buffer and leaves the dirty flag alone.
*
* @param {Object} self - tool_uca_maps instance
* @param {function(Array<Object>): Array<Object>} edit - gets a copy, returns the new list
* @returns {Promise<{ok: boolean, new_ids?: Array<number>}>} new_ids: numbers the save added
*/
export const save_sources = async function(self, edit) {

	const geolocation	= self.geolocation
	const before_ids	= new Set(stored_sources(self).map((source) => source.id))

	const buffer	= geolocation.get_entry_buffer(0)
	const previous	= buffer.sources
	const next		= edit(Array.isArray(previous) ? previous.map((source) => ({...source})) : [])
	if (next.length>0) {
		buffer.sources = next
	} else {
		delete buffer.sources
	}

	const changed_data_item = geolocation.build_changed_data_item(0)
	const api_response = changed_data_item
		? await geolocation.change_value({changed_data: [changed_data_item], refresh: false})
		: false

	if (!api_response || request_failed(api_response) || geolocation.data_degraded===true) {
		const live = geolocation.current_value && geolocation.current_value[0]
		if (live) {
			if (previous===undefined) {
				delete live.sources
			} else {
				live.sources = previous
			}
		}
		return {ok: false}
	}

	// the whole buffer was committed: nothing left to save
	geolocation.is_data_changed = false
	reapply_source_opacity(self)

	const new_ids = stored_sources(self)
		.map((source) => source.id)
		.filter((id) => !before_ids.has(id))

	return {ok: true, new_ids}
}//end save_sources



/**
* ADD_SOURCE
* Appends `source` (no id: the server numbers it) and saves; the layer the component
* builds for it is switched on, since the user asked to see it. A source equal to one the
* record already stores is not saved twice (the server would number a copy): that one is
* switched on.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} source - {type, url, params, attribution}
* @returns {Promise<{ok: boolean, id?: number}>}
*/
export const add_source = async function(self, source) {

	let id = find_equal_source_id(self, source)
	if (id===null) {
		const result = await save_sources(self, (list) => [...list, source])
		if (!result.ok) {
			return {ok: false}
		}
		id = result.new_ids[0] ?? null
	}

	// the tool may have been torn down while the save was on the wire
	const map	= self.geolocation && self.geolocation.map
	const layer	= id!==null ? source_layer(self, id) : null
	if (layer && map && !map.hasLayer(layer)) {
		layer.addTo(map)
	}

	return {ok: true, id: id ?? undefined}
}//end add_source



/**
* FIND_EQUAL_SOURCE_ID
* The number of the stored source with the same type, address and parameters, or null.
* The attribution is left out: it is the layer's credit, not what it draws, so a second
* spelling of it would save the same tiles twice.
*
* @param {Object} self
* @param {Object} source
* @returns {number|null}
*/
const find_equal_source_id = function(self, source) {

	// key by key: the record's jsonb hands the params back in its own key order
	const same_params = (a, b) => {
		const [left, right] = [a || {}, b || {}]
		const keys = Object.keys(left)
		return keys.length===Object.keys(right).length
			&& keys.every((key) => Object.hasOwn(right, key) && left[key]===right[key])
	}
	const match = stored_sources(self, source.type).find((stored) => stored.url===source.url
		&& same_params(stored.params, source.params))

	return match ? match.id : null
}//end find_equal_source_id



/**
* DELETE_SOURCE
* Removes the stored source numbered `id` and saves.
*
* @param {Object} self - tool_uca_maps instance
* @param {number} id
* @returns {Promise<{ok: boolean}>}
*/
export const delete_source = async function(self, id) {

	if (!stored_sources(self).some((source) => source.id===id)) {
		return {ok: false}
	}

	const result = await save_sources(self, (list) => list.filter((source) => source.id!==id))

	return {ok: result.ok}
}//end delete_source



// @license-end
