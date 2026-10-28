// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* COMPONENT_INVERSE
* Client-side model for component_inverse — a read-only "backlink" component
* that shows which external records reference the current record.
*
* Responsibilities:
* - Holds the standard instance state (tipo, section_tipo, context, data, …).
* - Delegates the full lifecycle (init / build / render / refresh / destroy /
*   save / load_data) and RQO construction to the shared component_common and
*   common prototypes — no custom logic is defined here.
* - Exposes four render entry-points (list / tm / edit / search) that are
*   implemented by the render_edit_component_inverse, render_list_component_inverse
*   and render_search_component_inverse sub-modules.
*
* This component is intentionally thin: all relationship resolution is
* performed server-side by class.component_inverse.php via
* section->get_inverse_references().  The client is responsible only for
* rendering the resolved locators delivered in self.data.
*
* Data shape (self.data):
*   {
*     entries : [
*       {
*         from_section_id    : string|number,  // section_id of the referencing record
*         from_section_tipo  : string,          // tipo of the referencing section
*         from_component_tipo: string           // tipo of the portal/relation component that holds the reference
*       },
*       …
*     ]
*   }
*
* Because the server computes inverse references on the fly (no database write
* ever occurs), the save prototype is inherited only as a no-op safety alias;
* user interaction is read-only in all views.
*
* @module component_inverse
*/

// imports
	import {common} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_inverse} from '../../component_inverse/js/render_edit_component_inverse.js'
	import {render_list_component_inverse} from '../../component_inverse/js/render_list_component_inverse.js'
	import {render_search_component_inverse} from '../../component_inverse/js/render_search_component_inverse.js'



/**
* COMPONENT_INVERSE
* Constructor for the component_inverse instance.
* All properties are intentionally left uninitialized (undefined) so that
* component_common.prototype.init populates them from the caller's options object.
* No default values are set here because this component carries no writable state
* of its own beyond the standard component properties.
*/
export const component_inverse = function(){

	// element properties declare
	this.model        // {string}      structure model name, always 'component_inverse'
	this.tipo         // {string}      component structure tipo, e.g. 'oh47'
	this.section_tipo // {string}      parent section tipo, e.g. 'oh1'
	this.section_id   // {number|string} current record's section_id
	this.mode         // {string}      rendering mode: 'edit' | 'list' | 'search'
	this.lang         // {string}      active language code, e.g. 'lg-eng'

	this.section_lang // {string}      section-level language (may differ from component lang)
	this.context      // {Object}      server-side context: properties, tools, permissions, view, …
	this.data         // {Object}      resolved backlink payload — see module header for shape
	this.parent       // {string}      tipo of the structural parent (section group, portal, etc.)
	this.node         // {HTMLElement|null} the component's root DOM node once rendered
	this.id           // {string}      unique instance id assigned during init
}//end component_inverse



/**
* COMMON FUNCTIONS
* Wire component_inverse into the shared lifecycle and render chain by
* assigning prototype methods from component_common and common.
*
* No logic is defined in this file beyond these assignments.  The split is
* intentional: all components share identical init/build/render/refresh/destroy
* behaviour, while view-specific rendering lives in the render_* sub-modules.
*
* Prototype map:
*   init        — component_common  — populates properties, subscribes events
*   build       — component_common  — loads context + data via build_autoload
*   destroy     — common            — tears down DOM nodes and event subscriptions
*   save        — component_common  — server persistence (no-op for read-only component)
*   load_data   — component_common  — fetches data without a full rebuild
*   update_datum — component_common — merges a build's datum into the shared datum
*   build_rqo   — common            — constructs the request-query object (RQO)
*   render      — common            — orchestrates mode dispatch (list/edit/…)
*   refresh     — common            — destroy + build + render cycle
*   list / tm   — render_list_component_inverse — renders in list / time-machine mode
*   edit        — render_edit_component_inverse — renders in edit mode (view: default | mini | print)
*   search      — render_search_component_inverse — read-only search view; emits NO
*                 search criterion (component_inverse is unsearchable server-side)
*/
// prototypes assign
	component_inverse.prototype.init		= component_common.prototype.init
	component_inverse.prototype.build		= component_common.prototype.build
	component_inverse.prototype.destroy		= common.prototype.destroy
	component_inverse.prototype.save		= component_common.prototype.save
	component_inverse.prototype.load_data	= component_common.prototype.load_data
	// build() calls it for a non-standalone instance (tool_time_machine's caller rebuild)
	component_inverse.prototype.update_datum	= component_common.prototype.update_datum
	component_inverse.prototype.build_rqo	= common.prototype.build_rqo

	// render
	component_inverse.prototype.render		= common.prototype.render
	component_inverse.prototype.refresh		= common.prototype.refresh
	component_inverse.prototype.list		= render_list_component_inverse.prototype.list
	component_inverse.prototype.edit		= render_edit_component_inverse.prototype.edit
	component_inverse.prototype.search		= render_search_component_inverse.prototype.search
	// get_search_value. Read by search.js serialize_filter_model. Always [] —
	// component_inverse owns no stored value and conform.ts refuses a leaf on it.
	component_inverse.prototype.get_search_value = render_search_component_inverse.prototype.get_search_value



// @license-end
