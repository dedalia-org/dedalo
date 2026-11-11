// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_LANG_MULTI
* Client-side render layer for the multi-language translation tool.
*
* Responsibilities:
* - Build the full editing UI that shows every configured project language
*   simultaneously, one language slot per column (`target_component_container`).
* - Wire the per-slot and batch "translate" buttons to the translation engine
*   (browser AI or server-side service).
* - Maintain two instance-level maps on `self` that are shared with
*   `tool_lang_multi.js` methods:
*     · `self.lang_containers` — lang-value → target_component_container (for CSS highlights)
*     · `self.lang_components` — lang-value → loaded component instance (for reads/writes)
* - Track which language slot is the active translation source and update
*   the visual highlight via `set_source_lang()`.
*
* Module layout:
*   render_tool_lang_multi (constructor, exported) — placeholder constructor; edit()
*     is attached to the prototype and delegated from tool_lang_multi.prototype.edit.
*   get_content_data_edit (private) — builds the full content DOM: top bar
*     (translate-all button + engine selector), status banner, and all language slots.
*   create_target_component (exported) — creates one language column with its
*     spinner, streaming overlay, source-tracking listeners, and per-slot translate
*     button.
*   is_component_empty (exported) — emptiness predicate used before asking for
*     overwrite confirmation.
*   build_automatic_translation (private) — builds the engine-selector `<select>`
*     and device-mode checkbox sub-panel.
*
* Both `create_target_component` and `is_component_empty` are also imported by
* tool_lang_multi.js, which is why they are named exports rather than closures.
*
* @module render_tool_lang_multi
*/

// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {append_engine_selector} from '../../tool_lang/js/translator_engine_select.js'



/**
* RENDER_TOOL_LANG_MULTI
* Render namespace constructor for the multi-language translation tool.
* Instantiated once; `edit()` is the sole prototype method and is delegated
* from `tool_lang_multi.prototype.edit` (see tool_lang_multi.js).
* @returns {boolean} true
*/
export const render_tool_lang_multi = function() {

	return true
}//end render_tool_lang_multi



/**
* EDIT
* Render the tool in edit mode. Optionally returns just the inner content
* node (when `options.render_level === 'content'`) or the full wrapped
* component node.
*
* Called via `tool_lang_multi.prototype.edit` (prototype delegation).
* `this` is the `tool_lang_multi` instance.
*
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - 'full' builds the wrapper
*   around the content; 'content' returns the raw content_data node for
*   embedding inside an existing container.
* @returns {Promise<HTMLElement>} The component wrapper (render_level 'full')
*   or the content_data element (render_level 'content').
*/
render_tool_lang_multi.prototype.edit = async function (options={}) {

	const self = this

	// options
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


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build and populate the full edit-mode content node.
*
* Creates the top action bar (translate-all button + engine selector sub-panel),
* a shared status/progress banner, and the scrollable column grid of language
* slots. Initialises `self.lang_containers` and `self.lang_components` to empty
* maps that are progressively filled as each slot's async spinner resolves.
*
* The translate-all button and engine selector render only when the tool context
* carries a `translator_engine` (tool_lang's config, via the server's configFrom).
*
* @param {Object} self - The `tool_lang_multi` instance.
* @returns {Promise<HTMLElement>} The populated content_data element.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// lang_containers. Map of lang value -> target_component_container (used for source highlight)
		self.lang_containers = {}
	// lang_components. Map of lang value -> component instance (used as translation source/target)
		self.lang_components = {}

	// top_container
		const top_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'top_container',
			parent			: fragment
		})

	// translator_engine config (from tool config section)
		const translator_engine = self.context?.config?.translator_engine?.value ?? false

	// automatic_translation. Only when an engine is configured (tool_lang's config,
	// served through configFrom) — never a button that does nothing.
		if (translator_engine) {
			// icon
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button icon lang black',
				parent			: top_container
			})
			// button (one click translate to all languages). Alt+click overwrites without modal.
			const button_automatic_translation = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'warning button_automatic_translation',
				inner_html		: self.get_tool_label('automatic_translation') || 'Automatic translation',
				parent			: top_container
			})
			button_automatic_translation.addEventListener('click', function(e){
				e.stopPropagation()
				self.automatic_translation_all({ event: e })
			})
			top_container.appendChild(build_automatic_translation({
				self				: self,
				translator_engine	: translator_engine
			}))
		}//end if (translator_engine)

	// status_container. Shared progress/status messages for the translate-all action
		self.status_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'status_container hide',
			parent			: top_container
		})

	// components container
		const components_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_container',
			parent			: fragment
		})

	// components list (source and targets)
		const langs_length = self.langs.length
		for (let i = 0; i < langs_length; i++) {
			const current_lang = self.langs[i] // object as {label:Spanish,value:lg-spa}
			const target_component_container = create_target_component(current_lang, self)
			components_container.appendChild(target_component_container)
		}

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* CREATE_TARGET_COMPONENT
* Build one language column: title bar, spinner placeholder, streaming overlay,
* source-tracking event listeners, and (when configured) a per-slot translate
* button injected into the rendered component's buttons fold.
*
* The function returns immediately after the container skeleton is created; the
* actual component load happens asynchronously inside `ui.load_item_with_spinner`.
* Once the async callback resolves, the spinner is replaced with the live
* component node and the streaming overlay / translate button are wired up.
*
* Side effects on `self`:
* - `self.lang_containers[lang.value]` is set to the returned container so that
*   `set_source_lang()` can toggle the `.source` / `.bold` CSS classes.
* - `self.lang_components[lang.value]` is set (inside the async callback) once
*   the component instance has been loaded and rendered.
*
* The returned container element also has two non-standard properties attached
* for the streaming use-case:
* - `container.streaming_overlay`         — the overlay `<div>`
* - `container.streaming_overlay_content` — the inner content `<div>`
*
* @param {Object} lang - Language descriptor from `page_globals.dedalo_projects_default_langs`.
* @param {string} lang.label - Human-readable label, e.g. 'English'.
* @param {string} lang.value - BCP 47-style language code, e.g. 'lg-eng'.
* @param {Object} self - The `tool_lang_multi` instance.
* @returns {HTMLElement} target_component_container — the column root element
*   (with the spinner already inserted; the component node replaces it later).
*/
export const create_target_component = (lang, self) => {

	// target_component_container
		const target_component_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'target_component_container'
		})

	// register container for source highlighting
		self.lang_containers[lang.value] = target_component_container

	// target_component_title
		const target_component_title = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'target_component_title',
			inner_html		: lang.label,
			parent			: target_component_container
		})

	// source highlight. Mark the current source lang
		if (lang.value===self.source_lang) {
			target_component_container.classList.add('source')
			target_component_title.classList.add('bold')
		}

		// load component gracefully
		ui.load_item_with_spinner({
			container			: target_component_container,
			preserve_content	: true,
			label				: lang.label,
			callback			: async () => {

				// component load (init and build component)
					const component = await self.get_component(lang.value)
					component.show_interface.tools = false
					self.lang_components[lang.value] = component
					// render node
					const node = await component.render({
						render_mode : 'edit'
					})

				// source tracking. EDITING this component makes it the source. Focus alone
				// does not: activating a slot to use its own translate button must keep it
				// a target.
					node.addEventListener('input', () => {
						self.set_source_lang(lang.value)
					})

				// streaming overlay (used by the browser engine while translating)
					const streaming_overlay = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'streaming_overlay hide',
						parent			: target_component_container
					})
					const streaming_overlay_content = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'streaming_overlay_content',
						parent			: streaming_overlay
					})
					target_component_container.streaming_overlay			= streaming_overlay
					target_component_container.streaming_overlay_content	= streaming_overlay_content


				// translator_engine. One-lang translation: the component's own button
				// (buttons_fold) translates the current source into THIS lang
					const translator_engine = self.context?.config?.translator_engine?.value ?? false
					if (translator_engine) {
						const buttons_fold = node.querySelector('.buttons_fold')
						if (buttons_fold) {
							const button_translate = ui.create_dom_element({
								element_type	: 'span',
								class_name		: 'button lang',
								title			: self.get_tool_label('automatic_translation') || 'Automatic translation',
								parent			: buttons_fold
							})
							const fn_click = async function(e) {
								e.stopPropagation()

								// skip translating into the current source lang
									const source_lang = self.resolve_source_lang(lang.value)
									if (lang.value===source_lang) {
										return
									}
								// never translate a blank source: it would blank the target
									if (is_component_empty(self.lang_components?.[source_lang])) {
										ui.show_message(self.status_container, self.get_tool_label('empty_source') || 'Source text is empty', 'error', 'component_message', true)
										return
									}

								// non empty value cases generates a confirm dialog
									if (is_component_empty(component)===false) {
										if(!confirm(self.get_tool_label('are_you_sure_to_overwrite_text') || 'Are you sure to overwrite the current value?')) {
											return
										}
									}

								self.set_slot_busy(target_component_container, true)

								try {
									await self.translate_target({
										target_lang			: lang.value,
										source_lang			: source_lang,
										target_component	: component,
										container			: target_component_container,
										translator_engine	: translator_engine
									})
								} catch (error) {
									console.error('translate_target error:', error)
								}
								self.set_slot_busy(target_component_container, false)
							}//end fn_click
							button_translate.addEventListener('click', fn_click)
						}
					}//end translator_engine

				return node
			}
		})//end ui.load_item_with_spinner


	return target_component_container
}//end create_target_component



/**
* IS_COMPONENT_EMPTY
* Check whether a component instance has no meaningful value.
*
* A component is considered empty when its `data.entries` array (v7) is absent,
* zero-length, or contains only items whose resolved text is blank after
* trimming. Both plain-string items (e.g. component_input_text) and object
* items with a `.value` string property (e.g. component_text_area entries)
* are handled by the same predicate.
*
* Used before showing the overwrite-confirmation dialog: if the target slot
* is already empty there is nothing to overwrite and the confirm can be
* skipped safely.
*
* @param {Object} component - A loaded Dédalo component instance. Must expose
*   `component.data.entries` (v7: Array of {id, lang, value}).
* @returns {boolean} true when the component contains no non-blank text.
*/
export const is_component_empty = (component) => {

	const value = component?.data?.entries
	if (!value || value.length<1) {
		return true
	}

	// empty only when no element holds meaningful text (supports multi-value)
		return !value.some(item => {
			const text = (typeof item==='string')
				? item
				: (item?.value || '')
			// markup is not text (same rule as the server's isEmptyTranslation): '<p></p>' is empty
			return typeof text==='string' && text.replace(/<[^>]*>/g, '').trim()!==''
		})
}//end is_component_empty



/**
* BUILD_AUTOMATIC_TRANSLATION
* Engine selector panel (shared builder from tool_lang) in its own container.
* @param {Object} options - {self, translator_engine}
* @returns {HTMLElement} automatic_translation_container
*/
const build_automatic_translation = ({self, translator_engine}) => {

	const automatic_translation_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'automatic_translation_container'
	})
	append_engine_selector({
		self				: self,
		translator_engine	: translator_engine,
		parent				: automatic_translation_container
	})

	return automatic_translation_container
}//end build_automatic_translation



// @license-end
