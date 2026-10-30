// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* COMPONENT_SVG
* Client-side controller for SVG (Scalable Vector Graphics) file components in Dédalo.
*
* Manages the full lifecycle of a single SVG component instance: initialisation,
* rendering across modes (edit / list / search / TM), and persistence of SVG asset
* metadata back to the server.
*
* SVG components are used both for standalone SVG assets and as annotation overlay
* layers attached to image components (see component_image). Unlike component_image,
* this controller does not embed a vector editor; it relies on the shared
* component_common/common prototype chain for all data-change and API interactions.
*
* All lifecycle and data-change methods are delegated to the shared
* component_common and common prototype chains — no custom overrides are defined here.
* View-specific rendering is provided by the render_edit, render_list, and
* render_search modules, which are aliased onto this prototype.
*
* Instance properties (set by component_common.prototype.init during build):
*   id           {string}          - unique component instance identifier
*   model        {string}          - ontology model name, e.g. 'component_svg'
*   tipo         {string}          - ontology tipo key of this component, e.g. 'rsc855'
*   section_tipo {string}          - ontology tipo of the parent section, e.g. 'oh1'
*   section_id   {string|number}   - numeric record identifier for the parent section
*   mode         {string}          - current rendering mode: 'edit' | 'list' | 'search'
*   lang         {string}          - active data language code, e.g. 'lg-nolan'
*   section_lang {string}          - active section language code, e.g. 'lg-eng'
*   context      {Object}          - server-supplied structure context (properties, features, tools)
*   data         {Object}          - server-supplied record data for this component
*   parent       {string}          - tipo of the structural parent (section group or portal)
*   node         {HTMLElement|null}- mounted DOM node; null until render completes
*   tools        {Array}           - tool descriptors available for this component
*   quality      {string}          - active file quality level (e.g. 'standard', 'original')
*   file_name    {string}          - base filename of the associated SVG asset
*   file_dir     {string}          - relative directory path of the SVG asset
*
* @package Dédalo
* @subpackage Core
*/

// imports
	import {common} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_svg} from './render_edit_component_svg.js'
	import {render_list_component_svg} from './render_list_component_svg.js'



/**
* COMPONENT_SVG
* Constructor — declares instance property slots. All values are populated by
* component_common.prototype.init() during the build phase; the declarations here
* serve only as documentation of the expected shape of a fully initialised instance.
*/
export const component_svg = function(){

	this.id

	// element properties declare
	this.model
	this.tipo
	this.section_tipo
	this.section_id
	this.mode
	this.lang

	this.section_lang
	this.context
	this.data
	this.parent
	this.node

	this.tools
	this.quality

	this.file_name
	this.file_dir
}//end component_svg



/**
* COMMON FUNCTIONS
* Extend component_svg with the shared prototype methods from component_common and common.
* No methods are overridden here; component_svg inherits the full standard behaviour
* for lifecycle management, data persistence, and RQO construction.
*/
	// prototypes assign
	// lifecycle
	component_svg.prototype.init				= component_common.prototype.init
	component_svg.prototype.build				= component_common.prototype.build
	component_svg.prototype.render				= common.prototype.render
	component_svg.prototype.refresh				= common.prototype.refresh
	component_svg.prototype.destroy				= common.prototype.destroy

	// change data
	component_svg.prototype.save				= component_common.prototype.save
	component_svg.prototype.update_data_value	= component_common.prototype.update_data_value
	component_svg.prototype.update_datum		= component_common.prototype.update_datum
	component_svg.prototype.change_value		= component_common.prototype.change_value
	component_svg.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_svg.prototype.build_rqo			= common.prototype.build_rqo


	// render
	// (!) tm reuses the list renderer — SVG components have no dedicated TM view.
	component_svg.prototype.list				= render_list_component_svg.prototype.list
	component_svg.prototype.edit				= render_edit_component_svg.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_svg.prototype.search				= async function(options) {
		const {render_search_component_svg} = await import('./render_search_component_svg.js')
		return render_search_component_svg.prototype.search.call(this, options)
	}



// @license-end
