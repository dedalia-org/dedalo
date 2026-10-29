// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* RELATION_LIST
* Client-side controller for the "relation list" widget.
*
* A relation list shows all records from any section that reference the
* currently-open record via a Dédalo relation.  The server resolves which
* sections are involved and returns a heterogeneous list whose columns differ
* per section type; this module issues the API requests and stores the result
* so that render_relation_list.js can paint the grid.
*
* Responsibilities:
*  - Builds and fires the `get_relation_list` API read request (SQO mode
*    `related`, filtered by the host record's locator).
*  - Fires a separate `count` API call to obtain the total number of related
*    records across all sections (used by the paginator; cached in `self.total`
*    so repeated page turns do not re-count).
*  - Exposes `get_related_records` for retrieving the full (unlimited) list of
*    section_ids for a single section_tipo.
*  - Exposes `open_related_records` as a thin delegation to `open_records_in_window`,
*    which opens a filtered section view in a popup or existing window.
*
* Data shape returned by the server (see the block comment below for a full
* example):
*  {
*    context : [ { section_tipo, section_label, component_tipo, component_label }, … ]
*    data    : [ { section_tipo?, section_id?, from_component_tipo?, value? }, … ]
*  }
*  The context array drives column headers; each entry in data either begins a
*  new record row (when it carries `section_tipo`+`section_id`) or appends a
*  cell value to the current row.
*
* Prototype methods are composed from:
*  - common.prototype  — lifecycle (destroy, render, refresh, build_rqo_show)
*  - render_relation_list.prototype — edit render method
*
* Main export: relation_list (constructor function, used via get_instance).
*/

/*

	// FORMAT OF THE JSON GET FROM SERVER
	// the context is the header of the list, with the columns resolution
	// the data is the rows of the list
	// it can mix some different columns (number, types, name of columns) which come from different sections

	{
		"context": [
			{
				"section_tipo": "oh1",
				"section_label": "Oral History",
				"component_tipo": "id",
				"component_label": "id"
			},
			{
				"section_tipo": "oh1",
				"section_label": "Oral History",
				"component_tipo": "oh14",
				"component_label": "code"
			},
			{
				"section_tipo": "oh1",
				"section_label": "Oral History",
				"component_tipo": "oh22",
				"component_label": "title"
			},
			{
				"section_tipo": "pci1",
				"section_label": "Intangible heritage",
				"component_tipo": "id",
				"component_label": "id"
			},
			{
				"section_tipo": "pci1",
				"section_label": "Intangible heritage",
				"component_tipo": "pci32",
				"component_label": "Denomination"
			}
		],
		"data": [
			{
				"section_tipo": "oh1",
				"section_id": 1
			},
			{
				"from_component_tipo": "oh14",
				"value": "eog34"
			},
			{
				"from_component_tipo": "oh22",
				"value": "Interview to cc"
			},
			{
				"section_tipo": "oh1",
				"section_id": 2
			},
			{
				"from_component_tipo": "oh14",
				"value": "eog38"
			},
			{
				"from_component_tipo": "oh22",
				"value": "Interview to jj"
			},
			{
				"section_tipo": "pci1",
				"section_id": 32
			},
			{
				"from_component_tipo": "pci32",
				"value": "h-kold38"
			}
		]
	}
*/



// import
	import {common} from '../../common/js/common.js'
	import {render_relation_list} from './render_relation_list.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {paginator} from '../../paginator/js/paginator.js'
	import {clone, open_records_in_window} from '../../common/js/utils/index.js'
	import {response_data, request_failed} from '../../common/js/api_error.js'
	import {request_complete} from '../../common/js/sqo_limit.js'



/**
* RELATION_LIST
* Constructor for the relation_list widget instance.
* Declares all instance properties as null/empty so that the prototype
* methods can rely on a predictable shape; actual values are assigned during
* init() and build().
*/
export const relation_list = function() {

	this.id						= null

	// element properties declare
	this.model					= null
	this.type					= null
	this.tipo					= null
	this.section_tipo			= null
	this.section_id				= null
	this.mode					= null
	this.lang					= null

	this.datum					= null
	this.context				= null
	this.data					= null

	this.node					= null
	this.status					= null
	this.filter					= null

	this.request_config_object	= null
	this.rqo					= null

	// paginator. The compact '1-10 of 4.683' strip (mode 'mini'), the same one
	// the inspector's Latest changes / Component history panels render.
	this.paginator				= null

	// (!) events_tokens accumulates event subscription handles so that
	// common.prototype.destroy can unsubscribe them all in one pass.
	this.events_tokens			= []

	return true
}//end relation_list



/**
* COMMON FUNCTIONS
* Extend instance with shared prototype methods from common and render modules.
* Individual source methods carry their own doc-blocks at definition site.
*/
// prototypes assign
	relation_list.prototype.destroy			= common.prototype.destroy
	relation_list.prototype.edit			= render_relation_list.prototype.edit
	relation_list.prototype.render			= common.prototype.render
	relation_list.prototype.refresh			= common.prototype.refresh
	relation_list.prototype.build_rqo_show	= common.prototype.build_rqo_show



/**
* INIT
* Bootstraps the relation_list instance from the provided options object.
* Sets all scalar properties to their initial values and marks the instance
* as initialized.  Must be called exactly once; a second call on the same
* instance is a programming error that is caught and reported.
*
* Pagination defaults: limit=10, offset=0 (first page).  Pass `options.limit`
* and `options.offset` to start at a different page.
*
* (!) The guard on `this.is_init` detects duplicated event bindings that can
*     arise when the same widget node is accidentally initialized twice.  In
*     debug mode an alert() fires so the developer notices immediately.
*
* @param {Object} options - initialization parameters
* @param {string} options.section_tipo - ontology tipo of the host section
* @param {string|number} options.section_id - record id of the host section
* @param {string} options.tipo - ontology tipo for this relation_list component
* @param {string} [options.type='detail'] - display type hint passed to the renderer
* @param {number} [options.limit=10] - maximum rows per page
* @param {number} [options.offset=0] - zero-based row offset for the first page
* @param {number|null} [options.total=null] - pre-computed total; skips the count request when provided
* @returns {boolean} true on success, false when a duplicate init is detected
*/
relation_list.prototype.init = function(options) {

	const self = this

	// safe init double control. To detect duplicated events cases
		if (typeof this.is_init!=='undefined') {
			console.error('Duplicated init for element:', this);
			if(SHOW_DEBUG===true) {
				alert('Duplicated init element');
			}
			return false
		}
		this.is_init = true

	// status update
		self.status = 'initializing'

	self.model			= 'relation_list'
	self.type			= options.type || 'detail'
	self.section_tipo	= options.section_tipo
	self.section_id		= options.section_id
	self.tipo			= options.tipo
	self.mode			= 'edit'
	self.node			= null
	self.context 		= {}
	self.limit			= options.limit ?? 10
	self.offset			= options.offset ?? 0
	self.total			= options.total ?? null

	// paginator. ONE strip component for the whole app: 'mini' is the compact
	// row-range design the inspector's Latest changes panel already renders.
	self.paginator = new paginator()
	self.paginator.init({
		caller	: self,
		mode	: 'mini'
	})
	// paginator_goto_ event. The strip publishes the target offset; the panel
	// listens to relation_list_paginator_<section_tipo> and rebuilds the list.
	self.events_tokens.push(
		event_manager.subscribe('paginator_goto_'+self.paginator.id, (offset) => {
			self.offset = offset
			event_manager.publish('relation_list_paginator_'+self.section_tipo, self)
		})
	)

	// status update
	self.status = 'initialized'

	return true
}//end init



/**
* BUILD
* Fetches the relation list data from the server and, when the total is not
* yet known, fires a separate count request.
*
* Two API calls may be made:
*  1. `get_relation_list` read request (SQO mode `related`, filtered by
*     the host record's locator) — populates `self.datum` with context + data.
*  2. A `count` request using a new SQO without limit/offset — populates
*     `self.total`.  The count is only fired when `self.total` is falsy, so
*     subsequent page turns skip it.
*
* The `source` object identifies the widget to the API; the SQO instructs the
* search engine to return records from any section (`section_tipo: ['all']`)
* that have a relation pointing at the current record (host section_tipo +
* section_id).
*
* After a successful build, `self.datum` has the shape described in the module
* comment and `self.rqo` is retained on the instance so that methods such as
* `get_related_records` can clone and modify it.
*
* @param {boolean} [autoload=true] - when false, skips the read request (datum
*   must be pre-populated; useful in tests or server-side-render scenarios)
* @returns {Promise<boolean>} resolves to true when the build completes; false
*   with no record (no request sent) or a failed read (self.build_error set)
*/
relation_list.prototype.build = async function(autoload=true){

	const self = this

	// no record (a record-less edit view): a null pin is never sent (0 stays a valid id)
		if (self.section_id===null || self.section_id===undefined || self.section_id==='') {
			self.status = 'built'
			return false
		}
		self.build_error = null

	// status update
		self.status = 'building'

	// self.datum. On building, if datum is not created, creation is needed
		self.datum = self.datum || {
			data	: [],
			context	: []
		}
		self.data = self.data || {}

	// source
	// Identifies this widget type to the server-side API dispatcher.
		const source = {
			section_tipo	: self.section_tipo,
			section_id		: self.section_id,
			tipo			: self.tipo,
			mode			: self.mode,
			model			: self.model,
			action			: 'get_relation_list'
		}

	// sqo, use the "related" mode to get related sections that call to the current record (current section_tipo and section_id)
	// `section_tipo: ['all']` tells the search engine to include every ontology section.
	// `filter_by_locators` restricts the result to records that hold a relation pointing
	// at the host record (self.section_tipo + self.section_id).
		const sqo = {
			section_tipo		: ['all'],
			mode				: 'related',
			limit				: self.limit,
			offset				: self.offset,
			full_count			: self.full_count,
			filter_by_locators	: [{
				section_tipo	: self.section_tipo,
				section_id		: self.section_id
			}]
		}

	// rqo, use the 'get_realtion_list' action from the API
		const rqo = {
			action	: 'read',
			source	: source,
			sqo		: sqo
		}
		self.rqo = rqo

	// read + count run CONCURRENTLY. They are independent (the count SQO ignores
	// limit/offset): run in sequence, a busy server made the panel wait for two
	// round trips back to back before it could paint.
		const tasks = []

	// load data if not yet received as an option
		if (autoload===true) {

			tasks.push(
				data_manager.request({
					use_worker	: true,
					body		: self.rqo
				})
				.then((api_response) => {
					// a refused/failed read leaves an explicit empty state (never a count over nothing)
					if (request_failed(api_response)) {
						self.build_error = api_response.error || {}
						self.datum = {data:[], context:[]}
						return
					}
					// set the result to the datum
					self.datum = response_data(api_response)
				})
			)
		}

	// total
	// if the total is calculated and stored previously, don't calculate again.
	// total is the sum of all related sections to this record and don't change with the pagination.
		if(!self.total){

			//sqo, use the related mode to get all sections that call to the current record
			// is created new sqo because the sqo of the instance has offset and limit and total need to be the sum of all related sections
			const sqo_count = {
				section_tipo		: ['all'],
				mode				: 'related',
				filter_by_locators	: [{
					section_tipo	: self.section_tipo,
					section_id		: self.section_id
				}]
			}
			//rqo, use the 'count' action of the API
			// `prevent_lock` avoids acquiring a DB lock for a pure count query.
			const rqo = {
				action			: 'count',
				prevent_lock	: true,
				sqo				: sqo_count,
				source			: source
			}

			// set the response to the self.total
			tasks.push(
				data_manager.request({
					body		: rqo,
					use_worker	: true
				})
				.then(function(response){
					if(!request_failed(response)){
						self.total = response_data(response).total
					}
				})
			)
		}

		await Promise.all(tasks)

	// failed read: the count's total must not survive it
		if (self.build_error) {
			self.total = 0
			self.status = 'built'
			return false
		}

	// paginator. Its state is read from caller.rqo at render time (get_total), so
	// a 'built' status here is enough for every page turn to repaint the strip.
		if(self.paginator){
			await self.paginator.build()
		}

	// status update
		self.status = 'built'

	return true
}//end build



/**
* GET_TOTAL
* The count the paginator asks its caller for (paginator.get_total contract).
* `self.total` is already resolved by build()'s count request and does not
* change with pagination — a page turn must not re-count.
*
* @returns {Promise<number|null>} total related records across all sections;
*   null when the count request failed (the strip stays hidden, as on one page)
*/
relation_list.prototype.get_total = async function() {

	return this.total
}//end get_total



/**
* GET_RELATED_RECORDS
* Returns the full (unlimited) list of section_ids for a single section_tipo
* that are related to the current host record.
*
* Clones the existing `self.rqo` so the shared state is not mutated, then
* overrides `sqo.section_tipo` to target only the requested section and walks
* the result page by page at the server's client ceiling (request_complete,
* common/js/sqo_limit.js) — never one request with `limit: 0`, which the
* server read as the same ceiling and truncated in silence (audit P2-31).
*
* The returned array contains the numeric section_ids extracted from data
* entries whose `component_tipo` is `'id'` — those entries act as row-start
* sentinels in the flat data array returned by the API.
*
* Used by the header click handler in render_relation_list to populate
* `open_related_records` with the full id set before opening a filtered window.
*
* @param {string} section_tipo - ontology tipo identifying the target section
* @returns {Promise<Array|boolean>} array of section_id numbers, or false when
*   the API returns an invalid response
*/
relation_list.prototype.get_related_records = async function(section_tipo) {

	const self = this

	// get full list of records (without limit) from relation_list for this section

	// clone existing rqo
		const rqo = clone(self.rqo)

	// change some custom properties
		rqo.sqo.section_tipo	= [section_tipo]

	// call API. A completeness read: every page, at the ceiling
		const datum = await request_complete(rqo, {
			count_rows : (page) => page.data.filter(el => el.component_tipo==='id').length
		})

	// check response
		if (!datum) {
			console.error('invalid response from API (get_related_records)');
			return false
		}

	// ar_section_id. Array of section_id used for filter q
	// Filter entries whose component_tipo is 'id' — these are the row-start sentinels
	// in the flat data array and carry the numeric section_id for each record.
		const ar_section_id = datum.data
			.filter(el => el.component_tipo==='id')
			.map(el => el.section_id)

	// debug
		if(SHOW_DEBUG===true) {
			console.log('))) get_related_records ar_section_id:', ar_section_id);
		}


	return ar_section_id
}//end get_related_records



/**
* OPEN_RELATED_RECORDS
* Opens a filtered section view for the given section_tipo and record ids.
* Delegates entirely to the shared `open_records_in_window` utility, which
* creates a temporary dummy section with a pre-built SQO filter, saves that
* filter server-side in the user session, then opens a popup/tab that picks
* it up — avoiding URL-length limits when the id list is large.
*
* `target_window` controls window re-use:
*  - null (default): re-uses the window named 'section_view' if it is already
*    open, replacing its content.
*  - a unique string (e.g. section_tipo + timestamp): forces a new window,
*    used when the user holds ALT while clicking the section header.
*
* @param {string} section_tipo - ontology tipo of the section to open
* @param {Array} ar_section_id - array of section_id numbers to filter by
* @param {string|null} target_window - window.open target name; null reuses existing
* @returns {Promise<boolean>} resolves to true when the window has been opened,
*   false when the browser refused it (pop-up blocker); the user is notified by
*   open_window itself
*/
relation_list.prototype.open_related_records = async function(section_tipo, ar_section_id, target_window) {

	const self = this

	const window_options = {
		caller			: self,
		section_tipo	: section_tipo,
		ar_section_id	: ar_section_id,
		target_window	: target_window
	}

	return open_records_in_window( window_options )
}//end open_related_records



// @license-end
