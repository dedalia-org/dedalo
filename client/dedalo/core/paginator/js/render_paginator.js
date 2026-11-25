// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'



/**
* RENDER_PAGINATOR
* Client-side render module for the full paginator variant used in edit, list,
* and time-machine views of a section or portal.
*
* Responsibilities:
* - Build the navigation button strip (first / prev / next / last).
* - Render a page-info area that shows the current page number, total pages,
*   and a displayed-records summary ("Showing X-Y of Z").
* - Provide an inline numeric input that lets the user jump directly to any page.
* - Defer the DB round-trip (get_total) until the browser is idle so that the
*   outer wrapper can be inserted into the DOM immediately without blocking paint.
*   Active-value callbacks are queued and fired once the total resolves.
*
* Entry point: render_paginator.prototype.edit (aliased as list / tm / edit_in_list
* by paginator.js). The micro and mini variants live in their own render modules.
*
* Exports: render_paginator (constructor, prototype carries .edit only)
*/
export const render_paginator = function() {

	return true
}//end render_paginator



/**
* EDIT
* Build and return the full paginator DOM node for edit / list / time-machine mode.
*
* When render_level is 'content', only the inner content_data fragment is returned
* (used during refresh cycles so the caller can replace just the inner content
* without rebuilding the outer wrapper). For any other render_level the full wrapper
* is returned with content_data already appended.
*
* Side effects:
* - Calls get_content_data, which schedules an async get_total via dd_request_idle_callback.
* - Attaches an alt+click debug listener to the wrapper when SHOW_DEBUG is true.
*
* @param {Object} options - Render options passed down from paginator.prototype.render
* @param {string} [options.render_level='full'] - 'full' builds outer wrapper + content; 'content' returns inner fragment only
* @returns {Promise<HTMLElement>} wrapper (full) or content_data fragment (content refresh)
*/
render_paginator.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// refresh case. Only content data is returned
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			// REFRESH swaps the strip that is already in the DOM (common.render
			// 'content' replaces wrapper.content_data with this return). Await the
			// ACTIVATION first: a strip handed over in its phase-1 state is all
			// inactive arrows + "Loading data …" until get_total returns — and on a
			// large log (dd15 is 2.4M rows; its bare COUNT is seconds) that reads as
			// the icons dying and coming back on EVERY pagination click. Waiting here
			// keeps the OLD strip live and clickable until the new one is complete,
			// so the swap is a text change, never a dead-arrows flash.
			// But when the caller's total was INVALIDATED (a new search sets
			// caller.total=null) the wait is a real COUNT round-trip, and the old
			// strip would read as the new result. Mark it 'stale' (dimmed, inert)
			// until the swap removes it. Pagination clicks keep a cached total and
			// are untouched.
			const counting	= self.caller && self.caller.total==null
			const old_node	= self.node?.content_data
			if (counting && old_node) {
				old_node.classList.add('stale')
			}
			await content_data.ready
			return content_data
		}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_paginator paginator edit full_width css_wrap_rows_paginator text_unselectable'
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data

		if(SHOW_DEBUG===true) {
			const click_handler = (e) => {
				if (e.altKey) {
					e.stopPropagation()
					e.preventDefault()
					console.log('/// selected instance:', self);
					return
				}
			}
			wrapper.addEventListener('click', click_handler)
		}


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Build the inner content fragment containing all paginator controls.
*
* The function is intentionally split into two phases to avoid blocking the
* initial paint:
*
* Phase 1 (synchronous) — all DOM nodes are created and appended to a
* DocumentFragment. Navigation buttons start with the CSS class 'inactive';
* the page-info span shows "Loading data …". Each button and info node
* registers a closure (active_value) that knows how to update itself once
* real pagination values are available.
*
* Phase 2 (deferred via dd_request_idle_callback) — self.get_total() is
* called. After the Promise resolves, every active_value callback is invoked
* in order, passing the corresponding property from self (e.g. self.total,
* self.page_number). This activates buttons and fills in the page counts.
*
* The active_values array is the glue between the two phases: it holds
* { name, callback } pairs where name is the property key on self whose
* value the callback needs.
*
* @param {Object} self - The paginator instance (provides get_total, paginate, page_number, total, total_pages, etc.)
* @returns {Promise<HTMLElement>} content_data div containing all paginator controls
*/
const get_content_data = async function(self) {

	// debug
		if(SHOW_DEBUG===true) {
			// const model = self.id.split("_")[1] +" "+ self.id.split("_")[2]
			// console.log(`++++++++++++++++++++++ total_pages: ${total_pages}, page_number: ${page_number}, offset_first: ${offset_first}, model: ${self.caller.model} `);
		}

	// active_values. Storage functions to be called when the total count is available
	// This allows scaffolding to be rendered before getting the result from the DB.
		const active_values = []

	// DOM fragment
		const fragment = new DocumentFragment()

	// nav_buttons
		const paginator_div_links = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'nav_buttons',
			parent			: fragment
		})

		// btn paginator_first
			const paginator_first = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_first_icon inactive',
				title			: (get_label.first_page || 'First page'),
				parent			: paginator_div_links
			})
			// active_value
			// Activates the "go to first page" button only when not already on page 1.
			// The mousedown listener is added only when the button is active to avoid
			// spurious paginate calls from a permanently inactive button.
			const update_offset_first = (value) => {
				if(self.page_number>1) {
					paginator_first.classList.remove('inactive')
					const mousedown_handler = (e) => {
						e.stopPropagation()
						self.paginate(value)
					}
					paginator_first.addEventListener('mousedown', mousedown_handler)
				}else{
					paginator_first.classList.add('inactive')
				}
			}
			active_values.push({
				name		: 'offset_first',
				callback	: update_offset_first
			})

		// btn paginator_prev
			const paginator_prev = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_prev_icon inactive',
				title			: (get_label.previous_page || 'Previous page'),
				parent			: paginator_div_links
			})
			// active_value
			// prev_page_offset is negative when on the first page; use >=0 as the
			// active guard so that offset 0 (first page) does not enable the button.
			const update_offset_prev = (value) => {
				if(self.prev_page_offset>=0) {
					paginator_prev.classList.remove('inactive')
					const mousedown_handler = (e) => {
						e.stopPropagation()
						self.paginate(value)
					}
					paginator_prev.addEventListener('mousedown', mousedown_handler)
				}else{
					paginator_prev.classList.add('inactive')
				}
			}
			active_values.push({
				name		: 'offset_prev',
				callback	: update_offset_prev
			})

		// placeholder for section ID
			if(self.caller && self.caller.section_id) {
				const placeholder_section_id = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'placeholder_section_id',
					text_content	: self.caller.section_id,
					parent			: paginator_div_links
				})
			}

		// btn paginator_next
			const paginator_next = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_next_icon inactive',
				title			: (get_label.next_page || 'Next page'),
				parent			: paginator_div_links
			})
			// active_value
			// next_page_offset >= total means we are on the last page; disable the button.
			const update_offset_next = (value) => {
				if(self.next_page_offset<self.total) {
					paginator_next.classList.remove('inactive')
					const mousedown_handler = (e) => {
						e.stopPropagation()
						self.paginate(value)
					}
					paginator_next.addEventListener('mousedown', mousedown_handler)
				}else{
					paginator_next.classList.add('inactive')
				}
			}
			active_values.push({
				name		: 'offset_next',
				callback	: update_offset_next
			})

		// btn paginator_last
			const paginator_last = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_last_icon inactive',
				title			: (get_label.last_page || 'Last page'),
				parent			: paginator_div_links
			})
			// active_value
			// page_number >= total_pages means we are on the last page; keep inactive.
			const update_offset_last = (value) => {
				if(self.page_number<self.total_pages) {
					paginator_last.classList.remove('inactive')
					const mousedown_handler = (e) => {
						e.stopPropagation()
						self.paginate(value)
					}
					paginator_last.addEventListener('mousedown', mousedown_handler)
				}else{
					paginator_last.classList.add('inactive')
				}
			}
			active_values.push({
				name		: 'offset_last',
				callback	: update_offset_last
			})

	// paginator_info
		const paginator_info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'paginator_info',
			parent			: fragment
		})

		// page_position. "Page [n] of N" as ONE unit: on a phone the info block
		// has no box (paginator.less) and these three must wrap together
			const page_position = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'page_position',
				parent			: paginator_info
			})

		// page_info
			const page_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'page_info inactive',
				inner_html		: (get_label.page || 'Page'),
				parent			: page_position
			})

			// input_go_to_page
				const input_go_to_page = ui.create_dom_element({
					element_type	: 'input',
					type			: 'number',
					class_name		: 'input_go_to_page',
					title			: get_label.go_to_page,
					// placeholder	: 1,
					parent			: page_position
				})

				// keyup event
				// NOTE: this event could open/close filter because page has a global keyup listener
				// see page.js add_events to prevent double fire
				const keyup_handler = (e) => {
					e.stopPropagation();
					e.preventDefault()
					if (e.key==='Enter' && input_go_to_page.value.length>0) {
						const page		= parseInt(input_go_to_page.value)
						const result	= self.go_to_page_json(page) // returns bool
						if (result===false) {
							input_go_to_page.classList.add('invalid')
						}else{
							if (input_go_to_page.classList.contains('invalid')) {
								input_go_to_page.classList.remove('invalid')
							}
						}
					}
				}
				input_go_to_page.addEventListener('keyup', keyup_handler)

				// blur event
				// On blur, clear any invalid state and reset the input to the placeholder
				// (current page number) so it does not retain a stale typed value.
				const blur_handler = (e) => {
					if (input_go_to_page.classList.contains('invalid')) {
						input_go_to_page.classList.remove('invalid')
					}
					input_go_to_page.value = null
					fit_input_go_to_page_to_value(input_go_to_page, self.page_number)
				}
				input_go_to_page.addEventListener('blur', blur_handler)

				// input event
				// Resize the input width as the user types so it stays visually tight.
				// Enter key is excluded here because keyup already handles submission.
				const input_handler = (e) => {
					e.preventDefault()
					if (e.key!=='Enter' ) {
						fit_input_go_to_page_to_value(input_go_to_page, input_go_to_page.value)
					}
				}
				input_go_to_page.addEventListener('input', input_handler)

				// active_value
				// Sets the placeholder to the current page number once the total is known.
				const update_page_number = (value) => {
					input_go_to_page.placeholder = value
					fit_input_go_to_page_to_value(input_go_to_page, value)
				}
				active_values.push({
					name		: 'page_number',
					callback	: update_page_number
				})

			// page_info label
			// (!) locale is hardcoded to 'es-ES'. The commented-out line that reads from
			// page_globals.locale was disabled intentionally; do not re-enable without
			// verifying locale availability at render time across all caller contexts.
			const locale = 'es-ES' // (page_globals.locale ?? 'es-CL').replace('_', '-')
			const total_pages_node	= ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'page_info inactive',
				inner_html		: ` Loading data ...  `,
				parent			: page_position
			})
			// active_value
			// Replaces "Loading data ..." with "of <total_pages>" once the DB responds.
			const update_total_pages = (value) => {
				const total_pages_label	= new Intl.NumberFormat(locale, {}).format(value);
				total_pages_node.textContent = (get_label.of || 'of') + ' ' + total_pages_label
				total_pages_node.classList.remove('inactive')
			}
			active_values.push({
				name		: 'total_pages',
				callback	: update_total_pages
			})

		// displayed_records (hidden on edit mode) // page_globals.locale
			const displayed_records_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'displayed_records',
				parent			: paginator_info
			})
			// active_value
			// Formats the "Records shown from X to Y of Z" summary using the v5-inherited
			// label template from get_label.records_displayed. The template uses literal
			// X / Y / Z placeholders that are replaced with locale-formatted numbers.
			// Falls back to a plain English string when the label is not available.
			const update_total = (value) => {
				const total_label = new Intl.NumberFormat(locale, {}).format(value);
				// displayed_records_label . Using legacy format label from v5 in PHP
				const displayed_records_label = get_label.records_displayed
					? (() => {
						// ref: Records shown from X to Y of Z.
						const map = {
							X	: new Intl.NumberFormat(locale, {}).format(self.page_row_begin),
							Y	: new Intl.NumberFormat(locale, {}).format(self.page_row_end),
							Z	: total_label
						};
						return get_label.records_displayed.replace(/X|Y|Z/g, (matched)=> {
							return map[matched];
						})
				      })()
				     : `Showing ${self.page_row_begin}-${self.page_row_end} of ${total_label}`
				displayed_records_node.textContent = displayed_records_label
			}
			active_values.push({
				name		: 'total',
				callback	: update_total
			})

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data paginator css_rows_paginator_content'
		})
		content_data.appendChild(fragment)

	// total. get from DDBB
	// dd_request_idle_callback defers the API call until the browser has spare cycles,
	// ensuring that paint and layout are not blocked by the network round-trip.
	// Once get_total resolves, all queued active_value callbacks are fired in
	// registration order to activate buttons and fill in the page counts.
		// The activation is EXPOSED as `content_data.ready` so the refresh path can
		// await a fully-activated strip before swapping it into the DOM (see edit()).
		// The initial full render never awaits it — first paint stays progressive.
		// Resolved on failure too: a hanging promise would freeze every refresh.
		content_data.ready = new Promise((resolve) => {
			dd_request_idle_callback(
				() => {
					self.get_total()
					.then(() => {
						// fire all active_values functions
						const active_values_length = active_values.length
						for (let i = 0; i < active_values_length; i++) {
							const item = active_values[i]
							// value is from self assigned vars like 'self.total'
							const value = self[item.name]
							// execute function passing selected value as param
							item.callback(value)
						}
						page_node.classList.remove('inactive')
					})
					.catch((error) => {
						console.error('paginator get_total failed:', error)
					})
					.finally(() => resolve(true))
				}
			)
		})

	// tooltips
	ui.activate_tooltips(paginator_div_links, '.btn')


	return content_data
}//end get_content_data



/**
* FIT_INPUT_GO_TO_PAGE_TO_VALUE
* Resize the go-to-page input element's width to fit the number of characters
* in the current value, with a minimum of 3 characters.
*
* Delegates to ui.fit_input_width_to_value with a fixed minimum of 3 chars
* so that a single-digit page number does not produce a tiny, hard-to-click input.
*
* @param {HTMLElement} input_node - The numeric input element to resize
* @param {number|string} page_number - Current page number or typed value; used to derive char count
* @returns {void}
*/
const fit_input_go_to_page_to_value = function(input_node, page_number) {

	ui.fit_input_width_to_value(input_node, page_number, 3)
}//end fit_input_go_to_page_to_value



// @license-end
