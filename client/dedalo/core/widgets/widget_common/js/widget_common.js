// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



/**
* WIDGET_COMMON
* Base constructor and shared prototype methods for all Dédalo widget instances.
*
* Widgets are read-only, display-only elements used inside component_info fields.
* They aggregate dynamic computed data produced by a server-side widget class
* (a subclass of class.widget_common.php) and present it alongside configurable
* labels. Unlike regular components they never write data to the database directly.
*
* Every concrete widget (calculation, state, user_activity, …) inherits its
* lifecycle from this module by assigning widget_common.prototype methods onto its
* own prototype. The lifecycle mirrors the core component lifecycle:
*
*   init() → build() → render() → [refresh cycles] → destroy()
*
* Status values progress through:
*   'initializing' → 'initialized' → 'building' → 'built'
*
* Differences from component_common:
*   - `this.tipo` is always null (widgets are positioned by the parent component,
*     not by an independent ontology tipo).
*   - `this.model` is fixed to 'widget'.
*   - `this.ipo` carries the Input-Process-Output configuration array that drives
*     the widget's data sourcing and output structure.
*   - `this.name` carries the widget class name (e.g. 'calculation', 'state'),
*     used when the build method makes an API request for widget data.
*
* The build() method on this base handles the component_info autoload path:
* when the caller IS a component_info and `autoload === true` it fires a
* 'get_widget_data' request via dd_component_info and stores the resolved payload
* in `self.value`. Concrete widgets whose data needs a different loading strategy
* should override build() rather than extend this one.
*
* (!) The caller is the LIVE component_info instance, not its name — the test is
* `caller.model === 'component_info'`. Comparing `caller` against the STRING
* 'component_info' matched nothing, so this path never ran and every on-demand
* widget load was silently dead (the oh 'descriptors' Terms button in a section
* list rendered 'Total 0' forever). Gate: test/unit/component_info_widget_client.test.ts.
*
* Server peer:  core/widgets/widget_common/class.widget_common.php
* API handler:  core/api/v1/common/class.dd_component_info.php (action get_widget_data)
*
* Exported:
*   widget_common — base constructor (function, used via prototype assignment only)
*   widget_common.prototype.init
*   widget_common.prototype.build
*   widget_common.prototype.destroy  (from common)
*   widget_common.prototype.refresh  (from common)
*   widget_common.prototype.render   (from common)
*/



// imports
	import {data_manager} from '../../../common/js/data_manager.js'
	import {common} from '../../../common/js/common.js'
	import {ui} from '../../../common/js/ui.js'
	import {response_data} from '../../../common/js/api_error.js'



export const widget_common = function(){

	return true
}//end widget_common



/**
* COMMON FUNCTIONS
* Delegate core lifecycle methods to the shared base class common.
*
* Widgets do not need their own implementations of destroy, refresh, or render —
* those follow the same contract as every other Dédalo UI element, so the common
* prototypes are used directly:
*
*   destroy  — unsubscribes all event tokens in this.events_tokens, optionally
*              removes the DOM node, and marks status as 'destroyed'.
*   refresh  — tears down per-render dependencies, re-calls build() then render().
*   render   — dispatches to this.edit() or this.list() based on this.mode.
*
* Concrete widget constructors (calculation, state, etc.) assign widget_common
* methods onto their own prototypes in the same way, so every widget in the
* system ultimately shares these three implementations.
*/
// prototypes assign
	// lifecycle
	widget_common.prototype.destroy	= common.prototype.destroy
	widget_common.prototype.refresh	= common.prototype.refresh
	widget_common.prototype.render	= common.prototype.render



/**
* INIT
* Initialises a widget instance from the options bag supplied by the parent
* component or section renderer.
*
* Seeds all well-known widget properties so that downstream lifecycle methods
* (build, render) can assume they exist. Identical in structure to
* common.prototype.init but tailored to the widget property set:
*
*   - `tipo` is always set to null (widgets have no independent ontology tipo).
*   - `model` is always fixed to 'widget'.
*   - `ipo` carries the Input-Process-Output configuration array from the ontology.
*   - `name` carries the concrete widget class name, e.g. 'calculation'.
*   - `caller` is the parent component_info instance (object) or the string
*     'component_info' when the parent is identified by name only.
*
* Sets `this.is_init = true` as a one-shot guard: a second call on the same
* instance is treated as a programming error and logs a console error.  When
* SHOW_DEBUG is true, an alert() is also triggered to make the bug impossible to
* miss during development.
*
* (!) `alert()` is intentional debug behaviour — do not replace with console.warn.
*
* @param {Object} options - Widget initialisation options bag
* @param {string} options.id - Unique instance identifier string
* @param {string} options.section_tipo - Ontology tipo of the parent section (e.g. 'oh1')
* @param {string|number} options.section_id - Record identifier within the section
* @param {string} options.lang - Active language tag (e.g. 'lg-eng')
* @param {string} options.mode - Render mode: 'edit' | 'list' | 'search'
* @param {*} options.value - Pre-loaded widget data payload; null when autoload handles it
* @param {Array|null} options.datalist - Optional list-of-values for select-style widgets
* @param {Array|null} options.ipo - Input-Process-Output config array from the ontology
* @param {string} options.name - Concrete widget class name, e.g. 'calculation'
* @param {Object|null} options.properties - Instance-specific configuration properties from ontology
* @param {Object|string|null} options.caller - Parent instance or caller identifier string
* @returns {Promise<boolean>} Resolves to true on success; false if already initialised
*/
widget_common.prototype.init = async function(options) {

	const self = this

	// safe init double control. To detect duplicated events cases
		if (typeof this.is_init!=='undefined') {
			console.error('Duplicated init for element:', this);
			if(SHOW_DEBUG===true) {
				alert('Duplicated init element');
			}
			return false
		}
		this.is_init = true

	// status update
		self.status = 'initializing'

	// set vars
		self.id				= options.id
		self.tipo			= null
		self.section_tipo	= options.section_tipo
		self.section_id		= options.section_id
		self.lang			= options.lang
		self.mode			= options.mode
		self.model			= 'widget'
		self.value			= options.value
		self.datalist		= options.datalist
		self.ipo			= options.ipo
		self.name			= options.name
		self.properties		= options.properties
		self.caller			= options.caller
		self.ar_instances	= [] // array of children instances of current instance (used for autocomplete, etc.)

	// status update
		self.status = 'initialized'


	return true
}//end init



/**
* BUILD
* Transitions the widget from 'initialized' to 'built' and, when autoload is
* requested for a component_info caller, fetches the widget's computed data from
* the server via the dd_component_info API action 'get_widget_data'.
*
* The component_info autoload path:
*   When the caller is a component_info (`caller.model === 'component_info'`, or
*   the legacy string 'component_info') and `autoload === true`, constructs a
*   Request Query Object (RQO) targeting the dd_component_info API handler and
*   awaits the response. If the response carries a truthy `result`, that value is
*   stored in `self.value` and subsequently passed to the render method.
*
*   RQO shape sent to the server:
*   {
*     action  : 'get_widget_data',
*     dd_api  : 'dd_component_info',
*     source  : {
*       tipo         : caller.tipo,         // component_info ontology tipo
*       section_tipo : caller.section_tipo, // owning section tipo
*       section_id   : caller.section_id,   // record id
*       mode         : self.mode            // 'edit' | 'list' | etc.
*     },
*     options : {
*       widget_name  : self.name  // e.g. 'calculation', 'state'
*     }
*   }
*
*   section_tipo / section_id fall back to the widget's own coordinates (seeded in
*   init) so the legacy string caller still resolves them. `tipo` has NO fallback —
*   a widget's own `self.tipo` is always null — so an unresolvable tipo is a
*   programming error: it logs a console.error and sends NOTHING. Sending empty
*   coordinates would earn a `result:false` envelope and paint an empty widget,
*   which is exactly the silent failure this path used to have.
*
* When `autoload === false` or the caller is not component_info, this method
* does nothing beyond the status update. Concrete widgets that need a different
* data-load strategy should override build() entirely.
*
* The commented-out CSS load block (load_style) is preserved intentionally —
* per-widget CSS loading was deferred and may be activated in the future.
*
* @param {boolean} [autoload=false] - When true, triggers an API request to
*   populate self.value before the widget is rendered.
* @returns {Promise<boolean>} Resolves to true once the widget reaches 'built' status
*/
widget_common.prototype.build = async function(autoload=false) {

	const self = this

	// status update
		self.status = 'building'

	// load self style
		// const tool_css_url = DEDALO_CORE_URL + '/widgets' + self.properties.path + "/css/" + self.name + ".css"
		// common.prototype.load_style(tool_css_url) // returns promise

	// autoload
		if (autoload===true) {

			// component_info caller cases
			// all component_info widgets are using this unified load data way
			// for convenience we place this API request in the common build
			// (!) The caller is the LIVE component_info instance (component_info.js
			// get_widgets passes 'caller : self'). The legacy string form is still
			// accepted, but it carries no component_info tipo, so it can only work
			// when the widget itself was seeded with usable coordinates.
			const caller_instance	= (self.caller && typeof self.caller==='object') ? self.caller : null
			const is_component_info	= caller_instance
				? caller_instance.model==='component_info'
				: self.caller==='component_info'
			if (is_component_info) {

				// coordinates. The component_info tipo is the widget's only anchor
				// and has no fallback (widget init sets self.tipo = null).
				const tipo			= caller_instance ? caller_instance.tipo : null
				const section_tipo	= (caller_instance ? caller_instance.section_tipo : null) ?? self.section_tipo
				const section_id	= (caller_instance ? caller_instance.section_id : null) ?? self.section_id

				// fail loud. Never send empty coordinates: the server would answer
				// result:false and the widget would silently render an empty value.
				if (!tipo || !section_tipo || section_id===null || section_id===undefined) {
					console.error('Error. Unable to resolve component_info coordinates for widget:',
						self.name, {tipo, section_tipo, section_id, caller:self.caller});
					self.status = 'built'
					return true
				}

				const rqo = {
					action	: 'get_widget_data',
					dd_api	: 'dd_component_info',
					source	: {
						tipo			: tipo,
						section_tipo	: section_tipo,
						section_id		: section_id,
						mode			: self.mode
					},
					options	: {
						widget_name	: self.name
					}
				}
				const api_response = await data_manager.request({
					body: rqo
				});

				const value = response_data(api_response)
				if(value) {
					self.value = value
				}

			}else{

				// let each widget handle its own data load overwriting this build
			}
		}

	// status update
		self.status = 'built'


	return true
}//end build



/**
* LOAD
* Unified lazy data loader for maintenance widgets. Fetches the widget value
* exactly once (guarded), then repaints the body content by re-rendering at
* render_level 'content' (common.render swaps node.content_data in place).
*
* The host (render_area_maintenance) calls this on widget "expose" (open) and,
* for declared background widgets, at idle priority while still collapsed.
* Widgets with no get_value (static, server-inlined value) are a no-op.
* Widgets that load something other than a get_value payload (e.g. an iframe or
* JSON editor) override this method.
*
* @return {Promise<boolean>} true when loaded / already loaded / not applicable
*/
widget_common.prototype.load = async function() {

	const self = this

	// guard: fetch only once per instance lifecycle
		if (self._load_state==='loading' || self._load_state==='loaded') {
			return true
		}

	// static widget (value inlined by server): nothing to fetch
		if (typeof self.get_value!=='function') {
			return true
		}

	self._load_state = 'loading'

	// loading feedback inside the current content node: after the node the
	// widget marked `.widget_load_slot` (where the loaded content will land),
	// else at the end
		const content_node = self.node ? self.node.content_data : null
		let spinner = null
		if (content_node) {
			spinner = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'spinner medium widget_load_spinner'
			})
			const slot = content_node.querySelector('.widget_load_slot')
			if (slot) {
				slot.after(spinner)
			} else {
				content_node.appendChild(spinner)
			}
		}

	try {

		self.error = null
		self.value = await self.get_value()

		// repaint content (spinner lives in the old content node, replaced here)
		if (self.node) {
			await self.render({ render_level : 'content' })
		}

		self._load_state = 'loaded'

	} catch (error) {
		self.error = error
		self._load_state = null // allow retry on next open
		if (spinner) {
			spinner.remove()
		}
		console.error('[widget load] ' + self.id + ':', error)
	}


	return true
}//end load



// @license-end
