// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {common} from '../../common/js/common.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {clone} from '../../common/js/utils/index.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_image} from '../../component_image/js/render_edit_component_image.js'
	import {render_list_component_image} from '../../component_image/js/render_list_component_image.js'



/**
* COMPONENT_IMAGE
* Client-side controller for image components in Dédalo.
*
* Manages the full lifecycle of a single image component instance: initialisation,
* rendering (edit / list / search / TM views), SVG-layer vector-drawing integration,
* image quality switching, and persistence of layer data back to the server.
*
* Key responsibilities:
* - Delegates lifecycle and data-change operations to component_common / common prototypes.
* - Exposes view-specific render methods by aliasing the corresponding render_* module
*   prototypes (edit, list, search, tm).
* - Owns the optional vector_editor (lazy-loaded SVG drawing canvas built on SvgCanvas).
*   When the editor is active, `ar_layers` is the single source of truth for layer state,
*   and `vector_editor.prototype.save_data` serialises it back into changed_data.
*
* REMOVED 2026-09-04 (P2-25 / DEAD-02): `component_image.prototype.update_draw_data`.
* It read a bare `project` global — the paper.js document object of an editor this
* component has not used since the SvgCanvas rewrite — so calling it threw a
* ReferenceError. It had no caller: the only one, in vector_editor.js's colour
* picker, had already been commented out, and `vector_editor.prototype.save_data`
* is the live serialiser. A method that cannot be called without throwing is not a
* fallback, it is a trap for the next reader.
* - Handles quality changes across both the vector-editor path and the raw SVG <object>
*   path via the unified `image_quality_change_handler`.
*
* Data shape (self.data.entries[]):
*   {
*     lib_data            : Array<LayerDescriptor> // vector-editor layer definitions
*     svg_file_data       : string                 // full SVG string exported for persistence
*     files_info          : Array<FileInfo>        // per-quality/per-extension availability
*     original_file_name  : string                 // uploaded filename before normalisation
*     original_normalized_name : string            // filesystem-safe normalised filename
*   }
*
* LayerDescriptor shape:
*   { layer_id, layer_data, layer_color, layer_opacity, user_layer_name, name, visible }
*
* @package Dédalo
* @subpackage Core
*/
export const component_image = function(){

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
}//end component_image



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// lifecycle
	component_image.prototype.init				= component_common.prototype.init
	component_image.prototype.build				= component_common.prototype.build
	component_image.prototype.render			= common.prototype.render
	component_image.prototype.refresh			= common.prototype.refresh
	// destroy: release the vector editor's document-level listeners (if it was
	// loaded) before delegating to the generic destructor.
	// (!) forward the args: refresh() calls destroy(false, true, false) to tear
	// down dependencies while keeping self.node; dropping them ran the default
	// (delete_self=true) and nulled the node, breaking refresh.
	component_image.prototype.destroy			= function(delete_self, delete_dependencies, remove_dom) {
		if (this.vector_editor && typeof this.vector_editor.destroy==='function') {
			this.vector_editor.destroy()
			this.vector_editor = null
		}
		return common.prototype.destroy.call(this, delete_self, delete_dependencies, remove_dom)
	}

	// change data
	component_image.prototype.save				= component_common.prototype.save
	component_image.prototype.update_data_value	= component_common.prototype.update_data_value
	component_image.prototype.update_datum		= component_common.prototype.update_datum
	component_image.prototype.change_value		= component_common.prototype.change_value
	component_image.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_image.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_image.prototype.list				= render_list_component_image.prototype.list
	component_image.prototype.edit				= render_edit_component_image.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_image.prototype.search			= async function(options) {
		const {render_search_component_image} = await import('../../component_image/js/render_search_component_image.js')
		return render_search_component_image.prototype.search.call(this, options)
	}



/**
* INIT
* Initialises the component instance after the generic component_common init completes.
* Sets up image-specific instance properties and subscribes to the quality-change event
* for this component id.
*
* Instance properties set here:
*   self.image_container  {HTMLElement|null}  - DOM container for the SVG <object> tag
*   self.img_height       {number|null}       - natural pixel height of the loaded image
*   self.img_width        {number|null}       - natural pixel width of the loaded image
*   self.img_src          {string|null}       - current image URI (updated on quality change)
*   self.img_view_height  {number}            - max display height for the image (px)
*   self.canvas_height    {number}            - canvas height for the vector editor (px)
*   self.canvas_width     {number|null}       - canvas width (computed later, null until set)
*   self.canvas_node      {HTMLElement|null}  - DOM canvas element used by the vector editor
*   self.ar_layers        {Array}             - ordered list of LayerDescriptor objects
*   self.vector_editor    {Object|null}       - lazy-loaded vector_editor instance
*
* @param {Object} options - initialisation options forwarded from build()
* @returns {Promise<boolean>} resolves with the result of component_common.prototype.init
*/
component_image.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await component_common.prototype.init.call(this, options)

	// image_container node
		self.image_container 		= null
	// image size
		self.img_height				= null
		self.img_width				= null
	// image source (URI)
		self.img_src 				= null
	// fixed height for the image
		self.img_view_height		= 1200
		self.canvas_height			= 432
		self.canvas_width			= null
	// canvas node
		self.canvas_node			= null

	// editor init vars
		self.ar_layers				= []
		self.vector_editor			= null

	// subscribe to quality change event (unified handler)
		self.events_tokens.push(
			event_manager.subscribe('image_quality_change_'+self.id, self.image_quality_change_handler.bind(self))
		)


	return common_init
}//end init



/**
* GET_DATA_TAG
* Builds a fresh tag descriptor for creating a new SVG annotation tag in the
* associated text-area component. Called when the user initiates a new draw tag
* from within a component that is linked to this image component.
*
* The returned object carries the layer metadata needed by the text-area so that
* the tag can reference the correct SVG layers later. When no lib_data exists yet
* (image not yet saved / no layers defined), a minimal single-raster-layer descriptor
* is returned as a safe default.
*
* @returns {Object} data_tag - tag descriptor with shape:
*   {
*     type          : 'draw',
*     tag_id        : null,
*     state         : 'n',      // 'n' = new / unsaved
*     label         : '',
*     data          : '',
*     last_layer_id : number|null,
*     layers        : Array<{ layer_id: number, user_layer_name: string }>
*   }
*/
component_image.prototype.get_data_tag = function() {

	const self = this

	const data_tag = {
		type			: 'draw',
		tag_id			: null,
		state			: 'n',
		label			: '',
		data			: '',
		last_layer_id	: null,
		layers			: [{
			layer_id		: 0,
			user_layer_name	: 'raster'
		}]
	}

	// get the lib_data of the image component
	const lib_data	= self.get_lib_data()

	// if the image has not lib data stop
	if(!lib_data){
		return data_tag
	}

	// last_layer_id
		const last_layer_id	= self.get_last_layer_id()

	// layers
		const layers = lib_data.map((item) => {
			const layer	= {
				layer_id		: item.layer_id,
				user_layer_name	: item.user_layer_name
			}
			return layer
		})

	// data_tag
		data_tag.last_layer_id	= last_layer_id + 1
		data_tag.layers			= layers

	return data_tag
}//end get_data_tag



/**
* GET_LIB_DATA
* Returns the lib_data array from the first entry of self.data.
* lib_data is the vector-editor layer store (SvgCanvas / svgEdit format) and is
* the canonical source for all layer operations when a vector editor is in use.
*
* Returns null when the first entry does not exist or has no lib_data, which is
* the expected state for a freshly uploaded image that has never been annotated.
*
* @returns {Array|null} lib_data - array of LayerDescriptor objects, or null
*/
component_image.prototype.get_lib_data = function() {

	const self = this

	const data		= self.data || {}
	const entries	= data.entries || []

	const lib_data = typeof entries[0]!=='undefined' && entries[0].lib_data
		? entries[0].lib_data
		: null


	return lib_data
}//end get_lib_data



/**
* GET_LAST_LAYER_ID
* Scans lib_data and returns the highest numeric layer_id currently in use.
* Used to compute the next layer_id when the user adds a new annotation tag
* (see get_data_tag: last_layer_id + 1).
*
* (!) Assumes lib_data is non-null. Call get_lib_data() first and guard
* against null before invoking this method.
*
* @returns {number} last_layer_id - the maximum layer_id value found in lib_data
*/
component_image.prototype.get_last_layer_id = function() {

	const self = this

	const lib_data		= self.get_lib_data()

	const ar_layer_id	= lib_data.map((item) => item.layer_id)

	const last_layer_id	= Math.max(...ar_layer_id)


	return last_layer_id
}//end get_last_layer_id



/**
* LOAD_VECTOR_EDITOR
* Lazily loads and initialises the vector_editor module and populates ar_layers
* from the saved lib_data (or seeds a default raster layer if no data exists yet).
*
* The vector_editor module import is deferred to this method so that the heavy
* SvgCanvas dependency is only fetched when the user explicitly opens the editor.
* A CSS 'loading' class is applied to self.node while the dynamic import resolves.
*
* After this call:
*   - self.vector_editor is a fully initialised vector_editor instance.
*   - self.ar_layers holds either the persisted LayerDescriptor list or a
*     single default raster layer with layer_id 0.
*
* @returns {Promise<boolean>} resolves true when the editor is ready
*/
component_image.prototype.load_vector_editor = async function() {

	const self = this

	const data					= self.data || {}
	const entries				= data.entries || []
	const default_layer_color	= '#ffffff';

	// options
		// const load		= options.load || 'full'
		// const layer_id	= options.layer_id || null

	// vector_editor. load and init if not already loaded
		if (!self.vector_editor){

			// load editor files and create a new vector_editor
			// load files only when editor is really necessary
			const load_editor_files = () => {
				return new Promise(function(resolve){

					if(self.node) {
						self.node.classList.add('loading')
					}

					import('../../component_image/js/vector_editor.js')
					.then(async function(module){

						const vector_editor = module.vector_editor

						if(self.node) {
							self.node.classList.remove('loading')
						}

						resolve(vector_editor)
					})
				})
			}
			const vector_editor = await load_editor_files()

			self.vector_editor = new vector_editor()
			await self.vector_editor.init_canvas(self)
		}

	// load all layers if the data is empty it create the first layer
		if(self.ar_layers.length < 1){
			// add the data from instance to the ar_layers, it control the all project layers that will showed in the vector editor
			self.ar_layers = typeof entries[0]!=='undefined' && entries[0].lib_data
				? entries[0].lib_data
				: [{
					layer_id		: 0,
					layer_data		: [],
					layer_color		: default_layer_color,
					layer_opacity	: 0.3,
					user_layer_name	: 'raster',
					name 			: 'layer_0',
					visible 		: true
				}]
		}

	return true
}//end load_vector_editor



/**
* LOAD_TAG_INTO_VECTOR_EDITOR
* Activates one or more SVG layers in the vector editor to display the annotation
* referenced by the given tag. Typically fired in response to a 'click_tag_draw' event.
*
* tag.data is expected to be a JSON-serialised array of layer_id values
* (e.g. '[2, 5]'). Each id is parsed and forwarded to vector_editor.activate_layer().
* If tag.data is empty or missing, the method returns false without side effects.
*
* The vector editor is loaded on demand if it has not been initialised yet.
*
* @param {Object} options - handler options
* @param {Object} options.tag - tag descriptor; must carry a .data string
* @returns {Promise<boolean>} false when tag has no drawable data, true on success
*/
component_image.prototype.load_tag_into_vector_editor = async function(options) {

	const self = this

	// options
		const tag = options.tag
		if( !tag.data || tag.data.length === 0){
			return false
		}

	if(!self.vector_editor){
		await self.load_vector_editor()
	}
	// convert the tag to 'real' object for manage it
	try {

		const ar_layer_id			= JSON.parse(tag.data)
		const ar_layer_id_length	= ar_layer_id.length
		for (let i = 0; i < ar_layer_id_length; i++) {

			const layer_id	= parseInt(ar_layer_id[i])
			self.vector_editor.activate_layer(layer_id, self)
		}
	} catch (error) {
		console.error(error)
		console.log("tag.data:", tag.data);
	}

	return true
}//end load_tag_into_vector_editor



/**
* GET_DEFAULT_FILE_INFO
* Returns the FileInfo descriptor for the quality configured as the default in
* self.context.features.default_quality. Used by render views to select the
* initial image variant to display without an explicit quality override.
*
* Returns null when no default quality is configured or when the requested
* entry index does not exist in self.data.entries.
*
* FileInfo shape (typical): { quality, extension, url, file_exist, width, height }
*
* @param {number} key - zero-based index into self.data.entries (default 0)
* @returns {Object|null} default_file_info - matching FileInfo object, or null
*/
component_image.prototype.get_default_file_info = function(key=0) {

	const self = this

	const default_quality = self.context.features.default_quality

	const entries = self.data.entries || [];

	const default_file_info = (default_quality && entries[key])
		? entries[key].files_info.find(el => el.quality === default_quality)
		: null

	return default_file_info
}//end get_default_file_info



/**
* GET_QUALITY_FILE_INFO
* Returns the FileInfo descriptor that matches both the requested quality level
* and file extension for the given entry index.
*
* This is the primary accessor used when a specific quality/format combination
* must be resolved (e.g. when the user switches quality via the quality selector
* or when a specific export format is needed).
*
* Returns null when the entry does not exist or no matching FileInfo is found.
*
* @param {string} quality - quality level identifier (e.g. 'original', 'thumb', 'medium')
* @param {string} extension - file extension without leading dot (e.g. 'jpg', 'tif', 'webp')
* @param {number} key - zero-based index into self.data.entries (default 0)
* @returns {Object|null} quality_file_info - matching FileInfo object, or null
*/
component_image.prototype.get_quality_file_info = function( quality='original', extension='jpg', key=0) {

	const self = this

	const entries = self.data.entries || [];

	const quality_file_info = (quality && entries[key])
		? entries[key].files_info.find(el => el.quality === quality && el.extension === extension)
		: null

	return quality_file_info
}//end get_quality_file_info



/**
* GET_ORIGINAL_FILE_NAME
* Returns the raw original filename as provided by the user at upload time,
* before any normalisation or filesystem sanitisation. Useful for display
* purposes where the user-facing name should be preserved.
*
* Returns null when the entry does not exist or has no original_file_name.
*
* @param {number} key - zero-based index into self.data.entries (default 0)
* @returns {string|null} original_file_name - the original upload filename, or null
*/
component_image.prototype.get_original_file_name = function( key=0 ) {

	const self = this

	const entries = self.data.entries || [];

	const original_file_name = (entries[key].original_file_name)
		? entries[key].original_file_name
		: null

	return original_file_name
}//end get_original_file_name



/**
* GET_ORIGINAL_NORMALIZED_FILE_NAME
* Returns the filesystem-safe normalised version of the original filename.
* Unlike get_original_file_name, this name has been sanitised for safe storage
* (e.g. diacritics removed, spaces replaced). Used when constructing download
* links or referencing the stored file on disk.
*
* Returns null when the entry does not exist or has no original_normalized_name.
*
* @param {number} key - zero-based index into self.data.entries (default 0)
* @returns {string|null} original_normalized_file_name - normalised filename, or null
*/
component_image.prototype.get_original_normalized_file_name = function( key=0 ) {

	const self = this

	const entries = self.data.entries || [];

	const original_normalized_file_name = (entries[key].original_normalized_name)
		? entries[key].original_normalized_name
		: null

	return original_normalized_file_name
}//end get_original_normalized_file_name



/**
* GET_ACTIVE_EXTENSIONS
* Combines the primary extension from context.features with any alternative
* extensions configured for this component and returns a flat ordered array.
* The primary extension is always first.
*
* Used by the quality selector and file-info lookup to iterate over all
* supported file variants (e.g. ['jpg', 'tif', 'webp']).
*
* @returns {Array} active_extensions - array of extension strings (e.g. ['jpg', 'webp'])
*/
component_image.prototype.get_active_extensions = function() {

	const self = this

	const extension					= self.context.features.extension
	const alternative_extensions	= self.context.features.alternative_extensions || []

	const active_extensions = [extension, ...alternative_extensions]

	return active_extensions
}//end get_active_extensions



/**
* IMAGE_QUALITY_CHANGE_HANDLER
* Unified handler for image quality changes across all views.
* Handles both SVG object node updates and vector editor integration.
* Subscribed to 'image_quality_change_'+self.id event in init.
*
* Two code paths based on component state:
*   1. Vector editor active (self.vector_editor is set): updates the image via
*      the vector editor's stage.setHref() so the drawing canvas stays in sync.
*   2. SVG <object> node (default edit view): directly updates the href/xlink:href
*      attribute on the <image> element inside the SVG document embedded in the
*      object_node, with the URL as given (already versioned by its file).
*      A 'loading' CSS class is toggled on the parent content_value element
*      while the new image loads.
*
* (!) The querySelector('image') call is awaited even though querySelector is
*     synchronous. The await has no semantic effect and is a pre-existing pattern.
*
* @param {string} url - the new image URL to load
* @returns {Promise<void>}
*/
component_image.prototype.image_quality_change_handler = async function(url) {

	const self = this

	// A falsy URL must never reach the SVG: setHref(x, null) writes href="null"
	// and the raster disappears until the component is reloaded.
	if (!url) {
		return
	}

	// store the current image source
		self.img_src = url

	// case 1: vector_editor is active
	// when the vector editor is loaded, it manages the image through its stage
		if (self.vector_editor) {
			const image_definition = self.vector_editor.image_definition
			const stage				= self.vector_editor.stage
			if (image_definition && stage) {
				image_definition.src = url
				stage.setHref(image_definition.image_node, url)
			}
			return
		}

	// case 2: SVG object node (default edit view without vector editor)
		const object_node = self.image_container?.object_node
		if (!object_node) {
			return
		}

	// svg document inside the object_node tag
		const svg_doc = object_node.contentDocument
	// Get the image item by tag name
		const image_node = svg_doc
			? await svg_doc.querySelector('image')
			: null

		if (image_node) {

			// content_value is the parent of image_container
				const content_value = self.image_container.parentElement

			// add spinner when new image is loading
				content_value.classList.add('loading')
				image_node.addEventListener('load', function(){
					content_value.classList.remove('loading')
				})

			// no load case (example: original tiff files)
				image_node.addEventListener('error', function(){
					content_value.classList.remove('loading')
				})

			// the URL arrives versioned by its file (media_url.js get_media_url): use as given
				const new_url = url

			// set the new source to the image node into the svg.
			// Write BOTH: the vector editor's export uses SVG2 `href`, which wins
			// over xlink:href wherever both exist (xlink alone then does nothing).
			// xlink is kept for the default envelope and older browsers.
				image_node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', new_url)
				image_node.setAttribute('href', new_url)
		}
}//end image_quality_change_handler



// @license-end
