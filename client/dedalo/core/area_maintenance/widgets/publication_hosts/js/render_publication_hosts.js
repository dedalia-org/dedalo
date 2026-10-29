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
// imports
import { ui } from '../../../../common/js/ui.js';
import { check_row, fact_row, section } from '../../update_code/js/render_update_status.js';
import { has_media_copy } from './media_copy_view.js';
import { probe_facts } from './probe_view.js';
import { render_api_lockstep, render_runtime_invalid } from './render_api_lockstep.js';
import { render_new_host } from './render_new_host.js';

/**
 * RENDER_PUBLICATION_HOSTS
 * View layer of the publication_hosts widget: one card per paired host.
 *
 * Widget value (server: src/core/area_maintenance/widgets/publication_hosts.ts,
 * WC-2026-10-03-publication-hosts-widget):
 *   {
 *     registry         : { state: 'ok' | 'registry_invalid', reason: string|null,
 *                          check: {id:'registry', state:'blocked', detail}|null },
 *     registry_path    : string,
 *     engine_qualities : string[],
 *     is_root          : boolean,
 *     hosts            : Array<HostPanelRow> | null,  // null whenever state !== 'ok'
 *     runtime_invalid  : string | null,   // phase 4: the runtime results file is unreadable
 *     api_lockstep     : {engine_release, refused, checked_at, rows} // phase 4 (render_api_lockstep.js)
 *     drafts_state     : 'ok' | 'drafts_invalid'   // root only: "New publication host"
 *     drafts           : Array<DraftRow> | null      // (render_new_host.js)
 *   }
 *   HostPanelRow carries `qualities` and `probe` (non-secret registry fields)
 *   for the edit form, and `public_probe` (phase 6: the last public-URL probe
 *   verdict, beside its `public_gate` check).
 *   `bun` is {expected, reported}: the work system's pinned Bun beside the
 *   host's running Bun (both fact rows); the `bun_version` check judges them.
 *   `nginx_map` is the host-wide nginx media map (provision init §13.4):
 *   {managed, expected, applied, host_hash, contributions, invalid, refused,
 *   drift, agent_outdated} on an nginx host, null otherwise (render_nginx_map);
 *   a non-root row omits host_hash, contributions and invalid. Its state is
 *   the `nginx_map` CHECK the server appends to such a row.
 *
 * THE CONTRACT WITH THE SERVER is update_code's: ids and facts, never
 * sentences. Check rows go through the shared check_row with the
 * `publication_hosts` label prefix (`publication_hosts_check_<id>`). Every
 * server string is set as TEXT (SEC-XSS): addresses and URLs are operator data.
 *
 * A registry the server could not use (registry_invalid, or a value with no
 * registry block) is a LOUD state: no card, no control, the reason shown — as
 * the server's `registry.check` row (check_row) when it sends one. It is never shown as an empty list.
 * A registry LOCK held by a writer (the read answered publication_host.busy; a
 * registry_locked state is read the same, defensively — the server never sends
 * one) is BUSY: transient, its own sentence and a retry —
 * never "invalid, repair it". Any other failed read shows its own error.
 * The last action outcome survives the post-action reload (self.last_outcome), once.
 * Controls render only for root (the server refuses everyone else anyway).
 * Agent commands are disabled while the pairing is not proved: the server never
 * sends the bearer then, so an enabled button could only fail.
 */
export const render_publication_hosts = function () {
	return true;
}; //end render_publication_hosts

/**
 * LIST
 * Entry point for both modes. `render_level` 'content' returns content_data only.
 * @param {Object} options
 * @returns {Promise<HTMLElement>}
 */
render_publication_hosts.prototype.list = async function (options) {
	const self = this;

	const render_level = options.render_level || 'full';

	const content_data = get_content_data(self);
	if (render_level === 'content') {
		return content_data;
	}

	const wrapper = ui.widget.build_wrapper_edit(self, {
		content_data: content_data,
	});
	wrapper.content_data = content_data;

	return wrapper;
}; //end list

/**
 * GET_CONTENT_DATA
 * Registry state first; then the notes; then one card per host; then the
 * shared result console.
 * @param {Object} self
 * @returns {HTMLElement}
 */
const get_content_data = function (self) {
	const value = self.value || {};

	const content_data = ui.create_dom_element({
		element_type: 'div',
		class_name: 'content_data publication_hosts_content',
	});

	// a failed read: busy (a held lock) is transient; anything else names its
	// error. Neither is "the registry is invalid".
	const read_error = self.read_error || null;
	const registry = value.registry || {};
	if (is_busy(read_error, registry)) {
		render_registry_busy(self, content_data);
		return content_data;
	}
	if (read_error) {
		render_read_failed(content_data, read_error);
		return content_data;
	}

	// the runtime results file is unreadable (get_value degrades, never 500s)
	if (value.runtime_invalid) {
		content_data.appendChild(render_runtime_invalid(value.runtime_invalid));
	}

	// any other state but 'ok' (registry_invalid, or no block) is loud;
	// hosts is null then, and is never read
	if (registry.state !== 'ok') {
		render_registry_invalid(content_data, registry);
		return content_data;
	}

	const hosts = Array.isArray(value.hosts) ? value.hosts : [];
	const is_root = value.is_root === true;

	if (hosts.length === 0) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_note no_hosts',
			text_content:
				get_label.publication_hosts_none ||
				'No publication host is paired. Pair one on this server with sudo -u <engine user> bun run dedalo:pair-publication-host.',
			parent: content_data,
		});
	}
	if (!is_root && hosts.length > 0) {
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_note root_only',
			text_content:
				get_label.publication_hosts_root_only ||
				'Only the root user can act on a publication host.',
			parent: content_data,
		});
	}

	// consumed once: the repaint right after an action shows its outcome, later ones do not
	const outcome = typeof self.last_outcome === 'string' ? self.last_outcome : '';
	self.last_outcome = null;
	const body_response = ui.create_dom_element({
		element_type: 'pre',
		class_name: 'body_response',
		text_content: outcome,
	});

	for (const host of hosts) {
		render_host(self, host, is_root, body_response, content_data);
	}

	// Publication API lockstep (phase 4): engine release vs each host's v2/v1
	if (value.api_lockstep && hosts.length > 0) {
		content_data.appendChild(
			render_api_lockstep(value.api_lockstep, {
				is_root: is_root,
				on_push: (button) => push_apis(self, value.api_lockstep, button, body_response),
			}),
		);
	}

	// "New publication host" (root only: the server sends drafts to root alone)
	if (is_root && typeof value.drafts_state === 'string') {
		content_data.appendChild(render_new_host(self, value, body_response));
	}

	content_data.appendChild(body_response);

	return content_data;
}; //end get_content_data

/**
 * IS_BUSY
 * A writer holds the registry lock: the read was refused publication_host.busy.
 * A registry_locked state is read the same, defensively (the server never sends one).
 * @returns {boolean}
 */
const is_busy = function (read_error, registry) {
	if (read_error && read_error.code === 'publication_host.busy') {
		return true;
	}
	return registry.state === 'registry_locked';
}; //end is_busy

/**
 * RENDER_REGISTRY_BUSY
 * The transient state: another writer (the pairing CLI, a panel action) holds
 * the registry lock. Nothing is wrong with the file; retry re-reads it.
 * @returns {HTMLElement}
 */
const render_registry_busy = function (self, parent) {
	const note = ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_note state_warning registry_busy',
		parent: parent,
	});
	ui.create_dom_element({
		element_type: 'span',
		text_content:
			get_label.publication_hosts_registry_busy ||
			'The publication host registry is busy: another change is being written. Retry in a moment.',
		parent: note,
	});
	const button = action_button(note, 'button_retry', get_label.reload || 'Reload', false);
	button.addEventListener('click', async (e) => {
		e.stopPropagation();
		button.classList.add('button_spinner');
		try {
			await self.reload();
		} finally {
			button.classList.remove('button_spinner');
		}
	});

	return note;
}; //end render_registry_busy

/**
 * RENDER_READ_FAILED
 * The value could not be read (not busy): the error, as TEXT. Never the
 * "registry invalid" sentence — nothing says the file is wrong.
 * @returns {HTMLElement}
 */
const render_read_failed = function (parent, error) {
	const note = ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_note state_danger read_failed',
		text_content: error_text(error),
		parent: parent,
	});

	return note;
}; //end render_read_failed

/**
 * RENDER_REGISTRY_INVALID
 * The loud state: the registry file is unreadable / invalid (or the value
 * carries no registry block at all). The server's `registry.check` row renders
 * through the shared check_row (its detail is the reason); without one, the
 * reason is a badge.
 * @param {HTMLElement} parent
 * @param {{state:string, reason:string|null, check:object|null}} registry
 * @returns {HTMLElement}
 */
const render_registry_invalid = function (parent, registry) {
	const note = ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_note state_danger registry_invalid',
		parent: parent,
	});
	ui.create_dom_element({
		element_type: 'span',
		text_content:
			get_label.publication_hosts_registry_invalid ||
			'The publication host registry is invalid. Nothing is shown or applied until it is repaired.',
		parent: note,
	});
	const check = registry.check;
	if (check && typeof check === 'object' && typeof check.id === 'string') {
		const facts = ui.create_dom_element({
			element_type: 'div',
			class_name: 'registry_check',
			parent: note,
		});
		check_row(facts, check, 'publication_hosts');
	} else if (registry.reason) {
		ui.create_dom_element({
			element_type: 'span',
			class_name: 'dd_badge mono',
			text_content: String(registry.reason),
			parent: note,
		});
	}

	return note;
}; //end render_registry_invalid

/**
 * RENDER_HOST
 * One host card: facts, checks, then (root only) actions and the edit form.
 * @returns {HTMLElement}
 */
const render_host = function (self, host, is_root, body_response, parent) {
	const card = ui.create_dom_element({
		element_type: 'div',
		class_name: 'publication_host update_status',
		dataset: { name: host.name },
		parent: parent,
	});

	const facts = section(card, host.name);
	const rules = host.rules || {};
	// the server withholds the address from non-root viewers: no row then (an
	// "Address: —" would read as "no address", not "hidden")
	if (typeof host.address_label === 'string') {
		fact_row(facts, get_label.publication_hosts_address || 'Address', host.address_label, true);
	}
	fact_row(facts, get_label.publication_hosts_public_url || 'Public URL', host.public_url, true);
	fact_row(
		facts,
		get_label.publication_hosts_rules_expected || 'Expected rules hash',
		rules.expected,
		true,
	);
	fact_row(
		facts,
		get_label.publication_hosts_rules_reported || 'Reported rules hash',
		rules.reported,
		true,
	);
	// the host-wide nginx media map (nginx hosts only; null otherwise)
	render_nginx_map(facts, host.nginx_map);
	// Bun side by side: the work system's pin vs the host's running Bun (the
	// `bun_version` check below is red when they differ)
	const bun = host.bun || {};
	fact_row(facts, get_label.publication_hosts_bun_expected || 'Expected Bun', bun.expected, true);
	fact_row(facts, get_label.publication_hosts_bun_reported || 'Reported Bun', bun.reported, true);

	const checks = Array.isArray(host.checks) ? host.checks : [];
	for (const check of checks) {
		check_row(facts, check, 'publication_hosts');
	}
	// phase 6: when the public gate was last probed, and why it is not proven (TEXT)
	for (const [label_key, fallback, value] of probe_facts(host)) {
		fact_row(facts, get_label[label_key] || fallback, value, false);
	}

	if (is_root) {
		render_actions(self, host, card, body_response);
		render_edit_form(self, host, card, body_response);
	}

	return card;
}; //end render_host

/**
 * RENDER_NGINX_MAP
 * The host-wide nginx media map's facts (provision init §13.4): for a managed
 * map the expected and applied hashes, the shared host hash and how many
 * instances the host file merges. A host hash other than this instance's own
 * is "shared with n instances", never drift. Its STATE is the server's
 * `nginx_map` check (host_status.ts nginxMapCheck: agent_outdated, a recorded
 * refusal, unmanaged, none, drift or ok), rendered with the other checks —
 * the client never derives it. Nothing for a host the map does not apply to
 * (Apache, no media).
 * @param {HTMLElement} facts
 * @param {Object|null|undefined} map
 * @returns {void}
 */
const render_nginx_map = function (facts, map) {
	if (!map || typeof map !== 'object') return;
	if (map.managed !== true) return;
	fact_row(
		facts,
		get_label.publication_hosts_map_expected || 'Expected media map hash',
		map.expected,
		true,
	);
	fact_row(
		facts,
		get_label.publication_hosts_map_applied || 'Applied media map hash',
		map.applied,
		true,
	);
	// host-wide facts: absent (not null) on a non-root row, which shows this instance only
	if (!Object.hasOwn(map, 'host_hash')) return;
	fact_row(
		facts,
		get_label.publication_hosts_map_host_hash || 'Shared host map hash',
		map.host_hash,
		true,
	);
	fact_row(
		facts,
		get_label.publication_hosts_map_contributions || 'Instances in the host map',
		Number.isInteger(map.contributions) ? map.contributions : null,
		false,
	);
}; //end render_nginx_map

/**
 * ACTION_BUTTON
 * @returns {HTMLButtonElement}
 */
const action_button = function (parent, class_name, text, disabled) {
	const button = ui.create_dom_element({
		element_type: 'button',
		class_name: 'light ' + class_name,
		text_content: text,
		parent: parent,
	});
	button.disabled = disabled === true;

	return button;
}; //end action_button

/**
 * CONFIRM_TEXT
 * "Are you sure?" + what + on which host.
 * @returns {string}
 */
const confirm_text = function (action_label, target) {
	return `${get_label.sure || 'Are you sure?'}\n${action_label}: ${target}`;
}; //end confirm_text

/**
 * RENDER_ACTIONS
 * Apply media rules · Probe media · Roll back API · Reconcile media copy
 * (rows carrying a media_copy check: not proven a non-copy host holding nothing) ·
 * Probe public gate · Remove host.
 */
const render_actions = function (self, host, card, body_response) {
	const actions = ui.create_dom_element({
		element_type: 'div',
		class_name: 'host_actions',
		parent: card,
	});
	const agent_blocked = host.pairing_proved !== true;

	const apply_label = get_label.publication_hosts_apply_rules || 'Apply media rules';
	const button_apply = action_button(actions, 'button_apply_rules', apply_label, agent_blocked);
	button_apply.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button_apply,
			body_response: body_response,
			action: 'apply_rules',
			options: { name: host.name },
			confirm_text: confirm_text(apply_label, host.name),
			reload: true,
		});
	});

	const button_probe = action_button(
		actions,
		'button_probe',
		get_label.publication_hosts_probe || 'Probe media',
		agent_blocked,
	);
	button_probe.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button_probe,
			body_response: body_response,
			action: 'probe',
			options: { name: host.name },
			confirm_text: null, // read-only on the agent
			reload: false,
		});
	});

	render_rollback(self, host, actions, body_response, agent_blocked);

	if (has_media_copy(host)) {
		render_media_copy(self, host, actions, body_response, agent_blocked);
	}

	render_probe_public(self, host, actions, body_response);

	const remove_label = get_label.publication_hosts_remove_host || 'Remove host';
	const button_remove = action_button(actions, 'danger button_remove_host', remove_label, false);
	button_remove.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button_remove,
			body_response: body_response,
			action: 'remove_host',
			options: { name: host.name },
			confirm_text: confirm_text(remove_label, host.name),
			reload: true,
		});
	});

	return actions;
}; //end render_actions

/**
 * RENDER_MEDIA_COPY
 * Root: run the media_copy reconcile (APPLY) for this host — the
 * same pure derivation the engine applies every 10 min: copy what is missing,
 * unmark then delete what is no longer published, verify. Only on a row that
 * carries a `media_copy` check (has_media_copy); confirm-gated (it puts and
 * deletes files on a public machine); the server's sentence is shown as TEXT;
 * a round that outlives the server's bounded wait answers `running` and
 * finishes detached (a later reload shows the Media copy row).
 * @returns {HTMLButtonElement}
 */
const render_media_copy = (self, host, parent, body_response, agent_blocked) => {
	const label = get_label.publication_hosts_reconcile_media_copy || 'Reconcile media copy';
	const button = action_button(parent, 'button_reconcile_media_copy', label, agent_blocked);
	button.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button,
			body_response: body_response,
			action: 'reconcile_media_copy',
			options: { name: host.name },
			result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
			confirm_text: confirm_text(label, host.name),
			reload: true,
		});
	});

	return button;
}; //end render_media_copy

/**
 * RENDER_PROBE_PUBLIC
 * Root: prove this host's media gate through its PUBLIC URL now (phase 6) —
 * the published probe file must answer 2xx, the unpublished one 404. It dials
 * no agent (two bounded GETs through the engine's public door), so it is never
 * disabled by an unproved pairing, and it changes nothing on the host: no
 * confirm. The server's sentence is shown as TEXT; the reload repaints the
 * Public gate row from the recorded verdict.
 * @returns {HTMLButtonElement}
 */
const render_probe_public = (self, host, parent, body_response) => {
	const label = get_label.publication_hosts_probe_public || 'Probe public gate';
	const button = action_button(parent, 'button_probe_public', label, false);
	button.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button,
			body_response: body_response,
			action: 'probe_public',
			options: { name: host.name },
			result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
			confirm_text: null, // an observation: nothing on the host changes
			reload: true,
		});
	});

	return button;
}; //end render_probe_public

/**
 * RENDER_ROLLBACK
 * API select (only an API with a previous release is selectable) + button.
 */
const render_rollback = function (self, host, parent, body_response, agent_blocked) {
	const apis = host.apis || {};
	const rollback_label = get_label.publication_hosts_rollback_api || 'Roll back API';

	const select = ui.create_dom_element({
		element_type: 'select',
		class_name: 'host_rollback_select',
		name: 'rollback_api',
		aria: { label: rollback_label },
		parent: parent,
	});
	let selectable = false;
	for (const api of ['v1', 'v2']) {
		const release = apis[api] || {};
		const option = ui.create_dom_element({
			element_type: 'option',
			text_content: `${api}: ${release.current || '—'} → ${release.previous || '—'}`,
			parent: select,
		});
		option.value = api;
		option.disabled = !release.previous;
		if (release.previous && !selectable) {
			option.selected = true;
			selectable = true;
		}
	}

	const button = action_button(
		parent,
		'button_rollback_api',
		rollback_label,
		agent_blocked || !selectable,
	);
	button.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button,
			body_response: body_response,
			action: 'rollback_api',
			options: { name: host.name, api: select.value },
			confirm_text: confirm_text(rollback_label, `${host.name} ${select.value}`),
			reload: true,
		});
	});

	return select;
}; //end render_rollback

/**
 * RENDER_EDIT_FORM
 * The fields the panel may edit (E4): public URL, public qualities, probe
 * files, prefilled from the row's `public_url`, `qualities` and `probe`. Never
 * the address, the instance or any secret.
 */
const render_edit_form = function (self, host, card, body_response) {
	const details = ui.create_dom_element({
		element_type: 'details',
		class_name: 'dd_fold host_edit',
		parent: card,
	});
	ui.create_dom_element({
		element_type: 'summary',
		text_content: get_label.publication_hosts_edit || 'Edit settings',
		parent: details,
	});
	const fields = ui.create_dom_element({
		element_type: 'div',
		class_name: 'host_edit_fields',
		parent: details,
	});

	const probe = host.probe || {};
	const inputs = {
		public_url: field(
			fields,
			'public_url',
			get_label.publication_hosts_public_url || 'Public URL',
			host.public_url,
		),
		qualities: field(
			fields,
			'qualities',
			get_label.publication_hosts_qualities || 'Public qualities',
			Array.isArray(host.qualities) ? host.qualities.join(', ') : '',
		),
		probe_published: field(
			fields,
			'probe_published',
			get_label.publication_hosts_probe_published || 'Probe file (published)',
			probe.published,
		),
		probe_unpublished: field(
			fields,
			'probe_unpublished',
			get_label.publication_hosts_probe_unpublished || 'Probe file (unpublished)',
			probe.unpublished,
		),
	};

	const button_save = action_button(
		fields,
		'button_apply button_save_host',
		get_label.save || 'Save',
		false,
	);
	button_save.addEventListener('click', async (e) => {
		e.stopPropagation();
		await run_action(self, {
			button: button_save,
			body_response: body_response,
			action: 'set_host_fields',
			options: read_host_fields(host.name, inputs),
			confirm_text: null,
			reload: true,
		});
	});

	return details;
}; //end render_edit_form

/**
 * FIELD
 * A labelled text input (the label wraps the input: named by construction).
 * @returns {HTMLInputElement}
 */
const field = function (parent, name, label_text, value) {
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
		element_type: 'input',
		type: 'text',
		name: name,
		parent: label_node,
	});
	input.value = value === null || value === undefined ? '' : String(value);

	return input;
}; //end field

/**
 * READ_HOST_FIELDS
 * set_host_fields options from the edit inputs. A blank field is null: a null
 * public_url is "not set yet", null qualities are "the engine's public
 * qualities", a null probe file is "not provisioned".
 * @param {string} name
 * @param {{public_url, qualities, probe_published, probe_unpublished}} inputs
 * @returns {Object}
 */
export const read_host_fields = function (name, inputs) {
	const text = (input) => String(input.value || '').trim();
	const qualities = text(inputs.qualities)
		.split(',')
		.map((quality) => quality.trim())
		.filter((quality) => quality.length > 0);

	return {
		name: name,
		public_url: text(inputs.public_url) || null,
		qualities: qualities.length > 0 ? qualities : null,
		probe: {
			published: text(inputs.probe_published) || null,
			unpublished: text(inputs.probe_unpublished) || null,
		},
	};
}; //end read_host_fields

/**
 * PUSH_APIS
 * Root: push the installed tree's verified Publication API releases (v2, then v1)
 * to every paired host — confirm-gated (it installs code on public machines), one
 * request, the server's sentence shown (it names a refusal or each failed host and
 * API), then the value reloads so every row shows its new last push. A round that
 * outlives the server's bounded wait answers `running` (its sentence says so) and
 * finishes detached; a later reload shows its outcome.
 * @returns {Promise<boolean>}
 */
const push_apis = function (self, panel, button, body_response) {
	const release = panel.engine_release || 'the verified release of this tree';
	return run_action(self, {
		button: button,
		body_response: body_response,
		action: 'push_apis',
		options: {},
		heading: 'Publication APIs · push_apis\n',
		result_text: (api_response) => String(response_extension(api_response, 'msg') || ''),
		confirm_text: `${get_label.sure || 'Are you sure?'}\nPush Publication API ${release} (v2, then v1) to every paired host`,
		reload: true,
	});
}; //end push_apis

/**
 * RUN_ACTION
 * The ONE action path: confirm (when asked) → spinner → request → outcome
 * shown in body_response (as TEXT) → reload only on success. A failure goes
 * through handle_api_error (the one client error model) and is never silent.
 * @param {Object} self - the widget instance
 * `spec.heading` / `spec.result_text(api_response)` override the outcome's
 * first line and body (push_apis has no host name and shows the server sentence).
 * @param {{button, body_response, action, options, confirm_text, reload, heading?, result_text?}} spec
 * @returns {Promise<boolean>} true on success
 */
export const run_action = async function (self, spec) {
	if (spec.confirm_text && self.confirm_action(spec.confirm_text) !== true) {
		return false;
	}

	const heading = spec.heading || `${spec.options.name} · ${spec.action}\n`;
	// shown now AND kept on the instance: the reload rebuilds content_data, and
	// its new body_response repaints this text (get_content_data)
	const show = (text) => {
		self.last_outcome = heading + text;
		spec.body_response.textContent = self.last_outcome;
	};
	spec.button.classList.add('button_spinner');
	try {
		const api_response = await self.widget_request(spec.action, spec.options);
		if (request_failed(api_response)) {
			show(error_text(api_response.error));
			await handle_api_error(api_response.error, { wrapper: spec.body_response });
			return false;
		}
		show(
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
		show(error_text(error));
		return false;
	} finally {
		spec.button.classList.remove('button_spinner');
	}
}; //end run_action

// @license-end
