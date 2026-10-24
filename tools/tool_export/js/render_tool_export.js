// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-unused-vars: "error"*/
/*global get_label, SHOW_DEBUG*/
/*eslint no-undef: "error"*/



// imports
	import {clone} from '../../../core/common/js/utils/index.js'
	import {render_components_list} from '../../../core/common/js/render_common.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {when_in_viewport} from '../../../core/common/js/events.js'
	import {downloadZip} from './lib/client-zip/index.js'



/**
* RENDER_TOOL_EXPORT
* Manages the component's logic and appearance in client side
*/
export const render_tool_export = function() {
}//end render_tool_export



/**
* EDIT
* Render DOM nodes of the tool
* @param object options
* @return HTMLElement wrapper
*/
render_tool_export.prototype.edit = async function (options) {

	const self = this

	// render level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render_tool_export



/**
* GET_CONTENT_DATA_EDIT
* @param object self
* @return HTMLElement content_data
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// grid_top
		const grid_top = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'grid_top no_print',
			parent			: fragment
		})

	// components_list_container (left side)
		const components_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_list_container',
			parent			: grid_top
		})
		// components_list. render section component list [left]
		const ar_components_exclude = ['component_password']
		const section_elements = await self.get_section_elements_context({
			section_tipo			: self.target_section_tipo,
			ar_components_exclude	: ar_components_exclude
		})
		// render_components_list (common shared render by render_common.js)
		const ar_components = render_components_list({
			self					: self,
			section_tipo			: self.target_section_tipo,
			target_div				: components_list_container,
			path					: [],
			section_elements		: section_elements,
			ar_components_exclude	: ar_components_exclude
		})

	// user_selection_list (right side)
		const selection_list_contaniner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'selection_list_contaniner',
			parent			: grid_top
		})
		// title
		ui.create_dom_element({
			element_type	: 'h1',
			class_name		: 'list_title',
			inner_html		: get_label.active_elements || 'Active elements',
			parent			: selection_list_contaniner
		})
		// user_selection_list
		const user_selection_list = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_selection_list',
			parent			: selection_list_contaniner
		})
		// empty_space
		const empty_space = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'empty_space',
			parent			: selection_list_contaniner
		})

		// empty_space drag and drop events
		empty_space.addEventListener('dragover', function(e){self.on_dragover(user_selection_list,e)})
		empty_space.addEventListener('dragleave', function(e){self.on_dragleave(this,e)})
		empty_space.addEventListener('drop', function(e){self.on_drop(user_selection_list,e)})

		// read saved ddo in local DB and restore elements if found
			const id = 'tool_export_config'
			data_manager.get_local_db_data(
				id,
				'data'
			)
			.then(function(response){
				const target_section_tipo = self.target_section_tipo[0]
				if (response?.value && response.value[target_section_tipo]) {
					// call for each saved ddo
					for (let i = 0; i < response.value[target_section_tipo].length; i++) {
						const ddo = response.value[target_section_tipo][i]
						self.build_export_component(ddo)
						.then((export_component_node)=>{
							// add DOM node
							user_selection_list.appendChild(export_component_node)
							// Update the ddo_export
							self.ar_ddo_to_export.push(ddo)
						})
					}
					if(SHOW_DEBUG===true) {
						console.log(`Added ddo items from saved local db ${target_section_tipo}. Items:`, response.value[target_section_tipo]);
					}
				}
			})

	// export_buttons_config
		const export_buttons_config = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_buttons_config',
			parent			: grid_top
		})

		// records info
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'records_info',
				parent			: export_buttons_config
			})
			ui.create_dom_element({
				element_type	: 'h1',
				class_name		: 'section_label',
				inner_html		: self.caller.label,
				parent			: export_buttons_config
			})
			const total_records_label = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'total_records_label',
				inner_html		: (get_label.total_records || 'Total records:') + ': ',
				parent			: export_buttons_config
			})
			const total_records = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'total_records',
				parent			: total_records_label
			})
			// section get total
			self.caller.get_total()
			.then(function(total){
				const locale		= 'es-ES' // (page_globals.locale ?? 'es-CL').replace('_', '-')
				const total_label	= new Intl.NumberFormat(locale, {}).format(total);
				total_records.insertAdjacentHTML('afterbegin', total_label)
			})

		// data_format selectors
			const data_format = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'data_format',
				inner_html		: (get_label.format || 'Format'),
				parent			: export_buttons_config
			})
			// select
				const select_data_format_export = ui.create_dom_element({
					element_type	: 'select',
					class_name		: 'select_data_format_export',
					parent			: data_format
				})
				const change_handler = () => {
					// fix value
					self.data_format = select_data_format_export.value
					// store to preserve across reloads
					localStorage.setItem('selected_data_format_export', select_data_format_export.value);
				}
				select_data_format_export.addEventListener('change', change_handler)

				// select_option_standard
				ui.create_dom_element({
					element_type	: 'option',
					inner_html		: get_label.standard || 'standard',
					value			: 'value',
					parent			: select_data_format_export
				})
				// select_option_breakdown
				ui.create_dom_element({
					element_type	: 'option',
					inner_html		: get_label.breakdown || 'Breakdown',
					value			: 'grid_value',
					parent			: select_data_format_export
				})
				// select_option_dedalo
				ui.create_dom_element({
					element_type	: 'option',
					inner_html		: 'Dédalo (Raw)',
					value			: 'dedalo_raw',
					parent			: select_data_format_export
				})

				// fix selector value
				self.data_format = localStorage.getItem('selected_data_format_export') || 'standard'
				select_data_format_export.value = self.data_format

		// Options to check
			const options_to_check = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'options_to_check',
				parent			: export_buttons_config
			})
			// Fill the gaps check_box
				const fill_the_gaps_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'check_label fill_the_gaps',
					inner_html		: self.get_tool_label('fill_the_gaps') || 'Fill the gaps',
					parent			: options_to_check
				})
				const fill_the_gaps_check = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					class_name		: 'option_check_box fill_the_gaps_check',
					parent			: fill_the_gaps_node
				})
				fill_the_gaps_check.checked = true

			// show labels check_box
				const show_tipo_in_label = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'check_label show_tipo_in_label',
					inner_html		: self.get_tool_label('show_tipo_in_label') || 'Show ontology tipo',
					parent			: options_to_check
				})
				const show_tipo_in_label_check = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					class_name		: 'option_check_box show_tipo_in_label_check',
					parent			: show_tipo_in_label
				})

		// button_export
			const button_export = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'button_export table success',
				inner_html		: get_label.tool_export || 'Export',
				parent			: export_buttons_config
			})
			button_export.addEventListener('click', async function(e) {
				e.stopPropagation()

				// clean target_div
					while (export_data_container.hasChildNodes()) {
						export_data_container.removeChild(export_data_container.lastChild);
					}
					const data_spinner = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'spinner',
						parent			: export_data_container
					});

				// spinner add
					[button_export, activate_all_columns, deactivate_all_columns].map(
						el => el.classList.add('hide')
					)
					const spinner = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'spinner',
						parent			: export_buttons_config
					})
					const show_tipo_in_label	= show_tipo_in_label_check.checked;
					const fill_the_gaps			= fill_the_gaps_check.checked;

				// loading class elements
					[components_list_container, selection_list_contaniner, export_buttons_options].map(
						el => el.classList.add('loading')
					)

				// export_grid
					const export_grid_options = {
						data_format			: self.data_format,
						ar_ddo_to_export	: self.ar_ddo_to_export,
						show_tipo_in_label	: show_tipo_in_label,
						fill_the_gaps		: fill_the_gaps,
						view				: 'table'
					}
					let dd_grid = null
					try {
						dd_grid = await self.get_export_grid(export_grid_options)
					}catch (error) {
						// restore the UI the same way as the success path below
						console.error('Error:', error.message)
						alert(`An error has occurred in the export\n\n${error.message}`)
						data_spinner.remove()
						;[button_export, activate_all_columns, deactivate_all_columns].map(
							el => el.classList.remove('hide')
						)
						spinner.remove()
						;[components_list_container, selection_list_contaniner, export_buttons_options].map(
							el => el.classList.remove('loading')
						)
						return
					}
					const dd_grid_export_node	= await dd_grid.render()

					const clone_node = dd_grid_export_node.cloneNode(true)
					if (dd_grid_export_node) {
						data_spinner.remove()
						export_data_container.appendChild(clone_node)
						// export_data_container.scrollIntoView(true)
						export_buttons_options.scrollIntoView(true)
					}

				// check if some allowed media component is present in the data
				// if not, the button_download_media will be lock to prevent use it
					if (button_download_media) {
						// fix values from grid data parsing models in portals
						self.grid_values = get_parsed_grid_values(self)

						const models_in_data		= self.grid_values.map(item => item.model)
						const models_in_data_unique	= [...new Set(models_in_data)];

						// set updated value
						self.media_components_in_data = models_in_data_unique.filter(el => self.media_components.has(el));

						const style_action = self.media_components_in_data.length ? 'remove' : 'add'
						button_download_media.classList[style_action]('loading')
					}

				// spinner remove
					[button_export, activate_all_columns, deactivate_all_columns].map(
						el => el.classList.remove('hide')
					)
					spinner.remove();

				// loading class elements
					[components_list_container, selection_list_contaniner, export_buttons_options].map(
						el => el.classList.remove('loading')
					)
			})

		// activate_all_columns
			const activate_all_columns = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'activation light activate_all_columns',
				inner_html		: get_label.activate_all_columns || 'Activate all columns',
				parent			: export_buttons_config
			})
			activate_all_columns.addEventListener('click', function(e) {
				e.stopPropagation()

				const ar_components_length = ar_components.length
				for (let i = 0; i < ar_components_length; i++) {

					const item = ar_components[i]

					// short vars
						const path	= item.path
						const ddo	= item.ddo
						const id	= self.compose_id(ddo, path)

					// rebuild ddo
						const new_ddo = {
							id				: id,
							tipo			: ddo.tipo,
							section_tipo	: ddo.section_tipo,
							model			: ddo.model,
							parent			: ddo.parent,
							lang			: ddo.lang,
							mode			: ddo.mode,
							label			: ddo.label,
							path			: path // full path from current section replaces ddo single path
						}

					// exists
						const found = self.ar_ddo_to_export.find(el => el.id===new_ddo.id)
						if (found) {
							// Ignored already included item ddo
							continue;
						}

					// Build component html
						self.build_export_component(new_ddo)
						.then((export_component_node)=>{

							// add DOM node
							user_selection_list.appendChild(export_component_node)

							// Update the ddo_export list
							self.ar_ddo_to_export.push(new_ddo)

							// save local db data
							self.update_local_db_data()
						})
				}//end for (let i = 0; i < ar_components_length; i++)
			})

		// deactivate_all_columns
			const deactivate_all_columns = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'activation light deactivate_all_columns',
				inner_html		: get_label.disable_all_columns || 'Disable all columns',
				parent			: export_buttons_config
			})
			deactivate_all_columns.addEventListener('click', function(e) {
				e.stopPropagation()

				const close_buttons = user_selection_list.querySelectorAll('.close') || []
				const close_buttons_length = close_buttons.length
				for (let i = 0; i < close_buttons_length; i++) {
					const item = close_buttons[i]
					item.click()
				}
			})

	// download_buttons_options
		const export_buttons_options = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_buttons_options no_print',
			parent			: fragment
		})

		// filename base name
		// Note that the file name is sanitized because toLocaleDateString adds characters
		// like '/' (as in '31/7/2026') that are not valid inside a file name
		const filename = sanitize_file_name(
			'export_' +self.caller.label +'_'+ new Date().toLocaleDateString()+'-'+ self.caller.section_tipo
		)

		// csv. button_export_csv
			const button_export_csv = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download',
				inner_html		: (get_label.download || 'Download') + ' CSV',
				parent			: export_buttons_options
			})
			button_export_csv.addEventListener('click', async function() {

				try {
					// built page by page, see export_text_blob
						const csv_blob = await self.export_text_blob('csv')

					// Download it
						self.download_export_blob(csv_blob, filename + '.csv')
				} catch (error) {
					console.error('Error on export CSV:', error);
					ui.show_message(export_buttons_options, 'Error on export CSV: ' + error.message)
				}
			})

		// tsv. button_export_tsv
			const button_export_tsv = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download',
				inner_html		: (get_label.download || 'Export') + ' TSV',
				parent			: export_buttons_options
			})
			button_export_tsv.addEventListener('click', async function() {

				try {
					// built page by page, see export_text_blob
						const tsv_blob = await self.export_text_blob('tsv')

					// Download it
						self.download_export_blob(tsv_blob, filename + '.tsv')
				} catch (error) {
					console.error('Error on export TSV:', error);
					ui.show_message(export_buttons_options, 'Error on export TSV: ' + error.message)
				}
			})

		// ods. button_export ODS Libre office
			const button_export_ods = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download',
				inner_html		: (get_label.download || 'Export') + ' ODS',
				parent			: export_buttons_options
			})
			button_export_ods.addEventListener('click', async function() {

				try {
					// note that the call is awaited to be able to catch the library errors
						await self.export_workbook('ods', filename + '.ods')
				} catch (error) {
					console.error('Error on export ODS:', error);
					ui.show_message(export_buttons_options, 'Error on export ODS: ' + error.message)
				}
			})

		// xlsx. button_export Excel
			const button_export_excel = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download',
				inner_html		: (get_label.download || 'Export') + ' XLSX',
				parent			: export_buttons_options
			})
			button_export_excel.addEventListener('click', async function() {

				try {
					// note that the call is awaited to be able to catch the library errors
						await self.export_workbook('xlsx', filename + '.xlsx')
				} catch (error) {
					console.error('Error on export XLSX:', error);
					ui.show_message(export_buttons_options, 'Error on export XLSX: ' + error.message)
				}
			})

		// html. button export html
			const button_export_html = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download',
				inner_html		: (get_label.download || 'Export') + ' HTML',
				parent			: export_buttons_options
			})
			button_export_html.addEventListener('click', async function() {

				try {
					// built page by page from the data (no DOM), see export_html_blob
						const html_blob = await self.export_html_blob()

					// Download it
						self.download_export_blob(html_blob, filename + '.html')
				} catch (error) {
					console.error('Error on export HTML:', error);
					ui.show_message(export_buttons_options, 'Error on export HTML: ' + error.message)
				}
			})

		// media. button download media (images, pdf, av, 3d, svg)
			const button_download_media = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success download loading',
				inner_html		: (get_label.download || 'Download') + ' media',
				parent			: export_buttons_options
			})
			const download_media_click_handler = (e) => {
				e.stopPropagation()
				e.target.blur()
				// modal with quality selection options
				render_download_modal(self)
			}
			button_download_media.addEventListener('click', download_media_click_handler)

		// print. button export print
			const button_export_print = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'processing_import success print',
				inner_html		: get_label.print || 'Print',
				parent			: export_buttons_options
			})
			button_export_print.addEventListener('click', function(e) {
				e.stopPropagation()
				e.preventDefault()
				window.print()
				return false;
			})

	// grid data container
		const export_data_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_data_container',
			parent			: fragment
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* BUILD_EXPORT_COMPONENT
* Creates export_component DOM item
* @param object ddo
* @return HTMLElement export_component
*/
render_tool_export.prototype.build_export_component = async function(ddo) {

	const self = this

	// short vars
		const path = ddo.path

	// export_component container. Create DOM element before load html from trigger
		const export_component = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'export_component'
		})
		export_component.ddo = ddo
		do_sortable(export_component, self)

		// export_component component_label
			const label = path.map((el)=>{
				return el.name
			}).join(' > ')
			ui.create_dom_element({
				element_type	: 'li',
				class_name		: 'component_label',
				inner_html		: label + '<span> [' + ddo.tipo + '] ' + ddo.model + '</span>',
				parent			: export_component
			})

	// button close
		const export_component_button_close = ui.create_dom_element({
			element_type	: 'span',
			parent			: export_component,
			class_name		: 'button close'
		})
		export_component_button_close.addEventListener('click', function(e) {
			e.stopPropagation()

			// remove search box and content (component) from DOM
			export_component.parentNode.removeChild(export_component)

			// delete the ddo from the array to export ddos
			const delete_ddo_index = self.ar_ddo_to_export.findIndex( el => el.id === ddo.id )
			self.ar_ddo_to_export.splice(delete_ddo_index, 1)

			// save local db data
			self.update_local_db_data()
		})


	return export_component
}//end build_export_component



/**
* DO_SORTABLE
* Add drag and drop features to the element
* @param DOM node element
* @return void
*/
const do_sortable = function(element, self) {

	// sortable
		element.draggable = true

	// reset all items
		function reset() {
			const element_children_length = element.parentNode.children.length
			for (let i = 0; i < element_children_length; i++) {
				const item = element.parentNode.children[i]
				if (item.classList.contains('displaced')) {
					item.classList.remove('displaced')
				}
			}
		}

	// events fired on the draggable target

		// drag start. Fix dragged element to recover later
			element.addEventListener('dragstart', (event) => {
				event.stopPropagation()

				reset()

				element.classList.add('dragging');

				// fix dragged element
					self.dragged = element

				// dataTransfer
					const data = {
						drag_type : 'sort'
					}
					// event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.dropEffect = 'move';
					event.dataTransfer.setData(
						'text/plain',
						JSON.stringify(data)
					)
			});

		// drag end
			element.addEventListener('dragend', (event) => {
				reset()
				// reset the dragging style
				event.target.classList.remove('dragging');
			});

	//  events fired on the drop targets

		// drag enter - add displaced padding
			element.addEventListener('dragenter', (event) => {
				event.preventDefault();

				reset()
				// const new_empty_node = document.createElement('div')
				// new_empty_node.classList.add('new_empty_node')
				// element.parentNode.insertBefore(new_empty_node, element)

				element.classList.add('displaced')
			});

		// allow to be dropable the element
		element.addEventListener('dragover', (event) => {
			event.preventDefault();
		})
		// on drop
			element.addEventListener('drop', (event) => {
				event.preventDefault();
				event.stopPropagation()

				reset()

				// remove dragover class from user_selection_list container
				element.parentNode.classList.remove('dragover')

				// data transfer
					const data			= event.dataTransfer.getData('text/plain');// element that move
					const parsed_data	= JSON.parse(data)

				if (parsed_data.drag_type==='sort') {

					// sort case
					// place drag item
					const dragged = self.dragged
					element.parentNode.insertBefore(dragged, element)
					dragged.classList.add('active')

					// Update the ddo_export. Move to the new array position
						const from_index	= self.ar_ddo_to_export.findIndex(el => el.id===dragged.ddo.id)
						const to_index		= [...element.parentNode.children].indexOf(dragged) // exclude title node
						// remove
						const item_moving_ddo = self.ar_ddo_to_export.splice(from_index, 1)[0];
						// add
						self.ar_ddo_to_export.splice(to_index, 0, item_moving_ddo);

						// save local db data
						self.update_local_db_data()

				}else if (parsed_data.drag_type==='add') {

					// add case

					// short vars
						const path	= parsed_data.path
						const ddo	= parsed_data.ddo
						const id	= self.compose_id(ddo, path)

					// rebuild ddo
						const new_ddo = {
							id				: id,
							tipo			: ddo.tipo,
							section_tipo	: ddo.section_tipo,
							model			: ddo.model,
							parent			: ddo.parent,
							lang			: ddo.lang,
							mode			: ddo.mode,
							label			: ddo.label,
							path			: path // full path from current section replaces ddo single path
						}

					// exists
						const found = self.ar_ddo_to_export.find(el => el.id===new_ddo.id)
						if (found) {
							// Ignored already included item ddo
							return
						}

					// Build component html
					self.build_export_component(new_ddo)
					.then((export_component_node)=>{

						// add DOM node
						element.parentNode.insertBefore(export_component_node, element)

						export_component_node.classList.add('active')

						// Add ddo in the current position
						// self.ar_ddo_to_export.push(new_ddo)
						const to_index = [...element.parentNode.children].indexOf(export_component_node) -1 // exclude title node
						// add
						self.ar_ddo_to_export.splice(to_index, 0, export_component_node.ddo);

						// save local db data
						self.update_local_db_data()
					})
				}
			});
}//end do_sortable



/**
* GET_PARSED_GRID_VALUES
* Get dd_grid values and overwrites models base in the
* self.ar_ddo_to_export (user components selection)
* @param object self
* 	tool_export instance
* @return array grid_values
*/
export const get_parsed_grid_values = (self) => {

	// grid_values from dd_grid extract values from dd_grid data
	const grid_values = self.dd_grid.get_grid_values(self.dd_grid.data)

	// overwrite model from grid_values with more accurate ar_ddo_to_export
	// this solves portals deep resolution inconsistencies
	const ar_ddo_to_export = self.ar_ddo_to_export
	ar_ddo_to_export.forEach(el => {
		const id = el.path.map(item => item.section_tipo +'_'+ item.component_tipo).join('_')
		const found = grid_values.filter(el => el.ar_columns_obj[0].id===id)
		if (found) {
			// overwrite the model as component_portal -> component_image
			found.map(f => f.model = el.model)
		}
	})


	return grid_values
}//end get_parsed_grid_values



/**
* RENDER_DOWNLOAD_MODAL
* Creates a standard dd_modal to allow quality selection for media
* download files before collect the files
* @param object self
* 	tool_export instance
* @return HTMLElement modal
*/
export const render_download_modal = (self) => {

	// body
	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body content'
	})
	// quality selectors
	const quality_parse = {}
	const models_unique = self.media_components_in_data;
	const models_unique_length = models_unique.length
	for (let i = 0; i < models_unique_length; i++) {

		const model = models_unique[i]

		// selector_container
			const selector_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'selector_container',
				parent			: body
			})

		// selector_title
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'selector_title',
				inner_html		: 'Quality for ' + model,
				parent			: selector_container
			})

		// quality_selector
			const quality_selector = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'quality_selector for_' + model,
				parent			: selector_container
			})
			switch (model) {

				case 'component_image':
					// Get the context of the default component image from resources
					// (Any is valid to get the a generic context)
					data_manager.get_element_context({
						model			: 'component_image',
						tipo			: 'rsc29',
						section_tipo	: 'rsc170'
					})
					.then(function(api_response){
						if(!api_response.result) {
							console.error('Failed component image context request:', api_response);
							return
						}

						const ar_quality = api_response.result?.[0].features?.ar_quality || []

						quality_parse[model] = {
							source : page_globals.dedalo_image_quality_default,
							target : page_globals.dedalo_image_quality_default
						}

						ar_quality.map(quality => {
							const select_option = ui.create_dom_element({
								element_type	: 'option',
								value			: quality,
								text_node		: quality,
								parent			: quality_selector
							})
							if (quality === page_globals.dedalo_image_quality_default) {
								select_option.selected = true
							}
						})
					})
					break;

				case 'component_av':
					quality_parse[model] = {
						source : page_globals.dedalo_av_quality_default,
						target : page_globals.dedalo_av_quality_default
					}
					ui.create_dom_element({
						element_type	: 'option',
						value			: page_globals.dedalo_av_quality_default,
						text_node		: page_globals.dedalo_av_quality_default,
						parent			: quality_selector
					})
					ui.create_dom_element({
						element_type	: 'option',
						value			: 'original',
						text_node		: 'original',
						parent			: quality_selector
					})
					break;

				case 'component_3d':
				case 'component_pdf':
				case 'component_svg':
					quality_parse[model] = {
						source : 'web',
						target : 'web'
					}
					ui.create_dom_element({
						element_type	: 'option',
						value			: 'web',
						text_node		: 'web',
						parent			: quality_selector
					})
					ui.create_dom_element({
						element_type	: 'option',
						value			: 'original',
						text_node		: 'original',
						parent			: quality_selector
					})
					break;

				default:
					// not yet implemented
					break;
			}
			const change_handler = (e) => {
				quality_parse[model].target = e.target.value
			}
			quality_selector.addEventListener('change', change_handler)
	}

	// footer
	const footer = ui.create_dom_element({
		element_type	: 'div',
		class_name 		: 'content'
	})

	// button_ok
	const button_ok = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'success',
		inner_html		: get_label.ok || 'OK',
		parent			: footer
	})
	const click_handler = async (e) => {
		e.stopPropagation()

		body.classList.add('loading')
		button_ok.classList.add('button_spinner')

		try {
			await download_media(
				self,
				quality_parse
			)
		} catch (error) {
			console.error(error)
		}

		body.classList.remove('loading')
		button_ok.classList.remove('button_spinner')
	}
	button_ok.addEventListener('click', click_handler)
	when_in_viewport(button_ok, () => {
		button_ok.focus()
	})

	const modal = ui.attach_to_modal({
		header		: get_label.download_media || 'Download media',
		body		: body,
		footer		: footer,
		size		: 'normal',
		callback	: (dd_modal) => {
			dd_modal.modal_content.style.width = '50rem'
			dd_modal.classList.add('tool_export_modal')
		},
		on_close : () => {

		}
	})


	return modal
}//end render_download_modal



/**
* DOWNLOAD_MEDIA
* Search media files in dd_grid data and download the found media files fetching the URL
* Default quality is used (e.g. '1.5MB' in images) in grid data. If we want to map to another
* quality (e.g. 'original') we set the 'quality_parse' object value.
* @param object self
* 	tool_export instance
* @param object|undefined quality_parse
* 	sample: {
*		component_image : {
*			source : '1.5MB',
*			target : 'original'
*		}
*	}
* @return
*/
const download_media = async function (self, quality_parse) {

	// quality_parse. Defines source and target quality for each model
	if (!quality_parse) {
		// default value
		quality_parse = {
			component_image : {
				source : '1.5MB',
				target : 'original'
			},
			component_av : {
				source : '404',
				target : 'original'
			}
		}
	}
	// calculate quality from quality_parse definition
	const get_quality = (model, type) => {
		if (quality_parse[model]) {
			return quality_parse[model][type] ?? false
		}
		return false
	}

	// grid_values (already calculated on submit with button export)
	const grid_values = self.grid_values

	// list of media models to parse
	const ar_models_set = new Set(self.media_components_in_data)

	// get value recursively from grid item
	const get_value = (item) => {

		if (!item || !item.value) {
			return null
		}

		if (item.model && ar_models_set.has(item.model)) {
			return {
				url		: item.value,
				model	: item.model
			}
		}

		if (Array.isArray(item.value)) {
			const ar_value = item.value.reduce((acc, inner_item) => {
				const current_value = get_value(inner_item);
				if (current_value) {
					acc.push(current_value);
				}
				return acc;
			}, []);
			return ar_value.length ? ar_value : null;
		}

		return null
	}

	// extract values from grid data
	const ar_values = []
	const grid_values_length = grid_values.length
	for (let i = 0; i < grid_values_length; i++) {

		const item = grid_values[i]

		const value = get_value(item)

		if (value) {

			if (Array.isArray(value)) {
				value.forEach(el => {
					ar_values.push(el)
				})
			}else{
				ar_values.push(value)
			}
		}
	}

	// no values case
	const ar_values_length = ar_values.length
	if (!ar_values_length) {
		return null
	}

	const failed_files = []
	const url_list = []
	const fill_url_list = (ar_values) => {

		const ar_values_length = ar_values.length
		for (let i = 0; i < ar_values_length; i++) {

			const el = clone( ar_values[i] )

			if (Array.isArray(el)) {
				fill_url_list(el)
			}else{

				const source_quality = get_quality(el.model, 'source')
				const target_quality = get_quality(el.model, 'target')

				// dedalo_raw case
				// If export data format is dedalo_raw, the url is inside 'files_info' property
				const nolan = 'lg-nolan'
				if (el.url[nolan] && el.url[nolan][0].files_info) {

					const found = el.url[nolan][0].files_info.find(el => el.quality===target_quality)
					if (found) {
						// overwrite URL
						el.url = DEDALO_MEDIA_URL + found.file_path
					}else{
						// find thumb
						const thumb = el.url[nolan][0].files_info.find(el => el.quality===page_globals.dedalo_quality_thumb)
						if (thumb) {
							failed_files.push( thumb.file_name )
						}else{
							failed_files.push( JSON.stringify( el.url[nolan][0].files_info ) )
						}
						continue; // skip item
					}
				}

				const ar_url = Array.isArray(el.url) ? el.url : el.url.split(' | ')
				ar_url.forEach(item => {

					if (!item || !item.length) {
						return
					}

					const url = (source_quality && target_quality && source_quality!==target_quality)
						? item.replace('/'+source_quality+'/','/'+target_quality+'/')
						: item

					url_list.push(url)
				})
			}
		}
	}
	fill_url_list(ar_values)

	const fetch_list = []
	url_list.flat().forEach(function(url) {

		const current_fetch = fetch(url)
			.then((res)=>{
				if (res.ok) {
					return res
				}
				failed_files.push(url)
			})
			.catch((error) => {
				if(SHOW_DEBUG===true) {
					console.log(error)
				}
			})

		fetch_list.push(current_fetch)
	});

	const promise_items = await Promise.all(fetch_list)

	// filter valid files (exclude not downloadable)
	const files = promise_items.filter(el => el)

	const downloaded_files = files.map(el => el.url)

	// info text file add to download file
	const info = {
		name: "info.txt",
		lastModified: new Date(),
		input: "Downloaded files: " + JSON.stringify(downloaded_files, null, 2) + "\nFailed files: " + JSON.stringify(failed_files, null, 2)
	}
	files.push(info)

	// get the ZIP stream in a Blob
	// Using lib client-zip @see https://github.com/Touffy/client-zip?tab=readme-ov-file
	const blob = await downloadZip(files).blob()

	// make and click a temporary link to download the Blob
	const link = document.createElement('a')
	link.href = URL.createObjectURL(blob)
	link.download = 'export_media.zip'
	link.click()
	link.remove()


	return true
}//end download_media



/**
* SANITIZE_FILE_NAME
* Removes from the given string the characters that are not allowed
* inside a file name (as the '/' added by toLocaleDateString)
* @param string file_name
* @return string
*/
const sanitize_file_name = function(file_name) {

	return String(file_name).replace(/[\\/:*?"<>|]/g, '-')
}//end sanitize_file_name



/**
* DOWNLOAD_FILE
* Creates a temporary link and clicks it to download the given content as a file.
* Note that a Blob object URL is used instead of a 'data:' URI because Firefox
* blocks top level 'data:' URI navigations and limits the size of 'data:' URIs
* (as the ones generated by big grid exports).
* @param string|Blob content
* @param string mime
* 	like 'text/csv;charset=utf-8'
* @param string file_name
* 	like 'export_my_section_31-7-2026-oh1.csv'
* @return bool
*/
const download_file = function(content, mime, file_name) {

	// blob
		const blob = (content instanceof Blob)
			? content
			: new Blob([content], {type: mime})

	// url. Temporary object URL, released once the download is already started
		const url = URL.createObjectURL(blob)

	// link. Note that 'target' is not set. A target forces the browser to open
	// a new browsing context and the 'download' attribute is then ignored
		const link = document.createElement('a')
			  link.style.display	= 'none'
			  link.href				= url
			  link.download			= sanitize_file_name(file_name)

	// download
		document.body.appendChild(link)
		link.click()
		document.body.removeChild(link)

	// release the object URL
		setTimeout(() => URL.revokeObjectURL(url), 60000)


	return true
}//end download_file



// @license-end
