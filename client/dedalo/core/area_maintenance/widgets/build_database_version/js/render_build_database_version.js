// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {update_process_status} from '../../../../common/js/common.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {normalize_stream_error, request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {build_failure} from '../../update_ontology/js/render_update_ontology.js'



/**
* RENDER_BUILD_DATABASE_VERSION
* Client-side render module for the build_database_version area-maintenance widget.
*
* The INSTALL DATABASE panel (the seed a new installation starts from) says, before
* anything runs:
*   - what the seed contains and where each part comes from (`value.parts`);
*   - the seed in this code and whether it matches its sources (`value.checkout_seed`);
*   - the last private build, with its downloads (`value.last_build`);
* and lets the administrator pick the ONTOLOGY SOURCE (`value.sources`) and the OUTPUT
* (`value.targets`). Every pick re-runs the server preflight (`seed_preflight`): each
* check with what was found and, when it fails, the fix; the Build button is enabled
* only when every check passes. The build is a background job followed live (its
* finished steps), and a page reload re-attaches to it. Server:
* core/install/seed_panel.ts + area_maintenance/widgets/build_database_version.ts
* (WC-2026-11-26-build-database-version-panel).
*
* Below it, folded: the dd_ontology RECOVERY file pair (build / restore).
*
* @exports {Function} render_build_database_version
* @exports {Function} seed_state_badge  - pure, for its client gate
* @exports {Function} release_text      - pure, for its client gate
*/



// the job handle kept across a reload (data_manager local db, 'status' table)
const JOB_KEY = 'process_build_install_version'
// the last source/output choice (localStorage, origin-scoped like update_ontology's)
const CHOICE_KEY = 'dedalo_seed_panel_choice'
// the download route of the newest private build (src/core/install/seed_build_download.ts)
const DOWNLOAD_URL = '/dedalo/install/seed_build/'



/**
* RENDER_BUILD_DATABASE_VERSION
* Constructor stub. No instance state is held here; all render logic lives in
* prototype methods and private module-scope functions.
* @returns {boolean} Always returns true (no-op constructor).
*/
export const render_build_database_version = function() {

	return true
}//end render_build_database_version



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
render_build_database_version.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
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
* SEED_STATE_BADGE
* The badge of the vendored seed's state against this checkout's sources.
* Pure — exported for its client gate.
* @param {string} state - 'current' | 'stale' | 'missing'
* @returns {{text:string, cls:string}}
*/
export const seed_state_badge = function (state) {

	switch (state) {
		case 'current':
			return { text: get_label.seed_state_current || 'Up to date', cls: 'pill_ok' }
		case 'stale':
			return { text: get_label.seed_state_stale || 'Out of date', cls: 'pill_warning' }
		default:
			return { text: get_label.seed_state_missing || 'Missing', cls: 'pill_danger' }
	}
}//end seed_state_badge



/**
* RELEASE_TEXT
* One line for an ontology release summary: version · export date · exporting host.
* Pure — exported for its client gate.
* @param {Object|null} release - {version, date, host?} (seed_panel.ts ReleaseSummary or a manifest's ontology_release)
* @returns {string}
*/
export const release_text = function (release) {

	if (!release || typeof release!=='object') {
		return '—'
	}
	return [
		release.version || null,
		(typeof release.date==='string' && release.date.length>=10) ? release.date.slice(0, 10) : null,
		release.host || null
	].filter(Boolean).join(' · ') || '—'
}//end release_text



/**
* GET_CONTENT_DATA
* The install-database panel, then the folded recovery-file pair.
* @param {Object} self - Widget instance (build_database_version).
* @returns {Promise<HTMLElement>}
*/
const get_content_data = async function(self) {

	const value = self.value || {}

	const content_data = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'content_data build_database_version_content'
	})

	content_data.appendChild(render_seed_panel(self, value))

	// ontology recovery file (build / restore), folded: a different job
		const fold = ui.create_dom_element({
			element_type	: 'details',
			class_name		: 'dd_fold recovery_fold',
			parent			: content_data
		})
		ui.create_dom_element({
			element_type	: 'summary',
			text_content	: get_label.seed_recovery_title || 'Ontology recovery file',
			parent			: fold
		})
		const build_recovery_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container build_recovery_version_container',
			parent			: fold
		})
		build_recovery_container.appendChild(render_build_recovery_version_file(self, value))
		const restore_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'group_container restore_dd_ontology_recovery_from_file_container',
			parent			: fold
		})
		restore_container.appendChild(render_restore_dd_ontology_recovery_from_file(self, value))


	return content_data
}//end get_content_data



/**
* BUILD_READOUT
* The kit's key/value readout (`.dd_readout` > `.dd_row` > `.dd_k` + `.dd_v`).
* A row value is TEXT (`v`), optionally led by a badge (`badge: {text, cls}`).
* @param {Array<{k:string, v?:string, mono?:boolean, badge?:Object}>} rows
* @returns {HTMLElement}
*/
const build_readout = function (rows) {

	const readout = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_readout'
	})
	rows.forEach(row => {
		const tr = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_row',
			parent			: readout
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_k',
			text_content	: row.k,
			parent			: tr
		})
		const cell = ui.create_dom_element({
			element_type	: 'div',
			class_name		: row.mono ? 'dd_v mono' : 'dd_v',
			parent			: tr
		})
		if (row.badge) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_badge ' + row.badge.cls,
				text_content	: row.badge.text,
				parent			: cell
			})
		}
		if (row.v!==undefined || !row.badge) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'v_text',
				// server text (paths, hosts, detail sentences): TEXT, never a sink
				text_content	: (row.v===null || row.v===undefined || row.v==='') ? '—' : String(row.v),
				parent			: cell
			})
		}
	})

	return readout
}//end build_readout



/**
* EYEBROW
* @param {string} text
* @param {HTMLElement} parent
* @returns {HTMLElement}
*/
const eyebrow = function (text, parent) {

	return ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_eyebrow',
		text_content	: text,
		parent			: parent
	})
}//end eyebrow



/**
* FORMAT_BYTES
* @param {number|null} bytes
* @returns {string}
*/
const format_bytes = function (bytes) {

	if (typeof bytes!=='number' || !isFinite(bytes)) {
		return '—'
	}
	return bytes >= 1048576
		? (bytes / 1048576).toFixed(1) + ' MB'
		: Math.round(bytes / 1024) + ' KB'
}//end format_bytes



/**
* SOURCE_LABEL
* @param {Object} option - a value.sources entry {id, kind}
* @returns {string}
*/
const source_label = function (option) {

	switch (option.kind) {
		case 'local_export':
			return get_label.seed_source_local_export || "This server's export"
		case 'master':
			return (get_label.update_ontology_master_server || 'Master server') + ': ' + option.id.slice('master:'.length)
		default:
			return get_label.seed_source_shipped || 'Release shipped with this code'
	}
}//end source_label



/**
* BUILD_DOWNLOADS
* The newest private build's download links (the seed + its manifest).
* @returns {HTMLElement}
*/
const build_downloads = function () {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'seed_downloads'
	})
	const links = [
		{ file: 'dedalo_install.pgsql.gz', text: (get_label.download || 'Download') + ' · dedalo_install.pgsql.gz' },
		{ file: 'dedalo_install.pgsql.gz.manifest.json', text: (get_label.download || 'Download') + ' · manifest' }
	]
	// kit buttons (an <a class="button"> takes the global icon-button style); the route
	// answers Content-Disposition: attachment, so the page stays where it is
	links.forEach(item => {
		const button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light seed_download',
			text_content	: item.text,
			parent			: node
		})
		button.addEventListener('click', (e) => {
			e.stopPropagation()
			window.location.assign(DOWNLOAD_URL + item.file)
		})
	})

	return node
}//end build_downloads



/**
* BUILD_PICKER
* A radio list on the kit's server picker (`.server_picker` > `.server_row`).
* @param {string} name - the radio group name
* @param {Array<{id:string, title:string, meta?:string, disabled?:boolean, note?:string}>} items
* @param {string} selected - the initially selected id
* @param {Function} on_change - called with the newly selected id
* @returns {HTMLElement}
*/
const build_picker = function (name, items, selected, on_change) {

	const picker = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'server_picker seed_picker'
	})
	items.forEach(item => {
		const row = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'server_row' + (item.disabled ? ' off' : '') + (item.id===selected ? ' on' : ''),
			parent			: picker
		})
		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'radio',
			parent			: row
		})
		input.name		= name
		input.value		= item.id
		input.checked	= item.id===selected
		input.disabled	= item.disabled===true
		input.addEventListener('change', () => {
			picker.querySelectorAll('.server_row').forEach(el => { el.classList.remove('on') })
			row.classList.add('on')
			on_change(item.id)
		})
		const meta = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'meta',
			parent			: row
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'nm',
			text_content	: item.title,
			parent			: meta
		})
		if (item.meta) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'url',
				text_content	: item.meta,
				parent			: meta
			})
		}
		if (item.note) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_badge pill_warning',
				text_content	: item.note,
				parent			: row
			})
		}
	})

	return picker
}//end build_picker



/**
* CHECK_LABEL
* @param {string} id - a preflight check id
* @returns {string}
*/
const check_label = function (id) {

	const labels = {
		pg_tools		: get_label.seed_check_pg_tools || 'PostgreSQL tools',
		database_role	: get_label.seed_check_database_role || 'Database permission',
		build_lock		: get_label.seed_check_build_lock || 'Other builds',
		source			: get_label.source || 'Source',
		output			: get_label.seed_output || 'Output',
		disk			: get_label.seed_check_disk || 'Disk space'
	}
	return labels[id] || id
}//end check_label



/**
* RENDER_CHECKS
* The preflight report: one readout row per check (badge + what was found), then
* the fix of every failed check as a warning note.
* @param {Object} report - {ok, checks:[{id, ok, detail, fix?}]}
* @returns {DocumentFragment}
*/
const render_checks = function (report) {

	const fragment = new DocumentFragment()
	const checks = Array.isArray(report?.checks) ? report.checks : []
	fragment.appendChild(build_readout(checks.map(check => ({
		k		: check_label(check.id),
		badge	: check.ok
			? { text: get_label.ok || 'OK', cls: 'pill_ok' }
			: { text: get_label.seed_check_failed || 'Needs action', cls: 'pill_danger' },
		v		: check.detail
	}))))
	checks.filter(check => !check.ok && check.fix).forEach(check => {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_warning seed_fix',
			text_content	: check_label(check.id) + ': ' + check.fix,
			parent			: fragment
		})
	})

	return fragment
}//end render_checks



/**
* RENDER_RESULT
* A finished build: its sentence, what it produced from what, and what to do next.
* @param {Object} result - the job result (build_database_version.ts buildInstallOwned)
* @returns {HTMLElement}
*/
const render_result = function (result) {

	const node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'seed_result'
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: Array.isArray(result.errors) && result.errors.length ? 'warning' : 'ok',
		text_content	: String(result.msg || ''),
		parent			: node
	})
	const checks = Array.isArray(result.checks) ? result.checks.length : 0
	node.appendChild(build_readout([
		{ k: get_label.file || 'File', v: result.output, mono: true },
		{ k: get_label.source || 'Source', v: result.source?.location, mono: true },
		{ k: get_label.seed_release || 'Ontology release', v: release_text(result.release) },
		{ k: get_label.size || 'Size', v: format_bytes(Number.parseInt(result.file_size, 10)) },
		{ k: get_label.seed_verified || 'Verified', v: (get_label.seed_checks_passed || '%s install checks passed').replace('%s', String(checks)) }
	]))
	if (Array.isArray(result.errors) && result.errors.length) {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note state_warning',
			text_content	: result.errors.join('\n'),
			parent			: node
		})
	}
	if (result.target==='private') {
		node.appendChild(build_downloads())
	}
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_note',
		text_content	: result.target==='checkout'
			? (get_label.seed_next_checkout || 'Commit the seed, its manifest and the ontology release files together.')
			: (get_label.seed_next_private || 'Only the newest build is kept: the next build replaces it.'),
		parent			: node
	})

	return node
}//end render_result



/**
* TRACK_BUILD_JOB
* Follows the build job (the ONE shared tracker, update_process_status): the
* finished steps (`frame.data.steps`) are written live into a console block; the
* tracker's own status nodes stay out of sight. Resolves the LAST frame.
* @param {string|number} pid
* @param {string} pfile
* @param {HTMLElement} parent
* @returns {Promise<Object|null>}
*/
const track_build_job = function (pid, pfile, parent) {

	const log = ui.create_dom_element({
		element_type	: 'pre',
		class_name		: 'seed_log',
		text_content	: get_label.seed_building || 'Building…',
		parent			: parent
	})
	const stream_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'seed_stream',
		parent			: parent
	})

	return new Promise((resolve) => {
		update_process_status(
			'build_install_version',
			pid,
			pfile,
			stream_node,
			1000,
			(last) => {
				stream_node.remove()
				resolve(last)
			},
			(frame) => {
				const steps = frame?.data?.steps
				if (Array.isArray(steps) && steps.length) {
					log.textContent = steps.join('\n')
				}
			}
		)
	})
}//end track_build_job



/**
* RENDER_SEED_PANEL
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - get_widget_value data (build_database_version.ts)
* @returns {HTMLElement}
*/
const render_seed_panel = function (self, value) {

	const panel = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'seed_panel'
	})

	// what it is
		eyebrow(get_label.seed_title || 'Install database', panel)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_note',
			text_content	: get_label.seed_intro || "The database a new installation starts from: the schema, the core ontology, the languages and the root user, verified by a test install. No installation's data is read.",
			parent			: panel
		})

	// collapsed / not loaded yet (widget_common.load): no readouts, no preflight call
		if (!Array.isArray(value.sources)) {
			return panel
		}

	// what it contains, and from where
		const parts = value.parts || {}
		panel.appendChild(build_readout([
			{
				k		: get_label.seed_part_schema || 'Schema',
				v		: (parts.schema || '—') + ' + ' + (get_label.seed_migrations || '%s migrations').replace('%s', String(parts.migrations ?? '—')),
				mono	: true
			},
			{
				k		: get_label.seed_part_ontology || 'Core ontology',
				v		: Array.isArray(parts.core_tlds) ? parts.core_tlds.join(', ') : '—',
				mono	: true
			}
		]))

	// the seed in this code
		const seed = value.checkout_seed
		if (seed) {
			eyebrow(get_label.seed_current || 'Seed in this code', panel)
			panel.appendChild(build_readout([
				{ k: get_label.file || 'File', v: seed.file, mono: true },
				{ k: get_label.seed_release || 'Ontology release', v: release_text(seed.release) },
				{ k: get_label.size || 'Size', v: format_bytes(seed.bytes) },
				{ k: get_label.seed_state || 'State', badge: seed_state_badge(seed.state) }
			]))
			if (Array.isArray(seed.findings) && seed.findings.length) {
				const details = ui.create_dom_element({
					element_type	: 'details',
					class_name		: 'dd_fold seed_findings',
					parent			: panel
				})
				ui.create_dom_element({
					element_type	: 'summary',
					text_content	: seed_state_badge(seed.state).text + ' (' + seed.findings.length + ')',
					parent			: details
				})
				ui.create_dom_element({
					element_type	: 'pre',
					text_content	: seed.findings.join('\n'),
					parent			: details
				})
			}
		}

	// the last private build
		const last = value.last_build
		if (last) {
			eyebrow(get_label.seed_last_build || 'Last build', panel)
			panel.appendChild(build_readout([
				{ k: get_label.date || 'Date', v: typeof last.built_at==='string' ? new Date(last.built_at).toLocaleString() : '—' },
				{ k: get_label.source || 'Source', v: last.source?.location, mono: true },
				{ k: get_label.seed_release || 'Ontology release', v: release_text(last.release) },
				{ k: get_label.size || 'Size', v: format_bytes(last.seed?.bytes) }
			]))
			panel.appendChild(build_downloads())
		}

	// choices: source + output
		const sources = Array.isArray(value.sources) ? value.sources : []
		const targets = Array.isArray(value.targets) ? value.targets : []
		// the last choice survives a reload, but only while it is still an offered, enabled option
		let stored = {}
		try { stored = JSON.parse(window.localStorage.getItem(CHOICE_KEY)) || {} } catch { /* corrupt: defaults */ }
		const offered = (list, id) => list.some(item => item.id===id && item.available!==false)
		const choice = {
			source : offered(sources, stored.source) ? stored.source : (value.default_source || sources[0]?.id || 'shipped'),
			target : offered(targets, stored.target) ? stored.target : 'private'
		}
		const save_choice = () => { window.localStorage.setItem(CHOICE_KEY, JSON.stringify(choice)) }

		eyebrow(get_label.source || 'Source', panel)
		panel.appendChild(build_picker('seed_source', sources.map(option => ({
			id		: option.id,
			title	: source_label(option),
			meta	: [option.location, option.release ? release_text(option.release) : null].filter(Boolean).join(' — ')
		})), choice.source, (id) => {
			choice.source = id
			save_choice()
			run_checks()
		}))

		eyebrow(get_label.seed_output || 'Output', panel)
		panel.appendChild(build_picker('seed_target', targets.map(target => ({
			id			: target.id,
			title		: target.id==='checkout'
				? (get_label.seed_output_checkout || 'This code checkout (to commit)')
				: (get_label.seed_output_private || 'Private folder (to download)'),
			meta		: target.location,
			disabled	: target.available!==true,
			note		: target.available!==true ? (get_label.seed_output_unavailable || 'Not a writable git checkout') : null
		})), choice.target, (id) => {
			choice.target = id
			save_choice()
			run_checks()
		}))

	// checks
		eyebrow(get_label.seed_checks || 'Checks', panel)
		const checks_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'seed_checks',
			parent			: panel
		})

	// build
		const button_build = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary button_build',
			text_content	: get_label.seed_build || 'Build install database',
			parent			: panel
		})
		button_build.disabled = true
		const response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'seed_response',
			parent			: panel
		})

	// the preflight of the current choice; the newest request wins
		let check_seq = 0
		const run_checks = async function () {
			const seq = ++check_seq
			button_build.disabled = true
			checks_node.replaceChildren(ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note',
				text_content	: (get_label.processing || 'Processing') + '…'
			}))
			const api_response = await self.seed_preflight(choice)
			if (seq!==check_seq) {
				return
			}
			checks_node.replaceChildren()
			if (request_failed(api_response)) {
				checks_node.appendChild(build_failure(api_response.error))
				return
			}
			const report = response_data(api_response)
			checks_node.appendChild(render_checks(report))
			button_build.disabled = report?.ok!==true
		}

	// follow a job (a new one, or the one a reload re-attaches to)
		const follow = async function (pid, pfile) {
			button_build.disabled = true
			button_build.classList.add('button_spinner')
			panel.classList.add('running')
			try {
				const final_frame = await track_build_job(pid, pfile, response)
				data_manager.delete_local_db_data(JOB_KEY, 'status')
				const job_error = normalize_stream_error(final_frame)
				const result = final_frame?.data
				const finished = final_frame?.is_running===false
					&& result!==null && typeof result==='object'
					&& typeof result.output==='string'
				if (job_error) {
					response.appendChild(build_failure(job_error))
				} else if (finished) {
					response.appendChild(render_result(result))
				} else {
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						text_content	: get_label.seed_build_unfinished || 'The build ended without a result.',
						parent			: response
					})
				}
			} finally {
				button_build.classList.remove('button_spinner')
				panel.classList.remove('running')
				run_checks()
			}
		}

		button_build.addEventListener('click', async (e) => {
			e.stopPropagation()
			if (!confirm(get_label.seed_confirm || 'Build the install database now?')) {
				return
			}
			response.replaceChildren()
			button_build.disabled = true
			const api_response = await self.build_install_version(choice)
			const pid	= response_extension(api_response, 'pid')
			const pfile	= response_extension(api_response, 'pfile')
			if (request_failed(api_response) || !pid || !pfile) {
				response.appendChild(request_failed(api_response)
					? build_failure(api_response.error)
					: ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error',
						text_content	: String(response_extension(api_response, 'msg') || (get_label.error || 'Error'))
					}))
				run_checks()
				return
			}
			data_manager.set_local_db_data({ id: JOB_KEY, value: { pid, pfile } }, 'status')
			follow(pid, pfile)
		})

	// a build already running (this page was reloaded mid-build): follow it, else check
		data_manager.get_local_db_data(JOB_KEY, 'status')
		.then((local) => {
			if (local?.value?.pid && local?.value?.pfile) {
				follow(local.value.pid, local.value.pfile)
			} else {
				run_checks()
			}
		})


	return panel
}//end render_seed_panel



/**
* RENDER_BUILD_RECOVERY_VERSION_FILE
* Builds the DOM fragment for the "build recovery version file" operation panel.
*
* The panel triggers `self.build_recovery_version_file()`, which dispatches to
* the server via `dd_area_maintenance_api → widget_request` and exports the live
* `dd_ontology` table as `dd_ontology_recovery.sql` under `/install/db/`.
*
* The panel contains:
*   - An info line describing the file that will be generated.
*   - A confirm-guarded button that adds a `loading` CSS class while the call
*     is in flight and removes it on completion.
*   - A `process_response` div where the raw JSON API response is rendered.
*
* The response area is cleared with a `while (firstChild)` loop before printing
* the new result. This is equivalent to `replaceChildren()` but written for
* broader compatibility.
*
* (!) `self.build_recovery_version_file()` uses `use_worker: true` in its
* data_manager.request call, intended to keep the main thread unblocked. In
* the current codebase the worker path falls back to a normal fetch internally,
* so there is no functional difference.
*
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - Server-supplied value object (not used in this panel).
* @returns {DocumentFragment} Fragment ready to be appended to the panel container.
*/
const render_build_recovery_version_file = function (self, value) {

	const fragment = new DocumentFragment()

	// info
		const text = `Creates 'dd_ontology_recovery.sql' file with basic Ontology data`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

	// button_process build_recovery_version
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: 'Create \'dd_ontology_recovery.sql\' file',
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('loading')
			button_process.classList.add('button_spinner')

			try {
				// build_recovery_version
				const api_response = await self.build_recovery_version_file()

				if(SHOW_DEBUG===true) {
					console.log('**** render_build_recovery_version_file api_response:', api_response);
				}

				// process_response print
				while (process_response.firstChild) {
					process_response.removeChild(process_response.firstChild);
				}
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'response',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				// unlocks the button submit
				button_process.classList.remove('loading')
				button_process.classList.remove('button_spinner')
			}
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_build_recovery_version_file



/**
* RENDER_RESTORE_DD_ONTOLOGY_RECOVERY_FROM_FILE
* Builds the DOM fragment for the "restore dd_ontology_recovery from file"
* operation panel.
*
* The panel triggers `self.restore_dd_ontology_recovery_from_file()`, which
* dispatches via `dd_area_maintenance_api → class_request` (not `widget_request`)
* and reimports `/install/db/dd_ontology_recovery.sql` to recreate the
* `dd_ontology_recovery` table in the live database.
*
* The panel contains:
*   - An info line describing the operation.
*   - A confirm-guarded button with the same `loading` toggle pattern used by
*     `render_build_recovery_version_file`.
*   - A `process_response` div where the raw JSON API response is rendered.
*
* Like the other panels, this operation dispatches via `widget_request` to
* `build_database_version::restore_dd_ontology_recovery_from_file`, gated by the
* widget-level `API_ACTIONS` list in `class.build_database_version.php`.
*
* (!) This handler calls `console.log` unconditionally (not guarded by
* `SHOW_DEBUG`). This differs from the pattern used in the other two panels.
*
* @param {Object} self - Widget instance (build_database_version).
* @param {Object} value - Server-supplied value object (not used in this panel).
* @returns {DocumentFragment} Fragment ready to be appended to the panel container.
*/
const render_restore_dd_ontology_recovery_from_file = function (self, value) {

	const fragment = new DocumentFragment()

	// info
		const text = `Restores table 'dd_ontology_recovery' from file`
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: text,
			class_name		: 'info_text',
			parent			: fragment
		})

	// button_process restore_dd_ontology_recovery_from_file
		const button_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_process',
			inner_html		: 'Restore \'dd_ontology_recovery\' table from file',
			parent			: fragment
		})
		// event click
		const click_handler = async (e) => {
			e.stopPropagation()

			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// blur button
			document.activeElement.blur()

			// locks the button submit
			button_process.classList.add('loading')
			button_process.classList.add('button_spinner')

			try {
				// restore_dd_ontology_recovery_from_file
				const api_response = await self.restore_dd_ontology_recovery_from_file()

				console.log('**** render_restore_dd_ontology_recovery_from_file api_response:', api_response);

				// process_response print
				while (process_response.firstChild) {
					process_response.removeChild(process_response.firstChild);
				}
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'response',
					text_content	: JSON.stringify(api_response, null, 2),
					parent			: process_response
				})
			} finally {
				// unlocks the button submit
				button_process.classList.remove('loading')
				button_process.classList.remove('button_spinner')
			}
		}
		button_process.addEventListener('click', click_handler)

	// process_response
		const process_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_response',
			parent			: fragment
		})


	return fragment
}//end render_restore_dd_ontology_recovery_from_file



// @license-end
