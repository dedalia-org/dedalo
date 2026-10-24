// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, Promise */
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'



/**
* RENDER_PAGINATOR_MINI
* Renderer mixin that provides the 'mini' display mode for the paginator component.
*
* 'mini' sits between the full 'edit' renderer (render_paginator.js — which has a
* page-jump input) and the 'micro' renderer (render_paginator_micro.js — which adds
* a 'show all' button). The mini variant is intentionally stripped-down: it shows
* only the four navigation buttons (first / prev / next / last) and a compact
* "X–Y of Z" record-range label. No page-jump input, no show-all control.
*
* Usage pattern (set by paginator.js):
*   paginator.prototype.mini = render_paginator_mini.prototype.mini
*
* The constructor itself is a no-op placeholder — the real state lives on the
* paginator instance that inherits this prototype method. All pagination properties
* (total, total_pages, page_number, offset_*, page_row_begin, page_row_end) are
* populated on `self` by paginator._update_pagination_props() before render.
*
* @exports render_paginator_mini
*/
export const render_paginator_mini = function() {

	return true
}//end render_paginator_mini.js



/**
* MINI
* Render node for use in current mode.
*
* Builds (or refreshes) the mini paginator DOM. The function is async because it
* must await self.get_total(), which may trigger an API call the first time it is
* invoked on the owning paginator instance.
*
* render_level values:
*   'full'    — builds and returns the full wrapper element (first render).
*   'content' — returns only the inner content_data element, used by
*               common.prototype.refresh() to swap content without rebuilding
*               the outer wrapper.
*
* Side effects:
*   - Appends content_data to wrapper.
*   - Stores a direct reference at wrapper.content_data for use by refresh.
*   - Calls add_events(wrapper, self) to register mousedown/click blockers.
*
* @param {Object} options - Render options passed from common.prototype.render.
* @param {string} [options.render_level='full'] - 'full' or 'content'.
* @returns {Promise<HTMLElement>} The outer wrapper element (render_level 'full')
*   or the inner content_data element (render_level 'content').
*/
render_paginator_mini.prototype.mini = async function(options) {

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
			class_name		: 'wrapper_paginator paginator mini full_width css_wrap_rows_paginator text_unselectable'
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data

	// events
		add_events(wrapper, self)


	return wrapper
}//end mini



/**
* ADD_EVENTS
* Attach element generic events to wrapper.
*
* Stops mousedown and click events from bubbling past the paginator wrapper.
* This prevents the host section or list view from interpreting a click on a
* navigation button as a record-selection or row-activation event.
*
* @param {HTMLElement} wrapper - The outermost paginator wrapper element.
* @param {Object} self - The paginator instance (unused here; kept for signature
*   parity with other render modules in case future events need it).
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
* Build the mini paginator's inner DOM from the current pagination state.
*
* Awaits self.get_total() to ensure all pagination properties on `self` are
* up-to-date before reading them. After the await, the following properties
* are read directly from `self` (all set by paginator._update_pagination_props):
*
*   self.total_pages    {number}  Total number of pages given current limit.
*   self.page_number    {number}  Current 1-based page index.
*   self.prev_page_offset {number} Byte offset of the previous page (may be negative
*                                  on page 1, which signals the 'prev' button as inactive).
*   self.next_page_offset {number} Byte offset of the next page; compared against total
*                                  to determine whether the 'next' button is active.
*   self.page_row_begin  {number}  1-based index of the first visible record.
*   self.page_row_end    {number}  1-based index of the last visible record.
*   self.offset_first   {number}  Offset to jump to the first page (always 0).
*   self.offset_prev    {number}  Offset to jump to the previous page.
*   self.offset_next    {number}  Offset to jump to the next page.
*   self.offset_last    {number}  Offset to jump to the last page.
*
* Visibility rule: when total_pages is falsy or < 2, a hidden placeholder div
* with class 'display_none' is returned instead of the real controls. This avoids
* flickering layout shifts when only one page of results exists.
*
* Button activation rule: each nav button is rendered active only when the
* corresponding offset points to a valid page:
*   first/prev — active when page_number > 1 (or prev_page_offset >= 0).
*   next/last  — active when next_page_offset < total (or page_number < total_pages).
* Inactive buttons receive the 'inactive' CSS class and no event listener.
*
* Record-range label: renders as "${page_row_begin}–${page_row_end} of ${total}",
* formatted with Intl.NumberFormat using a hard-coded 'es-ES' locale. The label
* is appended inside a 'paginator_info' container after the nav buttons.
*
* (!) FLAG: locale is hard-coded to 'es-ES'. The commented-out line above it shows
* the intended dynamic derivation from page_globals.locale. Until that is wired up,
* numeric formatting will always use Spanish conventions regardless of the user's
* actual locale. The `page_globals` global (declared in the /*global*\/ header) is
* unused here.
*
* (!) FLAG: The block of commented-out code around 'page_info' / 'total_pages_label'
* (lines 202–208 in the original) was a richer "Page N of M" label. It was replaced
* by the simpler "X–Y of Z" row-range format. The dead code is preserved in place
* per repository convention.
*
* @param {Object} self - The paginator instance.
* @returns {Promise<HTMLElement>} The content_data div containing all mini controls,
*   or a hidden placeholder div when paging is unnecessary.
*/
const get_content_data = async function(self) {

	// total
		const total = await self.get_total()

	// build vars
		const total_pages		= self.total_pages
		const page_number		= self.page_number
		const prev_page_offset	= self.prev_page_offset
		const next_page_offset	= self.next_page_offset
		const page_row_begin	= self.page_row_begin
		const page_row_end		= self.page_row_end
		const offset_first		= self.offset_first
		const offset_prev		= self.offset_prev
		const offset_next		= self.offset_next
		const offset_last		= self.offset_last

	// display none with empty case, or when pages are <2
		if (!total_pages || total_pages<2) {
			const wrap_rows_paginator = ui.create_dom_element({
				element_type	: 'div',
				// total_pages appended as extra class for easier debugging via DevTools
				class_name		: 'content_data paginator display_none ' + total_pages
			})
			return wrap_rows_paginator
		}

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
				class_name		: 'btn paginator_first_icon',
				title			: (get_label.first_page || 'First page'),
				parent			: paginator_div_links
			})
			if(page_number>1) {
				// active: attach listener only when not already on the first page
				const mousedown_handler = (e) => {
					e.stopPropagation()
					self.paginate(offset_first)
				}
				paginator_first.addEventListener('mousedown', mousedown_handler)
			}else{
				paginator_first.classList.add('inactive')
			}

		// btn paginator_prev
			const paginator_prev = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_prev_icon',
				title			: (get_label.previous_page || 'Previous page'),
				parent			: paginator_div_links
			})
			if(prev_page_offset>=0) {
				// active: prev_page_offset is negative on the first page, so >= 0 means there is a prior page
				const mousedown_handler = (e) => {
					e.stopPropagation()
					self.paginate(offset_prev)
				}
				paginator_prev.addEventListener('mousedown', mousedown_handler)
			}else{
				paginator_prev.classList.add('inactive')
			}

		// btn paginator_next
			const paginator_next = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_next_icon',
				title			: (get_label.next_page || 'Next page'),
				parent			: paginator_div_links
			})
			if(next_page_offset<total) {
				// active: next page exists only when its start offset is still within the total count
				const mousedown_handler = (e) => {
					e.stopPropagation()
					self.paginate(offset_next)
				}
				paginator_next.addEventListener('mousedown', mousedown_handler)
			}else{
				paginator_next.classList.add('inactive')
			}

		// btn paginator_last
			const paginator_last = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'btn paginator_last_icon',
				title			: (get_label.last_page || 'Last page'),
				parent			: paginator_div_links
			})
			if(page_number<total_pages) {
				// active: not already on the last page
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
		const locale			= 'es-ES' // (page_globals.locale ?? 'es-CL').replace('_', '-')
		const of_label = get_label.of || 'of'
		// const total_pages_label	= new Intl.NumberFormat(locale, {}).format(total_pages);
		// ui.create_dom_element({
		// 	element_type	: 'span',
		// 	class_name		: 'page_info',
		// 	inner_html		: (get_label.page || 'Page') + ` ${page_number} ` + (get_label.of || 'of') + ` ${total_pages_label} `,
		// 	parent			: paginator_info
		// })
		// displayed_records
		const total_label = new Intl.NumberFormat(locale, {}).format(total);
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'page_info',
			// compact row-range: e.g. "11–20 of 1,234"
			text_content	: `${page_row_begin}-${page_row_end} ${of_label} ${total_label}`,
			parent			: paginator_info
		})

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data paginator css_rows_paginator_content'
		})
		content_data.appendChild(fragment)

	// tooltips. Nav buttons are icon-only: the title is the only affordance.
	// Inactive buttons are pointer-events:none (paginator.less), so a disabled
	// button registers a tooltip but never shows one.
		ui.activate_tooltips(paginator_div_links, '.btn')


	return content_data
}//end get_content_data



// @license-end
