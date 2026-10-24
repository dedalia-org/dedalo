// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// import needed modules
	import { clone, dd_console } from '../../../core/common/js/utils/index.js'
	import { data_manager } from '../../../core/common/js/data_manager.js'
	import { request_failed, response_data } from '../../../core/common/js/api_error.js'
	import { common, create_source } from '../../../core/common/js/common.js'
	import { tool_common } from '../../../core/tools_common/js/tool_common.js'
	import { render_tool_image_rotation } from './render_tool_image_rotation.js' // self tool rendered (called from render common)
	import { upload } from '../../../core/services/service_upload/js/service_upload.js'
	import { process_uploaded_file } from '../../tool_upload/js/tool_upload.js'



/**
* TOOL_IMAGE_ROTATION (module)
* Image manipulation tool for Dédalo v7.
*
* Provides two image processing capabilities on a `component_image` record:
*
*   1. Rotation + crop — the user drags a range slider to pick degrees (-360…360,
*      step 0.01) and optionally draws a crop rectangle; clicking "Apply" calls
*      `apply_rotation()` which dispatches to the PHP back-end
*      (`tool_image_rotation::apply_rotation`) where every derived quality is
*      re-rendered server-side via ImageMagick.  The 'original' quality is always
*      preserved untouched.
*
*   2. Background removal — runs the `onnx-community/ISNet-ONNX` neural network entirely
*      in the browser via a Web Worker (WebGPU or WASM fallback).  The resulting
*      PNG blob is uploaded with `service_upload`, then converted from a temp file
*      into a full derived-quality set by `tool_upload::process_uploaded_file`.
*      Requires a WebGPU-capable browser for practical speed; users on incompatible
*      browsers are warned via `confirm()` before the worker is started.
*
* Architecture:
*   - `tool_image_rotation`      — main tool constructor; extends `tool_common`
*       lifecycle (init → build → render → destroy).
*   - `render_tool_image_rotation` — owns the DOM structure and control widgets
*       (imported from `render_tool_image_rotation.js`).
*   - `render_tool_image_crop`   — the drag-to-select crop overlay (imported by the
*       render module).
*   - PHP server-side: `class.tool_image_rotation.php`; the only exposed API action
*       is `apply_rotation` (per `API_ACTIONS` allowlist, SEC-024 §9.2).
*
* Prototype methods assigned below (see COMMON FUNCTIONS block):
*   - `render`  — delegated to `tool_common.prototype.render`
*   - `destroy` — delegated to `common.prototype.destroy`
*   - `refresh` — delegated to `common.prototype.refresh`
*   - `edit`    — delegated to `render_tool_image_rotation.prototype.edit`
*   - `init`    — overridden below (calls `tool_common.prototype.init`)
*   - `build`   — overridden below; resolves `main_element` from `ddo_map`
*   - `apply_rotation`              — sends rotation/crop params to the PHP API
*   - `automatic_background_removal`— runs the in-browser WASM/WebGPU pipeline
*
* Exports:
*   tool_image_rotation — the tool constructor.
*/



/**
* TOOL_IMAGE_ROTATION
* Constructor for the image rotation/crop/background-removal tool.
*
* All instance properties are initialised to null here; they are populated by
* `tool_common.prototype.init` during the `init()` call and extended in `build()`.
* The `//end page` label below is a legacy generator artefact and has no runtime
* meaning.
*
* @returns {boolean} Always true (Dédalo constructor sentinel).
*/
export const tool_image_rotation = function () {

	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null
	this.events_tokens	= null
	this.status			= null
	this.main_element	= null
	this.type			= null
	this.source_lang	= null
	this.target_lang	= null
	this.langs			= null
	this.caller			= null


	return true
}//end page



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// render : using common render entry point
	tool_image_rotation.prototype.render	= tool_common.prototype.render
	tool_image_rotation.prototype.destroy	= common.prototype.destroy
	tool_image_rotation.prototype.refresh	= common.prototype.refresh
	tool_image_rotation.prototype.edit		= render_tool_image_rotation.prototype.edit



/**
* INIT
* Custom tool initialisation — delegates to `tool_common.prototype.init` and then
* applies any tool-specific post-init steps (currently none beyond the common base).
*
* Called by the tool framework as the first lifecycle step; must be `await`-ed
* before `build()` is invoked.
*
* @param {Object} options - Options forwarded verbatim to `tool_common.prototype.init`.
*   Typically contains `{ caller, tool_config, lang, mode }`.
* @returns {Promise<boolean>} Resolves with the result of `tool_common.prototype.init`.
*/
tool_image_rotation.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// set the self specific vars not defined by the generic init (in tool_common)


	return common_init
}//end init



/**
* BUILD
* Custom tool build — calls `tool_common.prototype.build` (which loads CSS and
* instantiates every entry in `tool_config.ddo_map`), then locates the
* `main_element` instance in `ar_instances` for convenient access throughout the
* tool.
*
* `main_element` is identified by matching the ddo_map entry whose `role` is
* `'main_element'` to the built instance with the same `tipo`.  This is the
* `component_image` whose files will be rotated / processed.
*
* @param {boolean} [autoload=false] - When true, child components fetch their own
*   data automatically during build (forwarded to `tool_common.prototype.build`).
* @returns {Promise<boolean>} Resolves with the result of `tool_common.prototype.build`.
*/
tool_image_rotation.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// specific actions.. like fix main_element for convenience
		// main_element
			const main_element_ddo	= self.tool_config.ddo_map.find(el => el.role==='main_element')
			self.main_element		= self.ar_instances.find(el => el.tipo===main_element_ddo.tipo)

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom




/**
* APPLY_ROTATION
* Sends rotation and optional crop parameters to the PHP back-end and waits for
* the server to re-render every derived image quality.
*
* Flow:
*   1. Asks the user to confirm (native browser `confirm()`).
*   2. Builds an RQO (request query object) whose `source` encodes `self` and the
*      method name `'apply_rotation'` — the framework routes this to
*      `tool_image_rotation::apply_rotation()` on the PHP side.
*   3. Dispatches via `data_manager.request` (dd_tools_api → tool_request action).
*   4. Resolves the Promise with the server `response.result` (boolean true/false).
*
* The server applies rotation to every file quality except `'original'` (which is
* permanently preserved).  If `crop_area` is also set the crop is applied after
* rotation, with pixel coordinates scaled proportionally to each quality's
* dimensions.
*
* Note: `SHOW_DEVELOPER` is referenced inside the `.then` callback but is not listed
* in the `/*global*\/` header at the top of the file. (!) This will trigger an
* eslint no-undef warning at runtime in strict environments.
*
* @param {Object} options - Rotation parameters collected from the UI widgets.
* @param {number|string} options.rotation_degrees - Degrees to rotate; passed as a
*   float string from the range input (e.g. `'64.8'`). A value of `"0"` skips the
*   rotation phase server-side.
* @param {string} options.background_color - Hex colour string for the background
*   fill behind the rotated image (e.g. `'#ffffff'`). Ignored when `alpha` is true.
* @param {boolean} options.alpha - When true, the server renders the background as
*   transparent (requires a format that supports alpha, e.g. PNG or AVIF).
* @param {string} options.rotation_mode - `'expanded'` grows the canvas to fit the
*   full rotated image; `'default'` keeps the original canvas dimensions and clips
*   corners.
* @param {Object|null} options.crop_area - Pixel crop rectangle in the NATURAL
*   pixel space of the previewed default-quality file (render_tool_image_crop
*   already converts display px → natural px), or null to skip cropping. The
*   server normalizes it against the default-quality dimensions and re-scales it
*   per quality tier.
* @param {number} options.crop_area.x      - Left edge offset in reference pixels.
* @param {number} options.crop_area.y      - Top edge offset in reference pixels.
* @param {number} options.crop_area.width  - Crop width in reference pixels.
* @param {number} options.crop_area.height - Crop height in reference pixels.
* @returns {Promise<Object>} Resolves with the full API response
*   (`{result, msg, errors, …}`) so the caller can surface server-side failures;
*   returns plain `false` (non-Promise) if the user cancels the confirm dialog.
*/
tool_image_rotation.prototype.apply_rotation = function(options) {

	const self = this

	// confirm dialog
		if ( !confirm( (get_label.sure || 'Sure?') ) ) {
			return false
		}

	const rotation_degrees	= options.rotation_degrees
	const background_color	= options.background_color
	const alpha				= options.alpha
	const rotation_mode		= options.rotation_mode
	const crop_area			= options.crop_area

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'apply_rotation')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				tipo				: self.main_element.tipo,
				section_tipo		: self.main_element.section_tipo,
				section_id			: self.main_element.section_id,
				rotation_degrees	: rotation_degrees,
				background_color	: background_color,
				rotation_mode 		: rotation_mode,
				alpha				: alpha,
				crop_area			: crop_area,
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> apply_rotation API response:",'DEBUG',response);
				}

				// Resolve the whole response: `result` alone gave the caller no way
				// to tell the user WHY a rotation/crop failed (silent no-op).
				resolve(response)
			})
		})
}//end apply_rotation



/**
* AUTOMATIC_BACKGROUND_REMOVAL
* Runs the `onnx-community/ISNet-ONNX` subject-extraction model entirely in the browser
* via a dedicated Web Worker, then uploads the resulting PNG to the server and
* triggers full quality-set generation through `tool_upload::process_uploaded_file`.
*
* Pipeline steps:
*   1. Spawns `remove_background.js` as a module Worker
*      (`core/tools_common/js/processors/remove_background/remove_background.js`).
*   2. Posts the target image URL + model name + device preference to the worker.
*   3. Receives progress messages (`init`, `on_chunk_start`, `callback_function`,
*      `end`) and updates `nodes.status_container` to inform the user.
*   4. On `end`: converts the `Uint8ClampedArray` pixel payload to `ImageData`,
*      draws it to an `OffscreenCanvas`, and calls `canvas.convertToBlob` to get a
*      PNG `Blob`.
*   5. Calls the inner `upload_image()` closure which:
*        a. Renames the blob to match the component's original file name (extension
*           forced to `.png`).
*        b. Uploads via `service_upload` to the server temp directory.
*        c. Calls `process_uploaded_file` (tool_upload) to move and convert the
*           temp file into all configured quality formats under the component's
*           `'modified'` quality slot.
*
* Worker device selection: the code always requests `'webgpu'` (the `'wasm'`
* alternative is commented out).  If the browser does not support WebGPU, the
* worker falls back internally.  The caller checks `ua.check_transformers_webgpu()`
* before spawning and shows a `confirm()` warning if WebGPU is absent.
*
* Note: `options.transcriber_engine` and `options.transcriber_quality` are
* destructured from `options` but are never used within this method — they appear
* to be copy-paste leftovers from a transcription pipeline. (!) Do not remove them
* (doc-only rule); they are harmless dead assignments.
*
* Note: `button_remove_background.active === false` guard in the render module
* references a property that is never set to `true` before the call, so the branch
* will always short-circuit. (!) This is a pre-existing logic issue; do not fix here.
*
* @param {Object} options - Configuration for the removal pipeline.
* @param {Object} options.self_caller - The live `component_image` instance whose
*   file system paths and section context are used for the upload.
* @param {string} options.engine - Hugging Face model identifier, e.g.
*   `'onnx-community/ISNet-ONNX'`.
* @param {string} options.image - Absolute URL of the source image (typically the
*   `'original'` quality file) passed to the worker for inference.
* @param {string} options.original_file_name - File name (with extension) of the
*   source image; used to name the output PNG (`extension replaced with .png`).
* @param {Object} options.nodes - DOM node references used to update progress UI.
* @param {HTMLElement} options.nodes.status_container - Element whose `innerHTML`
*   is updated with progress labels during the worker pipeline.
* @param {string}  [options.transcriber_engine]  - Unused; kept for legacy compat.
* @param {string}  [options.transcriber_quality] - Unused; kept for legacy compat.
* @returns {Promise<boolean>} Resolves with `true` when the image has been uploaded
*   and processed successfully; the worker is terminated before resolution.
*/
tool_image_rotation.prototype.automatic_background_removal = async function(options) {

	const self = this

	// options
		const transcriber_engine	= options.transcriber_engine
		const transcriber_quality	= options.transcriber_quality
		const nodes					= options.nodes
		const image					= options.image
		const self_caller 			= options.self_caller
		const original_file_name 	= options.original_file_name
		const engine 				= options.engine

	// transcribe worker
		// Worker URLs resolve against the PAGE (/dedalo/core/page/), not this module –
		// same convention as tool_transcription/tool_lang. `../../../` resolved to
		// /core/… (404) and the worker never loaded.
		const background_removal_worker = new Worker( '../../core/tools_common/js/processors/remove_background/remove_background.js', {
			type : 'module'
		})

	return new Promise( async function(resolve){

		// call to the API, fetch data and get response
			nodes.status_container.classList.remove('hide')
			nodes.status_container.classList.add('loading_status')
			nodes.status_container.innerHTML = self.get_tool_label('processing_image') || 'Processing image...'

		// Manage the worker answers
		// it could be the status of the process or the final transcription data
		background_removal_worker.onmessage = async function(e) {
			const status	= e.data.status
			const data		= e.data.data

			switch (status) {
				case 'init':

					const progress	= data.progress;
					const status	= data.status;
					const device	= data.device;

					const procesing_label = device==='webgpu' ? 'setting_up' : 'procesing';

					// set the label for all status as initializing and the ready to Setting_up
					// both labels are translated into the tool config.
					const label = status==='ready'
						? self.get_tool_label( procesing_label )
						: self.get_tool_label( 'initializing' )

					const loaded = (progress)
						? ` : ${parseInt(progress).toString().padStart(2, 0)}%`
						: (status==='ready')
							? ''
							: ' : 00%'
					const procesing = `${label}${loaded}`;
					nodes.status_container.textContent = procesing;

					break;
				// on new chunk start empty the status_container, new phrase will be processed
				case 'on_chunk_start':
					nodes.status_container.innerHTML = '';
					nodes.status_container.classList.remove('loading_status')

					break;
				//every time that a word is processed and ready it is set at end of the phrase
				case 'callback_function':
					nodes.status_container.classList.remove('loading_status')
					nodes.status_container.innerHTML = data;

					break;
				// the worker's own failure (model bytes missing, no inference backend…)
				case 'error':
					fail( e.data.error || 'Background removal failed (see console)' )

					break;
				// final data as returned as array of objects with a dd_format parameter.
				case 'end':

					background_removal_worker.terminate()
					// transformers.js v4 returns ONE RawImage, alpha already applied
					// (older versions returned an array of per-label masks).
					const output = Array.isArray(data) ? data[0] : data;

					// Convert Uint8ClampedArray to ImageData
					const image_data = new ImageData(
						output.data,  // Uint8ClampedArray
						output.width,
						output.height
					);

					// Create PNG Blob from ImageData
					const canvas = new OffscreenCanvas(output.width, output.height);
					let ctx = canvas.getContext('2d');
					ctx.putImageData( image_data, 0, 0);
					// Create a final blob image
					const blob = await canvas.convertToBlob({ type: 'image/png' });

					// upload the final data to server
					const upload_response = await upload_image({
						image_blob : blob
					})

					resolve( upload_response )
					break;
			}
		}
		// ONE failure exit. The worker reports its own failures as a MESSAGE
		// ({status:'error'}), never as an onerror Event, and a script that fails to
		// load gives a bare Event with no message — so the reason is echoed rather
		// than invented. `resolve(false)` is the caller's "nothing was written".
		const fail = function(message) {
			background_removal_worker.terminate()
			nodes.status_container.classList.remove('loading_status')
			nodes.status_container.textContent = message
			resolve(false)
		}
		background_removal_worker.onerror = function(e) {
			console.error('Worker error [remove_background]:', e)
			fail( e.message ? `Worker error: ${e.message}` : 'Worker error: the worker script could not be loaded (see console)' )
		}

		const removal_options = {
			image_file	: image,
			model		: engine,
			device		: 'webgpu' //nodes.transcriber_device_checkbox.checked ? 'wasm' : 'webgpu'
		}

		// init the worker for transcription
		background_removal_worker.postMessage({
			options	: removal_options
		})

		// Upload image
		const upload_image = async( options )=>{

			// set the extension to the main image name
			const image_blob	= options.image_blob
			image_blob.name		= original_file_name.replace(/\.[^/.]+$/, '.png');

			// upload file (using service_upload)
			// upload file as another images to tmp directory
			const api_response = await upload({
				id					: self_caller.id,
				file				: image_blob, // binary data as file
				resource_type		: 'image', // target dir
				allowed_extensions	: ['png'],
				key_dir				: 'image',
				max_size_bytes		: image_blob.size
			})

			// envelope v2: a successful upload answers `data===true` with the staged
			// `file_data` extension key; every failure path (validation, transport,
			// server refusal) answers with an ApiError under `error`.
			if (request_failed(api_response) || response_data(api_response)!==true) {
				console.error("Error on upload api_response:", api_response);
				return false
			}
			// file_data set
			const file_data = api_response.file_data

			// process_uploaded_file
			// When the image is upload it will save as temporal image and needs to be moved and processed
			// for every quality and formats define in config
			const api_response_upload_done = await process_uploaded_file({
				file_data		: file_data,
				process_options	: null,
				caller			: {
					type	: "tool",
					model	: "tool_upload"
				},
				tipo			: self_caller.tipo,
				section_tipo	: self_caller.section_tipo,
				section_id		: self_caller.section_id,
				caller_type		: self_caller.context.type, // like 'tool' or 'component'. Switch different process actions on tool_upload class
				quality			: 'modified',
				target_dir		: null
			})

			// debug
			if(SHOW_DEBUG===true) {
				console.log('image file_data (on upload finish):', file_data);
			}

			// THE RESPONSE IS THE ONLY FRESH files_info THERE IS, so it is returned
			// instead of a bare `true`. process_uploaded_file rebuilt every derivative
			// of the 'modified' master — including the alternate-extension TWINS the
			// engine writes since 2026-08-07 — and answers with the disk scan taken
			// after that pass. The caller needs it: `component_common.build(true)` is a
			// no-op on an already-built instance (it returns immediately when
			// status==='built'), so nothing else in this flow ever refreshes
			// `data.entries[key].files_info`, and the removal's transparent version
			// stayed invisible until a full page reload.
			return api_response_upload_done
		}
	})

}//end automatic_background_removal




// @license-end
