// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* RENDER_API_ERROR
* The ONE renderer for an ApiError: text resolution (label → English message →
* code) and the four surfaces (toast, inline, full page panel, modal).
*
* LAW: NEVER innerHTML. Every message reaches the DOM through `text_content` /
* text nodes — an `error.message` is server text, a `details` value can be a
* user-typed string, and a stream frame can be anything (DS-1,
* error_report_xss_tripwire). It supersedes the legacy
* `render_common.render_server_response_error` panel (DELETED at the P4 compat
* removal); its affordances (logo, reload on session loss, Home link) are kept,
* its `inner_html` sinks are not.
*/

// imports
	import {ui} from './ui.js'
	import {event_manager} from './event_manager.js'
	import {format_label} from './common.js'
	import {is_api_error, client_error_message_for} from './api_error.js'



/**
* GET_LABELS
* `get_label` is a page global set by set_environment; absent pre-login and in tests.
* @return Object
*/
const get_labels = () => (typeof get_label!=='undefined' && get_label && typeof get_label==='object') ? get_label : {}



/**
* FILL_POSITIONAL
* `%s` placeholders take the `details` values in insertion order (legacy label
* style, still present in a few catalogs). Unknown/absent values leave `%s`
* visible — a visible placeholder is a bug report, a truncated sentence is not.
* @param {string} text
* @param {Object} details
* @return string
*/
const fill_positional = (text, details) => {
	if (!text.includes('%s')) {
		return text
	}
	const values = Object.values(details || {})
	let i = 0
	return text.replace(/%s/g, (match) => (i < values.length ? String(values[i++]) : match))
}//end fill_positional



/**
* TOOL_ERROR_LABELS
* tool name → the `reason_*` entries of that tool's context labels (register.json
* `labels`, single language: the server serves only the application language, and
* an empty list when the tool has none). Filled by tool_common.build; read by
* error_text to turn `details.reason_key` into the tool's own sentence. Bounded by
* the number of tools.
*/
const tool_error_labels = new Map()

/**
* TOOL_REASON_PREFIX
* A refusal reason `x` is the tool label named `reason_x` (the prefix keeps the
* refusal sentences apart from the tool's UI labels).
*/
const TOOL_REASON_PREFIX = 'reason_'



/**
* REGISTER_TOOL_ERROR_LABELS
* Remembers a tool's refusal sentences for error_text. Replaces what was stored
* for `tool`; a non-array (the tool has no context) forgets it.
* @param {string} tool - tool name, e.g. 'tool_uca_maps'
* @param {Array|null} labels - the tool context's labels ({name, value}[])
* @return bool true when something was stored
*/
export const register_tool_error_labels = (tool, labels) => {

	if (typeof tool!=='string' || !tool.length) {
		return false
	}
	if (!Array.isArray(labels)) {
		tool_error_labels.delete(tool)
		return false
	}
	tool_error_labels.set(tool, labels.filter((label) =>
		label && typeof label.name==='string' && label.name.startsWith(TOOL_REASON_PREFIX) && typeof label.value==='string' && label.value.length
	))

	return true
}//end register_tool_error_labels



/**
* UNRESOLVED_PLACEHOLDER
* What is left in a tool sentence the wire could not fill: a `${param}` the details do
* not carry, or a positional `%s` (a tool refusal label is filled by name only).
*/
const UNRESOLVED_PLACEHOLDER = /\$\{\w+\}|%s/

/**
* TOOL_REASON_TEXT
* The sentence for a tool refusal (`details.reason_key` on an ApiError whose `tool`
* is known): the tool's label `reason_<key>` (placeholders `${param}` = the code's
* declared details), else the wire `message` — the English sentence the tool declared
* for the key, which the server guarantees for a reason_key refusal. null when the error is not a
* tool refusal or has neither, so error_text carries on with the core chain.
*
* A label whose placeholder the wire cannot fill (`${max}` on a code that declares no
* such detail, or a `%s`) would reach the user as literal text — a cataloguer cannot act
* on `Max ${max} items` — so the vetted `message` stands in for it. The authoring that
* causes it is refused at build time (tool_reason_keys_tripwire, placeholder leg); this
* is the reader's side of the same rule, and under SHOW_DEBUG it says which label.
* @param {ApiError|Object} api_error
* @param {Object} details
* @return string|null
*/
const tool_reason_text = (api_error, details) => {

	const reason_key = details.reason_key
	if (typeof reason_key!=='string' || !reason_key.length || typeof api_error.tool!=='string') {
		return null
	}
	const found = tool_error_labels.get(api_error.tool)?.find((label) => label.name===TOOL_REASON_PREFIX + reason_key)
	if (found) {
		const text = format_label(found.value, details)
		if (!UNRESOLVED_PLACEHOLDER.test(text)) {
			return text
		}
		if (typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) {
			console.warn(`tool label ${TOOL_REASON_PREFIX}${reason_key} of ${api_error.tool} has a placeholder the error does not carry:`, found.value)
		}
	}

	return (typeof api_error.message==='string' && api_error.message.length) ? api_error.message : null
}//end tool_reason_text



/**
* ERROR_TEXT
* The sentence to show for an ApiError, in the user's language when the label
* exists: get_label[label_key] → format_label(template, details) (`${param}` and
* `%s`) → English `message` → `code`.
* A TOOL refusal (`details.reason_key` + `api_error.tool`) goes first through the
* tool's own label `reason_<key>` and then the wire `message`, so the user reads ONE
* translated (or, failing a translation, the tool's declared English) sentence instead of the core
* code's generic label.
* @param {ApiError|Object} api_error
* @return string
*/
export const error_text = (api_error) => {

	if (!api_error || typeof api_error!=='object') {
		return String(api_error ?? '')
	}

	const labels	= get_labels()
	const details	= (api_error.details && typeof api_error.details==='object') ? api_error.details : {}

	const reason_text = tool_reason_text(api_error, details)
	if (reason_text!==null) {
		return reason_text
	}

	if (api_error.label_key && typeof labels[api_error.label_key]==='string' && labels[api_error.label_key].length) {
		return fill_positional(format_label(labels[api_error.label_key], details), details)
	}

	if (typeof api_error.message==='string' && api_error.message.length) {
		return api_error.message
	}

	return client_error_message_for(api_error.code) || String(api_error.code || '')
}//end error_text



/**
* ERROR_DEBUG_SUFFIX
* Under SHOW_DEBUG, the code and request_id ride along so a screenshot joins the
* server log. Empty string in production.
* @param {ApiError|Object} api_error
* @return string
*/
export const error_debug_suffix = (api_error) => {

	if (typeof SHOW_DEBUG==='undefined' || SHOW_DEBUG!==true || !api_error) {
		return ''
	}
	const parts = [api_error.code, api_error.request_id].filter((item) => typeof item==='string' && item.length)
	return parts.length ? ` [${parts.join(' · ')}]` : ''
}//end error_debug_suffix



/**
* SEVERITY_TYPE
* ApiError.severity → notification bubble type (render_node_info).
*/
const severity_type = (api_error) => {
	switch (api_error?.severity) {
		case 'info'		: return 'success'
		case 'warning'	: return 'warning'
		default			: return 'error'
	}
}//end severity_type



/**
* RENDER_ERROR_TOAST
* Publishes the page 'notification' event (page.js renders it through
* render_node_info, which is text-only) — the same channel data_manager's
* render_msg_to_inspector used, so no new subscriber is needed.
* @param {ApiError|Object} api_error
* @param {Object} [options] - {remove_time:number|null, type:string}
* @return Object the published payload
*/
export const render_error_toast = (api_error, options = {}) => {

	const payload = {
		msg			: error_text(api_error) + error_debug_suffix(api_error),
		type		: options.type || severity_type(api_error),
		remove_time	: options.remove_time===undefined ? 10000 : options.remove_time,
		api_error	: is_api_error(api_error) ? api_error : null
	}
	event_manager.publish('notification', payload)

	return payload
}//end render_error_toast



/**
* RENDER_ERROR_INLINE
* Shows the message inside the caller's own wrapper (component_message node).
* @param {HTMLElement} wrapper
* @param {ApiError|Object} api_error
* @return HTMLElement|null the message wrap
*/
export const render_error_inline = (wrapper, api_error) => {

	if (!wrapper || typeof wrapper.querySelector!=='function') {
		return null
	}
	const type = api_error?.severity==='warning' ? 'warning' : 'error'

	return ui.show_message(wrapper, error_text(api_error) + error_debug_suffix(api_error), type)
}//end render_error_inline



/**
* RENDER_ERROR_PANEL
* Full-page error node (detached; the caller places it). Always shows the
* request_id line — it is the only join key with the server log — and the
* affordance the code calls for: Reload for a lost session (`auth.*`), Home
* otherwise.
* @param {ApiError|Object} api_error
* @return HTMLElement
*/
export const render_error_panel = (api_error) => {

	const labels	= get_labels()
	const code		= String(api_error?.code || '')

	// error_container
		const error_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'page_error_container api_error_panel'
		})
		error_container.dataset.code = code

	// icon_dedalo
		ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'icon_dedalo',
			src				: '../../core/themes/default/dedalo_logo.svg',
			parent			: error_container
		})

	// message
		ui.create_dom_element({
			element_type	: 'h1',
			class_name		: 'server_response_error',
			text_content	: error_text(api_error),
			parent			: error_container
		})

	// request_id (always — empty when the failure never reached the server)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'request_id',
			text_content	: 'request_id: ' + (api_error?.request_id || '-') + ((typeof SHOW_DEBUG!=='undefined' && SHOW_DEBUG===true) ? ' · ' + code : ''),
			parent			: error_container
		})

	// affordance
		if (code.startsWith('auth.')) {
			// a forced reload re-initiates the authentication handshake
			const link = ui.create_dom_element({
				element_type	: 'a',
				class_name		: 'link reload',
				text_content	: labels.reload || 'Reload',
				parent			: error_container
			})
			link.addEventListener('click', (e) => {
				e.stopPropagation()
				location.reload()
			})
			error_container.classList.add('not_logged_error')
		} else {
			const link_home = ui.create_dom_element({
				element_type	: 'a',
				class_name		: 'link home',
				href			: '../../core/page/',
				text_content	: labels.home || 'Home',
				parent			: error_container
			})
			link_home.addEventListener('click', (e) => {
				e.stopPropagation()
			})
			// raspa background: the generic full-page error look (perm.* keeps its own)
			error_container.classList.add(code.startsWith('perm.') ? 'no_access_error' : 'raspa_error')
		}

	return error_container
}//end render_error_panel



/**
* RENDER_ERROR_MODAL
* Opens the standard dd-modal with the message; used for answers the user must
* acknowledge (`record.in_use`, …).
* @param {ApiError|Object} api_error
* @param {Object} [options] - passed through to ui.attach_to_modal (size, on_close, …)
* @return HTMLElement the modal container
*/
export const render_error_modal = (api_error, options = {}) => {

	const labels = get_labels()

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'header content',
		text_content	: labels.error || 'Error'
	})
	const body = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'body content api_error_modal'
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'text',
		text_content	: error_text(api_error),
		parent			: body
	})
	if (api_error?.request_id) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'request_id',
			text_content	: 'request_id: ' + api_error.request_id + error_debug_suffix(api_error),
			parent			: body
		})
	}

	return ui.attach_to_modal({
		header	: header,
		body	: body,
		size	: options.size || 'small',
		...options
	})
}//end render_error_modal



/**
* RENDER_BUILD_FAILURE
* The node that replaces an element whose build() returned false. Tells the
* truth instead of guessing: with the request's ApiError (instance.build_error,
* stamped by build_autoload) it shows that error's text; only with NO error
* (empty context — the server's answer for an element the user cannot reach)
* does it name permissions. A transient failure (retryable / transport) gets a
* Reload button that rebuilds just this element via `on_retry`.
* @param {Object} options
* @param {Object} options.instance - the element whose build failed
* @param {Function} [options.on_retry] - async () => HTMLElement|null, the rebuilt node
* @param {string} [options.class_name='error_alert']
* @return HTMLElement
*/
export const render_build_failure = ({instance, on_retry, class_name='error_alert'}) => {

	const labels		= get_labels()
	const api_error		= is_api_error(instance?.build_error) ? instance.build_error : null
	const model			= instance?.model || 'element'
	const id			= [instance?.section_tipo, instance?.section_id].filter(Boolean).join(' - ')

	const text = api_error
		? `Error: Could not build element "${model}" ${id}: ` + error_text(api_error) + error_debug_suffix(api_error)
		: `Error: Could not build element "${model}" (missing context or data). Maybe your user doesn't have permissions to access to this element: ${id}`

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: class_name
	})
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: text,
		parent			: node
	})

	const transient = api_error && (api_error.retryable===true || api_error.transport===true)
	if (transient && typeof on_retry==='function') {
		const button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light reload',
			text_content	: labels.reload || 'Reload',
			parent			: node
		})
		button.addEventListener('click', async (e) => {
			e.stopPropagation()
			button.disabled = true
			try {
				const new_node = await on_retry()
				if (new_node && node.parentNode) {
					node.replaceWith(new_node)
					return
				}
			} catch (error) {
				console.error('render_build_failure retry failed:', error)
			}
			button.disabled = false
		})
	}

	return node
}//end render_build_failure



// @license-end
