// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/

// SEC-032: install runs WITHOUT authentication. All `*_status.innerHTML = <server text>`
// sites have been converted to `textContent` so that any reflection of attacker-controlled
// input (DB host, password validator, hierarchy import errors, etc.) cannot trigger
// pre-auth XSS. Counter tickers and reset-to-empty assignments were also converted for
// consistency.



// imports
	import {data_manager} from '../../common/js/data_manager.js'
	import {append_text_lines} from '../../common/js/utils/index.js'
	import {when_in_viewport} from '../../common/js/events.js'
	import {ui} from '../../common/js/ui.js'
	import {component_password} from '../../component_password/js/component_password.js'
	import {check_password} from '../../component_password/js/password_policy.js'
	import {format_label} from '../../common/js/common.js'
	import {get_instance} from '../../common/js/instances.js'
	import {toggle_theme, get_theme} from '../../page/js/theme.js'
	import {request_failed, response_data, response_extension} from '../../common/js/api_error.js'
	import {error_text} from '../../common/js/render_api_error.js'



/**
* SERVER_TEXT
* The sentence to print for ONE installer API answer.
*
* A FAILURE is an ApiError on the envelope — envelope v2 carries NO `msg` on a
* failure at all, so reading the step's `msg` there prints nothing. The ONE
* renderer resolves it (label → English `message` → code), which is exactly what
* this screen needs: the installer runs PRE-LOGIN with an empty label catalog, and
* `error_text` degrades to the English message on its own without assuming
* `get_label` exists.
*
* A SUCCESS keeps the step's own `msg` EXTENSION KEY (ERRORS_SPEC §3.0 — the
* install router puts every field beside the verdict there: src/core/install/
* engine.ts stepResult), read through response_extension so a failure can never
* fall back onto the compat mirror. Arrays are joined.
*
* @param {Object} api_response
* @param {string} [fallback]
* @return {string}
*/
const server_text = function(api_response, fallback) {

	if (request_failed(api_response)) {
		return error_text(api_response.error) || (fallback || '')
	}

	const msg = response_extension(api_response, 'msg')
	if (Array.isArray(msg)) {
		return msg.filter(line => line!==null && line!==undefined).join(' | ')
	}

	return (typeof msg==='string' && msg.length) ? msg : (fallback || '')
}//end server_text



/**
* RENDER_INSTALLER
* Client-side renderer for the Dédalo first-run installation wizard.
*
* This module drives a sequential, multi-step installation UI that runs without
* any prior authentication (see SEC-032). The wizard walks the operator through:
*
*   1. Help/docs links
*   2. Server init-test results (PHP environment checks)
*   3. Database configuration status + action choice (fresh install vs. update vs. root-pw reset)
*   4. Database creation from the bundled SQL file
*   5. Root-password setup (strength-validated)
*   6. First login
*   7. Hierarchy (thesaurus tree) import
*   8. Finish / reload
*
* The constructor is a no-op stub; all logic lives on the prototype. `installer.js`
* assigns `render_installer.prototype.render` to `installer.prototype.edit` and related
* render modes, so this prototype method is the single entry point invoked by the
* common render dispatcher.
*
* Exported symbols:
*   - render_installer           (constructor, assigned to installer.prototype)
*   - render_hierarchies_import_block  (also used standalone by activation screens)
*/

/**
* CREATE_SECTION_BLOCK
* Creates a section card with title, content div, and optional hide state.
* Sets a pointer on content_data for programmatic access.
* @param object options { label, class_name, hidden, parent, content_data }
* @return object { section, content_div }
*/
const create_section_block = function(options) {

	const label			= options.label || ''
	const class_name	= options.class_name || ''
	const hidden		= options.hidden ?? true
	const parent		= options.parent
	const content_data	= options.content_data

	const section = ui.create_dom_element({
		element_type	: 'section',
		class_name		: class_name + (hidden ? ' hide' : ''),
		parent			: parent
	})
	// set pointer on content_data
	content_data[class_name] = section

	// title
	ui.create_dom_element({
		element_type	: 'h1',
		inner_html		: label,
		parent			: section
	})

	// content wrapper
	const content_div = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'content',
		parent			: section
	})

	return { section, content_div }
}//end create_section_block


/**
* CREATE_STATUS_MSG
* Creates a status message node with ok/error/warning class.
* @param HTMLElement parent
* @return HTMLElement status_node
*/
const create_status_msg = function(parent) {

	const status_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'msg',
		parent			: parent
	})

	return status_node
}//end create_status_msg


/**
* CREATE_FIELD
* Creates a labelled form field (label + input + optional help text) inside a wrapper, and
* keeps the shared config object (`cfg`) in sync with the input value on every keystroke.
* Used by the modernized "collect configuration" wizard steps so the administrator never edits
* a config file by hand.
* @param object options { parent, cfg, name, label, type, value, placeholder, help, nullable, on_change, select }
* @return HTMLElement input
*/
const create_field = function(options) {

	const parent		= options.parent
	const cfg			= options.cfg
	const name			= options.name
	const label			= options.label || name
	const type			= options.type || 'text'
	const value			= options.value ?? ''
	const placeholder	= options.placeholder || ''
	const help			= options.help || ''
	const nullable		= options.nullable === true
	const on_change		= options.on_change
	const select		= Array.isArray(options.select) ? options.select : null

	const field = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'installer_field',
		parent			: parent
	})

	ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'installer_field_label',
		inner_html		: label,
		parent			: field
	})

	// `select` renders a fixed-choice <select> instead of a free-text input
	// (same cfg-sync contract) — used where a typo would silently degrade
	// (e.g. the SMTP encryption mode).
	const input = select
		? ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'installer_field_input',
			parent			: field
		})
		: ui.create_dom_element({
			element_type	: 'input',
			type			: type,
			class_name		: 'installer_field_input',
			value			: value,
			placeholder		: placeholder,
			parent			: field
		})
	if (select) {
		for (const option_value of select) {
			ui.create_dom_element({
				element_type	: 'option',
				value			: option_value,
				inner_html		: option_value,
				parent			: input
			})
		}
		input.value = value
	}
	if (type === 'password') {
		input.autocomplete = 'new-password'
	}

	// seed the shared config with the initial value (so defaults are submitted even untouched)
	cfg[name] = (nullable && value === '') ? null : value

	input.addEventListener('input', function() {
		// clear a previous failed-verification highlight as soon as the user edits
		input.classList.remove('invalid')
		cfg[name] = (nullable && input.value === '') ? null : input.value
		if (typeof on_change === 'function') {
			on_change()
		}
	})

	if (help !== '') {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_field_help',
			inner_html		: help,
			parent			: field
		})
	}

	return input
}//end create_field


/**
* ADD_SPINNER
* Appends a loading row (animated ring + label) to the given parent and returns the
* wrapper so the caller can remove it in one shot. The ring colours come from the
* theme tokens, so it stays visible in both light and dark.
* @param HTMLElement parent
* @param string label optional loading text (defaults to a localized "Working…")
* @return HTMLElement spinner_wrap
*/
const add_spinner = function(parent, label) {

	const spinner_wrap = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'spinner_wrap',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'installer_spinner',
		parent			: spinner_wrap
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'spinner_label',
		inner_html		: label || get_label.loading || 'Working…',
		parent			: spinner_wrap
	})

	return spinner_wrap
}//end add_spinner


/**
* API_CALL_WITH_SPINNER
* Performs a data_manager API call with spinner and status message management.
* @param object options { action, dd_action, body_options, status_node, button_node, retries, timeout, spinner_label }
* @return object api_response
*/
const api_call_with_spinner = async function(options) {

	const action			= options.action
	const dd_action		= options.dd_action || 'install'
	const dd_api			= options.dd_api || 'dd_utils_api'
	const body_options		= options.body_options || {}
	const status_node		= options.status_node
	const button_node		= options.button_node
	const retries			= options.retries ?? 1
	const timeout			= options.timeout ?? 10 * 1000

	// lock button
	if (button_node) {
		button_node.classList.add('loading')
	}

	// reset status + enter loading state (neutral surface for the spinner row)
	if (status_node) {
		status_node.classList.remove('ok', 'error', 'warning')
		status_node.classList.add('loading')
		status_node.textContent = ''
	}

	// add spinner
	const spinner = status_node
		? add_spinner(status_node, options.spinner_label)
		: null

	// API call
	// options.body, when supplied, is used verbatim (e.g. a widget_request envelope);
	// otherwise the install-surface envelope is assembled from action/dd_api/body_options.
	const request_body = options.body || {
		action	: dd_action,
		dd_api	: dd_api,
		options	: {
			action	: action,
			...body_options
		}
	}
	const api_response = await data_manager.request({
		body	: request_body,
		retries	: retries,
		timeout	: timeout
	})

	// unlock button
	if (button_node) {
		button_node.classList.remove('loading')
	}

	// remove spinner + exit loading state
	if (spinner) {
		spinner.remove()
	}
	if (status_node) {
		status_node.classList.remove('loading')
	}

	return api_response
}//end api_call_with_spinner


/**
* SET_STATUS_RESULT
* Sets status message class and text based on API response.
* @param HTMLElement status_node
* @param object api_response
*/
const set_status_result = function(status_node, api_response) {

	// ONE error model: a failed call has no `msg` on the wire — its text comes from
	// the ApiError through the ONE renderer (server_text).
	if (request_failed(api_response) || response_data(api_response) !== true) {
		status_node.classList.add('error')
	} else {
		status_node.classList.add('ok')
	}
	status_node.textContent = server_text(api_response)
}//end set_status_result


/**
* UPDATE_STEP_INDICATOR
* Updates the step indicator dots and lines to reflect current progress.
* @param HTMLElement step_indicator
* @param number active_step (1-based)
*/
const update_step_indicator = function(step_indicator, active_step) {

	if (!step_indicator) return

	const dots		= step_indicator.querySelectorAll('.step_dot')
	const lines		= step_indicator.querySelectorAll('.step_line')
	const total		= dots.length

	for (let i = 0; i < total; i++) {
		const dot = dots[i]
		dot.classList.remove('active', 'completed')
		if (i + 1 < active_step) {
			dot.classList.add('completed')
		} else if (i + 1 === active_step) {
			dot.classList.add('active')
		}
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		line.classList.remove('completed')
		if (i + 1 < active_step) {
			line.classList.add('completed')
		}
	}
}//end update_step_indicator


/**
* REVEAL_SECTION
* Reveals a previously-hidden wizard step and smoothly scrolls it into view, so that
* completing a step automatically advances the operator to the next one. Scrolling
* happens inside the installer's own scroll container (.installer.wrapper).
* @param HTMLElement section
*/
const reveal_section = function(section) {

	if (!section) return

	// let a step refresh its own content right before it appears — e.g. the install-DB
	// confirmation grid, whose values are only known once the earlier steps are filled
	if (typeof section._on_reveal === 'function') {
		section._on_reveal()
	}

	section.classList.remove('hide')
	section.classList.add('fade_in')

	// wait one frame so the now-visible section has layout before scrolling to it
	requestAnimationFrame(() => {
		section.scrollIntoView({ behavior:'smooth', block:'start' })
	})
}//end reveal_section


/**
* COUNTDOWN_AND_RELOAD
* Shows a countdown in the status node then reloads the page.
* @param HTMLElement status_node
* @param number seconds
*/
const countdown_and_reload = function(status_node, seconds=5) {

	let counter = seconds
	const interval = setInterval(() => {
		status_node.textContent = 'Initializing in ' + counter
		counter--
		if (counter < 0) {
			clearInterval(interval)
			location.reload()
		}
	}, 1000)
}//end countdown_and_reload



/**
* RENDER_INSTALLER
* Manages the component's logic and appearance in client side
*/
export const render_installer = function() {

	return true
}//end render_installer



/**
* RENDER
* Render node for use in install mode
*
* Entry point called by the common render dispatcher (installer.prototype.edit, .list, …).
* Builds the full install wizard DOM tree wrapped in a top-level div.wrapper.install
* element and returns it, or returns the inner content_data fragment directly when
* render_level is 'content'.
*
* Side effects: attaches content_data as a property on the returned wrapper so that
* inner sub-blocks can later unhide sibling sections via `self.node.content_data.*`.
*
* @param {Object} options - Render options passed by the common render dispatcher
* @param {string} [options.render_level='full'] - 'full' returns wrapper; 'content' returns inner fragment only
* @returns {Promise<HTMLElement>} The wrapper div (render_level 'full') or content_data div ('content')
*/
render_installer.prototype.render = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// no context: get_install_context was refused (e.g. install.ip_denied, which
	// names the address to allow). The API error surface already shows that
	// refusal; building the wizard on a null context only stacked a TypeError
	// ("Cannot read properties of null") on top of it (2026-10-08).
		if (!self.context) {
			return ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'wrapper installer'
			})
		}

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper installer'
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data

	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds and returns the full multi-section install wizard DOM tree.
*
* Creates one <section> per wizard step and attaches each as a named property on
* the returned content_data div so that sibling sections can be revealed later with
* `self.node.content_data.<section_name>.classList.remove('hide')`.
*
* All sections except help_block and init_test_block start with the CSS class 'hide'
* (injected by the inner add_hidden_block helper) and are progressively revealed as
* each step completes successfully.
*
* Section order and purpose:
*   help_block                – documentation links
*   init_test_block           – server environment pre-flight results
*   config_block              – database configuration check + action selector
*   installer_db_block          – create DB from bundled SQL file
*   set_root_password_block   – set superuser password
*   login_block               – first login after password is set
*   hierarchies_import_block  – import thesaurus hierarchies
*   register_tools_block      – register the available tools into the registry
*   installer_finish_block      – finalize and reload
*
* @param {Object} self - The install instance (provides self.context.properties and self.node)
* @returns {HTMLElement} content_data div containing all wizard sections
*/
const get_content_data = function(self) {

	const properties = self.context?.properties || {}

	// needs_config: true on a FRESH install (placeholder/unreachable config) → render the
	// modernized collect+validate+persist wizard; false on an already-configured-but-not-installed
	// system → keep the legacy config-check + install/update/reset options.
	const needs_config = properties.needs_config === true

	// shared form-values object accumulated across the collect steps and submitted at persist time
	self._cfg = self._cfg || {}
	self._needs_config = needs_config // used by the password/login reveal step numbers

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data'
		})

	// ── HEADER / BRAND ──
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_header',
			parent			: content_data
		})
		const brand_mark = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_mark',
			parent			: header
		})
		ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'installer_logo',
			src				: DEDALO_CORE_URL + '/themes/default/dedalo_logo_white.svg',
			parent			: brand_mark
		})
		const brand = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_brand',
			parent			: header
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_title',
			inner_html		: 'Dédalo',
			parent			: brand
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_subtitle',
			inner_html		: get_label.installation_help || 'Installation Wizard',
			parent			: brand
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_version',
			text_content	: properties.version || '',
			parent			: header
		})

		// theme toggle — light is default, dark is opt-in via data-theme="dark".
		// Uses the shared app controller (core/page/js/theme.js), so the installer
		// honours and updates the same 'dedalo_theme' preference as the rest of v7.
		const theme_toggle = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'installer_theme_toggle',
			parent			: header
		})
		theme_toggle.type	= 'button'
		theme_toggle.title	= get_label.theme_toggle || 'Toggle theme'
		theme_toggle.innerHTML =
			'<svg class="theme_icon theme_icon_moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
			'<svg class="theme_icon theme_icon_sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
		// icon: light shows the moon (→ switch to dark), dark shows the sun (→ switch to light)
		const sync_theme_icon = function() {
			const is_dark	= get_theme() === 'dark'
			const moon		= theme_toggle.querySelector('.theme_icon_moon')
			const sun		= theme_toggle.querySelector('.theme_icon_sun')
			if (moon) moon.style.display = is_dark ? 'none' : 'block'
			if (sun)  sun.style.display  = is_dark ? 'block' : 'none'
		}
		sync_theme_icon()
		theme_toggle.addEventListener('click', function() {
			toggle_theme()
			sync_theme_icon()
		})

	// ── STEP INDICATOR ──
		const step_indicator = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'step_indicator',
			parent			: content_data
		})
		content_data.step_indicator = step_indicator
		const step_labels = needs_config
			? [
				get_label.init_text || 'Diagnostics',
				get_label.db_name || 'Database',
				get_label.entity_name || 'Entity',
				get_label.installation_ontologies || 'Ontologies',
				get_label.enable_diffusion || 'Diffusion',
				get_label.installation_mailer || 'Email',
				get_label.save_configuration || 'Save config',
				get_label.check_directories || 'Directories',
				get_label.install_db_label || 'Install Dédalo DDBB',
				get_label.set_root_pw_label || 'Set root password',
				get_label.login_label || 'Login',
				get_label.import_hierarchies_label || 'Install hierarchies',
				get_label.register_tools || 'Register tools',
				get_label.install_done || 'Done!'
			]
			: [
				get_label.init_text || 'Diagnostics',
				get_label.installation_config_test || 'Configuration',
				get_label.install_db_label || 'Install Dédalo DDBB',
				get_label.set_root_pw_label || 'Set root password',
				get_label.login_label || 'Login',
				get_label.import_hierarchies_label || 'Install hierarchies',
				get_label.register_tools || 'Register tools',
				get_label.install_done || 'Done!'
			]
		for (let i = 0; i < step_labels.length; i++) {
			if (i > 0) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name	: 'step_line',
					parent		: step_indicator
				})
			}
			const dot = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'step_dot',
				inner_html		: String(i + 1),
				parent			: step_indicator
			})
			dot.title = step_labels[i]
		}
		// initial state: step 1 active
		update_step_indicator(step_indicator, 1)

	// ── HELP BLOCK ──
		const help = create_section_block({
			label			: get_label.installation_help || 'Installation help',
			class_name		: 'help_block',
			hidden			: false,
			parent			: content_data,
			content_data	: content_data
		})
		help.content_div.appendChild(render_help_block(self))

	// ── INIT TEST BLOCK ──
		const init_test = create_section_block({
			label			: get_label.init_text || 'Server Diagnostics',
			class_name		: 'init_test_block',
			hidden			: false,
			parent			: content_data,
			content_data	: content_data
		})
		init_test.content_div.appendChild(
			render_init_test_block(self)
		)

	// ── CONFIG AREA ──
	if (needs_config) {

		// modernized flow: collect → validate → persist (no manual config-file editing)
		// DB CONFIG
			const db_config = create_section_block({
				label			: get_label.installation_db_config || 'Database (PostgreSQL)',
				class_name		: 'db_config_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			db_config.content_div.appendChild(render_db_config_block(self))

		// ENTITY
			const entity = create_section_block({
				label			: get_label.installation_entity || 'Entity & install info',
				class_name		: 'entity_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			entity.content_div.appendChild(render_entity_block(self))

		// ONTOLOGIES (the domain ontologies to install — >= 1, oh pre-ticked)
			const ontologies = create_section_block({
				label			: get_label.installation_ontologies || 'Ontologies',
				class_name		: 'ontologies_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			ontologies.content_div.appendChild(render_ontologies_block(self))
			// the server catalog is read when the step first appears (not before
			// the operator reaches it), and again when the update-server box changes
			ontologies.section._on_reveal = self._ontologies_on_reveal

		// DIFFUSION (optional)
			const diffusion = create_section_block({
				label			: get_label.installation_diffusion || 'Diffusion database (optional)',
				class_name		: 'diffusion_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			diffusion.content_div.appendChild(render_diffusion_block(self))

		// OUTBOUND EMAIL / MAILER (optional — password recovery)
			const mailer = create_section_block({
				label			: get_label.installation_mailer || 'Outbound email (optional)',
				class_name		: 'mailer_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			mailer.content_div.appendChild(render_mailer_block(self))

		// PERSIST + VERIFY
			const persist = create_section_block({
				label			: get_label.installation_persist || 'Save configuration',
				class_name		: 'persist_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			persist.content_div.appendChild(render_persist_block(self))

		// DIRECTORIES
			const directories = create_section_block({
				label			: get_label.installation_directories || 'Directories & permissions',
				class_name		: 'directories_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			directories.content_div.appendChild(render_directories_block(self))

		// the init-test viewport hook reveals this first
			content_data._first_config = 'db_config_block'

	} else {

		// legacy flow: validate the already-present config + offer install/update/reset
			const config = create_section_block({
				label			: get_label.installation_config_test || 'Configuration',
				class_name		: 'config_block',
				hidden			: true,
				parent			: content_data,
				content_data	: content_data
			})
			config.content_div.appendChild(render_config_block(self))
			content_data.config_block.config_block_status = config.content_div

			const config_block_options = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'content',
				parent			: content_data.config_block
			})
			config_block_options.appendChild(render_config_options(self))
			content_data.config_block.config_block_options = config_block_options

			content_data._first_config = 'config_block'
	}

	// ── INSTALL DB BLOCK ──
		const installer_db = create_section_block({
			label			: get_label.install_db_label || 'Install Dédalo DDBB',
			class_name		: 'installer_db_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		installer_db.content_div.appendChild(render_installer_db_block(self))
		// refresh the DB confirmation grid from the entered values each time this step appears
		installer_db.section._on_reveal = self._refresh_installer_db_config

	// ── SET ROOT PASSWORD BLOCK ──
		const set_pw = create_section_block({
			label			: get_label.set_root_pw_label || 'Set root password',
			class_name		: 'set_root_password_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		set_pw.content_div.appendChild(render_set_root_password_block(self))

	// ── LOGIN BLOCK ──
	// The root user logs in HERE, inside the installer, without navigating away (the login
	// component's custom_action_dispatch intercepts success). This authenticates the session so
	// the MANDATORY hierarchy import below can run with real credentials (no superuser shortcut).
		const login = create_section_block({
			label			: get_label.login_label || 'Login',
			class_name		: 'login_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		render_login_block(self)
	.then(function(response){
		login.content_div.appendChild(response)
	})

	// ── HIERARCHIES IMPORT BLOCK ──
	// Importing hierarchies/ontologies is a MANDATORY install step (only WHICH hierarchies is
	// optional). It runs AFTER login so section::create_record has an authenticated user, and a
	// successful import reveals the Finish step.
		const hierarchies = create_section_block({
			label			: get_label.import_hierarchies_label || 'Install hierarchies',
			class_name		: 'hierarchies_import_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		const hierarchies_import_options = {
			hierarchies				: properties.hierarchies,
			hierarchy_typologies	: properties.hierarchy_typologies,
			// core hierarchies (lg) are activated with the seed restore — shown, not offered
			core_hierarchies		: properties.core_hierarchies,
			// NO country is ever pre-ticked: the toponymy group carries a SUGGESTION to
			// import the operator's own country instead (hierarchy.json manifest, 2026-10-10)
			toponymy_typology		: properties.toponymy_typology,
			// optional thesauri are optional: an empty selection is a valid answer here
			allow_empty				: true,
			// On a successful import, reveal the Register tools step.
			callback		: function() {
				reveal_section(self.node.content_data.register_tools_block)
				update_step_indicator(self.node.content_data.step_indicator, needs_config ? 13 : 7)
			}
		}
		// The thesauri the saved plan's ontologies declare (persist_config's
		// `hierarchy_dependencies`, kept in self._hierarchy_dependencies) are only
		// known after the Save step, so the list is (re)built each time the step
		// appears: every one pre-ticked (a mandatory one marked "strongly
		// recommended" and still EDITABLE — owner decision 2026-10-10: a thesaurus
		// never blocks an install) — and NOTHING else pre-ticked (the declared dependencies are the ONLY
		// pre-selection; the old per-descriptor default list is gone, 2026-10-10).
		const render_hierarchies_step = function() {
			const declared = Array.isArray(self._hierarchy_dependencies) ? self._hierarchy_dependencies : []
			hierarchies.content_div.replaceChildren(
				render_hierarchies_import_block({
					...hierarchies_import_options,
					// a fresh array per render (the block sorts its input in place)
					hierarchies				: [...(properties.hierarchies || [])],
					hierarchy_typologies	: [...(properties.hierarchy_typologies || [])],
					default_checked			: [...new Set(declared.map(el => el.tld))],
					required_hierarchies	: declared.filter(el => el.mandatory===true)
				})
			)
		}
		render_hierarchies_step()
		hierarchies.section._on_reveal = render_hierarchies_step

	// ── REGISTER TOOLS BLOCK ──
	// Register the discoverable tools (import, export, time machine, …) into the
	// registry so they appear in the application from the first boot. Runs AFTER
	// login (it writes section records) and reveals the Finish step on completion.
		const register_tools = create_section_block({
			label			: get_label.register_tools || 'Register tools',
			class_name		: 'register_tools_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		register_tools.content_div.appendChild(render_register_tools_block(self))

	// ── INSTALL FINISH BLOCK ──
		const finish = create_section_block({
			label			: get_label.install_done || 'Done!',
			class_name		: 'installer_finish_block',
			hidden			: true,
			parent			: content_data,
			content_data	: content_data
		})
		finish.content_div.appendChild(render_installer_finish_block(self))


	return content_data
}//end get_content_data



/**
* RENDER_HELP_BLOCK
* Creates the help/documentation link section of the install wizard.
*
* Renders two rows: one linking to the official install guide and one linking to
* the configuration reference. Both links open in a new tab with rel="noopener noreferrer"
* to prevent tab-napping (SEC-033).
*
* @param {Object} self - The install instance (unused directly; retained for API consistency)
* @returns {DocumentFragment} Fragment containing the two documentation link rows
*/
const render_help_block = function(self) {

	const fragment = new DocumentFragment()

	// installation info
		const installer_info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description installer_info_node',
			inner_html		: get_label.installation_help_info || 'Installation info: ',
			parent			: fragment
		})
		ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'info icon',
			src				: 'https://dedalo.dev/tpl/assets/img/logos/logo_dedalo.svg',
			parent			: installer_info_node
		})
		// link
		const link_install = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'link',
			href			: 'https://dedalo.dev/docs/v7/install/',
			inner_html		: 'https://dedalo.dev/docs/v7/install/',
			parent			: installer_info_node
		})
		link_install.target	= '_blank'
		link_install.rel	= 'noopener noreferrer' // SEC-033

	// installation config
		const installer_config_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description installer_config_node',
			inner_html		: get_label.installation_config || 'Installation config: ',
			parent			: fragment
		})
		ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'info icon',
			src				: 'https://dedalo.dev/tpl/assets/img/logos/logo_dedalo.svg',
			parent			: installer_config_node
		})
		const link_configuration = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'link',
			href			: 'https://dedalo.dev/docs/v7/config/config/',
			inner_html		: 'https://dedalo.dev/docs/v7/config/config/',
			target			: '_blank',
			parent			: installer_config_node
		})
		link_configuration.target	= '_blank'
		link_configuration.rel		= 'noopener noreferrer' // SEC-033


	return fragment
}//end render_help_block



/**
* RENDER_INIT_TEST_BLOCK
* Creates the server environment pre-flight result section.
*
* Reads `context.properties.init_test` (a server-populated object) and renders either
* an error message (when the test failed or the property is absent) or a success/warning
* message. On success it wires a when_in_viewport observer that reveals config_block once
* this message scrolls into view, creating the step-by-step wizard progression.
*
* init_test shape expected from the server:
*   {
*     result  : {boolean},   // false → pre-flight failed
*     errors  : {boolean},   // true → passed with warnings
*     msg     : {Array}      // array of human-readable result strings
*   }
*
* @param {Object} self - The install instance (provides self.context.properties and self.node)
* @returns {DocumentFragment} Fragment with one status message element
*/
const render_init_test_block = function(self) {

	// short vars
		const properties	= self.context.properties
		const init_test		= properties.init_test || null
		const server_info	= properties.server_info || null

	const fragment = new DocumentFragment()

	// fail init_test case
	// Guard against both missing property and explicit result:false.
	// When init_test is absent it usually means a PHP fatal prevented the context from
	// being built at all; show a generic error rather than crashing.
		if (!init_test || init_test.result===false) {
			const msg_lines = (init_test && Array.isArray(init_test.msg) && init_test.msg.length)
				? init_test.msg
				: ['Init test fails (unknown server error)']
			// TEXT nodes + real <br> elements — server diagnostics are never markup
			append_text_lines(
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg error',
					parent			: fragment
				}),
				msg_lines
			)

			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'init_test_summary fail',
				inner_html		: '<span class="summary_icon">&#10060;</span> Server diagnostics failed',
				parent			: fragment
			})
		}

	// ── DIAGNOSTICS GRID ──
		const diagnostics_grid = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'diagnostics_grid',
			parent			: fragment
		})

		// helper: add a diagnostic card
		const add_card = function(label, value, status) {
			const card = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagnostic_card',
				parent			: diagnostics_grid
			})
			// icon
			const icon_class = status || 'info'
			const icon_char	= status === 'pass' ? '&#10003;'
				: status === 'fail' ? '&#10007;'
				: status === 'warn' ? '&#9888;'
				: '&#8505;'
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagnostic_icon ' + icon_class,
				inner_html		: icon_char,
				parent			: card
			})
			// info
			const info = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagnostic_info',
				parent			: card
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagnostic_label',
				inner_html		: label,
				parent			: info
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'diagnostic_value',
				text_content	: value,
				parent			: info
			})
		}

		// NOTE (DEC-19, TS-native installer): the PHP/Apache-specific diagnostic
		// cards (PHP Version / Memory Limit / PHP Memory / Max Execution Time /
		// Apache / PHP User / GD / mbstring) were removed — the Bun server has no
		// PHP, so those were always '—'. This installer client is a TS-OWNED
		// divergence from the PHP copy (excluded from scripts/sync_client.sh,
		// ledgered WC-2026-07-09-installer-diagnostics-grid in
		// engineering/wire_contract/). The real progression gate is init_test.result.

		// RAM
		add_card(
			'System RAM',
			server_info?.ram || '—',
			server_info?.ram ? 'pass' : 'info'
		)

		// CPU frequency
		add_card(
			'CPU Frequency',
			server_info?.cpu_mhz || '—',
			server_info?.cpu_mhz ? 'info' : 'info'
		)

		// PostgreSQL version
		add_card(
			'PostgreSQL',
			server_info?.pg_version || '—',
			server_info?.pg_version ? 'pass' : 'warn'
		)

		// Disk free space
		add_card(
			'Disk Free Space',
			server_info?.disk_free_space || '—',
			server_info?.disk_free_space ? 'pass' : 'info'
		)

		// OS / Platform
		add_card(
			'Platform',
			server_info?.platform || '—',
			'info'
		)

		// Server software
		add_card(
			'Server Software',
			server_info?.server_software || '—',
			'info'
		)

		// ImageMagick
		add_card(
			'ImageMagick',
			server_info?.imagemagick || '—',
			server_info?.imagemagick_supported === true ? 'pass'
				: server_info?.imagemagick ? 'warn'
				: 'warn'
		)

		// FFmpeg
		add_card(
			'FFmpeg',
			server_info?.ffmpeg || '—',
			server_info?.ffmpeg_supported === true ? 'pass'
				: server_info?.ffmpeg ? 'warn'
				: 'warn'
		)

		// cURL
		add_card(
			'cURL',
			server_info?.curl || '—',
			server_info?.curl ? 'pass' : 'warn'
		)

		// OpenSSL
		add_card(
			'OpenSSL',
			server_info?.openssl || '—',
			server_info?.openssl ? 'pass' : 'warn'
		)

	// ── SUMMARY BANNER ──
		const has_errors	= init_test && init_test.errors && init_test.errors.length > 0
		const summary_status = !init_test || init_test.result === false
			? 'fail'
			: has_errors
				? 'warn'
				: 'pass'
		const summary_icon	= summary_status === 'pass' ? '&#10003;'
			: summary_status === 'fail' ? '&#10060;'
			: '&#9888;'
		const summary_text	= summary_status === 'pass'
			? 'All diagnostics passed'
			: summary_status === 'fail'
				? 'Diagnostics failed — fix errors above to continue'
				: 'Diagnostics passed with warnings'

		const summary_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'init_test_summary ' + summary_status,
			inner_html		: '<span class="summary_icon">' + summary_icon + '</span> ' + summary_text,
			parent			: fragment
		})

	// show individual test messages if any (only when init_test passed, since errors are already shown above on fail)
		if (init_test && init_test.result !== false && init_test.msg && init_test.msg.length > 0) {
			const add_css = has_errors ? 'warning' : 'ok'
			append_text_lines(
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + add_css,
					parent			: fragment
				}),
				init_test.msg
			)
		}

	// auto-reveal config block when diagnostics are in viewport.
	// Gate on diagnostics passing: a hard failure (result===false) or a missing init_test
	// (PHP fatal before context build) means the server prerequisites are not met. The summary
	// banner above instructs the user to "fix errors above to continue", so we must NOT expose
	// the config form here — otherwise that instruction is never actually enforced and the user
	// proceeds to enter DB credentials on a server that cannot run Dédalo.
		when_in_viewport(
			summary_node,
			() => {
				if (!init_test || init_test.result===false) {
					return // diagnostics failed → keep config steps hidden, stay on diagnostics
				}
				const first = self.node.content_data._first_config || 'config_block'
				const first_section = self.node.content_data[first]
				if (first_section) {
					first_section.classList.remove('hide')
				}
				update_step_indicator(self.node.content_data.step_indicator, 2)
			}
		)


	return fragment;
}//end render_init_test_block



/**
* RENDER_CONFIG_BLOCK
* Creates the database configuration validation status section.
*
* Reads `context.properties.db_status` (a server-populated object) and renders a
* hierarchical summary of each configuration sub-check. When global_status is false the
* function renders per-item error/ok indicators (db name, username, password, information
* schema, info key, and connection) and returns early so the user sees exactly what to fix
* in dedalo_config.php. When global_status is true it renders a single "passed" message.
*
* db_status shape expected from the server:
*   {
*     global_status           : {boolean},
*     config_check            : {boolean},  // config file parsed successfully
*     config_db_name_check    : {boolean},
*     config_user_name_check  : {boolean},
*     config_pw_check         : {boolean},
*     config_information_check: {boolean},
*     config_info_key_check   : {boolean},
*     db_connection_check     : {boolean}   // actual TCP connection to PostgreSQL
*   }
*
* @param {Object} self - The install instance (provides self.context.properties)
* @returns {DocumentFragment} Fragment with status message(s) and optional error detail nodes
*/
const render_config_block = function(self) {

	// short vars
		const properties	= self.context.properties
		const db_status		= properties.db_status || null

	const fragment = new DocumentFragment()

	// fail db_status case
	// If the server could not even assemble db_status (e.g. config file unreadable),
	// there is nothing useful to display — show a generic context-failure message.
		if (!db_status) {
			// if the db_status is not set the installation process can not be start
			// some error was happen in the server.
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'msg error',
				inner_html		: get_label.failed_install_context || 'Server has failed to get context for db status',
				parent			: fragment
			})

			return fragment
		}//end if (!db_status)

	// fail global_status case
	// Render one indicator node per sub-check so the operator can identify precisely
	// which values in dedalo_config.php need correction before retrying.
		if (db_status.global_status===false) {

			// warning errors message
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg error',
					inner_html		: get_label.config_has_errors || 'Configuration test contains errors!',
					parent			: fragment
				})

			// errors
				const db_status_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'container_errors',
					parent			: fragment
				})

			// db config_check (global)
			// Top-level check: could the config file be found and parsed at all?
				const db_config_check_label = db_status.config_check
					? get_label.db_config_check_ok || 'Database: db config ok'
					: get_label.db_config_check_invalid || 'Database: db config invalid!'
				const db_config_check_class = db_status.config_check
					? 'ok'
					: 'error'
				const db_config_check_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_config_check_class,
					inner_html		: db_config_check_label,
					parent			: db_status_container
				})

			// config db name
				const db_name_label = db_status.config_db_name_check
					? get_label.db_name_ok || 'Database: db name config ok'
					: get_label.db_name_invalid || 'Database: db name config invalid!'
				const db_name_class = db_status.config_db_name_check
					? 'ok'
					: 'error'
				const db_name_check = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_name_class,
					inner_html		: db_name_label,
					parent			: db_config_check_node
				})

			// config user_name_check
				const user_name_label = db_status.config_user_name_check
					? get_label.db_username_ok || 'Database: username config ok'
					: get_label.db_username_invalid || 'Database: username config invalid!'
				const db_username_class = db_status.config_user_name_check
					? 'ok'
					: 'error'
				const db_username_check = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_username_class,
					inner_html		: user_name_label,
					parent			: db_config_check_node
				})

			// config pw_check
				const pw_label = db_status.config_pw_check
					? get_label.db_pw_ok || 'Database: pw config ok'
					: get_label.db_pw_invalid || 'Database: pw config invalid!'
				const db_pw_class = db_status.config_pw_check
					? 'ok'
					: 'error'
				const db_pw_check = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_pw_class,
					inner_html		: pw_label,
					parent			: db_config_check_node
				})
			// config information_check
				const information_label = db_status.config_information_check
					? get_label.db_information_ok || 'Database: information config ok'
					: get_label.db_information_invalid || 'Database: information config invalid!'
				const db_information_class = db_status.config_information_check
					? 'ok'
					: 'error'
				const db_information_check = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_information_class,
					inner_html		: information_label,
					parent			: db_config_check_node
				})
			// config info_key_check
				const info_key_label = db_status.config_info_key_check
					? get_label.db_info_key_ok || 'Database: information key config ok'
					: get_label.db_info_key_invalid || 'Database: information key config invalid!'
				const db_info_key_class = db_status.config_info_key_check
					? 'ok'
					: 'error'
				const db_info_key_check = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_info_key_class,
					inner_html		: info_key_label,
					parent			: db_config_check_node
				})

			// db connection_check
			// The connection check is rendered outside db_config_check_node because it
			// tests a live TCP handshake rather than a config-value parse, so it is
			// logically a sibling of config_check rather than a child.
				const db_connection_check_label = db_status.db_connection_check
					? get_label.db_connection_check_ok || 'Database: db connection ok'
					: get_label.db_connection_check_invalid || 'Database: db connection invalid!'
				const db_connection_check_class = db_status.db_connection_check
					? 'ok'
					: 'error'
				// db_connection_check_node
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_connection_check_class,
					inner_html		: db_connection_check_label,
					parent			: fragment
				})

			// db writable_check
				const db_writable_check_label = db_status.db_writable_check
					? get_label.db_writable_check_ok || 'Database: db writable ok'
					: get_label.db_writable_check_invalid || 'Database: db is not writable! Check user permissions'
				const db_writable_check_class = db_status.db_writable_check
					? 'ok'
					: 'error'
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'msg ' + db_writable_check_class,
					inner_html		: db_writable_check_label,
					parent			: fragment
				})

			return fragment
		}//end if (db_status.global_status===false)

	// config is OK message
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'msg ' + 'ok',
			inner_html		: get_label.config_has_passed || 'Configuration test passed!',
			parent			: fragment
		})
	return fragment;
}//end render_config_block



/**
* RENDER_CONFIG_OPTIONS
* Creates the action-selector section shown after configuration checks pass.
*
* Renders up to three mutually exclusive buttons:
*   - "To install"        – always present; reveals installer_db_block and removes this options panel.
*   - "To update"         – only present when db_data_version[0] < 6 (migration from v5/v6);
*                           calls the 'to_update' API action and triggers a 5-second reload countdown.
*   - "To change root"    – always present; reveals set_root_password_block for a standalone
*                           password reset without re-running the full install.
*
* Each button removes the config_block_options panel on click to prevent double-submission.
*
* @param {Object} self - The install instance (provides self.context.properties and self.node)
* @returns {DocumentFragment} Fragment containing the action buttons and optional update-status div
*/
const render_config_options = function(self) {

	const fragment = new DocumentFragment()

	// installer_db_button
		const installer_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary installer_button',
			inner_html		: get_label.to_install || 'To install',
			parent			: fragment
		})
		installer_button.addEventListener('mouseup', async function() {
			// show the installer_db
			reveal_section(self.node.content_data.installer_db_block)
			update_step_indicator(self.node.content_data.step_indicator, 3)
			self.node.content_data.config_block.config_block_options.remove();
		})//end mouse_up event

	// db_data_version. Update option
	// Only show the "To update" button when an existing v5/v6 Dédalo database is detected.
	// db_data_version is an array; index [0] holds the major version number as a string.
		const db_data_version = (self.context.properties && self.context.properties.db_data_version)
			? self.context.properties.db_data_version
			: null
		if (db_data_version && db_data_version[0] && parseInt(db_data_version[0])<6) {

			const to_update_status = create_status_msg(fragment)

			const update_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'primary update_button',
				inner_html		: get_label.to_update || 'To update',
				parent			: fragment
			})
			update_button.addEventListener('mouseup', async function() {

				// remove other options
					installer_button.remove()

				// API call with spinner
					const api_response = await api_call_with_spinner({
						action			: 'to_update',
						status_node		: to_update_status,
						button_node		: update_button
					})

				// manage result
					if (request_failed(api_response) || response_data(api_response)===false) {
						console.error("to_update failed:", api_response.error || api_response);
					}else{
						console.log("to_update api_response:", api_response);
						countdown_and_reload(to_update_status, 3)
						update_button.remove()
					}

				// unlock button
					self.node.content_data.config_block.config_block_options.remove();
			})//end mouse_up event
		}

	// to reset root pw
	// A standalone path that skips DB creation and goes directly to the password-change
	// form; useful when the operator forgets the root password on an existing installation.
		const reset_root_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary installer_button',
			inner_html		: get_label.to_change_pw || 'To change root',
			parent			: fragment
		})
		reset_root_button.addEventListener('mouseup', async function() {
			// show the installer_db
			reveal_section(self.node.content_data.set_root_password_block)
			self.node.content_data.config_block.config_block_options.remove();
		})//end mouse_up event


	return fragment;
}//end render_config_options



/**
* RENDER_DB_CONFIG_BLOCK
* Modernized PostgreSQL configuration step. Collects the connection values, lets the
* administrator TEST the connection interactively (green/red), and on success reveals the
* entity step. Nothing is written to disk here — values accumulate in self._cfg and are
* persisted later by the "Save configuration" step. No manual config-file editing.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_db_config_block = function(self) {

	const fragment	= new DocumentFragment()
	const cfg		= self._cfg
	const db		= (self.context.properties && self.context.properties.db_config) || {}

	// placeholders from the catalog defaults must NOT prefill (force a real value)
	const is_placeholder = function(v, ph) { return (!v || v===ph) ? '' : v }

	// prerequisite note
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description',
			inner_html		: get_label.installation_db_prereq || 'Prerequisite: an accessible PostgreSQL database whose role can create tables, indexes and functions. Enter the connection details and test them.',
			parent			: fragment
		})

	// fields
		create_field({ parent:fragment, cfg, name:'db_hostname', label:get_label.hostname || 'Host', value: db.hostname || 'localhost', placeholder:'localhost', help:'Hostname or IP of the PostgreSQL server.' })
		create_field({ parent:fragment, cfg, name:'db_port', label:get_label.port || 'Port', value: (db.port || '5432'), placeholder:'5432', help:'TCP port. Leave the default unless your server uses another.' })
		create_field({ parent:fragment, cfg, name:'db_socket', label:get_label.socket || 'Unix socket (optional)', value:'', placeholder:'/var/run/postgresql', nullable:true, help:'Only for socket connections; leave empty for TCP.' })
		create_field({ parent:fragment, cfg, name:'db_database', label:get_label.db_name || 'Database name', value: is_placeholder(db.db_name, 'dedalo_mydatabase'), placeholder:'dedalo', help:'The database Dédalo will use. The role below must own it (or have full privileges on it).' })
		create_field({ parent:fragment, cfg, name:'db_username', label:get_label.username || 'Username', value: is_placeholder(db.user_name, 'myusername'), placeholder:'dedalo' })
		create_field({ parent:fragment, cfg, name:'db_password', label:get_label.password || 'Password', type:'password', value:'' })

	// status + test button
		const status = create_status_msg(fragment)
		const test_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary db_test_button',
			inner_html		: get_label.test_connection || 'Test connection',
			parent			: fragment
		})
		test_button.addEventListener('mouseup', async function() {
			const api_response = await api_call_with_spinner({
				action		: 'test_db_connection',
				body_options: {
					db_hostname	: cfg.db_hostname,
					db_port		: cfg.db_port,
					db_socket	: cfg.db_socket,
					db_database	: cfg.db_database,
					db_username	: cfg.db_username,
					db_password	: cfg.db_password
				},
				status_node	: status,
				button_node	: test_button
			})
			set_status_result(status, api_response)
			if (response_data(api_response)===true) {
				reveal_section(self.node.content_data.entity_block)
				update_step_indicator(self.node.content_data.step_indicator, 3)
			}
		})

	return fragment
}//end render_db_config_block



/**
* RENDER_ENTITY_BLOCK
* Collects the entity identity (name + label) and the install fingerprints
* (information + info key), plus timezone/locale. info/info_key are STATE values written to
* ../private/state.php and MUST NOT change after install — the copy warns about that.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_entity_block = function(self) {

	const fragment	= new DocumentFragment()
	const cfg		= self._cfg
	const entity	= (self.context.properties && self.context.properties.dedalo_entity) || ''
	const entity_val = (!entity || entity==='my_entity_name') ? '' : entity

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		inner_html		: get_label.installation_entity_help || 'Identify this installation. The information and info key are set once and must not be changed afterwards (they are part of how stored credentials are encrypted).',
		parent			: fragment
	})

	// keep references to the inputs so failed verification can highlight them (not just the status msg)
	const entity_input		= create_field({ parent:fragment, cfg, name:'entity', label:get_label.entity_name || 'Entity name', value:entity_val, placeholder:'my_institution', help:'Short machine name for this installation.' })
	create_field({ parent:fragment, cfg, name:'entity_label', label:get_label.entity_label || 'Entity label', value:'', placeholder:'My Institution', help:'Human-readable name (defaults to the entity name).' })
	const information_input	= create_field({ parent:fragment, cfg, name:'information', label:get_label.install_information || 'Install information', value:'', placeholder:'My Institution archive', help:'Fixed install fingerprint. Do not change after install.' })
	const info_key_input	= create_field({ parent:fragment, cfg, name:'info_key', label:get_label.info_key || 'Install info key', value:'', placeholder:'my_institution_key', help:'Fixed install fingerprint. Do not change after install.' })
	create_field({ parent:fragment, cfg, name:'timezone', label:get_label.timezone || 'Timezone', value:'Europe/Madrid', placeholder:'Europe/Madrid' })
	create_field({ parent:fragment, cfg, name:'locale', label:get_label.locale || 'Locale', value:'es-ES', placeholder:'es-ES' })

	// LANGUAGES (mandatory): the checked set drives DEDALO_APPLICATION_LANGS +
	// PROJECTS_DEFAULT_LANGS; the two dropdowns pick the default interface/data
	// language from the checked set. Without these the configured server refuses
	// to boot, so at least one language is required (validated on Continue).
	const props			= self.context.properties || {}
	const available_langs	= props.available_langs || {}
	const lang_codes		= Object.keys(available_langs)
	// The server owns the default (lang_catalog.ts INSTALL_DEFAULT_LANG_CODES); no
	// client-side "all languages" fallback — without the hint nothing is pre-ticked.
	const checked_default	= Array.isArray(props.install_checked_langs) ? props.install_checked_langs : []

	const langs_field = ui.create_dom_element({ element_type:'div', class_name:'installer_field', parent:fragment })
	ui.create_dom_element({ element_type:'label', class_name:'installer_field_label', inner_html:get_label.working_languages || 'Working languages', parent:langs_field })
	const langs_checks = ui.create_dom_element({ element_type:'div', class_name:'installer_langs_checks', parent:langs_field })
	const lang_checkboxes = {}
	lang_codes.forEach(function(code){
		const row = ui.create_dom_element({ element_type:'label', class_name:'installer_lang_check', parent:langs_checks })
		const cb = ui.create_dom_element({ element_type:'input', type:'checkbox', parent:row })
		cb.value = code
		cb.checked = checked_default.indexOf(code) !== -1
		cb.addEventListener('change', sync_langs)
		lang_checkboxes[code] = cb
		ui.create_dom_element({ element_type:'span', text_content:(available_langs[code] || code)+' ('+code+')', parent:row })
	})
	ui.create_dom_element({ element_type:'div', class_name:'installer_field_help', inner_html:'Languages this installation manages. At least one is required.', parent:langs_field })

	const app_lang_field = ui.create_dom_element({ element_type:'div', class_name:'installer_field', parent:fragment })
	ui.create_dom_element({ element_type:'label', class_name:'installer_field_label', inner_html:get_label.default_interface_language || 'Default interface language', parent:app_lang_field })
	const app_lang_select = ui.create_dom_element({ element_type:'select', class_name:'installer_field_input', parent:app_lang_field })

	const data_lang_field = ui.create_dom_element({ element_type:'div', class_name:'installer_field', parent:fragment })
	ui.create_dom_element({ element_type:'label', class_name:'installer_field_label', inner_html:get_label.default_data_language || 'Default data language', parent:data_lang_field })
	const data_lang_select = ui.create_dom_element({ element_type:'select', class_name:'installer_field_input', parent:data_lang_field })

	const checked_lang_codes = function(){ return lang_codes.filter(code => lang_checkboxes[code].checked) }
	// Rebuild a select's options from the checked langs, preserving the prior
	// choice when still valid (else the first checked lang). Returns the value set.
	const refresh_lang_select = function(select, prev){
		const codes = checked_lang_codes()
		select.innerHTML = ''
		codes.forEach(function(code){
			const opt = ui.create_dom_element({ element_type:'option', text_content:(available_langs[code] || code)+' ('+code+')', parent:select })
			opt.value = code
		})
		const want = (codes.indexOf(prev) !== -1) ? prev : (codes[0] || '')
		select.value = want
		return want
	}
	function sync_langs(){
		cfg.langs = checked_lang_codes()
		cfg.app_lang_default = refresh_lang_select(app_lang_select, cfg.app_lang_default)
		cfg.data_lang_default = refresh_lang_select(data_lang_select, cfg.data_lang_default)
	}
	app_lang_select.addEventListener('change', function(){ cfg.app_lang_default = app_lang_select.value })
	data_lang_select.addEventListener('change', function(){ cfg.data_lang_default = data_lang_select.value })
	// seed defaults from the context hints, then build the selects + cfg.langs
	cfg.app_lang_default = props.application_lang_default || (lang_codes[0] || '')
	cfg.data_lang_default = props.data_lang_default || (lang_codes[0] || '')
	sync_langs()

	// UPDATE SERVERS (WC-2026-10-08-install-plan-update-servers-core-lg): ticked =
	// the official master is written to ONTOLOGY_SERVERS + CODE_SERVERS; unticked =
	// air-gapped (both written as []). The default comes from the server context
	// (`update_servers.default`); an absent context means checked. Server-supplied
	// strings (the URL) go through text_content only.
	const update_servers_props	= props.update_servers || {}
	const official_servers		= update_servers_props.official || {}
	const official_url			= (official_servers.ontology && official_servers.ontology.url) || ''
	cfg.update_servers			= update_servers_props.default !== false

	const updates_field = ui.create_dom_element({ element_type:'div', class_name:'installer_field', parent:fragment })
	ui.create_dom_element({ element_type:'label', class_name:'installer_field_label', text_content:get_label.installation_updates || 'Updates', parent:updates_field })
	const updates_row = ui.create_dom_element({ element_type:'label', class_name:'installer_lang_check', parent:updates_field })
	const updates_checkbox = ui.create_dom_element({ element_type:'input', type:'checkbox', parent:updates_row })
	updates_checkbox.checked = cfg.update_servers
	ui.create_dom_element({ element_type:'span', text_content:get_label.installation_update_servers || 'Use the official Dédalo update server', parent:updates_row })
	if (official_url !== '') {
		ui.create_dom_element({ element_type:'div', class_name:'installer_field_help', text_content:official_url, parent:updates_field })
	}
	const airgapped_warning = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'installer_field_help' + (cfg.update_servers ? ' hide' : ''),
		text_content	: get_label.installation_update_servers_airgapped || 'Air-gapped: no ontology or code updates will be offered until a server is added to ONTOLOGY_SERVERS / CODE_SERVERS in ../private/.env',
		parent			: updates_field
	})
	updates_checkbox.addEventListener('change', function() {
		cfg.update_servers = updates_checkbox.checked === true
		airgapped_warning.classList.toggle('hide', cfg.update_servers)
		// the Ontologies step offers what the chosen source serves: re-read it
		if (typeof self._ontologies_refresh === 'function') {
			self._ontologies_refresh()
		}
	})

	// required field → its input, so validation can flag the exact offending field
	const required_inputs = { entity:entity_input, information:information_input, info_key:info_key_input }

	const status = create_status_msg(fragment)
	const next_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'primary entity_next_button',
		inner_html		: get_label.continue_label || 'Continue',
		parent			: fragment
	})
	next_button.addEventListener('mouseup', function() {
		// clear any previous field highlights before re-validating
		Object.values(required_inputs).forEach(input => input.classList.remove('invalid'))
		// minimal required-field validation (no server round-trip needed)
		const missing = ['entity','information','info_key'].filter(k => !cfg[k] || String(cfg[k]).trim()==='')
		if (missing.length>0) {
			missing.forEach(k => { if (required_inputs[k]) required_inputs[k].classList.add('invalid') })
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = (get_label.required_fields || 'Please fill the required fields') + ': ' + missing.join(', ')
			return
		}
		// Entity is a MACHINE identifier (drives paths, the session name, media folder). Reject
		// spaces/special chars — they break the session name and produce ugly paths. Suggest a slug.
		const entity_val = String(cfg.entity).trim()
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(entity_val)) {
			const suggestion = entity_val.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'my_entity'
			entity_input.classList.add('invalid')
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = (get_label.entity_invalid || 'Entity name must start with a letter and contain only letters, numbers and underscores (no spaces). Try: ') + suggestion
			return
		}
		// LANGUAGES: at least one working language, and the two defaults must be
		// among the selected set (a missing lang set makes the configured server
		// refuse to boot — persist_config enforces the same server-side).
		if (!Array.isArray(cfg.langs) || cfg.langs.length===0) {
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = get_label.languages_required || 'Select at least one working language'
			return
		}
		if (cfg.langs.indexOf(cfg.app_lang_default)===-1 || cfg.langs.indexOf(cfg.data_lang_default)===-1) {
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = get_label.language_default_invalid || 'The default interface and data languages must be among the selected languages'
			return
		}
		status.classList.remove('error'); status.classList.add('ok')
		status.textContent = 'OK'
		reveal_section(self.node.content_data.ontologies_block)
		update_step_indicator(self.node.content_data.step_indicator, 4)
	})

	return fragment
}//end render_entity_block



/**
* ONTOLOGY_NOTE_FALLBACKS
* English fallbacks of the explanatory notes the server names per catalog entry
* (`note_key` — src/core/install/ontology_choice.ts ONTOLOGY_NOTE_LABELS). The
* wizard runs pre-login, so a catalog label may be absent: the note must still read.
*/
const ONTOLOGY_NOTE_FALLBACKS = {
	installation_ontology_note_oh	: 'Oral history: interviews, their audiovisual recordings, transcriptions and indexing. Built in — installable without a network.',
	installation_ontology_note_tch	: 'Tangible cultural heritage: the general inventory model for objects and collections. Downloaded from the update server.'
}



/**
* RENDER_WARNING_LINES
* Appends one warning box holding each server warning as its own line. The
* warnings are server text (they name TLDs and remedies): text_content only.
* Non-blocking by design — the caller decides nothing from them.
* @param HTMLElement parent
* @param array|undefined warnings
* @return HTMLElement|null the box, or null when there is nothing to show
*/
const render_warning_lines = function(parent, warnings) {

	const lines = (Array.isArray(warnings) ? warnings : [])
		.filter(line => typeof line==='string' && line!=='')
	if (lines.length===0) {
		return null
	}

	const box = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'msg warning installer_warning_lines',
		parent			: parent
	})
	for (const line of lines) {
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: line,
			parent			: box
		})
	}

	return box
}//end render_warning_lines



/**
* ONTOLOGY_ENTRY_LABEL
* The visible name of one catalog entry. The manifest names read "Oral History | oh";
* the TLD is appended only when the name does not already carry it.
* @param object entry (OntologyCatalogView entry)
* @return string
*/
const ontology_entry_label = function(entry) {

	const name = (typeof entry.name==='string' && entry.name!=='') ? entry.name : entry.tld

	return name.indexOf(entry.tld)!==-1
		? name
		: name + ' [' + entry.tld + ']'
}//end ontology_entry_label



/**
* ONTOLOGY_DEPENDENCY_TEXT
* What ticking this entry brings with it: the declared dependencies the installer
* installs too (`also_installs`, deps of deps included, core excluded), the
* "not declared" warning when the source does not declare them
* (`dependencies === null` — an older ontology server, or a built-in
* ontology.json that predates hierarchy60), or '' (nothing more).
* @param object entry (OntologyCatalogView entry)
* @return object { text, warning }
*/
const ontology_dependency_text = function(entry) {

	if (entry.dependencies===null) {
		// the built-in (vendored) ontology.json may predate the declaration
		// (hierarchy60) — not a server's fault, so say where it comes from
		return {
			text	: entry.origin==='vendored'
				? (get_label.installation_ontologies_undeclared_builtin || 'The built-in ontology file does not declare what this ontology depends on (a release that predates the declaration): it is installed alone over the core ontologies.')
				: (get_label.installation_ontologies_undeclared || 'The ontology server does not declare what this ontology depends on (an older server): it is installed alone, and anything it references in other ontologies stays unresolved.'),
			warning	: true
		}
	}
	const also = Array.isArray(entry.also_installs) ? entry.also_installs : []
	if (also.length===0) {
		return { text : '', warning : false }
	}

	return {
		text	: (get_label.installation_ontologies_also_installs || 'Also installs:') + ' ' + also.join(', '),
		warning	: false
	}
}//end ontology_dependency_text



/**
* DEPENDENCY_DECLINE_TOKEN
* The `declined_dependencies` token of one declared dependency: `<tld>:<main>`
* (the plan also accepts a bare TLD — both mains — but the wizard declines
* exactly the row the operator unticked).
* @param object dependency {tld, main, mandatory}
* @return string
*/
const dependency_decline_token = function(dependency) {

	return dependency.tld + ':' + dependency.main
}//end dependency_decline_token



/**
* IS_FIXED_DEPENDENCY
* True when a declared dependency names something the SEED always installs, so
* it is never a choice: a core ontology (`properties.ontologies.core`, or the
* engine-owned `ddengine` — the server's isFixedTld) for `main: ontology35`, a
* core hierarchy (`properties.core_hierarchies`, lg) for `main: hierarchy1`.
* The server never lets such a dependency be declined either
* (ontology_choice.ts followOntologyDependencies / isListedThesaurus).
* @param object dependency {tld, main, mandatory}
* @param array core_ontologies the core ontology TLDs
* @param array core_hierarchies [{tld, label}]
* @return bool
*/
const is_fixed_dependency = function(dependency, core_ontologies, core_hierarchies) {

	if (dependency.main==='hierarchy1') {
		return core_hierarchies.some(item => item && item.tld===dependency.tld)
	}

	return dependency.tld==='ddengine' || core_ontologies.includes(dependency.tld)
}//end is_fixed_dependency



/**
* RENDER_DEPENDENCY_ROW
* One DECLARED dependency of a ticked ontology (hierarchy60): a checkbox that is
* checked and LOCKED when it is a mandatory ONTOLOGY (always installed), checked
* but EDITABLE otherwise (unticking declines it — the token travels as
* `cfg.declined_dependencies`). A MANDATORY THESAURUS (`main: hierarchy1`) is
* checked, EDITABLE and marked "strongly recommended" (owner decision
* 2026-10-10: a thesaurus never blocks an install); unticking it shows the
* warning that it can be installed later. `main: hierarchy1` rows are thesauri
* (installed at the "Install hierarchies" step), `main: ontology35` rows are
* ontologies. A FIXED dependency (a core ontology / core thesaurus: the seed
* always installs it — see is_fixed_dependency) is checked and LOCKED too,
* whatever its `mandatory`: unticking it could change nothing.
* Server strings → text_content only (SEC-032).
* @param object dependency {tld, main, mandatory}
* @param Set declined the declined tokens (mutated on change)
* @param function on_change
* @param bool fixed the dependency is always installed (core)
* @return HTMLElement li
*/
const render_dependency_row = function(dependency, declined, on_change, fixed) {

	const token = dependency_decline_token(dependency)
	const is_thesaurus = dependency.main==='hierarchy1'
	// a mandatory THESAURUS is a strong recommendation, never a lock
	const recommended = fixed!==true && dependency.mandatory===true && is_thesaurus
	const locked = fixed===true || (dependency.mandatory===true && !is_thesaurus)
	const li = ui.create_dom_element({
		element_type	: 'li',
		class_name		: 'ontology_dependency' + (locked ? ' mandatory' : (recommended ? ' recommended' : ' optional'))
	})
	const label = ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'hierarchy_label ontology_dependency_label',
		parent			: li
	})
	const checkbox = ui.create_dom_element({
		element_type	: 'input',
		type			: 'checkbox',
		class_name		: 'hierarchy_checkbox',
		parent			: label
	})
	checkbox.value		= token
	checkbox.checked	= locked || !declined.has(token)
	checkbox.disabled	= locked
	const kind = dependency.main==='hierarchy1'
		? (get_label.installation_dependency_thesaurus || 'thesaurus')
		: (get_label.installation_dependency_ontology || 'ontology')
	const status_text = fixed===true
		? (get_label.installation_dependency_core || 'core — always installed')
		: recommended
			? (get_label.installation_dependency_recommended || 'strongly recommended — untick only to install it later')
			: dependency.mandatory===true
				? (get_label.installation_dependency_required || 'required — always installed')
				: (get_label.installation_dependency_optional || 'optional — untick to skip it')
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: dependency.tld + ' (' + kind + ', ' + status_text + ')',
		parent			: label
	})
	// declining a strongly recommended thesaurus: say so, and where to install it later
	const warning_node = recommended
		? ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_field_help warning recommended_declined',
			text_content	: get_label.installation_dependency_recommended_warning || 'Not installed now. This thesaurus is strongly recommended: you can install it later from Maintenance › Install hierarchies.',
			parent			: li
		  })
		: null
	const sync_warning = function() {
		if (warning_node) {
			warning_node.classList.toggle('hide', checkbox.checked)
		}
	}
	sync_warning()

	if (!locked) {
		checkbox.addEventListener('change', function() {
			if (checkbox.checked) {
				declined.delete(token)
			}else{
				declined.add(token)
			}
			sync_warning()
			on_change()
		})
	}

	return li
}//end render_dependency_row



/**
* RENDER_ONTOLOGY_ENTRY
* One catalog row: checkbox + name, the explanatory note (when the server names
* one), the dependency line and the declared-dependency rows (a mandatory
* ontology locked, everything else pre-ticked and editable — render_dependency_row), shown only while the row is
* ticked. Every server-supplied string goes through text_content (SEC-032).
* @param object entry (OntologyCatalogView entry)
* @param Set selected the ticked TLDs (mutated on change)
* @param Set declined the declined dependency tokens (mutated on change)
* @param function on_change called after every tick/untick
* @param function is_fixed dependency → bool (is_fixed_dependency, bound)
* @return HTMLElement li
*/
const render_ontology_entry = function(entry, selected, declined, on_change, is_fixed) {

	const li = ui.create_dom_element({
		element_type	: 'li',
		class_name		: 'ontology_entry'
	})

	const label = ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'hierarchy_label ontology_label',
		parent			: li
	})
	const checkbox = ui.create_dom_element({
		element_type	: 'input',
		type			: 'checkbox',
		class_name		: 'hierarchy_checkbox',
		parent			: label
	})
	checkbox.value		= entry.tld
	checkbox.checked	= selected.has(entry.tld)
	ui.create_dom_element({
		element_type	: 'span',
		text_content	: ontology_entry_label(entry),
		parent			: label
	})

	// note (oh, tch): a label key named by the server
	const note_text = entry.note_key
		? (get_label[entry.note_key] || ONTOLOGY_NOTE_FALLBACKS[entry.note_key] || '')
		: ''
	if (note_text!=='') {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_field_help ontology_note',
			text_content	: note_text,
			parent			: li
		})
	}

	// dependencies: visible while ticked
	const dependency = ontology_dependency_text(entry)
	const dependency_node = dependency.text!==''
		? ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_field_help ontology_dependencies' + (dependency.warning ? ' warning' : ''),
			text_content	: dependency.text,
			parent			: li
		  })
		: null
	// declared dependencies: a mandatory ONTOLOGY and FIXED (core — the seed always
	// installs it) locked; thesauri (mandatory = strongly recommended) and optional
	// ontologies pre-ticked and editable
	const declared = Array.isArray(entry.dependencies) ? entry.dependencies : []
	const dependencies_node = declared.length>0
		? ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'ontology_dependency_list',
			parent			: li
		  })
		: null
	for (const dependency of declared) {
		dependencies_node.appendChild(render_dependency_row(dependency, declined, on_change, is_fixed(dependency)))
	}
	const sync_dependency = function() {
		if (dependency_node) {
			dependency_node.classList.toggle('hide', !checkbox.checked)
		}
		if (dependencies_node) {
			dependencies_node.classList.toggle('hide', !checkbox.checked)
		}
	}
	sync_dependency()

	checkbox.addEventListener('change', function() {
		if (checkbox.checked) {
			selected.add(entry.tld)
		}else{
			selected.delete(entry.tld)
		}
		sync_dependency()
		on_change()
	})

	return li
}//end render_ontology_entry



/**
* GROUP_ONTOLOGY_ENTRIES
* The catalog entries grouped by typology name, in the server's order (default
* first, then typology, then TLD — describeOntologyCatalog sorts them).
* @param array entries
* @return array [{ name, entries }]
*/
const group_ontology_entries = function(entries) {

	const groups = new Map()
	for (const entry of entries) {
		const name = (typeof entry.typology_name==='string' && entry.typology_name!=='')
			? entry.typology_name
			: (get_label.others || 'Others')
		if (!groups.has(name)) {
			groups.set(name, [])
		}
		groups.get(name).push(entry)
	}

	return [...groups].map(([name, group_entries]) => ({ name, entries:group_entries }))
}//end group_ontology_entries



/**
* RENDER_ONTOLOGY_GROUP
* One typology group as a <details>. A group opens when it holds a default, a
* noted (oh, tch) or a ticked entry — the domain models; every other group (the
* thesaurus typologies: toponymy, thematic, semantics…) starts collapsed, so a
* server catalog of a few hundred TLDs stays readable.
* @param object group { name, entries }
* @param Set selected
* @param Set declined
* @param function on_change
* @param function is_fixed dependency → bool (is_fixed_dependency, bound)
* @return HTMLElement details
*/
const render_ontology_group = function(group, selected, declined, on_change, is_fixed) {

	const details = ui.create_dom_element({
		element_type	: 'details',
		class_name		: 'ontology_group'
	})
	details.open = group.entries.some(entry => entry.is_default===true || !!entry.note_key || selected.has(entry.tld))

	ui.create_dom_element({
		element_type	: 'summary',
		class_name		: 'typology_label',
		text_content	: group.name + ' (' + group.entries.length + ')',
		parent			: details
	})

	const ul = ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'ontology_ul',
		parent			: details
	})
	for (const entry of group.entries) {
		ul.appendChild(render_ontology_entry(entry, selected, declined, on_change, is_fixed))
	}

	return details
}//end render_ontology_group



/**
* RENDER_ONTOLOGIES_BLOCK
* The "Ontologies" step (WC-2026-10-09-install-domain-ontologies): which DOMAIN
* ontologies this installation carries beyond the core the database seed ships.
*
*  - core (`properties.ontologies.core`) is shown as fixed rows — never a choice;
*  - the built-in catalog (`properties.ontologies.offline`: the vendored `oh`) is
*    rendered at once, with no network;
*  - when the update-server box (Entity step) is ticked, the step asks the server
*    for the configured ontology server's catalog (`get_ontology_catalog`) the first
*    time it appears and again whenever the box changes; an unreadable server
*    (`data:false`) is reported and the built-in catalog stays offered;
*  - `properties.ontologies.default` (oh) is pre-ticked; tch carries its note but
*    is not; a ticked entry shows what it also installs (the DECLARED dependencies)
*    or the not-declared warning, and one row per declared dependency
*    (hierarchy60): a MANDATORY ONTOLOGY checked and locked; every other row
*    pre-ticked (a mandatory THESAURUS marked strongly recommended) — unticking
*    one declines it (`cfg.declined_dependencies`, `<tld>:<main>`);
*  - at least one domain ontology is required. The choice travels as
*    `cfg.ontologies` with persist_config — only TLDs the current catalog offers.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_ontologies_block = function(self) {

	const fragment		= new DocumentFragment()
	const cfg			= self._cfg
	const props			= self.context.properties || {}
	const context		= props.ontologies || {}
	const offline_view	= context.offline || { entries:[], warnings:[] }
	const core			= Array.isArray(context.core) ? context.core : []
	const core_hierarchies	= Array.isArray(props.core_hierarchies) ? props.core_hierarchies : []
	// a dependency the seed always installs is shown locked, never a choice
	const is_fixed		= dependency => is_fixed_dependency(dependency, core, core_hierarchies)

	// the ticked TLDs — kept across catalog reloads; only the offered ones are posted
	const selected = new Set(Array.isArray(context.default) ? context.default : [])
	// the declined dependency tokens (optional ones, and recommended thesauri) (`<tld>:<main>`) — kept across reloads
	const declined = new Set()
	let offered = []

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		text_content	: get_label.installation_ontologies_help || 'Choose the domain ontologies this installation will catalogue with. The core ontologies are always installed; each chosen ontology brings the ontologies it declares as dependencies.',
		parent			: fragment
	})

	// core: fixed rows, not checkboxes
	if (core.length>0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description info core_hierarchies',
			text_content	: (get_label.core_hierarchies_always || 'Always installed:') + ' ' + core.join(', '),
			parent			: fragment
		})
	}

	const airgapped_note = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'installer_field_help ontology_airgapped hide',
		text_content	: get_label.installation_ontologies_airgapped || 'Air-gapped: only the built-in ontology (Oral history, oh) is offered. Tick the update server in the Entity step to choose from its catalog.',
		parent			: fragment
	})
	const source_status	= create_status_msg(fragment)
	const list			= ui.create_dom_element({ element_type:'div', class_name:'ontology_container', parent:fragment })
	const status		= create_status_msg(fragment)
	const next_button	= ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'primary ontologies_next_button',
		text_content	: get_label.continue_label || 'Continue',
		parent			: fragment
	})

	// cfg.ontologies = ticked ∩ offered, in catalog order; the declined tokens as-is
	// (a token no ticked ontology declares is inert in the plan)
	const sync_cfg = function() {
		cfg.ontologies = offered.filter(tld => selected.has(tld))
		cfg.declined_dependencies = [...declined]
		status.classList.remove('ok', 'error')
		status.textContent = ''
	}

	const render_list = function(view) {
		const entries = Array.isArray(view.entries) ? view.entries : []
		offered = entries.map(entry => entry.tld)
		// a catalog that offers none of the ticked TLDs (e.g. the box was unticked
		// after tch was chosen) falls back to the default instead of an empty choice
		if (!offered.some(tld => selected.has(tld))) {
			for (const tld of (Array.isArray(context.default) ? context.default : [])) {
				if (offered.includes(tld)) selected.add(tld)
			}
		}
		list.replaceChildren()
		for (const group of group_ontology_entries(entries)) {
			list.appendChild(render_ontology_group(group, selected, declined, sync_cfg, is_fixed))
		}
		render_warning_lines(list, view.warnings)
		sync_cfg()
	}

	// catalog loading: the newest request wins (the box may change mid-flight)
	let request_seq		= 0
	let revealed		= false
	const load_catalog = async function() {
		const seq				= ++request_seq
		const update_servers	= cfg.update_servers!==false
		airgapped_note.classList.toggle('hide', update_servers)
		source_status.classList.remove('ok', 'error', 'warning')
		source_status.textContent = ''
		if (!update_servers) {
			render_list(offline_view)
			return
		}
		const api_response = await api_call_with_spinner({
			action			: 'get_ontology_catalog',
			body_options	: { update_servers : true },
			status_node		: source_status,
			timeout			: 60*1000,
			spinner_label	: get_label.installation_ontologies_loading || 'Reading the update server\'s ontology catalog…'
		})
		if (seq!==request_seq) {
			return // superseded by a newer request
		}
		const catalog = response_extension(api_response, 'catalog')
		const view = (catalog && Array.isArray(catalog.entries)) ? catalog : offline_view
		if (request_failed(api_response) || response_data(api_response)!==true) {
			source_status.classList.add('warning')
			source_status.textContent = (get_label.installation_ontologies_unreachable || 'The update server\'s ontology catalog could not be read — only the built-in ontologies are offered.') + ' ' + server_text(api_response)
		}
		render_list(view)
	}

	// the built-in catalog at once; the server's when the step first appears
	render_list(offline_view)
	self._ontologies_on_reveal = function() {
		if (revealed) return
		revealed = true
		load_catalog()
	}
	self._ontologies_refresh = function() {
		if (revealed) {
			load_catalog()
		}
	}

	next_button.addEventListener('mouseup', function() {
		sync_cfg()
		if (cfg.ontologies.length===0) {
			status.classList.add('error')
			status.textContent = get_label.installation_ontologies_required || 'Select at least one domain ontology (the default is Oral history, oh).'
			return
		}
		status.classList.add('ok')
		status.textContent = 'OK'
		reveal_section(self.node.content_data.diffusion_block)
		update_step_indicator(self.node.content_data.step_indicator, 5)
	})

	return fragment
}//end render_ontologies_block



/**
* RENDER_DIFFUSION_BLOCK
* Optional MariaDB/MySQL (Bun diffusion engine) configuration. A checkbox enables the fields;
* when enabled the connection must be tested green before continuing. On continue the values
* are kept in self._cfg (cfg.diffusion flag) for the dual-write at persist time.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_diffusion_block = function(self) {

	const fragment	= new DocumentFragment()
	const cfg		= self._cfg
	cfg.diffusion	= false
	let tested_ok	= false

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		inner_html		: get_label.installation_diffusion_help || 'Optional: the diffusion (publication) engine uses a MariaDB/MySQL database. Enable it only if you will publish content. You can configure it later.',
		parent			: fragment
	})

	// enable toggle
		const toggle_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'installer_toggle_label',
			inner_html		: get_label.enable_diffusion || 'Enable diffusion database',
			parent			: fragment
		})
		const toggle = ui.create_dom_element({ element_type:'input', type:'checkbox', class_name:'installer_toggle' })
		toggle_label.prepend(toggle)

	// fieldset (hidden until enabled)
		const fields = ui.create_dom_element({ element_type:'div', class_name:'diffusion_fields hide', parent:fragment })
		create_field({ parent:fields, cfg, name:'mysql_hostname', label:get_label.hostname || 'Host', value:'localhost', placeholder:'localhost' })
		create_field({ parent:fields, cfg, name:'mysql_port', label:get_label.port || 'Port', value:'3306', placeholder:'3306' })
		create_field({ parent:fields, cfg, name:'mysql_socket', label:get_label.socket || 'Unix socket (optional)', value:'', nullable:true, placeholder:'/run/mysqld/mysqld.sock' })
		create_field({ parent:fields, cfg, name:'mysql_database', label:get_label.db_name || 'Database name', value:'web_dedalo', placeholder:'web_dedalo' })
		create_field({ parent:fields, cfg, name:'mysql_username', label:get_label.username || 'Username', value:'', placeholder:'web' })
		create_field({ parent:fields, cfg, name:'mysql_password', label:get_label.password || 'Password', type:'password', value:'' })

	const status = create_status_msg(fragment)

	const test_button = ui.create_dom_element({ element_type:'button', class_name:'primary diffusion_test_button hide', inner_html:get_label.test_connection || 'Test connection', parent:fragment })
	const continue_button = ui.create_dom_element({ element_type:'button', class_name:'primary diffusion_continue_button', inner_html:get_label.continue_label || 'Continue', parent:fragment })

	toggle.addEventListener('change', function() {
		cfg.diffusion = toggle.checked
		tested_ok = false
		fields.classList.toggle('hide', !toggle.checked)
		test_button.classList.toggle('hide', !toggle.checked)
		continue_button.textContent = toggle.checked ? (get_label.continue_label || 'Continue') : (get_label.skip || 'Skip diffusion')
	})
	continue_button.textContent = get_label.skip || 'Skip diffusion'

	test_button.addEventListener('mouseup', async function() {
		const api_response = await api_call_with_spinner({
			action		: 'test_diffusion_connection',
			body_options: {
				mysql_hostname	: cfg.mysql_hostname,
				mysql_port		: cfg.mysql_port,
				mysql_socket	: cfg.mysql_socket,
				mysql_database	: cfg.mysql_database,
				mysql_username	: cfg.mysql_username,
				mysql_password	: cfg.mysql_password
			},
			status_node	: status,
			button_node	: test_button
		})
		set_status_result(status, api_response)
		tested_ok = (response_data(api_response)===true)
	})

	continue_button.addEventListener('mouseup', function() {
		if (cfg.diffusion===true && tested_ok!==true) {
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = get_label.test_diffusion_first || 'Test the diffusion connection successfully before continuing (or disable it).'
			return
		}
		reveal_section(self.node.content_data.mailer_block)
		update_step_indicator(self.node.content_data.step_indicator, 6)
	})

	return fragment
}//end render_diffusion_block



/**
* RENDER_MAILER_BLOCK
* Optional step: outbound email (SMTP relay). The engine relays through an existing
* mailbox; these settings become the DEDALO_SMTP_* keys and enable the login screen's
* password recovery emails. Mirrors the diffusion block: toggle, fieldset, a verify
* probe (connection + auth, no email sent) that must pass before continuing when enabled.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_mailer_block = function(self) {

	const fragment	= new DocumentFragment()
	const cfg		= self._cfg
	cfg.mailer		= false
	let tested_ok	= false

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		inner_html		: get_label.installation_mailer_help || 'Optional: outbound email lets users recover a forgotten password from the login screen (an 8-digit code is emailed to them). Dédalo relays through an existing SMTP mailbox — it never runs its own mail server. You can configure it later in ../private/.env.',
		parent			: fragment
	})

	// enable toggle
		const toggle_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'installer_toggle_label',
			inner_html		: get_label.enable_mailer || 'Enable outbound email (password recovery)',
			parent			: fragment
		})
		const toggle = ui.create_dom_element({ element_type:'input', type:'checkbox', class_name:'installer_toggle' })
		toggle_label.prepend(toggle)

	// fieldset (hidden until enabled)
		const fields = ui.create_dom_element({ element_type:'div', class_name:'mailer_fields hide', parent:fragment })
		create_field({ parent:fields, cfg, name:'smtp_host', label:get_label.hostname || 'Host', value:'', placeholder:'smtp.example.org' })
		create_field({ parent:fields, cfg, name:'smtp_port', label:get_label.port || 'Port', value:'587', placeholder:'587' })
		create_field({ parent:fields, cfg, name:'smtp_secure', label:get_label.encryption || 'Encryption', value:'tls', select:['tls','ssl','none'], help:get_label.smtp_secure_help || 'tls = STARTTLS (port 587) · ssl = implicit TLS (port 465) · none = unencrypted (localhost relays only)' })
		create_field({ parent:fields, cfg, name:'smtp_user', label:get_label.username || 'Username', value:'', nullable:true, placeholder:'dedalo@example.org' })
		create_field({ parent:fields, cfg, name:'smtp_pass', label:get_label.password || 'Password', type:'password', value:'', nullable:true })
		create_field({ parent:fields, cfg, name:'smtp_from', label:get_label.from_address || 'From address', value:'', nullable:true, placeholder:'dedalo@example.org', help:get_label.smtp_from_help || 'The sender address of outbound mail. When empty, the username is used.' })
		create_field({ parent:fields, cfg, name:'smtp_from_name', label:get_label.from_name || 'From name (optional)', value:'', nullable:true, placeholder:'Dédalo' })

	const status = create_status_msg(fragment)

	const test_button = ui.create_dom_element({ element_type:'button', class_name:'primary mailer_test_button hide', inner_html:get_label.test_connection || 'Test connection', parent:fragment })
	const continue_button = ui.create_dom_element({ element_type:'button', class_name:'primary mailer_continue_button', inner_html:get_label.continue_label || 'Continue', parent:fragment })

	toggle.addEventListener('change', function() {
		cfg.mailer = toggle.checked
		tested_ok = false
		fields.classList.toggle('hide', !toggle.checked)
		test_button.classList.toggle('hide', !toggle.checked)
		continue_button.textContent = toggle.checked ? (get_label.continue_label || 'Continue') : (get_label.skip_mailer || 'Skip outbound email')
	})
	continue_button.textContent = get_label.skip_mailer || 'Skip outbound email'

	test_button.addEventListener('mouseup', async function() {
		const api_response = await api_call_with_spinner({
			action		: 'test_mailer_connection',
			body_options: {
				smtp_host	: cfg.smtp_host,
				smtp_port	: cfg.smtp_port,
				smtp_secure	: cfg.smtp_secure,
				smtp_user	: cfg.smtp_user,
				smtp_pass	: cfg.smtp_pass
			},
			status_node	: status,
			button_node	: test_button,
			timeout		: 20*1000
		})
		set_status_result(status, api_response)
		tested_ok = (response_data(api_response)===true)
	})

	continue_button.addEventListener('mouseup', function() {
		if (cfg.mailer===true && tested_ok!==true) {
			status.classList.remove('ok'); status.classList.add('error')
			status.textContent = get_label.test_mailer_first || 'Test the SMTP connection successfully before continuing (or disable outbound email).'
			return
		}
		reveal_section(self.node.content_data.persist_block)
		update_step_indicator(self.node.content_data.step_indicator, 7)
	})

	return fragment
}//end render_mailer_block



/**
* RENDER_PERSIST_BLOCK
* The "Save configuration" step: writes ../private/.env (+ Bun .env) and state.php, shows the
* auto-generated secrets ONCE, then exposes the activation gate (verify the saved config is
* live; if not, guide a php-fpm reload). On green it reveals the directories step.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_persist_block = function(self) {

	const fragment	= new DocumentFragment()
	const cfg		= self._cfg

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		inner_html		: get_label.installation_persist_help || 'Save the configuration to ../private/.env (outside the web root, chmod 600). Strong secrets will be generated and shown once — store them safely.',
		parent			: fragment
	})

	const status		= create_status_msg(fragment)
	// what the saved plan will install (the chosen ontologies + their declared
	// dependencies, deps first) and its non-blocking warnings
	const plan_box		= ui.create_dom_element({ element_type:'div', class_name:'persist_plan', parent:fragment })
	const secrets_box	= ui.create_dom_element({ element_type:'div', class_name:'generated_secrets hide', parent:fragment })
	const verify_status	= create_status_msg(fragment)

	const save_button = ui.create_dom_element({ element_type:'button', class_name:'primary persist_button', inner_html:get_label.save_configuration || 'Save configuration', parent:fragment })
	const verify_button = ui.create_dom_element({ element_type:'button', class_name:'primary verify_button hide', inner_html:get_label.verify_active || 'Verify active configuration', parent:fragment })

	save_button.addEventListener('mouseup', async function() {
		const api_response = await api_call_with_spinner({
			action		: 'persist_config',
			// update_servers: true = official master, false = air-gapped (absent → official).
			// ontologies (in cfg): the ticked domain ontologies of the Ontologies step;
			// a non-vendored one makes the server read the update server's manifest
			// before writing (its declared dependencies decide ACTIVE_ONTOLOGY_TLDS),
			// hence the longer timeout.
			body_options: { ...cfg, diffusion: cfg.diffusion===true, mailer: cfg.mailer===true, update_servers: cfg.update_servers!==false },
			status_node	: status,
			button_node	: save_button,
			timeout		: 60*1000
		})
		set_status_result(status, api_response)
		plan_box.replaceChildren()
		if (response_data(api_response)!==true) {
			return
		}
		render_ontology_plan(plan_box, api_response)
		// the thesauri the saved plan's ontologies declare: the "Install hierarchies"
		// step pre-ticks them all (a mandatory one marked strongly recommended)
		const hierarchy_dependencies = response_extension(api_response, 'hierarchy_dependencies')
		self._hierarchy_dependencies = Array.isArray(hierarchy_dependencies) ? hierarchy_dependencies : []
		// show generated secrets ONCE
		const generated = api_response.generated || {}
		const keys = Object.keys(generated)
		if (keys.length>0) {
			secrets_box.classList.remove('hide')
			ui.create_dom_element({ element_type:'div', class_name:'generated_secrets_title', inner_html:(get_label.generated_secrets_warning || '⚠ Save these secrets now — they are shown only once and must never be changed later:'), parent:secrets_box })
			for (const k of keys) {
				const row = ui.create_dom_element({ element_type:'div', class_name:'generated_secret_row', parent:secrets_box })
				ui.create_dom_element({ element_type:'span', class_name:'generated_secret_key', text_content:k, parent:row })
				const val = ui.create_dom_element({ element_type:'input', class_name:'generated_secret_val', value:generated[k], parent:row })
				val.readOnly = true
			}
		}
		save_button.remove()
		verify_button.classList.remove('hide')
	})

	verify_button.addEventListener('mouseup', async function() {
		const api_response = await api_call_with_spinner({
			action		: 'verify_active_config',
			body_options: { db_database: cfg.db_database, db_username: cfg.db_username, entity: cfg.entity },
			status_node	: verify_status,
			button_node	: verify_button
		})
		set_status_result(verify_status, api_response)
		if (response_data(api_response)===true) {
			verify_button.remove()
			reveal_section(self.node.content_data.directories_block)
			update_step_indicator(self.node.content_data.step_indicator, 8)
		}
		// if not active: status shows the reload guidance; the button stays for a re-check
	})

	return fragment
}//end render_persist_block



/**
* RENDER_DIRECTORIES_BLOCK
* Verifies (and can create) the main writable directories. Because the media path derives from
* the entity, this runs AFTER the config is active. All-green reveals the database install step.
* @param {Object} self
* @returns {DocumentFragment}
*/
const render_directories_block = function(self) {

	const fragment	= new DocumentFragment()

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'description',
		inner_html		: get_label.installation_directories_help || 'Dédalo needs write permission on its working directories (private, sessions, cache, media, backup). Check them and create any that are missing.',
		parent			: fragment
	})

	const list		= ui.create_dom_element({ element_type:'div', class_name:'directories_list', parent:fragment })
	const status	= create_status_msg(fragment)
	const check_button	= ui.create_dom_element({ element_type:'button', class_name:'primary dirs_check_button', inner_html:get_label.check_directories || 'Check directories', parent:fragment })
	const create_button	= ui.create_dom_element({ element_type:'button', class_name:'primary dirs_create_button hide', inner_html:get_label.create_directories || 'Create missing directories', parent:fragment })

	const render_dirs = function(dirs) {
		list.textContent = ''
		for (const d of (dirs||[])) {
			const ok = d.exists && d.writable
			const row = ui.create_dom_element({ element_type:'div', class_name:'directory_row ' + (ok?'ok':'error'), parent:list })
			ui.create_dom_element({ element_type:'span', class_name:'directory_icon', inner_html: ok ? '&#10003;' : '&#10007;', parent:row })
			ui.create_dom_element({ element_type:'span', class_name:'directory_label', text_content:d.label, parent:row })
			ui.create_dom_element({ element_type:'span', class_name:'directory_path', text_content:d.path, parent:row })
		}
	}

	const run_check = async function(create, button) {
		const api_response = await api_call_with_spinner({
			action		: 'check_directories',
			body_options: { create: create===true },
			status_node	: status,
			button_node	: button
		})
		render_dirs(api_response.dirs)
		set_status_result(status, api_response)
		if (response_data(api_response)===true) {
			create_button.classList.add('hide')
			reveal_section(self.node.content_data.installer_db_block)
			update_step_indicator(self.node.content_data.step_indicator, 9)
		} else {
			create_button.classList.remove('hide')
		}
	}

	check_button.addEventListener('mouseup', function(){ run_check(false, check_button) })
	create_button.addEventListener('mouseup', function(){ run_check(true, create_button) })

	return fragment
}//end render_directories_block



/**
* RENDER_ONTOLOGY_PLAN
* After a successful persist_config: the domain ontologies the saved plan will
* stage and import (`ontology_install` — the chosen ones and their declared
* dependencies, deps first) and the plan's non-blocking warnings (e.g. an
* ontology whose dependencies the server does not declare). Server text →
* text_content only.
* @param HTMLElement parent
* @param object api_response (persist_config)
*/
const render_ontology_plan = function(parent, api_response) {

	const install = response_extension(api_response, 'ontology_install')
	if (Array.isArray(install) && install.length>0) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description info',
			text_content	: (get_label.installation_ontologies || 'Ontologies') + ': ' + install.join(', '),
			parent			: parent
		})
	}
	render_warning_lines(parent, response_extension(api_response, 'warnings'))
}//end render_ontology_plan



/**
* INSTALLER_DB_STEPS
* The install-DB block's ordered steps (WC-2026-10-09-install-domain-ontologies):
* fetch + verify the ontology files BEFORE the database is touched, restore the
* seed, import the staged ontologies. Labels resolved at click time.
* @return array [{ action, timeout, label }]
*/
const installer_db_steps = function() {

	return [
		{
			action	: 'stage_ontologies',
			timeout	: 600*1000,
			label	: get_label.installation_ontologies_staging || 'Fetching and verifying the ontology files…'
		},
		{
			action	: 'install_db_from_default_file',
			timeout	: 120*1000,
			label	: get_label.installation_db_restoring || 'Installing the database from the seed file…'
		},
		{
			action	: 'install_ontologies',
			timeout	: 600*1000,
			label	: get_label.installation_ontologies_installing || 'Installing the domain ontologies…'
		}
	]
}//end installer_db_steps



/**
* RUN_INSTALL_DB_SEQUENCE
* Runs the steps in order, one status line each, and stops at the FIRST failure
* (that line shows the refusal through set_status_result). Step warnings
* (`warnings` extension key: undeclared dependencies, unresolved references) are
* shown under the lines and never block.
* @param array steps (installer_db_steps)
* @param HTMLElement container the status lines' parent
* @param HTMLElement button
* @return object { ok }
*/
const run_install_db_sequence = async function(steps, container, button) {

	for (const step of steps) {
		const status_node = create_status_msg(container)
		const api_response = await api_call_with_spinner({
			action			: step.action,
			status_node		: status_node,
			button_node		: button,
			timeout			: step.timeout,
			spinner_label	: step.label
		})
		set_status_result(status_node, api_response)
		if (request_failed(api_response) || response_data(api_response)!==true) {
			console.error(step.action + ' failed:', api_response.error || api_response)
			return { ok : false }
		}
		render_warning_lines(container, response_extension(api_response, 'warnings'))
	}

	return { ok : true }
}//end run_install_db_sequence



/**
* RENDER_INSTALLER_DB_BLOCK
* Creates the database installation section.
*
* Verifies that the bundled SQL source file exists at the expected server path
* (via `properties.target_file_path_exists`); if not, renders an error and returns early.
* Otherwise displays the target file path, the active db_config key/value pairs (db name,
* host, port, user – no password), and an "INSTALL DATABASE FROM FILE" button.
*
* On button click the function calls the 'install_db_from_default_file' API action.
* On success it reveals set_root_password_block; on failure it shows the error message
* from the API response via textContent (SEC-032: never innerHTML for API output).
*
* @param {Object} self - The install instance (provides self.context.properties and self.node)
* @returns {DocumentFragment} Fragment with file path info, db config grid, action button, and status div
*/
const render_installer_db_block = function(self) {

	// short vars
		const properties = self.context.properties

	const fragment = new DocumentFragment()

	// check if the file exists in the correct path
	// The SQL dump must be present before the install action is offered; without it
	// the server-side handler would fail immediately with an unhelpful I/O error.
		if (!properties.target_file_path_exists) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'msg error',
				inner_html		: get_label.installation_db_error_file_path || 'Database file not found! Please verify that the installation file exists in: '+ properties.target_file_path,
				parent			: fragment
			})

			return fragment
		}

	// target_file_path
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description',
			inner_html		: get_label.installation_db || 'Install DDBB source file: '+ properties.target_file_path,
			parent			: fragment
		})

	// db_config properties
	// Render a two-column grid of key/value config pairs so the operator can confirm
	// the target database before triggering the potentially destructive SQL import.
		const db_config_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'db_config_container',
			parent			: fragment
		})
		// (Re)populate the confirmation grid. Every wizard block is built once up-front,
		// BEFORE the operator fills the DB step, so reading self._cfg at build time would
		// only ever show the catalog placeholders. This closure re-reads the values the
		// operator actually entered and is run again whenever the step is revealed
		// (wired via the section's _on_reveal hook in get_content_data).
		const refresh_db_config = function() {
			db_config_container.replaceChildren()
			const db_config_display = (self._cfg && self._cfg.db_database)
				? {
					db_name		: self._cfg.db_database,
					user_name	: self._cfg.db_username,
					hostname	: self._cfg.db_hostname,
					port		: self._cfg.db_port,
					socket		: self._cfg.db_socket,
					ontologies	: Array.isArray(self._cfg.ontologies) ? self._cfg.ontologies.join(', ') : ''
				}
				: (properties.db_config || {})
			for(const config_item in db_config_display){
				ui.create_dom_element({
					element_type 	: 'div',
					class_name		: 'db_config key',
					text_content	: config_item,
					parent			: db_config_container
				})
				ui.create_dom_element({
					element_type 	: 'div',
					class_name		: 'db_config value',
					text_content	: db_config_display[config_item] ?? '',
					parent			: db_config_container
				})
			}
		}
		refresh_db_config()
		// expose so the step can refresh itself when revealed (see get_content_data wiring)
		self._refresh_installer_db_config = refresh_db_config

	// installer_db_status: one status line per step (run_install_db_sequence)
		const installer_db_status = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'installer_db_steps',
			parent			: fragment
		})

	// installer_db_button
		const installer_db_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary installer_db_button',
			inner_html		: get_label.installation_from_file || 'INSTALL DATABASE FROM FILE',
			parent			: fragment
		})
		// THREE steps, one button (WC-2026-10-09-install-domain-ontologies): the
		// ontology files are fetched and verified BEFORE the database is touched
		// (stage_ontologies), then the seed is restored, then the staged ontologies
		// are imported. One status line per step; the first failure stops the run.
		let running = false
		installer_db_button.addEventListener('mouseup', async function() {

			if (running) return
			running = true

			// a re-run starts from a clean status list
				installer_db_status.replaceChildren()

			const result = await run_install_db_sequence(installer_db_steps(), installer_db_status, installer_db_button)
			running = false

			// manage result
				if (result.ok===true) {
					// show set_root_password_block
					reveal_section(self.node.content_data.set_root_password_block)
					// step indicator: "Set root password" is step 10 in the needs_config (14-step) flow
					// and step 4 in the legacy (8-step) flow. Branch like the password/login blocks do.
					update_step_indicator(self.node.content_data.step_indicator, self._needs_config ? 10 : 4)
					installer_db_button.remove();
				}
		})//end mouse_up event


	return fragment
}//end render_installer_db_block



/**
* RENDER_SET_ROOT_PASSWORD_BLOCK
* Creates the root-password setup form for the Dédalo superuser account.
*
* Renders two password fields (new password + retype) backed by
* component_password.prototype.validate_password_format for real-time strength checking.
* Paste is disabled on the retype field to force manual retyping.
* A show/hide checkbox toggles both fields between 'password' and 'text' type.
*
* The policy is the engine's ONE password policy (component_password/js/
* password_policy.js): its rules are listed under the description, and the
* server (root_pw.ts) refuses what breaks them — no installer-local options.
*
* On successful save (API result===true), set_root_password_block.change_root_pw_button is
* removed and login_block is revealed. API response messages are always set via textContent
* (SEC-032).
*
* @param {Object} self - The install instance (provides self.node for sibling-block revelation)
* @returns {DocumentFragment} Fragment with description, two password inputs, show-checkbox, status div, and save button
*/
const render_set_root_password_block = function(self) {

	const fragment = new DocumentFragment()

	// description + the policy's rules (password_policy.js — the ONE policy the
	// server enforces on this step too: root_pw.ts refuses what breaks it)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description',
			inner_html		: get_label.root_password_intro || 'Type and retype your desired superuser password and keep it in a safe place.',
			parent			: fragment
		})
		const rules_list = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'description password_rules',
			parent			: fragment
		})
		for (const rule of check_password('').rules) {
			ui.create_dom_element({
				element_type	: 'li',
				text_content	: format_label(get_label[rule.label] || rule.label, rule.params),
				parent			: rules_list
			})
		}

	// input_new_pw field
	// Both 'keyup' and 'change' fire set_message so that inline validation runs both
	// while typing and on programmatic value changes (e.g. autofill).
		const input_new_pw = ui.create_dom_element({
			element_type	: 'input',
			type			: 'password',
			class_name		: 'password_value',
			value			: '', // default value
			placeholder		: get_label.password || 'Password',
			parent			: fragment
		})
		input_new_pw.autocomplete = 'new-password'
		input_new_pw.addEventListener('keyup', function(e) {
			e.preventDefault()
			const validated_obj = component_password.prototype.validate_password_format(input_new_pw.value)
			set_message(validated_obj, input_new_pw)
		})
		input_new_pw.addEventListener('change', function(e) {
			e.preventDefault()

			// validated. Test password is acceptable string
				const validated_obj = component_password.prototype.validate_password_format(input_new_pw.value)

			// message
				set_message(validated_obj, input_new_pw)
		})

		/**
		* SET_MESSAGE
		* Updates the set_pw_status element and input decoration based on a validation result.
		*
		* Applies 'valid'/'invalid' CSS class to the input node and 'ok'/'error' to the status
		* div, and adds/removes the 'loading' class on the save button to prevent submission
		* when the password does not meet the configured policy.
		*
		* (!) set_pw_status and change_root_pw_button are referenced from the enclosing
		* render_set_root_password_block scope; they are defined later in that function and
		* accessed via closure. This is safe because set_message is only ever called from
		* user-event handlers that fire after the full fragment has been composed.
		*
		* @param {Object} validated_obj - Return value of component_password.validate_password_format
		* @param {boolean} validated_obj.valid   - true if password meets all policy requirements
		* @param {string}  validated_obj.message - human-readable failure reason (empty on success)
		* @param {HTMLElement} input_node - The password input to decorate
		* @returns {boolean} Always true
		*/
		function set_message(validated_obj, input_node) {

			// message reset
				set_pw_status.classList.remove('ok')
				set_pw_status.classList.remove('error')
				set_pw_status.textContent = ''

			if (validated_obj.valid===false) {
				input_node.classList.remove('valid')
				input_node.classList.add('invalid')
				set_pw_status.classList.add('error')
				set_pw_status.textContent = validated_obj.message
				change_root_pw_button.classList.add('loading')
			}else{
				input_node.classList.remove('invalid')
				input_node.classList.add('valid')
				change_root_pw_button.classList.remove('loading')
			}

			return true
		}//end set_message

	// input_new_pw 2 field
	// The retype field validates that both entries are identical AND that the primary
	// field still passes the policy; catching copy-paste errors that could lock the operator out.
		const input_new_pw_retype = ui.create_dom_element({
			element_type	: 'input',
			type			: 'password',
			class_name		: 'password_value',
			value			: '', // default value
			placeholder		: get_label.new_pw_retype || 'Retype Password',
			parent			: fragment
		})
		input_new_pw_retype.autocomplete = 'new-password'
		// prevent paste values here
		// Paste is blocked on the retype field so the operator is forced to type the
		// password twice, reducing the risk of committing an accidentally wrong value.
		input_new_pw_retype.addEventListener('paste', function(e) {
			e.preventDefault();
			return false;
		})

		input_new_pw_retype.addEventListener('keyup', function(e) {
			e.preventDefault()
			const validated_obj = component_password.prototype.validate_password_format(input_new_pw.value)
			set_message(
				{
					valid	: input_new_pw_retype.value===input_new_pw.value && validated_obj.valid===true,
					message	: input_new_pw_retype.value!==input_new_pw.value ? 'Error. Password do not match!' : ''
				},
				input_new_pw_retype
			)
		})

	// checkbox show/hide
	// Toggles both password inputs between 'password' and 'text' type simultaneously
	// so the operator can visually inspect what they have typed in both fields.
		const label_checkbox_show = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'password_show_label',
			inner_html		: get_label.show_pw || 'Show',
			parent			: fragment
		})
		const input_new_pw_show = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'password_show'
		})
		label_checkbox_show.prepend(input_new_pw_show)
		input_new_pw_show.addEventListener('click', function() {
			if(input_new_pw.type === 'password') {
				input_new_pw.type			= 'text'
				input_new_pw_retype.type	= 'text'
			}else{
				input_new_pw.type			= 'password'
				input_new_pw_retype.type	= 'password'
			}
		})

	// set_pw_status msg
		const set_pw_status = create_status_msg(fragment)

	// change_root_pw_button
	// Performs a final re-validation of both fields before submitting, guarding against
	// edge cases where the button might be clicked before the keyup handler had a chance
	// to lock it (e.g. rapid keyboard→mouse transitions).
		const change_root_pw_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary change_root_pw_button',
			inner_html		: get_label.save_root_pw || ' Save the root password ',
			parent			: fragment
		})
		change_root_pw_button.addEventListener('mouseup', async function() {

			// validate again first password input
				const validated_obj = component_password.prototype.validate_password_format(input_new_pw.value)
				if (validated_obj.valid!==true) {
					set_message(validated_obj, input_new_pw)
					return false
				}

			// check again mismatch retype
				if(input_new_pw_retype.value!==input_new_pw.value) {
					set_message(
						{ valid: false, message: 'Error. Password do not match!' },
						input_new_pw_retype
					)
					return false
				}

			// API call with spinner
				const api_response = await api_call_with_spinner({
					action			: 'set_root_pw',
					body_options	: { password: input_new_pw.value },
					status_node		: set_pw_status,
					button_node		: change_root_pw_button
				})

			// manage result
				if (response_data(api_response)===true) {
					console.log('api_response:', server_text(api_response))
					set_status_result(set_pw_status, api_response)
					change_root_pw_button.remove();
					// show next block: login (root logs in inside the installer)
					reveal_section(self.node.content_data.login_block)
					update_step_indicator(self.node.content_data.step_indicator, self._needs_config ? 11 : 5)
				}else{
					console.error('set_root_pw failed:', api_response.error || api_response);
					set_status_result(set_pw_status, api_response)
				}
		})


	return fragment
}//end render_set_root_password_block



/**
* RENDER_LOGIN_BLOCK
* Creates the login section that appears after the root password is saved.
*
* Renders a "To login" button that, on click, lazily instantiates and renders a full
* login component (fetched via get_instance) and appends it inside login_container.
* A custom_action_dispatch hook is injected into the login instance before it builds so
* that a successful authentication immediately reveals hierarchies_import_block and
* removes the login button to prevent re-use.
*
* The login component context is loaded via login.build(true) (autoload=true), which
* calls the 'get_install_context' API action — no prior session is required.
*
* @param {Object} self - The install instance (provides self.node for sibling-block revelation)
* @returns {Promise<DocumentFragment>} Fragment with login_container, "To login" button, and logged-status div
*/
const render_login_block = async function(self) {

	const fragment = new DocumentFragment()

	// login_container
	// Starts hidden; revealed after the operator clicks "To login" and the login widget is built.
		const login_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'login_container hide',
			parent			: fragment
		})

	// to_login_button
		const to_login_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary to_login_button',
			inner_html		: get_label.to_login || 'To login',
			parent			: fragment
		})
		to_login_button.addEventListener('mouseup', async function() {

			// login instance, build and render
				const login = await get_instance({
					model	: 'login',
					mode	: 'edit'
				})

			// rendered login panel node, assigned after render() below; declared here so the
			// dispatch closure can remove the floating panel on a successful login.
				let login_node = null

			// custom_action_dispatch. Set before render to catch the on-login action
			// This function is called by the login component's submit handler in place of
			// the default session-redirect logic, so we can intercept the result inside
			// the install wizard without navigating away from the page.
				const custom_action_dispatch = function(api_response){

					if (response_data(api_response)===true) {

						// all is OK case
							login_status.classList.add('ok')
							login_status.classList.remove('hide')
							login_container.classList.add('hide')
							to_login_button.remove()

						// remove the floating login panel — it is appended to self.node (not to
						// login_container), so hiding the container leaves it stuck on screen.
							if (login_node) {
								login_node.remove()
							}

						// login done → reveal the MANDATORY hierarchies import (now authenticated)
							reveal_section(self.node.content_data.hierarchies_import_block)
							update_step_indicator(self.node.content_data.step_indicator, self._needs_config ? 12 : 6)

					}else{

						// fail case
							login_status.classList.add('error')
							login_status.textContent = server_text(api_response, 'API response login fails')
							console.warn('api_response:', api_response);
					}

					return response_data(api_response)
				}
				login.custom_action_dispatch = custom_action_dispatch

			// build with autoload to get login context from API
				await login.build(true)

			// render and assign node (login_node is declared above so the dispatch can remove it)
				login_node = await login.render()
				// login_container.appendChild(login_node)
				self.node.appendChild(login_node)

			// show the login_container
				login_container.classList.remove('hide')
		})//end mouse_up event

	// login_status msg
	// Hidden by default; revealed with class 'ok' on successful login, or 'error' on failure.
		const login_status = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'msg logged hide',
			inner_html		: get_label.logged || 'Logged',
			parent			: fragment
		})


	return fragment
}//end render_login_block



/**
* RENDER_HIERARCHIES_IMPORT_BLOCK
* Creates the hierarchy (thesaurus tree) selection and import section.
*
* This function is exported and reused by the hierarchy activation screen outside of
* the install wizard, so it accepts a plain options object rather than a self reference.
*
* Hierarchies are grouped by typology and sorted alphabetically (reversed, because the
* render loops iterate from last to first — the visual order is therefore A→Z top-to-bottom).
* Each hierarchy is rendered as a labelled checkbox. Pre-checked items come from
* options.default_checked (an array of TLD strings — in the install wizard ONLY the
* declared thesaurus dependencies; no country is ever pre-checked). Already-active
* hierarchies show an '[active]' badge but can still be selected for re-import.
*
* Hierarchy objects shape (element of options.hierarchies — the server's client view of
* install/import/hierarchy/hierarchy.json, hierarchy_meta.ts hierarchyChoiceView):
*   {
*     label    : {string},  // human-readable name
*     tld      : {string},  // top-level domain identifier, e.g. 'es', 'ca'
*     typology : {number},  // groups the entry under a typology header
*     has_data : {boolean}, // false = an EMPTY thesaurus by design (installs with no terms)
*     dependencies : {Array}, // the THESAURI it declares ({tld, mandatory}); ticking it pre-ticks them
*     type     : {string}   // 'model' entries are skipped (they are definition templates)
*   }
*
* DECLARED THESAURI ARE A RECOMMENDATION, NEVER A LOCK (owner decision 2026-10-10):
* ticking an entry pre-ticks the thesauri it declares; a row some ticked entry (or an
* installed ontology — options.required_hierarchies) declares MANDATORY is marked
* "strongly recommended by: …" and stays editable; unticking it shows the warning that
* it can be installed later. The server never adds one the operator unticked.
*
* On "Import hierarchies" click the function calls the 'install_hierarchies' API action with
* the collected TLD list. A partial failure (some items result===false) shows the first
* failing item's message; full success calls options.callback if provided.
*
* (!) alert() and confirm() are used here because this screen is part of the pre-auth
* install wizard where no Dédalo dialog component is available yet.
*
* @param {Object} options - Configuration object
* @param {Array}  options.hierarchies              - All available hierarchy descriptors
* @param {Array}  [options.default_checked=[]]     - TLD strings pre-checked by default
* @param {Array}  [options.installed_hierarchies=[]] - lowercase TLDs already imported (marked "installed"; reset-eligible)
* @param {string} [options.hierarchy_files_dir_path=''] - Server path shown for informational purposes
* @param {Function} [options.callback]             - Called with api_response on successful import
* @param {Array}  [options.hierarchy_typologies=[]] - Typology group descriptors ({label, typology})
* @param {boolean} [options.show_filter=false]     - Render a live name/TLD text filter above the list
* @param {Object} [options.reset_request]          - Endpoint ({dd_api, action, source}) for a destructive "Reset to seed" button (maintenance widget only)
* @param {Array}  [options.core_hierarchies=[]]    - Always-installed core hierarchies ({tld, label}); shown as a fixed note, never offered (install wizard)
* @param {boolean} [options.allow_empty=false]     - When true, an empty selection is confirmed and posted as `hierarchies: []` (install wizard); false keeps the "Select one or more items" refusal (maintenance widget)
* @param {Array}  [options.required_hierarchies=[]] - Thesauri the installed ontologies declare MANDATORY ({tld, dependants}); rendered checked, EDITABLE, marked strongly recommended (install wizard — unticking declines with a warning)
* @param {number} [options.toponymy_typology]     - The Toponymy typology id; when given, its group shows the suggestion to import the operator's OWN country (install wizard) — a suggestion, never a pre-checked box
* @returns {DocumentFragment} Fragment with description, optional filter, grouped hierarchy checkboxes, import button, optional reset button, and status div
*/
export const render_hierarchies_import_block = function(options) {

	// options
		const hierarchies				= options.hierarchies || []
		const default_checked			= options.default_checked || []
		// lowercase TLDs whose term data is already imported (marked "installed" + eligible
		// for reset). Empty for the install wizard, which does not pass it.
		const installed_hierarchies		= options.installed_hierarchies || []
		const hierarchy_files_dir_path	= options.hierarchy_files_dir_path || ''
		const callback					= options.callback
		const hierarchy_typologies		= options.hierarchy_typologies || []
		// Alternate import endpoint ({dd_api, action, source}); when set the import routes
		// through it instead of the sealed-off install surface (dd_utils_api:install).
		const import_request			= options.import_request || null
		// When true, render a live text filter above the list (name / TLD). Opt-in so
		// the install wizard keeps its plain list; the maintenance widget enables it.
		const show_filter				= options.show_filter===true
		// Endpoint for the DESTRUCTIVE "Reset to seed" action ({dd_api, action, source}).
		// When set (maintenance widget) a danger button re-seeds already-installed ticked
		// hierarchies; absent (install wizard) → no reset button at all.
		const reset_request				= options.reset_request || null
		// Core hierarchies ({tld, label}) the seed restore always activates (lg). Shown as a
		// fixed note so the operator knows Languages is installed whatever is ticked below.
		const core_hierarchies			= Array.isArray(options.core_hierarchies) ? options.core_hierarchies : []
		// Install wizard only: an empty optional selection is a valid answer (confirmed,
		// then posted as `hierarchies: []`). Default false keeps the maintenance refusal.
		const allow_empty				= options.allow_empty===true
		// Install wizard only: the MANDATORY declared thesauri (hierarchy60) — checked,
		// EDITABLE, marked strongly recommended with the ontologies that declare them.
		// Unticking declines (a warning here and in the server's answer), never refused.
		const required_hierarchies		= Array.isArray(options.required_hierarchies) ? options.required_hierarchies : []
		const required_by				= new Map(required_hierarchies.map(el => [el.tld, el.dependants || []]))
		// Install wizard only: the Toponymy typology id. Its group carries a visible
		// suggestion to import the operator's own country — never a pre-checked box.
		const toponymy_typology			= options.toponymy_typology ?? null

	// DocumentFragment
		const fragment = new DocumentFragment();

		// Sort both arrays in descending alphabetical order. The rendering loops iterate
		// from last-to-first (i-- / j--), so the final on-screen order is ascending A→Z.
		hierarchies.sort((a,b) => (a.label < b.label) ? 1 : ((b.label < a.label) ? -1 : 0))
		hierarchy_typologies.sort((a,b) => (a.label < b.label) ? 1 : ((b.label < a.label) ? -1 : 0))

	// info
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description info',
			inner_html		: get_label.import_hierarchies_description || 'It will be displayed in the thesaurus. Keep in mind that large countries can consume a lot of resources. Don\'t load unnecessary countries. You can always load more countries later',
			parent			: fragment
		})

	// source_files
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description source_files',
			inner_html		: get_label.import_hierarchies_directory_description || 'Source files directory: ' + hierarchy_files_dir_path,
			parent			: fragment
		})

	// core hierarchies note (always installed, not selectable). Server-supplied labels →
	// text_content only.
		if (core_hierarchies.length>0) {
			const core_list = core_hierarchies
				.map(el => (el.label || el.tld) + ' [' + el.tld + ']')
				.join(', ')
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'description info core_hierarchies',
				text_content	: (get_label.core_hierarchies_always || 'Always installed:') + ' ' + core_list,
				parent			: fragment
			})
		}

	// filter bar (opt-in). A live text box that shows/hides list rows by name or TLD;
	// wired below once the list (and its total) exists. Placed above the container so it
	// reads as the list's control.
		let filter_input	= null
		let filter_count	= null
		if (show_filter) {
			const filter_bar = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'hierarchy_filter',
				parent			: fragment
			})
			filter_input = ui.create_dom_element({
				element_type	: 'input',
				class_name		: 'hierarchy_filter_input',
				parent			: filter_bar
			})
			filter_input.type			= 'search'
			filter_input.placeholder	= get_label.filter || 'Filter by name or TLD…'
			filter_input.setAttribute('aria-label', get_label.filter || 'Filter by name or TLD')
			filter_count = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'hierarchy_filter_count dd_badge mono',
				parent			: filter_bar
			})
		}

	// hierarchies
		const hierarchy_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'hierarchy_container',
			parent			: fragment
		})

		// tld → {hierarchy, checkbox, recommend_node, warning_node}: the declared-thesaurus
		// wiring (pre-tick on tick, "strongly recommended" marks) runs over it after the loop.
		const row_by_tld = new Map()

		// Accumulates the TLD strings for all checked checkboxes.
		// Pre-populated with default_checked items during the initial loop, then kept
		// in sync by checkbox change handlers (push on check, splice on uncheck).
		const selected_hierarchies = []
		// Count of importable rows actually rendered — the filter's "of N" denominator.
		let total_hierarchies = 0
		const hierarchy_typologies_length = hierarchy_typologies.length
		for (let i = hierarchy_typologies_length - 1; i >= 0; i--) {

			const current_hierarchy_typology = hierarchy_typologies[i]

			// Skip typology groups that have no matching hierarchies in the available list.
			const found_hierarchies = hierarchies.filter(el => el.typology === current_hierarchy_typology.typology)

			if(found_hierarchies.length < 1){
				continue
			}

			// typology_label
			ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'typology_label',
				text_content	: current_hierarchy_typology.label,
				parent			: hierarchy_container
			})

			// toponymy suggestion (install wizard): import YOUR country — advice only
			if (toponymy_typology!==null && current_hierarchy_typology.typology===toponymy_typology) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'description info toponymy_suggestion',
					text_content	: get_label.install_toponymy_suggestion || 'Tip: import the toponymy of your own country (e.g. Nepal for an installation in Nepal). No country is selected by default.',
					parent			: hierarchy_container
				})
			}

			// list of hierarchies
			const hierarchy_ul = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'hierarchy_ul',
				parent			: hierarchy_container
			})

			const hierarchies_len = found_hierarchies.length
			for (let j = hierarchies_len - 1; j >= 0; j--) {

				// hierarchy object
					const current_hierarchy = found_hierarchies[j]
					// Skip model-type entries — they are definition templates, not importable data files.
					if(current_hierarchy.type==='model'){
						continue
					}

				// is_default check (a recommended thesaurus is pre-checked, never locked)
					const is_required			= required_by.has(current_hierarchy.tld)
					const is_default_checked	= default_checked.find(el => el===current_hierarchy.tld)
					const checked				= (is_default_checked || is_required) ? true : false

				// li element
					const hierarchy_li = ui.create_dom_element({
						element_type	: 'li',
						parent			: hierarchy_ul
					})
					// searchable key for the filter (name + tld), lowercased once here so
					// the input handler stays a cheap substring test.
					hierarchy_li.dataset.search = (current_hierarchy.label + ' ' + current_hierarchy.tld).toLowerCase()
					total_hierarchies++

				// label
				// The label text includes the TLD in brackets for disambiguation when
				// multiple hierarchies share similar display names.
					const hierarchy_label = ui.create_dom_element({
						element_type	: 'label',
						class_name		: 'hierarchy_label',
						text_content	: current_hierarchy.label + ' [' + current_hierarchy.tld + ']',
						parent			: hierarchy_li
					})
					// an EMPTY thesaurus by design (no data files): it installs with no terms
					if (current_hierarchy.has_data===false) {
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'empty_hierarchy dd_badge',
							text_content	: ' ' + (get_label.empty || 'Empty'),
							parent			: hierarchy_label
						})
					}
					if (installed_hierarchies.includes( current_hierarchy.tld.toLowerCase() )) {
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'installed_hierarchy',
							inner_html		: get_label.installed || 'installed',
							parent			: hierarchy_label
						})
					}

				// checkbox
					const hierarchy_checkbox = ui.create_dom_element({
						element_type	: 'input',
						type			: 'checkbox',
						class_name		: 'hierarchy_checkbox'
					})
					hierarchy_label.prepend(hierarchy_checkbox)
					hierarchy_checkbox.checked = checked ? 'checked' : ''
					// "strongly recommended by: …" + the declined warning — filled by
					// refresh_recommendations (never a lock: a thesaurus never blocks)
					const recommend_node = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'required_hierarchy recommended_hierarchy',
						parent			: hierarchy_label
					})
					const warning_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'installer_field_help warning recommended_declined',
						text_content	: get_label.installation_dependency_recommended_warning || 'Not installed now. This thesaurus is strongly recommended: you can install it later from Maintenance › Install hierarchies.',
						parent			: hierarchy_li
					})
					// `hidden`, not a class: the block also renders in the maintenance widget
					warning_node.hidden = true
					row_by_tld.set(current_hierarchy.tld, {
						hierarchy		: current_hierarchy,
						checkbox		: hierarchy_checkbox,
						recommend_node	: recommend_node,
						warning_node	: warning_node
					})
					hierarchy_checkbox.addEventListener('change', function() {
						if(hierarchy_checkbox.checked){
							selected_hierarchies.push(current_hierarchy.tld)
							// pre-tick the thesauri this one declares (still editable)
							tick_declared(current_hierarchy)
						}else{
							const index = selected_hierarchies.indexOf(current_hierarchy.tld)
							if (index !== -1) selected_hierarchies.splice(index, 1);
						}
						refresh_recommendations()
					})

				// add checked to selected_hierarchies
				// Seed the array on initial render so that default-checked items are
				// included without requiring the user to interact with the checkbox.
					if(checked){
						selected_hierarchies.push(current_hierarchy.tld)
					}
			}
		}

	// declared thesauri wiring (hierarchy60 `main: hierarchy1`, owner decision 2026-10-10)
		// The thesauri an entry declares, as the server's view lists them ({tld, mandatory}).
		function declared_of(hierarchy) {
			return Array.isArray(hierarchy.dependencies) ? hierarchy.dependencies : []
		}
		// Ticking an entry PRE-TICKS what it declares (mandatory and optional alike —
		// transitively, through each row's own change handler). Never a lock.
		function tick_declared(hierarchy) {
			for (const dependency of declared_of(hierarchy)) {
				const row = row_by_tld.get(dependency.tld)
				if (row && !row.checkbox.checked) {
					row.checkbox.checked = true
					row.checkbox.dispatchEvent(new Event('change'))
				}
			}
		}
		// Who declares `tld` MANDATORY right now: the installed ontologies
		// (required_hierarchies) and every TICKED entry.
		function recommenders_of(tld) {
			const by = [...(required_by.get(tld) || [])]
			for (const [other_tld, row] of row_by_tld) {
				if (!row.checkbox.checked) continue
				const declares = declared_of(row.hierarchy).some(el => el.tld===tld && el.mandatory===true)
				if (declares && !by.includes(other_tld)) by.push(other_tld)
			}
			return by
		}
		// The "strongly recommended by: …" mark of every row, and its declined warning
		// (shown while a recommended row is unticked). Server strings → text_content.
		function refresh_recommendations() {
			for (const [tld, row] of row_by_tld) {
				const by = recommenders_of(tld)
				row.recommend_node.textContent = by.length>0
					? ' — ' + (get_label.installation_hierarchy_recommended_by || 'strongly recommended by:') + ' ' + by.join(', ')
					: ''
				row.warning_node.hidden = by.length===0 || row.checkbox.checked
			}
		}
		// initial state: what the pre-ticked rows declare is pre-ticked too
		for (const row of [...row_by_tld.values()]) {
			if (row.checkbox.checked) tick_declared(row.hierarchy)
		}
		refresh_recommendations()

	// filter wiring (opt-in). Substring-matches each row's data-search (name + tld);
	// hides non-matching rows and any typology group left empty, updates the "X of N"
	// count, and toggles a "no matches" note. No filter → all rows visible.
		if (show_filter && filter_input) {
			const no_matches = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'hierarchy_no_matches dd_note',
				inner_html		: get_label.no_results || 'No hierarchies match the filter.',
				parent			: hierarchy_container
			})
			no_matches.hidden = true

			const apply_filter = function(raw) {
				const query = (raw || '').trim().toLowerCase()
				let visible = 0
				const groups = hierarchy_container.querySelectorAll('.hierarchy_ul')
				groups.forEach(group => {
					let group_visible = 0
					group.querySelectorAll('li').forEach(li => {
						const match = query==='' || (li.dataset.search || '').indexOf(query) !== -1
						li.hidden = !match
						if (match) { visible++; group_visible++ }
					})
					// hide an emptied group together with its typology heading (prev sibling)
					group.hidden = group_visible===0
					const heading = group.previousElementSibling
					if (heading && heading.classList.contains('typology_label')) {
						heading.hidden = group_visible===0
					}
				})
				filter_count.textContent = query==='' ? String(total_hierarchies) : (visible + ' / ' + total_hierarchies)
				no_matches.hidden = visible!==0
			}

			filter_input.addEventListener('input', () => apply_filter(filter_input.value))
			apply_filter('') // seed the count
		}

	// import_hierarchies_status msg
		const import_hierarchies_status = create_status_msg(fragment)

	// import button
		const import_hierarchies_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary import_hierarchies_button',
			inner_html		: get_label.import_hierarchies_button || ' Import hierarchies ',
			parent			: hierarchy_container
		})
		import_hierarchies_button.addEventListener('mouseup', fn_import_hierarchies)
		/**
		* FN_IMPORT_HIERARCHIES
		* Event handler for the "Import hierarchies" button.
		*
		* Guards against empty selection (alert; with allow_empty a confirm instead, then
		* `hierarchies: []` is posted) and prompts for confirmation (confirm) before dispatching the 'install_hierarchies' API action with the collected TLD list.
		* On a partial failure the first failing item's message is shown. On full success the
		* import button is removed, and options.callback is called if provided.
		*
		* (!) Uses alert() and confirm() — acceptable here because no modal component is
		* available at install time. Flag: consider replacing with inline UI feedback once
		* the UI layer is fully initialized.
		*
		* @returns {Promise<void>}
		*/
		async function fn_import_hierarchies(){

			// empty selection: refused (maintenance) or confirmed as a valid answer (install wizard,
			// allow_empty) — the server answers `hierarchies: []` with ok:true.
				const is_empty = selected_hierarchies.length<1
				if (is_empty && !allow_empty) {
					alert( get_label.select_a_file || 'Select one or more items' );
					return
				}

			// confirm action
				const confirm_text = is_empty
					? (get_label.no_optional_hierarchies_confirm || 'No optional thesaurus will be installed (you can add them later from Maintenance › Add hierarchy). Continue?')
					: selected_hierarchies.length + ' ' + get_label.hierarchies +'. '+ get_label.sure
				if (!confirm( confirm_text )) {
					return false
				}

			// lock container
				import_hierarchies_button.classList.add('loading')
				hierarchy_container.classList.add('loading')

			// API call with spinner
				// import_request set (maintenance widget) → route through the given endpoint
				// (widget_request) with the TLDs in options.hierarchies; otherwise the
				// install-wizard default (dd_utils_api:install / install_hierarchies).
				const call_options = {
					status_node	: import_hierarchies_status,
					button_node	: import_hierarchies_button,
					timeout		: 600 * 1000 // hierarchy imports can take minutes
				}
				if (import_request) {
					call_options.body = {
						dd_api			: import_request.dd_api,
						action			: import_request.action,
						prevent_lock	: true,
						source			: import_request.source,
						options			: { hierarchies: selected_hierarchies }
					}
				} else {
					call_options.action			= 'install_hierarchies'
					call_options.body_options	= { hierarchies: selected_hierarchies }
				}
				const api_response = await api_call_with_spinner(call_options)
				console.log('install_hierarchies response: ', api_response);

			// manage result
				// Backend contract: the step's verdict is the payload; `msg`, `errors[]` and
				// `responses[]` are its extension keys. Success only when the verdict is
				// true AND no per-item errors were recorded.
				const step_errors = response_extension(api_response, 'errors')
				const ar_errors = Array.isArray(step_errors) ? step_errors : []
				if (response_data(api_response)===true && ar_errors.length===0) {
					import_hierarchies_status.classList.add('ok')
					import_hierarchies_status.textContent = server_text(api_response)
					import_hierarchies_button.remove()
					if (typeof callback==='function') {
						callback(api_response)
					}
				}else{
					console.error('install_hierarchies errors:', ar_errors, api_response);
					import_hierarchies_status.classList.add('error')
					import_hierarchies_status.textContent = ar_errors.length>0
						? String(ar_errors[0])
						: server_text(api_response, 'Hierarchy import failed')
				}

			// unlock container
				import_hierarchies_button.classList.remove('loading')
				hierarchy_container.classList.remove('loading')
		}

	// reset button (opt-in, maintenance widget only). DESTRUCTIVE: re-seeds the ticked
	// hierarchies that are ALREADY installed, discarding local edits. Import skips those
	// same rows; reset is the explicit way to force them back to the vendored seed.
		if (reset_request) {
			const reset_hierarchies_button = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'danger reset_hierarchies_button',
				inner_html		: get_label.reset_to_seed || 'Reset to seed',
				parent			: hierarchy_container
			})
			reset_hierarchies_button.addEventListener('mouseup', fn_reset_hierarchies)

			/**
			* FN_RESET_HIERARCHIES
			* Re-seed the ticked hierarchies that are already installed. Only installed tlds
			* are eligible (a non-installed tick is a plain import, not a reset). Requires a
			* strong confirmation because it deletes and re-copies the terms, discarding edits.
			* @returns {Promise<void>}
			*/
			async function fn_reset_hierarchies(){

				// only ticked hierarchies that are ALREADY installed can be reset
					const to_reset = selected_hierarchies.filter(tld => installed_hierarchies.includes(tld.toLowerCase()))
					if (to_reset.length<1) {
						alert( get_label.reset_pick_installed || 'Tick one or more already-installed hierarchies to reset.' )
						return
					}

				// destructive confirmation (lists the tlds and warns about data loss)
					const warn = (get_label.reset_warning || 'This DELETES and re-imports from the seed, discarding any local edits')
						+ ':\n\n' + to_reset.join(', ') + '\n\n' + (get_label.sure || 'Are you sure?')
					if (!confirm(warn)) {
						return false
					}

				// lock container
					reset_hierarchies_button.classList.add('loading')
					hierarchy_container.classList.add('loading')

				// API call with spinner (reset endpoint; TLDs in options.hierarchies)
					const api_response = await api_call_with_spinner({
						status_node	: import_hierarchies_status,
						button_node	: reset_hierarchies_button,
						timeout		: 600 * 1000,
						body		: {
							dd_api			: reset_request.dd_api,
							action			: reset_request.action,
							prevent_lock	: true,
							source			: reset_request.source,
							options			: { hierarchies: to_reset }
						}
					})
					console.log('reset_hierarchies response: ', api_response);

				// manage result (same contract as import)
					const step_errors = response_extension(api_response, 'errors')
				const ar_errors = Array.isArray(step_errors) ? step_errors : []
					if (response_data(api_response)===true && ar_errors.length===0) {
						import_hierarchies_status.classList.add('ok')
						import_hierarchies_status.textContent = server_text(api_response)
						if (typeof callback==='function') {
							callback(api_response)
						}
					}else{
						console.error('reset_hierarchies errors:', ar_errors, api_response);
						import_hierarchies_status.classList.add('error')
						import_hierarchies_status.textContent = ar_errors.length>0
							? String(ar_errors[0])
							: server_text(api_response, 'Hierarchy reset failed')
					}

				// unlock container
					reset_hierarchies_button.classList.remove('loading')
					hierarchy_container.classList.remove('loading')
			}
		}


	return fragment
}//end render_hierarchies_import_block



/**
* RENDER_REGISTER_TOOLS_BLOCK
* Creates the "Register tools" install step.
*
* Tools (import, export, time machine, …) live as directories under the tools path; until
* they are registered into the database registry (section dd1324) they do not appear in the
* application. A fresh install used to ship with an empty registry, so an administrator had
* to discover Maintenance → Register tools on their own. This step runs the very same action
* during install — making it an explicit, visible part of the flow so the tools menu is never
* mistakenly left empty.
*
* On "Register tools" click it calls the 'register_tools' API action (which delegates to
* installer::register_tools() → tools_register::import_tools()) and renders the per-tool
* import report so the operator sees exactly what was registered, with versions and any
* per-tool problems. Tool registration is best-effort: the Finish step is revealed on any
* completed run (a single broken tool must not trap the install), with errors surfaced in
* the report so they can be fixed and the action re-run.
*
* (!) Dynamic values from the report (tool names, versions, messages) are written with
* textContent, never innerHTML (SEC-032: never innerHTML for server/filesystem-derived text).
*
* @param {Object} self - The install instance (provides self.node and self._needs_config)
* @returns {DocumentFragment} Fragment with description, report list, status div and action button
*/
const render_register_tools_block = function(self) {

	const fragment = new DocumentFragment()

	// info
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description',
			inner_html		: get_label.register_tools_help || 'Register the available tools (import, export, time machine, …) so they appear in the application. This scans the tools directory and records each tool in the database. You can always re-run this later from Maintenance → Register tools.',
			parent			: fragment
		})

	// report list (filled after the action runs)
		const report_list = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'tools_report',
			parent			: fragment
		})

	// status msg
		const status = create_status_msg(fragment)

	// register button
		const register_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary register_tools_button',
			inner_html		: get_label.register_tools || 'Register tools',
			parent			: fragment
		})

	/**
	* RENDER_REPORT
	* Paints one row per processed tool: ✓ registered, ⚠ registered with warnings, ✗ failed.
	* @param {Array} report - per-tool import report objects from the API
	*/
	const render_report = function(report) {

		report_list.textContent = ''

		const ar_report = Array.isArray(report) ? report : []
		if (ar_report.length<1) {
			return
		}

		for (let i = 0; i < ar_report.length; i++) {
			const item			= ar_report[i]
			const ar_errors		= Array.isArray(item.errors) ? item.errors : []
			const ar_warnings	= Array.isArray(item.warnings) ? item.warnings : []
			const has_errors	= ar_errors.length>0
			const ok			= item.imported===true && has_errors===false
			const state			= ok ? 'ok' : (has_errors ? 'error' : 'warning')

			const row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'tool_row ' + state,
				parent			: report_list
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'tool_icon',
				inner_html		: ok ? '&#10003;' : (has_errors ? '&#10007;' : '&#9888;'),
				parent			: row
			})
			// name (textContent: filesystem-derived)
			const name_node = ui.create_dom_element({ element_type:'span', class_name:'tool_name', parent:row })
			name_node.textContent = item.name || (item.dir || '')
			// version
			const version_node = ui.create_dom_element({ element_type:'span', class_name:'tool_version', parent:row })
			version_node.textContent = item.version ? ('v' + item.version) : ''
			// per-tool errors / warnings
			const messages = has_errors ? ar_errors : ar_warnings
			if (messages.length>0) {
				const detail = ui.create_dom_element({ element_type:'div', class_name:'tool_detail', parent:row })
				detail.textContent = messages.join(' · ')
			}
		}
	}//end render_report

	register_button.addEventListener('mouseup', async function(){

		// API call with spinner (registration can scan many tool dirs)
			const api_response = await api_call_with_spinner({
				action		: 'register_tools',
				status_node	: status,
				button_node	: register_button,
				timeout		: 120 * 1000
			})
			console.log('register_tools response: ', api_response);

		// report
			render_report(api_response.report)

		// status + advance.
		// Best-effort: reveal Finish on any completed run so a single broken tool can't trap the
		// install. A clean run removes the button; a run with per-tool errors keeps it for a retry.
			const step_errors = response_extension(api_response, 'errors')
				const ar_errors = Array.isArray(step_errors) ? step_errors : []
			if (response_data(api_response)===true && ar_errors.length===0) {
				status.classList.add('ok')
				status.textContent = server_text(api_response)
				register_button.remove()
			}else{
				console.error('register_tools errors:', ar_errors, api_response);
				status.classList.add('warning')
				status.textContent = ar_errors.length>0
					? (server_text(api_response) + ' — ' + ar_errors[0])
					: server_text(api_response, 'Tool registration finished with warnings')
			}

			reveal_section(self.node.content_data.installer_finish_block)
			update_step_indicator(self.node.content_data.step_indicator, self._needs_config ? 14 : 8)
	})


	return fragment
}//end render_register_tools_block



/**
* RENDER_INSTALLER_FINISH_BLOCK
* Creates the final step section shown after hierarchy import completes.
*
* Renders a success description and a "Let's go!" button. On click the button calls the
* 'install_finish' API action which disables install mode server-side (removes/renames the
* install lock file). On success a 5-second countdown updates installer_finish_status via
* textContent and then triggers location.reload() to boot into the normal Dédalo UI.
*
* On failure the spinner is removed but the button stays locked (class 'loading' is not
* removed on error) — this is intentional: if install_finish fails the operator should
* not retry without understanding the server error shown in installer_finish_status.
*
* @param {Object} self - The install instance (provides self.node; unused in this function
*                        body but retained for API consistency with other render functions)
* @returns {DocumentFragment} Fragment with description, finish button, and status div
*/
const render_installer_finish_block = function(self) {

	const fragment = new DocumentFragment();

	// info
		const description_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'description msg ok',
			inner_html		: get_label.install_finished || 'Congrats! The installation process was successfully, Dédalo is ready.',
			parent			: fragment
		})

	// installer_finish_status msg
		const installer_finish_status = create_status_msg(fragment)

	// installer_finish_button
		const installer_finish_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'success installer_finish_button',
			inner_html		: get_label.install_finished || ' Let\'s go! ',
			parent			: fragment
		})
		installer_finish_button.addEventListener('mouseup', async function(){

			// API call with spinner
				const api_response = await api_call_with_spinner({
					action			: 'install_finish',
					status_node		: installer_finish_status,
					button_node		: installer_finish_button
				})

			// manage result
				if (request_failed(api_response) || response_data(api_response)===false) {

					// fail case
					// (!) The 'loading' class is NOT removed on error — intentional guard
					// to prevent a re-click without understanding the failure.

					console.error("install_finish api_response:", api_response);
					installer_finish_status.classList.add('error')
					installer_finish_status.textContent = server_text(api_response, 'Install finish failed')
				}else{
					console.log("install_finish api_response:", api_response);
					installer_finish_status.classList.add('ok')
					installer_finish_status.textContent = server_text(api_response) + ' Setting up!'
					installer_finish_button.remove()
					countdown_and_reload(installer_finish_status, 5)
				}
		})


	return fragment
}//end render_installer_finish_block



// @license-end
