// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/

import { make_activable } from '../../../core/common/js/a11y.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { register_error_policy } from '../../../core/common/js/error_policy.js';
// imports
import { ui } from '../../../core/common/js/ui.js';
import { offered_models } from './browser_models.js';

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
 * The browser-engine panel also carries the MODEL selector and the quality (quantisation)
 * selector (v6 40bf5eaacf + 23010156ad; shown only for a model pinned at more than one
 * quantisation — model_dtypes): the model options are the engine
 * definition's `models` catalogue (register.json) minus the models not offered by default
 * (browser_models.js offered_models); the CPU checkbox is disabled for a WebGPU-only model.
 * Both choices persist ('translator_engine_model_select', 'translator_dtype_select').
 *
 * Side effects: sets self.translator_engine_select, self.translator_device_checkbox,
 * self.translator_engine_model_select, self.translator_dtype_select and
 * self.translator_models, read at click time through selected_browser_options().
 * Pre-selects self.target_translator.
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
			// a remembered CPU choice does not apply to a WebGPU-only model
			sync_model_controls();
		}
	});

	// translation model. The models differ in shape, not just size: TranslateGemma is a chat
	// model whose template treats its input as the text to translate, NLLB and opus-mt are
	// seq2seq MT models, Qwen a general instruct model (v6). Each option's LABEL is the
	// engine_<name> tool label, so it stays multilingual and can say the licence out loud.
	const browser_engine = translator_engine.find((el) => el.type === 'browser');
	const configured = Array.isArray(browser_engine?.models) && browser_engine.models.length > 0 ? browser_engine.models : null;
	const models = offered_models(configured);
	// the full definitions the worker may be sent: the OFFERED ones only (A1-02 re-review). A
	// name that is not offered — a remembered choice, a hand-edited select — resolves to no
	// model, and the run is refused before the worker starts (browser_translation.js).
	self.translator_models = models;

	const model_container = ui.create_dom_element({
		element_type: 'span',
		class_name: 'model_container',
		parent: configuration_container,
	});
	ui.create_dom_element({
		element_type: 'label',
		text_content: self.get_tool_label('translation_model') || 'Model',
		parent: model_container,
	});
	const model_select = ui.create_dom_element({
		element_type: 'select',
		parent: model_container,
	});
	for (const model of models) {
		ui.create_dom_element({
			element_type: 'option',
			value: model.name,
			text_content: self.get_tool_label(`engine_${model.name}`) || model.name,
			parent: model_select,
		});
	}
	self.translator_engine_model_select = model_select;

	// model quality (quantisation). q4 is what makes a 4B model fit in a browser at all and a
	// contributor to its repetition loops; q8 buys quality back at roughly double the download
	// and memory, which may not fit — so it stays opt-in (v6: a TranslateGemma choice).
	// The choices are the model's PINNED quantisations only — `dtypes` in its catalogue entry,
	// else its one `dtype`: the model store serves nothing that is not pinned, so offering an
	// unpinned q8 would offer a run that cannot load. The selector shows only when a model
	// has more than one.
	const QUALITY_LABELS = {
		q4: () => self.get_tool_label('model_quality_q4') || 'Standard (faster, ~2.5 GB)',
		q8: () => self.get_tool_label('model_quality_q8') || 'High (better, ~4.5 GB, may not fit)',
	};
	const quality_container = ui.create_dom_element({
		element_type: 'span',
		class_name: 'quality_container',
		parent: configuration_container,
	});
	ui.create_dom_element({
		element_type: 'label',
		text_content: self.get_tool_label('model_quality') || 'Model quality',
		parent: quality_container,
	});
	const dtype_select = ui.create_dom_element({
		element_type: 'select',
		parent: quality_container,
	});
	const fill_quality = (model) => {
		const dtypes = model_dtypes(model);
		const previous = dtype_select.value;
		dtype_select.replaceChildren();
		for (const dtype of dtypes) {
			ui.create_dom_element({
				element_type: 'option',
				value: dtype,
				text_content: QUALITY_LABELS[dtype] ? QUALITY_LABELS[dtype]() : dtype,
				parent: dtype_select,
			});
		}
		if (dtypes.includes(previous)) {
			dtype_select.value = previous;
		}
		quality_container.classList.toggle('hide', dtypes.length < 2);
	};
	self.translator_dtype_select = dtype_select;

	// the CPU option is meaningless for a WebGPU-only model: force GPU, disable the toggle and
	// say why, rather than offer a setting that crashes. Derived from the same catalogue.
	const sync_model_controls = () => {
		const model = models.find((item) => item.name === model_select.value);
		fill_quality(model);
		if (model?.requires_webgpu) {
			translator_device_checkbox.checked = false;
			translator_device_checkbox.disabled = true;
			translator_device_checkbox.title = self.get_tool_label('requires_webgpu_hint') || 'This model runs on the GPU only';
		} else {
			translator_device_checkbox.disabled = false;
			translator_device_checkbox.title = '';
		}
	};

	for (const [select, id] of [
		[model_select, 'translator_engine_model_select'],
		[dtype_select, 'translator_dtype_select'],
	]) {
		select.addEventListener('change', () => {
			data_manager.set_local_db_data({ id, value: select.value }, 'status');
			sync_model_controls();
		});
		data_manager.get_local_db_data(id, 'status').then((saved) => {
			// a remembered model that is no longer offered keeps the default
			if (saved?.value && Array.from(select.options).some((option) => option.value === saved.value)) {
				select.value = saved.value;
				sync_model_controls();
			}
		});
	}
	sync_model_controls();

	// initial visibility: the pre-selected (persisted) engine decides
	if (is_browser(self.translator_engine_select.value)) {
		configuration_container.classList.remove('hide');
	}
}; //end append_engine_selector

/**
 * SELECTED_BROWSER_OPTIONS
 * What the browser engine runs with, read at click time from the selector
 * append_engine_selector built: device ('wasm' when the CPU option is checked), the model
 * name, its full definition from the tool config, and the dtype override (only one of the
 * model's pinned quantisations — forcing a dtype the store does not serve would fail to load).
 * @param {Object} self - tool instance (tool_lang | tool_lang_multi)
 * @returns {{device:string, engine:string|null, model:Object|null, alternatives:Array<{name:string, label:string, requires_webgpu:boolean}>, dtype:string|null}}
 */
export const selected_browser_options = (self) => {
	const engine = self.translator_engine_model_select?.value || null;
	const model = (self.translator_models || []).find((item) => item.name === engine) || null;
	const chosen = self.translator_dtype_select?.value || null;
	return {
		device: self.translator_device_checkbox?.checked ? 'wasm' : 'webgpu',
		engine,
		model,
		// what a 'try a smaller model' refusal may name: the offered models, by their short label
		alternatives: (self.translator_models || []).map((item) => ({
			name: item.name,
			label: String(self.get_tool_label?.(`engine_${item.name}`) || item.name).split(' — ')[0],
			requires_webgpu: item.requires_webgpu === true,
		})),
		// only a quantisation the model is pinned at; null = its own default
		dtype: model && chosen && model_dtypes(model).length > 1 && model_dtypes(model).includes(chosen) ? chosen : null,
	};
}; //end selected_browser_options

/**
 * MODEL_DTYPES
 * The quantisations a catalogue model can run at: its `dtypes` list when it declares one
 * (each must be pinned in src/core/ai/model_pins.json), else its single `dtype`.
 * @param {Object|null|undefined} model - a browser_transformer.models entry
 * @returns {string[]}
 */
export const model_dtypes = (model) => {
	if (Array.isArray(model?.dtypes) && model.dtypes.length > 0) {
		return model.dtypes;
	}
	return model?.dtype ? [model.dtype] : [];
}; //end model_dtypes

// @license-end
