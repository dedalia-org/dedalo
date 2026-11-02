// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_user_admin */
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_USER_ADMIN
*
* Client-side render layer for tool_user_admin — the Dédalo tool that lets the
* currently logged-in user view and update their own profile data (full name,
* password, email, avatar) without navigating to the full section editor.
*
* The tool targets section dd128 (Users) and exposes a fixed subset of that
* section's components, some in read-only mode (section id, username, profile)
* and some as editable fields (full name, password, email, user image).
*
* Architecture:
*   This module is a pure render companion.  It does NOT define the tool
*   constructor — that lives in tool_user_admin.js.  Instead, it exports the
*   `render_tool_user_admin` constructor whose sole purpose is to carry the
*   `edit` prototype method.  tool_user_admin.js then mixes that method into
*   `tool_user_admin.prototype.edit` (and also `.list`) via prototype assignment.
*
*   render_tool_user_admin.prototype.edit
*     └── get_content_data (module-private)
*           └── self.get_ddo_map()  (defined in tool_user_admin.js)
*                 → self.get_component(ddo) per entry
*                       → component_instance.build(true) + .render()
*
* DOM structure produced by this module:
*   wrapper (ui.tool.build_wrapper_edit)
*     └── content_data (ui.tool.build_content_data)
*           └── components_container  .components_container
*                 ├── .component_column  ← rendered dd330 (section id, read-only)
*                 ├── .component_column  ← rendered dd132 (username, read-only)
*                 ├── .component_column  ← rendered dd1725 (user profile, read-only)
*                 ├── .component_column  ← rendered dd452 (full name, editable)
*                 ├── .component_column  ← rendered dd133 (password, editable)
*                 ├── .component_column  ← rendered dd134 (email, editable)
*                 └── .component_column  ← rendered dd522 (user image, editable)
*
* All component columns are created before any async rendering begins so that
* the insertion order matches the ddo_map order regardless of which Promise
* resolves first (see Promise.all approach in get_content_data).
*
* Exports:
*   {Function} render_tool_user_admin — Constructor; provides `.prototype.edit`.
*
* Dependencies:
*   - ui (core/common/js/ui.js) — DOM builder helpers.
*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {ACTIVE_STYLES, get_active_style, save_active_style} from '../../../core/page/js/active_style.js'



/**
* RENDER_TOOL_USER_ADMIN
* Constructor for the render prototype object.
*
* The body is intentionally empty (returns true as a no-op sentinel).
* All behaviour lives on `render_tool_user_admin.prototype.edit`.
*
* Usage in tool_user_admin.js:
*   tool_user_admin.prototype.edit = render_tool_user_admin.prototype.edit
*   tool_user_admin.prototype.list = render_tool_user_admin.prototype.edit
*
* @returns {boolean} true
*/
export const render_tool_user_admin = function() {

	return true
}//end render_tool_user_admin



/**
* EDIT
* Builds and returns the full tool wrapper DOM for the user-admin tool.
*
* This method is wired into both `tool_user_admin.prototype.edit` and
* `.list`, so the same DOM is produced in both edit and list modes.
* It is invoked automatically by `tool_common.prototype.render` once the
* tool has been initialised and built.
*
* Render levels:
*   - 'full' (default) — builds the complete wrapper shell via
*     `ui.tool.build_wrapper_edit` and embeds the content_data inside it.
*     `wrapper.content_data` is set as a convenience pointer.
*   - 'content' — skips the wrapper and returns only the content_data
*     node directly; used for partial refreshes where the outer chrome
*     already exists.
*
* @param {Object} options - Render configuration.
* @param {string} [options.render_level='full'] - 'full' or 'content'.
* @returns {Promise<HTMLElement>} The tool wrapper element (render_level 'full')
*   or the content_data element (render_level 'content').
*/
render_tool_user_admin.prototype.edit = async function(options) {

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
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Module-private helper that builds and returns the content_data DOM node
* containing all rendered user-profile components.
*
* Strategy:
*   1. A DocumentFragment is used as a staging area so that all DOM work
*      stays off-document until the fragment is appended to content_data.
*   2. A `.component_column` div is pre-created for each ddo entry (in map
*      order) before any async work begins.  This guarantees that components
*      always appear in the order defined by get_ddo_map(), even though the
*      individual component instances are built and rendered concurrently via
*      Promise.all.
*   3. Each component is obtained via `self.get_component(ddo)` (defined in
*      tool_user_admin.js), which calls get_instance + build internally.
*      The rendered node is appended directly into the pre-allocated column.
*   4. Finally, `ui.tool.build_content_data` creates the standard
*      content_data wrapper, the fragment is appended, and the node is
*      returned to the caller.
*
* @param {Object} self - The tool_user_admin instance (used as `this` context).
* @returns {Promise<HTMLElement>} The populated content_data DOM element.
*/
const get_content_data = async function(self) {

	const fragment = new DocumentFragment()

	// components container
		const components_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'components_container',
			parent 			: fragment
		})

	// build every component as a loadable item
		const ddo_map = self.get_ddo_map()

		// Create columns first to maintain order
		// Pre-allocating columns before the async fan-out ensures that
		// DOM insertion order mirrors ddo_map order even when individual
		// component.render() Promises resolve out-of-order.
		const columns = ddo_map.map(() => ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'component_column',
			parent 			: components_container
		}))

		// Load and render components in parallel
		// Each ddo entry maps to one component_instance; building in parallel
		// reduces total wait time for the initial paint.
		await Promise.all(ddo_map.map(async (ddo, index) => {
			const component_instance = await self.get_component(ddo)
			const component_node = await component_instance.render()
			columns[index].appendChild(component_node)
		}))

	// active style switcher (the user's dd1206 UI preferences)
		fragment.appendChild( render_active_style_switcher() )

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* RENDER_ACTIVE_STYLE_SWITCHER
* One radio per ACTIVE_STYLES entry, each with a small preview of the look.
* A change applies at once and is saved to the user's own record.
* @returns {HTMLElement} fieldset
*/
const render_active_style_switcher = function() {

	const fieldset = ui.create_dom_element({
		element_type	: 'fieldset',
		class_name		: 'active_style_switcher'
	})
	ui.create_dom_element({
		element_type	: 'legend',
		inner_html		: get_label.active_style || 'Active field style',
		parent			: fieldset
	})

	const current = get_active_style()
	for (const style of ACTIVE_STYLES) {

		const option = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'active_style_option',
			parent			: fieldset
		})
		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'radio',
			name			: 'active_style',
			value			: style.id,
			parent			: option
		})
		input.checked = style.id===current
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'active_style_preview preview_' + style.id,
			parent			: option
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'active_style_name',
			inner_html		: get_label[style.label] || style.id,
			parent			: option
		})

		input.addEventListener('change', async () => {
			fieldset.classList.add('loading')
			try {
				await save_active_style(style.id)
			} catch (error) {
				// applied for this browser all the same; the API error was already shown
				console.error('active style not saved:', error)
			} finally {
				fieldset.classList.remove('loading')
			}
		})
	}


	return fieldset
}//end render_active_style_switcher



// @license-end
