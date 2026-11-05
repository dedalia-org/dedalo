// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_media_versions */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {bytes_format, download_file, open_window} from '../../../core/common/js/utils/index.js'
	import {open_tool} from '../../../tools/tool_common/js/tool_common.js'



/**
* RENDER_TOOL_MEDIA_VERSIONS
* Manages the component's logic and appearance in client side
*/
export const render_tool_media_versions = function() {

	return true
}//end render_tool_media_versions



/**
* EDIT
* Render tool DOM nodes
* This function is called by render common attached in 'tool_media_versions.js'
* @param object options
* @return HTMLElement wrapper
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
* Render tool body or 'content_data'
* @param instance self
* @return HTMLElement content_data
*/
const get_content_data = async function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// main_element_container
		const main_element_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'main_element_container',
			parent			: fragment
		})
		// show_interface
		self.main_element.show_interface.tools = false
		self.main_element.show_interface.read_only = true
		// render
		self.main_element.render()
		.then(function(component_node){
			main_element_container.appendChild(component_node)
		})
		// fix
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
* Render 'Show data' button and container to display
* the current files and DB data comparison
* @param object self
* @return HTMLElement|null
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

	// is_sync
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

		// versions_container
			const versions_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'sync_data_container',
				parent			: sync_data_wrapper
			})

		// button_icon_show_data
			const button_icon_show_data = ui.create_dom_element({
				element_type	: 'span',
				title			: 'Display component files_info',
				class_name		: 'button icon ' + (is_sync ? 'eye' : 'exclamation'),
				parent			: versions_container
			})
			button_icon_show_data.addEventListener('click', function(e) {
				e.stopPropagation()
				pre_data.classList.toggle('hide')
			})
			// label
			const label_string = !is_sync
				? self.get_tool_label('files_info_is_unsync') || 'Files info data is unsync'
				: self.get_tool_label('show_data') || 'Show data'
			const label_node = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'label',
				inner_html		: label_string,
				parent			: versions_container
			})
			label_node.addEventListener('click', (e)=> {
				button_icon_show_data.click(e)
			})

		// button_sync
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
				.then(function(response){
					// tool closed while waiting the background process
					if (response.stopped===true) {
						return
					}
					if (response.result===true) {
						self.refresh({
							build_autoload	: false,
							destroy			: false
						})
					}else{
						self.node.content_data.classList.remove('loading')
						alert('Error: ' + (response.msg || 'Unknown') )
					}
				})
			})

		// delete_normalized_files check box
			// Check for activate the delete of all images created by the upload process and recreate all of them
			// if will delete original, modified, default generated images, keeping the uploaded file (.tiff, .psd, etc)
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

		// pre_data JSON data
			const pre_data = ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'pre hide',
				inner_html		: JSON.stringify({
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
* @param object self
* @return HTMLElement
*/
const render_versions_grid = function(self) {

	const fragment = new DocumentFragment()

	// quality versions
		const ar_quality = self.ar_quality
		if (!ar_quality || ar_quality.length<1) {
			console.log('Error. Invalid component ar_quality :', ar_quality);
			return fragment
		}

	// thumb
		const thumb = ar_quality.find(el => el === 'thumb')
		if(!thumb){
			ar_quality.push('thumb')
		}

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

	// specific_actions. Special features based on main_element model. They are defined in tool properties.
		// sample:
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
		const specific_actions = self.context.properties.specific_actions || {}
		// functions mapper. Maps action name with handler function
		// Define here the list of available specific tool functions
		for(const action_name in specific_actions) {

			const ar_models = specific_actions[action_name]
			if (ar_models.includes(self.main_element.model)) {

				// check valid function call
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


	// versions_container
		const versions_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'versions_container',
			parent			: fragment
		})
		Object.assign(
			versions_container.style,
			{
				'grid-template-columns': `minmax(6rem, 1fr) repeat(${ar_quality.length}, 1fr)`,
				'grid-template-rows': `repeat(${ar_rows.length + 1}, minmax(2rem, auto))`
			}
		)

	// line_labels
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

	// quality labels
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
					'grid-row': `${i+2}`
				}
			)
		}

	// contents by quality
		const ar_quality_length = ar_quality.length
		for (let i = 0; i < ar_quality_length; i++) {

			const current_quality = ar_quality[i];

			const quality_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'column quality_container',
				parent			: versions_container
			})
			// quality label
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
*  Renders file_info_node whit one icon to display the selected quality preview
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_file = function(quality, self) {

	// info columns
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_file' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

		// file_info
		const files_info = ((quality==='thumb')
			? self.files_info_disk // thumb is not in files_info_safe (different extension case)
			: self.files_info_safe) || [] // fallback to empty array to keep render rock-solid
		const file_info = files_info.find(el => el.quality===quality)
		if (file_info && file_info.file_exist===true) {
			if (file_info.file_path) {
				const button_file_av = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button media',
					title			: get_label.visualizar || 'View',
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
* @param string quality
* @param object self
* @return HTMLElement file_info_node
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
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_file_size = function(quality, self) {

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
* @param string quality
* @param object self
* @return HTMLElement file_info_node
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
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_file_upload = function(quality, self) {

	// info columns
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_file_upload' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

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
				// tool context minimum
					const tool_context = {
						model	: 'tool_upload',
						name	: 'tool_upload',
						mode	: 'edit'
					}

				const caller = self.main_element

				// update caller context quality
					caller.context.target_quality = quality

				// open_tool (tool_common)
					open_tool({
						tool_context	: tool_context,
						caller			: caller
					})

			// event on refresh caller
				let token
				const render_handler = () => {
					event_manager.unsubscribe(token)
					self.main_element_quality = quality
					self.refresh()
				}
				token = event_manager.subscribe('render_'+self.main_element.id, render_handler)
				self.events_tokens.push(token)
		})


	return file_info_node
}//end render_file_upload



/**
* RENDER_FILE_VERSIONS
* Render all file versions of current quality as:
*	Search | Download | Extension
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_file_versions = function(quality, self) {

	// custom_files_info. Include non original and files_info_alternative quality
		const raw_custom_files_info	= self.files_info_safe.concat(self.files_info_alternative)
		// remove duplicates
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
			class_name		: 'file_info render_file_versions' + (quality===self.caller.context.features.default_quality ? ' default' : '')
		})

	// iterate files_info
		const files_info		= custom_files_info.filter(el => el.quality===quality)
		const files_info_length	= files_info.length
		for (let k = 0; k < files_info_length; k++) {

			const file_info = files_info[k]

			// check file_exists
				if (!file_info || file_info.file_exist!==true) {
					continue;
				}

			// size
				const size = bytes_format(file_info.file_size)

			// extension
				const extension	= file_info && file_info.file_path
					? file_info.file_path.split('.').pop()
					: null;

			// file_url
				const file_url = DEDALO_MEDIA_URL + file_info.file_path

			// cell_node
				const cell_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'cell_node',
					parent			: file_info_node
				})

			// button_link
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

			// button_file_download
				const button_file_download = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button download',
					title			: (get_label.download || 'Download') + ' ' + size,
					parent			: cell_node
				})
				button_file_download.addEventListener('click', function(e){
					e.stopPropagation()

					const url		= DEDALO_MEDIA_URL + file_info.file_path
					const file_name	= `dedalo_download_${quality}_` + url.substring(url.lastIndexOf('/')+1);

					download_file({
						url			: url,
						file_name	: file_name
					})
				})

			// file_info_extension
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'button file_info_extension',
					title			: get_label.extension || 'Extension',
					inner_html		: extension,
					parent			: cell_node
				})

			// button_file_delete
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
					.then(function(response){
						if (response.result===true) {
							self.refresh({
								build_autoload : false
							})
						}else{
							self.node.content_data.classList.remove('loading')
							alert('Error: ' + (response.msg || 'Unknown') )
						}
					})
				})
		}//end for (let k = 0; k < files_info_length; k++)


	return file_info_node
}//end render_file_versions



/**
* RENDER_FILE_DELETE
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_file_delete = function(quality, self) {

	// custom_files_info. Include non original and original quality
		const custom_files_info = self.files_info_safe.concat(self.files_info_original)

	// info columns
	const file_info_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'file_info render_file_delete' + (quality===self.caller.context.features.default_quality ? ' default' : '')
	})

	// file_info
		const file_info = custom_files_info.find(el => el.quality===quality)
		// const file_info = (quality==='original' && self.file_info_normalized_name)
		// 	? self.file_info_normalized_name
		// 	: custom_files_info.find(el => el.quality===quality)

		if (file_info && file_info.file_exist===true) {

			const button_file_download = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button delete',
				parent			: file_info_node
			})
			button_file_download.addEventListener('click', async function(){
				self.node.classList.add('loading')
				// exec delete_quality
				const response = await self.delete_quality(quality)
				if (response===true) {
					// self.main_element_quality = quality
					self.refresh({
						build_autoload : false
					})
				}
				self.node.classList.remove('loading')
			})
		}


	return file_info_node
}//end render_file_delete



/**
* RENDER_BUILD_VERSION
* @param string quality
* @param object self
* @return HTMLElement file_info_node
*/
const render_build_version = function(quality, self) {

	// file_info_node
		const file_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info render_build_version' + (quality===self.main_element.context.features.default_quality ? ' default' : '')
		})

	// exclude original quality button from list
		if (quality==='original') {
			return file_info_node
		}

	// button_build_version
		const button_build_version = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button gear',
			title			: (get_label.build || 'Build') + ` ${quality} ` + (get_label.version || 'version'),
			parent			: file_info_node
		})
		const fn_click = async function (e) {
			e.stopPropagation()

			self.node.classList.add('loading')

			// exec build_version
			const result = await self.build_version(quality)
			if (result===true) {

				// building
				button_build_version.remove()

				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'blink',
					inner_html		: get_label.processing || 'Processing',
					parent			: file_info_node
				})

				if (self.main_element.model === 'component_av' && quality !== 'thumb') {
					const check_file = async function() {

						if (self.timer) {
							clearTimeout(self.timer);
						}

						const files_info	= await self.get_files_info()
						const found			= files_info.find(el => el.quality===quality)
						if (found && found.file_exist===true) {
							// processing_label.remove()
							// button_build_version.classList.remove('hide')
							self.main_element_quality = quality

							// force save component to update dato files_info
							// Note that action 'force_save' do not save data really and do not need more
							// properties, is only to allow API exec component save transparently
								await self.main_element.save([{
									action : 'force_save'
								}])

							self.refresh({
								build_autoload : false
							})
						}else{
							// check again after 2 sec
							self.timer = setTimeout(async function(){
								check_file()
							}, 2000)
						}
					}
					check_file()
				}else{
					dd_request_idle_callback(
						() => {
							self.refresh({
								build_autoload : false
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
*  Special render functions based on context.properties definitions
*/
const render_specific_actions = {

	/**
	* GET_LINE_CONFORM_HEADERS
	*  Specific component_av feature
	* @param string quality
	* @param object self
	* @return HTMLElement file_info_node
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

		if (file_info && quality!=='original' && file_info.file_exist===true) {

			const button_build_version = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button repair',
				title			: (get_label.conform_headers || 'Conform headers'),
				parent			: file_info_node
			})
			button_build_version.addEventListener('click', async function(){
				self.node.classList.add('loading')
				// exec conform_headers
				const result = await self.conform_headers(quality)
				if (result===true) {
					self.main_element_quality = quality
					self.refresh()
				}
				self.node.classList.remove('loading')
			})
		}


		return file_info_node
	},//end conform_headers

	/**
	* ROTATE
	*  Specific component_image feature
	* @param string quality
	* @param object self
	* @return HTMLElement file_info_node
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

				// button_rotate_left
					const button_rotate_left = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button rotate',
						title			: (get_label.rotate || 'Rotate') +' '+ (get_label.left || 'left') +' ('+ (get_label.destructive || 'destructive')+')',
						parent			: file_info_node
					})
					button_rotate_left.addEventListener('click', async function(e){
						e.stopPropagation()

						self.node.classList.add('loading')
						// exec rotate
						const result = await self.rotate(quality, -90)
						if (result===true) {
							self.main_element.quality = quality
							self.main_element.refresh()
						}
						self.node.classList.remove('loading')
					})

				// button_rotate_right
					const button_rotate_right = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button rotate right',
						title			: (get_label.rotate || 'Rotate') +' '+ (get_label.right || 'right') +' ('+ (get_label.destructive || 'destructive')+')',
						parent			: file_info_node
					})
					button_rotate_right.addEventListener('click', async function(e){
						e.stopPropagation()

						self.node.classList.add('loading')
						// exec rotate
						const result = await self.rotate(quality, 90)
						if (result===true) {
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
