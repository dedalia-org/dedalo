// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals */
/*eslint no-undef: "error"*/



/**
* ACTIVE_STYLE
* The active-component highlight style: which look `.wrapper_component.edit.active`
* takes (layout.less). A user preference, chosen in tool_user_admin.
*
* - `default` is the base (the one-frame look in layout.less) and sets no attribute.
* - Every other style is `data-active_style="<id>"` on <html>, and ONE stylesheet,
*   `core/page/css/active_styles/<id>.less`, scoped under that attribute.
*   Adding a style = one ACTIVE_STYLES entry + that file + its import in main.less
*   + its label (gate: test/unit/active_style_registry.test.ts).
*
* Persistence: the user's dd1206 "User interface preferences" (component_json on
* their own dd128 record, key `active_style`) is the truth, served as
* `page_globals.ui_preferences` (WC-2026-11-02-ui-preferences). localStorage
* ACTIVE_STYLE_KEY only caches it so theme-init.js paints the right style before
* the first frame.
*/



// imports
	import {get_instance} from '../../common/js/instances.js'



// The registry. `label` is a get_label key.
export const ACTIVE_STYLES = Object.freeze([
	{ id : 'default',	label : 'active_style_default' },
	{ id : 'lift',		label : 'active_style_lift' },
	{ id : 'margin',	label : 'active_style_margin' }
])

// localStorage key; must stay in sync with theme-init.js
export const ACTIVE_STYLE_KEY = 'dedalo_active_style'

// The users section and its "User interface preferences" component
const USERS_SECTION_TIPO	= 'dd128'
const UI_PREFERENCES_TIPO	= 'dd1206'



/**
* NORMALIZE_ACTIVE_STYLE
* @param {*} id
* @returns {string} a registered id; 'default' for anything else
*/
export const normalize_active_style = function(id) {

	return ACTIVE_STYLES.some(el => el.id===id) ? id : 'default'
}//end normalize_active_style



/**
* GET_ACTIVE_STYLE
* @returns {string} the style currently applied to the document
*/
export const get_active_style = function() {

	return normalize_active_style(document.documentElement.dataset.active_style)
}//end get_active_style



/**
* APPLY_ACTIVE_STYLE
* Sets the document attribute and refreshes the first-paint cache.
* @param {string} id
* @returns {string} the applied (normalized) id
*/
export const apply_active_style = function(id) {

	const style = normalize_active_style(id)
	const root = document.documentElement

	if (style==='default') {
		delete root.dataset.active_style
	}else{
		root.dataset.active_style = style
	}

	try {
		if (style==='default') {
			localStorage.removeItem(ACTIVE_STYLE_KEY)
		}else{
			localStorage.setItem(ACTIVE_STYLE_KEY, style)
		}
	} catch(_) {
		// storage blocked: the attribute still applies for this page
	}

	return style
}//end apply_active_style



/**
* SYNC_ACTIVE_STYLE_FROM_SERVER
* Applies the logged user's stored choice (page_globals.ui_preferences).
* Anonymous pages (login) keep whatever the cache painted.
* @returns {void}
*/
export const sync_active_style_from_server = function() {

	if (typeof page_globals==='undefined' || page_globals.is_logged!==true) {
		return
	}

	apply_active_style(page_globals.ui_preferences?.active_style)
}//end sync_active_style_from_server



/**
* SAVE_ACTIVE_STYLE
* Applies the style and stores it in the user's own dd1206, keeping any other
* preference keys already there.
* @param {string} id
* @returns {Promise<boolean>} true when saved
*/
export const save_active_style = async function(id) {

	const style = apply_active_style(id)

	// dynamic: keeps component_json off the page boot graph
	const {build_changed_data_item} = await import('../../component_json/js/component_json.js')

	const component = await get_instance({
		model			: 'component_json',
		mode			: 'edit',
		tipo			: UI_PREFERENCES_TIPO,
		section_tipo	: USERS_SECTION_TIPO,
		section_id		: page_globals.user_id,
		lang			: 'lg-nolan'
	})
	await component.build(true)

	const entry = component.data?.entries?.[0]
	const current = (entry?.value && typeof entry.value==='object' && !Array.isArray(entry.value))
		? entry.value
		: {}
	const value = Object.assign({}, current, { active_style : style })

	const response = await component.change_value({
		changed_data	: [build_changed_data_item(value, entry?.id ?? null)],
		refresh			: false
	})

	// keep the page's copy current (a later sync must not revert it)
	page_globals.ui_preferences = value

	return response!==false
}//end save_active_style



// @license-end
