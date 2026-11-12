// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global   */
/*eslint no-undef: "error"*/



/**
* RENDER_SECTION_GROUP
* Client-side renderer for `section_group` — a structural, non-data grouping element
* that visually organises a set of components within a section record.
*
* A `section_group` carries no data values of its own: it only contributes layout.
* Its children are rendered by `section_record` into the `content_data` container
* that this module creates and exposes via `wrapper.content_data`.
*
* Two ontology-driven sub-types exist on the server:
*   - Default (`section_group`)  — renders with a collapsible header label.
*   - `section_group_div`        — `context.add_label === false`; no header, no
*                                  collapse toggle, no top margin.
*
* Collapse state is persisted to IndexedDB (table 'status') so that the last
* open/closed position survives page reloads.  The IndexedDB key is
* `section_group_<section_tipo>_<tipo>`, guaranteeing uniqueness across all
* group instances on a given page.
*
* Context shape expected on `self.context` (populated by the server's
* src/core/resolve/structure_context.ts buildCore — `add_label` is stamped on
* every section_group entry, false iff the stored model is section_group_div):
*   {
*     label     : string,               // display label for the header
*     add_label : boolean,              // false → section_group_div variant
*     css       : Object|undefined      // optional structure-level style overrides
*   }
*
* CSS override shape (`context.css`):
*   {
*     label : string[],   // additional CSS class names applied to the header element
*     …                   // other selector fragments forwarded to set_element_css
*   }
*
* Exports: `render_section_group` (constructor; `edit` and `list` prototype methods).
*
* Prototype assignments onto `section_group` are performed in `section_group.js`:
*   section_group.prototype.edit = render_section_group.prototype.edit
*   section_group.prototype.list = render_section_group.prototype.list
*/



// imports
	import {data_manager} from '../../common/js/data_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {set_element_css} from '../../page/js/css.js'



/**
* RENDER_SECTION_GROUP
* Constructor function that acts as the prototype host for the `edit` and `list`
* rendering methods.  Instances are never created directly; the methods are aliased
* onto `section_group.prototype` at module load time.
*/
export const render_section_group = function() {

	return true
}//end render_section_group



/**
* EDIT
* Builds and returns the full DOM subtree for a `section_group` in edit (or list)
* mode.  When called with `render_level === 'content'` it returns only the bare
* `content_data` container so that callers can inject it at a custom insertion point
* without the outer wrapper and header.
*
* DOM structure produced (default path):
*   <div class="wrapper_section_group … edit">     ← get_wrapper()
*     <div class="label icon_arrow [up] …">        ← collapsible header (omitted for _div variant)
*     <div class="content_data … hide">            ← get_content_data(); hidden until state resolved
*
* The `content_data` element starts with the `hide` CSS class to avoid a flash of
* uncollapsed content during the async IndexedDB read.  `ui.collapse_toggle_track`
* applies the persisted state synchronously after the read resolves, so the
* momentary `hide` is typically invisible to the user.
*
* The `wrapper.content_data` property is set so that `section_record` can locate
* the correct insertion point when it iterates child component groups.
*
* Collapse indicator convention:
*   - Header has class `up`   → content_data is visible (open).
*   - Header lacks class `up` → content_data is hidden (collapsed).
* The callbacks passed to `ui.collapse_toggle_track` keep this class in sync.
*
* @param {Object} options - Render options object.
* @param {string} [options.render_level='full'] - Render depth.
*   'content' returns only the content_data div (skips wrapper, header, and state restore).
*   'full' (default) returns the complete wrapper with header and resolved collapse state.
* @returns {Promise<HTMLElement>} The outer wrapper element (full mode) or the bare
*   content_data div (content mode).
*/
render_section_group.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// collapsed_id (used to identify local DB records)
		// Key format guarantees uniqueness per group instance across all open sections.
		const collapsed_id		= `section_group_${self.section_tipo}_${self.tipo}`
		const collapsed_table	= 'status'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			// Early return: caller wants only the container, not the full rendered tree.
			return content_data
		}

	// section_group_div variant: no header, so no collapse toggle — it must never
		// consult a persisted collapse state (a stale 'collapsed' row, e.g. written
		// while the div wrongly rendered a header, would hide its content with no
		// way to reopen it). Always open.
		const is_div = self.context.add_label===false

	// content data state. Needed to prevent blink components show on page load
		// Reads the persisted collapse state from IndexedDB.
		// A missing record (undefined/null/false) means "open" (the default state).
		const ui_status = is_div
			? null
			: await data_manager.get_local_db_data(
				collapsed_id,
				collapsed_table
			  )
		if (!ui_status) {
			// No stored state (or stored state is falsy) → show content_data as open.
			content_data.classList.remove('hide')
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper =	get_wrapper(self)
		// set wrapper content data property (used as grouper selector from section_record)
		// (!) This is a plain expando property on the DOM node — not a standard attribute.
		wrapper.content_data = content_data

	// header (label)
		// section_group_div variant: context.add_label is explicitly false on the server.
		// In that case the group renders without a header and without top margin.
		if (is_div) {
			wrapper.classList.add('no_margin')
		}else{

			const component_label = ui.create_dom_element({
				element_type	: 'div',
				// 'up' indicates the open state; absent means collapsed.
				// (!ui_status) is true when the stored value is falsy → content is open → add 'up'.
				class_name		: 'icon_arrow' + (!ui_status ? ' up' : ''),
				inner_html		: self.label // + ' [' + self.tipo + ' - ' + self.permissions + ']'
			})
			// CSS
				// Apply any structure-level CSS class overrides from the ontology descriptor.
				// element_css.label is an array of additional class names for the header element.
				const element_css = self.context.css || {}
 				const label_structure_css = typeof element_css.label!=="undefined" ? element_css.label : []
				const ar_css = ['label', ...label_structure_css]
				component_label.classList.add(...ar_css)

			// collapse_toggle_track
				// Callbacks keep the arrow icon direction in sync with collapse state.
				// 'up' class on the label means the panel is open (arrow points up).
				const collapse = function() {
					component_label.classList.remove('up')
				}
				const expose = function() {
					component_label.classList.add('up')
				}
				// Wire the click toggle and restore the persisted open/closed state.
				// default_state is 'opened' (omitted here, so ui uses its own default),
				// meaning the record is deleted from IndexedDB when the panel is opened —
				// only the collapsed state is actively stored.
				ui.collapse_toggle_track({
					toggler				: component_label,
					container			: content_data,
					collapsed_id		: collapsed_id,
					collapse_callback	: collapse,
					expose_callback		: expose
				})

			// add component_label
				wrapper.appendChild(component_label)
		}

	// content_data
		wrapper.appendChild(content_data)


	return wrapper
}//end edit



/**
* LIST
* Alias of `edit`. `section_group` renders identically in list and edit modes
* because it is a structural container with no editable data of its own.
* @returns {Promise<HTMLElement>} See `edit`.
*/
render_section_group.prototype.list = render_section_group.prototype.edit;



/**
* GET_WRAPPER
* Creates and returns the outer wrapper `<div>` for a `section_group` instance.
*
* Class name composition (space-separated):
*   `wrapper_<type>`           — e.g. `wrapper_section_group`
*   `<model>`                  — ontology model name (e.g. `section_group`)
*   `<tipo>`                   — ontology identifier (e.g. `oh1_rsc127`)
*   `<section_tipo>_<tipo>`    — fully-qualified scoped selector for CSS overrides
*   `<mode>`                   — current render mode (e.g. `edit`, `list`)
*
* If `self.context.css` is present, the CSS override descriptor is injected into
* the shared dynamic stylesheet via `set_element_css`, scoped to a selector of
* the form `<section_tipo>_<tipo>.edit`.  This is the v6-compatible "new way"
* of applying structure-level style rules — the comment "css new way v6" refers
* to the migration from inline `style` attributes to a shared stylesheet.
*
* (!) `set_element_css` is async but its return value is intentionally discarded
* here.  The rules are queued via `requestAnimationFrame` inside that function
* and will be applied before the next paint; there is no need to await them.
*
* @param {Object} self - The `section_group` instance (provides type, model, tipo,
*   section_tipo, mode, and context).
* @returns {HTMLElement} The newly created wrapper div.
*/
const get_wrapper = function(self) {

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type : 'div',
			class_name : `${'wrapper_'+self.type} ${self.model} ${self.tipo} ${self.section_tipo+'_'+self.tipo} ${self.mode}`
		})

	// css new way v6
		// Inject structure-level CSS overrides into the shared dynamic stylesheet.
		if (self.context.css) {
			const selector = `${self.section_tipo}_${self.tipo}.edit`
			set_element_css(selector, self.context.css)
		}

	return wrapper
}//end get_wrapper



/**
* GET_CONTENT_DATA
* Creates and returns the inner container `<div>` into which child components are
* rendered by `section_record`.
*
* The element is created with the `hide` CSS class pre-applied so that it starts
* invisible.  The caller (`edit`) removes `hide` once the IndexedDB collapse state
* is resolved, avoiding a flash of uncollapsed content during the async read.
*
* Class names applied: `content_data`, `<self.type>` (e.g. `section_group`), `hide`.
*
* @param {Object} self - The `section_group` instance (provides `type`).
* @returns {HTMLElement} The newly created content_data div (initially hidden).
*/
const get_content_data = function(self) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.type, 'hide')

	return content_data
}//end get_content_data



// @license-end
