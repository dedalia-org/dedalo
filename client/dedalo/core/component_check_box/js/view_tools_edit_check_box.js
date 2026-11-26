// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_TOOLS_URL */
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'
	import {a11y} from '../../common/js/a11y.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {strip_tags, tool_base_url, same_section_id} from '../../common/js/utils/index.js'
	import {get_buttons} from './render_edit_component_check_box.js'



/**
* VIEW_TOOLS_EDIT_CHECK_BOX
* Edit-mode render view for the `tools` variant of `component_check_box`.
*
* This view is selected when `context.view === 'tools'` and is purpose-built for
* the security-tools profiles field (`dd1067`, `DEDALO_COMPONENT_SECURITY_TOOLS_PROFILES_TIPO`).
* Instead of the plain label-only layout used by the `default` view, it renders
* a two-column grid where each option row shows:
*   - A tool icon fetched from `<tool_base_url(tool_name)>/img/icon.svg`
*   - The option label (HTML-tag stripped, collator-sorted)
*   - A checkbox toggling the locator relation
*   - Optionally, a developer info badge (`[tool_name - section_id]`) when `SHOW_DEBUG` is true
*
* Additionally, a **Select all** master checkbox is prepended above the list so the
* user can enable or disable all non-disabled options in a single click.
*
* `always_active` options (tools that are mandatory for all users and profiles) render
* with the checkbox disabled and an `(* always_active)` annotation in their label.
* The master "Select all" checkbox skips disabled inputs when iterating.
*
* Data flow:
*   `self.data.datalist` — array of resolved option objects, each carrying
*     `{value:{section_id,section_tipo}, label, section_id, tool_name, always_active, tool_description}`.
*   `self.data.entries`  — array of currently selected locators (relations).
*   Changes are persisted immediately via `self.change_value` (inherited from
*   `component_common`) after every checkbox interaction, keeping the relation store
*   in sync with the UI state. The master "Select all" handler issues a bulk
*   `set_data` action rather than individual `insert`/`remove` actions.
*
* Exports:
*   `view_tools_edit_check_box` — namespace constructor (returns `true`).
*   `view_tools_edit_check_box.render` — async factory that builds the full DOM wrapper.
*
* @see render_edit_component_check_box (./render_edit_component_check_box.js)
*   — imports `get_buttons` and dispatches to this module for `view === 'tools'`.
* @see component_check_box (./component_check_box.js)
*   — parent controller that owns `self.data`, `self.context`, `self.permissions`.
* @see docs/core/components/component_check_box.md — full component specification.
*/
export const view_tools_edit_check_box = function() {

	return true
}//end view_tools_edit_check_box



/**
* RENDER
* Async factory that produces the full edit DOM tree for the `tools` view.
*
* Behaviour by `options.render_level`:
*   - `'content'` — returns only the `content_data` node (used by incremental
*     refresh paths that want to re-render the checkbox list without rebuilding
*     the outer wrapper, label, or buttons).
*   - `'full'` (default) — returns the complete `wrapper_component` node built by
*     `ui.component.build_wrapper_edit`, with `content_data` and an optional
*     `buttons_container` attached. A `view_tools` class is stamped on the wrapper
*     (via `wrapper.classList.add('view_' + self.context.view)`) to allow targeted
*     CSS for the two-column tool-icon layout.
*
* A pointer `wrapper.content_data` is set so that callers (e.g. refresh paths) can
* reach the inner content node directly from the wrapper without a DOM query.
*
* Permissions gate: the `buttons_container` (reset + list-open + tool buttons) is
* only built when `self.permissions > 1` (i.e. read+write or admin).
*
* @param {Object} self - Component instance. Must expose:
*   `self.data` {Object}, `self.context` {Object} (including `view`),
*   `self.permissions` {number}, and `self.change_value` {Function}.
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - `'full'` or `'content'`.
* @returns {Promise<HTMLElement>} The wrapper element (full) or content_data node (content).
*/
view_tools_edit_check_box.render = async function(self, options) {

	// render_level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			buttons			: buttons
		})
		wrapper.classList.add('view_'+self.context.view)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the full `content_data` DOM subtree for the `tools` view.
*
* This function:
* 1. Strips HTML tags (e.g. search `<mark>` highlights) from every `datalist`
*    item label — labels come pre-resolved by the server but may carry markup
*    from a search context; the tools view renders plain text only.
* 2. Re-sorts the cleaned datalist alphabetically using `Intl.Collator` for
*    locale-aware ordering (the server may deliver items in ontology/insertion
*    order rather than alphabetical).
* 3. Creates a `content_data` wrapper via `ui.component.build_content_data` with
*    `autoload:true` (triggers scroll-into-view / intersection-observer logic for
*    lazy-loaded components). The `nowrap` class prevents label text from wrapping
*    so rows stay on a single line.
* 4. Prepends a **Select all** master `<label>` + `<input type=checkbox>`.
*    Its `change` handler iterates every `.input_checkbox` that is not disabled
*    and not the master itself, syncs their `checked` state, and issues a single
*    bulk `set_data` changed_data action with the full array of selected locators
*    (or `null` when unchecking all). A no-op guard (`changed === false`) prevents
*    unnecessary server round-trips when the master checkbox is clicked but no
*    individual checkbox state actually changes.
* 5. Appends one `content_value` node per datalist item (built by `get_input_element`).
*    Numeric index pointers (`content_data[i]`) are set for direct O(1) access by
*    callers that need to reach a specific row without a DOM query.
*
* Mutates `datalist` items in place (strips `el.label`). This is intentional — the
* local copy is only used for rendering and is not persisted back to the server.
*
* @param {Object} self - Component instance. Must expose `self.data.datalist`,
*   `self.data.changed_data`, and `self.change_value`.
* @returns {HTMLElement} The populated `content_data` container.
*/
const get_content_data = function(self) {

	// short vars
		const datalist = self.data.datalist || []

	// datalist: prepare a clean list to render
		// remove html tags like <mark>
		datalist.map(el => {
			el.label = strip_tags(el.label)
			return el
		})
		// sort again by label
		datalist.sort((a, b) => new Intl.Collator().compare(a.label, b.label));

	// content_data
		const content_data = ui.component.build_content_data(self, {
			autoload : true
		})
		content_data.classList.add('nowrap')

	// activate all
		// label
			const option_label	= ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'input_label select_all',
				inner_html		: '<span>'+ (get_label.all || 'All') +'</span>',
				parent			: content_data
			})
		// input checkbox
			const input_checkbox = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				class_name		: 'input_checkbox'
			})
			option_label.prepend(input_checkbox)
			input_checkbox.addEventListener('change', async function(e) {

				const datalist_values = []

				let changed				= false
				const source			= e.target
				const checkboxes		= content_data.querySelectorAll('.input_checkbox');
				const checkboxes_length	= checkboxes.length
				for (let i = 0; i < checkboxes_length; i++) {

					const item = checkboxes[i]

					// ignore disabled inputs
					if (item.disabled || item===input_checkbox) {
						continue;
					}

					// check if checked status has changed
					if (changed===false && item.checked!==source.checked) {
						changed = true
					}

					// set new value
					item.checked = source.checked;

					// add to values list if is checked
					if (item.checked) {
						datalist_values.push( item.datalist_value )
					}
				}

				// if nothing has changed, stop here
					if (changed===false) {
						return
					}

				// change data to set empty value in the component (it saved in Session instead DDBB)
					const changed_data = [Object.freeze({
						action	: 'set_data',
						value	: datalist_values.length ? datalist_values : null
					})]

				// fix instance changed_data
					self.data.changed_data = changed_data

				// force to save on every change. Needed to recalculate the value keys
					await self.change_value({
						changed_data	: changed_data,
						refresh			: false
					})
			})//end change event

	// render datalist options
		const datalist_length = datalist.length
		for (let i = 0; i < datalist_length; i++) {

			const datalist_item = datalist[i]

			// do not render tool always_active, they are for all users and profiles
			// if(datalist_item.always_active){
				// continue
			// }

			const content_value_node = get_input_element(i, datalist_item, self)
			content_data.appendChild(content_value_node)
			// set the pointer
			content_data[i] = content_value_node
		}


	return content_data
}//end get_content_data



/**
* GET_INPUT_ELEMENT
* Builds one `content_value` row for a single datalist option in the `tools` view.
*
* Each row consists of (in DOM order):
*   1. A tool icon `<img>` prepended before the label
*      (`<tool_base_url(tool_name)>/img/icon.svg`). The URL is built via
*      `tool_base_url`, which checks `DEDALO_TOOLS_URLS[tool_name]` before
*      falling back to `DEDALO_TOOLS_URL + '/' + tool_name`.
*   2. A `<label class="input_label">` containing:
*      a. An `<input type=checkbox class="input_checkbox">` (prepended)
*      b. A `<span>` with the stripped label text
*   3. Optionally, a `<span class="developer_info show_on_active">` badge when
*      `SHOW_DEBUG === true`, showing `[tool_name - section_id]`.
*   4. When `tool_description` is non-empty: an info toggle (`.tool_info_toggle`,
*      role=button, aria-expanded) and a folded `.tool_description` text block
*      wrapping under the row. The toggle flips `.open` on the row and never
*      touches the checkbox.
*
* A non-enumerable property `input_checkbox.datalist_value` stores the locator
* `{section_id, section_tipo}` object directly on the DOM node so the master
* "Select all" handler can collect selected values without extra lookups.
*
* Checked state is determined by scanning `self.data.entries` for a locator whose
* `section_id` (strict equality `===`) and `section_tipo` (strict `===`) match the
* datalist item's `value` object.
*
* `always_active` flag handling: when `datalist_item.always_active` is truthy the
* checkbox is disabled and `(* always_active)` is appended to the label HTML.
* This prevents the user from removing tools that are mandatory for every profile.
* Note: the commented-out block above (`// input_checkbox.checked = 'checked'`)
* was an earlier approach that is intentionally left as dead code; do not remove it.
*
* Change event: delegates to `self.change_handler` (inherited from
* `component_common`) with the standard payload `{self, e, i, datalist_value,
* input_checkbox}`. `change_handler` will call `build_changed_data_item` and
* then `change_value` to persist the toggle immediately.
*
* Focus event: calls `ui.component.activate(self)` when `self.active` is false,
* so tabbing into a checkbox auto-activates the component (needed for keyboard
* navigation through the form).
*
* @param {number} i - Zero-based index of this item within the datalist.
* @param {Object} current_value - A single resolved datalist item with shape:
*   `{value:{section_id,section_tipo}, label, section_id, tool_name, always_active, tool_description}`.
* @param {Object} self - Component instance. Must expose `self.data.entries`,
*   `self.permissions`, `self.active`, `self.change_handler`, and `self.context`.
* @returns {HTMLElement} A `<div class="content_value">` ready to append into `content_data`.
*/
const get_input_element = (i, current_value, self) => {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || []
		const value_length		= entries.length
		const datalist_item		= current_value
		const datalist_value	= datalist_item.value
		const section_id		= datalist_item.section_id
		const tool_name			= datalist_item.tool_name
		const label				= datalist_item.label

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// label
		const option_label	= ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'input_label',
			inner_html		: '<span>'+render_value(label, 'text')+'</span>',
			parent			: content_value
		})

	// input checkbox
		const input_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'input_checkbox',
		})
		option_label.prepend(input_checkbox)
		// store the datalist locator on the DOM node so the Select-all handler can
		// collect selected values without an additional array lookup
		input_checkbox.datalist_value = datalist_value
		input_checkbox.addEventListener('focus', function() {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self)
			}
		})
		input_checkbox.addEventListener('change', function(e) {

			self.change_handler({
				self			: self,
				e				: e,
				i				: i,
				datalist_value	: datalist_value,
				input_checkbox	: input_checkbox
			})
		})//end change event
		// checked input_checkbox set on match
		// section_id compares type-tolerantly (same_section_id), section_tipo strictly
		for (let j = 0; j < value_length; j++) {
			if (entries[j] && datalist_value &&
				same_section_id(entries[j].section_id, datalist_value.section_id) &&
				entries[j].section_tipo===datalist_value.section_tipo
				) {
					input_checkbox.checked = 'checked'
			}
		}

	// do not render tool always_active, they are for all users and profiles
		if(datalist_item.always_active){
			// input_checkbox.checked = 'checked'
			input_checkbox.disabled = true
			option_label.innerHTML += ' (* always_active)'
		}

	// developer_info
		if(SHOW_DEBUG===true){
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'developer_info',
				text_content	: `[${tool_name} - ${section_id}]`,
				parent			: content_value
			})
		}


	// tool_description. Folded under the row (info toggle) so the panel stays
	// compact. Stored as HTML (register.json dd612): rendered as plain text.
		const description = datalist_item.tool_description
			// paragraph/line breaks survive as newlines (CSS pre-line)
			? strip_tags(datalist_item.tool_description.replace(/<\/p>|<br\s*\/?>/gi, '\n')).trim()
			: ''
		if (description.length>0) {
			const description_id = `tool_description_${self.id}_${i}`
			const button_info = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button info tool_info_toggle',
				title			: get_label.information || 'Information',
				aria			: {controls : description_id},
				parent			: content_value
			})
			a11y.make_activable(button_info, {
				expanded	: false,
				on_activate	: (e) => {
					e.stopPropagation()
					const open = content_value.classList.toggle('open')
					button_info.setAttribute('aria-expanded', String(open))
				}
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'tool_description',
				id				: description_id,
				inner_html		: render_value(description, 'text'),
				parent			: content_value
			})
		}

	// tool_icon
		const icon_url	= tool_base_url(tool_name) + '/img/icon.svg'
		const tool_icon	= ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'tool_icon',
			src				: icon_url
		})
		content_value.prepend(tool_icon)


	return content_value
}//end get_input_element



// @license-end
