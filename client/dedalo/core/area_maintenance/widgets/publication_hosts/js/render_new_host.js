// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

import {
	request_failed,
	response_data,
	response_extension,
} from '../../../../common/js/api_error.js';
import { handle_api_error } from '../../../../common/js/error_dispatch.js';
import { error_text } from '../../../../common/js/render_api_error.js';
import { ui } from '../../../../common/js/ui.js';
import { fact_row, section } from '../../update_code/js/render_update_status.js';

/**
 * RENDER_NEW_HOST
 * "New publication host" (root only): the drafts awaiting installation, their
 * kit, the sealed-package pairing, and the form that makes a draft
 * (engineering/PUBLICATION_HOST_SPEC.md §9.14; server:
 * src/core/area_maintenance/widgets/publication_host_setup.ts).
 *
 * Value (root's get_value only — another admin's payload has no `drafts` key):
 *   drafts_state : 'ok' | 'drafts_invalid'
 *   drafts       : Array<{name, created_at, draft, state:'awaiting'|'paired',
 *                  paired_as, kit:{name, instance, release, sha256, size,
 *                  built_at, file_name}|null}> | null
 *
 * THE FORM SENDS A DRAFT, NEVER A CREDENTIAL, and the server judges it with the
 * publication agent's own rules; a refusal names its fields
 * (`error.details.fields`, comma-separated declaration paths) and each input
 * whose `data-field` is listed is marked. The pairing upload sends the package
 * (base64) and the passphrase in ONE request; the passphrase input is cleared
 * whatever the answer, and nothing is kept on the instance.
 * Every server string is set as TEXT.
 */

/** The draft form's inputs, by declaration path (the server's field names). */
export const DRAFT_FORM_FIELDS = Object.freeze([
	'name',
	'instance',
	'site.domain',
	'listen.kind',
	'listen.host',
	'listen.port',
	'web.server',
	'apis',
	'v1.user',
	'media.mode',
	'media.root',
	'layout',
	'agent_user',
	'engine_group',
	'v2.user',
	'v2.unit',
	'v2.port',
]);

/**
 * READ_DRAFT_FORM
 * save_draft options from the form inputs (a map path → input): exactly the
 * draft keys the server reads — no engine_group on two machines, no listen
 * address on one, no v1 block on a v2-only draft, no media root for 'none'.
 * @param {Object<string, HTMLInputElement|HTMLSelectElement>} inputs
 * @returns {{name: string, draft: Object}}
 */
export const read_draft_form = function (inputs) {
	const text = (path) => String(inputs[path]?.value ?? '').trim();
	const number = (path) => {
		const value = text(path);
		return /^\d{1,5}$/.test(value) ? Number(value) : value;
	};
	const two = text('listen.kind') === 'tls';
	const draft = {
		instance: text('instance'),
		layout: text('layout'),
		apis: text('apis'),
		listen: two
			? { kind: 'tls', host: text('listen.host'), port: number('listen.port') }
			: { kind: 'unix' },
		agent_user: text('agent_user'),
		web: { server: text('web.server') },
		site: { domain: text('site.domain') },
		media:
			text('media.mode') === 'none'
				? { mode: 'none' }
				: { mode: text('media.mode'), root: text('media.root') },
		v2: { unit: text('v2.unit'), user: text('v2.user'), port: number('v2.port') },
	};
	if (!two) draft.engine_group = text('engine_group');
	if (draft.apis === 'v1_and_v2') draft.v1 = { user: text('v1.user') };

	return { name: text('name'), draft: draft };
}; //end read_draft_form

/**
 * FILL_DRAFT_FORM
 * The inputs from a proposal ({name, draft}) — the reverse of read_draft_form.
 * @returns {void}
 */
export const fill_draft_form = function (inputs, proposal) {
	const draft = proposal.draft || {};
	const set = (path, value) => {
		if (inputs[path])
			inputs[path].value = value === undefined || value === null ? '' : String(value);
	};
	set('name', proposal.name);
	set('instance', draft.instance);
	set('site.domain', draft.site?.domain);
	set('listen.kind', draft.listen?.kind);
	set('listen.host', draft.listen?.host);
	set('listen.port', draft.listen?.port);
	set('web.server', draft.web?.server);
	set('apis', draft.apis);
	set('v1.user', draft.v1?.user);
	set('media.mode', draft.media?.mode);
	set('media.root', draft.media?.root);
	set('layout', draft.layout);
	set('agent_user', draft.agent_user);
	set('engine_group', draft.engine_group);
	set('v2.user', draft.v2?.user);
	set('v2.unit', draft.v2?.unit);
	set('v2.port', draft.v2?.port);
}; //end fill_draft_form

/**
 * MARK_FIELD_ERRORS
 * Marks every input the refusal names (details.fields), clears the others.
 * @returns {string[]} the fields marked
 */
export const mark_field_errors = function (inputs, api_error) {
	const named = String(api_error?.details?.fields || '')
		.split(',')
		.map((field) => field.trim())
		.filter((field) => field.length > 0);
	for (const [path, input] of Object.entries(inputs)) {
		const bad = named.includes(path);
		input.classList.toggle('field_error', bad);
		input.setAttribute('aria-invalid', bad ? 'true' : 'false');
	}
	return named;
}; //end mark_field_errors

/**
 * BYTES_TO_BASE64 / BASE64_TO_BYTES
 * Chunked, so a 1 MiB package never builds one giant argument list.
 */
export const bytes_to_base64 = function (bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
};
export const base64_to_bytes = function (text) {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
};

/**
 * RENDER_NEW_HOST
 * The whole section: drafts (with their kit and pairing), then the form.
 * @param {Object} self - the widget instance
 * @param {Object} value - the widget value
 * @param {HTMLElement} body_response - the shared result console
 * @returns {HTMLElement}
 */
export const render_new_host = function (self, value, body_response) {
	const wrap = ui.create_dom_element({
		element_type: 'div',
		class_name: 'new_publication_host',
	});
	ui.create_dom_element({
		element_type: 'h3',
		class_name: 'new_host_title',
		text_content: get_label.publication_hosts_new_title || 'New publication host',
		parent: wrap,
	});

	if (value.drafts_state === 'drafts_invalid') {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_note state_danger drafts_invalid',
			text_content:
				get_label.publication_hosts_drafts_invalid ||
				'The publication host drafts file is unreadable or invalid. Drafts are not shown until it is repaired or deleted.',
			parent: wrap,
		});
	} else {
		const drafts = Array.isArray(value.drafts) ? value.drafts : [];
		for (const row of drafts) {
			render_draft(self, row, wrap, body_response);
		}
	}

	render_draft_form(self, wrap, body_response);

	return wrap;
}; //end render_new_host

/**
 * RENDER_DRAFT
 * One saved draft: what it declares, its state, its kit, and (awaiting) the
 * actions: build the kit, download it, pair from the sealed package (two
 * machines), remove.
 */
const render_draft = function (self, row, parent, body_response) {
	const draft = row.draft || {};
	const card = ui.create_dom_element({
		element_type: 'div',
		class_name: 'publication_host_draft update_status',
		dataset: { name: row.name },
		parent: parent,
	});
	const facts = section(card, row.name);
	const listen = draft.listen || {};
	const two = listen.kind === 'tls';
	fact_row(
		facts,
		get_label.publication_hosts_draft_state || 'State',
		row.state === 'paired'
			? `${get_label.publication_hosts_draft_paired || 'Paired as'} ${row.paired_as}`
			: get_label.publication_hosts_draft_awaiting || 'Awaiting installation',
		false,
	);
	fact_row(facts, get_label.publication_hosts_draft_instance || 'Instance', draft.instance, true);
	fact_row(
		facts,
		get_label.publication_hosts_draft_domain || 'Site domain',
		draft.site?.domain,
		true,
	);
	fact_row(
		facts,
		get_label.publication_hosts_draft_listen || 'Agent listens on',
		two
			? `${listen.host}:${listen.port}`
			: get_label.publication_hosts_draft_one_machine || 'a socket (this machine)',
		true,
	);
	fact_row(
		facts,
		get_label.publication_hosts_draft_apis || 'Publication APIs',
		draft.apis === 'v1_and_v2' ? 'v1 + v2' : 'v2',
		true,
	);
	const kit = row.kit;
	fact_row(
		facts,
		get_label.publication_hosts_kit_sha256 || 'Kit sha256',
		kit ? kit.sha256 : null,
		true,
	);
	if (kit) {
		fact_row(facts, get_label.publication_hosts_kit_release || 'Kit release', kit.release, true);
	}

	const actions = ui.create_dom_element({
		element_type: 'div',
		class_name: 'host_actions',
		parent: card,
	});
	const awaiting = row.state !== 'paired';

	const build_label = get_label.publication_hosts_build_kit || 'Build kit';
	const button_build = button(actions, 'button_build_kit', build_label, !awaiting);
	button_build.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run(self, {
			button: button_build,
			body_response: body_response,
			action: 'build_kit',
			options: { name: row.name },
			result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
			reload: true,
		});
	});

	const button_download = button(
		actions,
		'button_download_kit',
		get_label.publication_hosts_download_kit || 'Download kit',
		!kit,
	);
	button_download.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run(self, {
			button: button_download,
			body_response: body_response,
			action: 'download_kit',
			options: { name: row.name },
			result_text: (api_response) => save_kit(self, response_data(api_response)),
			reload: false,
		});
	});

	if (two && awaiting) {
		render_pair_form(self, row, card, body_response);
	}

	const remove_label = get_label.publication_hosts_remove_draft || 'Remove draft';
	const button_remove = button(actions, 'danger button_remove_draft', remove_label, false);
	button_remove.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run(self, {
			button: button_remove,
			body_response: body_response,
			action: 'remove_draft',
			options: { name: row.name },
			confirm_text: `${get_label.sure || 'Are you sure?'}\n${remove_label}: ${row.name}`,
			reload: true,
		});
	});

	return card;
}; //end render_draft

/**
 * SAVE_KIT
 * The downloaded kit becomes a file the browser saves, named as install.sh
 * expects; the console shows its sha256 (compare it on the publication host).
 * @returns {string} the console text
 */
const save_kit = function (self, data) {
	const bytes = base64_to_bytes(String(data?.kit_base64 || ''));
	const blob = new Blob([bytes], { type: 'application/gzip' });
	if (typeof self.save_file === 'function') {
		self.save_file(blob, data.file_name);
	}
	return `${data.file_name}\nsha256 ${data.sha256}\n\n${get_label.publication_hosts_kit_next || 'On the publication host, as root: sha256sum the kit (it must print the sha256 above), extract install.sh, then run sh install.sh <instance> --kit <file> --kit-sha256 <sha256>.'}`;
}; //end save_kit

/**
 * RENDER_PAIR_FORM
 * Two machines: the sealed package provision init wrote + its passphrase.
 * The server binds it to THIS draft (instance + address) and proves it live
 * before anything is stored; nothing here takes an address.
 */
const render_pair_form = function (self, row, card, body_response) {
	const details = ui.create_dom_element({
		element_type: 'details',
		class_name: 'dd_fold host_edit pair_package',
		parent: card,
	});
	ui.create_dom_element({
		element_type: 'summary',
		text_content: get_label.publication_hosts_pair_package || 'Pair from the sealed package',
		parent: details,
	});
	const fields = ui.create_dom_element({
		element_type: 'div',
		class_name: 'host_edit_fields',
		parent: details,
	});
	const file_label = ui.create_dom_element({
		element_type: 'label',
		class_name: 'host_field',
		parent: fields,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: 'host_field_label',
		text_content: get_label.publication_hosts_pair_package_file || 'Pairing package (.pairing)',
		parent: file_label,
	});
	const file_input = ui.create_dom_element({
		element_type: 'input',
		type: 'file',
		name: 'pairing_package',
		parent: file_label,
	});
	file_input.accept = '.pairing';
	const pass_label = ui.create_dom_element({
		element_type: 'label',
		class_name: 'host_field',
		parent: fields,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: 'host_field_label',
		text_content: get_label.publication_hosts_pair_passphrase || 'One-time passphrase',
		parent: pass_label,
	});
	const pass_input = ui.create_dom_element({
		element_type: 'input',
		type: 'password',
		name: 'pairing_passphrase',
		parent: pass_label,
	});
	pass_input.autocomplete = 'off';

	const pair_label = get_label.publication_hosts_pair || 'Pair';
	const button_pair = button(fields, 'button_apply button_pair_package', pair_label, false);
	button_pair.addEventListener('click', async (e) => {
		e.stopPropagation();
		const file = file_input.files && file_input.files[0];
		const passphrase = pass_input.value;
		// the passphrase leaves the page in this one request and nowhere else (the debug
		// request line redacts it: data_manager.js debug_redacted (every options value))
		pass_input.value = '';
		if (!file || passphrase.trim() === '') {
			body_response.textContent =
				get_label.publication_hosts_pair_missing ||
				'Choose the package file and type its passphrase.';
			return;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		await run(self, {
			button: button_pair,
			body_response: body_response,
			action: 'pair_package',
			options: { name: row.name, package_base64: bytes_to_base64(bytes), passphrase: passphrase },
			heading: `${row.name} · pair_package\n`,
			result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
			confirm_text: `${get_label.sure || 'Are you sure?'}\n${pair_label}: ${row.name}`,
			reload: true,
		});
	});

	return details;
}; //end render_pair_form

/**
 * RENDER_DRAFT_FORM
 * Domain + machines + APIs → Propose (the server's proposals) → every field
 * editable → Save draft. Root only (the whole section is).
 */
const render_draft_form = function (self, parent, body_response) {
	const details = ui.create_dom_element({
		element_type: 'details',
		class_name: 'dd_fold host_edit new_host_form',
		parent: parent,
	});
	ui.create_dom_element({
		element_type: 'summary',
		text_content: get_label.publication_hosts_new_draft || 'Create a draft',
		parent: details,
	});
	const fields = ui.create_dom_element({
		element_type: 'div',
		class_name: 'host_edit_fields',
		parent: details,
	});

	const inputs = {};
	const text_field = (path, label_text) => {
		inputs[path] = labelled(fields, path, label_text, 'input');
	};
	const select_field = (path, label_text, options) => {
		const select = labelled(fields, path, label_text, 'select');
		for (const [option_value, option_text] of options) {
			const option = ui.create_dom_element({
				element_type: 'option',
				text_content: option_text,
				parent: select,
			});
			option.value = option_value;
		}
		inputs[path] = select;
	};

	text_field('site.domain', get_label.publication_hosts_draft_domain || 'Site domain');
	select_field('listen.kind', get_label.publication_hosts_draft_machines || 'Machines', [
		['unix', get_label.publication_hosts_draft_machines_one || 'One machine (this server)'],
		[
			'tls',
			get_label.publication_hosts_draft_machines_two ||
				'Two machines (mTLS over a private network)',
		],
	]);
	text_field(
		'listen.host',
		get_label.publication_hosts_draft_listen_host || 'Private IPv4 address of the publication host',
	);
	select_field('apis', get_label.publication_hosts_draft_apis || 'Publication APIs', [
		['v2_only', get_label.publication_hosts_draft_apis_v2 || 'v2 only (recommended, no PHP)'],
		['v1_and_v2', get_label.publication_hosts_draft_apis_v1 || 'v1 and v2 (a v6-era website)'],
	]);

	const button_propose = button(
		fields,
		'button_propose_draft',
		get_label.publication_hosts_propose || 'Propose',
		false,
	);

	text_field('name', get_label.publication_hosts_draft_name || 'Host name (in this panel)');
	text_field('instance', get_label.publication_hosts_draft_instance || 'Instance');
	select_field('layout', get_label.publication_hosts_draft_layout || 'Layout', [
		['home', get_label.publication_hosts_draft_layout_home || '/home/<domain> (the site home)'],
		['system', get_label.publication_hosts_draft_layout_system || '/opt and /srv'],
	]);
	text_field('listen.port', get_label.publication_hosts_draft_listen_port || 'Agent port');
	select_field('web.server', get_label.publication_hosts_draft_web_server || 'Web server', [
		['apache', get_label.publication_hosts_draft_web_apache || 'Apache'],
		['nginx', get_label.publication_hosts_draft_web_nginx || 'nginx'],
	]);
	select_field('media.mode', get_label.publication_hosts_draft_media_mode || 'Media', [
		[
			'shared',
			get_label.publication_hosts_draft_media_shared ||
				"shared (a read-only mount of this server's media)",
		],
		[
			'copy',
			get_label.publication_hosts_draft_media_copy ||
				'copy (the published media, copied to the host)',
		],
		['none', get_label.publication_hosts_draft_media_none || 'none'],
	]);
	text_field(
		'media.root',
		get_label.publication_hosts_draft_media_root || 'Media directory on the publication host',
	);
	text_field('agent_user', get_label.publication_hosts_draft_agent_user || 'Agent account');
	text_field(
		'engine_group',
		get_label.publication_hosts_draft_engine_group || 'Group of the account that runs Dédalo',
	);
	text_field('v1.user', get_label.publication_hosts_draft_v1_user || 'v1 pool account');
	text_field('v2.user', get_label.publication_hosts_draft_v2_user || 'v2 account');
	text_field('v2.unit', get_label.publication_hosts_draft_v2_unit || 'v2 service');
	text_field('v2.port', get_label.publication_hosts_draft_v2_port || 'v2 local port');

	const sync_visibility = () => {
		const two = inputs['listen.kind'].value === 'tls';
		const v1 = inputs.apis.value === 'v1_and_v2';
		show(inputs['listen.host'], two);
		show(inputs['listen.port'], two);
		show(inputs.engine_group, !two);
		show(inputs['v1.user'], v1);
		show(inputs['media.root'], inputs['media.mode'].value !== 'none');
	};
	for (const path of ['listen.kind', 'apis', 'media.mode']) {
		inputs[path].addEventListener('change', sync_visibility);
	}
	sync_visibility();

	button_propose.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run(self, {
			button: button_propose,
			body_response: body_response,
			action: 'propose_draft',
			options: {
				domain: inputs['site.domain'].value.trim(),
				machines: inputs['listen.kind'].value === 'tls' ? 'two' : 'one',
				listen_host: inputs['listen.host'].value.trim(),
				apis: inputs.apis.value,
			},
			heading: 'propose_draft\n',
			result_text: (api_response) => {
				const proposal = response_data(api_response) || {};
				fill_draft_form(inputs, proposal);
				sync_visibility();
				return (
					get_label.publication_hosts_proposed ||
					'Proposed. Review every field, then save the draft.'
				);
			},
			reload: false,
		});
	});

	const button_save = button(
		fields,
		'button_apply button_save_draft',
		get_label.publication_hosts_save_draft || 'Save draft',
		false,
	);
	button_save.addEventListener('click', async (e) => {
		e.stopPropagation();
		const { name, draft } = read_draft_form(inputs);
		mark_field_errors(inputs, null);
		await run(self, {
			button: button_save,
			body_response: body_response,
			action: 'save_draft',
			options: { name: name, draft: draft },
			heading: `${name} · save_draft\n`,
			result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
			on_error: (api_error) => mark_field_errors(inputs, api_error),
			reload: true,
		});
	});

	return details;
}; //end render_draft_form

const show = (input, visible) => {
	const label = input.closest('label');
	if (label) label.hidden = !visible;
};

/**
 * LABELLED
 * A labelled input or select (the label wraps it: named by construction),
 * carrying its declaration path in data-field.
 */
const labelled = function (parent, path, label_text, element_type) {
	const label_node = ui.create_dom_element({
		element_type: 'label',
		class_name: 'host_field',
		parent: parent,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: 'host_field_label',
		text_content: label_text,
		parent: label_node,
	});
	const input = ui.create_dom_element({
		element_type: element_type,
		name: path,
		dataset: { field: path },
		parent: label_node,
	});
	if (element_type === 'input') input.type = 'text';

	return input;
}; //end labelled

const button = function (parent, class_name, text, disabled) {
	const node = ui.create_dom_element({
		element_type: 'button',
		class_name: 'light ' + class_name,
		text_content: text,
		parent: parent,
	});
	node.disabled = disabled === true;
	return node;
};

/**
 * RUN
 * The section's action path (the card actions' run_action, plus an on_error
 * hook for the field marks): confirm → spinner → request → outcome as TEXT →
 * reload on success. A refusal shows its label AND its sentence (the server's
 * deliberate, field-by-field text).
 * @returns {Promise<boolean>}
 */
const run = async function (self, spec) {
	if (spec.confirm_text && self.confirm_action(spec.confirm_text) !== true) {
		return false;
	}
	const heading = spec.heading || `${spec.options.name} · ${spec.action}\n`;
	const out = (text) => {
		self.last_outcome = heading + text;
		spec.body_response.textContent = self.last_outcome;
	};
	spec.button.classList.add('button_spinner');
	try {
		const api_response = await self.widget_request(spec.action, spec.options);
		if (request_failed(api_response)) {
			const api_error = api_response.error || {};
			const label_text = error_text(api_error);
			const sentence = typeof api_error.message === 'string' ? api_error.message : '';
			out(sentence && sentence !== label_text ? `${label_text}\n${sentence}` : label_text);
			if (typeof spec.on_error === 'function') spec.on_error(api_error);
			await handle_api_error(api_error, { wrapper: spec.body_response });
			return false;
		}
		out(
			typeof spec.result_text === 'function'
				? spec.result_text(api_response)
				: JSON.stringify(response_data(api_response) ?? null, null, 2),
		);
		if (spec.reload === true) {
			await self.reload();
		}
		return true;
	} catch (error) {
		console.error('publication_hosts action failed:', spec.action, error);
		out(error_text(error));
		return false;
	} finally {
		spec.button.classList.remove('button_spinner');
	}
}; //end run

// @license-end
