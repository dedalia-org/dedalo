// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* COMPONENT_AV
* Audio/video component for Dédalo: manages media playback, timecode handling,
* fragment extraction, and posterframe management.
*
* Responsibilities:
* - Wrapping the native HTMLMediaElement (self.video) with timecode utilities
*   (tc_to_seconds, time_to_tc, go_to_time, play_pause, rewind, set_playback_rate).
* - Building tag objects that pair a timecode label with structured tag data so that
*   linked component_text_area instances can insert TC markers into rich-text content.
* - Communicating with the server-side dd_component_av_api for operations that require
*   backend processing: fragment download, media-stream inspection, and posterframe
*   creation/deletion.
* - Exposing two static helpers — open_av_player and download_av_fragment — consumed
*   directly by dd_grid_indexation without a component instance.
*
* Event integration:
*   The component subscribes to ontology-configured events (key_up_f2, key_up_esc,
*   click_tag_tc) whose target DOM elements are declared in the component's ontology
*   properties. See the note near the import block below.
*
* Prototype chain:
*   Lifecycle and data-persistence methods are delegated to component_common / common.
*   Rendering is dispatched to render_edit_component_av, render_list_component_av,
*   and render_search_component_av (see the COMMON FUNCTIONS block).
*
* @module component_av
* @exports {Function} component_av - constructor
* @exports {Function} open_av_player - static: open a standalone AV viewer window
* @exports {Function} download_av_fragment - static: request and download a time-range clip
*/



// imports
	import {dd_console} from '../../common/js/utils/index.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {object_to_url_vars, open_window, download_file} from '../../common/js/utils/index.js'
	import {common, create_source} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_av} from '../../component_av/js/render_edit_component_av.js'
	import {render_list_component_av} from '../../component_av/js/render_list_component_av.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'
	import {error_text} from '../../common/js/render_api_error.js'



	// Note about event_manager
	// the component_av is configured by properties in the ontology,
	// it has subscribed to some events that comes defined in properties as: key_up_f2, key_up_esc, click_tag_tc
	// the events need to be linked to specific text_area and it's defined in ontology.
	// Event bindings are therefore established by the render layer, not here.



/**
* COMPONENT_AV
* Constructor for the audio/video component instance.
* Properties are declared here so that tooling can discover them; they are
* populated by component_common.prototype.init once the server context/data
* is fetched. self.video is assigned by the render layer after the
* HTMLMediaElement is inserted into the DOM.
*/
export const component_av = function(){

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
	this.video    // HTMLMediaElement (<video> or <audio>) set by the render layer
	this.quality  // active quality label, e.g. 'low' | 'medium' | 'high'

	this.fragment = null  // optional in-progress fragment definition; null = no active fragment
}//end  component_av



/**
* COMMON FUNCTIONS
* Extend component_av with shared prototype methods from component_common and common.
* AV-specific methods (timecode, media streams, posterframe) are defined further below
* in this file; generic component behavior is injected here.
*/
// prototypes assign
	// lifecycle
	component_av.prototype.init					= component_common.prototype.init
	component_av.prototype.build				= component_common.prototype.build
	component_av.prototype.render				= common.prototype.render
	component_av.prototype.refresh				= common.prototype.refresh
	// destroy: release the <video> element before delegating to the generic
	// destructor. A retained, loaded/playing media element keeps its decoded
	// buffers and network connection alive (media memory leak) and keeps firing
	// timeupdate into a destroyed instance.
	// (!) forward the args so refresh()/dependency teardown behave correctly
	// (see component_image.destroy for the same fix).
	component_av.prototype.destroy				= function(delete_self, delete_dependencies, remove_dom) {
		const self = this
		if (self.video) {
			try {
				self.video.pause()
				self.video.removeAttribute('src')
				self.video.load()
			} catch (e) {
				console.warn('component_av destroy: error releasing video', e)
			}
			self.video = null
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}

	// change data
	component_av.prototype.save					= component_common.prototype.save
	component_av.prototype.update_data_value	= component_common.prototype.update_data_value
	component_av.prototype.update_datum			= component_common.prototype.update_datum
	component_av.prototype.change_value			= component_common.prototype.change_value
	component_av.prototype.set_changed_data		= component_common.prototype.set_changed_data
	component_av.prototype.build_rqo			= common.prototype.build_rqo

	// render — delegates to mode-specific render modules
	component_av.prototype.list					= render_list_component_av.prototype.list
	component_av.prototype.edit					= render_edit_component_av.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_av.prototype.search				= async function(options) {
		const {render_search_component_av} = await import('../../component_av/js/render_search_component_av.js')
		return render_search_component_av.prototype.search.call(this, options)
	}

	component_av.prototype.change_mode			= component_common.prototype.change_mode



/**
* GO_TO_TIME
* Seek the media element to a specific time, accepting either a raw second
* value or a timecode string carried by a tag object.
*
* Two call patterns are supported:
*  1. Tag-based (fired by the 'click_tag_tc' event from component_text_area):
*       options = {
*         caller       : <component_text_area instance>,
*         tag          : { node_name: 'img', type: 'tc',
*                          tag_id: '[TC_00:00:08.000_TC]', state: 'n',
*                          label: '00:00:08.000', data: '00:00:08.000' },
*         text_editor  : <service_ckeditor instance>
*       }
*     options.tag.data holds the TC string; it is converted via tc_to_seconds().
*
*  2. Direct seconds (called programmatically by the component itself):
*       options = { seconds: 16 }
*
* Falls back to 0 if neither seconds nor tag.data is provided.
* Returns false immediately when self.video has not been assigned by the render layer.
*
* @param {Object} options - call options (see patterns above)
* @param {number} [options.seconds] - target position in seconds (pattern 2)
* @param {Object} [options.tag] - tag object whose .data is a TC string (pattern 1)
* @returns {number|boolean} target position in seconds, or false when no video element is set
*/
component_av.prototype.go_to_time = function(options) {

	const self = this

	if (!self.video) {
		dd_console("Ignored go_to_time call. No self.video is set", 'warning', [self.tipo, self.id]);
		return false
	}

	// Resolve target seconds: prefer options.seconds; fall back to TC string on the tag;
	// default to 0 when neither is provided.
	const seconds = options.seconds
		? options.seconds
		: (options.tag && options.tag.data)
			? self.tc_to_seconds(options.tag.data)
			: 0

	self.video.currentTime = seconds;

	return seconds
}//end  go_to_time



/**
* PLAY_PAUSE
* Toggle playback state of the media element. When pausing, an optional
* rewind_seconds offset is applied immediately after the pause so the
* operator can re-hear a short lead-in before the pause point.
* Returns false immediately when self.video is not yet set.
*
* @param {number} [rewind_seconds=0] - seconds to rewind after pausing; 0 disables rewind
* @returns {boolean} self.video.paused state after the toggle, or false when no video element is set
*/
component_av.prototype.play_pause = function(rewind_seconds=0) {

	const self = this

	if (!self.video) {
		dd_console("Ignored play_pause call. No self.video is set", 'warning', [self.tipo, self.id]);
		return false
	}

	if (self.video.paused) {
		self.video.play();
	} else {
		self.video.pause();
		if(rewind_seconds > 0){
			self.rewind(rewind_seconds)
		}
	}

	return self.video.paused
}//end play_pause



/**
* REWIND
* Step the media element backward by the given number of seconds from its
* current position. Typically called by play_pause when rewind_seconds > 0.
* (!) Does not guard against self.video being null; callers must ensure the
*     video element exists before calling this method.
*
* @param {number} seconds - number of seconds to rewind (must be > 0)
* @returns {number} resulting self.video.currentTime after the seek
*/
component_av.prototype.rewind = function(seconds) {

	const self = this
	self.video.currentTime = parseFloat(self.video.currentTime - seconds);

	return self.video.currentTime
}//end rewind



/**
* GET_DATA_TAG
* Build a tag descriptor object from the media element's current position.
* The returned object is the canonical structure consumed by component_text_area
* when inserting a TC marker into rich-text content.
*
* Shape of the returned object:
*   {
*     type   : 'tc',             // tag category
*     tag_id : '00:00:08.000',  // timecode string used as the tag's unique key
*     state  : 'n',             // 'n' = new / not yet saved
*     label  : '00:00:08.000',  // human-readable display label
*     data   : '00:00:08.000'   // raw TC data; parsed by tc_to_seconds when the tag is clicked
*   }
*
* @returns {Object} data_tag - tag descriptor at the current playback position
*/
component_av.prototype.get_data_tag = function() {

	const self 	= this

	const tc 	= self.get_current_tc()
	const data_tag = {
		type	: 'tc',
		tag_id	: tc,
		state	: 'n',
		label	: tc,
		data	: tc
	}

	return data_tag
}//end get_data_tag



/**
* GET_CURRENT_TC
* Read the media element's current playback position and format it as a
* timecode string (HH:MM:SS.mmm) via time_to_tc.
*
* @returns {string} timecode string in 'HH:MM:SS.mmm' format
*/
component_av.prototype.get_current_tc = function() {

	const self = this

	// guard: the throttled 'timeupdate' listener can fire after destroy() has
	// released self.video (video.load() emits events asynchronously)
	if (!self.video) {
		return ''
	}

	const tc = self.time_to_tc(self.video.currentTime)

	return tc
}//end get_current_tc



/**
* TC_TO_SECONDS
* Convert a timecode string in 'HH:MM:SS.mmm' format to a total number of
* floating-point seconds. For example, '00:12:19.878' → 739.878.
*
* When the argument is already an integer (e.g. the caller pre-converted it),
* it is returned as-is. This short-circuit avoids double-conversion when callers
* pass a numeric value rather than a string.
*
* Parsing strategy:
*   - Split on ':' to extract hours, minutes, and the SS.mmm portion.
*   - Split the original string on '.' to extract the millisecond fragment
*     independently (the seconds portion from the ':' split still carries '.mmm',
*     but parseFloat on ar[2] discards the fraction — the milliseconds are
*     reconstructed by reassembling as `total_seconds + '.' + mseconds`).
*
* @param {string|number} tc - timecode string 'HH:MM:SS.mmm' or a pre-computed integer
* @returns {number} total_seconds - position in seconds as a float (e.g. 739.878)
*/
component_av.prototype.tc_to_seconds = function(tc) {

	if(Number.isInteger(tc)) {
		return tc
	}

	//var tc		= "00:09:52.432";
	const ar		= tc.split(":")
	const ar_ms		= tc.split(".")

	const hours		= parseFloat(ar[0])>0 ? parseFloat(ar[0]) : 0
	const minutes	= parseFloat(ar[1])>0 ? parseFloat(ar[1]) : 0
	const seconds	= parseFloat(ar[2])>0 ? parseFloat(ar[2]) : 0
	const mseconds	= parseFloat(ar_ms[1])>0 ? parseFloat(ar_ms[1]) : 0

	// Reconstruct as a string concatenation so the millisecond fragment is
	// preserved exactly without floating-point rounding from arithmetic.
	const total_seconds = parseFloat( (hours * 3600) + (minutes * 60) + seconds +'.'+ mseconds)


	return total_seconds
}//end  tc_to_seconds



/**
* TIME_TO_TC
* Convert a floating-point media position (in seconds) to a human-readable
* timecode string in 'HH:MM:SS.mmm' format.
*
* Strategy: multiply the position by 1000 to get milliseconds and store it
* in a zeroed-out Date object; then extract hours/minutes/seconds/ms via the
* standard Date accessors. This lets the JS engine do the modular arithmetic
* rather than duplicating it in hand-rolled integer division.
*
* Zero-padding helpers (local to the function):
*   wrap(n)    → zero-pads single-digit integers (e.g. 9 → '09')
*   wrap_ms(n) → zero-pads milliseconds to exactly 3 digits
*
* (!) The hours extraction applies a 12-hour modulo correction:
*     `date.getHours() < 13 ? ... : date.getHours() - 12`. This means
*     positions ≥ 12 h 0 m 0 s are silently clamped/offset. Media longer
*     than 12 hours would produce incorrect TC output.
*
* @param {number} time - media position in seconds (floating-point)
* @returns {string} tc - timecode string, e.g. '00:12:19.878'
*/
component_av.prototype.time_to_tc = function(time) {

	// date
		const date = (new Date())
		date.setHours(0); // reset the hours to 0
		date.setMinutes(0); // reset the minutes to 0
		date.setSeconds(0); // reset the seconds to 0
		date.setMilliseconds(time * 1000); // set the date with the time of the video in ms

	// format the tc with 09
	// current_date can be; hour, min or second
	function wrap(current_date) {
		return ((current_date < 10)
			? '0' + current_date
			: current_date);
	}
	//format the ms with 001 or 010 or 100
	function wrap_ms(ms) {
		return ((ms < 1)
			? '000'
			: (ms < 10)
				? '00' + ms
				:  (ms < 100)
					? '0' + ms
					: ms);
	}

	// (!) 12-hour correction: Date.getHours() returns 0–23; values ≥ 13 are
	//     reduced by 12. Media longer than 12 hours will produce unexpected TC.
	const hours		= wrap(date.getHours() < 13
		? date.getHours()
		: (date.getHours() - 12));
	const minutes	= wrap(date.getMinutes());
	const seconds	= wrap(date.getSeconds());
	const mseconds	= wrap_ms(date.getMilliseconds()) //fps: wrap(Math.floor(((time % 1) * frame_rate)));

	// tc
		const tc = `${hours}:${minutes}:${seconds}.${mseconds}`


	return tc
}//end time_to_tc



/**
* SET_PLAYBACK_RATE
* Set the HTMLMediaElement's playback speed. The rate is normalised to a
* one-significant-digit float (e.g. 1.5 → '2', 0.75 → '0.8') before being
* assigned because toPrecision(1) is used. Typical values from the UI are
* 0.5, 1.0, 1.5, 2.0.
* Returns false immediately when self.video is not yet set.
*
* (!) toPrecision(1) on values ≥ 10 produces scientific notation ('1e+1'),
*     which browsers will reject; pass only values in the range 0.1–9.9.
*
* @param {number} rate - desired playback rate (e.g. 1.0 for normal speed)
* @returns {string|boolean} the normalised rate string assigned to playbackRate,
*                           or false when no video element is set
*/
component_av.prototype.set_playback_rate = function(rate) {

	const self = this

	// no video case
		if (!self.video) {
			dd_console("Ignored rate call. No self.video is set", 'warning', [self.tipo, self.id]);
			return false
		}

	// Format number as float, precision 1
		rate = parseFloat(rate)
		rate = rate.toPrecision(1)

	// fix value
		self.video.playbackRate = rate;

	return rate
}//end set_playback_rate



/**
* OPEN_AV_PLAYER
* Static helper (not a prototype method) called by dd_grid_indexation to open
* the Dédalo AV viewer in a dedicated browser window. Builds a page URL with
* all parameters needed for the page layer to instantiate a component_av in
* 'viewer' mode, then delegates to open_window.
*
* The opened window's page layer reads tc_in / tc_out from the URL and seeks
* the media element to those positions after load.
*
* @param {Object} options - viewer options
* @param {string} options.component_tipo - ontology tipo of the AV component
* @param {string} options.section_tipo - ontology tipo of the parent section
* @param {string|number} options.section_id - record id of the parent section
* @param {number} [options.tc_in_secs=0] - start position in seconds (default 0)
* @param {number|null} [options.tc_out_secs=null] - end position in seconds; null = no limit
* @returns {Promise<boolean>} always resolves true
*/
export const open_av_player = async function(options) {

	// options
		const component_tipo	= options.component_tipo
		const section_id		= options.section_id
		const section_tipo		= options.section_tipo
		const tc_in_secs		= options.tc_in_secs ?? 0 // as seconds
		const tc_out_secs		= options.tc_out_secs ?? null // as seconds

	// open new window. Let page collect url params and create a new instance of component_av
		const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
			tipo			: component_tipo,
			section_tipo	: section_tipo,
			id				: section_id,
			mode			: 'edit',
			view			: 'viewer',
			menu			: false,
			tc_in			: tc_in_secs,
			tc_out			: tc_out_secs
		})
		open_window({
			url		: url,
			target	: 'viewer',
			// 16:9 starting box; the viewer refits it to the real media ratio
			width	: 1024,
			height	: 576
		})


	return true
}//end open_av_player



/**
* DOWNLOAD_AV_FRAGMENT
* Static helper (not a prototype method) called by dd_grid_indexation to extract
* and download a time-range clip from a media file. The server-side
* dd_component_av_api 'download_fragment' action runs FFmpeg (or equivalent)
* to produce the clip; the resulting file URL is the response payload.
*
* Flow:
*  1. Adds a 'loading' CSS class to the optional button_caller element.
*  2. Posts a 'download_fragment' request to dd_component_av_api via data_manager.
*  3. On success, triggers a browser download via download_file().
*  4. On failure, logs the error and hands it to handle_api_error (policy-rendered).
*  5. Removes the 'loading' class from button_caller in both cases.
*
* The request uses a 1-hour timeout because FFmpeg encoding of long clips can
* take substantial time on the server.
*
*     is currently wired up. Do not change this without updating all callers.
*
* @param {Object} options - fragment request options
* @param {string} options.tipo - ontology tipo of the AV component
* @param {string} options.section_tipo - ontology tipo of the parent section
* @param {string|number} options.section_id - record id of the parent section
* @param {string} options.tag_id - tag identifier for the fragment (used server-side)
* @param {string} options.lang - language code for multi-language media lookup
* @param {string} options.quality - quality label, e.g. 'low' | 'medium' | 'high'
* @param {number} [options.tc_in_secs=0] - fragment start in seconds
* @param {number|null} [options.tc_out_secs=null] - fragment end in seconds; null = end of file
* @param {boolean} [options.watermark=false] - whether to add a watermark to the output
* @param {HTMLElement} [options.button_caller] - button that triggered the action;
*        receives 'loading' class during the request
* @returns {Promise<Object>} resolves with the raw api_response from dd_component_av_api
*/
export const download_av_fragment = async function(options) {

	// options
		const tipo			= options.tipo
		const section_tipo	= options.section_tipo
		const section_id	= options.section_id
		const tag_id		= options.tag_id
		const lang			= options.lang
		const quality		= options.quality
		const tc_in_secs	= options.tc_in_secs || 0 // as seconds
		const tc_out_secs	= options.tc_out_secs || null // as seconds
		const watermark		= options.watermark!==undefined ? options.watermark : false
		const button_caller = options.button_caller

		if (button_caller) {
			button_caller.classList.add('loading')
		}

	/*
		// trigger url
			const trigger_url = null

		// watermark
			const watermark = null

		// url
			const url_vars = {
				mode			: 'download_file',
				quality			: quality,
				tipo			: tipo,
				section_tipo	: section_tipo,
				section_id		: section_id,
				tc_in			: tc_in,
				tc_out			: tc_out,
				watermark		: watermark
			}
			const pairs = []
			for (const key in url_vars) {
				pairs.push( key+'='+url_vars[key] )
			}
			const url = self.trigger_url + '?' + pairs.join('&')
			*/

	return new Promise(function(resolve){

		data_manager.request({
			body : {
				action	: 'download_fragment',
				dd_api	: 'dd_component_av_api',
				source	: {
					tipo			: tipo,
					section_tipo	: section_tipo,
					section_id		: section_id,
					tag_id			: tag_id,
					lang			: lang
				},
				options : {
					quality		: quality,
					tc_in_secs	: tc_in_secs,
					tc_out_secs	: tc_out_secs,
					watermark	: watermark
				}
			},
			retries : 1, // one try only
			timeout : 3600 * 1000 // 1 hour waiting response; encoding can be slow
		})
		.then(async function(api_response){

			if (button_caller) {
				button_caller.classList.remove('loading')
			}

			if (request_failed(api_response)) {

				// error case. The policy renders it (toast by default), in the
				// user's language, without blocking the page.
				console.error('Error on create fragment:', api_response.error)
				await handle_api_error(api_response.error);

			}else{

				// success case — build a friendly filename from quality + original basename
				const url		= response_data(api_response);
				const file_name	= `dedalo_download_${quality}_` + url.substring(url.lastIndexOf('/')+1);

				download_file({
					url			: url,
					file_name	: file_name
				})
			}

			resolve(api_response)
		})
	})
}//end download_av_fragment



/**
* GET_MEDIA_STREAMS
* Fetch technical stream metadata (video/audio tracks, codecs, durations,
* resolutions, etc.) from the server for this component's default-quality file.
* The data is provided by the server-side dd_component_av_api 'get_media_streams'
* action, which typically calls FFprobe.
*
* On success, resolves with the 'streams' array from the API response.
* On API error, logs the message and resolves with null (not rejected), allowing
* callers to treat missing stream info as a graceful degradation rather than a
* hard failure.
*
* @returns {Promise<Array|null>} resolves with the streams array on success,
*                               or null if the API reports an error
*/
component_av.prototype.get_media_streams = function() {

	const self = this

	return new Promise(function(resolve){

		data_manager.request({
			body : {
				action	: 'get_media_streams',
				dd_api	: 'dd_component_av_api',
				source	: {
					tipo			: self.tipo,
					section_tipo	: self.section_tipo,
					section_id		: self.section_id,
					lang			: self.lang
				},
				options : {
					// quality	: quality
				}
			},
			retries : 2, // two try only
			timeout : 15 * 1000 // 15 secs waiting response
		})
		.then(async function(api_response) {
			if(SHOW_DEBUG===true) {
				console.log('))) get_media_streams api_response:', api_response);
			}

			const streams_data = response_data(api_response)
			if (request_failed(api_response) || streams_data===false) {

				// error case

				console.error(request_failed(api_response)
					? error_text(api_response.error)
					: 'Error on get_media_streams')

				resolve(null)

			}else{

				// success case — extract streams array; default to [] if absent
				const media_streams	= streams_data?.streams || []

				resolve(media_streams)
			}
		})
	})
}//end get_media_streams



/**
* CREATE_POSTERFRAME
* Extract a still frame from the media file at the current playback position
* and save it as the component's posterframe image on the server, overwriting
* any previously existing posterframe for this record.
*
* The request passes self.video.currentTime so the server knows which frame to
* extract. If self.video is not yet set (e.g. called before the player renders),
* the optional-chaining fallback sends 0 (start of file).
*
* (!) The doc-block param '@param object viewer' in the original is inaccurate:
*     the function signature takes no parameters — the instance (self) provides
*     all required context via create_source(self).
*
* (!) SHOW_DEVELOPER is not declared in the global pragma at the top of this file.
*     If it is undefined at runtime, the guard evaluates as false and the debug
*     log is silently skipped.
*
* @returns {Promise<boolean>} the response payload — true on success, false on error
*/
component_av.prototype.create_posterframe = async function() {

	const self = this

	// move_file_to_dir
		const rqo = {
			dd_api	: 'dd_component_av_api',
			action	: 'create_posterframe',
			source	: create_source(self),
			options	: {
				current_time : self.video?.currentTime || 0 // fallback to 0 when no video element
			}
		}

	// call to the API, fetch data and get response
		const api_response = await data_manager.request({
			body : rqo,
			retries : 1, // one try only
			timeout : 3600 * 1000 // 1 hour waiting response; frame extraction can be slow
		})

	// debug
		if(SHOW_DEVELOPER===true) {
			dd_console("-> create_posterframe API response:",'DEBUG', api_response);
		}


	return response_data(api_response)
}//end create_posterframe



/**
* DELETE_POSTERFRAME
* Remove the existing posterframe file for this component from the server.
* All context is derived from the component instance via create_source(self);
* no additional options are currently required by the API action.
*
* (!) The inline comment '// move_file_to_dir' is a stale copy-paste label
*     from a sibling action and does not describe the actual operation here.
*
* (!) SHOW_DEVELOPER is not declared in the global pragma at the top of this file —
*     see the same note in create_posterframe above.
*
* @returns {Promise<boolean>} the response payload — true on success, false on error
*/
component_av.prototype.delete_posterframe = async function() {

	const self = this

	// move_file_to_dir
		const rqo = {
			dd_api	: 'dd_component_av_api',
			action	: 'delete_posterframe',
			source	: create_source(self),
			options	: {}
		}

	// call to the API, fetch data and get response
		const api_response = await data_manager.request({
			body : rqo,
			retries : 1, // one try only
			timeout : 3600 * 1000 // 1 hour waiting response
		})

	// debug
		if(SHOW_DEVELOPER===true) {
			dd_console("-> delete_posterframe API response:",'DEBUG', api_response);
		}


	return response_data(api_response)
}//end delete_posterframe



// @license-end
