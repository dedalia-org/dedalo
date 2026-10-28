// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {request_failed, response_data} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'



/**
* RENDER_MAINTENANCE_PREREQ
* The `.dd_prereq` block for an action the server refuses outside maintenance
* mode (update_code, update_data_version): the reason AND the switch, where the
* operator reads it — never discovered at the last step of a modal.
*
* The switch is check_config's own door (`set_maintenance_mode`), so there is
* one server path and one effect; check_config stays the place to turn it OFF.
*
* @param {HTMLElement} parent
* @param {Function} on_enabled - called after the server confirmed the switch
* @returns {HTMLElement} the block
*/
export const render_maintenance_prereq = function(parent, on_enabled) {

	const block = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'dd_note state_danger dd_prereq maintenance_prereq',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_prereq_text',
		text_content	: get_label.maintenance_mode_required || 'Maintenance mode is off: this action will be refused until it is enabled.',
		parent			: block
	})
	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'warning button_enable_maintenance',
		text_content	: get_label.maintenance_mode_enable || 'Enable maintenance mode',
		parent			: block
	})
	button.addEventListener('click', async (e) => {
		e.stopPropagation()

		const confirmed = await ui.confirm({
			header			: get_label.maintenance_mode_enable || 'Enable maintenance mode',
			body			: get_label.maintenance_mode_enable_warning || "Users other than 'root' will be logged out and will not be able to log in until maintenance mode is turned off (Check config).",
			accept_class	: 'warning'
		})
		if (confirmed!==true) {
			return
		}

		button.disabled = true
		button.classList.add('button_spinner')
		try {
			const api_response = await data_manager.request({
				body : {
					dd_api	: 'dd_area_maintenance_api',
					action	: 'widget_request',
					source	: { type : 'widget', model : 'check_config', action : 'set_maintenance_mode' },
					options	: { value : true }
				}
			})
			if (request_failed(api_response) || !response_data(api_response)) {
				if (request_failed(api_response)) {
					await handle_api_error(api_response.error, {wrapper: block})
				}
				button.disabled = false
				return
			}
			page_globals.maintenance_mode = true
			await on_enabled()
		} finally {
			button.classList.remove('button_spinner')
		}
	})

	return block
}//end render_maintenance_prereq



// @license-end
