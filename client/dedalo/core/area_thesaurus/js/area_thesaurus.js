// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/


/**
* AREA_THESAURUS
* Client-side controller for the Thesaurus area and its Ontology sibling (area_ontology).
*
* Responsibilities:
*  - Bootstraps a thesaurus area page: fetches context + data via the dedalo API,
*    resolves hierarchy/tree configuration from context, wires a search (filter) panel,
*    and delegates DOM rendering to render_area_thesaurus.prototype.list.
*  - Handles two distinct area models sharing this constructor:
*      • area_thesaurus  — browse/edit thesaurus term trees (dd100 section type).
*      • area_ontology   — browse/edit Dédalo's internal ontology term tree (dd5).
*    The `self.model` property distinguishes them at runtime.
*  - Supports a URL-initiated deep-link mode (`search_tipos` parameter) that pre-filters
*    the tree to highlight specific term tipos passed from Ontology node buttons.
*  - Manages the `show_models` toggle (Ctrl+M) that shows/hides `.model_value` elements
*    in the tree, persisting the state to the local IndexedDB 'status' table.
*
* Data shape after build():
*  - self.datum   {Object}  Full raw API response (context[] + data[]).
*  - self.context {Object}  Single context entry for self.tipo.
*  - self.data    {Array}   Data entries for self.tipo (ts_search / typologies / value).
*  - self.filter  {Object}  Keyed `search` instance that drives the collapsible search panel.
*  - self.rqo     {Object}  Request query object forwarded to the API; carries source.caller
*                           when this area was opened as a picker (see picker_caller), and is
*                           augmented in build() with hierarchy_sections, hierarchy_terms,
*                           thesaurus_mode, and an optional SQO filter when search_tipos is
*                           active.
*
* Picker reads:
*  When a relation component opens this area to pick terms, the request declares its
*  CALLER (`rqo.source.caller`) and nothing else — the server derives the picker mode
*  (`context.thesaurus_mode`), the hierarchy narrowing and the per-term selectability from
*  it. This area only carries the declaration; the wiring of the picker itself belongs to
*  the one shared module (`thesaurus_picker.js` attach_picker) and its hosts.
*
* Prototype chain:
*  Constructor             → area_thesaurus (this file)
*  Lifecycle / utilities   → common (common.prototype.refresh / build_rqo_show; destroy is
*                            wrapped here to release this instance's keydown listener)
*  Initialization          → area_common.prototype.init (id, mode, lang, events_tokens setup)
*  Rendering               → render_area_thesaurus.prototype.list (assigned to both .edit and .list)
*
* Key event contracts:
*  - Subscribes to  'toggle_search_panel_<id>'  (search button in the inspector toolbar).
*  - Subscribes to  'render_<id>'               (restores search-panel open state on re-render).
*  - Publishes      'render_instance'            after each render() call.
*  - Registers a global 'keydown' listener (Ctrl+M) via dd_request_idle_callback so it
*    runs only after the initial paint. The handler is stored on the instance
*    (self.keydown_handler_show_models) and removed by destroy().
*/


// imports
	import {
		common,
		set_context_vars,
		build_autoload
	} from '../../common/js/common.js'
	import {
		clone,
		url_vars_to_object,
		get_tld_from_tipo,
		get_section_id_from_tipo
	} from '../../common/js/utils/index.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {area_common} from '../../area_common/js/area_common.js'
	import {get_instance} from '../../common/js/instances.js'
	import {toggle_search_panel} from '../../search/js/render_search.js'
	import {render_area_thesaurus} from './render_area_thesaurus.js'
	import {response_data} from '../../common/js/api_error.js'



/**
* AREA_THESAURUS
* Constructor for the thesaurus/ontology area controller.
*
* Declares all instance properties with their default values (or undefined where
* the value is always supplied by init() / build()). Concrete initialization of
* these properties happens in area_common.prototype.init (identity + event tokens)
* and area_thesaurus.prototype.build (context, data, rqo, filter).
*/
export const area_thesaurus = function() {

	/** @var {string} id - Unique instance identifier assigned by the instance registry. */
	this.id

	// element properties declare
	/** @var {string} model - Area model name: 'area_thesaurus' or 'area_ontology'. */
	this.model
	/** @var {string} type - Generic element type (e.g. 'area'). */
	this.type
	/** @var {string} tipo - Ontology tipo for this area (e.g. 'dd100' for thesaurus, 'dd5' for ontology). */
	this.tipo
	/** @var {string} section_tipo - Section tipo derived from context (e.g. 'dd100'). Set in build(). */
	this.section_tipo
	/** @var {string} mode - Interaction mode, always 'list' for areas. */
	this.mode
	/** @var {string} lang - Active language code (e.g. 'lg-spa'). */
	this.lang

	/** @var {Object} datum - Raw API response; contains context[] and data[] arrays after build(). */
	this.datum
	/** @var {Object} context - Single context entry for self.tipo, extracted from datum.context. */
	this.context
	/** @var {Array} data - Data entries for self.tipo, extracted from datum.data. */
	this.data

	/** @var {Array} widgets - Child context entries of self.tipo that have typo==='widget'. */
	this.widgets

	/** @var {Object} node - Map of key DOM node references (e.g. node.content_data, node.search_container). */
	this.node
	/** @var {string} status - Lifecycle status: 'building' | 'built'. */
	this.status

	/** @var {Object|null} filter - Keyed `search` instance that powers the collapsible search panel. Null until build(). */
	this.filter = null

	/** @var {Object} request_config_object - The 'main' entry from context.request_config used to construct rqo. */
	this.request_config_object
	/** @var {Object} rqo - Request query object forwarded to the API. Augmented in build() with hierarchy, thesaurus_mode, and optional SQO filter. */
	this.rqo

	/**
	* @var {Object} build_options
	* Options influencing how ts_object nodes are rendered.
	*   terms_are_model {boolean} false → render as descriptor terms; true → render as ontology model context.
	* (!) This property is kept for backward compatibility; at runtime the rqo.source.build_options
	* object drives the actual behavior, not this property.
	*/
	this.build_options = {
		terms_are_model : false //false = the terms are descriptors terms // true = the terms are models (context model of the terms)
	}

	// display mode: string 'default|relation'
	/** @var {string} thesaurus_mode - Tree display mode sourced from context: 'default' or 'relation'. Forwarded to rqo.source.thesaurus_mode. */
	this.thesaurus_mode

	// thesaurus_view_mode: string 'default|model'. Used to allow manage models
	/** @var {string|null} thesaurus_view_mode - View mode controlling whether model nodes are editable: 'model' | 'default' | null. Sourced from options.config or URL param. */
	this.thesaurus_view_mode

	// picker_caller: the ddo that opened this area as a term picker
	/**
	* @var {Object|null} picker_caller
	* {section_tipo, section_id, tipo} of the relation component that opened this area to
	* pick terms. Set in init() from options.config (in-page host) or the URL param (picker
	* window reload); folded into rqo.source.caller by build()'s generate_rqo so it rides the
	* FIRST read. Null on an ordinary browse.
	*/
	this.picker_caller = null

	/**
	* @var {Object|null} picker
	* The picker wired onto this area by thesaurus_picker.js attach_picker (set by the host,
	* not here). Read in render() only to report a granted-but-unwired picker.
	*/
	this.picker = null

	/** @var {boolean} picker_missing_reported - True once render() reported a granted picker read with no picker attached (reported once per instance). */
	this.picker_missing_reported = false

	/** @var {Function|null} keydown_handler_show_models - Document keydown listener (Ctrl+M) installed by init(); removed by destroy(). */
	this.keydown_handler_show_models = null

	// // model_value_is_hide : bool default false. Used to store the Ontology model_value hidden status
	// // An event to keydown Ctr + m fires the changes in this property and is read by ts_object when render
	// // the ts_line (list_thesaurus_element model_value div node)
	// self.model_value_is_hide = false

	// search_tipos. Array of tipos to search in the request from URL
	// Usually is added to the URL by Ontology node open in tree button
	/** @var {Array|undefined} search_tipos - Optional array of tipo strings from the 'search_tipos' URL param. When present (area_ontology only), build() constructs a SQO filter to highlight those nodes. */
	this.search_tipos
}//end area_thesaurus



/**
* COMMON FUNCTIONS
* Prototype assignments that wire shared lifecycle and render methods onto area_thesaurus.
*
* refresh / build_rqo_show  — delegated to common so all areas share the same
*   implementation (session handling, rqo construction). destroy is NOT delegated here: it
*   is wrapped below so the instance releases the document listener it installed itself.
* edit / list / relation — all point to render_area_thesaurus.prototype.list because the
*   thesaurus area only has a single view mode (the paginated tree list); there is no
*   separate 'edit' layout distinct from 'list'.
*
* (!) 'relation' is a mode this area genuinely runs in — the ontology declares it in the
*   tool_indexation ddo_map ("mode":"relation", tipo dd100) and self.mode carries it (see
*   the 'default|relation' note on the constructor). common.prototype.render resolves a
*   mode by looking for a METHOD of that name and silently falls back to 'list', so an
*   undeclared-but-valid mode logged "Invalid render_mode 'relation'" on every render of
*   the indexation tool. Declaring the alias is the truthful fix: the mode is supported,
*   and it is this renderer that supports it. What 'relation' actually changes lives
*   downstream in context.thesaurus_mode (render_ts_line / render_ts_id_column), not in a
*   different area layout — the renderer ignores render_mode entirely.
*   (!) Do NOT "fix" this by normalising self.mode to 'list' the way section.js does for
*   'list_thesaurus': self.mode is also the get_instance key of the area's search filter
*   and the local-db id of its search-panel state, so collapsing it would make the tool's
*   thesaurus share that state with the standalone thesaurus area.
*/
// prototypes assign
	area_thesaurus.prototype.refresh		= common.prototype.refresh
	area_thesaurus.prototype.build_rqo_show	= common.prototype.build_rqo_show
	area_thesaurus.prototype.edit			= render_area_thesaurus.prototype.list
	area_thesaurus.prototype.list			= render_area_thesaurus.prototype.list
	area_thesaurus.prototype.relation		= render_area_thesaurus.prototype.list



/**
* DESTROY
* Lifecycle teardown. Releases the document-level Ctrl+M listener this instance installed
* in init() and then delegates to the shared common implementation (dependency cascade,
* self removal, DOM removal).
*
* The listener is the instance's own: init() adds it to `document`, so nothing else can
* reach it once the instance is gone. Every picker open/close cycle used to leave one
* behind, and accumulated identical handlers cancel each other out (Ctrl+M stops working
* page-wide).
*
* (!) It is released ONLY when delete_self is true. build() calls destroy(false, true,
* false) on every rebuild to reclaim the previous tree while this area keeps running —
* dropping the listener there would break Ctrl+M after the first search or refresh.
*
* @param {boolean} [delete_self=true] - Destroy this instance itself.
* @param {boolean} [delete_dependencies=false] - Destroy the registered dependent instances.
* @param {boolean} [remove_dom=false] - Remove the wrapper node from the DOM.
* @returns {Promise<Object>} The common.prototype.destroy result object.
*/
area_thesaurus.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// keydown listener (Ctrl+M, show_models toggle) installed by init
		if (delete_self===true && self.keydown_handler_show_models) {
			document.removeEventListener('keydown', self.keydown_handler_show_models)
			self.keydown_handler_show_models = null
		}

	return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* PARSE_PICKER_CALLER
* Decode the JSON-encoded `picker_caller` URL param into the caller object the request
* declares (`rqo.source.caller`).
*
* The decoded object is forwarded VERBATIM, without a shape check: the server
* shape-validates the caller and refuses a malformed one with a named 400. A second,
* client-side validator would be a second authority able to disagree with it — and a
* client that silently dropped a caller it did not like would turn a picker into an
* ordinary browse with no explanation.
*
* Only an undecodable param is dropped here (there is nothing to forward), and loudly.
*
* @param {string|Array|undefined} raw - Raw URL param value.
* @returns {Object|null} The decoded caller, or null when the param is absent/undecodable.
*/
const parse_picker_caller = function(raw) {

	if (!raw) {
		return null
	}

	try {
		return JSON.parse(raw)
	} catch (error) {
		console.error('(!) Ignored malformed picker_caller URL param (not valid JSON):', raw, error);
		return null
	}
}//end parse_picker_caller



/**
* INIT
* Lifecycle phase 1: initialize the area instance before any API call.
*
* Delegates to area_common.prototype.init for identity (id, tipo, mode, lang),
* event-token array setup, and URL-param parsing shared by all areas.
* Then wires area_thesaurus-specific subscriptions and parses its own URL params.
*
* Event subscriptions registered here:
*  - 'toggle_search_panel_<id>'  Fired by the inspector toolbar "search" button.
*    Lazily builds+renders the filter instance the first time the panel opens, then
*    delegates to toggle_search_panel() for show/hide animation.
*  - 'render_<id>'  Fired after each render() call.
*    Reads the persisted 'open_search_panel' status from the local DB and, if the
*    panel was open before a refresh, rebuilds and re-opens it.
*
* Keyboard shortcut (Ctrl+M) registered in a dd_request_idle_callback:
*  - Reads/migrates the 'show_models' preference (localStorage → local DB).
*  - Installs a global 'keydown' listener that toggles '.model_value' visibility
*    and persists the change to the local DB 'status' table.
*  - The listener is kept in self.keydown_handler_show_models so destroy() can
*    remove it; see destroy() for why it is released only on a full destroy.
*
* URL params consumed (via url_vars_to_object):
*  - initiator      {string} JSON-encoded caller id. Sets self.linker for DS (DataService) deep-links.
*  - thesaurus_view_mode  {string} 'model'|'default'|null.
*  - picker_caller  {string} JSON-encoded {section_tipo, section_id, tipo} of the component
*                   that opened this area as a term picker. See self.picker_caller.
*  - search_tipos   {string} Comma-separated tipo list (area_ontology only).
*
* @param {Object} options - Initialization options forwarded from the area page bootstrap.
* @returns {Promise<boolean>} Resolves to the result of area_common.prototype.init.
*/
area_thesaurus.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await area_common.prototype.init.call(this, options);

	// events subscription

		// toggle_search_panel. Triggered by button 'search' placed into section inspector buttons
			// warm_search_panel. Called on search button hover/focus (user intent, never
			// at page load): the build requests start before the click
			self.warm_search_panel = () => {
				if (self.filter && self.search_container?.children.length===0) {
					self.filter_build_promise ??= self.filter.build()
				}
			}
			const toggle_search_panel_handler = async () => {

				// Lazy-load: only build+render the filter the first time the panel opens.
				if (self.search_container.children.length===0) {
					// await add_to_container(self.search_container, self.filter)
					await ui.load_item_with_spinner({
						container	: self.search_container,
						label		: 'filter',
						callback	: async () => {
							const build_promise = self.filter_build_promise ?? self.filter.build()
							self.filter_build_promise = null // a later reopen rebuilds fresh
							await build_promise
							return self.filter.render()
						}
					})
				}
				toggle_search_panel(self.filter)
			}
			self.events_tokens.push(
				event_manager.subscribe('toggle_search_panel_'+self.id, toggle_search_panel_handler)
			)

		// render event
			const render_handler = () => {
				// Restore the search panel open/closed state after a re-render.
				// The status key is 'open_search_panel_<tipo>_<mode>' in the local DB 'status' table.
				const status_id			= `open_search_panel_${self.tipo}_${self.mode}`
				const collapsed_table	= 'status'
				data_manager.get_local_db_data(status_id, collapsed_table, true)
				.then(async function(ui_status){
					// (!) Note that ui_status only exists when element is open
					const is_open = typeof ui_status==='undefined' || ui_status.value===false
						? false
						: true
					if (is_open===true && self.search_container.children.length===0) {
						// add_to_container(self.search_container, self.filter)
						await ui.load_item_with_spinner({
							container	: self.search_container,
							label		: 'filter',
							callback	: async () => {
								// consume a hover warmup, so it is never reused stale on a later open
								const build_promise = self.filter_build_promise ?? self.filter.build()
								self.filter_build_promise = null
								await build_promise
								return self.filter.render()
							}
						})
						toggle_search_panel(self.filter)
					}
				})
			}
			self.events_tokens.push(
				event_manager.subscribe('render_'+self.id, render_handler)
			)

		// key commands
			dd_request_idle_callback(
				async () => {
					// show_models persisted state. Lives in the local db 'status'
					// table like every other UI state (expand status, search panel).
					// One-time migration from the legacy localStorage key.
					const legacy_value = localStorage.getItem('show_models')
					if (legacy_value) {
						await data_manager.set_local_db_data(
							{ id: 'show_models', value: true },
							'status'
						)
						localStorage.removeItem('show_models')
					}
					const show_models_status = await data_manager.get_local_db_data('show_models', 'status')
					// Fall back to the in-memory flag if the DB has no entry yet (first load).
					window.page_globals.show_models = show_models_status?.value===true
						? true
						: (window.page_globals.show_models || false)

					const keydown_handler = (e) => {

						// control + m keys
						if (e.key==='m' && e.ctrlKey===true) {
							const model_value_list = document.querySelectorAll('.model_value')
							if (window.page_globals.show_models) {
								// display case. Change to hide
								[...model_value_list].map((el)=>{
									el.classList.add('hide')
								})
								// save status for persistence
								data_manager.delete_local_db_data('show_models', 'status')
								window.page_globals.show_models = false
							}else{
								// hidden case. Change to display
								[...model_value_list].map((el)=>{
									el.classList.remove('hide')
								})
								data_manager.set_local_db_data(
									{ id: 'show_models', value: true },
									'status'
								)
								window.page_globals.show_models = true
							}
						}
					}
					// The idle callback can fire after a fast open/close cycle (a picker host
					// builds and destroys the area within one frame). Installing on a
					// destroyed instance would leave a listener nothing can remove.
					if (self.status==='destroyed') {
						return
					}
					// keep the reference on the instance: it is the only way destroy()
					// can take this listener off document again (see destroy).
					self.keydown_handler_show_models = keydown_handler
					document.addEventListener('keydown', self.keydown_handler_show_models)
				}
			)

	// URL vars
		const url_vars = url_vars_to_object(window.location.search)

	// linker
		// linker. Get component caller id from url (needed to link terms for DS callers)
		// (!) The param is user-editable, so the parse is guarded like the sibling
		// parse_picker_caller above: an undecodable value is dropped loudly and the
		// area degrades to a browse-only tree instead of dying during init.
		if (url_vars.initiator) {
			let caller_id = null
			try {
				caller_id = JSON.parse(url_vars.initiator)
			} catch (error) {
				console.error('(!) Ignored malformed initiator URL param (not valid JSON):', url_vars.initiator, error);
			}
			if (caller_id!==null) {
				self.linker = {
					id		: caller_id,
					caller	: null // passed as null for DS call identification. Indexation callers have value here
				}
			}
		}

	// thesaurus_view_mode: model|default|null
		// Priority: programmatic options (e.g. tool open) → URL param (page reload) → null.
		self.thesaurus_view_mode = options.config?.thesaurus_view_mode // init options case
			|| url_vars.thesaurus_view_mode // page reload case
			|| null

	// picker_caller: {section_tipo, section_id, tipo}|null
		// The caller ddo that opened this area as a term picker. It is the ONLY thing a
		// picker request declares: the server derives the picker mode
		// (context.thesaurus_mode), the hierarchy narrowing and the per-term selectability
		// from this caller. The client declares no conclusion of its own.
		// Priority: programmatic options (the in-page picker host) → URL param (picker
		// window reload) → null (ordinary browse).
		// (!) Read here, at init, because generate_rqo must fold it into the request BEFORE
		// build_autoload: a boot page performs exactly one read, and a caller that arrives
		// after it changes nothing.
		self.picker_caller = options.config?.picker_caller // init options case
			|| parse_picker_caller(url_vars.picker_caller) // page reload case
			|| null

	// search tipos
	// Used by area_ontology to search and hilite terms in the tree
	// e.g. https://localhost/dedalo/core/page/?tipo=dd5&mode=list&search_tipos=oh26,rs14
		if (url_vars.search_tipos) {
			const search_tipos = url_vars.search_tipos.split(',')
			if (Array.isArray(search_tipos)) {
				self.search_tipos = search_tipos
			}
		}


	return common_init
}//end init



/**
* PARSE_SEARCH_TIPOS_FILTER
* Converts an array of ontology tipo strings into a SQO filter object that the API
* can use to restrict the tree to nodes matching those tipos.
*
* Each tipo (e.g. 'oh26', 'rs14') is split into its TLD prefix (e.g. 'oh', 'rs')
* and its numeric section_id ('26', '14') using get_tld_from_tipo / get_section_id_from_tipo.
* Those two pieces map to the ontology section fields:
*  - ontology7 (component_input_text 'tld')   — the namespace / top-level-domain.
*  - ontology2 (component_section_id 'Id')    — the numeric record id within that namespace.
*
* A single tipo produces a plain $and clause.
* Multiple tipos are wrapped in a $or so any match returns the section record.
* Tipos that fail the tld/section_id extraction are skipped with a console.error.
*
* Used only in build() when self.model === 'area_ontology' and self.search_tipos is set.
*
* @param {Array} search_tipos - Array of tipo strings, e.g. ['rsc22', 'rsc89'].
* @returns {Object|null} SQO filter object, or null if the input is invalid / all tipos are bad.
*/
const parse_search_tipos_filter = function (search_tipos) {

	if (!Array.isArray(search_tipos)) {
		return null
	}

	const filter_items = []

	const search_tipos_length = search_tipos.length
	for (let i = 0; i < search_tipos_length; i++) {
		const tipo = search_tipos[i]

		// Decompose the tipo into (namespace TLD, numeric id) for the two ontology fields.
		const tld			= get_tld_from_tipo(tipo)
		const section_id	= get_section_id_from_tipo(tipo);

		if (!tld || !section_id) {
			console.error('Ignored invalid tipo:', tipo);
			continue;
		}

		// Build a per-tipo $and clause: both the TLD and the section id must match.
		const filter_item = {
			"$and": [
				{
					"q": [
						tld
					],
					"q_operator": "=",
					"path": [
						{
							"name": "tld",
							"model": "component_input_text",
							"section_tipo": "ontology1",
							"component_tipo": "ontology7"
						}
					],
					"q_split": false,
					"type": "jsonb"
				},
				{
					"q": [
						section_id
					],
					"path": [
						{
							"name": "Id",
							"model": "component_section_id",
							"section_tipo": "ontology1",
							"component_tipo": "ontology2"
						}
					],
					"q_split": false,
					"type": "jsonb"
				}
			]
		}

		filter_items.push(filter_item)
	}

	// zero items case
	if (filter_items.length<1) {
		return null;
	}

	// Collapse multiple per-tipo clauses under a single $or so any matching tipo passes.
	const filter = filter_items.length === 1
		? filter_items[0]
		: {
			"$or" : filter_items
		  }


	return filter
}//end parse_search_tipos_filter



/**
* BUILD
* Lifecycle phase 2: fetch context + data from the API and prepare the instance
* for rendering.
*
* Two-pass rqo construction:
*  1. generate_rqo() is called before the API fetch so the request is ready.
*     At this point context may not yet be loaded, so request_config_object falls
*     back to an empty object and build_rqo_show creates a minimal rqo.
*     The picker caller (self.picker_caller) is folded in this first pass — it is
*     an instance field, not a context value, precisely so it rides the only read
*     a boot page performs.
*  2. After api_response is processed and context is available, generate_rqo() is
*     called again so that hierarchy_sections / hierarchy_terms / thesaurus_mode —
*     values that live in context — are correctly folded into rqo.source.
*
* Search-action optimization:
*  When rqo.source.search_action === 'search' the existing ts_object tree instances
*  must survive the build so build_search_instances can find them via get_instance_by_id.
*  In all other cases (initial load, show_all) destroy() is called first to clean up
*  the previous tree and prevent memory leaks.
*
* search_tipos deep-link (area_ontology only):
*  When self.search_tipos is set (from the URL) the rqo is augmented with:
*   - sqo.filter     — $and/$or filter targeting the specific ontology section records.
*   - sqo.section_tipo — the namespace root tipos (TLD + '0') extracted from each tipo.
*   - source.search_action = 'search'  — so the server treats it as a filtered query.
*
* show_models initialization:
*  Both areas default to show_models=false — the model badges are hidden until
*  Ctrl+M (PHP area_thesaurus.js set model_value_is_hide=true for area_ontology,
*  the same effective state). The local DB 'status' row 'show_models' overrides
*  the default; a legacy localStorage key is still checked as a one-release
*  fallback (migration runs in init).
*
* @param {boolean} [autoload=true] - When false, skips the API call (used for dry-run / unit-test scenarios).
* @returns {Promise<boolean>} true on success; false if the API returned no response or an empty context.
*/
area_thesaurus.prototype.build = async function(autoload=true) {
	const t0 = performance.now()

	const self = this

	// status update
		self.status = 'building'

	// self.datum. On building, if datum is not created, creation is needed
		self.datum = self.datum || {
			data	: [],
			context	: []
		}
		self.data = self.data || []

	// rqo
		const generate_rqo = async function(){
			// request_config_object. get the request_config_object from context
			// Falls back to {} when context is not yet loaded (first pass before the API call).
			self.request_config_object	= (self.context && self.context.request_config)
				? self.context.request_config.find(el => el.api_engine==='dedalo' && el.type==='main')
				: {}

			// rqo build
			const action	= 'get_data'
			const add_show	= false
			// Preserve the existing rqo across refreshes — only build once per instance.
			self.rqo = self.rqo || await self.build_rqo_show(self.request_config_object, action, add_show)

			// self.search_tipos. Used in area_ontology to auto-search the given tipos from URL
			// @see init search_tipos
			if (self.model==='area_ontology' && self.search_tipos) {
				const filter = parse_search_tipos_filter(self.search_tipos);
				if (filter) {
					self.rqo.sqo.filter = filter
					// Restrict the search to the namespace root sections for each tipo (TLD + '0').
					self.rqo.sqo.section_tipo = self.search_tipos.map(el => get_tld_from_tipo(el) + '0')
					self.rqo.source.search_action = 'search'
				}
			}

			// Propagate the view mode to the server so it returns model-context items when needed.
			self.rqo.source.build_options = {
				terms_are_model : (self.thesaurus_view_mode==='model')
			}

			// picker caller. The one declaration a picker request makes (@see init picker_caller).
			// Folded HERE, inside generate_rqo, because generate_rqo is awaited before
			// build_autoload: a boot page performs exactly one read, so the caller has to ride
			// that first request or the server derives nothing from it.
			// Only set when declared: adding the key unconditionally would change the request
			// shape of every ordinary thesaurus read.
			if (self.picker_caller) {
				self.rqo.source.caller = self.picker_caller
			}
		}
		await generate_rqo()

	// load from DDBB
		if (autoload===true) {

			// build_autoload
			// Use unified way to load context and data with
			// errors and not login situation managing
				const api_response = await build_autoload(self)

				// show debug
				if (SHOW_DEBUG===true) {
					console.log('area_thesaurus build api_response:', api_response);
				}

				// server: wrong response
				if (!api_response) {
					return false
				}
				// server: bad build context
				const datum = response_data(api_response)
				if(!datum.context.length){
					console.error("Error!!!!, area_thesaurus without context:", api_response);
					return false
				}

			// destroy dependencies
			// Skip during search: ts_object instances in the cache must stay alive so
			// build_search_instances can find them via get_instance_by_id and
			// open_search_branches can walk the tree. For show_all and initial loads
			// (no search_action or 'show_all') we still destroy so the tree resets cleanly.
				const is_search_action = self.rqo?.source?.search_action === 'search'
				if (!is_search_action) {
					await self.destroy(
						false, // bool delete_self
						true, // bool delete_dependencies
						false // bool remove_dom
					)
				}

			// set the result to the datum
				self.datum = datum

			// set context and data to current instance
				if(!self.context){
					const context =  self.datum.context.find(element => element.tipo===self.tipo)
					if (!context) {
						console.error("context not found in api_response:", api_response);
					}else{
						self.context = context
					}
				}
				// Filter data to this instance's tipo only; the response may include data for
				// child components and widgets that will be consumed by other instances.
				self.data		= self.datum.data.filter(element => element.tipo===self.tipo)
				self.widgets	= self.datum.context.filter(element => element.parent===self.tipo && element.typo==='widget')

			// dd_request
				// self.dd_request.show = self.build_rqo('show', self.context.request_config, 'get_data')

			// rebuild the request_config_object and rqo in the instance
				// request_config_object
				// 	self.request_config_object	= self.context.request_config.find(el => el.api_engine==='dedalo')

			// rqo config
			// Echo the tree-structure params the server answered with back onto the rqo of
			// the follow-up reads (refresh / search).
			// (!) These three are the server's OWN answers travelling back to it, never a
			// client declaration: hierarchy_sections / hierarchy_terms / thesaurus_mode are
			// derived server-side (from the area node's properties, and from source.caller
			// on a picker read). The picker mode in particular is granted by the server and
			// is never asserted from here.
				if(self.context.hierarchy_sections){
					self.rqo.source.hierarchy_sections = self.context.hierarchy_sections
				}
				if(self.context.hierarchy_terms){
					self.rqo.source.hierarchy_terms = self.context.hierarchy_terms
				}
				if(self.context.thesaurus_mode){
					self.rqo.source.thesaurus_mode = self.context.thesaurus_mode
				}
				// Apply a conservative default limit; context may raise it for large thesauri.
				self.rqo.sqo.limit = self.rqo.sqo.limit ?? 30

			// rqo regenerate
			// Second pass: context is now available so request_config_object and
			// build_options are re-applied with the correct values.
				await generate_rqo()
				if(SHOW_DEBUG===true) {
					console.log("AREA self.rqo after load:", clone(self.rqo));
				}
		}//end if (autoload===true)

	// update instance properties from context
		set_context_vars(self, self.context)

	// label
		self.label = self.context.label

	// permissions. calculate and set (used by section records later)
		self.permissions = self.context.permissions || 0

	// section tipo
		self.section_tipo = self.context.section_tipo || null

	// initiator . URL defined var or Caller of parent section
	// this is a param that defined who is calling to the section, sometimes it can be a tool or page or ...,
		// const searchParams = new URLSearchParams(window.location.href);
		// const initiator = searchParams.has("initiator")
		// 	? searchParams.get("initiator")
		// 	: self.caller
		// 		? self.caller.id
		// 		: false
		// // fix initiator
		// 	self.initiator = JSON.parse(initiator)

	// search filter
		if (!self.filter) {
			// keyed, registered instance. id_variant separates this area search
			// from a section search sharing section_tipo/mode/lang.
			self.filter = await get_instance({
				model			: 'search',
				section_tipo	: self.section_tipo,
				mode			: self.mode,
				lang			: self.lang,
				id_variant		: self.model,
				caller			: self
			})
		}

	// show_models. Thesaurus default is false, but Ontology default is true.
	// Persisted in the local db 'status' table (localStorage read kept one
	// release as legacy fallback; see init migration)
		const show_models_status = await data_manager.get_local_db_data('show_models', 'status')
		// (!) Legacy localStorage.getItem('show_models') check is intentionally kept
		// for one-release backward compatibility; it is cleaned up in init()'s migration.
		window.page_globals.show_models = (self.model==='area_ontology'
			|| show_models_status?.value===true
			|| localStorage.getItem('show_models'))
			? true
			: false;

	// debug
		if(SHOW_DEBUG===true) {
			//console.log("self.context section_group:",self.datum.context.filter(el => el.model==='section_group'));
			console.log("+ Time to build", self.model, " ms:", performance.now()-t0);
		}

	// status update
		self.status = 'built'


	return true
}//end build



/**
* RENDER
* Lifecycle phase 3: paint the DOM from the loaded context and data.
*
* Delegates the actual DOM construction to common.prototype.render, which
* dispatches to self.list() (= render_area_thesaurus.prototype.list) based on
* self.mode. After the node is in the DOM, publishes 'render_instance' so the
* page menu and any other listeners can update their section labels.
*
* Picker check: a read that declared a caller AND was granted relation mode by the server
* must have a picker wired onto it before it paints — the tree rows reach the picker
* through the linker they already carry (render_area_thesaurus passes self.linker to every
* ts_object). Wiring is the host's job (thesaurus_picker.js attach_picker); this area never
* builds one. A granted read that renders without a picker would paint a tree whose picks
* can never be published, so it is reported once, loudly, instead of browsing silently.
*
* @param {Object} [options={}] - Render options forwarded to common.prototype.render.
*   render_level {string} 'full' (rebuild wrapper + content) | 'content' (update content only).
* @returns {Promise<HTMLElement>} The first DOM node stored in self.node.
*/
area_thesaurus.prototype.render = async function(options={}) {

	const self = this

	// picker check. Granted by the server, but nothing wired it
		if (self.picker_caller
			&& self.context?.thesaurus_mode==='relation'
			&& !self.picker
			&& self.picker_missing_reported===false) {
			self.picker_missing_reported = true
			console.error(
				'(!) [area_thesaurus] the server granted picker (relation) mode for the declared'
				+ ' caller, but no picker is wired onto this area. Whatever mounted it must call'
				+ ' attach_picker (core/area_thesaurus/js/thesaurus_picker.js) before render.'
				+ ' Caller:',
				self.picker_caller
			);
		}

	// call generic common render
		const result_node = await common.prototype.render.call(this, options)

	// event publish
		event_manager.publish('render_instance', self)


	return result_node
}//end render



/**
* GET_SECTIONS_SELECTOR_DATA
* Returns the data entry for self.tipo that the search widget's sections_selector
* uses to populate its typologies and sections list.
*
* The search component calls this method on its caller (this area) to retrieve
* the structured data it needs to render filter choices scoped to the area's
* section type (e.g. 'dd100' for thesaurus, 'dd5' for ontology).
*
* @returns {Object|undefined} The single self.data item whose tipo matches self.tipo,
*   or undefined if self.data is empty or no match exists.
*/
area_thesaurus.prototype.get_sections_selector_data = function() {

	const self = this

	const sections_selector_value = self.data.find(item => item.tipo===self.tipo)

	return sections_selector_value
}//end get_sections_selector_data



/**
* NAVIGATE
* Applies a navigation action (e.g. page change, hierarchy level change) and
* re-renders the content area without rebuilding the full wrapper.
*
* Workflow:
*  1. Adds the 'loading' CSS class to self.node.content_data for a visual spinner.
*  2. Executes the optional options.callback (e.g. to update pagination state).
*  3. Calls self.refresh() with render_level:'content' and build_autoload:true so
*     only the tree list is redrawn — the wrapper node and search panel are preserved.
*  4. Removes 'loading' in the finally block regardless of success or failure.
*
* (!) navigation_history is extracted from options but never used; it is kept
* for forward-compatibility with the common navigation contract.
*
* @param {Object} options - Navigation options.
*   @param {Function} [options.callback] - Optional async function to execute before refreshing (e.g. update rqo.sqo.offset).
*   @param {boolean}  [options.navigation_history=false] - Reserved; currently unused by this implementation.
* @returns {Promise<boolean>} Always true after the refresh completes.
*/
area_thesaurus.prototype.navigate = async function(options) {

	const self = this

	// options
		const callback				= options.callback
		const navigation_history	= options.navigation_history!==undefined
			? options.navigation_history
			: false

	// loading
		self.node.content_data.classList.add('loading')

	try {

		// callback execute
		if (callback) {
			await callback()

			if(SHOW_DEBUG===true) {
				// console.log("-> Executed section navigate received callback:", callback);
			}
		}

		// refresh
		await self.refresh({
			build_autoload	: true,
			render_level	: 'content',
			destroy			: false
		})

	} catch (error) {
		console.error("Error in area_thesaurus navigate:", error);
	} finally {
		// always remove loading class
		self.node.content_data.classList.remove('loading')
	}


	return true
}//end navigate



/**
* GET_TOTAL
* Returns the number of term records found by the last search or initial load.
*
* Reads the ts_search.found array from the first entry of self.data.
* ts_search is only present after a filtered search response; on a plain
* tree load the property is absent and the method returns 0.
*
* Used by the search panel and pagination widgets to display result counts.
*
* @returns {number} Count of found term records, or 0 when no search result data is available.
*/
area_thesaurus.prototype.get_total = function() {

	const self = this

	const data = self.data || []

	// ts_search is present only in search-result data frames, not in plain tree responses.
	const ts_search = data[0]?.ts_search || {}

	const found = ts_search.found || []

	return found.length
}//end get_total



// @license-end
