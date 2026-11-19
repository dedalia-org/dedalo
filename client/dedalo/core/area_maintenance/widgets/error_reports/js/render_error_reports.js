// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {request_failed, response_data} from '../../../../common/js/api_error.js'
	import {handle_api_error} from '../../../../common/js/error_dispatch.js'
	import {error_text} from '../../../../common/js/render_api_error.js'



/**
* RENDER_ERROR_REPORTS
* DOM layer of the error_reports maintenance widget (WC-018).
*
* Design follows the system_info widget: a rounded datalist table with an
* uppercase header row and grid data rows, styled with the theme-aware CSS
* custom properties (--bg_surface, --border_default, --fg_muted, …). The rules
* are injected once as a scoped <style> rather than added to the compiled
* main.css — main.css is re-synced from the PHP tree and this widget is
* TS-only, so a self-contained style survives the sync (sync-drift hazard).
*
* SECURITY (DS-1): every report field (description, source, stack, context) is
* UNTRUSTED user/browser-supplied content. It is rendered
* EXCLUSIVELY through text_content / textContent — never inner_html — so a
* crafted report can not become markup in a global admin's browser.
*
* @module render_error_reports
*/
export const render_error_reports = function() {

	return true
}//end render_error_reports



/**
* LIST
* Render the widget (system_info render contract: 'content' returns the bare
* content_data for the unified load() re-render; 'full' wraps it).
*
* The widget's look lives in css/error_reports.less → compiled into main.css
* (@import'ed from area_maintenance.less), scoped under .error_reports_widget —
* the SINGLE source of truth for the styling.
* @param {Object} options
* @param {string} [options.render_level='full']
* @returns {Promise<HTMLElement>}
*/
render_error_reports.prototype.list = async function(options={}) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = render_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* RENDER_CONTENT_DATA
* Build the widget interior. Every report-derived string renders via
* text_content (DS-1).
* @param {Object} self - the error_reports widget instance
* @returns {HTMLElement} content_data node
*/
const render_content_data = function(self) {

	const value	= self.value || {}
	const total	= (typeof value.total==='number') ? value.total : null

	const content_data = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'content_data full_width error_reports_widget'
	})

	// summary: total + latest
		const summary = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_reports_summary',
			parent			: content_data
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'error_reports_total',
			text_content	: total!==null ? (total + ' report' + (total===1 ? '' : 's')) : '—',
			parent			: summary
		})
		if (value.latest_received_at) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'error_reports_meta',
				text_content	: 'latest: ' + value.latest_received_at,
				parent			: summary
			})
		}
		if (total===null) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'error_reports_meta',
				text_content	: 'Report store not available yet.',
				parent			: summary
			})
		}

	// target — where reports from THIS installation are sent (env-driven,
	// DEDALO_ERROR_REPORT_EMAIL). textContent only (DS-1).
		const target = typeof value.target==='string' ? value.target : null
		if (target!==null) {
			const target_row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error_reports_target',
				parent			: content_data
			})
			ui.create_dom_element({
				element_type	: 'b',
				text_content	: 'Reports are sent to: ',
				parent			: target_row
			})
			ui.create_dom_element({
				element_type	: 'code',
				text_content	: target,
				parent			: target_row
			})
		}

	// table
		const table = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_reports_table',
			parent			: content_data
		})
		// header row
			const header = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'er_row header',
				parent			: table
			})
			for (const label of ['Received', 'From', 'User', 'Section', 'Description']) {
				ui.create_dom_element({ element_type: 'div', text_content: label, parent: header })
			}
		// rows load on demand
			const list_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error_reports_list',
				parent			: table
			})

	// footer: load button + pagination state
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_reports_footer',
			parent			: content_data
		})
		const load_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light',
			text_content	: get_label.load || 'Load reports',
			parent			: footer
		})

		let offset		= 0
		const page_size	= 25

		load_button.addEventListener('click', async function() {
			load_button.disabled = true
			load_button.classList.add('button_spinner')
			try {
				const api_response = await data_manager.request({
					body : {
						dd_api			: 'dd_area_maintenance_api',
						action			: 'widget_request',
						prevent_lock	: true,
						source	: {
							type	: 'widget',
							model	: 'error_reports',
							action	: 'get_reports'
						},
						options	: { offset : offset, limit : page_size }
					}
				})
				const result = response_data(api_response) || null
				if (request_failed(api_response) || !result || !Array.isArray(result.reports)) {
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error_reports_empty',
						text_content	: request_failed(api_response)
							? error_text(api_response.error)
							: 'The reports could not be loaded.',
						parent			: list_container
					})
					load_button.disabled = false
					if (request_failed(api_response)) {
						// ONE error model: policy + renderer decide the surface
						await handle_api_error(api_response.error, {wrapper: list_container})
					}
					return
				}
				if (result.reports.length===0 && offset===0) {
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error_reports_empty',
						text_content	: 'No reports received yet.',
						parent			: list_container
					})
				}
				for (const report of result.reports) {
					append_report_row(report, list_container)
				}
				offset += result.reports.length
				load_button.textContent	= get_label.load_more || 'Load more'
				load_button.disabled	= offset >= result.total || result.reports.length===0
			} catch (error) {
				console.error(error)
				load_button.disabled = false
			} finally {
				load_button.classList.remove('button_spinner')
			}
		})


	return content_data
}//end render_content_data



/**
* APPEND_REPORT_ROW
* One report: a clickable grid summary row + a hidden detail panel toggled
* below it. textContent only (DS-1).
* @param {Object} report - StoredErrorReport row from the server
* @param {HTMLElement} list_container
* @returns {void}
*/
const append_report_row = function(report, list_container) {

	// summary row
		const row = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'er_row report',
			parent			: list_container
		})
		const section = report.section_tipo
			? report.section_tipo + (report.section_id ? '/' + report.section_id : '')
			: '—'
		const cells = [
			{ cls: 'er_when', text: report.received_at || '?' },
			{ cls: 'er_from', text: report.entity || '—' },
			{ cls: 'er_user', text: (report.user_id!==null && report.user_id!==undefined) ? String(report.user_id) : '—' },
			{ cls: 'er_section', text: section },
			{ cls: 'er_desc', text: typeof report.description==='string' ? report.description : '' }
		]
		for (const cell of cells) {
			ui.create_dom_element({ element_type: 'div', class_name: cell.cls, text_content: cell.text, parent: row })
		}

	// detail panel (built lazily on first open)
		const detail = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'er_detail',
			parent			: list_container
		})
		detail.style.display	= 'none'
		let built				= false

		row.addEventListener('click', function() {
			const open = detail.style.display==='none'
			detail.style.display = open ? 'block' : 'none'
			row.classList.toggle('open', open)
			if (open && !built) {
				build_detail(report, detail)
				built = true
			}
		})
}//end append_report_row



/**
* BUILD_DETAIL
* Populate a report's detail panel. All fields via textContent (DS-1).
* @param {Object} report
* @param {HTMLElement} detail
* @returns {void}
*/
const build_detail = function(report, detail) {

	const field = function(label, value) {
		if (value===null || value===undefined || value==='') return
		const row = ui.create_dom_element({ element_type: 'div', class_name: 'er_field', parent: detail })
		ui.create_dom_element({ element_type: 'span', class_name: 'er_label', text_content: label + ':', parent: row })
		ui.create_dom_element({ element_type: 'span', text_content: String(value), parent: row })
	}

	field('Description', report.description)
	field('Page', report.page_url)
	field('Dédalo version', report.dedalo_version)
	// mail outcome (context.mail, stamped by tool_error_report at send time)
		const mail = report.context && report.context.mail && typeof report.context.mail==='object'
			? report.context.mail
			: null
		if (mail) {
			field('Email', String(mail.status) + (mail.code ? ' (' + mail.code + ')' : '') + (mail.ref ? ' · ref ' + mail.ref : ''))
		}

	// captured JS errors — <pre> + textContent (stack text is hostile input)
		const js_errors = Array.isArray(report.js_errors) ? report.js_errors : []
		if (js_errors.length > 0) {
			ui.create_dom_element({ element_type: 'div', class_name: 'er_field er_label', text_content: 'JavaScript errors (' + js_errors.length + ')', parent: detail })
			for (const item of js_errors) {
				const line = [
					'[' + (item && item.type ? item.type : 'error') + ']' + (item && item.count > 1 ? ' ×' + item.count : ''),
					item && item.msg ? item.msg : '(no message)',
					item && item.source ? item.source + (item.line!==null && item.line!==undefined ? ':' + item.line : '') : null,
					item && item.stack ? item.stack : null
				].filter(el => el!==null).join('\n')
				const pre = document.createElement('pre')
				pre.className	= 'er_pre'
				pre.textContent	= line
				detail.appendChild(pre)
			}
		}

	// screenshot — an inline data URL the reporter attached. Rendered as an
	// <img> (a data: URL as img.src is inert markup-wise; still never innerHTML).
	// Only a well-formed image data URL is shown; anything else is ignored.
		const screenshot = report.context && typeof report.context.screenshot==='string'
			? report.context.screenshot
			: null
		const screenshot_ok = typeof screenshot==='string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(screenshot)
		if (screenshot_ok) {
			ui.create_dom_element({ element_type: 'div', class_name: 'er_field er_label', text_content: 'Screenshot', parent: detail })
			const link = ui.create_dom_element({ element_type: 'a', class_name: 'er_screenshot_link', parent: detail })
			link.setAttribute('href', screenshot)
			link.setAttribute('target', '_blank')
			link.setAttribute('rel', 'noopener noreferrer')
			const img = ui.create_dom_element({ element_type: 'img', class_name: 'er_screenshot', parent: link })
			img.setAttribute('src', screenshot)
			img.setAttribute('alt', 'Reported screenshot')
		}

	// raw context — pretty JSON, textContent. The screenshot blob is rendered
	// above; strip it here so the dump stays readable.
		if (report.context) {
			const context_view = {}
			for (const key in report.context) {
				if (Object.prototype.hasOwnProperty.call(report.context, key)) {
					context_view[key] = key==='screenshot'
						? (screenshot_ok ? '[see Screenshot above]' : report.context[key])
						: report.context[key]
				}
			}
			ui.create_dom_element({ element_type: 'div', class_name: 'er_field er_label', text_content: 'Context', parent: detail })
			const pre = document.createElement('pre')
			pre.className	= 'er_pre'
			pre.textContent	= JSON.stringify(context_view, null, 2)
			detail.appendChild(pre)
		}
}//end build_detail



// @license-end
