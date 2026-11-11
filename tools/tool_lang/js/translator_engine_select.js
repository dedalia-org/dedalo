// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/

import { make_activable } from '../../../core/common/js/a11y.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { register_error_policy } from '../../../core/common/js/error_policy.js';
// imports
import { ui } from '../../../core/common/js/ui.js';

// error policy. Both translation tools (the only callers of automatic_translation)
// show a translation.* refusal in their own panel, next to the language it is
// about; the page toast would say it a second time.
register_error_policy({
	'translation.*': { action: 'silent' },
});

/**
 * APPEND_ENGINE_SELECTOR
 * The translator-engine picker shared by tool_lang and tool_lang_multi: engine
 * <select> (choice persisted as 'translator_engine_select' in local-DB 'status'),
 * gear toggle and the browser-engine configuration panel (WASM/CPU checkbox,
 * persisted as 'translator_device_checkbox'). The panel is visible only while a
 * 'browser' type engine is selected.
 *
 * Side effects: sets self.translator_engine_select and self.translator_device_checkbox,
 * read by each tool at click time. Pre-selects self.target_translator.
 *
 * @param {Object} options
 * @param {Object} options.self - tool instance (tool_lang | tool_lang_multi)
 * @param {Array<Object>} options.translator_engine - [{name, label, type:'browser'|'server'}]
 * @param {HTMLElement} options.parent - node the picker is appended to
 * @returns {void}
 */
export const append_engine_selector = ({ self, translator_engine, parent }) => {
	const is_browser = (name) => translator_engine.find((el) => el.name === name)?.type === 'browser';

	// select
	self.translator_engine_select = ui.create_dom_element({
		element_type: 'select',
		parent: parent,
	});
	for (const engine of translator_engine) {
		const option = ui.create_dom_element({
			element_type: 'option',
			value: engine.name,
			text_content: engine.label,
			parent: self.translator_engine_select,
		});
		if (self.target_translator === engine.name) {
			option.selected = true;
		}
	}
	self.translator_engine_select.addEventListener('change', () => {
		data_manager.set_local_db_data(
			{
				id: 'translator_engine_select',
				value: self.translator_engine_select.value,
			},
			'status',
		);
		configuration_container.classList.toggle(
			'hide',
			!is_browser(self.translator_engine_select.value),
		);
	});

	// configuration. open/close the configuration options
	const show_configuration = ui.create_dom_element({
		element_type: 'span',
		class_name: 'icon gear',
		parent: parent,
	});
	make_activable(show_configuration, {
		label: self.get_tool_label('configuration') || 'Configuration',
		on_activate: () => configuration_container.classList.toggle('hide'),
	});

	const configuration_container = ui.create_dom_element({
		element_type: 'div',
		class_name: 'configuration_container hide',
		parent: parent,
	});

	// device checkbox (browser engine: webgpu by default, wasm/cpu when checked)
	const device_container = ui.create_dom_element({
		element_type: 'span',
		class_name: 'device_container',
		parent: configuration_container,
	});
	const option_label = ui.create_dom_element({
		element_type: 'label',
		text_content: self.get_tool_label('cpu_device') || 'More compatible, slower.',
		parent: device_container,
	});
	const translator_device_checkbox = ui.create_dom_element({
		element_type: 'input',
		type: 'checkbox',
	});
	self.translator_device_checkbox = translator_device_checkbox;
	option_label.prepend(translator_device_checkbox);

	const device_id = 'translator_device_checkbox';
	translator_device_checkbox.addEventListener('change', () => {
		data_manager.set_local_db_data(
			{
				id: device_id,
				value: translator_device_checkbox.checked,
			},
			'status',
		);
	});
	data_manager.get_local_db_data(device_id, 'status').then((device_saved) => {
		if (device_saved) {
			translator_device_checkbox.checked = device_saved.value;
		}
	});

	// initial visibility: the pre-selected (persisted) engine decides
	if (is_browser(self.translator_engine_select.value)) {
		configuration_container.classList.remove('hide');
	}
}; //end append_engine_selector

// @license-end
