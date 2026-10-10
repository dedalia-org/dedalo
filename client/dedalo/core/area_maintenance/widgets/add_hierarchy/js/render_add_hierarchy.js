// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {render_hierarchies_import_block} from '../../../../installer/js/render_installer.js'



/**
* RENDER_ADD_HIERARCHY
* Client-side renderer for the `add_hierarchy` maintenance widget.
*
* This widget lets administrators import thesaurus hierarchy files into an
* already-running Dédalo installation — the same operation that the first-run
* installation wizard performs, but accessible post-install from the
* Area Maintenance panel.
*
* Architecture notes:
*   - The constructor is a no-op stub. All logic lives on the prototype.
*   - `add_hierarchy.js` assigns `render_add_hierarchy.prototype.list` to both
*     `add_hierarchy.prototype.edit` and `add_hierarchy.prototype.list`, so
*     this single render method serves both render modes.
*   - Widget data is fetched by `area_maintenance.prototype.get_value` (shared),
*     which calls the `dd_area_maintenance_api` / `get_widget_value` action and
*     returns the `add_hierarchy::get_value()` payload:
*       {
*         hierarchies              : Array   – available hierarchy file descriptors
*         installed_hierarchies    : Array   – hierarchies whose term data is imported (each has a `tld` property)
*         hierarchy_files_dir_path : string  – server-side path shown for reference
*         hierarchy_typologies     : Array   – grouping categories for the hierarchy list
*       }
*   - The actual import UI (checkbox list + "Import hierarchies" button) is
*     rendered by `render_hierarchies_import_block` from `render_installer.js`,
*     which is shared between the install wizard and this widget.
*
* Exported symbols:
*   - render_add_hierarchy  (constructor, prototype assigned to add_hierarchy)
*/
export const render_add_hierarchy = function() {

	return true
}//end render_add_hierarchy



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
*		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_add_hierarchy.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* GET_CONTENT_DATA_EDIT
* Builds the inner content DOM tree for the add_hierarchy widget.
*
* Responsibilities:
*   1. Reads the widget's current value (populated by `add_hierarchy.get_value`
*      via the shared `area_maintenance.prototype.get_value` method).
*   2. Flattens the `installed_hierarchies` array into a plain lowercase-TLD array
*      so that `render_hierarchies_import_block` can mark already-installed
*      hierarchies without performing a deep object comparison.
*   3. Defines a post-import callback (`fn_callback`) that appends a "Reload"
*      button to `body_response` after a successful import, triggering a
*      content-only widget refresh.
*   4. Delegates the hierarchy checkbox list and import button to
*      `render_hierarchies_import_block` (shared with the install wizard).
*   5. Appends a `body_response` div after the import block to receive
*      post-import feedback and the reload button injected by `fn_callback`.
*
* Data shape expected in `self.value`:
*   {
*     hierarchies              : Array<{label:string, tld:string, typology:number, has_data:boolean}>  // hierarchy.json client view
*     installed_hierarchies    : Array<{tld:string, ...}>  // <tld>1 term data present, or an active empty-by-design thesaurus
*     hierarchy_files_dir_path : string
*     hierarchy_typologies     : Array<{label:string, typology:number}>
*   }
*
* (!) `fn_callback` closes over `body_response`, which is only appended to
*     `content_data` AFTER the callback is defined. The reference is resolved at
*     call time (not definition time), so the closure is safe — but take care
*     when reordering DOM construction below.
*
* @param {Object} self - The `add_hierarchy` widget instance (carries `self.value`).
* @returns {HTMLElement} content_data - Root div containing the hierarchy import UI.
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value = self.value || {}

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data add_hierarchy_content'
		})

	// section heading (kit eyebrow — matches the other maintenance widgets)
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'dd_eyebrow',
			inner_html		: get_label.import_hierarchies || 'Import hierarchies',
			parent			: content_data
		})

	// short vars
		const hierarchies				= value.hierarchies
		const hierarchy_files_dir_path	= value.hierarchy_files_dir_path
		const hierarchy_typologies		= value.hierarchy_typologies
		const installed_hierarchies			= []
		const installed_hierarchies_length	= value.installed_hierarchies?.length
		// Flatten installed_hierarchies objects to lowercase TLD strings.
		// render_hierarchies_import_block uses Array.includes() for installed-state detection,
		// so a plain string array is required (not the full server objects).
		for (let i = 0; i < installed_hierarchies_length; i++) {
			const item = value.installed_hierarchies[i]
			if (item.tld) {
				installed_hierarchies.push( item.tld.toLowerCase() )
			}else{
				// Guard: items without a tld property are skipped to avoid pushing
				// undefined into the array, which would break the includes() check.
				console.error('Ignored empty tld item from installed_hierarchies:', item);
			}
		}

	// callback. If exec on success
		// This function is called by render_hierarchies_import_block after a fully
		// successful import. It adds a "Reload" button so the operator can refresh
		// the widget without a full page reload.
		function fn_callback(api_response) {
			// add button refresh
			const button_refresh = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'light button_refresh',
				inner_html		: get_label.reload || 'Reload',
				parent			: body_response
			})
			button_refresh.addEventListener('click', function(e) {
				e.stopPropagation()

				// render_level:'content' swaps only content_data, avoiding a full DOM rebuild.
				// destroy:true ensures old event listeners are cleaned up before re-render.
				self.refresh({
					build_autoload	: false,
					render_level	: 'content',
					destroy			: true
				})
			})
		}

	// hierarchies_import_node. It built from render_installer because is the same rendered.
		// Passes the flattened installed_hierarchies array and the post-import callback.
		// default_checked is empty ([]) so no hierarchies are pre-selected on open —
		// the operator must explicitly choose which ones to import.
		const hierarchies_import_options = {
			hierarchies					: hierarchies,
			installed_hierarchies		: installed_hierarchies,
			hierarchy_files_dir_path	: hierarchy_files_dir_path,
			hierarchy_typologies 		: hierarchy_typologies,
			default_checked				: [],
			callback					: fn_callback,
			// live name/TLD filter — admins locate a hierarchy in the long list fast
			show_filter					: true,
			// Route the import through the maintenance widget action (widget_request →
			// add_hierarchy::install_hierarchies), NOT the install-wizard surface
			// (dd_utils_api:install), which 404s once the instance is sealed.
			import_request				: {
				dd_api	: 'dd_area_maintenance_api',
				action	: 'widget_request',
				source	: {
					type	: 'widget',
					model	: 'add_hierarchy',
					action	: 'install_hierarchies'
				}
			},
			// Destructive "Reset to seed" for already-installed hierarchies (import skips
			// those; this re-seeds them). Routes to add_hierarchy::reset_hierarchies.
			reset_request				: {
				dd_api	: 'dd_area_maintenance_api',
				action	: 'widget_request',
				source	: {
					type	: 'widget',
					model	: 'add_hierarchy',
					action	: 'reset_hierarchies'
				}
			}
		}
		const hierarchies_import_node = render_hierarchies_import_block(hierarchies_import_options)
		content_data.appendChild(hierarchies_import_node)

	// body_response
		// Placeholder div that receives dynamic content after a successful import
		// (the "Reload" button injected by fn_callback above).
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})
		// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit



// @license-end
