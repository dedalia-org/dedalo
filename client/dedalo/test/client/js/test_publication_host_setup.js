// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, afterEach, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_PUBLICATION_HOST_SETUP
 * "New publication host" in the publication_hosts widget (render_new_host.js;
 * server: src/core/area_maintenance/widgets/publication_host_setup.ts).
 *
 * What it pins:
 *  - the section renders for ROOT only and only when the value carries
 *    drafts_state (the server sends drafts to root alone); a corrupt drafts
 *    file is a LOUD note, never an empty list;
 *  - each draft card shows its state (awaiting / paired as), its listener,
 *    its kit sha256; Build kit, Download kit (disabled until a kit exists),
 *    Remove draft (confirm-gated); the pairing upload exists only for an
 *    awaiting TWO-machine draft and takes no address;
 *  - Propose fills the form from the server's proposal; Save sends EXACTLY
 *    the draft keys (no engine group on two machines, no v1 block on v2-only,
 *    no address on one machine); a refusal marks the inputs its
 *    details.fields names and shows the label AND the sentence;
 *  - the pairing upload sends the package as base64 + the passphrase in one
 *    request and clears the passphrase input whatever the answer;
 *  - Download hands the decoded kit bytes to save_file under the kit's name
 *    and shows its sha256.
 *
 *  - ONE MACHINE FIRST (spec §1.1): the topology question is asked by where
 *    the public website runs, THIS server (another vhost) being the default;
 *    an awaiting one-machine draft shows the server's install block as TEXT
 *    (copyable) with the kit folded under it; a two-machine draft keeps the
 *    kit + package path unfolded;
 *  - FIRST USE (docs step 10): a paired draft offers one action that chains
 *    apply_rules → push_apis (that one host) → probe_public, confirm-gated,
 *    each step's outcome shown, a failed step not stopping the next, one
 *    reload at the end.
 *
 * Backend-free: widget_request / confirm_action / reload / save_file are
 * replaced on the INSTANCE.
 */

import { publication_hosts } from '../../../core/area_maintenance/widgets/publication_hosts/js/publication_hosts.js';
import {
	base64_to_bytes,
	bytes_to_base64,
	FIRST_USE_STEPS,
	read_draft_form,
	run_first_use,
} from '../../../core/area_maintenance/widgets/publication_hosts/js/render_new_host.js';
import { ApiError } from '../../../core/common/js/api_error.js';
import { debug_redacted } from '../../../core/common/js/data_manager.js';

const container = document.getElementById('content');
const mounted = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const DRAFT = Object.freeze({
	instance: 'museum_org',
	layout: 'home',
	apis: 'v2_only',
	listen: { kind: 'tls', host: '10.20.0.2', port: 8471 },
	agent_user: 'museum_org_agent',
	web: { server: 'apache' },
	site: { domain: 'museum.org' },
	media: { mode: 'copy', root: '/srv/pub/museum_org' },
	v2: { unit: 'dedalo-publication-api-v2-museum_org', user: 'museum_org_v2', port: 3100 },
});

const draft_row = (overrides = {}) =>
	Object.assign(
		{
			name: 'museum_org',
			created_at: '2026-10-09T00:00:00.000Z',
			draft: DRAFT,
			state: 'awaiting',
			paired_as: null,
			kit: null,
			install: null,
		},
		overrides,
	);

const ONE_MACHINE_DRAFT = Object.freeze(
	Object.assign({}, DRAFT, {
		listen: { kind: 'unix' },
		engine_group: 'dedalo',
		media: { mode: 'shared', root: '/srv/dedalo/media' },
	}),
);

/**
 * Run `fn` with `navigator.clipboard` replaced by `stub` (an own property shadowing the
 * prototype getter), restored afterwards whatever happens — so the copy button's two
 * branches each have an outcome the test can see.
 */
const with_clipboard = async function (stub, fn) {
	const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: stub });
	try {
		await fn();
	} finally {
		if (own) Object.defineProperty(navigator, 'clipboard', own);
		else delete navigator.clipboard;
	}
};

const INSTALL_COMMAND =
	"# On THIS server, as root.\n(umask 077 && cat > /root/museum_org.draft.json) <<'DEDALO_PUBLICATION_HOST_DRAFT'\n{\"instance\": \"<script>x</script>\"}\nDEDALO_PUBLICATION_HOST_DRAFT\nsh /opt/dedalo/master_dedalo/publication/host_agent/deploy/install.sh museum_org --source /opt/dedalo/master_dedalo --draft /root/museum_org.draft.json\n";
const one_machine_row = (overrides = {}) =>
	draft_row(
		Object.assign(
			{
				draft: ONE_MACHINE_DRAFT,
				install: {
					source: '/opt/dedalo/master_dedalo',
					draft_file: '/root/museum_org.draft.json',
					agent_deps: true,
					command: INSTALL_COMMAND,
				},
			},
			overrides,
		),
	);

const value = (drafts, extra = {}) =>
	Object.assign(
		{
			registry: { state: 'ok', reason: null },
			registry_path: '/srv/dedalo/private/publication_hosts.json',
			engine_qualities: [],
			is_root: true,
			hosts: [],
			drafts_state: 'ok',
			drafts: drafts,
		},
		extra,
	);

const build_widget = (widget_value) => {
	const self = new publication_hosts();
	self.id = 'publication_hosts';
	self.value = widget_value;
	self.caller = null;
	self.events_tokens = [];
	self.calls = [];
	self.reloads = 0;
	self.confirms = [];
	self.saved = [];
	self.next_response = { ok: true, data: null, msg: 'OK.' };
	self.confirm_action = (message) => {
		self.confirms.push(message);
		return true;
	};
	self.reload = async () => {
		self.reloads++;
	};
	self.save_file = (blob, name) => {
		self.saved.push({ blob, name });
	};
	self.widget_request = async (action, options) => {
		self.calls.push({ action: action, options: options });
		return typeof self.next_response === 'function'
			? self.next_response(action, options)
			: self.next_response;
	};
	return self;
};

const mount = async (self) => {
	const content_data = await self.list({ render_level: 'content' });
	container.appendChild(content_data);
	mounted.push(content_data);
	return content_data;
};

const inputs_of = (content) => {
	const inputs = {};
	for (const node of content.querySelectorAll('.new_host_form [data-field]')) {
		inputs[node.dataset.field] = node;
	}
	return inputs;
};

describe('PUBLICATION HOST SETUP (New publication host)', function () {
	this.timeout(10000);

	afterEach(() => {
		while (mounted.length) {
			mounted.pop().remove();
		}
	});

	it('renders for root only, and only when the server sent drafts', async () => {
		const root = await mount(build_widget(value([])));
		assert.ok(root.querySelector('.new_publication_host'), 'root sees the section');
		const admin = await mount(build_widget(value([], { is_root: false })));
		assert.isNull(admin.querySelector('.new_publication_host'), 'a non-root admin sees none');
		// an older server: the value carries no drafts_state key at all
		const { drafts_state: _absent, ...older_value } = value([]);
		const none = await mount(build_widget(older_value));
		assert.isNull(none.querySelector('.new_publication_host'), 'no drafts_state, no section');
	});

	it('a corrupt drafts file is a loud note, never an empty list', async () => {
		const content = await mount(build_widget(value(null, { drafts_state: 'drafts_invalid' })));
		const note = content.querySelector('.drafts_invalid');
		assert.ok(note, 'the note renders');
		assert.isTrue(note.classList.contains('state_danger'));
		assert.strictEqual(content.querySelectorAll('.publication_host_draft').length, 0);
	});

	it('a draft card: state, listener, kit sha; download disabled until a kit exists; pairing only for an awaiting two-machine draft', async () => {
		const content = await mount(build_widget(value([draft_row()])));
		const card = content.querySelector('.publication_host_draft');
		assert.ok(card);
		assert.include(card.textContent, '10.20.0.2:8471');
		assert.isTrue(card.querySelector('.button_download_kit').disabled, 'no kit, no download');
		assert.isFalse(card.querySelector('.button_build_kit').disabled);
		assert.ok(card.querySelector('.pair_package input[type="file"]'), 'the package input');
		assert.strictEqual(
			card.querySelector('.pair_package input[name="pairing_passphrase"]').type,
			'password',
		);
		assert.isNull(
			card.querySelector('.pair_package input[name*="address"], .pair_package input[name*="host"]'),
			'no address input',
		);

		const sha = 'c'.repeat(64);
		const built = await mount(
			build_widget(
				value([
					draft_row({
						kit: { sha256: sha, release: '7.0.1_abcdef0', file_name: 'k.tar.gz', size: 3 },
					}),
				]),
			),
		);
		assert.include(
			built.querySelector('.publication_host_draft').textContent,
			sha,
			'the kit sha256 is shown',
		);
		assert.isFalse(built.querySelector('.button_download_kit').disabled);

		const one = await mount(
			build_widget(
				value([
					draft_row({
						draft: Object.assign({}, DRAFT, { listen: { kind: 'unix' }, engine_group: 'dedalo' }),
					}),
				]),
			),
		);
		assert.isNull(
			one.querySelector('.pair_package'),
			'a one-machine draft pairs itself during init',
		);
		const paired = await mount(
			build_widget(value([draft_row({ state: 'paired', paired_as: 'museum_org' })])),
		);
		assert.isNull(paired.querySelector('.pair_package'), 'a paired draft has no upload');
		assert.isTrue(paired.querySelector('.button_build_kit').disabled);
	});

	it('Propose fills the form; Save sends exactly the draft keys', async () => {
		const self = build_widget(value([]));
		const content = await mount(self);
		const inputs = inputs_of(content);
		inputs['site.domain'].value = 'museum.org';
		inputs['listen.kind'].value = 'tls';
		inputs['listen.kind'].dispatchEvent(new Event('change'));
		inputs['listen.host'].value = '10.20.0.2';
		self.next_response = { ok: true, data: { name: 'museum_org', draft: DRAFT } };
		content.querySelector('.button_propose_draft').click();
		await settle();
		assert.deepEqual(self.calls[0], {
			action: 'propose_draft',
			options: { domain: 'museum.org', machines: 'two', listen_host: '10.20.0.2', apis: 'v2_only' },
		});
		assert.strictEqual(inputs.instance.value, 'museum_org');
		assert.strictEqual(inputs['v2.port'].value, '3100');
		assert.strictEqual(inputs['media.root'].value, '/srv/pub/museum_org');

		self.next_response = { ok: true, data: { name: 'museum_org' }, msg: 'OK. Draft saved.' };
		content.querySelector('.button_save_draft').click();
		await settle();
		const save = self.calls[1];
		assert.strictEqual(save.action, 'save_draft');
		assert.deepEqual(
			save.options,
			{ name: 'museum_org', draft: DRAFT },
			'the draft round-trips: two machines carry no engine group, v2-only no v1',
		);
		assert.strictEqual(self.reloads, 1);
	});

	it('read_draft_form: one machine sends the group and no address; v1 + v2 sends the v1 user; none sends no root', () => {
		const field = (v) => ({ value: v });
		const inputs = {
			name: field('a_b'),
			instance: field('a_b'),
			'site.domain': field('a.b'),
			'listen.kind': field('unix'),
			'listen.host': field('10.0.0.1'),
			'listen.port': field('8471'),
			'web.server': field('nginx'),
			apis: field('v1_and_v2'),
			'v1.user': field('a_b_v1'),
			'media.mode': field('none'),
			'media.root': field('/x'),
			layout: field('system'),
			agent_user: field('a_b_agent'),
			engine_group: field('dedalo'),
			'v2.user': field('a_b_v2'),
			'v2.unit': field('u'),
			'v2.port': field('3101'),
		};
		const { draft } = read_draft_form(inputs);
		assert.deepEqual(draft.listen, { kind: 'unix' });
		assert.strictEqual(draft.engine_group, 'dedalo');
		assert.deepEqual(draft.v1, { user: 'a_b_v1' });
		assert.deepEqual(draft.media, { mode: 'none' });
		assert.strictEqual(draft.v2.port, 3101);
	});

	it('a refused save marks the named fields and shows the label and the sentence', async () => {
		const self = build_widget(value([]));
		const content = await mount(self);
		const inputs = inputs_of(content);
		self.next_response = {
			ok: false,
			error: new ApiError({
				code: 'publication_host_setup.draft_invalid',
				status: 400,
				label_key: 'error_publication_host_setup_draft_invalid',
				message: 'Error. The draft was refused:\nv2.port: v2.port 3100 — also used by instance x',
				details: { fields: 'v2.port,agent_user' },
				category: 'caller',
				retryable: false,
				source: 'envelope',
			}),
		};
		content.querySelector('.button_save_draft').click();
		await settle();
		assert.isTrue(inputs['v2.port'].classList.contains('field_error'));
		assert.isTrue(inputs.agent_user.classList.contains('field_error'));
		assert.isFalse(inputs.instance.classList.contains('field_error'));
		assert.strictEqual(inputs['v2.port'].getAttribute('aria-invalid'), 'true');
		const console_text = content.querySelector('.body_response').textContent;
		assert.include(console_text, 'also used by instance x', 'the sentence');
		assert.strictEqual(self.reloads, 0, 'no reload on a refusal');
	});

	it('the upload sends base64 + passphrase in one request and clears the passphrase whatever the answer', async () => {
		const self = build_widget(value([draft_row()]));
		const content = await mount(self);
		const card = content.querySelector('.publication_host_draft');
		const file_input = card.querySelector('.pair_package input[type="file"]');
		const bytes = new Uint8Array([0x44, 0x44, 0x50, 0x48, 0x50, 0x41, 0x49, 0x52, 1, 2, 3]);
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], 'museum_org.pairing'));
		file_input.files = transfer.files;
		const pass = card.querySelector('input[name="pairing_passphrase"]');
		pass.value = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01';
		self.next_response = {
			ok: false,
			error: new ApiError({
				code: 'publication_host_setup.pairing_refused',
				status: 400,
				label_key: 'error_publication_host_setup_pairing_refused',
				message: 'Error. The passphrase is wrong, or the package was altered.',
				details: { reason: 'package_auth' },
				category: 'caller',
				retryable: false,
				source: 'envelope',
			}),
		};
		card.querySelector('.button_pair_package').click();
		await settle();
		await settle();
		assert.strictEqual(self.calls.length, 1);
		assert.deepEqual(self.calls[0], {
			action: 'pair_package',
			options: {
				name: 'museum_org',
				package_base64: bytes_to_base64(bytes),
				passphrase: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01',
			},
		});
		assert.strictEqual(pass.value, '', 'the passphrase input is cleared');
		assert.strictEqual(self.confirms.length, 1, 'confirm-gated');
		assert.strictEqual(self.reloads, 0);
		// no file: nothing sent
		file_input.files = new DataTransfer().files;
		pass.value = 'x';
		card.querySelector('.button_pair_package').click();
		await settle();
		assert.strictEqual(self.calls.length, 1);
		assert.strictEqual(pass.value, '');
	});

	it('the debug request line never carries the passphrase or the package — nor any options value (data_manager debug_redacted)', () => {
		const merged = {
			body: {
				action: 'widget_request',
				options: { name: 'a', passphrase: 'P', package_base64: 'QUJD' },
			},
		};
		const shown = debug_redacted(merged);
		assert.strictEqual(shown.body.options.passphrase, '[redacted]');
		assert.strictEqual(shown.body.options.package_base64, '[redacted]');
		assert.strictEqual(
			shown.body.options.name,
			'[redacted]',
			'every value: no list of secret names to rot',
		);
		assert.deepEqual(
			Object.keys(shown.body.options),
			['name', 'passphrase', 'package_base64'],
			'the key names stay',
		);
		assert.strictEqual(merged.body.options.passphrase, 'P', 'the request itself is unchanged');
	});

	it('the topology question asks where the public website runs; THIS server is the default and proposes one machine', async () => {
		const self = build_widget(value([]));
		const content = await mount(self);
		const inputs = inputs_of(content);
		const select = inputs['listen.kind'];
		assert.strictEqual(select.value, 'unix', 'the default is one machine');
		assert.strictEqual(select.options[0].value, 'unix');
		const label_text = select.closest('label').textContent;
		// lang-neutral: the suite renders in its application lang (get_label), English is the fallback
		const lbl = window.get_label || {};
		assert.include(
			label_text,
			lbl.publication_hosts_draft_machines || 'Where the public website runs',
			'asked by what the operator knows',
		);
		assert.include(
			select.options[0].textContent,
			lbl.publication_hosts_draft_machines_one || 'On this server (another vhost)',
		);
		assert.include(
			select.options[1].textContent,
			lbl.publication_hosts_draft_machines_two || 'On another server (mTLS over a private network)',
		);
		inputs['site.domain'].value = 'museum.org';
		self.next_response = { ok: true, data: { name: 'museum_org', draft: ONE_MACHINE_DRAFT } };
		content.querySelector('.button_propose_draft').click();
		await settle();
		assert.strictEqual(self.calls[0].options.machines, 'one');
	});

	it('an awaiting one-machine draft shows the install block as text (copyable), the kit folded; no package upload', async () => {
		const self = build_widget(value([one_machine_row()]));
		const content = await mount(self);
		const card = content.querySelector('.publication_host_draft');
		const pre = card.querySelector('.one_machine_install pre.one_machine_command');
		assert.ok(pre, 'the block renders');
		assert.strictEqual(pre.textContent, INSTALL_COMMAND, 'exactly the server text');
		assert.isNull(pre.querySelector('script'), 'set as TEXT, never markup');
		assert.strictEqual(
			card.querySelector('.one_machine_install_note').textContent,
			(window.get_label || {}).publication_hosts_install_here_note ||
				'Run this block on this server, as root. The host pairs itself during the install: no kit and no package are needed. Once paired, this draft shows it.',
		);
		const fold = card.querySelector('details.kit_fold');
		assert.ok(fold, 'the kit stays available, folded');
		assert.isFalse(fold.open);
		assert.ok(fold.querySelector('.button_build_kit'));
		assert.ok(fold.querySelector('.button_download_kit'));
		assert.isNull(card.querySelector('.pair_package'), 'init pairs itself: no upload');
		assert.ok(card.querySelector('.button_remove_draft'));
		// copy, BOTH branches pinned to an outcome that can fail (a no-op button, a
		// dropped listener or a throw before writeText would leave the selection empty
		// AND the clipboard untouched): the clipboard takes exactly the block ...
		const written = [];
		await with_clipboard(
			{ writeText: async (text) => { written.push(text); } },
			async () => {
				window.getSelection().removeAllRanges();
				card.querySelector('.button_copy_command').click();
				await settle();
			},
		);
		assert.deepEqual(written, [INSTALL_COMMAND], 'the clipboard received exactly the server text');
		// ... and where the browser refuses it, the block is SELECTED for Ctrl+C.
		await with_clipboard(
			{ writeText: async () => { throw new Error('NotAllowedError'); } },
			async () => {
				window.getSelection().removeAllRanges();
				card.querySelector('.button_copy_command').click();
				await settle();
			},
		);
		// Range.toString = the selected Text data verbatim; Selection.toString is the
		// layout-rendered text and drops the <pre>'s final newline
		const selection = window.getSelection();
		assert.strictEqual(selection.rangeCount, 1, 'refused clipboard: one range selected');
		assert.strictEqual(
			selection.getRangeAt(0).toString(),
			INSTALL_COMMAND,
			'refused clipboard: exactly the block is selected',
		);
		window.getSelection().removeAllRanges();

		// two machines: the kit is the path, unfolded, with the package upload
		const two = await mount(build_widget(value([draft_row()])));
		const two_card = two.querySelector('.publication_host_draft');
		assert.isNull(two_card.querySelector('.one_machine_install'));
		assert.isNull(two_card.querySelector('details.kit_fold'));
		assert.ok(two_card.querySelector('.host_actions > .button_build_kit'));
		// paired: no block, no fold
		const paired = await mount(
			build_widget(
				value([one_machine_row({ state: 'paired', paired_as: 'museum_org', install: null })]),
			),
		);
		assert.isNull(paired.querySelector('.one_machine_install'));
		assert.isNull(paired.querySelector('details.kit_fold'));
	});

	it('FIRST USE: only a paired draft offers it; it chains rules → push (that host) → probe, shows each outcome, reloads once', async () => {
		const awaiting = await mount(build_widget(value([one_machine_row()])));
		assert.isNull(awaiting.querySelector('.button_first_use'), 'not before the pairing');

		const self = build_widget(
			value([draft_row({ state: 'paired', paired_as: 'museum_www', install: null })]),
		);
		const content = await mount(self);
		const button_first = content.querySelector('.button_first_use');
		assert.ok(button_first, 'a paired draft offers First use');
		self.next_response = (action) => {
			if (action === 'apply_rules') {
				return {
					ok: false,
					error: new ApiError({
						code: 'maintenance.action_refused',
						status: 400,
						label_key: 'error_maintenance_action_refused',
						message: "Error. Host 'museum_www' reports media mode 'none'.",
						details: {},
						category: 'caller',
						retryable: false,
						source: 'envelope',
					}),
				};
			}
			if (action === 'push_apis') {
				return { ok: true, data: true, msg: 'OK. Release 7.0.1_abcdef0 is current on 1 publication host(s).', running: false };
			}
			return {
				ok: true,
				data: { state: 'unknown', detail: 'the public URL is not set' },
				msg: "Warning. 'museum_www': the public URL is not set",
			};
		};
		button_first.click();
		await settle();
		await settle();
		assert.deepEqual(
			self.calls.map((call) => [call.action, call.options]),
			[
				['apply_rules', { name: 'museum_www' }],
				['push_apis', { hosts: ['museum_www'] }],
				['probe_public', { name: 'museum_www' }],
			],
			'the docs step 10 order, against the host the draft is paired as',
		);
		assert.strictEqual(self.confirms.length, 1, 'one confirm for the chain');
		assert.strictEqual(self.reloads, 1, 'one reload at the end');
		const text = content.querySelector('.body_response').textContent;
		assert.include(text, "reports media mode 'none'", 'the failed step: its sentence');
		assert.include(text, 'Release 7.0.1_abcdef0', 'a failed step does not stop the next');
		assert.include(text, 'the public URL is not set', 'the probe verdict');
	});

	it('run_first_use: step states read each answer; declined = nothing sent', async () => {
		assert.deepEqual(
			FIRST_USE_STEPS.map((step) => step.action),
			['apply_rules', 'push_apis', 'probe_public'],
		);
		const self = build_widget(value([]));
		const console_node = document.createElement('div');
		self.next_response = (action) => {
			if (action === 'push_apis') return { ok: true, data: null, msg: 'Push started', running: true };
			if (action === 'probe_public') return { ok: true, data: { state: 'failed' }, msg: 'Error.' };
			return { ok: true, data: { host: 'h' }, msg: 'OK. Media rules applied.' };
		};
		const outcomes = await run_first_use(self, 'pub_a', console_node, null);
		assert.deepEqual(
			outcomes.map((o) => [o.action, o.state]),
			[
				['apply_rules', 'ok'],
				['push_apis', 'running'],
				['probe_public', 'failed'],
			],
		);
		assert.include(console_node.textContent, 'Running · ');

		const declined = build_widget(value([]));
		declined.confirm_action = () => false;
		assert.isNull(await run_first_use(declined, 'pub_a', console_node, null));
		assert.strictEqual(declined.calls.length, 0);
		assert.strictEqual(declined.reloads, 0);
	});

	it('Download hands the decoded kit to save_file under its name and shows the sha256', async () => {
		const sha = 'd'.repeat(64);
		const self = build_widget(
			value([draft_row({ kit: { sha256: sha, release: 'r', file_name: 'kit.tar.gz', size: 3 } })]),
		);
		const content = await mount(self);
		const payload = new Uint8Array([1, 2, 250]);
		self.next_response = {
			ok: true,
			data: {
				sha256: sha,
				file_name: 'dedalo_publication_host_kit_museum_org.tar.gz',
				kit_base64: bytes_to_base64(payload),
			},
		};
		content.querySelector('.button_download_kit').click();
		await settle();
		assert.strictEqual(self.saved.length, 1);
		assert.strictEqual(self.saved[0].name, 'dedalo_publication_host_kit_museum_org.tar.gz');
		const got = new Uint8Array(await self.saved[0].blob.arrayBuffer());
		assert.deepEqual(Array.from(got), Array.from(payload));
		assert.include(content.querySelector('.body_response').textContent, sha);
		assert.deepEqual(Array.from(base64_to_bytes(bytes_to_base64(payload))), Array.from(payload));
	});
});

// @license-end
