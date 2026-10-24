// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'



/**
* RENDER_PAGINATOR_MICRO
* Compact ("micro") render mode for the paginator component.
*
* This module provides the `micro` prototype method mixed into `paginator` instances
* (see core/paginator/js/paginator.js, `paginator.prototype.micro`).  The micro mode
* renders a minimal navigation strip: a "Show all" toggle, a total-records count,
* four icon-based nav buttons (first / prev / next / last), and a page-position
* indicator (`<current>-<total>` pages).  A "Reset paginator" button is also shown
* when the show-all state is active so the user can revert to the original limit.
*
* Compared with the `mini` mode (render_paginator_mini.js), micro omits the
* row-range display and the locale-formatted total, favouring a smaller footprint
* for contexts such as narrow sidebars or tiled mosaic views.
*
* Lifecycle:
*   1. `paginator.prototype.micro(options)` — builds and returns the full wrapper
*      (or just the inner content_data node when `render_level === 'content'`).
*   2. `get_content_data(self)` — async helper; calls `self.get_total()` (which in
*      turn delegates to `self.caller.get_total()`) and builds the DOM fragment.
*   3. `add_events(wrapper, self)` — attaches mousedown/click capture handlers that
*      stop event bubbling at the paginator boundary.
*
* Key interactions:
*   - Navigation buttons call `self.paginate(offset)` which publishes the
*     `paginator_goto_<id>` event consumed by the owning section/portal.
*   - Show-all stores the previous limit in `self.show_all_status` and calls
*     `self.show_all()`, publishing `paginator_show_all_<id>`.
*   - Reset restores the previous limit via `self.reset_paginator(limit)`,
*     publishing `reset_paginator_<id>`.
*
* @module render_paginator_micro
*/



/**
* RENDER_PAGINATOR_MICRO
* Constructor stub — all behaviour lives on the prototype.
* Instances are never created directly; `paginator.prototype.micro` is assigned
* from `render_paginator_micro.prototype.micro` in paginator.js.
* @returns {boolean} Always true (matches the common paginator constructor contract).
*/
export const render_paginator_micro = function() {

	return true
}//end render_paginator_micro.js



/**
* MICRO
* Build the micro-mode paginator DOM node for the calling paginator instance.
*
* When `options.render_level === 'content'`, only the inner `content_data` element
* is returned (used by `common.prototype.refresh` to swap content without
* rebuilding the outer wrapper).  Otherwise the full wrapper is constructed,
* `content_data` is appended to it, a back-reference (`wrapper.content_data`) is
* stored for later refresh cycles, and generic bubble-stopping events are attached.
*
* The method is async because `get_content_data` must await `self.get_total()`.
*
* @param {Object} options - Render options forwarded by the paginator render pipeline.
* @param {string} [options.render_level='full'] - 'full' builds the outer wrapper;
*   'content' skips the wrapper and returns only the inner content node.
* @returns {Promise<HTMLElement>} The wrapper div (full mode) or the content_data
*   div (content mode).
*/
render_paginator_micro.prototype.micro = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// refresh case. Only content data is returned
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_paginator paginator micro css_wrap_rows_paginator text_unselectable'
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data

	// events
		add_events(wrapper, self)


	return wrapper
}//end edit



/**
* ADD_EVENTS
* Attach mousedown and click handlers to the paginator wrapper that stop event
* propagation, preventing clicks inside the paginator from bubbling to the parent
* section or mosaic container and accidentally triggering row-selection or other
* container-level handlers.
*
* @param {HTMLElement} wrapper - The paginator wrapper element to attach events to.
* @param {Object} self - The paginator instance (unused in handlers but kept for
*   symmetry with add_events in other render_paginator_* modules).
* @returns {boolean} Always true.
*/
const add_events = (wrapper, self) => {

	// mousedown
		const mousedown_handler = (e) => {
			e.stopPropagation()
			// prevent bubble event to container element
			return false
		}
		wrapper.addEventListener('mousedown', mousedown_handler)

	// click
		const click_handler = (e) => {
			e.stopPropagation()
			// prevent bubble event to container element
			return false
		}
		wrapper.addEventListener('click', click_handler)


	return true
}//end add_events



/**
* GET_CONTENT_DATA
* Async factory that constructs the paginator content DOM tree for the micro mode.
*
* Awaits `self.get_total()` (which delegates to `self.caller.get_total()` and
* populates derived pagination props via `_update_pagination_props`).  All
* pagination state is then read directly from the paginator instance.
*
* Visibility rules:
* - When `total_pages` is falsy (0 / null) or less than 2 AND `show_all_status`
*   is not set, a hidden placeholder div is returned so the caller's layout is not
*   disrupted.
* - When `total_pages >= 2`, the full navigation UI is rendered:
*     • Optional "Show all" button (omitted when limit === 1, i.e. mosaic-of-one
*       mode, or when `show_interface.show_all` is false).
*     • A total-records count span.
*     • First / Prev / Next / Last icon buttons; buttons pointing beyond the
*       record boundary are marked `inactive` and receive no click handler.
*     • A page-position info span (`<page_number>-<total_pages>`).
* - When `show_all_status` is set (show-all mode is active) a "Reset paginator"
*   button and a total count are appended regardless of page count.
*
* Offset guards used for button activation:
*   - First/Prev active when `page_number > 1` or `prev_page_offset >= 0`.
*   - Next active when `next_page_offset < total`.
*   - Last active when `page_number < total_pages`.
*
* @param {Object} self - The paginator instance; must expose `get_total()`,
*   `total_pages`, `page_number`, `prev_page_offset`, `next_page_offset`,
*   `offset_first`, `offset_prev`, `offset_next`, `offset_last`, `limit`,
*   `show_interface`, `show_all_status`, `paginate()`, `show_all()`, and
*   `reset_paginator()`.
* @returns {Promise<HTMLElement>} The assembled `content_data` div node containing
*   the full navigation UI, or a hidden placeholder when pagination is not needed.
*/
const get_content_data = async function(self) {

	// total
		const total = await self.get_total()

	// build vars
		const total_pages		= self.total_pages
		const page_number		= self.page_number
		const prev_page_offset	= self.prev_page_offset
		const next_page_offset	= self.next_page_offset
		// const page_row_begin	= self.page_row_begin
		// const page_row_end		= self.page_row_end
		const offset_first		= self.offset_first
		const offset_prev		= self.offset_prev
		const offset_next		= self.offset_next
		const offset_last		= self.offset_last

	// display none with empty case, or when pages are <2 and show_all_status is not set
		if((!total_pages || total_pages<2) && !self.show_all_status) {
			const wrap_rows_paginator = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'content_data paginator display_none ' + total_pages
			})
			return wrap_rows_paginator
		}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// show_all_button. Don't show in mosaics of 1 item (limit 1)
		if ( total_pages>1 ) {

			// show all
				if (self.limit>1 && self.show_interface.show_all ) {
					if (!self.show_all_status && total_pages>1) {

						const show_all_button = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'show_all_button',
							inner_html		: (get_label.show_all || 'Show all') + ' : ',
							parent			: fragment
						})
						const mousedown_handler = (e) => {
							e.stopPropagation()
							// fix show_all_status (store the previous limit value to use wen reset)
							self.show_all_status = {
								limit : self.limit
							}
							// trigger show_all (publish a event listened by the section)
							self.show_all()
						}
						show_all_button.addEventListener('mousedown', mousedown_handler)
					}
				}

			// displayed_total_records
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'displayed_total_records',
					text_content	: `${total} `,
					parent			: fragment
				})

			// navigation
				const paginator_div_links = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'nav_buttons',
					parent			: fragment
				})

				// btn first
					const paginator_first = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'btn paginator_first_icon',
						title			: (get_label.first_page || 'First page'),
						parent			: paginator_div_links
					})
					if(page_number>1) {
						const mousedown_handler = (e) => {
							e.stopPropagation()
							self.paginate(offset_first)
						}
						paginator_first.addEventListener('mousedown', mousedown_handler)
					}else{
						paginator_first.classList.add('inactive')
					}

				// btn previous
					const paginator_prev = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'btn paginator_prev_icon',
						title			: (get_label.previous_page || 'Previous page'),
						parent			: paginator_div_links
					})
					if(prev_page_offset>=0) {
						const mousedown_handler = (e) => {
							e.stopPropagation()
							self.paginate(offset_prev)
						}
						paginator_prev.addEventListener('mousedown', mousedown_handler)
					}else{
						paginator_prev.classList.add('inactive')
					}

				// btn next
					const paginator_next = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'btn paginator_next_icon',
						title			: (get_label.next_page || 'Next page'),
						parent			: paginator_div_links
					})
					if(next_page_offset<total) {
						const mousedown_handler = (e) => {
							e.stopPropagation()
							self.paginate(offset_next)
						}
						paginator_next.addEventListener('mousedown', mousedown_handler)
					}else{
						paginator_next.classList.add('inactive')
					}

				// btn last
					const paginator_last = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'btn paginator_last_icon',
						title			: (get_label.last_page || 'Last page'),
						parent			: paginator_div_links
					})
					if(page_number<total_pages) {
						const mousedown_handler = (e) => {
							e.stopPropagation()
							self.paginate(offset_last)
						}
						paginator_last.addEventListener('mousedown', mousedown_handler)
					}else{
						paginator_last.classList.add('inactive')
					}

				// paginator_info
					const paginator_info = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'paginator_info',
						parent			: fragment
					})
					// page_info
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'page_info',
						text_content	: `${page_number}-${total_pages}`,
						parent			: paginator_info
					})

				// tooltips. Nav buttons are icon-only: the title is the only affordance.
				// Inactive buttons are pointer-events:none (paginator.less), so a disabled
				// button registers a tooltip but never shows one.
					ui.activate_tooltips(paginator_div_links, '.btn')

		}//end if ( total_pages>1 )

	// reset paginator
		if(self.show_all_status) {
			const reset_paginator_button = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'reset_paginator_button',
				inner_html		: get_label.reset || 'Reset',
				parent			: fragment
			})
			const mousedown_handler = (e) => {
				e.stopPropagation()
				// trigger show_all (publish a event listened by the section)
				self.reset_paginator( self.show_all_status.limit )
				// reset show_all_status
				self.show_all_status = null
			}
			reset_paginator_button.addEventListener('mousedown', mousedown_handler)

			// paginator_info
			const paginator_info = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'paginator_info',
				parent			: fragment
			})
			// displayed_total_records
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'displayed_total_records',
				text_content	: `: ${total}`,
				parent			: paginator_info
			})
		}

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data paginator css_rows_paginator_content'
		})
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



// @license-end
