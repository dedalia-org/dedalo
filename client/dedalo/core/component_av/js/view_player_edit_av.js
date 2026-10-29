// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {when_in_viewport} from '../../common/js/events.js'
	import {get_media_url} from './media_url.js'
	import {event_manager} from '../../common/js/event_manager.js'



/**
* VIEW_PLAYER_EDIT_AV
* Dedicated "player" view for the component_av edit mode.
*
* This module exports the render entry-point and the two helper builders
* that assemble the HTML5 video element and its accompanying transport controls.
* It is selected when context.view === 'player' (as opposed to the default 'default'
* or 'viewer' views handled by sibling modules).
*
* Key responsibilities:
*  - Lazily load the video source via IntersectionObserver (when_in_viewport) so
*    the browser does not fetch media bytes until the player enters the visible
*    viewport — important for list views that may render dozens of AV components.
*  - Apply fragment time-range constraints (vbegin / vend) as media-fragment URI
*    parameters when self.fragment is set (e.g. from a linked timecode annotation).
*  - Attach a <track kind="captions"> element when subtitles are available in
*    self.data.subtitles, and subscribe to the 'updated_subtitles_file_<id>' event
*    so the track is hot-swapped whenever tool_transcription regenerates the VTT file.
*  - Restrict right-click context menu and show 'nodownload' on the native controls
*    when the component's permission level is read-only (self.permissions <= 1).
*  - Render a custom transport-control bar (get_av_control_buttons) that exposes
*    frame-accurate navigation driven by the r_frame_rate reported in self.media_streams.
*
* Data shapes expected on `self` (the component_av instance):
*   self.context            {Object}  - component context DDO from the server
*   self.context.features   {Object}  - { quality: string, extension: string, ... }
*   self.data               {Object}  - component data DDO from the server
*   self.data.entries       {Array}   - array of entry objects; entries[0] is the primary file group
*   self.data.entries[0].files_info {Array} - array of file_info objects per quality/extension
*     file_info shape: { quality, extension, file_path, file_exist, file_size, file_time }
*   self.data.posterframe_url {string} - absolute URL of the poster image, versioned by the server (?v=<mtime ms>-<size>)
*   self.data.subtitles     {Object|undefined}
*     subtitles shape: { subtitles_url: string, lang: string, lang_name: string }
*   self.fragment           {Object|null} - active fragment window; null means no fragment
*     fragment shape: { tc_in: string|null, tc_out: string|null }
*   self.media_streams      {Array}   - FFprobe stream objects; index 0 is the video stream
*     stream shape: { r_frame_rate: '25/1', ... }  (r_frame_rate is a rational string)
*   self.quality            {string}  - active quality level, e.g. 'original' | '404' | '720'
*   self.permissions        {number}  - 1 = read-only, 2 = read/write
*   self.video              {HTMLVideoElement} - set by get_content_data_player after DOM append
*   self.events_tokens      {Array}   - accumulator for event_manager subscription tokens
*   self.id                 {string}  - component instance id (used as event channel suffix)
*
* Exports:
*   view_player_edit_av          — namespace constructor (returns true; not instantiated)
*   view_player_edit_av.render   — async entry-point; builds and returns the full wrapper node
*   get_content_data_player      — exported so sibling views can embed the player inside their own layout
*/



/**
* VIEW_PLAYER_EDIT_AV
* Namespace constructor. Not instantiated; serves only as an object carrier for
* the static render method below. Mirrors the pattern used by all other
* view_*_edit_*.js modules in this component.
* @returns {boolean} Always true.
*/
export const view_player_edit_av = function() {

	return true
}//end view_player_edit_av



/**
* RENDER
* Async entry-point called by render_edit_component_av when the active view is 'player'.
*
* Two operating modes controlled by options.render_level:
*   'content' — returns only the content_data node (used when re-rendering in-place,
*               e.g. after an upload, without rebuilding the outer wrapper).
*   'full'    — (default) returns the full component wrapper including the outer
*               chrome built by ui.component.build_wrapper_edit. A pointer from
*               wrapper.content_data back to the inner node is always set.
*
* Side effects:
*   - Fetches self.media_streams from the server API if not already cached on self.
*     media_streams is needed by get_av_control_buttons for frame-rate calculations.
*   - Populates self.video (via get_content_data_player → video element append).
*
* (!) The add_events call is currently commented out (line 59). Events are wired inside
*     get_content_data_player instead (viewport observer, subtitle reload, permission guard).
*
* @param {Object} self    - component_av instance
* @param {Object} options - render options
* @param {string} [options.render_level='full'] - 'content' | 'full'
* @returns {Promise<HTMLElement>} wrapper (full mode) or content_data node (content mode)
*/
view_player_edit_av.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// media_streams (used to know frame rate)
		if (!self.media_streams) {
			self.media_streams = await self.get_media_streams()
		}

	// content_data
		const content_data = get_content_data_player({
			self					: self,
			with_control_buttons	: true
		})
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			label			: null
		})
		// set pointers
		wrapper.content_data = content_data

	// add events
		//add_events(self, wrapper)


	return wrapper
}//end  player



/**
* GET_CONTENT_DATA_PLAYER
* Build the inner content node containing the HTML5 video element and, optionally,
* the transport control bar.
*
* Exported so that sibling view modules (e.g. a modal overlay) can embed the
* player without constructing the full edit wrapper.
*
* Video source resolution:
*   The function selects the file_info entry whose quality matches self.quality
*   (or context.features.quality as fallback) AND whose extension matches
*   context.features.extension AND whose file_exist is true. If no matching
*   entry is found, video_url is null and the video element is omitted entirely.
*
* Fragment URL syntax:
*   When self.fragment is set, Media Fragment URI parameters are appended to the
*   video src: `?vbegin=<tc_in_seconds>&vend=<tc_out_seconds>`.  tc_in defaults
*   to 0 when self.fragment.tc_in is falsy.  tc_out falls back to self.video.duration
*   — which at this point may be undefined because the video has not yet loaded;
*   callers relying on tc_out should ensure the video metadata is available first.
*
* Lazy loading:
*   The <video> element's src attribute is NOT set immediately. Instead, the node
*   is registered with when_in_viewport so that the src (and preload='metadata') are
*   applied only after the element scrolls into the visible area. This prevents
*   unnecessary network requests for AV components that are off-screen.
*
* Subtitle track:
*   When self.data.subtitles.subtitles_url is present and the video is not a fragment
*   (tc_in is null), a <track kind="captions"> element is created and appended.
*   A subscription to the event channel 'updated_subtitles_file_<self.id>' is also
*   registered so the track src can be rewritten when the VTT file changes.
*   The subscription token is stored in self.events_tokens for cleanup on destroy.
*
* (!) DEDALO_MEDIA_URL is a global constant (listed in the file-top globals pragma)
*     injected by the PHP page shell. If undefined at runtime, video_url construction
*     will throw. Similarly, event_manager is used without an explicit import — it must
*     be available as a page-level global. This is a known pattern in this codebase but
*     should be reviewed if the module is ever refactored into strict ESM isolation.
*
* (!) self.video.duration (used in tc_out fallback at line 114) may be NaN or undefined
*     when this function runs synchronously before the video fires 'loadedmetadata'.
*     The fragment URL could therefore contain 'vend=NaN' for the fallback case.
*
* @param {Object}  options                       - call options
* @param {Object}  options.self                  - component_av instance
* @param {boolean} options.with_control_buttons  - when true, append the transport control bar
* @returns {HTMLElement} content_data - the populated content wrapper node
*/
export const get_content_data_player = function(options) {

	// options
		const self					= options.self
		const with_control_buttons	= options.with_control_buttons

	const fragment = new DocumentFragment()

	// short vars
		const context		= self.context || {}
		const data			= self.data || {}
		const entries		= data.entries || []
		const files_info	= entries[0]
			? (entries[0].files_info || [])
			: []
		const quality		= self.quality || context.features.quality
		const extension		= self.context.features.extension

	// url
		// posterframe
			const posterframe_url = data.posterframe_url || page_globals.fallback_image

		// media
			const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true && el.extension===extension)
			const video_url	= file_info && file_info.file_path
				? get_media_url(file_info) // file-versioned: a rebuilt rendition gets a new URL
				: null

	// player
		if (video_url) {

			// fragment
			// Build Media Fragment URI parameters when self.fragment is set.
			// vbegin/vend are expected to carry TC strings (HH:MM:SS.mmm) as produced
			// by component_av.prototype.time_to_tc — the browser interprets them as seconds.
				const tc_in = (!self.fragment)
					? null
					: (self.fragment.tc_in)
						? 'vbegin='+ self.fragment.tc_in
						: 'vbegin=0';

				const tc_out = (!self.fragment)
					? null
					:(self.fragment.tc_out)
						? 'vend='+ self.fragment.tc_out
						: null; // duration is unknown before metadata loads (self.video does
						         // not exist yet here); omit vend and let it play to the end

				const fragment_url = (tc_in)
					? (tc_out ? tc_in + '&' + tc_out : tc_in)
					: null

			// video node
				const video		= document.createElement('video')
				video.poster	= posterframe_url
				video.preload	= 'none' // prevent video data loading until user interaction
				video.controls	= true
				video.classList.add('posterframe')
				video.setAttribute('tabindex', 0)

			// observer. Set video source only when it is in viewport (to save network traffic)
				when_in_viewport(
					video, // node to observe
					() => { // callback
						video.preload = 'metadata' // load only metadata (duration, dimensions) not full video
						video.src = (self.fragment)
							? video_url + '?' + fragment_url
							: video_url
					}
				)

			// permissions
			// set read only permissions, remove the contextmenu and nodownload
				if(self.permissions <= 1){
					video.addEventListener("contextmenu", (e) => {
						e.preventDefault();
						return false
					});
					video.controlsList	= 'nodownload'
				}

			// subtitles track.
				if (tc_in) {
					// Add only if its not a fragment
					console.warn('Skip create subtitles track to fragment. tc_in: ', tc_in);
				}else{
					const subtitles	= self.data.subtitles
					if(subtitles && subtitles.subtitles_url) {

						const subtitles_track	= document.createElement('track')
						// subtitles_track.type	= 'text/vtt'
						subtitles_track.kind	= 'captions'
						subtitles_track.src		= subtitles.subtitles_url
						subtitles_track.srclang	= subtitles.lang
						subtitles_track.label	= subtitles.lang_name
						subtitles_track.default	= true
						// Add new track to video
						video.appendChild(subtitles_track)

						// update_subtitles event
						// (this event is fired, among others, by tool_transcription on update subtitles file)
						const updated_subtitles_file_handler = (options={}) => {

							// options (non mandatory)
								const lang	= options.lang || self.lang
								const url	= options.url || subtitles.subtitles_url

							// lang_tld2
							// Look up the ISO 3166-1 alpha-2 language code (tld2) from the global
							// dedalo_projects_default_langs list so the track srclang attribute can be
							// updated accurately even when the incoming lang is a Dédalo lang-id (e.g. 'lg-es').
								const lang_item = page_globals.dedalo_projects_default_langs.find(
									el => el.value===lang
								)
								const lang_tld2 = lang_item ? lang_item.tld2 : null
								if (!lang_tld2) {
									console.log(
										'Unable to find lang in page_globals:',
										options.lang,
										page_globals.dedalo_projects_default_langs
									);
									return
								}

							// URL src replace
							// Replace the language path segment (e.g. 'lg-es') in the existing URL with
							// the new lang, then append a cache-buster to force the browser to reload
							// the VTT file even if the path is identical to what was previously cached.
								const new_url = subtitles_track.srclang!==lang_tld2
									? url.replace(/(lg-[a-z]{2,})/, lang)
									: subtitles_track.src
								const non_cache_url = new_url.split('?')[0] + '?t=' + (new Date()).getTime()
								// apply source url
								subtitles_track.src	= non_cache_url

							// lang info update
								if (subtitles_track.srclang!==lang_tld2) {
									subtitles_track.srclang	= lang_tld2
									subtitles_track.label	= lang_item.label
								}

							if(SHOW_DEBUG===true) {
								console.log('Changed subtitles track src:', lang_tld2, subtitles_track.src);
							}
						}
						self.events_tokens.push(
							event_manager.subscribe('updated_subtitles_file_' + self.id, updated_subtitles_file_handler)
						)
					}
				}

			// append the video node to the instance
				self.video = video
				fragment.appendChild(video)
		}

	// av_control_buttons
		if (with_control_buttons && self.video) {
			const av_control_buttons = get_av_control_buttons(self)
			fragment.appendChild(av_control_buttons)
		}

	// content_data
		const content_data = ui.component.build_content_data(self)
			  content_data.appendChild(fragment)


	return content_data
}//end get_content_data_player



/**
* GET_AV_CONTROL_BUTTONS
* Build the custom transport-control bar that sits below the native HTML5 video controls.
*
* The bar provides:
*   - Beginning     : seek to t=0
*   - Play/Pause    : toggle playback; icon class switches between 'play' and 'pause'
*                     by listening to the native 'play' and 'pause' events on self.video
*   - SMPTE display : live timecode readout updated on every 'timeupdate' event
*   - < 10s / < 5s : seek backward by 10 or 5 seconds
*   - - 1 / + 1    : step one video frame backward or forward (frame-accurate)
*   - > 5s / > 10s : seek forward by 5 or 10 seconds
*
* Frame-accurate navigation:
*   The ±1 frame buttons compute the per-frame duration from the FFprobe r_frame_rate
*   rational string stored in self.media_streams[0].r_frame_rate (e.g. '25/1' or '30000/1001').
*   The resulting time_for_frame is added to / subtracted from self.video.currentTime
*   and passed to self.go_to_time(). The computed target is rounded to 3 decimal places
*   to avoid floating-point drift accumulating across many frame-step operations.
*
* Event handling strategy:
*   All interactive controls listen on 'mouseup' (not 'click') to allow the user to
*   position the playhead precisely without triggering an accidental click event from a
*   mousedown-drag sequence. The ±seconds buttons also call e.stopPropagation() to
*   prevent the event from bubbling to a potential parent drag handler in the section.
*
* (!) The Play/Pause button's event listeners use `async` arrow functions but perform
*     no await operations — they are synchronous in practice and the async keyword is
*     unnecessary. This is existing code; do not remove async.
*
* (!) The 'timeupdate' event listener is also marked async without a reason — same note.
*
* @param {Object} self - component_av instance; self.video and self.media_streams must be set
* @returns {HTMLElement} av_control_buttons - container div with class 'av_control_buttons'
*/
const get_av_control_buttons = (self) => {

	const fragment = new DocumentFragment()

	// css
		const btn_class = 'light'

	// av_begin_button. button go to begin of av
		const av_begin_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			inner_html		: get_label.beginning || 'Beginning',
			parent			: fragment
		})
		av_begin_button.addEventListener('mouseup', () =>{
			const seconds = 0
			self.go_to_time({
				seconds : seconds
			});
		})

	// av_play_button. play / pause media
		const av_play_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class + ' play',
			// text_content	: get_label.play || 'Play',
			parent			: fragment
		})
		//listen the av state
		self.video.addEventListener('pause', async () =>{
			av_play_button.classList.remove('pause')
			av_play_button.classList.add('play')
		})
		self.video.addEventListener('play', async () =>{
			av_play_button.classList.remove('play')
			av_play_button.classList.add('pause')
		})
		// change the state of the av
		av_play_button.addEventListener('mouseup', () =>{
			self.play_pause();
		})

	// av_smpte. Show the SMPTE (time code)
		const av_smpte = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'smpte',
			parent			: fragment,
			inner_html		: render_value(self.get_current_tc(), 'text')
		})
		// throttle DOM updates and use textContent (no HTML parse) to avoid
		// excessive reflows during playback (timeupdate can fire many times/sec)
		let last_tc_update = 0
		self.video.addEventListener('timeupdate', () =>{
			const now = performance.now()
			if (now - last_tc_update < 100) {
				return
			}
			last_tc_update = now
			av_smpte.textContent = self.get_current_tc();
		})

	// av_minus_10_seg. Go to 10 seconds before of the current time ( - 10 seconds )
		const av_minus_10_seg = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '< 10s',
			parent			: fragment
		})
		av_minus_10_seg.addEventListener('mouseup', (e) =>{
			e.stopPropagation()

			const seconds = self.video.currentTime - 10
			self.go_to_time({
				seconds : seconds
			});
		})

	// av_minus_5_seg. Go to 5 seconds before of the current time ( - 5 seconds )
		const av_minus_5_seg = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '< 5s',
			parent			: fragment
		})
		av_minus_5_seg.addEventListener('mouseup', (e) =>{
			e.stopPropagation()

			const seconds = self.video.currentTime - 5
			self.go_to_time({
				seconds : seconds
			});
		})

	// move_frame function
		const move_frame = (e) => {
			e.stopPropagation()

			const media_stream = self.media_streams[0] || null
			if (!media_stream) {
				console.error('Error getting media_stream:', self.media_streams);
				return
			}

			const direction = e.target.direction

			// get the r_frame_rate of the video stream and get the time for 1 frame
			const r_frame_rate				= media_stream.r_frame_rate
			const ar_frame_rate_operator	= r_frame_rate.split('/')
			const frame_rate				=  parseInt(ar_frame_rate_operator[0]) / parseInt(ar_frame_rate_operator[1])
			const time_for_frame			= 1 / frame_rate
			const seconds					= (direction==='forward')
				? (self.video.currentTime + time_for_frame).toFixed(3)
				: (self.video.currentTime - time_for_frame).toFixed(3)
			self.go_to_time({
				seconds : seconds
			});
		}//end move_frame

	// av_minus_1_frame. Go to 1 frame before of the current time ( - 1 frame )
		// the server send the head information in the media_info streams
		// the video is the first item of the streams array
		const av_minus_1_frame = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '- 1',
			parent			: fragment
		})
		av_minus_1_frame.direction = 'backward'
		av_minus_1_frame.addEventListener('mouseup', move_frame)

	// av_plus_1_frame. go to 1 frame after of the current time ( + 1 frame )
		// the server send the head information in the media_info streams
		// the video is the first item of the streams array
		const av_plus_1_frame = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '+ 1',
			parent			: fragment
		})
		av_plus_1_frame.direction = 'forward'
		av_plus_1_frame.addEventListener('mouseup', move_frame)

	// av_plus_5_seg. Go to 5 seconds after of the current time ( + 5 seconds )
		const av_plus_5_seg = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '> 5s',
			parent			: fragment
		})
		av_plus_5_seg.addEventListener('mouseup', (e) =>{
			e.stopPropagation()

			const seconds = self.video.currentTime + 5
			self.go_to_time({
				seconds : seconds
			});
		})

	// av_plus_10_seg. Go to 10 seconds after of the current time ( + 10 seconds )
		const av_plus_10_seg = ui.create_dom_element({
			element_type	: 'button',
			class_name		: btn_class,
			text_content	: '> 10s',
			parent			: fragment
		})
		av_plus_10_seg.addEventListener('mouseup', (e) =>{
			e.stopPropagation()

			const seconds = self.video.currentTime + 10
			self.go_to_time({
				seconds : seconds
			});
		})

	// av_control_buttons main container
		const av_control_buttons = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'av_control_buttons'
		})
		av_control_buttons.appendChild(fragment)


	return av_control_buttons
}//end get_av_control_buttons



/**
* BUILD_VIDEO_HTML5
* Legacy HTML5 video builder — superseded by the inline video construction in
* get_content_data_player and left commented out for historical reference.
*
* This block was the original generic video factory that supported multi-source,
* restricted-fragment skipping, and loadedmetadata-driven subtitle injection.
* The approach was replaced by the current viewport-lazy pattern (when_in_viewport).
*
* (!) Do not remove this block; it documents the prior architecture and the
*     specific problems (event-handler map, play-on-ready) that the current
*     implementation deliberately avoids.
*
* @returns {HTMLElement} video - the constructed HTML5 video element
*/
	// const build_video_html5 = function(request_options) {

	// 	const self = this

	// 	// options
	// 		const options = {
	// 			// video type. (array) default ["video/mp4"]
	// 			type 	 : ["video/mp4"],
	// 			// video src. (array)
	// 			src  	 : [""],
	// 			// id. dom element video id (string) default "video_html5"
	// 			id 		 : "video_html5",
	// 			// controls. video control property (boolean) default true
	// 			controls : true,
	// 			// play (boolean). play video on ready. default false
	// 			play : false,
	// 			// poster image. (string) url of posterframe image
	// 			poster 	 : "",
	// 			// class css. video additional css classes
	// 			class 	 : "",
	// 			// preload (string) video element attribute preload
	// 			preload  : "auto",
	// 			// height (integer) video element attribute. default null
	// 			height 	 : null,
	// 			// width (integer) video element attribute. default null
	// 			width 	 : null,
	// 			// tcin_secs (integer). default null
	// 			tcin_secs  : 0,
	// 			// tcout_secs (integer). default null
	// 			tcout_secs : null,
	// 			// ar_subtitles (array). array of objects with subtitles full info. default null
	// 			ar_subtitles : null,
	// 			// ar_restricted_fragments. (array) default null
	// 			ar_restricted_fragments : null
	// 		}

	// 		// apply options
	// 		for (var key in request_options) {
	// 			if (request_options.hasOwnProperty(key)) {
	// 				options[key] = request_options[key]
	// 			}
	// 		}
	// 		// debug
	// 		if(SHOW_DEBUG===true) {
	// 			console.log("[common.build_video_html5] options",options)
	// 		}

	// 	// video handler events
	// 		const handler_events = {
	// 			loadedmetadata 	: {},
	// 			timeupdate 		: {},
	// 			contextmenu 	: {}
	// 		}

	// 	// html5 video. dom element html5 video
	// 		const video 				= document.createElement("video")
	// 			  video.id 				= options.id
	// 			  video.controls 		= options.controls
	// 			  video.poster 			= options.poster
	// 			  video.className 		= options.class
	// 			  video.preload 		= options.preload
	// 			  video.controlsList 	= "nodownload"
	// 			  video.dataset.setup 	= '{}'

	// 			  if (options.height) {
	// 				video.height = options.height
	// 			  }
	// 			  if (options.width) {
	// 				video.width = options.width
	// 			  }
	// 			  options.play = true
	// 			  if (options.play && options.play===true) {

	// 				handler_events.loadedmetadata.play = (e) => {
	// 			  		try {
	// 					//video.play()
	// 				}catch(error){
	// 			  		console.warn("Error on video play:",error);
	// 			  	}
	// 			}
	// 		  }

	// 		// src. video sources
	// 			for (let i = 0; i < options.src.length; i++) {
	// 				let source 		= document.createElement("source")
	// 					source.src  = options.src[i]
	// 					source.type = options.type[i]
	// 				video.appendChild(source)
	// 			}

	// 		// restricted fragments. Set ar_restricted_fragments on build player to activate skip restricted fragments
	// 			if (options.ar_restricted_fragments) {
	// 				const ar_restricted_fragments = options.ar_restricted_fragments
	// 				const tcin_secs 			  = options.tcin_secs
	// 				if (typeof ar_restricted_fragments!=="undefined" && ar_restricted_fragments.length>0) {
	// 					handler_events.timeupdate.skip_restricted = () => {
	// 						self.skip_restricted(video, ar_restricted_fragments, tcin_secs)
	// 					}
	// 				}
	// 			}

	// 		// subtitles
	// 			if (options.ar_subtitles) {
	// 				const subtitles_tracks = []
	// 				for (let i = 0; i < options.ar_subtitles.length; i++) {

	// 					let subtitle_obj = options.ar_subtitles[i]

	// 					if (subtitle_obj.src===undefined) {
	// 						console.warn("Invalid subtitle object:",subtitle_obj);
	// 						continue
	// 					}

	// 					// Build track
	// 					let track = document.createElement("track")
	// 						track.kind 		= "captions" // subtitles | captions
	// 						track.src 		= subtitle_obj.src
	// 						track.srclang 	= subtitle_obj.srclang
	// 						track.label 	= subtitle_obj.label
	// 						if (subtitle_obj.default && subtitle_obj.default===true) {
	// 							track.default = true
	// 							track.addEventListener("load", function() {
	// 							   this.mode = "showing";
	// 							   video.textTracks[0].mode = "showing"; // thanks Firefox
	// 							});
	// 						}
	// 					// add track
	// 					subtitles_tracks.push(track)
	// 				}//end for (var i = 0; i < options.ar_subtitles.length; i++)

	// 				handler_events.loadedmetadata.add_subtitles_tracks = () => {
	// 					for (let i = 0; i < subtitles_tracks.length; i++) {
	// 						// add to video
	// 						video.appendChild(subtitles_tracks[i]);
	// 						//console.log("added subtitle track:",subtitles_tracks[i]);
	// 					}
	// 				}
	// 			}

	// 		// msj no html5
	// 			const msg_no_js = document.createElement("p")
	// 				  msg_no_js.className = "vjs-no-js"
	// 			const msj_text = document.createTextNode("To view this video please enable JavaScript, and consider upgrading to a web browser that supports HTML5 video")
	// 				  msg_no_js.appendChild(msj_text)
	// 			video.appendChild(msg_no_js)

	// 		// disable_context_menu - (TEMPORAL DISABLED !)
	// 			// handler_events.contextmenu.disable_context_menu = (e) => {
	// 			// 	e.preventDefault();
	// 			// }



	// 		// REGISTER_EVENTS
	// 		const register_events = function(handler_object, handler_events) {

	// 			for (let event_name in handler_events) {
	// 				// add event
	// 				const event_functions = handler_events[event_name]
	// 				handler_object.addEventListener(event_name, function(e) {
	// 					for (let key in event_functions) {
	// 						event_functions[key](e)
	// 					}
	// 				})
	// 			}

	// 			return true
	// 		}

	// 		// video events	register
	// 			register_events(video, handler_events)


	// 	return video
	// }//end  build_video_html5



// @license-end
