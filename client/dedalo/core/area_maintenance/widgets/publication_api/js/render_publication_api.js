// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {object_to_url_vars} from '../../../../common/js/utils/index.js'



/**
* RENDER_PUBLICATION_API
* Client-side render module for the `publication_api` maintenance widget.
*
* This widget is the administrative view of Dédalo's publication server API
* configuration. It gives maintenance administrators two things:
*
*   1. One "Open Swagger UI" button per configured API web user (entry in
*      `API_WEB_USER_CODE_MULTIPLE`). Each button opens the Swagger interactive
*      documentation UI for that API endpoint in a new browser tab, passing the
*      database name, access code, and current UI language as query parameters.
*      The Swagger UI URL is taken from the per-entry `api_ui` property when
*      present (off-server publication endpoints) and falls back to the default
*      `DEDALO_ROOT_WEB`-relative path `publication/server_api/v1/docu/ui/`.
*
*   2. A `<pre>` block with a pretty-printed JSON dump of the full `value`
*      object (the diffusion configuration snapshot populated by the server in
*      `class.area_maintenance.php`). This lets admins verify live runtime
*      values such as `dedalo_diffusion_domain`, `dedalo_diffusion_langs`,
*      `dedalo_diffusion_resolve_levels`, and the `diffusion_map` network probe
*      results without leaving the maintenance area.
*
* Widget data flow:
*   widget_common.load() → `self.value` is populated with a diffusion config
*   snapshot from the server → widget_common.render() →
*   render_publication_api.prototype.list(options) →
*   get_content_data_edit(self) returns a content_data <div> →
*   ui.widget.build_wrapper_edit wraps it into the final widget wrapper.
*
* `self.value` shape (set by `class.area_maintenance.php`):
* {
*   dedalo_diffusion_domain       : string,   // DEDALO_DIFFUSION_DOMAIN constant
*   dedalo_diffusion_resolve_levels: number,  // DEDALO_DIFFUSION_RESOLVE_LEVELS constant
*   dedalo_diffusion_langs        : string[], // DEDALO_DIFFUSION_LANGS constant
*   api_web_user_code_multiple    : Array<{   // API_WEB_USER_CODE_MULTIPLE constant
*     db_name : string,  // target publication database name, e.g. 'web_my_entity'
*     code    : string,  // authentication token for the publication API
*     api_ui  : string|null // optional override URL for the Swagger UI; null → use default
*   }>,
*   diffusion_map: Object  // result of diffusion_utils::get_diffusion_map() with connection status
* }
*
* @module render_publication_api
*/



/**
* RENDER_PUBLICATION_API
* Constructor function (empty shell). Follows the Dédalo prototype-assign
* pattern: render methods are attached to `render_publication_api.prototype`
* below and then copied onto `publication_api.prototype` in
* `publication_api.js` (both `edit` and `list` are mapped to `list` here).
* @returns {boolean} Always true — nothing to initialise in the constructor.
*/
export const render_publication_api = function() {

	return true
}//end render_publication_api



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
render_publication_api.prototype.list = async function(options) {

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
* Builds the inner content DOM for the publication_api widget.
*
* Produces a <div> containing:
*   - One "Open Swagger UI <db_name>" button for each entry in
*     `self.value.api_web_user_code_multiple`. Clicking a button builds a
*     query-string from the entry's `code`, `db_name`, and the current
*     application language (`page_globals.dedalo_application_lang`), then
*     opens the resulting Swagger UI URL in a new browser tab.
*   - A <pre> block rendering a full JSON dump of `self.value`, allowing
*     admins to inspect the complete diffusion configuration snapshot that
*     the server computed for this maintenance session (domain, langs,
*     resolve levels, diffusion map with live connection status).
*   - An empty `body_response` <div> appended after the dump. It exists as
*     a placeholder that callers or future code may use to display async
*     feedback; it is not populated by this render path.
*
* Swagger UI URL resolution (per entry):
*   - If `item.api_ui` is truthy: use it directly (supports off-server
*     publication endpoints, e.g. `https://dedalo.dev/dedalo/publication/...`).
*   - Otherwise: build the default URL as
*     `${DEDALO_ROOT_WEB}/publication/server_api/v1/docu/ui/`.
*     (!) `DEDALO_ROOT_WEB` is declared in the `/*global*\/` directive at the
*     top of this file but is NOT listed there — it is injected by
*     `environment.js.php` as a plain JS variable, not via page_globals, so
*     it is a legitimate global reference even though eslint-no-undef will
*     flag it.
*
* @param {Object} self - The `publication_api` widget instance. The method
*   reads `self.value` (an object) and `self.value.api_web_user_code_multiple`
*   (an Array of API user entries). Both default to empty safely.
* @returns {Promise<HTMLElement>} content_data - A <div> containing the per-
*   database Swagger buttons, the config JSON dump, and the body_response
*   placeholder; intended to be passed to `ui.widget.build_wrapper_edit`.
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value							= self.value || {}
		const api_web_user_code_multiple	= value.api_web_user_code_multiple || []

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// api_web_user_code_multiple iterate
	// Each entry represents one configured publication database endpoint; we
	// render one Swagger UI launch button per entry.
		const api_web_user_code_multiple_length = api_web_user_code_multiple.length
		for (let i = 0; i < api_web_user_code_multiple_length; i++) {

			const item = api_web_user_code_multiple[i]

			// button_open
			// Opens the Swagger interactive documentation UI for this database's
			// publication API in a new tab. Label includes the db_name so admins
			// can distinguish entries at a glance in multi-database setups.
				const button_open = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'light',
					text_content	: `Open Swagger UI ${item.db_name}`,
					parent			: content_data
				})
				// click event
				// A dedicated handler variable is used (rather than an inline arrow
				// passed directly) so a reference is held for potential future
				// removeEventListener calls.
				const click_handler = (e) => {
					e.stopPropagation()

					// url
					// Build the Swagger UI query-string: code authenticates the
					// request; db_name selects the target publication database;
					// lang ensures the UI renders labels in the current locale.
						const url_vars = object_to_url_vars({
							code	: item.code,
							db_name	: item.db_name,
							lang	: page_globals.dedalo_application_lang
						})

					// api_ui. Normally is in the same server, but it is possible to define other in config.php
					// (!) DEDALO_ROOT_WEB is a plain JS global injected by environment.js.php;
					// it is not in the /*global*/ list above, which causes eslint no-undef to
					// flag this line. Do NOT add it to the eslint comment unless it is also
					// added to the /*global*/ directive.
					const api_ui = item.api_ui
						? item.api_ui
						: `${DEDALO_ROOT_WEB}/publication/server_api/v1/docu/ui/`

					const url = api_ui + '?' + url_vars

					window.open(url)
				}
				button_open.addEventListener('click', click_handler)
		}

	// diffusion_values (from config file)
	// Pretty-print the full value object so admins can verify all diffusion
	// constants (domain, langs, resolve levels, diffusion_map connection probe)
	// that were active when area_maintenance rendered this widget.
		ui.create_dom_element({
			element_type	: 'pre',
			class_name		: '',
			text_content	: JSON.stringify(value, null, 2),
			parent			: content_data
		})

	// body_response
	// Empty placeholder <div> reserved for async feedback or future UI additions.
	// Currently unused by this render path.
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})
		// add at end body_response
		content_data.appendChild(body_response)


	return content_data
}//end get_content_data_edit


// @license-end
