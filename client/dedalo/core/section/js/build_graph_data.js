// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* BUILD_GRAPH_DATA
* Graph data helpers for the section graph view.
*
* Converts a Dédalo section datum (the {context, data} pair already loaded in
* the edit client) into a graph structure composed of *nodes* (records) and
* *links* (relations between records). The module also provides async helpers
* that lazily expand the graph one hop at a time by requesting additional
* datums from the server.
*
* Key concepts:
* - A **node** represents a single record: { id, section_tipo, section_id, label,
*   is_root, expanded, loaded }.
*   `id` is always `section_tipo + '_' + section_id` so it can be used as a
*   stable graph identity key.
* - A **link** represents a directed relation: { source, target, parent_id,
*   relation_tipo, relation_label [, is_inverse] }.
*   `source` / `target` are node ids. Inverse relations (records pointing *to*
*   the root, fetched via relation_list) carry `is_inverse: true`.
* - A **datum** is the standard Dédalo API read result: `{ context: [...], data: [...] }`.
*   `context` items describe the section/component structure; `data` items carry
*   the actual component values (entries).
*
* Exports:
*   RELATION_MODELS       — constant list of relation-bearing component models
*   build_model_map       — index context by section_tipo_tipo key
*   build_section_maps    — extract section_map objects from context
*   resolve_label         — best-effort record label from datum data
*   is_fallback_label     — detect unresolved placeholder labels
*   extract_relations     — collect outgoing relation locators from a record
*   extract_node_fields   — collect displayable non-relation field values
*   datum_to_graph        — build initial graph from the root record's datum
*   fetch_section_datum   — load a single record datum via the API
*   fetch_section_terms   — batch-resolve display terms via the API
*   apply_section_terms   — apply server-returned terms to graph node labels
*   fetch_node_relations  — lazily expand a node's outgoing edges
*   upgrade_fallback_labels — upgrade provisional node labels in bulk
*   parse_relation_list_response — parse relation_list API response into graph objects
*   fetch_inverse_relations — fetch records that point *to* the root record
*/

// imports
	import {data_manager} from '../../common/js/data_manager.js'
	import {clone, strip_tags} from '../../common/js/utils/index.js'
	import {get_term_tipos, get_fields_separator} from '../../common/js/section_map.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'



/**
* RELATION_MODELS
* Client-side mirror of `component_relation_common::get_components_with_relations()`.
*
* The exhaustive list of component model names whose `entries` array contains
* locators (`{ section_tipo, section_id }`) pointing to other section records.
* Any datum item whose context model appears in this list is treated as a
* *graph edge source* rather than a displayable field value.
*
* Keep in sync with the PHP server-side equivalent when new relation component
* types are added to the system.
*/
export const RELATION_MODELS = [
	'component_autocomplete',
	'component_autocomplete_hi',
	'component_check_box',
	'component_dataframe',
	'component_filter',
	'component_filter_master',
	'component_inverse',
	'component_portal',
	'component_publication',
	'component_radio_button',
	'component_relation_children',
	'component_relation_index',
	'component_relation_model',
	'component_relation_parent',
	'component_relation_related',
	'component_relation_struct',
	'component_select',
	'component_select_lang'
]



/**
* BUILD_MODEL_MAP
* Index datum.context by a compound key so that any component can be looked up
* in O(1) during data traversal.
*
* The key is `section_tipo + '_' + tipo` (e.g. `'dd123_dd456'`), matching the
* pattern used throughout datum.data items. The value is the raw context object,
* which carries at minimum `{ tipo, section_tipo, model, label }`.
*
* Context items missing either `tipo` or `section_tipo` are silently skipped
* because they cannot form a valid lookup key.
*
* @param {Object} datum - Standard Dédalo datum `{ context: [...], data: [...] }`
* @returns {Object} map keyed by `section_tipo_tipo`; values are context objects
*/
export const build_model_map = function(datum) {

	const map = {}

	const context = datum?.context || []
	const context_length = context.length
	for (let i = 0; i < context_length; i++) {
		const ctx = context[i]
		if (!ctx || !ctx.tipo) {
			continue
		}
		map[ctx.section_tipo + '_' + ctx.tipo] = ctx
	}

	return map
}//end build_model_map



/**
* STRIP_HTML
* Reduce a stored value to its human-readable TEXT (tags removed, entities
* decoded) through the inert <template> parser of util.strip_tags — one parse,
* no regex pass (a `/<[^>]*>/` strip is incomplete on nested fragments like
* `<scr<b>ipt>`, CodeQL #7941).
*
* Not a sanitiser and never needs to be one: every label/value it feeds is
* rendered as a text node (view_graph_edit_section.js text_content), and the
* server terms that bypass it (get_section_terms) are rendered the same way.
* Non-string / falsy input is returned as-is (preserves null/undefined
* so callers can still distinguish "no value" from "empty string").
*
* @param {string} str - Raw string possibly containing HTML markup
* @returns {string} The text content of `str`, or the original value
*   unchanged when it is not a non-empty string
*/
const strip_html = function(str) {

	if (!str || typeof str !== 'string') return str

	return strip_tags(str)
}//end strip_html



/**
* BUILD_SECTION_MAPS
* Collect section_map configuration objects from a datum's context array,
* keyed by `section_tipo`.
*
* Context items with `model === 'section'` may carry an optional
* `section_map` property (the resolved display-configuration tree that
* drives term/label resolution via `section_map.js`). This function
* extracts those mappings so they are available for label resolution
* without requiring additional server round-trips.
*
* Only context items that carry a non-null `section_map` are included;
* sections without a configured map are omitted silently (callers fall
* back to heuristic or fallback labels in that case).
*
* @param {Object} datum - Standard Dédalo datum `{ context: [...], data: [...] }`
* @returns {Object} maps keyed by `section_tipo`; values are section_map objects
*/
export const build_section_maps = function(datum) {

	const maps = {}

	const context = datum?.context || []
	const context_length = context.length
	for (let i = 0; i < context_length; i++) {
		const ctx = context[i]
		if (!ctx || ctx.model !== 'section') continue
		const sm = ctx?.section_map
		if (sm) {
			maps[ctx.section_tipo] = sm
		}
	}

	return maps
}//end build_section_maps



/**
* EXTRACT_TEXT
* Best-effort flattening of a component `entries` value into a readable string.
*
* Different component types store their resolved value under different keys.
* This function probes each entry for known display-value keys in order of
* precedence: `value` → `literal` → `term` → `label`. Plain string and number
* entries are accepted directly. HTML markup is stripped before joining.
*
* The function is intentionally lenient: null/undefined entries and entries
* with no recognisable text key are silently skipped rather than throwing.
*
* @param {*} entries - A single value or array of values from a datum data item's
*   `entries` field. May be null, undefined, a string, a number, or an object
*   with any of the recognised display-value keys.
* @returns {string} Comma-separated, HTML-stripped text parts, or an empty
*   string when no displayable text is found
*/
const extract_text = function(entries) {

	if (entries===null || entries===undefined) {
		return ''
	}

	const arr = Array.isArray(entries) ? entries : [entries]
	const parts = []
	const arr_length = arr.length
	for (let i = 0; i < arr_length; i++) {
		const el = arr[i]
		if (el===null || el===undefined) {
			continue
		}
		if (typeof el === 'string' || typeof el === 'number') {
			parts.push(strip_html(String(el)))
		}else if (typeof el === 'object') {
			const value = el.value ?? el.literal ?? el.term ?? el.label ?? null
			if (value!==null && (typeof value === 'string' || typeof value === 'number')) {
				parts.push(strip_html(String(value)))
			}
		}
	}

	return parts.filter(Boolean).join(', ').trim()
}//end extract_text



/**
* RESOLVE_LABEL
* Find a readable display label for a record, using only the data already
* present in the provided datum (no additional API calls).
*
* Resolution strategy (first hit wins):
*   0. **section_map term tipos** — if the section has a section_map, the
*      term tipo(s) it declares are looked up in datum.data. Multiple term
*      tipos are joined with the section_map's own `fields_separator`. This
*      is the authoritative label (same logic as the PHP section_map resolver).
*   1. **Heuristic scan** — the first non-relation, non-section_id data item
*      for this record whose `entries` yield non-empty text.
*   2. **Context section label** — if the section context carries a `label`
*      property (e.g. the section type's display name such as "Cecas"), use it
*      as a section-type-level fallback.
*   3. **Fallback** — `section_tipo · section_id` placeholder string, detectable
*      by `is_fallback_label()` for later upgrade.
*
* @param {Object} datum        - Standard Dédalo datum `{ context, data }`
* @param {string} section_tipo - Ontology tipo of the target section
* @param {string} section_id   - Record identifier (compared as string)
* @param {Object} model_map    - Pre-built map from `build_model_map(datum)`
* @param {Object} [section_maps] - Optional section_map objects keyed by section_tipo,
*   from `build_section_maps(datum)`. When present, enables strategy 0.
* @returns {string} A human-readable label, or the fallback placeholder string
*/
export const resolve_label = function(datum, section_tipo, section_id, model_map, section_maps) {

	const fallback	= section_tipo + ' · ' + section_id
	const data		= datum?.data || []
	const data_length = data.length

	// 0. try section_map term tipos for precise label resolution
	// (all term tipos of the resolved scope, joined with its separator)
		const section_map	= section_maps?.[section_tipo]
		const term_tipos	= get_term_tipos(section_map)
		if (term_tipos.length) {
			const parts = []
			for (let t = 0; t < term_tipos.length; t++) {
				const term_tipo = term_tipos[t]
				for (let i = 0; i < data_length; i++) {
					const item = data[i]
					if (item.section_tipo!==section_tipo || String(item.section_id)!==String(section_id) || item.tipo!==term_tipo) {
						continue
					}
					const piece = extract_text(item.entries)
					if (piece) {
						parts.push(piece)
					}
					break // one item per tipo
				}
			}
			if (parts.length) {
				return parts.join(get_fields_separator(section_map))
			}
		}

	// 1. heuristic: first non-relation, non-section_id value
		for (let i = 0; i < data_length; i++) {
			const item = data[i]
			if (item.section_tipo!==section_tipo || String(item.section_id)!==String(section_id)) {
				continue
			}
			const ctx	= model_map[item.section_tipo + '_' + item.tipo]
			const model	= ctx?.model || item.debug_model || ''
			if (RELATION_MODELS.includes(model) || model==='component_section_id') {
				continue
			}
			const label = extract_text(item.entries)
			if (label) {
				return label
			}
		}

	// 2. try the context section label (e.g. "Cecas", "Bibliografía")
		const context = datum?.context || []
		const context_length = context.length
		for (let i = 0; i < context_length; i++) {
			const ctx = context[i]
			if (ctx.section_tipo===section_tipo && ctx.tipo===section_tipo && ctx.label) {
				return ctx.label
			}
		}

	return fallback
}//end resolve_label



/**
* IS_FALLBACK_LABEL
* Detect provisional placeholder labels so they can be targeted for upgrade.
*
* A fallback label is either empty/null or starts with the pattern
* `"section_tipo · "` (produced by the final branch of `resolve_label`).
* Upgrade routines use this predicate to skip nodes that already have a
* real display value and avoid redundant API calls.
*
* @param {string} label        - The current node label to test
* @param {string} section_tipo - The ontology tipo of the node's section
* @returns {boolean} true when the label is a provisional placeholder
*/
export const is_fallback_label = function(label, section_tipo) {
	return !label || label.indexOf(section_tipo + ' · ')===0
}//end is_fallback_label



/**
* EXTRACT_RELATIONS
* Collect every outgoing relation declared by the relation components of a
* given record inside the provided datum.
*
* Only datum data items that (a) belong to the specified root record and
* (b) have a model listed in `RELATION_MODELS` are considered. For each
* such item, every entry that carries a valid `{ section_tipo, section_id }`
* locator is emitted as a relation descriptor.
*
* The function does not filter out self-references; the caller is responsible
* for skipping edges where source === target.
*
* @param {Object} datum             - Standard Dédalo datum `{ context, data }`
* @param {string} root_section_tipo - Ontology tipo of the owning section
* @param {string} root_section_id   - Record identifier of the owning record
* @param {Object} model_map         - Pre-built map from `build_model_map(datum)`
* @returns {Array} Array of relation descriptors:
*   `[{ locator: { section_tipo, section_id }, relation_tipo, relation_label }]`
*   where `section_id` is always a string.
*/
export const extract_relations = function(datum, root_section_tipo, root_section_id, model_map) {

	const relations	= []
	const data		= datum?.data || []
	const data_length = data.length

	for (let i = 0; i < data_length; i++) {
		const item = data[i]
		// only components belonging to the root record itself
		if (item.section_tipo!==root_section_tipo || String(item.section_id)!==String(root_section_id)) {
			continue
		}
		const ctx	= model_map[item.section_tipo + '_' + item.tipo]
		const model	= ctx?.model || item.debug_model || ''
		if (!RELATION_MODELS.includes(model)) {
			continue
		}
		const entries = Array.isArray(item.entries) ? item.entries : []
		const entries_length = entries.length
		for (let j = 0; j < entries_length; j++) {
			const loc = entries[j]
			if (!loc || !loc.section_tipo || !loc.section_id) {
				continue
			}
			relations.push({
				locator			: {
					section_tipo	: loc.section_tipo,
					section_id		: String(loc.section_id)
				},
				relation_tipo	: item.tipo,
				relation_label	: ctx?.label || item.debug_label || item.tipo
			})
		}
	}

	return relations
}//end extract_relations



/**
* BUILD_NODE
* Factory that constructs a normalised graph node object from raw options.
*
* The `id` field is always `section_tipo + '_' + section_id` (the canonical
* graph identity key used throughout the module for deduplication and link
* source/target references).
*
* `expanded` and `loaded` are both true only for the root node — non-root
* nodes start unexpanded and unloaded; the graph expands them lazily via
* `fetch_node_relations`.
*
* @param {Object} options
* @param {string} options.section_tipo - Ontology tipo of the node's section
* @param {string|number} options.section_id - Record identifier (coerced to string)
* @param {string} options.label    - Human-readable display label
* @param {boolean} [options.is_root=false] - Whether this is the central/root record
* @returns {Object} Graph node: `{ id, section_tipo, section_id, label,
*   is_root, expanded, loaded }`
*/
const build_node = function(options) {
	return {
		id				: options.section_tipo + '_' + options.section_id,
		section_tipo	: options.section_tipo,
		section_id		: String(options.section_id),
		label			: options.label,
		is_root			: options.is_root === true,
		expanded		: options.is_root === true, // root starts expanded
		loaded			: options.is_root === true  // root data already in client
	}
}//end build_node



/**
* DATUM_TO_GRAPH
* Build the initial graph (central record + its direct relations) reusing the
* data already loaded in the edit client — no additional API call is made.
*
* The root node (`is_root: true`, `expanded: true`, `loaded: true`) is always
* the first element of the returned `nodes` array. Linked records become
* unloaded, unexpanded satellite nodes whose labels are resolved from the
* same datum (which may already contain their data if they were loaded as
* related records). Nodes are deduplicated by id; multiple relations pointing
* to the same target produce only one node but multiple links.
*
* Also seeds `section_maps` from `self.context.config.section_map` (the root
* section's own display config) so label resolution has the authoritative
* scope object from the first render.
*
* @param {Object} self - Section instance in edit mode. Must provide:
*   `self.datum`, `self.section_tipo`, `self.section_id`,
*   optionally `self.rqo` and `self.context.config.section_map`.
* @returns {Object} `{ nodes, links, section_maps }` — nodes and links arrays
*   ready to be consumed by the graph renderer; section_maps accumulator for
*   subsequent label-upgrade calls.
*/
export const datum_to_graph = function(self) {

	const datum			= self.datum
	const model_map		= build_model_map(datum)
	const section_maps	= build_section_maps(datum)
	// also seed root section's section_map from self.context.config
	const root_sm = self?.context?.config?.section_map
	if (root_sm) {
		section_maps[self.section_tipo] = root_sm
	}
	const root_tipo		= self.section_tipo
	const root_id_value	= String(self.section_id)
	const root_id		= root_tipo + '_' + root_id_value

	// root node
		const root_label = resolve_label(datum, root_tipo, root_id_value, model_map, section_maps)
		const nodes = [
			build_node({
				section_tipo	: root_tipo,
				section_id		: root_id_value,
				label			: root_label,
				is_root			: true
			})
		]

	// direct relations
		const links			= []
		const relations		= extract_relations(datum, root_tipo, root_id_value, model_map)
		const relations_len	= relations.length
		for (let i = 0; i < relations_len; i++) {
			const rel = relations[i]
			const tid = rel.locator.section_tipo + '_' + rel.locator.section_id
			if (tid===root_id) {
				continue // skip self reference
			}
			if (!nodes.find(n => n.id===tid)) {
				nodes.push(build_node({
					section_tipo	: rel.locator.section_tipo,
					section_id		: rel.locator.section_id,
					label			: resolve_label(datum, rel.locator.section_tipo, rel.locator.section_id, model_map, section_maps)
				}))
			}
			links.push({
				source			: root_id,
				target			: tid,
				parent_id		: root_id,
				relation_tipo	: rel.relation_tipo,
				relation_label	: rel.relation_label
			})
		}

	return { nodes, links, section_maps }
}//end datum_to_graph



/**
* FETCH_SECTION_DATUM
* Read a single record's full datum (context + data) from the server.
*
* Clones `self.rqo` as a template and overrides its source/sqo fields so the
* server loads exactly the requested record via `filter_by_locators`. Key
* overrides applied:
* - `source.view = 'default'` — prevents the server from dispatching into the
*   graph view handler, which would cause infinite recursion.
* - `source.session_save = false` — graph-driven lookups must not overwrite the
*   user's central navigation SQO stored in the session; they are read-only
*   side-reads.
* - `source.session_key` and `rqo.id`/`rqo.show` are deleted to ensure a clean
*   record-level read.
*
* Returns `null` on network error or if the API returns no result.
*
* @param {Object} self       - Central section instance (supplies the rqo template)
* @param {string} section_tipo - Ontology tipo of the section to read
* @param {string} section_id   - Record identifier to fetch
* @returns {Promise<Object|null>} The datum `{ context, data }`, or null on failure
*/
export const fetch_section_datum = async function(self, section_tipo, section_id) {

	try {
		// rqo template from the central section
			const rqo = self.rqo ? clone(self.rqo) : { source:{} }

			rqo.action			= 'read'
			rqo.source			= rqo.source || {}
			rqo.source.tipo			= section_tipo
			rqo.source.section_tipo	= section_tipo
			rqo.source.model		= 'section'
			rqo.source.typo			= 'sections'
			rqo.source.mode			= 'edit'
			rqo.source.view			= 'default' // avoid graph view dispatch on the server
			rqo.source.session_save	= false // never overwrite the central section navigation session SQO (graph reads are lookups, not navigation)
			delete rqo.source.session_key
			delete rqo.source.section_id
			delete rqo.id
			delete rqo.show

			rqo.sqo = {
				section_tipo		: [section_tipo],
				limit				: 1,
				offset				: 0,
				filter_by_locators	: [{
					section_tipo	: section_tipo,
					section_id		: section_id
				}]
			}

		// api request
			const api_response = await data_manager.request({
				body : rqo
			})

			if (SHOW_DEBUG===true && request_failed(api_response)) {
				console.warn('[build_graph_data.fetch_section_datum] failed:', api_response.error)
			}

		return response_data(api_response) || null

	} catch (error) {
		console.error('[build_graph_data.fetch_section_datum] error:', error)
		return null
	}
}//end fetch_section_datum



/**
* FETCH_SECTION_TERMS
* Batch-resolve authoritative display terms for a set of records via the
* `get_section_terms` API endpoint — one HTTP request for the entire graph.
*
* This is a lightweight alternative to loading a full datum per node: the
* server resolves only the section_map term string for each locator and
* returns a flat map. Sections that do not define a section_map term are
* omitted from the response, so the client's own provisional label is preserved
* for those nodes (rather than being overwritten with an empty string).
*
* Duplicates in the `locators` input are deduplicated before the request so
* the payload stays minimal regardless of graph size.
*
* The `lang` code from `self.lang` or `self.rqo.source.lang` is forwarded when
* available so the server resolves terms in the same language currently
* displayed to the user.
*
* @param {Object} self     - Section instance (used as lang source)
* @param {Array}  locators - Array of `{ section_tipo, section_id }` objects
*   (e.g. the `nodes` array from `datum_to_graph`; extra properties are ignored)
* @returns {Promise<Object>} Map keyed `${section_tipo}_${section_id}` → term string;
*   empty object on error or when no locators are provided
*/
export const fetch_section_terms = async function(self, locators) {

	try {
		if (!Array.isArray(locators) || locators.length===0) {
			return {}
		}

		// build a deduped minimal locator list
		const seen = {}
		const ar_locators = []
		const locators_length = locators.length
		for (let i = 0; i < locators_length; i++) {
			const n = locators[i]
			if (!n || !n.section_tipo || n.section_id===undefined || n.section_id===null) {
				continue
			}
			const key = n.section_tipo + '_' + n.section_id
			if (seen[key]) {
				continue
			}
			seen[key] = true
			ar_locators.push({ section_tipo: n.section_tipo, section_id: String(n.section_id) })
		}
		if (ar_locators.length===0) {
			return {}
		}

		const rqo = {
			action		: 'get_section_terms',
			locators	: ar_locators
		}
		// match the displayed data lang when available; server defaults otherwise
		const lang = self?.lang || self?.rqo?.source?.lang || null
		if (lang) {
			rqo.lang = lang
		}

		const api_response = await data_manager.request({ body : rqo })

		if (SHOW_DEBUG===true && request_failed(api_response)) {
			console.warn('[build_graph_data.fetch_section_terms] failed:', api_response.error)
		}

		const result = response_data(api_response)
		return (result && typeof result === 'object') ? result : {}

	} catch (error) {
		console.error('[build_graph_data.fetch_section_terms] error:', error)
		return {}
	}
}//end fetch_section_terms



/**
* APPLY_SECTION_TERMS
* Overwrite node labels with authoritative terms returned by `fetch_section_terms`.
*
* The `terms` map is keyed by `node.id` (`section_tipo + '_' + section_id`),
* which is identical to the key structure used by `fetch_section_terms`. Only
* non-empty terms override a node's current label, so a section that has a
* configured section_map but an empty resolved value keeps whatever provisional
* label the client previously assigned.
*
* Nodes are mutated in place; the return value indicates whether any label
* actually changed so the caller can skip a DOM refresh when nothing changed.
*
* @param {Array}  nodes - Graph node array (mutated in place)
* @param {Object} terms - Map from `fetch_section_terms`: `{ node_id → term_string }`
* @returns {boolean} true when at least one node label was updated
*/
export const apply_section_terms = function(nodes, terms) {

	if (!terms || !Array.isArray(nodes)) {
		return false
	}

	let changed = false
	const nodes_length = nodes.length
	for (let i = 0; i < nodes_length; i++) {
		const node = nodes[i]
		const term = terms[node.id]
		if (term && term !== node.label) {
			node.label = term
			changed = true
		}
	}

	return changed
}//end apply_section_terms



/**
* FETCH_NODE_RELATIONS
* Lazily expand a graph node by fetching its full datum from the server and
* extracting its outgoing relations as child nodes and links.
*
* Also opportunistically upgrades the node's label when it was a provisional
* fallback and the fetched datum contains a better literal. Any section_maps
* found in the fetched datum are merged into the shared `section_maps`
* accumulator (first-seen value wins; existing entries are not overwritten).
*
* The returned nodes/links are *candidates* — the caller is responsible for
* deduplication against the existing graph before adding them.
*
* Returns `{ nodes: [], links: [] }` when the datum cannot be loaded.
*
* @param {Object} self          - Central section instance (rqo template)
* @param {Object} node          - Graph node to expand. Mutated in place if a
*   better label is found for it.
* @param {Object} section_maps  - Shared section_map accumulator (mutated in place)
* @returns {Promise<Object>} `{ nodes, links }` — arrays of new candidate
*   nodes and links for the expanded node
*/
export const fetch_node_relations = async function(self, node, section_maps) {

	const datum = await fetch_section_datum(self, node.section_tipo, node.section_id)
	if (!datum) {
		return { nodes: [], links: [] }
	}

	const model_map = build_model_map(datum)

	// merge section_maps from fetched datum
	const new_maps = build_section_maps(datum)
	const new_keys = Object.keys(new_maps)
	const new_keys_len = new_keys.length
	for (let i = 0; i < new_keys_len; i++) {
		const key = new_keys[i]
		if (!section_maps[key]) {
			section_maps[key] = new_maps[key]
		}
	}

	// upgrade node label if it was a fallback
		if (is_fallback_label(node.label, node.section_tipo)) {
			const better = resolve_label(datum, node.section_tipo, node.section_id, model_map, section_maps)
			if (better && !is_fallback_label(better, node.section_tipo)) {
				node.label = better
			}
		}

	const nodes		= []
	const links		= []
	const relations	= extract_relations(datum, node.section_tipo, node.section_id, model_map)
	const relations_len = relations.length
	for (let i = 0; i < relations_len; i++) {
		const rel = relations[i]
		const tid = rel.locator.section_tipo + '_' + rel.locator.section_id
		if (tid===node.id) {
			continue // skip self reference
		}
		nodes.push(build_node({
			section_tipo	: rel.locator.section_tipo,
			section_id		: rel.locator.section_id,
			label			: resolve_label(datum, rel.locator.section_tipo, rel.locator.section_id, model_map, section_maps)
		}))
		links.push({
			source			: node.id,
			target			: tid,
			parent_id		: node.id,
			relation_tipo	: rel.relation_tipo,
			relation_label	: rel.relation_label
		})
	}

	return { nodes, links }
}//end fetch_node_relations



/**
* UPGRADE_FALLBACK_LABELS
* Iteratively replace provisional fallback labels on graph nodes with real
* display text, fetching datums section-type by section-type to minimise
* API calls.
*
* Strategy:
* 1. Group all nodes with fallback labels by `section_tipo`. This means one
*    datum fetch per section type is sufficient to get the model_map (all
*    records of the same section type share identical structure).
* 2. For each section-type group, fetch one datum (the first node's record),
*    derive the model_map and section_maps, then attempt `resolve_label` for
*    every node in the group.
* 3. After each section-type batch, invoke `update_callback` so the graph
*    renderer can refresh incrementally rather than waiting for all upgrades.
*
* (!) Only one datum per section_tipo is fetched, using the first node's
* section_id. Because all records of the same tipo share the same component
* structure (model_map), this is safe for label-field discovery. Individual
* record data is still read correctly because `resolve_label` scans the
* datum's data array by exact section_id match.
*
* Nodes are mutated in place. `section_maps` is mutated in place.
* Returns no value (upgrades happen as a side effect).
*
* @param {Object}   self            - Section instance (rqo template)
* @param {Array}    nodes           - Full graph.nodes array (mutated in place)
* @param {Function} update_callback - Called after each section-type batch upgrades labels
* @param {Object}   section_maps    - Shared section_map accumulator (mutated in place)
* @returns {Promise<void>}
*/
export const upgrade_fallback_labels = async function(self, nodes, update_callback, section_maps) {

	// collect unique section_tipos that need resolution
		const pending = {}
		const nodes_length = nodes.length
		for (let i = 0; i < nodes_length; i++) {
			const node = nodes[i]
			if (is_fallback_label(node.label, node.section_tipo)) {
				pending[node.section_tipo] = pending[node.section_tipo] || []
				pending[node.section_tipo].push(node)
			}
		}

		const tipos = Object.keys(pending)
		const tipos_length = tipos.length
		if (tipos_length===0) return
		for (let i = 0; i < tipos_length; i++) {

			const section_tipo	= tipos[i]
			const group		= pending[section_tipo]
			// fetch datum for the first node of this tipo (same section structure)
			const sample		= group[0]
			const datum		= await fetch_section_datum(self, section_tipo, sample.section_id)

			if (!datum) {
				continue
			}

			const model_map = build_model_map(datum)

			// merge section_maps from fetched datum
			const new_maps = build_section_maps(datum)
			const new_keys = Object.keys(new_maps)
			const new_keys_len = new_keys.length
			for (let j = 0; j < new_keys_len; j++) {
				const key = new_keys[j]
				if (!section_maps[key]) {
					section_maps[key] = new_maps[key]
				}
			}

			// upgrade every node of this section_tipo
			const group_length = group.length
			for (let j = 0; j < group_length; j++) {
				const node	= group[j]
				const better	= resolve_label(datum, node.section_tipo, node.section_id, model_map, section_maps)
				if (better && !is_fallback_label(better, node.section_tipo)) {
					node.label = better
				}
			}

			// let the graph refresh after each tipo batch
			if (typeof update_callback==='function') {
				update_callback()
			}
		}
}//end upgrade_fallback_labels



/**
* EXTRACT_NODE_FIELDS
* Collect the displayable (non-relation) field values of a record from its datum.
*
* Iterates datum.data looking for items belonging to the specified record.
* Filters out:
* - Components whose model appears in `RELATION_MODELS` (these are shown as
*   graph edges, not field values).
* - `component_section_id` (the internal primary-key component, not a user field).
*
* When no label is found in the context (ctx.label / item.debug_label), the raw
* `item.tipo` string is used as the field label so the field is never unlabelled.
* When `entries` resolve to an empty string, the value is substituted with '—'
* so the UI always shows something rather than a blank row.
*
* @param {Object} datum       - Standard Dédalo datum `{ context, data }`
* @param {string} section_tipo - Ontology tipo of the owning section
* @param {string} section_id   - Record identifier (compared as string)
* @param {Object} model_map    - Pre-built map from `build_model_map(datum)`
* @returns {Array} Array of field descriptors: `[{ label, value, tipo }]`
*   where `value` is always a non-empty string ('—' when no data found).
*/
export const extract_node_fields = function(datum, section_tipo, section_id, model_map) {

	const fields	= []
	const data		= datum?.data || []
	const data_length = data.length

	for (let i = 0; i < data_length; i++) {
		const item = data[i]
		if (item.section_tipo!==section_tipo || String(item.section_id)!==String(section_id)) {
			continue
		}
		const ctx	= model_map[item.section_tipo + '_' + item.tipo]
		const model	= ctx?.model || item.debug_model || ''
		// skip relation components (shown as edges) and structural id
		if (RELATION_MODELS.includes(model) || model==='component_section_id') {
			continue
		}
		const label	= ctx?.label || item.debug_label || item.tipo
		const value	= extract_text(item.entries)
		fields.push({
			label	: label,
			value	: value || '—',
			tipo	: item.tipo
		})
	}

	return fields
}//end extract_node_fields



/**
* PARSE_RELATION_LIST_RESPONSE
* Transform a relation_list API response into graph nodes and inverse links.
*
* **Response format** (from the `relation_list` component's `get_relation_list` action):
* ```
* {
*   context: [{ section_tipo, section_label, component_tipo, component_label }, ...],
*   data:    [
*     { component_tipo: 'id', section_tipo, section_id },       // record sentinel
*     { component_tipo: <tipo>, value: <string> },               // field value
*     ...                                                         // more fields
*     { component_tipo: 'id', ... },                             // next record
*     ...
*   ]
* }
* ```
* Data items are walked sequentially. A sentinel with `component_tipo === 'id'`
* starts a new record group; subsequent non-id items are collected as that
* record's field values.
*
* Produced links have `is_inverse: true` and flow *from* the referencing record
* *to* the root (`source → target = referencing_id → root_id`), so they
* visually represent the "points at me" direction in the graph.
*
* The node label is built by joining all resolved field values with ' | '. When
* no values are available, the section-type label (from context) or the
* `section_tipo · section_id` fallback is used instead.
*
* @param {Object} result           - API response result `{ context, data }`
* @param {string} root_section_tipo - Ontology tipo of the central/root section
* @param {string} root_section_id   - Record identifier of the root node
* @returns {Object} `{ nodes, links }` — new candidate nodes and inverse links
*   (`links[].is_inverse === true`); self-references to root_id are skipped.
*/
export const parse_relation_list_response = function(result, root_section_tipo, root_section_id) {

	const root_id = root_section_tipo + '_' + root_section_id
	const nodes	= []
	const links	= []

	const context	= result?.context || []
	const data		= result?.data || []

	// build section_label lookup from context
	// section_labels: keyed by section_tipo; used as node-label fallback when no record values are found
	// (!) component_labels is populated here but not consumed further in this function;
	// it appears to be scaffolding reserved for future per-field label display.
	const section_labels = {}
	const component_labels = {}
	const context_len = context.length
	for (let i = 0; i < context_len; i++) {
		const ctx = context[i]
		if (!ctx) continue
		if (ctx.section_tipo) {
			section_labels[ctx.section_tipo] = ctx.section_label || ctx.section_tipo
		}
		if (ctx.component_tipo && ctx.component_tipo !== 'id') {
			component_labels[ctx.section_tipo + '_' + ctx.component_tipo] = ctx.component_label || ctx.component_tipo
		}
	}

	// walk data array: group items by record (each record starts with component_tipo==='id')
	let current_record = null
	const records = []
	const data_len = data.length
	for (let i = 0; i < data_len; i++) {
		const item = data[i]
		if (!item) continue

		if (item.component_tipo === 'id') {
			current_record = {
				section_tipo	: item.section_tipo,
				section_id		: String(item.section_id),
				values			: []
			}
			records.push(current_record)
			continue
		}

		if (current_record) {
			current_record.values.push({
				component_tipo	: item.component_tipo,
				value			: item.value
			})
		}
	}

	// build nodes and inverse links from each calling record
	const records_len = records.length
	for (let i = 0; i < records_len; i++) {
		const rec = records[i]
		const tid = rec.section_tipo + '_' + rec.section_id

		// skip self-reference
		if (tid === root_id) continue

		// collect all value strings from the record for both node label and link label
		const vals_len = rec.values.length
		const value_parts = []
		for (let j = 0; j < vals_len; j++) {
			const v = rec.values[j]
			const str = (v.value !== null && v.value !== undefined) ? strip_html(String(v.value)) : ''
			if (str) {
				value_parts.push(str)
			}
		}

		// node label: all values joined by ' | ', fallback to section label or tipo·id
		const label = value_parts.length > 0
			? value_parts.join(' | ')
			: (section_labels[rec.section_tipo] || (rec.section_tipo + ' · ' + rec.section_id))

		nodes.push(build_node({
			section_tipo	: rec.section_tipo,
			section_id		: rec.section_id,
			label			: label
		}))

		// inverse link label: all values joined by ' | ', prefixed with '←'
		const relation_label = value_parts.length > 0
			? '← ' + value_parts.join(' | ')
			: '← ' + (section_labels[rec.section_tipo] || rec.section_tipo)

		links.push({
			source			: tid,
			target			: root_id,
			parent_id		: root_id,
			relation_tipo	: rec.section_tipo,
			relation_label	: relation_label,
			is_inverse		: true
		})
	}

	return { nodes, links }
}//end parse_relation_list_response



/**
* FETCH_INVERSE_RELATIONS
* Fetch records that reference the root record (inverse/back-links) via the
* `relation_list` component API, and convert them into graph nodes + inverse links.
*
* Requires `self.context.config.relation_list_tipo` to be set — this is the
* ontology tipo of the `component_relation_list` in the section config that
* declares which relation_list to use for back-link lookup. Returns an empty
* result immediately when the tipo is missing.
*
* Makes two sequential API requests:
* 1. A `count` request to get the total number of referencing records (for
*    pagination in the graph UI).
* 2. A `read` request limited to `options.limit` records starting at
*    `options.offset`, with `mode: 'related'` and `filter_by_locators` pointing
*    at the root record. Both share the same `source` object.
*
* The result is parsed by `parse_relation_list_response`, which produces nodes
* and links with `is_inverse: true`.
*
* @param {Object} self              - Section instance providing rqo template
*   and `context.config.relation_list_tipo`
* @param {string} root_section_tipo - Ontology tipo of the root/central section
* @param {string} root_section_id   - Record identifier of the root node
* @param {Object} [options={}]      - Pagination options
* @param {number} [options.limit=50]  - Maximum number of records to return
* @param {number} [options.offset=0]  - Pagination offset
* @returns {Promise<Object>} `{ nodes, links, total, loaded }` where:
*   - `nodes` — candidate graph nodes for the referencing records
*   - `links` — inverse links (`is_inverse: true`)
*   - `total` — full count of referencing records (for pagination)
*   - `loaded` — number of nodes actually returned in this batch
*   Returns `{ nodes: [], links: [], total: 0, loaded: 0 }` on failure or when
*   `relation_list_tipo` is not configured.
*/
export const fetch_inverse_relations = async function(self, root_section_tipo, root_section_id, options={}) {

	const relation_list_tipo = self?.context?.config?.relation_list_tipo
	if (!relation_list_tipo) {
		return { nodes: [], links: [], total: 0, loaded: 0 }
	}

	const limit	= options.limit ?? 50
	const offset	= options.offset ?? 0

	try {
		// shared source for both count and data requests
		const source = {
			section_tipo	: root_section_tipo,
			section_id		: root_section_id,
			tipo			: relation_list_tipo,
			model			: 'relation_list',
			action			: 'get_relation_list',
			mode			: 'edit'
		}

		// shared sqo filter
		const filter_by_locators = [{
			section_tipo	: root_section_tipo,
			section_id		: root_section_id
		}]

		// count request (uses the standard count API action)
		const count_rqo = {
			action			: 'count',
			prevent_lock	: true,
			sqo				: {
				section_tipo		: ['all'],
				mode				: 'related',
				filter_by_locators	: filter_by_locators
			},
			source			: source
		}

		const count_response = await data_manager.request({
			body : count_rqo
		})

		const total = response_data(count_response)?.total ?? 0

		// data request
		const rqo = {
			action	: 'read',
			source	: source,
			sqo	: {
				section_tipo		: ['all'],
				mode				: 'related',
				limit				: limit,
				offset				: offset,
				filter_by_locators	: filter_by_locators
			}
		}

		const api_response = await data_manager.request({
			body : rqo
		})

		if (SHOW_DEBUG===true && request_failed(api_response)) {
			console.warn('[build_graph_data.fetch_inverse_relations] failed:', api_response.error)
		}

		const result = response_data(api_response)

		// relation_list returns an object { context, data } directly
		if (!result || (!result.context && !result.data)) {
			return { nodes: [], links: [], total, loaded: 0 }
		}

		const parsed = parse_relation_list_response(result, root_section_tipo, root_section_id)

		return {
			nodes	: parsed.nodes,
			links	: parsed.links,
			total	: total,
			loaded	: parsed.nodes.length
		}

	} catch (error) {
		console.error('[build_graph_data.fetch_inverse_relations] error:', error)
		return { nodes: [], links: [], total: 0, loaded: 0 }
	}
}//end fetch_inverse_relations



// @license-end
