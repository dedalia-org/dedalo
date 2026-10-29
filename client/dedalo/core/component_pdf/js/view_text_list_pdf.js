// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'



/**
* VIEW_TEXT_LIST_PDF
* Minimal icon-only render view for the PDF component in 'text' list context.
*
* This view is selected by render_list_component_pdf when self.context.view === 'text'.
* It produces a lightweight <span> wrapper containing a generic PDF icon <img>.
* No actual file URL is resolved: the icon always points to the static SVG at
* DEDALO_CORE_URL/themes/default/icons/file-pdf-o.svg, making this view suitable
* for plain-text export contexts, data-export tables, or column cells where a small
* fixed-size icon is sufficient and media-file lookup would be wasteful.
*
* The module exports a single static method (view_text_list_pdf.render) that is
* called directly — the constructor itself is a no-op stub that returns true, following
* Dédalo's convention for view modules that do not need instance state.
*
* Callers:
*   render_list_component_pdf.prototype.list — routes here when view === 'text'
*   component_pdf.prototype.list / .tm       — both delegate through render_list_component_pdf
*
* Contrast with sister views:
*   view_default_list_pdf — resolves the real file URL and attaches a viewer open-handler.
*   view_mini_pdf         — resolves the thumb URL for autocomplete / relation chips.
*/
export const view_text_list_pdf = function() {

	return true
}//end view_text_list_pdf



/**
* RENDER
* Builds a <span> wrapper containing the generic PDF icon image.
*
* Unlike view_default_list_pdf, this render does NOT attempt to resolve a real
* file URL from self.data.entries.  It always uses the static icon SVG bundled
* with the Dédalo theme.  The resulting node has no click / mousedown handler,
* so no viewer popup is triggered.
*
* CSS classes on the wrapper follow the shared Dédalo component-wrapper convention:
*   'wrapper_component'  — identifies the node as a component wrapper
*   self.model           — e.g. 'component_pdf'
*   self.mode            — e.g. 'list'
*   'media'              — marks this as a media-type component node
*   'view_<self.view>'   — e.g. 'view_text'
*
* @param {Object} self    - The component_pdf instance being rendered.
*   self.model {string}   — component type identifier (e.g. 'component_pdf')
*   self.mode  {string}   — render mode (e.g. 'list')
*   self.view  {string}   — view name (expected 'text' for this module)
* @param {Object} options - Forwarded from render_list_component_pdf; not currently
*   used by this view but accepted to satisfy the shared render(self, options) contract.
* @returns {Promise<HTMLElement>} Resolves to the assembled <span> wrapper node.
*/
view_text_list_pdf.render = async function(self, options) {

	// image append to wrapper
		const url = DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'span',
			class_name		: `wrapper_component ${self.model} ${self.mode} media view_${self.view}`
		})

	// image
		const image	= document.createElement('img')
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.src = url
		wrapper.appendChild(image)


	return wrapper
}//end render



// @license-end
