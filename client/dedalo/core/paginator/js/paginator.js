// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global Promise, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// import
	import {event_manager} from '../../common/js/event_manager.js'
	import {common} from '../../common/js/common.js'
	import {render_paginator} from './render_paginator.js'
	import {render_paginator_mini} from './render_paginator_mini.js'
	import {render_paginator_micro} from './render_paginator_micro.js'



/**
* PAGINATOR
* Client-side pagination controller that tracks the current position in a paginated
* record list and coordinates navigation between pages.
*
* Responsibilities:
* - Holds all pagination state: total record count, current page, page boundaries,
*   and pre-calculated navigation offsets (first / prev / next / last).
* - Delegates the actual total-count query to `this.caller.get_total()` so that
*   the owning section or portal supplies the correct data source.
* - Publishes named events (e.g. 'paginator_goto_<id>') that the owning section
*   subscribes to in order to reload data at the new offset.
* - Supports three render variants (full, mini, micro) via prototype delegation to
*   render_paginator, render_paginator_mini, and render_paginator_micro.
*
* Lifecycle: construct → init() → build() → render() → destroy()
* The constructor only declares properties; all real initialization is in init().
*
* Usage:
*   const p = new paginator()
*   p.init({ caller: section_instance, mode: 'list' })
*   await p.build()
*   const node = await p.render({ mode: 'micro' })
*/
export const paginator = function() {

	this.id					= null

	this.model				= null
	this.mode				= null
	this.events_tokens		= null
	this.node				= null

	this.caller				= null

	// Pagination state — all set by _update_pagination_props() after get_total() resolves.
	this.total				= null // {number} total record count returned by the data source
	this.total_pages		= null // {number} Math.ceil(total / limit)
	this.page_number		= null // {number} 1-based current page index
	this.prev_page_offset	= null // {number} offset - limit (may be negative; checked before use)
	this.next_page_offset	= null // {number} offset + limit

	this.page_row_begin		= null // {number} 1-based index of the first record on this page (for display)
	this.page_row_end		= null // {number} 1-based index of the last record on this page (for display)

	// Pre-computed absolute offsets for navigation buttons.
	this.offset_first		= null // {number} always 0
	this.offset_prev		= null // {number} Math.max(0, offset - limit)
	this.offset_next		= null // {number} offset + limit (caller must guard against overshooting total)
	this.offset_last		= null // {number} limit * (total_pages - 1)

	this.status				= null // {string} lifecycle stage: 'initializing' | 'initialized' | 'building' | 'built' | 'rendered'

	this.id_variant			= null // {string|null} optional suffix used when multiple paginators coexist

	this.show_interface 	= null // {Object} display-behaviour flags (e.g. { show_all: true })
}//end paginator



/**
* COMMON FUNCTIONS
* Extend paginator with shared prototype methods from common and render modules.
* Render variants are bound here; the actual DOM logic lives in each render_* module.
*/
// prototypes assign
	paginator.prototype.edit			= render_paginator.prototype.edit
	paginator.prototype.edit_in_list	= render_paginator.prototype.edit
	paginator.prototype.list			= render_paginator.prototype.edit // same as edit
	paginator.prototype.mini			= render_paginator_mini.prototype.mini
	paginator.prototype.micro			= render_paginator_micro.prototype.micro
	paginator.prototype.render			= common.prototype.render
	paginator.prototype.refresh			= common.prototype.refresh



/**
* INIT
* Initialises the paginator instance with the provided options.
* Must be called exactly once — a second call on the same instance logs an error
* and (in debug mode) shows an alert, then returns false.
*
* Sets up the unique id ('paginator_' + caller.id), resolves show_interface defaults,
* and transitions status to 'initialized'. Does NOT fetch totals or render DOM.
*
* @param {Object} options - Initialisation options
* @param {Object} options.caller - Owning section/portal instance; must expose
*   rqo.sqo.limit, rqo.sqo.offset, get_total(), id, mode, and status.
* @param {string} [options.mode] - Render mode override; defaults to options.caller.mode
* @param {Object} [options.show_interface] - Partial display-behaviour overrides
*   merged with defaults ({ show_all: true }). Unknown keys from options are kept;
*   missing keys fall back to the defaults defined inside this method.
* @returns {boolean} true on success, false if already initialised (duplicate guard)
*/
paginator.prototype.init = function(options) {

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

	if (!options.caller) {
		console.error("Paginator options caller not found:", options);
	}

	// set vars
		self.model			= 'paginator'
		self.mode			= options.mode || options.caller.mode
		self.caller			= options.caller
		self.events_tokens	= []
		self.node			= null

	// serialize the paginator.Create the unique token
		self.id = 'paginator_'+self.caller.id

	// show_interface. object . Defines useful view custom properties to take control
	// of some common component behaviors
	// if show_interface is defined in properties used the definition, else use this default
		const default_show_interface = {
			show_all	: true, // bool true
		}
		// set the instance show_interface
		self.show_interface = (!options.show_interface)
			? default_show_interface
			: (()=>{
				const new_show_interface = options.show_interface
				// add missing keys
				for (const [key, value] of Object.entries(default_show_interface)) {
					if (new_show_interface[key]===undefined) {
						new_show_interface[key] = value
					}
				}

				return new_show_interface
				}
			  )()

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Async build step: inherits permissions from the caller and transitions status
* to 'built'. Publishes the 'built_<id>' event so that orchestrators waiting on
* the paginator's ready signal can proceed.
*
* Does not fetch data or render DOM — that happens in render().
*
* @returns {Promise<boolean>} Resolves to true when build is complete.
*/
paginator.prototype.build = async function() {
	// const t0 = performance.now()

	const self = this

	// status update
		self.status = 'building'

	// permissions. Inherits permissions from the caller
		self.permissions = self.caller.permissions

	// status update
		self.status = 'built'

	// event publish
		event_manager.publish('built_' + self.id)


	return true
}//end build



/**
* DESTROY
* Tears down the paginator instance by unsubscribing all registered event listeners.
* Does not remove the DOM node — the caller is responsible for DOM cleanup.
*
* All tokens accumulated in self.events_tokens are passed to
* event_manager.unsubscribe(). The returned array of results is stored in
* result.delete_self for the caller to inspect if needed.
*
* @returns {Promise<Object>} result object with a `delete_self` array containing
*   the return values of each event_manager.unsubscribe() call.
*/
paginator.prototype.destroy = async function() {

	const self = this

	const result = {}

	// get the events that the instance was created
		const events_tokens = self.events_tokens

	// delete the registered events
		const delete_events = events_tokens.map(current_token => event_manager.unsubscribe(current_token))

	result.delete_self = delete_events


	return result
}//end destroy



/**
* _TOTAL_PROMISE
* @private
* @type {Promise<number>|null}
* A private property to hold the pending promise for the total count API call.
* This prevents multiple concurrent API calls if get_total is invoked rapidly.
*/
paginator.prototype._total_promise = null; // Initialize this property once, likely after prototype definition



/**
* GET_TOTAL
* Fetches the total count of records asynchronously from an API.
* Ensures only one API call is active at a time to prevent redundant requests.
* Once the total is fetched, it updates all pagination-related properties on the instance.
* @return {Promise<number>} A Promise that resolves with the total count of records.
*/
paginator.prototype.get_total = async function() {
	// If a promise to fetch the total is already pending, return that existing promise.
	// This is the core of our debouncing/queueing mechanism.
	if (this._total_promise) {
		return this._total_promise;
	}

	// Create and store a new promise for the current API call.
	// This promise will be resolved or rejected based on the API call's outcome.
	this._total_promise = (async () => {
		try {
			// Execute the actual API call to get the total.
			// This is where your external data source is queried.
			const total = await this.caller.get_total();

			// After successfully getting the total, calculate and update
			// all derived pagination properties on the instance.
			this._update_pagination_props(total);

			// Once the operation completes (successfully), clear the promise
			// so that future calls to get_total will trigger a new API request.
			this._total_promise = null;

			return total; // Resolve the promise with the fetched total
		} catch (error) {
			// --- Error Handling ---
			// Log the error for debugging purposes.
			console.error("paginator.get_total: Error fetching total from API:", error);

			// In case of an error, clear the promise so that the next call to get_total
			// will attempt to re-fetch the total, rather than endlessly returning a rejected promise.
			this._total_promise = null;

			// Re-throw the error so that the original caller of get_total can handle it.
			throw error;
		}
	})(); // Immediately invoke this async IIFE to create and assign the promise.


	return this._total_promise; // Return the promise that was just created/stored
}//end get_total



/**
* _UPDATE_PAGINATION_PROPS
* @private
* Calculates and updates all derived pagination properties on the paginator instance.
* This method is called internally after the total count has been successfully fetched.
* @param {number} total The total count of records (should be a non-negative number).
*/
paginator.prototype._update_pagination_props = function(total) {

	const self = this

	// short vars
	let limit		= self.get_limit()
	let offset		= self.get_offset()

	// pages fix vars

	// Normalize to numbers and ensure values are non-negative to prevent unexpected calculations (e.g., NaN).
	self.total	= Math.max(0, Number(total) || 0)

	limit		= Number(limit)
	offset		= Number(offset)

	if (Number.isNaN(limit)) {
		limit = 0
	}
	if (Number.isNaN(offset)) {
		offset = 0
	}

	self.limit	= Math.max(0, limit)
	self.offset	= Math.max(0, offset)

	// Calculate total pages. Handle 'limit' being zero to avoid division by zero.
	// If total > 0 but limit is 0, it implies one "page" of all items.
	self.total_pages = self.limit > 0 ? Math.ceil(self.total / self.limit) : (self.total > 0 ? 1 : 0);

	// Calculate current page number.
	// Assuming get_page_number handles cases where offset/limit lead to invalid page numbers.
	this.page_number = self.get_page_number(self.limit, self.offset);

	// page offset
	self.prev_page_offset	= self.offset - self.limit
	self.next_page_offset	= self.offset + self.limit

	// Calculate the display range for the current page (e.g., "Showing 11-20 of 100").
	self.page_row_begin	= (self.total===0) ? 0 : self.offset + 1;
	self.page_row_end	= self.get_page_row_end(self.page_row_begin, self.limit, self.total);

	// offset fix
	// Calculate offsets for navigation links.
	self.offset_first	= 0;
	self.offset_prev	= (self.offset > self.limit) ? self.offset - self.limit : 0
	self.offset_next	= self.offset + self.limit
	self.offset_last	= self.limit * (self.total_pages -1)
}//end _update_pagination_props



/**
* GET_LIMIT
* Reads the current page size (number of records per page) from the caller's
* search query object. Warns if the value is undefined, which would cause
* incorrect pagination calculations downstream.
*
* @returns {number|undefined} The limit value from caller.rqo.sqo.limit,
*   or undefined if not yet set.
*/
paginator.prototype.get_limit = function() {

	const limit = this.caller.rqo.sqo.limit
	if (limit===undefined) {
		console.warn('Paginator limit is empty!', limit, typeof limit);
	}

	return limit
}//end get_limit



/**
* GET_OFFSET
* Reads the current record offset (zero-based position of the first record on
* the current page) from the caller's search query object. Warns if the value
* is undefined, which would cause incorrect pagination calculations downstream.
*
* @returns {number|undefined} The offset value from caller.rqo.sqo.offset,
*   or undefined if not yet set.
*/
paginator.prototype.get_offset = function() {

	const offset = this.caller.rqo.sqo.offset
	if (offset===undefined) {
		console.warn('Paginator offset is empty!', offset, typeof offset);
	}

	return offset
}//end get_offset



/**
* SMOOTH_PAGE_SWAP
* The rows change height from page to page (a record's value is one line on one
* page and eight on the next), and replacing them made the panel jump — on a
* phone, where the inspector sits above the section, that jump moves the whole
* form under the user's finger.
*
* A page turn is a FLIP: the new rows are already in the DOM when this runs, so
* the FIRST keyframe (the height before the request) is applied before the next
* paint, and the browser grows/shrinks the container over the page turn instead
* of snapping it. The container is clipped while it animates, so the new rows
* never paint over the paginator on the way down.
*
* @param {HTMLElement|null} node - The persistent rows container (.list_body).
* @param {number} height_from - Its height, measured BEFORE the page turn.
* @returns {void}
*/
const smooth_page_swap = function(node, height_from) {

	if (!node || !(height_from>0) || typeof node.animate!=='function') {
		return
	}

	const height_to = node.getBoundingClientRect().height
	// nothing to smooth: same height, an empty page, or not laid out
	if (!(height_to>0) || Math.abs(height_to-height_from)<2) {
		return
	}
	// the user asked for less motion: a page turn is not an animation surface
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return
	}

	const previous_overflow	= node.style.overflow
	node.style.overflow		= 'hidden'

	// 200ms = --transition-base, same curve as --ease-standard: a page turn is
	// the same weight of change as the rest of the interface's motion.
	const animation = node.animate(
		[
			{ height: height_from + 'px' },
			{ height: height_to + 'px' }
		],
		{ duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
	)
	const restore = () => {
		node.style.overflow = previous_overflow
	}
	animation.addEventListener('finish', restore)
	animation.addEventListener('cancel', restore)
}//end smooth_page_swap



/**
* PAGINATE
* Navigates to the page starting at the given absolute record offset.
*
* Guards against calls that arrive before the owning section or the paginator
* itself have finished rendering — both checks log a warning and return false
* rather than triggering an overlapping data fetch.
*
* Side effects:
* - Publishes the 'paginator_goto_<id>' event with the new offset; the owning
*   section subscribes to this event via event_manager and calls update_pagination().
* - Adds a 'loading' CSS class to self.node immediately for visual feedback, then
*   subscribes a one-time handler to 'render_<caller.id>' that removes it.
* - (!) The 'render_<self.id>' subscription at the end of this method is intentionally
*   NOT added to events_tokens and therefore will NOT be cleaned up by destroy().
*
* @param {number} offset - Zero-based absolute record offset to navigate to.
* @returns {Promise<boolean>} true when the navigation event was dispatched,
*   false when the call was ignored because the element or paginator is not ready.
*/
paginator.prototype.paginate = async function(offset) {

	const self = this

	// avoid overlap section calls if not ready
		if (self.caller.model!=='time_machine' && self.caller.status!=='rendered') {
			console.warn(`/// [paginator.paginate] Ignored (1) paginate offset (element is not ready status: ${self.caller.status}). offset:`, offset);
			return false
		}

	// avoid overlap section calls if not ready
		if (self.status!=='rendered') {
			console.warn(`/// [paginator.paginate] Ignored (2) paginate offset (paginator is not ready status: ${self.status}). offset:`, offset);
			return false
		}

	// preserve caller wrapper height to prevent blink
		// if(self.caller.node){
		// 	self.caller.node[0].style.minHeight = self.caller.node[0].offsetHeight + 'px'
		// }

	// the rows container whose height changes with the page. Measured NOW, while
	// the old page is still mounted (see smooth_page_swap).
	// DIRECT child only: an edit section's node also CONTAINS the inspector, and
	// its open history panels have their own .list_body — animating one of those
	// on a section page turn would move the wrong block.
	// A direct .list_body may still be `display: contents` and measure 0 (the
	// inspector's Component history): fall back to the caller's own node, so those
	// panels get the same height FLIP as every other list.
		const list_body = self.caller.node?.querySelector
			? self.caller.node.querySelector(':scope > .list_body')
			: null
		const caller_node = self.caller.node?.getBoundingClientRect
			? self.caller.node
			: null
		const height_node = (list_body && list_body.getBoundingClientRect().height > 0)
			? list_body
			: caller_node
		const height_from = height_node
			? height_node.getBoundingClientRect().height
			: 0

	// set the new offset to the current paginator
		// self.offset = offset

	// publish event (section is listen this event to refresh)
		event_manager.publish('paginator_goto_'+self.id, offset)

	// paginator content data update
		// Note that caller refresh the paginator too, adding loading class feels more responsive for user
		self.node.classList.add('loading')

		const render_handler = () => {
			self.node.classList.remove('loading')
		}
		self.events_tokens.push(
			// ONE-SHOT: a repeating listener would replay the stale `height_from`
			// on every later render of the caller (a save, a mode change).
			event_manager.subscribe_once('render_'+self.caller.id, () => {
				render_handler()
				smooth_page_swap(height_node, height_from)
			})
		)
		// on destroy, remove loading class to the node	(! do not include this subscription into events_tokens)
		event_manager.subscribe('render_'+self.id, render_handler)


	return true
}//end paginate



/**
* GET_PAGE_NUMBER
* Converts a zero-based record offset and a page size into a 1-based page number.
* Returns 1 for the first page (offset 0) or when item_per_page is zero or negative
* (guard against division by zero).
*
* Formula: Math.ceil(offset / item_per_page) + 1 when offset > 0.
*
* @param {number} item_per_page - Number of records per page (the limit). Must be > 0
*   for a meaningful result; values ≤ 0 return page 1 unconditionally.
* @param {number} offset - Zero-based index of the first record on the current page.
* @returns {number} 1-based current page number (always ≥ 1).
*/
paginator.prototype.get_page_number = function(item_per_page, offset) {

	// protect against invalid or zero item_per_page to avoid division by zero or Infinity
	if (item_per_page<=0) {
		return 1
	}

	if (offset>0) {
		const page_number = Math.ceil(offset/item_per_page)+1 ;
		return page_number;
	}

	return 1;
}//end get_page_number



/**
* GET_PAGE_ROW_END
* Calculates the 1-based index of the last record visible on the current page,
* clamped to total_records so the last page does not show a phantom end row.
*
* Returns 0 when there are no records (total_records === 0).
*
* @param {number} page_row_begin - 1-based index of the first record on this page.
* @param {number} item_per_page - Number of records per page (the limit).
* @param {number} total_records - Total number of records across all pages.
* @returns {number} 1-based index of the last record on this page, or 0 if empty.
*/
paginator.prototype.get_page_row_end = function(page_row_begin, item_per_page, total_records) {
	if (total_records===0) {
		return 0
	}
	const page_row_end = page_row_begin + item_per_page -1;
	if (page_row_end > total_records) {
		return total_records
	}

	return page_row_end;
}//end get_page_row_end



/**
* GO_TO_PAGE_JSON
* Navigates to an arbitrary page given its 1-based page number.
* Validates that the target page is in range and differs from the current page
* before computing the new offset and calling paginate().
*
* Used by render_paginator's "go-to-page" input field (Enter key handler).
*
* @param {number} page - 1-based page number to jump to.
* @returns {boolean} true when navigation was triggered, false when the page
*   is invalid (out of range, equal to the current page, or NaN-like).
*/
paginator.prototype.go_to_page_json = function(page) {

	const self = this

	// short vars
		const total_pages	= self.total_pages
		const item_per_page	= self.limit
		const current_page	= self.page_number

	// check valid page
		if (page==current_page || page<1 || page>total_pages) {
			console.log("[go_to_page_json] Invalid page:", page);
			return false
		}

	// new offset
		const new_offset = ((page -1) * item_per_page)

	// search with new offset
		self.paginate(new_offset)


	return true
}//end go_to_page_json



/**
* NAVIGATE_TO_NEXT_PAGE
* Convenience wrapper that advances to the page immediately after the current one.
* Delegates to go_to_page_json(), which guards against navigating past the last page.
*
* @returns {boolean} true when navigation was triggered, false if already on the last page.
*/
paginator.prototype.navigate_to_next_page = function() {

	const self = this

	// short vars
		const current_page	= self.page_number
		const page			= current_page + 1

	return self.go_to_page_json(page)
}//end navigate_to_next_page



/**
* NAVIGATE_TO_PREVIOUS_PAGE
* Convenience wrapper that moves back to the page immediately before the current one.
* Delegates to go_to_page_json(), which guards against navigating before page 1.
*
* @returns {boolean} true when navigation was triggered, false if already on the first page.
*/
paginator.prototype.navigate_to_previous_page = function() {

	const self = this

	// short vars
		const current_page	= self.page_number
		const page			= current_page - 1

	return self.go_to_page_json(page)
}//end navigate_to_previous_page



/**
* SHOW_ALL
* Publishes the 'paginator_show_all_<id>' event.
* The owning portal subscribes to this event and responds by setting
* rqo.sqo.limit to the SERVER's client ceiling (common/js/sqo_limit.js
* max_page_limit — never 0: the server read 0 as the same ceiling and clamped
* in silence, audit P2-31 / CLI-29), then refreshing the data.
*
* The show_interface.show_all flag (set during init) controls whether the
* render layer exposes a "Show all" button to the user.
*
* @returns {boolean} Always true (fire-and-forget; no error path).
*/
paginator.prototype.show_all = function() {

	const self = this

	// publish event (section is listen this event to refresh)
		event_manager.publish('paginator_show_all_' + self.id)


	return true
}//end show_all



/**
* RESET_PAGINATOR
* Publishes the 'reset_paginator_<id>' event, passing the desired limit value.
* The owning section/portal subscribes to this event and restores the page size
* to the given limit (the value saved before show_all() was triggered), then
* refreshes the data. Used by the "Reset" button in micro/mini render variants.
*
* @param {number} limit - Page size to restore (typically the value stored in
*   show_all_status.limit before show_all() was called).
* @returns {boolean} Always true (fire-and-forget; no error path).
*/
paginator.prototype.reset_paginator = function(limit) {

	const self = this

	// publish event (section is listen this event to refresh)
		event_manager.publish(
			'reset_paginator_' + self.id,
			limit
		)


	return true
}//end reset_paginator



// @license-end
