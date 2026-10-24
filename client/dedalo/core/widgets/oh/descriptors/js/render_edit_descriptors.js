// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_DESCRIPTORS
* Edit-mode renderer for the Oral History (OH) descriptors widget.
*
* This module provides the client-side `edit` render path for the `descriptors`
* widget (core/widgets/oh/descriptors). The widget displays the thesaurus
* descriptor terms associated with a record — grouped by IPO entry — as an
* interactive grid.
*
* Responsibilities:
* - Build the edit-mode DOM subtree (wrapper + content_data) for a descriptors
*   widget instance.
* - Render a "Terms" toggle button that, when clicked, switches the widget back
*   to `list` mode and calls `self.refresh()`.
* - Iterate over every IPO entry (`self.ipo`) and, for each one, delegate to
*   `get_value_element` to build a labelled descriptor group containing a
*   `dd_grid` sub-instance loaded with the server-provided terms data.
*
* Data contract (from class.descriptors.php → `self.value`):
*   Each item in `self.value` is a plain object with a nested `.value` property:
*   {
*     value: {
*       key:       number,      // IPO index this item belongs to
*       widget_id: string,      // 'indexation' | 'terms'
*       value:     number|Object // count (indexation) or grid-value object (terms)
*     }
*   }
*
* The exported constructor `render_edit_descriptors` is a no-op function whose
* prototype methods are mixed into the `descriptors` class via
* `descriptors.prototype.edit = render_edit_descriptors.prototype.edit`
* (see descriptors.js). It is never instantiated directly.
*
* Companion files:
* - render_list_descriptors.js — list-mode renderer (same widget, simpler view)
* - descriptors.js             — constructor + prototype wiring
* - class.descriptors.php      — server-side data builder (PHP)
*
* @module render_edit_descriptors
*/

// imports
	import {get_instance} from '../../../../common/js/instances.js'
	import {ui} from '../../../../common/js/ui.js'



/**
* RENDER_EDIT_DESCRIPTORS
* Constructor stub. All logic lives on the prototype and is mixed into `descriptors`.
* @returns {boolean} true
*/
export const render_edit_descriptors = function() {

	return true
}//end render_edit_descriptors



/**
* EDIT
* Render node for use in modes: edit, edit_in_list
*
* Builds the content_data subtree for the descriptors widget in edit mode. If
* `render_level` is `'content'`, returns just the inner `content_data` element
* without the surrounding wrapper (used when the caller manages the wrapper
* itself). Otherwise returns a full wrapper element produced by
* `ui.widget.build_wrapper_edit`, with `content_data` attached as a property.
*
* Called as `this.edit(options)` where `this` is a `descriptors` instance
* (prototype is mixed in via descriptors.js).
*
* @param {Object} options - Render options passed by widget_common.prototype.render.
* @param {string} options.render_level - `'content'` to skip wrapper creation; any
*   other value (typically `'full'`) to return the complete widget wrapper.
* @returns {Promise<HTMLElement>} Resolves to the wrapper element (full render) or
*   the content_data element (content-only render).
*/
render_edit_descriptors.prototype.edit = async function(options) {

	const self = this

	const render_level = options.render_level

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build the full content_data DOM subtree for the edit view.
*
* Creates:
* 1. A `<div class="content_data widget">` root container.
* 2. A `<button class="button_display">` labelled with `get_label.terms` (or
*    `'Terms'` as fallback) that switches the widget back to list mode on
*    `mouseup` and calls `self.refresh()`.
* 3. A `<div class="values_container">` holding one `DocumentFragment` per IPO
*    entry; each fragment is produced by `get_value_element`.
*
* IPO iteration: `self.ipo` is an array of IPO configuration objects (one per
* descriptor group defined in the ontology). For each index `i`, `self.value`
* is filtered to find the data items belonging to that group (`item.key === i`),
* then forwarded to `get_value_element`.
*
* @param {Object} self - The `descriptors` widget instance (`this` from prototype method).
* @param {Array}  self.ipo   - IPO entries from the ontology widget configuration.
* @param {Array}  self.value - Flat array of server-emitted data items (see module doc).
* @returns {Promise<HTMLElement>} Resolves to the populated content_data element.
*/
const get_content_data_edit = async function(self) {

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data widget'
		})

	// button_display
		const button_display = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_display',
			inner_html 		: get_label.terms || 'Terms',
			parent			: content_data
		})
		button_display.addEventListener('mouseup', async function(e){
			e.stopPropagation()

			// change mode
				self.mode = 'list'
				self.node.classList.remove('edit')
				self.node.classList.add('list')

			await self.refresh()
		})

	// values container
		const values_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'values_container',
			parent			: content_data
		})

	// values
		const ipo			= self.ipo
		const ipo_length	= ipo.length
		for (let i = 0; i < ipo_length; i++) {
			// Filter the flat value array to items belonging to IPO group i.
			// Each item carries its group index in `item.key`.
			const data	= self.value.filter(item => item.key===i)
			const node	= await get_value_element(i, data, self)
			values_container.appendChild(node)
		}


	return content_data
}//end get_content_data_edit



/**
* GET_VALUE_ELEMENT
* Build the DOM fragment for one IPO group (one descriptor category).
*
* Produces a `DocumentFragment` containing:
* - A `<div class="label">` showing the current indexation count, e.g. "Total 7".
* - A `<div class="descriptors_list_container">` that, when the count is > 0,
*   is populated asynchronously with a `dd_grid` instance via `render_values`.
*
* Note: the dd_grid append is performed with `.then()` after the fragment is
* returned, so the container may be momentarily empty while the grid resolves.
* Callers appending the fragment to the live DOM will see the grid appear once
* the promise settles.
*
* Note: `data` is the subset of `self.value` where `item.key === i`.
* Items are FLAT — `{widget, key, widget_id, value, ...}` — exactly as the
* server emits them; there is no `.value` envelope. The list-mode counterpart
* (`render_list_descriptors.js`) reads them identically.
*
* @param {number} i    - IPO group index (0-based).
* @param {Array}  data - Data items for this IPO group (subset of `self.value`).
* @param {Object} self - The `descriptors` widget instance.
* @returns {Promise<DocumentFragment>} Resolves to the populated fragment.
*/
const get_value_element = async (i, data, self) => {

	const indexation	= data.find(el => el.widget_id==='indexation')
	// Safely extract the indexation count; default to 0 when the item is absent.
	const value			= indexation?.value || 0

	const fragment = new DocumentFragment()

	// label
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'label',
			text_content	: (get_label.total || 'Total') + ' ' +  (value+''),
			parent			: fragment
		})

	// descriptors_list_container
		const descriptors_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'descriptors_list_container',
			parent			: fragment
		})

	// values dd_grid
		if ( value > 0 ) {
			// Build and append the dd_grid asynchronously; the container is already
			// in the fragment so the node becomes visible when the promise settles.
			render_values(self, data)
			.then(function(dd_grid_node){
				descriptors_list_container.appendChild(dd_grid_node)
			})
		}


	return fragment
}//end get_value_element



/**
* RENDER_VALUES
* Instantiate and render a `dd_grid` for the given IPO group's terms data.
*
* Extracts the 'terms' data item from `data` (the item with `widget_id === 'terms'`),
* wraps its `.value` in a single-element array as required by `dd_grid`'s data
* contract, then calls `get_instance` to build and render the grid with view
* `'descriptors'`.
*
* The `dd_grid` is configured with:
* - `view: 'descriptors'` — selects the descriptor-specific column layout.
* - `mode: 'list'` — read-only display (no inline editing).
* - `data: [terms.value]` — the merged component_grid_value array produced
*   by class.descriptors.php.
*
* (!) If the 'terms' item is absent from `data` (e.g. an empty group), `terms`
* defaults to `{}` and `terms.value` will be `undefined`, which is passed
* to `dd_grid` as `[undefined]`. This is a known edge case; the grid tolerates it
* but callers should ensure the server always emits both 'indexation' and 'terms'
* items for each group when the count > 0.
*
* @param {Object} self - The `descriptors` widget instance.
* @param {Array}  data - Data items for the current IPO group.
* @returns {Promise<HTMLElement>} Resolves to the rendered dd_grid DOM node.
*/
const render_values = function(self, data) {

	return new Promise(async function(resolve){

		// Terms find
		const terms = data.find(el => el.widget_id==='terms') || {}

		// dd_grid_data
		const dd_grid_data	= [terms.value]

		// dd_grid build and append
		const dd_grid		= await get_instance({
			model			: 'dd_grid',
			section_tipo	: self.section_tipo,
			section_id		: self.section_id,
			tipo			: self.section_tipo,
			mode			: 'list',
			view			: 'descriptors',
			lang			: page_globals.dedalo_data_lang,
			data			: dd_grid_data
		})
		await dd_grid.build(false)
		const dd_grid_node = await dd_grid.render()


		resolve(dd_grid_node)
	})
}//end render_values



// @license-end
