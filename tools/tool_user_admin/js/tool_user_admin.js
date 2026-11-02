// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* TOOL_USER_ADMIN (module)
* Self-service user-profile editor tool.
*
* Allows the currently-authenticated user to update their own editable profile
* fields (full name, password, email, avatar image) without requiring admin access.
* Read-only fields (section id, username, profile role) are shown for context but
* cannot be modified through this tool.
*
* Architecture:
*   - Builds a live `section` instance targeting `dd128` (the users ontology section)
*     restricted to the current user's `page_globals.user_id`.
*   - Defines a hard-coded `ddo_map` that overrides the section's default request
*     config, mixing read-only entries (permissions:1) with fully editable ones.
*   - Each component is retrieved via `get_component()` and rendered independently
*     inside the tool wrapper produced by `render_tool_user_admin`.
*   - Demo installations (dedalo_entity==='dedalo_demo', username==='dedalo') are
*     blocked at the JS level; the server independently enforces the same restriction.
*
* Key ontology tipos used:
*   dd128  — users section
*   dd330  — section_id component (read-only)
*   dd132  — username component (read-only)
*   dd1725 — user profile/role component (read-only)
*   dd452  — full name component (editable)
*   dd133  — password component (editable)
*   dd134  — email component (editable)
*   dd522  — user avatar image component (editable)
*
* Exported symbols:
*   tool_user_admin — constructor; prototype methods assigned below.
*/



// import needed modules
	import {get_instance} from '../../../core/common/js/instances.js'
	import {common} from '../../../core/common/js/common.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_user_admin} from './render_tool_user_admin.js' // self tool rendered (called from render common)



/**
* TOOL_USER_ADMIN
* Self-service user-profile editor tool constructor.
*
* Allows the authenticated user to view and update their own profile fields
* (full name, password, email, avatar image) within the dd128 users section.
* Inherits its lifecycle (init/build/render/destroy/refresh) from tool_common
* and common via prototype assignment below.
*
* Instance properties follow the standard Dédalo tool contract; all are seeded
* to null here and populated during init/build.
*/
export const tool_user_admin = function () {

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
}//end tool_user_admin



/**
* COMMON FUNCTIONS
* Extend tool_user_admin with shared prototype methods from tool_common, common,
* and render_tool_user_admin.
*
* render/destroy/refresh/build_rqo_show come from the generic tool and component
* bases; edit/list are provided by render_tool_user_admin so the render layer
* can be maintained separately from the controller logic.
* Both 'edit' and 'list' modes delegate to the same render_tool_user_admin.edit
* implementation because this tool has a single display mode regardless of context.
*/
// prototypes assign
	tool_user_admin.prototype.render			= tool_common.prototype.render
	tool_user_admin.prototype.destroy			= common.prototype.destroy
	tool_user_admin.prototype.refresh			= common.prototype.refresh
	// others
	tool_user_admin.prototype.build_rqo_show	= common.prototype.build_rqo_show
	// render mode edit (default). Set the tool custom manager to build the DOM nodes view
	tool_user_admin.prototype.edit				= render_tool_user_admin.prototype.edit
	tool_user_admin.prototype.list				= render_tool_user_admin.prototype.edit



/**
* INIT
* Initialises the tool_user_admin instance.
*
* Delegates to tool_common.prototype.init, which seeds all standard tool
* properties (id, model, mode, caller, etc.) from the supplied options object.
* The placeholder comment below marks the intended location for any future
* tool-specific property overrides that tool_common does not cover.
*
* @param {Object} options - Standard tool init options (tipo, section_tipo,
*   section_id, mode, lang, caller, properties, …) as produced by the tool
*   launcher in tool_common.
* @returns {Promise<boolean>} Resolves to the result of tool_common.prototype.init
*   (true on success, false when a critical property is missing).
*/
tool_user_admin.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// set the self specific vars not defined by the generic init (in tool_common)

	return common_init
}//end init



/**
* BUILD
* Builds the tool_user_admin instance after init.
*
* Delegates the bulk of the work to tool_common.prototype.build (which loads
* tool CSS, resolves ddo_map items into live instances, and optionally fetches
* tool context from the API). After that, applies a demo-installation guard:
* if the current session belongs to the 'dedalo_demo' entity with the reserved
* 'dedalo' username, the tool is blocked by storing the error on `self.error`.
* The render layer (tool_common.prototype.render) detects a truthy `self.error`
* and displays an error view instead of the normal UI.
*
* (!) The server enforces the same demo guard independently; this client-side
* check is a UX layer only and must not be relied upon as the sole security
* control.
*
* @param {boolean} [autoload=false] - When true, tool_common.build immediately
*   triggers a data fetch; when false the caller controls when data is loaded.
* @returns {Promise<boolean>} Resolves to the return value of
*   tool_common.prototype.build (true on success).
*/
tool_user_admin.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// demo user case in demo installation. Generates and exception and control will be passed to the catch block
		// Note that the server security controls already handle this situation for added security
			const dedalo_entity	= page_globals.dedalo_entity
			const username		= page_globals.username
			if (dedalo_entity==='dedalo_demo' && username==='dedalo') {
				throw('Tool not allowed. dedalo_entity "dedalo_demo" cannot change user dedalo configuration')
			}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* GET_COMPONENT
* Instantiates, inits, and builds a single component for the user-profile form.
*
* Called by render_tool_user_admin.get_content_data for each entry in the ddo_map
* returned by get_ddo_map(). Each component is wired to:
*   - section_tipo 'dd128' (the users section, hardcoded)
*   - section_id from page_globals.user_id (the current authenticated user)
*   - data lang from page_globals.dedalo_data_lang
*   - caller set to `self` (this tool instance), which signals to the component
*     that it is running inside a tool rather than a normal section render, allowing
*     the component to suppress UI elements that only make sense in full section views
*
* The component is built with autoload=true so its data is fetched immediately
* and the returned instance is render-ready.
*
* @param {Object} ddo - A single ddo entry from get_ddo_map(); must contain at
*   minimum: tipo {string}, model {string}, mode {string}, properties {Object}.
* @returns {Promise<Object>} A fully built Dédalo component instance ready to call
*   render() on.
*/
tool_user_admin.prototype.get_component = async function(ddo) {

	const self = this

	// section_id
	const section_id = page_globals.user_id

	// section_tipo
	const section_tipo = 'dd128'

	// lang
	const lang = page_globals.dedalo_data_lang

	// instance_options (clone context and edit)
		const instance_options = {
			model				: ddo.model,
			mode				: ddo.mode,
			tipo				: ddo.tipo,
			section_tipo		: section_tipo,
			section_id			: section_id,
			lang				: lang,
			properties			: ddo.properties,
			caller				: self // set current tool as component caller (to check if component is inside tool or not)
		}

	// get instance and init
		const component_instance = await get_instance(instance_options)

	// build
		await component_instance.build(true)

	// ddo permissions override: can only LOWER the server's level (read-only
	// entries stay read-only for a global admin / root, whose stamp is higher)
		if (typeof ddo.permissions==='number') {
			// (a context-less build leaves no level: Number(…)||0 keeps it at 0, never NaN)
			component_instance.permissions = Math.min(Number(component_instance.permissions) || 0, ddo.permissions)
		}


	return component_instance
}//end get_component



/**
* GET_DDO_MAP
* Returns the static ddo_map that defines which user-profile components are
* shown in this tool and whether each is editable or read-only.
*
* The ddo_map is intentionally defined here (rather than fetched from the server
* request_config) so the tool has full control over which fields are exposed and
* their permissions, regardless of any server-side section configuration.
*
* Each entry follows the standard Dédalo ddo shape:
*   tipo         {string}  - ontology tipo identifying the component
*   type         {string}  - always 'component' here
*   typo         {string}  - always 'ddo' here
*   model        {string}  - JS component constructor name
*   section_tipo {string}  - always 'dd128' (users section)
*   parent       {string}  - always 'dd128' (direct child of users section)
*   mode         {string}  - always 'edit' (render in edit context)
*   properties   {Object}  - css override + show_interface flags (tools:false
*                            hides the component's own tool buttons, tools:true
*                            enables them — needed for the image upload tool)
*   permissions  {number}  - 1 = read-only override; omit = use normal ACL
*
* Read-only entries (permissions:1):
*   dd330  section id        (component_section_id)
*   dd132  username          (component_input_text)
*   dd1725 user profile/role (component_select)
*
* Editable entries (no permissions override, normal ACL applies):
*   dd452  full name         (component_input_text)
*   dd133  password          (component_password)
*   dd134  email             (component_email)
*   dd522  user avatar image (component_image — tools:true allows the upload tool)
*
* Commented-out entry:
*   dd170  projects/filter_master — disabled; kept for reference in case project
*          assignment display is needed in future iterations.
*
* @returns {Array} Array of ddo descriptor objects, one per component to render.
*/
tool_user_admin.prototype.get_ddo_map = function() {

	// section_tipo
	const section_tipo = 'dd128'

	const ddo_map = [
		// section id . read only (!)
		{
			tipo			: 'dd330', // section id . read only (!)
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_section_id',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'section_id',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			},
			permissions		: 1
		},
		// username . read only (!)
		{
			tipo			: 'dd132',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_input_text',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'User name',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			},
			// view			: 'line',
			permissions		: 1
		},
		// user profile . read only (!)
		{
			tipo			: 'dd1725',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_select',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'User profile',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			},
			// view			: 'line',
			permissions		: 1
		},
		// user full name . editable
		{
			tipo			: 'dd452',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_input_text',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'Full user name',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			}
		},
		// password . editable (read only for root: a self-change asks no current
		// password, and root has no emailed recovery — a hijacked root session could
		// lock the real root out for good. Until a re-authenticated change exists,
		// root's password is rotated outside this panel)
		{
			tipo			: 'dd133',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_password',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'Password',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			},
			...(page_globals.user_id > 0 ? {} : { permissions : 1 })
		},
		// email . editable
		{
			tipo			: 'dd134',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_email',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'email',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					tools : false
				}
			}
		},
		// projects . read only (!)
		// {
		// 	tipo			: 'dd170',
		// 	type			: 'component',
		// 	typo			: 'ddo',
		// 	model			: 'component_filter_master',
		// 	section_tipo	: section_tipo,
		// 	parent			: section_tipo,
		// 	// label		: 'Project',
		// 	mode			: 'edit',
		// 	properties		: {css:{}},
		// 	permissions		: 1
		// },
		// user image . editable (read only for root: media files are named by a
		// positive section_id, and root's record is dd128/-1 — an upload would fail)
		{
			tipo			: 'dd522',
			type			: 'component',
			typo			: 'ddo',
			model			: 'component_image',
			section_tipo	: section_tipo,
			parent			: section_tipo,
			// label		: 'User image',
			mode			: 'edit',
			properties		: {
				css:{},
				show_interface : {
					// allow necessary upload tool here
					tools : page_globals.user_id > 0
				}
			},
			...(page_globals.user_id > 0 ? {} : { permissions : 1 })
		}
	]


	return ddo_map
}//end get_ddo_map



/**
* BUILD_USER_SECTION
* Creates and returns a live `section` instance targeting the current user's
* record in the dd128 (users) section.
*
* This method is intentionally deferred — it is called only when the tool is
* rendered, not during init/build — so the section instance is not created
* until the UI is actually requested, improving startup performance.
*
* The section is constructed with a custom request_config that injects the
* ddo_map from get_ddo_map(), overriding the server-side section show config.
* This ensures only the tool-defined subset of user fields is fetched and rendered.
*
* Key construction details:
*   - section_id is coerced to string ('' + page_globals.user_id) because the
*     instances registry and API layer expect string ids.
*   - lang is page_globals.dedalo_data_nolan (language-neutral / no-language) so
*     that non-translatable fields like username and password render correctly.
*   - id_variant combines section_tipo + section_id + a stable suffix to ensure
*     the instance cache key is unique and does not collide with other usages of
*     dd128 that may exist in the session.
*   - filter and inspector are explicitly set to false on the returned section so
*     the tool UI does not expose section-level search or inspector controls.
*
* @returns {Promise<Object>} A fully initialised (but not yet built/rendered)
*   Dédalo section instance for the current user's dd128 record.
*/
tool_user_admin.prototype.build_user_section = async function() {

	const self = this

	// short vars
		const section_tipo	= 'dd128' // self.section_tipo
		const section_id	= '' + page_globals.user_id

	// ddo_map. Note that this ddo_map overwrite the default section request_config show ddo_map (!)
		const ddo_map = self.get_ddo_map()

	// request_config
		const request_config = [{
			api_engine	: 'dedalo',
			type		: 'main',
			show		: {
				ddo_map : ddo_map
			},
			sqo : {
				section_tipo	: [section_tipo],
				limit			: 1,
				offset			: 0
			}
		}]

	// context
		const instance_options = {
			type			: 'section',
			typo			: 'ddo',
			tipo			: section_tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: page_globals.dedalo_data_nolan,
			mode			: 'edit',
			model			: 'section',
			add_show		: true,
			caller			: self,
			request_config	: request_config,
			id_variant		: section_tipo +'_'+ section_id + '_build_user_section'
		}

	const section = await get_instance(instance_options)
		// filter search disallow
			section.filter = false
		// inspector disallow
			section.inspector = false


	return section
}//end build_user_section



/**
* ON_CLOSE_ACTIONS
* Executes cleanup when the tool is closed by the user.
*
* Called by the tool_common close handler with the display context that was
* used to open the tool. When the tool was opened as a modal overlay, the
* instance is destroyed (remove DOM, clear event listeners, unregister
* instances). When opened as a standalone window the window itself handles
* teardown, so this method does nothing beyond returning true.
*
* The commented-out `self.caller.refresh()` is deliberately disabled: calling
* refresh on the caller component_json would trigger an unnecessary server
* round-trip since user profile changes do not affect the calling context.
*
* @param {string} open_as - Display mode used when opening: 'modal' or 'window'.
* @returns {Promise<boolean>} Always resolves to true.
*/
tool_user_admin.prototype.on_close_actions = async function(open_as) {

	const self = this

	if (open_as==='modal') {
		// self.caller.refresh() // never refresh caller (component_json)
		self.destroy(true, true, true)
	}

	return true
}//end on_close_actions



// @license-end
