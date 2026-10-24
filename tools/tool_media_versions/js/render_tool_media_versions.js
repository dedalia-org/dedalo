// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_media_versions */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {format_elapsed} from '../../../core/common/js/job_follow.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {error_text, render_error_inline, render_error_toast} from '../../../core/common/js/render_api_error.js'
	import {bytes_format, download_file, open_window} from '../../../core/common/js/utils/index.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'



/**
* RENDER_TOOL_MEDIA_VERSIONS
* Client-side render module for the tool_media_versions tool.
*
* This module provides the edit-mode DOM rendering for the media-versions tool,
* which displays a per-quality grid of all physical media files associated with a
* media component (component_image, component_av, etc.).
*
* Architecture:
*  - `render_tool_media_versions` is a plain constructor whose `prototype.edit` is
*    mixed into `tool_media_versions` (see tool_media_versions.js).
*  - The edit UI is composed of:
*      1. A read-only inline preview of the main_element component (the media itself).
*      2. A sync_data bar that compares DB-stored files_info against real disk state
*         and exposes a "Regenerate" action when they diverge.
*      3. A versions_grid — a CSS grid where columns are quality levels and rows are
*         action categories (File preview, Size, Upload, Versions, Delete, Build,
*         and any model-specific actions such as rotate or conform_headers).
*
* Data flow (set by tool_media_versions.build before render is called):
*  - self.files_info_disk    — live disk scan (array of file_info objects).
*  - self.files_info_safe    — disk entries whose extension matches main_extension.
*  - self.files_info_alternative — disk entries with a non-main extension.
*  - self.files_info_original — disk entries with quality === 'original'.
*  - self.ar_quality         — ordered list of quality names from caller context.
*  - self.regenerate_options — user-chosen flags passed to the sync_files API call.
*
* File-info object shape (returned by get_files_info / stored in build):
*  {
*    quality    : {string}          — e.g. 'original', '404', 'audio', 'thumb'
*    file_exist : {boolean}         — false when the file is missing on disk
*    file_name  : {string|null}
*    file_path  : {string|null}     — server-relative path prepended with DEDALO_MEDIA_URL
*    file_url   : {string|null}
*    file_size  : {number|null}     — bytes
*    file_time  : {Object|null}
*    extension  : {string|null}
*  }
*
* (!) DEDALO_MEDIA_URL is consumed in this module but is NOT listed in the
* /*global*\/ directive above — it will trigger an eslint no-undef warning.
* It is injected into the page as a browser global by the PHP template layer.
*/
export const render_tool_media_versions = function() {

	return true
}//end render_tool_media_versions



/**
* EDIT
* Builds and returns the full edit-mode DOM wrapper for the media-versions tool.
*
* Called by the tool_common render pipeline (mixed into tool_media_versions.prototype.edit).
* When render_level === 'content', skips the outer wrapper and returns only the
* content_data node (used for partial refreshes). Otherwise returns a complete
* ui.tool wrapper with content_data attached as a property for later reference.
*
* @param {Object} options - render options forwarded from tool_common
* @param {string} [options.render_level='full'] - 'full' builds wrapper; 'content' returns content_data only
* @returns {Promise<HTMLElement>} wrapper (full) or content_data (content-only)
*/
render_tool_media_versions.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointer
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the inner content_data node that forms the body of the tool UI.
*
* The content_data contains three logical sections, appended in order:
*  1. main_element_container — a read-only, no-toolbar render of the media
*     component itself (so the editor can see the current media inline).
*  2. sync_data bar — file/DB comparison strip (only when render_sync_data
*     returns a non-null node).
*  3. versions_grid — the full quality × action matrix.
*
* The main_element render is kicked off asynchronously (non-blocking); the
* resolved component_node is appended when ready, so the rest of the UI
* paints immediately.
*
* @param {Object} self - the tool_media_versions instance
* @returns {Promise<HTMLElement>} content_data node ready to insert into the DOM
*/
const get_content_data = async function(self) {

	// RECORD JOBS, BEFORE THE GRID. Ask the server what background work is
	// already running for this record, so a tier being built by an upload — or by
	// another operator — renders as busy instead of as an empty cell. Awaited on
	// purpose: the grid reads this to decide whether a tier gets a gear or a
	// progress readout, and painting the gear first would offer a build that the
	// server is about to refuse. get_record_jobs degrades to [] on any failure, so
	// this can delay the panel but never break it.
		self.record_jobs = await self.get_record_jobs()

	// RELEASE THE PREVIOUS PASS'S JOB STREAMS. A render replaces every node this
	// panel owns, so the followers of the previous pass are writing to a DOM that
	// no longer exists — and each one holds an HTTP connection for as long as its
	// job runs. This pass re-discovers the same live jobs from self.record_jobs
	// just below and follows them again, against the nodes it is about to build, so
	// nothing stops being watched; only the orphans are given back.
		self.job_followers.cancel_all()

	// DocumentFragment
		const fragment = new DocumentFragment()

	// main_element_container
		const main_element_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'main_element_container',
			parent			: fragment
		})
		// show_interface: disable toolbar and force read-only so the embedded
		// component is a pure preview — the tool manages edits, not the component itself
		self.main_element.show_interface.tools = false
		self.main_element.show_interface.read_only = true
		// render
		self.main_element.render()
		.then(function(component_node){
			main_element_container.appendChild(component_node)
		})
		// fix: keep a reference so other methods can locate the container later
		self.main_element_container = main_element_container

	// render_sync_data
		const sync_data = render_sync_data(self)
		if (sync_data) {
			fragment.appendChild(sync_data)
		}

	// versions_container
		const versions_grid = render_versions_grid(self)
		fragment.appendChild(versions_grid)

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)

	// activate tooltips
		ui.activate_tooltips(content_data, 'button')


	return content_data
}//end get_content_data



/**
* RENDER_SYNC_DATA
* Builds a diagnostic / control strip that compares DB-stored file metadata against
* real disk state, and lets the user trigger a full media regeneration.
*
* The strip contains:
*  - A toggle icon button ('eye' when in sync, 'exclamation' when not) and a label
*    that reveal/hide the raw JSON comparison panel (pre_data).
*  - A "Regenerate component" button that calls self.sync_files() after confirmation,
*    then refreshes the tool on success or shows an alert on failure.
*  - A "Delete normalized files" checkbox that sets self.regenerate_options before
*    the sync_files call, directing the server to also delete derived files.
*  - A hidden <pre> panel with the JSON diff between DB and disk for debugging.
*
* Sync check: is_sync is a coarse length comparison only — it does not compare
* individual file names or paths. A length match is a necessary but not sufficient
* condition for true synchrony.
*
* (!) pre_data is declared after button_icon_show_data's click listener, which
* references it via closure. The forward reference works because JS closures
* capture the binding, not the value — pre_data is defined by the time any click
* fires.  The eslint no-use-before-define rule would warn here if enabled.
*
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} sync_data_wrapper node containing the control strip
*/
const render_sync_data = function(self) {

	// files info from DB data
		const files_info_db = self.files_info_db || []

	// files info from disk
		const files_info_disk = self.files_info_disk || []

	// original_file_name
		const original_file_name = self.original_file_name

	// original_normalized_name
		const original_normalized_name = self.original_normalized_name

	// is_sync: coarse check — equal entry counts implies DB and disk are in sync
		const is_sync = files_info_db.length === files_info_disk.length

	// debug
		if(SHOW_DEBUG===true) {
			console.log('debug files_info_db:', files_info_db);
			console.log('debug files_info_disk:', files_info_disk);
		}

	// sync_data_wrapper
		const sync_data_wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'sync_data_wrapper'
		})

		// versions_container: inner bar that holds controls side by side
			const versions_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'sync_data_container',
				parent			: sync_data_wrapper
			})

		// button_icon_show_data: toggles the pre_data JSON panel visibility
			const button_icon_show_data = ui.create_dom_element({
				element_type	: 'span',
				title			: 'Display component files_info',
				class_name		: 'button icon ' + (is_sync ? 'eye' : 'exclamation'),
				parent			: versions_container
			})
			button_icon_show_data.addEventListener('click', function(e) {
				e.stopPropagation()
				// (!) pre_data is declared below; closure forward reference is safe here
				pre_data.classList.toggle('hide')
			})
			// label: text varies depending on sync state
			const label_string = !is_sync
				? self.get_tool_label('files_info_is_unsync') || 'Files info data is unsync'
				: self.get_tool_label('show_data') || 'Show data'
			const label_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label',
				inner_html		: label_string,
				parent			: versions_container
			})
			// clicking the label delegates to the icon button so the toggle is shared
			label_node.addEventListener('click', (e)=> {
				button_icon_show_data.click(e)
			})

		// button_sync: triggers full media regeneration with optional file cleanup
			const button_sync = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'gear button_sync_data ' + (is_sync ? 'light' : 'warning'),
				title			: 'Sync data and re-create alternatives and thumb',
				inner_html		: (self.get_tool_label('regenerate') || 'Regenerate component'),
				parent			: versions_container
			})
			button_sync.addEventListener('click', function(e) {
				e.stopPropagation()

				// confirm dialog
				if ( !confirm( (get_label.sure || 'Sure?') ) ) {
					return false
				}

				self.node.content_data.classList.add('loading')

				self.sync_files()
				.then(async function(response){
					report_side_effects(self, response)
					if (action_succeeded(response)) {
						self.refresh({
							build_autoload	: false,
							destroy			: false
						})
					}else{
						self.node.content_data.classList.remove('loading')
						// ONE error model: the dispatcher decides the surface and the
						// renderer emits TEXT (server msg is untrusted, never alert/HTML)
						console.error('sync_files failed:', response.error)
						await handle_api_error(response.error, {wrapper: self.node.content_data})
					}
				})
			})

		// delete_normalized_files check box
			// When checked, the server will delete all derived images produced by the
			// upload process (original, modified, default generated) before regenerating,
			// keeping only the uploaded source file (e.g. .tiff, .psd).
			// label
			const delete_normalized_files_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'delete_normalized_files_label',
				inner_html		: self.get_tool_label('delete_normalized_files') || 'Delete normalized files',
				parent			: versions_container
			})

			// delete_normalized_files_checkbox
				const delete_normalized_files_checkbox = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox'
				})
				delete_normalized_files_label.prepend(delete_normalized_files_checkbox)
				delete_normalized_files_checkbox.addEventListener('change', function(e) {
					// set the delete option checked by the user into the global regenerate options object.
					self.regenerate_options.delete_normalized_files = delete_normalized_files_checkbox.checked
				})

		// pre_data: hidden JSON panel showing the raw DB vs disk file metadata for debugging
			const pre_data = ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'pre hide',
				text_content	: JSON.stringify({
					files_info_db				: files_info_db,
					files_info_disk				: files_info_disk,
					original_file_name			: original_file_name,
					original_normalized_name	: original_normalized_name
				}, null, 2),
				parent			: sync_data_wrapper
			})


	return sync_data_wrapper
}//end render_sync_data



/**
* RENDER_VERSIONS_GRID
* Builds the full quality × action CSS grid that is the core of the tool UI.
*
* Layout: a CSS grid with explicit column/row sizing set inline via style:
*  - Column 0   : row-label sidebar (action names).
*  - Columns 1…N: one column per quality level (original, 404, audio, thumb, …).
*  - Row 0      : quality-name header labels.
*  - Rows 1…M   : one row per entry in ar_rows (file preview, size, upload, …).
*
* 'thumb' is always appended to ar_quality when absent because thumbnails need
* their own management column even if not part of the component's normal quality list.
*
* ar_rows defines the ordered set of row renderers. Each entry is:
*  { renderer: {Function}(quality, self) → HTMLElement, label: {string} }
*
* Specific actions (e.g. rotate for component_image, conform_headers for component_av)
* are read from self.context.properties.specific_actions and mapped to handlers in
* the render_specific_actions object. Unknown action names are silently skipped with
* a console warning.
*
* The grid uses inline grid-column / grid-row placement on each cell to achieve a
* true two-dimensional layout without requiring CSS classes per cell.
*
* @param {Object} self - the tool_media_versions instance
* @returns {DocumentFragment} fragment containing the populated versions_container grid
*/
const render_versions_grid = function(self) {

	const fragment = new DocumentFragment()

	// quality versions
		const ar_quality = self.ar_quality
		if (!ar_quality || ar_quality.length<1) {
			console.log('Error. Invalid component ar_quality :', ar_quality);
			return fragment
		}

	// thumb: always ensure the thumb column exists, even if the caller's ar_quality omits it
		const thumb = ar_quality.find(el => el === 'thumb')
		if(!thumb){
			ar_quality.push('thumb')
		}

	// ar_rows: ordered list of row descriptors; each renderer receives (quality, self)
	const ar_rows = [
		{
			renderer	: render_file,
			label		: get_label.file || 'File'
		},
		// {renderer: render_file_extension,label: get_label.extension || 'Extension'},
		{
			renderer	: render_file_size,
			label		: get_label.size || 'Size'
		},
		// { renderer: , label: get_label.alternative_extensions || 'Alt. extensions' },
		{
			renderer	: render_file_upload,
			label		: get_label.upload || 'Upload'
		},
		{
			renderer	: render_file_versions,
			label		: get_label.versions || 'Versions'
		},
		{
			renderer	: render_file_delete,
			label		: get_label.delete || 'Delete'
		},
		{
			renderer	: render_build_version,
			label		: (get_label.build || 'Build') + ' ' + (get_label.version || 'version')
		}
	]

	// specific_actions: model-specific extra rows declared in tool properties.
		// Expected shape in context.properties:
		// {
		//   "specific_actions": {
		//     "rotate": [
		//       "component_image"
		//     ],
		//     "conform_headers": [
		//       "component_av"
		//     ]
		//   }
		// }
		// Each key maps to an array of model names for which the action should appear.
		const specific_actions = self.context.properties.specific_actions || {}
		// functions mapper: maps action name to the corresponding render_specific_actions handler
		for(const action_name in specific_actions) {

			const ar_models = specific_actions[action_name]
			if (ar_models.includes(self.main_element.model)) {

				// guard: only add rows for actions that have a defined renderer
					if(typeof render_specific_actions[action_name]!=='function') {
						console.warn("Ignored invalid function name:", action_name);
						continue;
					}

				ar_rows.push({
					renderer	: render_specific_actions[action_name],
					label		: get_label[action_name] || action_name
				})
			}
		}


	// versions_container: the CSS grid element; column/row sizing set inline
		const versions_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'versions_container',
			parent			: fragment
		})
		// first column is the label sidebar (minmax), then one equal column per quality
		Object.assign(
			versions_container.style,
			{
				'grid-template-columns': `minmax(6rem, 1fr) repeat(${ar_quality.length}, 1fr)`,
				'grid-template-rows': `repeat(${ar_rows.length + 1}, minmax(2rem, auto))`
			}
		)

	// line_labels: the leftmost column — "Quality" header + one row-name label per ar_row entry
		const colum_labels_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'column labels_container',
			parent			: versions_container
		})
			const quality_label = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'label',
				inner_html		: get_label.quality || 'Quality',
				parent			: colum_labels_container
			})

		Object.assign(
			quality_label.style,
			{
				'grid-column': `1`,
				'grid-row': `1`,
			}
		)

	// quality labels: one row-name label per action row, placed in column 1
		const ar_rows_length = ar_rows.length
		for (let i = 0; i < ar_rows_length; i++) {
			const current_row = ar_rows[i]

			const label = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'label',
				inner_html		: current_row.label,
				parent			: colum_labels_container
			})
			Object.assign(
				label.style,
				{
					'grid-column': `1`,
					// row 1 is the quality-name header; action rows start at row 2
					'grid-row': `${i+2}`
				}
			)
		}

	// contents by quality: for each quality level, build a full column of action cells
		const ar_quality_length = ar_quality.length
		for (let i = 0; i < ar_quality_length; i++) {

			const current_quality = ar_quality[i];

			const quality_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'column quality_container',
				parent			: versions_container
			})
			// quality label header cell: gets 'default' CSS class if this is the default quality
				const quality_label_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'file_info' + (current_quality===self.main_element.context.features.default_quality ? ' default' : ''),
					parent			: quality_container
				})

				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'label',
					inner_html		: current_quality,
					parent			: quality_label_node
				})
				Object.assign(
					quality_label_node.style,
					{
						'grid-column': `${i+2}`,
						'grid-row': `1`
					}
				)

			const ar_rows_length = ar_rows.length
			for (let j = 0; j < ar_rows_length; j++) {
				const current_row = ar_rows[j]
				const row_node = current_row.renderer(current_quality, self)

				quality_container.appendChild( row_node )
				// explicit grid placement: column i+2 (0 is sidebar), row j+2 (0 is header)
				Object.assign(
					row_node.style,
					{
						'grid-column': `${i+2}`,
						'grid-row': `${j+2}`
					}
				)
			}
		}//end for (let i = 0; i < ar_quality_length; i++)


	return fragment
}//end render_versions_grid



/**
* RENDER_FILE
* Renders the file-preview cell for a given quality level.
*
* When the file exists and has a path, renders a media icon button:
*  - For 'thumb': opens the thumbnail in a new window (thumbnails use a different
*    extension and are not renderable by the embedded media component).
*  - For other qualities: switches the main_element to the selected quality and
*    refreshes the inline preview in place.
* When the file exists but has no path, renders a dash placeholder.
* When the file does not exist (file_exist !== true), renders nothing.
*
* Source selection: thumb files live in files_info_disk (unfiltered) because
* they may have a different extension than the component's primary extension
* and would be excluded by the files_info_safe filter.
*
* (!) DEDALO_MEDIA_URL is a browser global injected by the PHP template; it is
* not in the /*global*\/ directive and will produce an eslint warning.
*
* @param {string} quality - quality level key (e.g. 'original', '404', 'thumb')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node for this quality's file preview cell
*/
const render_file = function(quality, self) {

	// info columns
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_file' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

		// file_info: thumb uses the unfiltered disk list; other qualities use the
		// extension-filtered safe list to avoid showing alternate-format entries here
		const files_info = ((quality==='thumb')
			? self.files_info_disk // thumb is not in files_info_safe (different extension case)
			: self.files_info_safe) || [] // fallback to empty array to keep render rock-solid
		const file_info = files_info.find(el => el.quality===quality)
		if (file_info && file_info.file_exist===true) {
			if (file_info.file_path) {
				const button_file_av = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button media',
					title			: self.get_tool_label('view') || 'View',
					parent			: file_info_node
				})
				button_file_av.addEventListener('click', async function(e) {
					e.stopPropagation()

					// thumb open a new window always (is not compatible with all media components view)
					if (quality==='thumb') {
						const file_url = DEDALO_MEDIA_URL + file_info.file_path
						open_window({
							url : file_url
						})
						return
					}

					self.node.classList.add('loading')
					// change main_element quality and refresh it
					self.main_element.quality = quality
					await self.main_element.refresh()
					self.node.classList.remove('loading')
				})
			}else{
				// const extension = file_info.file_path.split(".").pop();
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: '',
					inner_html		: `-`,
					parent			: file_info_node
				})
			}
		}//end if (file_info.file_path) {


	return file_info_node
}//end render_file



/**
* RENDER_FILE_EXTENSION
* (Dead code — commented out. Was intended to render the file extension string for
* a given quality cell. Disabled in favour of showing extensions inline inside the
* render_file_versions row. Do not remove without a deliberate cleanup decision.)
* @param {string} quality - quality level key
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node
*/
	// const render_file_extension = function(quality, self) {

	// 	// info columns
	// 		const file_info_node = ui.create_dom_element({
	// 			element_type	: 'div',
	// 			class_name		: 'file_info' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
	// 		})

	// 		// file_info
	// 		const file_info = (quality==='original' && self.file_info_normalized_name)
	// 			? self.file_info_normalized_name
	// 			: self.files_info_safe.find(el => el.quality===quality)

	// 		if (file_info && file_info.file_exist===true) {

	// 			const extension = file_info.file_path.split('.').pop();

	// 			// icon file
	// 			ui.create_dom_element({
	// 				element_type	: 'span',
	// 				class_name		: '',
	// 				inner_html		: extension,
	// 				parent			: file_info_node
	// 			})
	// 		}


	// 	return file_info_node
	// }//end render_file_extension



/**
* RENDER_FILE_SIZE
* Renders the file-size cell for a given quality level.
*
* Combines files_info_safe (primary-extension files) with files_info_alternative
* (alternate-extension variants) to find a size entry for the requested quality.
* The size is formatted via bytes_format for human readability (e.g. "13.3 MB").
* Renders nothing when the file does not exist on disk.
*
* @param {string} quality - quality level key (e.g. 'original', '404', 'thumb')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node containing the formatted size string
*/
const render_file_size = function(quality, self) {

	// merge safe and alternative lists to cover all possible formats for this quality
	const custom_files_info	= self.files_info_safe.concat(self.files_info_alternative)

	// file_info
	const file_info = custom_files_info.find(el => el.quality===quality)

	const file_info_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'file_info render_file_size' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
	})

	if (file_info && file_info.file_exist===true) {

		// size
		const size = bytes_format(file_info.file_size)

		// icon file
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: '',
			inner_html		: size,
			parent			: file_info_node
		})
	}


	return file_info_node
}//end render_file_size



/**
* RENDER_ALTERNATIVE_EXTENSIONS
* (Dead code — commented out. Was intended to render download buttons for each
* alternative-extension variant of a quality (e.g. .webm alongside .mp4).
* The feature is now partially served by render_file_versions which iterates all
* custom_files_info entries. Do not remove without a deliberate cleanup decision.)
* @param {string} quality - quality level key
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node
*/
	// const render_alternative_extensions = function(quality, self) {

	// 	// short vars
	// 		const value_files_info				= self.files_info_alternative
	// 		const alternative_extensions		= self.main_element.context.features.alternative_extensions
	// 		const alternative_extensions_length	= alternative_extensions.length

	// 	// file_info_node
	// 		const file_info_node = ui.create_dom_element({
	// 			element_type	: 'div',
	// 			class_name		: 'file_info' + (quality===self.main_element.context.features.default_quality ? ' default' : ''),
	// 		})

	// 	// info columns
	// 		for (let j = 0; j < alternative_extensions_length; j++) {

	// 			const alternative_extension = alternative_extensions[j]

	// 			// files_info
	// 			const file_info = value_files_info.find(el => el.quality===quality && el.extension===alternative_extension)
	// 			if (file_info) {

	// 					// cell_node
	// 						const cell_node = ui.create_dom_element({
	// 							element_type	: 'div',
	// 							class_name		: 'cell_node',
	// 							parent			: file_info_node
	// 						})

	// 					// button_download
	// 						const button_download = ui.create_dom_element({
	// 							element_type	: 'span',
	// 							class_name		: 'button download',
	// 							title			: get_label.download || 'Download',
	// 							parent			: cell_node
	// 						})
	// 						button_download.addEventListener('click', function(e) {
	// 							e.stopPropagation();
	// 							const file_url = DEDALO_MEDIA_URL + file_info.file_path
	// 							open_window({
	// 								url : file_url
	// 							})
	// 						})

	// 					// file_info_extension
	// 						ui.create_dom_element({
	// 							element_type	: 'span',
	// 							class_name		: 'file_info_extension',
	// 							inner_html		: file_info.extension,
	// 							parent			: cell_node
	// 						})
	// 			}
	// 		}


	// 	return file_info_node
	// }//end render_alternative_extensions



/**
* RENDER_FILE_UPLOAD
* Renders the upload action cell for a given quality level.
*
* 'thumb' quality has no upload button — thumbnails are always generated
* automatically by the server side, never uploaded directly.
*
* For other qualities, clicking the upload button opens tool_upload with the
* main_element as caller, and sets target_quality on the caller's context so
* the uploader knows which quality slot to fill.
*
* After tool_upload closes and the main_element re-renders, the one-shot
* event_manager subscription (stored in self.events_tokens for cleanup) fires
* to refresh the whole tool and show the newly uploaded file.
*
* @param {string} quality - quality level key (e.g. 'original', '404', 'thumb')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node containing the upload button (or empty for thumb)
*/
const render_file_upload = function(quality, self) {

	// info columns
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_file_upload' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

		// thumb cannot be manually uploaded; it is derived from the original
		if(quality==='thumb'){
			return file_info_node
		}

		const button_file_upload = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button upload',
			title			: get_label.upload || 'Upload',
			parent			: file_info_node
		})
		button_file_upload.addEventListener('click', function(e){
			e.stopPropagation()

			// open tool_upload
				// tool context minimum: only required fields for open_tool
					const tool_context = {
						model	: 'tool_upload',
						name	: 'tool_upload',
						mode	: 'edit'
					}

				const caller = self.main_element

				// update caller context quality so tool_upload targets the right quality slot
					caller.context.target_quality = quality

				// open_tool (tool_common)
					open_tool({
						tool_context	: tool_context,
						caller			: caller
					})

			// event on refresh caller: listen for the main_element render event (fired after upload),
			// then refresh the tool once; unsubscribe immediately to avoid repeat triggers
				let token
				const render_handler = () => {
					event_manager.unsubscribe(token)
					self.main_element_quality = quality
					// destroy:false — a destroying refresh nulls main_element.context and
					// the grid re-render throws on its first line (see render_build_version).
					self.refresh({
						build_autoload	: false,
						destroy			: false
					})
				}
				token = event_manager.subscribe('render_'+self.main_element.id, render_handler)
				// store token so tool destroy can clean up if the user closes before uploading
				self.events_tokens.push(token)
		})


	return file_info_node
}//end render_file_upload



/**
* RENDER_FILE_VERSIONS
* Renders the versions cell for a given quality, listing every physical file variant
* (primary extension + alternative extensions) as a row of action buttons:
*   Open (find icon) | Download | Extension label | Delete
*
* The deduplication step is necessary because files_info_safe and files_info_alternative
* can overlap when the same path appears in both arrays — the composite key
* 'quality_extension' ensures each unique (quality, extension) pair appears once.
*
* The "Open" button appends a cache-busting timestamp query parameter so the browser
* does not serve a stale cached version of the file.
*
* The "Download" button uses download_file() (which triggers a forced-download response)
* rather than open_window(), so the browser saves the file instead of trying to render it.
*
* (!) This function reads self.caller.context.features.default_quality to mark the default
* column, whereas most other renderers use self.main_element.context.features.default_quality.
* These may refer to the same context or to different ones depending on tool setup — verify
* if visual inconsistencies appear in the 'default' highlight.
*
* (!) DEDALO_MEDIA_URL is a browser global; it is not in the /*global*\/ directive.
*
* @param {string} quality - quality level key (e.g. 'original', '404', 'audio')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node containing one cell_node per existing file variant
*/
const render_file_versions = function(quality, self) {

	// custom_files_info: combine primary-extension and alternative-extension disk entries
		const raw_custom_files_info	= self.files_info_safe.concat(self.files_info_alternative)
		// deduplicate by composite key 'quality_extension' — same file might appear in both arrays
		const object_files_info = {}
		const raw_custom_files_info_length = raw_custom_files_info.length
		for (let i = 0; i < raw_custom_files_info_length; i++) {
			const el = raw_custom_files_info[i]
			object_files_info[el.quality +'_'+ el.extension] = el
		}
		const custom_files_info = Object.values(object_files_info)

	// file_info_node
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			// (!) uses self.caller.context, not self.main_element.context — see doc-block note above
			class_name		: 'file_info render_file_versions' + (quality===self.caller.context.features.default_quality ? ' default' : '')
		})

	// iterate files_info: render one cell_node per existing (quality, extension) pair
		const files_info		= custom_files_info.filter(el => el.quality===quality)
		const files_info_length	= files_info.length
		for (let k = 0; k < files_info_length; k++) {

			const file_info = files_info[k]

			// check file_exists
				if (!file_info || file_info.file_exist!==true) {
					continue;
				}

			// size: human-readable string for the download button tooltip
				const size = bytes_format(file_info.file_size)

			// extension: extracted from file_path as the last dot-separated segment
				const extension	= file_info && file_info.file_path
					? file_info.file_path.split('.').pop()
					: null;

			// file_url
				const file_url = DEDALO_MEDIA_URL + file_info.file_path

			// cell_node: one per (quality, extension) pair
				const cell_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'cell_node',
					parent			: file_info_node
				})

			// button_link: opens the file in a new window; timestamp prevents browser caching
				const button_link = ui.create_dom_element({
					element_type	: 'a',
					class_name		: 'button find',
					title			: (get_label.open || 'Open') + ' ' + file_url,
					parent			: cell_node
				})
				button_link.addEventListener('click', function(e) {
					e.stopPropagation()

					open_window({
						url : file_url + '?t=' + (new Date()).getTime()
					})
				})

			// button_file_download: triggers a forced file download (not browser rendering)
				const button_file_download = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button download',
					title			: (get_label.download || 'Download') + ' ' + size,
					parent			: cell_node
				})
				button_file_download.addEventListener('click', function(e){
					e.stopPropagation()

					const url		= DEDALO_MEDIA_URL + file_info.file_path
					// prefix file_name with quality to avoid collision when downloading
					// multiple versions of the same media
					const file_name	= `dedalo_download_${quality}_` + url.substring(url.lastIndexOf('/')+1);

					download_file({
						url			: url,
						file_name	: file_name
					})
				})

			// file_info_extension: label badge showing the extension (e.g. 'mp4', 'webm')
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button file_info_extension',
					title			: get_label.extension || 'Extension',
					text_content	: extension,
					parent			: cell_node
				})

			// button_file_delete: deletes this specific (quality, extension) file version
				const button_file_delete = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button delete',
					title			: get_label.delete || 'Delete',
					parent			: cell_node
				})
				button_file_delete.addEventListener('click', function(e){
					e.stopPropagation()

					if (!confirm(get_label.sure + '\n\nFile: '+file_info.file_name)) {
						return false
					}

					self.node.content_data.classList.add('loading')

					self.delete_version(quality, extension)
					.then(async function(response){
						report_side_effects(self, response)
						if (action_succeeded(response)) {
							// destroy:false — see the note in render_build_version: a
							// destroying refresh nulls main_element.context and the
							// re-render throws before it can repaint.
							self.refresh({
								build_autoload	: false,
								destroy			: false
							})
						}else{
							self.node.content_data.classList.remove('loading')
							console.error('delete_version failed:', response.error)
							await handle_api_error(response.error, {wrapper: self.node.content_data})
						}
					})
				})
		}//end for (let k = 0; k < files_info_length; k++)


	return file_info_node
}//end render_file_versions



/**
* RENDER_FILE_DELETE
* Renders the delete-quality cell for a given quality level.
*
* This deletes the entire quality slot (all files for that quality), unlike
* render_file_versions' per-extension delete which removes a single file variant.
*
* Combines files_info_safe with files_info_original (not files_info_alternative)
* so that 'original' quality entries are reachable even though they are excluded
* from files_info_safe (which uses the component's primary extension filter).
*
* The confirmation dialog is handled inside self.delete_quality (in tool_media_versions.js),
* so no extra confirm() call is needed here.
*
* (!) This function reads self.caller.context.features.default_quality (same pattern as
* render_file_versions), while most other renderers use self.main_element.context.
*
* @param {string} quality - quality level key (e.g. 'original', '404', 'thumb')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node containing the delete button (or empty if file absent)
*/
const render_file_delete = function(quality, self) {

	// custom_files_info: the primary-extension entries, plus the 'original' ones,
	// PLUS the thumb — which belongs to no model's primary extension but one.
	//
	// The thumb is always a jpg while `files_info_safe` is filtered to the
	// component's own extension, so this cell rendered a Delete button for
	// component_image and an EMPTY CELL for av, pdf, svg and 3d: the same action,
	// present on one model and invisible on four, with nothing on screen to explain
	// the difference (the file was still deletable, but only through the per-file
	// row below). A quality is deletable or it is not; that cannot depend on which
	// media type the operator happens to be looking at.
		const thumb_entries = (self.files_info_alternative || []).filter(
			(el) => el.quality===THUMB_QUALITY
		)
		const custom_files_info = self.files_info_safe
			.concat(self.files_info_original)
			.concat(thumb_entries)

	// info columns
	const file_info_node = ui.create_dom_element({
		element_type	: 'div',
		// (!) uses self.caller.context, not self.main_element.context — see doc-block note above
		class_name		: 'file_info render_file_delete' + (quality===self.caller.context.features.default_quality ? ' default' : '')
	})

	// file_info
		const file_info = custom_files_info.find(el => el.quality===quality)
		// const file_info = (quality==='original' && self.file_info_normalized_name)
		// 	? self.file_info_normalized_name
		// 	: custom_files_info.find(el => el.quality===quality)

		if (file_info && file_info.file_exist===true) {

			const button_file_delete = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button delete',
				parent			: file_info_node
			})
			button_file_delete.addEventListener('click', async function(){
				self.node.classList.add('loading')
				// exec delete_quality: confirmation is handled inside self.delete_quality
				const response = await self.delete_quality(quality)
				// The full response now (see tool_media_versions.js delete_quality):
				// a successful delete can still have taken companion files with it.
				report_side_effects(self, response)
				if (action_succeeded(response)) {
					// self.main_element_quality = quality
					self.refresh({
						build_autoload	: false,
						destroy			: false
					})
				}
				self.node.classList.remove('loading')
			})
		}


	return file_info_node
}//end render_file_delete



/**
* RENDER_BUILD_VERSION
* Renders the "Build version" action cell for a given quality level.
*
* Clicking triggers self.build_version(quality) on the server, which derives a
* new quality-encoded file from the 'original'. The button is removed on success
* and replaced with a blinking "Processing" label while the background job runs.
*
* Two post-build strategies, based on component model:
*
*  component_av (except thumb):
*    AV transcoding is asynchronous and may take minutes, so the panel FOLLOWS
*    THE JOB the server minted (response.job_id) via self.get_job_status(), and
*    only when that job is terminal does it confirm the file on disk with
*    self.get_files_info(). Watching the filesystem alone cannot tell "still
*    encoding" from "the job failed" — which is why a dead transcode used to
*    blink "Processing" forever. Terminal-with-errors, a job that vanished
*    (server restart), a job that finished without writing the requested tier,
*    and the overall wait cap all end the wait with a READABLE reason and put
*    the gear back so the operator can retry. self.timer holds the pending
*    setTimeout so destroy() can clear it.
*
*  component_3d thumb:
*    THE 3D THUMB IS NOT BUILT ON THE SERVER AT ALL — it is a resize of the
*    record's posterframe, and a posterframe of a mesh can only be produced by
*    something that can RENDER a mesh. This engine cannot: there is no server-side
*    3D renderer, and handing the .glb to the raster thumbnailer is what made this
*    very gear answer `identify: no decode delegate for this image format`. So the
*    click captures the live Three.js scene as a JPEG and uploads it exactly like
*    the edit form does after an upload (component_3d.create_posterframe →
*    service_upload → dd_component_3d_api::move_file_to_dir), and the server
*    derives the thumb from the posterframe it just bound. See
*    create_3d_posterframe for the viewer-less fallback.
*
*  All other models (images, etc.):
*    Processing is fast enough that a single dd_request_idle_callback refresh
*    after the build call is sufficient.
*
* 'original' quality is excluded: you cannot build the original from itself.
*
* @param {string} quality - quality level key (e.g. '404', 'audio', 'thumb')
* @param {Object} self - the tool_media_versions instance
* @returns {HTMLElement} file_info_node containing the build button (empty for 'original')
*/

/** The thumb tier's name (DEDALO_QUALITY_THUMB's canonical value). */
const THUMB_QUALITY = 'thumb'




/**
* ACTION_SUCCEEDED
* Did the action really run?
*
* Envelope v2 answers with `ok:true` — the ONE test, for a server answer and for
* the shapes this client synthesises alike (`create_3d_posterframe` returns the
* same `{ok}` discriminator, so there is no second convention to honour).
*
* @param {Object|false} response - an API envelope (or a client-made one)
* @returns {boolean}
*/
const action_succeeded = (response) => {

	if (!response || request_failed(response)) {
		return false
	}

	return response.ok===true
}//end action_succeeded



/**
* REPORT_SIDE_EFFECTS
* Put the server's own account of a SUCCESSFUL action in front of the operator.
*
* WHAT THIS FIXES. The engine composes careful sentences for the things an
* operator cannot see and did not ask for — "the accompanying alternate
* version(s) went with it (moved to the deleted folder, recoverable)", "the
* derived tiers could NOT be rebuilt from the remaining master", "not every
* configured format could be written", "N file(s) could NOT be rebuilt" — and
* attaches them to a `result:true` response, because the action itself DID
* happen. This panel then read `result` alone and threw the rest away: one click
* could remove files the operator never named, or leave a tier stale, and the only
* record of it was the server log. The sentences existed; nobody ever saw them.
*
* It is a dismissible banner, not a blocking dialog: the action succeeded, so it
* must not block the refresh that follows. Real FAILURES go the other way — they
* are ApiErrors and the dispatcher (handle_api_error) owns their surface.
*
* @param {Object} self - the tool_media_versions instance
* @param {Object} response - the raw API response
* @returns {boolean} true when something was reported
*/
const report_side_effects = function(self, response) {

	// ENVELOPE v2. The account lives in the PAYLOAD — there is no prose `msg` on a
	// success any more, and `result` is now the compat MIRROR of `data` (an object,
	// so the old `result!==true` test rejected every successful action and this
	// whole report went silent). `response_data` is the ONE accessor: `data`, then
	// the mirror while it lasts, `false` on a failure envelope.
	if (!response || request_failed(response)) {
		return false
	}
	const data = response_data(response)
	if (!data || typeof data!=='object') {
		return false
	}

	// The TRIGGER is structured data (errors / retired), never a string match on
	// the sentence — wording that changes must not silently stop being shown.
	// Both lists are payload keys of every mutating action of this tool
	// (tools/tool_media_versions/server/media_versions.ts:385-396, :423-434).
	const reported		= data.errors
	const error_entries	= Array.isArray(reported) ? reported : []
	const retired		= Array.isArray(data.retired) ? data.retired : []
	if (error_entries.length===0 && retired.length===0) {
		return false
	}

	// `data.summary` ALREADY composes the whole account — withRebuildFailure
	// (media_versions.ts:338-343) appends the errors and withRetiredTwins the
	// retired twins to the sentence — so the entries are printed once, as the
	// summary, and only fall back to a per-item list when the server sent none.
	// A coded entry resolves through the ONE renderer, a bare string prints as-is.
	const item_line	= (entry) => typeof entry==='string' ? entry : error_text(entry)
	const summary	= (typeof data.summary==='string' && data.summary.length>0)
		? data.summary
		: null
	const wrapper	= self.node?.content_data || self.node
	const severity	= error_entries.length>0 ? 'error' : 'warning'
	if (wrapper) {
		if (summary!==null) {
			// ui.show_message writes the text through `text_content` — never a sink
			ui.show_message(wrapper, summary, severity)
		}else{
			// no sentence: each item on its own line, through the ONE renderer
			for (const entry of [...error_entries, ...retired]) {
				render_error_inline(wrapper, entry)
			}
		}
	}else{
		// no node to host the banner — the ONE renderer's toast surface, text-only
		render_error_toast({
			message		: summary ?? [...error_entries, ...retired].map(item_line).join('; '),
			severity	: severity
		})
	}


	return true
}//end report_side_effects


/**
* CREATE_3D_POSTERFRAME
* The 3D half of the "build thumb" cell: capture the record's posterframe from
* the live 3D scene and let the server derive the thumb from it.
*
* WHY THE CLIENT DOES THE WORK. For component_3d the thumb tier is a resize of the
* record's posterframe (DEDALO_QUALITY_THUMB: "3d | Will render the posterframe"),
* and the posterframe is a picture of a RENDERED mesh. This engine has no mesh
* renderer — the only thing in the whole stack that can draw the model is the
* browser's WebGL canvas — so the file cannot be produced server-side at all. That
* is why this panel's gear had nothing to call and why routing it to the generic
* image builder made the server hand a .glb to ImageMagick, which answered
* `no decode delegate for this image format`.
*
* It reuses the component's OWN method (component_3d.prototype.create_posterframe,
* the same one the edit form fires after an upload): viewer.get_image() → upload to
* the staging tree via service_upload → dd_component_3d_api::move_file_to_dir with
* target_dir 'posterframe'. The server binds the snapshot and rebuilds the thumb
* from it in the same call, so nothing here needs a second request.
*
* FALLBACK, and it is a real case: with no viewer on this box (WebGL unavailable,
* a preview that never mounted, a model that failed to load) the panel still asks
* the SERVER to build the thumb — which succeeds whenever a posterframe already
* exists on disk, and otherwise fails with the engine's own message naming what is
* missing. Losing the ability to rebuild a thumb from an existing posterframe just
* because the scene will not draw would be the worse failure.
*
* @param {Object} self - the tool_media_versions instance
* @returns {Promise<Object>} `{result:boolean, msg:string}` — the shape the click
*   handler reads (same contract as self.build_version's response)
*/
const create_3d_posterframe = async function(self) {

	const main_element = self.main_element

	// viewer: resolved BEFORE the confirmation, because which of the two paths runs
	// decides who asks for it (self.build_version confirms on its own, and asking
	// twice for one click is worse than asking late).
		// The WAIT lives on the component (component_3d.ensure_viewer), so this panel
		// and tool_posterframe cannot disagree about whether to wait for the scene.
		const viewer = (typeof main_element.ensure_viewer === 'function')
			? await main_element.ensure_viewer()
			: null

	// fallback: no viewer here — let the server rebuild the thumb from the
	// posterframe already on disk (and report its own refusal when there is none)
		if (!viewer) {
			if(SHOW_DEBUG===true) {
				console.log('3d posterframe: no viewer available, falling back to server build_version');
			}
			return await self.build_version(THUMB_QUALITY)
		}

	// confirm: the capture OVERWRITES the current posterframe (and the thumb derived
	// from it) with the camera angle on screen right now — the same confirmation
	// every other mutating gear in this panel asks for.
		if ( !confirm( (get_label.sure || 'Sure?') ) ) {
			// the user cancelled: the same `{ok}` discriminator every answer carries,
			// with no ApiError behind it (nothing failed)
			return { ok : false }
		}

	// capture path: the component's own posterframe method, driven by the live viewer
		const created = await main_element.create_posterframe(viewer)
		if (created===true) {
			return { ok : true }
		}

	// A refusal THIS function produced has no server round-trip behind it — there is
	// no ApiError to dispatch, so it is reported here as a client-side failure.
	// Server refusals travel the other path (self.build_version → handle_api_error).
		const msg = 'The 3D scene could not be captured or uploaded. Check the browser console.'
		alert('Error: ' + msg)


	return { ok : false }
}//end create_3d_posterframe



/** Poll cadence of the AV build watcher, ms. */
/**
* LIVE_JOB_FOR_QUALITY
* The running job for one tier, from the server's record-scoped answer.
*
* The panel renders THIS rather than click-local state, which is the whole point:
* before, "Processing" existed only inside the click handler that started a build,
* so a transcode started by tool_upload seconds earlier — or by a colleague — was
* invisible, and its tier looked exactly like one that had never been built.
*
* @param {Object} self
* @param {string} quality
* @returns {Object|null} the activity row, or null when nothing is running
*/
const live_job_for_quality = function(self, quality) {

	const jobs = self.record_jobs
	if (!Array.isArray(jobs)) {
		return null
	}
	return jobs.find(job =>
		job
		&& job.record
		&& job.record.component_tipo===self.main_element.tipo
		// The job's OWN tier, or any companion tier it also writes: the ingest
		// transcode produces the default quality AND the audio tier in one job,
		// and the server refuses a build of either. Matching only `label` would
		// leave the audio column showing an idle gear whose click is guaranteed
		// to be refused — the panel contradicting the server.
		&& (job.label===quality || (job.also_qualities || []).includes(quality))
		&& (job.status==='running' || job.status==='queued')
	) || null
}//end live_job_for_quality



/**
* RENDER_JOB_PROGRESS
* The busy readout for one tier: a label, a bar, and the elapsed time.
*
* Determinate ONLY when the server reported a percentage. A tier whose source
* declares no duration yields progress null, and an indeterminate bar is the
* honest rendering — a made-up number is the frozen-70% lie in a new costume.
*
* @param {Object} job - activity row {label, progress, started_at, owner_name}
* @param {HTMLElement} parent
* @returns {Object} {node, update(frame_progress)}
*/
const render_job_progress = function(job, parent) {

	const wrapper = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'job_progress',
		parent			: parent
	})

	const label = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'job_progress_label blink',
		inner_html		: get_label.processing || 'Processing',
		parent			: wrapper
	})

	const bar_track = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'job_progress_track',
		parent			: wrapper
	})
	const bar_fill = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'job_progress_fill',
		parent			: bar_track
	})

	const elapsed_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'job_progress_elapsed',
		parent			: wrapper
	})

	// WHOSE work this is, but only when it is not the reader's own. An operator
	// looking at a tier someone else is building needs to know that before they
	// go hunting for why their gear is disabled.
	if (job.owner_name) {
		const owner_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'job_progress_owner',
			parent			: wrapper
		})
		// textContent: owner_name is ANOTHER USER'S self-editable display name
		// (dd132). Through innerHTML it is stored cross-user XSS.
		owner_node.textContent = String(job.owner_name)
	}

	const apply = function(progress) {
		if (typeof progress==='number' && isFinite(progress)) {
			bar_track.classList.remove('indeterminate')
			bar_fill.style.width = `${Math.max(0, Math.min(100, progress))}%`
			label.textContent = `${(get_label.processing || 'Processing')} ${Math.round(progress)}%`
		}else{
			// No percentage is knowable — say "working", not a number.
			bar_track.classList.add('indeterminate')
			bar_fill.style.width = '100%'
			label.innerHTML = get_label.processing || 'Processing'
		}
		elapsed_node.innerHTML = format_elapsed(job.started_at)
	}
	apply(job.progress)

	// The elapsed readout ticks on its own: SSE frames arrive on state CHANGES,
	// and a long encode legitimately reports nothing for a while. A frozen clock
	// during that silence reads as a dead job.
	const ticker = setInterval(() => {
		elapsed_node.innerHTML = format_elapsed(job.started_at)
	}, 1000)

	return {
		node	: wrapper,
		update	: apply,
		stop	: () => clearInterval(ticker)
	}
}//end render_job_progress



// The 2 s poll ladder and its one-hour cap are GONE (2026-08-12): the panel now
// follows a job over dd_utils_api::get_job_events, which pushes a frame on every
// transition and ends on the terminal one. The cap existed because a poller that
// never hears anything cannot tell "still encoding" from "the server died"; a
// stream that closes without a terminal frame answers that directly.
const render_build_version = function(quality, self) {

	// file_info_node
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_build_version' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

	// exclude original quality: nothing to "build" — original is the source, not a derivative
		if (quality==='original') {
			return file_info_node
		}

	// ALREADY BUILDING? The server's record-scoped answer decides, so a tier being
	// transcoded by an upload — or by another operator — renders as busy the
	// moment this panel opens, instead of as an empty cell offering a gear.
	//
	// The gear is NOT rendered at all in that state: the server refuses a second
	// build for a live target (AvBuildRefused), and offering a click that is
	// guaranteed to be refused is how the duplicate-encode race read as normal use.
		const running_job = live_job_for_quality(self, quality)
		if (running_job) {

			const progress_ui = render_job_progress(running_job, file_info_node)

			// Follow it to the end, then re-render the grid against the finished
			// files — the panel that DISCOVERED a job gets the same completion
			// behaviour as the one that started it.
			//
			// Through the INSTANCE GROUP, never follow_job directly: this stream
			// outlives the panel unless the panel owns it (tool_media_versions.js
			// job_followers).
			self.job_followers.follow(running_job.job_id, {
				on_frame : function(frame) {
					if (frame && typeof frame.progress==='number') {
						progress_ui.update(frame.progress)
					}
				},
				on_done : function(frame) {
					progress_ui.stop()
					const reported	= frame && frame.errors
					const errors	= Array.isArray(reported) ? reported : []
					if (errors.length>0) {
						// A failed tier stays readable with its reason. Reverting it to a
						// blank cell is the "never built" lie this whole path removes.
						progress_ui.node.remove()
						const err_node = ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'build_error',
							parent			: file_info_node
						})
						// Server error text carries paths and tool output; textContent.
						err_node.textContent = (get_label.error || 'Error') + ': ' + errors.join('; ')
						return
					}
					self.refresh({
						build_autoload	: false,
						destroy			: false
					})
				}
			})

			return file_info_node
		}

	// is_3d_posterframe: this cell CAPTURES the posterframe instead of asking the
	// server to build a version — see the doc-block and create_3d_posterframe.
		const is_3d_posterframe = self.main_element.model==='component_3d' && quality===THUMB_QUALITY

	// button_build_version
		const button_build_version = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button gear',
			title			: is_3d_posterframe
				? (self.get_tool_label('create_posterframe') || 'Create posterframe from the 3D scene')
				: (get_label.build || 'Build') + ` ${quality} ` + (get_label.version || 'version'),
			parent			: file_info_node
		})
		const fn_click = async function (e) {
			e.stopPropagation()

			self.node.classList.add('loading')

			// exec build_version: the server accepted the job when result===true,
			// and for AV it hands back the job_id of the transcode it started.
			// The 3D thumb goes the other way round — the browser produces the file
			// and the server derives the thumb from it (create_3d_posterframe).
			const response	= is_3d_posterframe
				? await create_3d_posterframe(self)
				: await self.build_version(quality)
			const accepted	= action_succeeded(response)
			// A build that SUCCEEDED can still have failed to write a configured
			// format (the twin channel) — the server says so, and this is where the
			// operator hears it.
			report_side_effects(self, response)
			// A REFUSED build must be readable. report_side_effects deliberately
			// answers only for result===true, so before this a rejection was
			// completely silent — the gear simply did nothing and the operator had
			// no way to learn why. That path is now reachable on purpose: the server
			// refuses a tier that is already being built (AvBuildRefused), and a
			// refusal nobody can see is the same defect as a job that dies quietly.
			if (!accepted) {
				const wrapper = self.node?.content_data || self.node
				if (request_failed(response)) {
					// a real server refusal: ONE error model, ONE renderer (text-only)
					console.error('build_version refused:', response.error)
					await handle_api_error(response.error, {wrapper: wrapper})
				}else{
					// a refusal THIS client synthesised (create_3d_posterframe) — no
					// envelope behind it, so there is no ApiError to dispatch
					const reason = 'the server refused this build'
					if (wrapper) {
						ui.show_message(wrapper, reason, 'warning')
					}else{
						render_error_toast({message: reason, severity: 'warning'})
					}
				}
				// The panel's view of what is running is now stale — the refusal
				// usually MEANS someone else's job holds this tier. Re-render so the
				// cell shows that job instead of the gear that was just refused.
				self.refresh({
					build_autoload	: false,
					destroy			: false
				})
			}
			if (accepted) {

				// Replace the button with the SAME busy readout a discovered job
				// renders (render_job_progress), so a build looks identical whether
				// this browser started it or the panel found it already running.
				button_build_version.remove()

				const progress_ui = render_job_progress(
					{
						label		: quality,
						progress	: null,
						started_at	: Date.now()
					},
					file_info_node
				)

				// give_up: end the wait honestly — say WHY, and put the gear back so
				// the operator can act. Never leave the label blinking on a build
				// that is not happening.
				const give_up = function(reason) {
					if (self.timer) {
						clearTimeout(self.timer)
						self.timer = null
					}
					progress_ui.stop()
					progress_ui.node.remove()
					file_info_node.appendChild(button_build_version)
					const reason_node = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'build_error',
						parent			: file_info_node
					})
					reason_node.textContent = (get_label.error || 'Error') + ': ' + reason
				}

				// done: the file is really there — re-render against it.
				const done = async function() {
					if (self.timer) {
						clearTimeout(self.timer)
						self.timer = null
					}
					progress_ui.stop()
					self.main_element_quality = quality

					// NO force_save here. PHP needed one: its build ran outside the
					// component, so someone had to trigger the save pipeline to get the
					// new files_info into the record. The TS engine persists it on the
					// build path itself — the av transcode job writes files_info back
					// when it finishes, and the synchronous types write it back in the
					// build_version handler. The call was also a guaranteed 500:
					// 'force_save' is not an implemented save action (save_component.ts
					// refuses unknown actions loudly), so this line failed the whole
					// completion step and left the cell blinking on a build that HAD
					// succeeded. A component with no stored files_info at all is the
					// one case still needing a write — that is what Regenerate
					// (sync_files) is for, and the unsync bar says so.
					//
					// destroy:false is load-bearing (the pattern sync_files already
					// uses): the default refresh destroys DEPENDENCIES, which nulls
					// main_element.context — and the first thing this grid re-reads is
					// main_element.context.features.default_quality, so the re-render
					// died on a TypeError and the cell kept blinking on a build that
					// had finished. build(false) re-scans get_files_info regardless of
					// autoload, so the grid is still fresh.
					self.refresh({
						build_autoload	: false,
						destroy			: false
					})
				}

				if (self.main_element.model === 'component_av' && quality !== THUMB_QUALITY) {

					const job_id	= response.job_id || null

					// THE FILE CHECK. A quality counts as built only when the scan
					// reports the entry present AND non-empty: a zero-byte file is a
					// failed encode, not a version (the encoder writes to a temp name
					// and renames, so a partial file should never be visible — this is
					// the belt to that braces).
					const file_is_ready = async function() {
						const files_info	= await self.get_files_info()
						const found			= files_info.find(el => el.quality===quality)
						return !!(found && found.file_exist===true && (found.file_size===null || found.file_size>0))
					}

					// PUSH, not poll. The job runs in the server process, so every
					// transition is pushed as it happens and the stream ENDS on the
					// terminal frame. The old setTimeout ladder (2 s, capped at an hour)
					// is gone with its cap: a frame arrives when there is news, and a
					// stream that closes without a terminal frame is itself the answer.
					if (job_id===null) {
						// A server that accepted the build without minting a job: nothing
						// to follow. Check the disk once and report honestly either way.
						if (await file_is_ready()) {
							done()
						}else{
							give_up('the server accepted the build but returned no job to follow')
						}
					}else{
						// Through the instance group — a build started here and then
						// abandoned (the operator closes the panel while it encodes) must
						// give its connection back. See tool_media_versions.js job_followers.
						self.job_followers.follow(job_id, {
							on_frame : function(frame) {
								if (frame && typeof frame.progress==='number') {
									progress_ui.update(frame.progress)
								}
							},
							on_done : async function(frame) {
								progress_ui.stop()

								// No terminal frame: the stream died with the server. In-process
								// jobs do not survive that, so this is "not running any more",
								// never "still working" — but the file may have landed before
								// the restart, so ask the disk before calling it a failure.
								if (!frame) {
									if (await file_is_ready()) {
										return done()
									}
									return give_up('job lost (the server restarted while it ran)')
								}

								// Errors win over everything else.
								const reported	= frame.errors
								const errors	= Array.isArray(reported) ? reported : []
								if (errors.length>0) {
									return give_up(errors.join('; '))
								}
								// Terminal and clean, but the tier is not on disk: the job did
								// something other than what was asked. Say so instead of waiting.
								if (!(await file_is_ready())) {
									return give_up(quality + ' not built')
								}
								return done()
							}
						})
					}
				}else{
					// non-AV builds complete synchronously; refresh on the next idle frame
					dd_request_idle_callback(
						() => {
							self.refresh({
								build_autoload	: false,
								destroy			: false
							})
						}
					)
				}
			}
			self.node.classList.remove('loading')
		}
		button_build_version.addEventListener('click', fn_click)


	return file_info_node
}//end render_build_version



/**
* RENDER_SPECIFIC_ACTIONS
* Namespace object holding model-specific row renderers that are dynamically
* inserted into the versions grid based on tool context.properties.specific_actions.
*
* Each method has the same signature as other row renderers:
*   (quality: string, self: tool_media_versions) → HTMLElement
*
* Action names must match exactly between context.properties and this object's keys.
* render_versions_grid guards against unknown names with typeof check + console.warn.
*
* Current actions:
*  - conform_headers : component_av only — re-writes container headers of a derived file
*  - rotate          : component_image only — destructive in-place image rotation
*
* To add a new model-specific action:
*  1. Implement it as a method here.
*  2. Add an entry to specific_actions in the tool's register.json / tool properties.
*  3. Implement the matching server-side method in class.tool_media_versions.php.
*/
const render_specific_actions = {

	/**
	* CONFORM_HEADERS
	* Renders the "conform headers" action cell for component_av files.
	*
	* Conform-headers rewrites the container metadata (e.g. moov atom placement)
	* of an existing derived AV file without re-transcoding. Useful when a file was
	* transcoded externally and has a non-standard header layout that causes streaming
	* issues. Skipped for 'original' quality since the raw upload should not be modified.
	*
	* @param {string} quality - quality level key (e.g. '404', 'audio'); 'original' is skipped
	* @param {Object} self - the tool_media_versions instance
	* @returns {HTMLElement} file_info_node with conform button, or empty node if not applicable
	*/
	conform_headers(quality, self) {

		// info columns
		// file_info_node
			const file_info_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'file_info conform_headers' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
			})


		// file_info
		const file_info = self.files_info_safe.find(el => el.quality===quality)

		// only show the button when the file exists and quality is not 'original'
		if (file_info && quality!=='original' && file_info.file_exist===true) {

			const button_conform_headers = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button repair',
				title			: (get_label.conform_headers || 'Conform headers'),
				parent			: file_info_node
			})
			button_conform_headers.addEventListener('click', async function(){
				self.node.classList.add('loading')
				// exec conform_headers. The method resolves the WHOLE envelope now:
				// the payload is `{summary, errors, files_info}`, never the bare
				// `true` this branch used to compare against — which is why the
				// panel stopped repainting after a remux.
				const response = await self.conform_headers(quality)
				report_side_effects(self, response)
				if (action_succeeded(response)) {
					self.main_element_quality = quality
					// destroy:false — see render_build_version.
					self.refresh({
						build_autoload	: false,
						destroy			: false
					})
				}
				self.node.classList.remove('loading')
			})
		}


		return file_info_node
	},//end conform_headers

	/**
	* ROTATE
	* Renders left/right rotation buttons for component_image files.
	*
	* Rotation is destructive — it overwrites the existing file on disk. The
	* button titles explicitly label the action as "(destructive)" to warn users.
	* Degrees: -90 for left (counter-clockwise), +90 for right (clockwise).
	*
	* After a successful rotate, only the main_element is refreshed (not the full
	* tool) because only the visual preview needs to update — file metadata does
	* not change.
	*
	* @param {string} quality - quality level key (e.g. 'original', '404', 'thumb')
	* @param {Object} self - the tool_media_versions instance
	* @returns {HTMLElement} file_info_node with rotate-left and rotate-right buttons
	*/
	rotate(quality, self) {

		// info columns
			const file_info_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'file_info rotate' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
			})

		// file_info
			const file_info = self.files_info_safe.find(el => el.quality===quality)
			if (file_info && file_info.file_exist===true) {

				// button_rotate_left: counter-clockwise (-90 degrees)
					const button_rotate_left = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button rotate',
						title			: (get_label.rotate || 'Rotate') +' '+ (get_label.left || 'left') +' ('+ (get_label.destructive || 'destructive')+')',
						parent			: file_info_node
					})
					button_rotate_left.addEventListener('click', async function(e){
						e.stopPropagation()

						self.node.classList.add('loading')
						// exec rotate (see the conform_headers note: the whole envelope)
						const response = await self.rotate(quality, -90)
						report_side_effects(self, response)
						if (action_succeeded(response)) {
							self.main_element.quality = quality
							self.main_element.refresh()
						}
						self.node.classList.remove('loading')
					})

				// button_rotate_right: clockwise (+90 degrees)
					const button_rotate_right = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button rotate right',
						title			: (get_label.rotate || 'Rotate') +' '+ (get_label.right || 'right') +' ('+ (get_label.destructive || 'destructive')+')',
						parent			: file_info_node
					})
					button_rotate_right.addEventListener('click', async function(e){
						e.stopPropagation()

						self.node.classList.add('loading')
						// exec rotate (see the conform_headers note: the whole envelope)
						const response = await self.rotate(quality, 90)
						report_side_effects(self, response)
						if (action_succeeded(response)) {
							self.main_element.quality = quality
							self.main_element.refresh()
						}
						self.node.classList.remove('loading')
					})
			}


		return file_info_node
	}//end rotate

}//end render_specific_actions



// @license-end
