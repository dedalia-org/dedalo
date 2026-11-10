// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, afterEach, assert */
/*eslint no-undef: "error"*/

/**
 * TEST_PUBLICATION_HOSTS
 * The publication_hosts maintenance widget (PUBLICATION_HOST_SPEC phase 3) and
 * media_control's one line pointing at it.
 *
 * What it pins:
 *  - a registry the server could not use (registry_invalid, or no registry
 *    block at all; hosts: null) is a LOUD state (reason shown — the server's
 *    registry.check row through check_row when sent — no card, no control),
 *    never an empty list;
 *  - every server string renders as TEXT (addresses and URLs are operator data);
 *  - check rows are labelled through check_row's `publication_hosts` prefix,
 *    and check_row's default prefix is unchanged for update_code / serve_code;
 *  - controls exist only for root; agent commands are disabled while the
 *    pairing is not proved; every agent-changing action is confirm-gated, shows
 *    the spinner while in flight, reports its outcome, and reloads only on success;
 *  - after a success the REAL reload path (get_value → refresh) repaints the
 *    fresh state and the outcome survives the repaint;
 *  - a held registry lock (a failed read answering publication_host.busy, or a
 *    registry_locked state) reads as BUSY — transient, retryable — never as
 *    "invalid, repair it"; any other failed read shows its own error;
 *  - a non-root row (address withheld by the server) shows no Address fact;
 *  - the host-wide nginx media map (provision init §13.4): a managed row shows
 *    expected/applied/shared hashes and the instance count; its STATE is the
 *    server's `nginx_map` check rendered like every check (drift red, ok green,
 *    `unmanaged` ok) — the client derives none of it; an Apache row
 *    (nginx_map null, no check) shows none of it;
 *  - the edit form is prefilled from the row's qualities/probe; set_host_fields
 *    sends null for a blank field (= engine default);
 *  - media_control's line asks the dashboard to open publication_hosts, and the
 *    System Map's listener (the RECEIVE half) opens it — and ignores an
 *    unknown id or a map no longer in the document.
 *
 * The fixtures follow the Task 7 panel wire ({registry:{state,reason},
 * registry_path, engine_qualities, is_root, hosts}) and its action answers
 * ({host, …}).
 *
 * Backend-free: widget_request / confirm_action / reload are replaced on the
 * INSTANCE, so no request, no native dialog (a blocking confirm() freezes the
 * headless renderer) and no get_value round-trip.
 */

import { OPEN_WIDGET_EVENT } from '../../../core/area_maintenance/js/maintenance_events.js';
import { build_map_view } from '../../../core/area_maintenance/js/render_area_maintenance.js';
import { media_control } from '../../../core/area_maintenance/widgets/media_control/js/media_control.js';
import { publication_hosts } from '../../../core/area_maintenance/widgets/publication_hosts/js/publication_hosts.js';
import { read_host_fields } from '../../../core/area_maintenance/widgets/publication_hosts/js/render_publication_hosts.js';
import { check_row } from '../../../core/area_maintenance/widgets/update_code/js/render_update_status.js';
import { ApiError, CLIENT_ERROR } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { error_text } from '../../../core/common/js/render_api_error.js';

// DOM container
const container = document.getElementById('content');

// helpers
const mounted = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
/** Poll until `probe` returns a truthy value (the real reload repaints at idle priority). */
const until = async (probe, ms = 4000) => {
	const end = Date.now() + ms;
	for (;;) {
		const found = probe();
		if (found) return found;
		if (Date.now() > end) throw new Error('until: the condition never held');
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};
const labels = () => window.get_label || {};

const build_host = (overrides = {}) =>
	Object.assign(
		{
			name: 'www',
			address_label: 'https://pub.example.test:8443',
			public_url: 'https://www.example.test',
			qualities: ['1.5MB', 'web'],
			probe: { published: 'image/web/0/probe_published.jpg', unpublished: null },
			checks: [
				{ id: 'registry', state: 'ok' },
				{ id: 'secrets', state: 'ok' },
				{ id: 'reachable', state: 'ok' },
				{ id: 'pairing', state: 'ok' },
				{ id: 'rules_hash', state: 'blocked', detail: 'expected != reported' },
			],
			rules: { expected: 'a'.repeat(64), reported: 'b'.repeat(64) },
			apis: {
				v1: { current: '7.0.1_abcdef0', previous: '7.0.0_1234567' },
				v2: { current: '7.0.1_abcdef0', previous: null },
			},
			token_present: true,
			bundle_present: true,
			pairing_proved: true,
		},
		overrides,
	);

const panel_value = (registry, hosts, is_root = true) => ({
	registry: registry,
	registry_path: '/srv/dedalo/private/publication_hosts.json',
	engine_qualities: ['1.5MB', 'web'],
	is_root: is_root,
	hosts: hosts,
});

const ok_value = (hosts, is_root = true) =>
	panel_value({ state: 'ok', reason: null }, hosts, is_root);

const build_widget = (value) => {
	const self = new publication_hosts();
	self.id = 'publication_hosts';
	self.value = value;
	self.caller = null;
	self.events_tokens = [];
	// test doubles ON THE INSTANCE (the prototype stays the real one)
	self.calls = [];
	self.reloads = 0;
	self.confirms = [];
	self.confirm_answer = true;
	self.next_response = { ok: true, data: { host: 'www' } };
	self.confirm_action = (message) => {
		self.confirms.push(message);
		return self.confirm_answer;
	};
	self.reload = async () => {
		self.reloads++;
	};
	self.widget_request = async (action, options) => {
		self.calls.push({ action: action, options: options });
		return self.next_response;
	};
	return self;
};

const mount = async (self) => {
	const content_data = await self.list({ render_level: 'content' });
	container.appendChild(content_data);
	mounted.push(content_data);
	return content_data;
};

describe('PUBLICATION_HOSTS WIDGET', function () {
	this.timeout(10000);

	afterEach(function () {
		while (mounted.length) {
			mounted.pop().remove();
		}
	});

	describe('readout', function () {
		it('a registry the server could not read is a loud state: reason shown, no card, no control', async function () {
			const self = build_widget(
				panel_value({ state: 'registry_invalid', reason: 'invalid_json' }, null),
			);
			const content = await mount(self);

			const note = content.querySelector('.registry_invalid');
			assert.ok(note, 'the invalid-registry note renders');
			assert.isTrue(
				note.classList.contains('state_danger'),
				'it is a danger note, not a quiet one',
			);
			assert.include(note.textContent, 'invalid_json', 'the reason is shown');
			assert.strictEqual(content.querySelectorAll('.publication_host').length, 0, 'no host card');
			assert.strictEqual(content.querySelectorAll('button').length, 0, 'no control');
		});

		it('the server registry.check row renders through check_row (publication_hosts prefix)', async function () {
			const self = build_widget(
				panel_value(
					{
						state: 'registry_invalid',
						reason: 'invalid_json',
						check: { id: 'registry', state: 'blocked', detail: 'invalid_json' },
					},
					null,
				),
			);
			const content = await mount(self);

			const note = content.querySelector('.registry_invalid');
			assert.ok(note, 'the invalid-registry note renders');
			const row = note.querySelector('.registry_check .check_row.state_blocked');
			assert.ok(row, 'the registry check renders as a blocked check row');
			assert.strictEqual(
				row.querySelector('.dd_k').textContent,
				labels().publication_hosts_check_registry || 'registry',
				'labelled through the publication_hosts prefix',
			);
			assert.include(row.textContent, 'invalid_json', 'its detail (the reason) is shown');
			assert.strictEqual(content.querySelectorAll('button').length, 0, 'no control');
		});

		it('a held registry lock (read answered publication_host.busy) is BUSY, never "invalid": its own sentence, a retry', async function () {
			const self = build_widget(null);
			self.read_error = new ApiError({
				code: 'publication_host.busy',
				status: 409,
				message: 'busy',
				source: 'envelope',
			});
			const content = await mount(self);

			const note = content.querySelector('.registry_busy');
			assert.ok(note, 'the busy note renders');
			assert.strictEqual(
				content.querySelector('.registry_invalid'),
				null,
				'never the invalid note',
			);
			assert.include(
				note.textContent,
				labels().publication_hosts_registry_busy || 'busy',
				'its own transient sentence',
			);
			assert.notInclude(note.textContent, 'repaired', 'it never asks for a repair');
			assert.strictEqual(content.querySelectorAll('.publication_host').length, 0, 'no card');
			let reloads = 0;
			self.reload = async () => {
				reloads++;
			};
			note.querySelector('.button_retry').click();
			await settle();
			assert.strictEqual(reloads, 1, 'retry re-reads the value');
		});

		it('a registry_locked state reads as busy too (never the invalid sentence)', async function () {
			const self = build_widget(panel_value({ state: 'registry_locked', reason: 'locked' }, null));
			const content = await mount(self);

			assert.ok(content.querySelector('.registry_busy'), 'busy note');
			assert.strictEqual(content.querySelector('.registry_invalid'), null, 'not invalid');
		});

		it('any other failed read shows ITS error, never the "registry invalid" sentence', async function () {
			const self = build_widget(null);
			const error = new ApiError({
				code: CLIENT_ERROR.TIMEOUT,
				status: 0,
				message: 'The request timed out',
				source: 'transport',
			});
			self.read_error = error;
			const content = await mount(self);

			const note = content.querySelector('.read_failed');
			assert.ok(note, 'the read-failed note renders');
			assert.include(note.textContent, error_text(error), 'the error is named');
			assert.strictEqual(content.querySelector('.registry_invalid'), null, 'not invalid');
		});

		it('get_value keeps the failed read: data_manager error → value null + read_error', async function () {
			const self = build_widget(null);
			Reflect.deleteProperty(self, 'read_error');
			const error = new ApiError({
				code: 'publication_host.busy',
				status: 409,
				message: 'busy',
				source: 'envelope',
			});
			const original = data_manager.request;
			data_manager.request = async () => ({ ok: false, error: error });
			let value;
			try {
				value = await self.get_value();
			} finally {
				data_manager.request = original;
			}
			assert.isNotOk(value, 'no value from a failed read');
			assert.strictEqual(self.read_error, error, 'the error is kept for the view');
		});

		it('a non-root row (address withheld by the server) shows no Address fact', async function () {
			const host = build_host();
			Reflect.deleteProperty(host, 'address_label');
			const self = build_widget(ok_value([host], false));
			const content = await mount(self);

			const card = content.querySelector('.publication_host');
			assert.notInclude(
				card.textContent,
				labels().publication_hosts_address || 'Address',
				'no "Address: —" that reads as "no address"',
			);
		});

		it('a value with no registry block reads as invalid, never as an empty list', async function () {
			const self = build_widget({ is_root: true, hosts: [] });
			const content = await mount(self);

			assert.ok(content.querySelector('.registry_invalid'), 'missing registry block = invalid');
			assert.strictEqual(
				content.querySelector('.no_hosts'),
				null,
				'never the "no host paired" note',
			);
		});

		it('no paired host says how to pair one, and renders no card', async function () {
			const self = build_widget(ok_value([]));
			const content = await mount(self);

			const note = content.querySelector('.no_hosts');
			assert.ok(note, 'the no-host note renders');
			assert.include(
				note.textContent,
				'dedalo:pair-publication-host',
				'it names the documented pair command',
			);
			assert.include(note.textContent, 'sudo -u', 'run as the engine user, never root');
			assert.strictEqual(content.querySelectorAll('.publication_host').length, 0);
		});

		it('a paired host renders its facts as TEXT and one prefixed check row per check', async function () {
			const hostile = '<img src=x onerror="window.__ph_xss=1">';
			const self = build_widget(ok_value([build_host({ address_label: hostile })]));
			const content = await mount(self);

			const card = content.querySelector('.publication_host[data-name="www"]');
			assert.ok(card, 'one card, keyed by host name');
			assert.strictEqual(
				card.querySelector('img'),
				null,
				'an operator string never parses as HTML',
			);
			assert.include(card.textContent, hostile, 'it is shown verbatim');
			assert.include(card.textContent, 'a'.repeat(64), 'expected rules hash shown');
			assert.include(card.textContent, 'b'.repeat(64), 'reported rules hash shown');

			const rows = card.querySelectorAll('.check_row');
			assert.strictEqual(rows.length, 5, 'one row per server check');

			const pairing_key = [...rows].map((row) => row.querySelector('.dd_k').textContent);
			assert.include(
				pairing_key,
				labels()['publication_hosts_check_pairing'] || 'pairing',
				'labelled through the publication_hosts prefix',
			);

			const blocked = card.querySelector('.check_row.state_blocked');
			assert.ok(blocked, 'the blocked check is marked on its row');
			assert.ok(blocked.querySelector('.dd_badge.pill_danger'), 'with the kit danger pill');
			assert.include(blocked.textContent, 'expected != reported', 'and the server fact');
		});

		it('Bun: the pin and the host Bun side by side, a drift red with both versions', async function () {
			const self = build_widget(
				ok_value([
					build_host({
						checks: [{ id: 'bun_version', state: 'blocked', detail: '1.4.2 != 1.4.3' }],
						bun: { expected: '1.4.3', reported: '1.4.2' },
					}),
				]),
			);
			const content = await mount(self);
			const card = content.querySelector('.publication_host[data-name="www"]');
			const facts = [...card.querySelectorAll('.dd_row')].map((row) => row.textContent);
			const expected_label = labels().publication_hosts_bun_expected || 'Expected Bun';
			const reported_label = labels().publication_hosts_bun_reported || 'Reported Bun';
			assert.include(facts, expected_label + '1.4.3', 'the work system pin shown');
			assert.include(facts, reported_label + '1.4.2', 'the host Bun shown');

			const row = card.querySelector('.check_row.state_blocked');
			assert.ok(row, 'the drift is a blocked check row');
			assert.ok(row.querySelector('.dd_badge.pill_danger'), 'red: the kit danger pill');
			assert.strictEqual(
				row.querySelector('.dd_k').textContent,
				labels().publication_hosts_check_bun_version || 'bun_version',
			);
			assert.include(row.textContent, '1.4.2 != 1.4.3', 'both versions named');
		});

		it('nginx map: a managed row shows hashes and the instance count; its state is the server check (drift red)', async function () {
			const H = 'e'.repeat(64);
			const S = 'f'.repeat(64);
			const managed = {
				managed: true,
				expected: H,
				applied: H,
				host_hash: S,
				contributions: 2,
				invalid: 0,
				refused: null,
				drift: false,
				agent_outdated: false,
			};
			const with_check = (check) => [...build_host().checks, check];
			const content = await mount(
				build_widget(
					ok_value([
						build_host({
							nginx_map: managed,
							checks: with_check({ id: 'nginx_map', state: 'ok', detail: H.slice(0, 12) }),
						}),
					]),
				),
			);
			const card = content.querySelector('.publication_host[data-name="www"]');
			const facts = [...card.querySelectorAll('.dd_row')].map((row) => row.textContent);
			const L = labels();
			const map_label = L.publication_hosts_check_nginx_map || 'nginx_map';
			assert.include(facts, (L.publication_hosts_map_expected || 'Expected media map hash') + H);
			assert.include(facts, (L.publication_hosts_map_applied || 'Applied media map hash') + H);
			assert.include(facts, (L.publication_hosts_map_host_hash || 'Shared host map hash') + S);
			assert.include(
				facts,
				(L.publication_hosts_map_contributions || 'Instances in the host map') + '2',
			);
			const ok_row = [...card.querySelectorAll('.check_row')].find(
				(row) => row.querySelector('.dd_k')?.textContent === map_label,
			);
			assert.ok(ok_row, 'the map state is a check row, labelled by its id');
			assert.ok(ok_row.classList.contains('state_ok'), 'shared, not drift');

			const drift = { ...managed, applied: null, drift: true };
			const drifted = await mount(
				build_widget(
					ok_value([
						build_host({
							name: 'drift',
							nginx_map: drift,
							checks: with_check({ id: 'nginx_map', state: 'blocked', detail: 'none' }),
						}),
					]),
				),
			);
			const row = [
				...drifted.querySelectorAll('.publication_host[data-name="drift"] .check_row'),
			].find((r) => r.querySelector('.dd_k')?.textContent === map_label);
			assert.ok(row.classList.contains('state_blocked'), 'not loaded is red');
			assert.ok(row.querySelector('.dd_badge.pill_danger'), 'red: the kit danger pill');
			assert.include(row.textContent, 'none');

			// a non-root row: the server omits the host-wide facts, so no host-wide rows render
			const { host_hash: _h, contributions: _c, invalid: _i, ...own } = managed;
			const reduced = await mount(
				build_widget(ok_value([build_host({ name: 'own', nginx_map: own })])),
			);
			const ownFacts = [
				...reduced.querySelectorAll('.publication_host[data-name="own"] .dd_row'),
			].map((r) => r.textContent);
			assert.include(ownFacts, (L.publication_hosts_map_applied || 'Applied media map hash') + H);
			assert.notOk(
				ownFacts.some((text) =>
					text.startsWith(L.publication_hosts_map_host_hash || 'Shared host map hash'),
				),
				'no shared host hash below root',
			);
			assert.notOk(
				ownFacts.some((text) =>
					text.startsWith(L.publication_hosts_map_contributions || 'Instances in the host map'),
				),
				'no instance count below root',
			);
		});

		it('nginx map: unmanaged shows only its check; apache (null) shows nothing', async function () {
			const unmanaged = {
				managed: false,
				expected: null,
				applied: null,
				host_hash: null,
				contributions: 0,
				invalid: 0,
				refused: null,
				drift: false,
				agent_outdated: false,
			};
			const content = await mount(
				build_widget(
					ok_value([
						build_host({
							name: 'hand',
							nginx_map: unmanaged,
							checks: [
								...build_host().checks,
								{ id: 'nginx_map', state: 'ok', detail: 'unmanaged' },
							],
						}),
						build_host({ name: 'apache', nginx_map: null }),
					]),
				),
			);
			const map_label = labels().publication_hosts_check_nginx_map || 'nginx_map';
			const hand = content.querySelector('.publication_host[data-name="hand"]');
			const check = [...hand.querySelectorAll('.check_row')].find(
				(row) => row.querySelector('.dd_k')?.textContent === map_label,
			);
			assert.include(check.textContent, 'unmanaged');
			assert.ok(check.classList.contains('state_ok'), 'a hand-placed map is not drift');
			const handFacts = [...hand.querySelectorAll('.dd_row')].map((row) => row.textContent);
			assert.notOk(
				handFacts.some((text) =>
					text.startsWith(labels().publication_hosts_map_expected || 'Expected media map hash'),
				),
				'no hash rows for a hand-placed map',
			);
			const apache = content.querySelector('.publication_host[data-name="apache"]');
			const apacheLabels = [...apache.querySelectorAll('.dd_k')].map((k) => k.textContent);
			assert.notInclude(apacheLabels, map_label, 'no map check on an apache host');
			assert.notOk(
				apacheLabels.some(
					(text) => text === (labels().publication_hosts_map_expected || 'Expected media map hash'),
				),
				'no map rows on an apache host',
			);
		});

		it('nginx map: server strings render as TEXT', async function () {
			const hostile = '<img src=x onerror=alert(1)>';
			const map = {
				managed: true,
				expected: hostile,
				applied: null,
				host_hash: null,
				contributions: 1,
				invalid: 0,
				refused: hostile,
				drift: true,
				agent_outdated: false,
			};
			const content = await mount(build_widget(ok_value([build_host({ nginx_map: map })])));
			const card = content.querySelector('.publication_host[data-name="www"]');
			assert.isNull(card.querySelector('img'), 'no element was injected');
			assert.include(card.textContent, hostile);
		});

		it('Bun: an unreachable host shows the pin and a dash, the check unknown', async function () {
			const self = build_widget(
				ok_value([
					build_host({
						checks: [{ id: 'bun_version', state: 'unknown', detail: 'status_unavailable' }],
						bun: { expected: '1.4.3', reported: null },
					}),
				]),
			);
			const content = await mount(self);
			const card = content.querySelector('.publication_host[data-name="www"]');
			const reported_label = labels().publication_hosts_bun_reported || 'Reported Bun';
			const facts = [...card.querySelectorAll('.dd_row')].map((row) => row.textContent);
			assert.include(facts, reported_label + '—', 'not reported reads as a dash');
			assert.ok(card.querySelector('.check_row.state_unknown'), 'unknown, never red or green');
		});

		it('a non-root admin sees the readout and a note, and no control at all', async function () {
			const self = build_widget(ok_value([build_host()], false));
			const content = await mount(self);

			assert.ok(content.querySelector('.root_only'), 'the root-only note renders');
			assert.ok(content.querySelector('.publication_host .check_row'), 'the readout still renders');
			assert.strictEqual(content.querySelector('.host_actions'), null, 'no action bar');
			assert.strictEqual(content.querySelector('.host_edit'), null, 'no edit form');
			assert.strictEqual(content.querySelectorAll('button').length, 0, 'no button anywhere');
		});

		it('agent commands are disabled while the pairing is not proved; remove stays available', async function () {
			const self = build_widget(ok_value([build_host({ pairing_proved: false })]));
			const content = await mount(self);

			assert.isTrue(content.querySelector('.button_apply_rules').disabled, 'apply disabled');
			assert.isTrue(content.querySelector('.button_probe').disabled, 'probe disabled');
			assert.isTrue(content.querySelector('.button_rollback_api').disabled, 'rollback disabled');
			assert.isFalse(
				content.querySelector('.button_remove_host').disabled,
				'remove is a local registry edit',
			);
		});

		it('rollback offers only an API that has a previous release', async function () {
			const self = build_widget(ok_value([build_host()]));
			const content = await mount(self);

			const select = content.querySelector('.host_rollback_select');
			assert.strictEqual(select.value, 'v1', 'the first API with a previous release is selected');
			const v2 = select.querySelector('option[value="v2"]');
			assert.isTrue(v2.disabled, 'v2 has no previous release to go back to');
			assert.include(
				select.querySelector('option[value="v1"]').textContent,
				'7.0.0_1234567',
				'the option names the target release',
			);
		});
	});

	describe('actions', function () {
		it('apply_rules is confirm-gated: a declined confirm sends nothing', async function () {
			const self = build_widget(ok_value([build_host()]));
			self.confirm_answer = false;
			const content = await mount(self);

			content.querySelector('.button_apply_rules').click();
			await settle();

			assert.strictEqual(self.confirms.length, 1, 'the operator was asked');
			assert.include(self.confirms[0], 'www', 'the question names the host');
			assert.deepEqual(self.calls, [], 'nothing was sent');
			assert.strictEqual(self.reloads, 0);
		});

		it('apply_rules confirmed: one request, spinner while in flight, result shown, value reloaded', async function () {
			const self = build_widget(ok_value([build_host()]));
			let release = null;
			self.widget_request = (action, options) => {
				self.calls.push({ action: action, options: options });
				return new Promise((resolve) => {
					release = () =>
						resolve({
							ok: true,
							data: { host: 'www', server: 'apache', hash: 'c'.repeat(64), dropped: [] },
						});
				});
			};
			const content = await mount(self);
			const button = content.querySelector('.button_apply_rules');

			button.click();
			await settle();
			assert.isTrue(button.classList.contains('button_spinner'), 'spinner while the agent works');

			release();
			await settle();
			assert.isFalse(button.classList.contains('button_spinner'), 'spinner removed after');
			assert.deepEqual(self.calls, [{ action: 'apply_rules', options: { name: 'www' } }]);
			assert.strictEqual(self.reloads, 1, 'value reloaded once');
			assert.include(
				content.querySelector('.body_response').textContent,
				'c'.repeat(64),
				'the applied hash is shown',
			);
		});

		it('after a success the REAL reload repaints the FRESH state and keeps the outcome on screen', async function () {
			const self = build_widget(ok_value([build_host()]));
			Reflect.deleteProperty(self, 'reload'); // the prototype's: get_value → refresh({destroy:true})
			self.get_value = async () =>
				ok_value([build_host({ rules: { expected: 'c'.repeat(64), reported: 'c'.repeat(64) } })]);
			self.next_response = {
				ok: true,
				data: {
					host: 'www',
					server: 'apache',
					hash: 'c'.repeat(64),
					dropped: ['Header set X-Dropped'],
				},
			};
			await self.build(false);
			const wrapper = await self.render();
			container.appendChild(wrapper);
			mounted.push(wrapper);
			const before = wrapper.content_data;
			assert.include(before.textContent, 'b'.repeat(64), 'the stale reported hash shows first');

			wrapper.querySelector('.button_apply_rules').click();
			const after = await until(() =>
				wrapper.content_data !== before && self.status === 'rendered' ? wrapper.content_data : null,
			);

			assert.notInclude(after.textContent, 'b'.repeat(64), 'the stale state is gone');
			assert.include(
				after.querySelector('.publication_host').textContent,
				'c'.repeat(64),
				'the fresh reported hash is painted',
			);
			const response = after.querySelector('.body_response').textContent;
			assert.include(response, 'apply_rules', 'the outcome survives the repaint');
			assert.include(response, 'X-Dropped', "apply_rules' dropped list stays visible");

			// the outcome belongs to the repaint that FOLLOWS the action, not to every later one
			const shown = wrapper.content_data;
			await self.reload();
			const later = await until(() =>
				wrapper.content_data !== shown && self.status === 'rendered' ? wrapper.content_data : null,
			);
			assert.strictEqual(
				later.querySelector('.body_response').textContent,
				'',
				'a later repaint does not replay the old outcome',
			);
		});

		it('a refused action shows the error sentence and does not reload', async function () {
			const self = build_widget(ok_value([build_host()]));
			const error = new ApiError({
				code: 'publication_host.timeout',
				status: 503,
				message: 'The publication host agent did not answer in time',
				source: 'envelope',
			});
			self.next_response = { ok: false, error: error };
			const content = await mount(self);
			const button = content.querySelector('.button_apply_rules');

			button.click();
			await settle();

			assert.include(
				content.querySelector('.body_response').textContent,
				error_text(error),
				'the failure is visible',
			);
			assert.strictEqual(self.reloads, 0, 'no reload on failure');
			assert.isFalse(
				button.classList.contains('button_spinner'),
				'spinner removed after a failure too',
			);
		});

		it('probe sends no confirm and does not reload', async function () {
			const self = build_widget(ok_value([build_host()]));
			self.next_response = {
				ok: true,
				data: {
					host: 'www',
					probe: {
						mode: 'shared',
						root: '/srv/pub_media',
						present: true,
						read_only: true,
						pub_readable: true,
						pub_markers: 3,
						web_traversable: true,
						problems: [],
					},
				},
			};
			const content = await mount(self);

			content.querySelector('.button_probe').click();
			await settle();

			assert.strictEqual(self.confirms.length, 0, 'a read-only probe asks nothing');
			assert.deepEqual(self.calls, [{ action: 'probe', options: { name: 'www' } }]);
			assert.strictEqual(self.reloads, 0);
			assert.include(content.querySelector('.body_response').textContent, '"pub_markers": 3');
		});

		it('rollback_api sends the selected API, confirm-gated, and reloads', async function () {
			const self = build_widget(ok_value([build_host()]));
			self.next_response = {
				ok: true,
				data: { host: 'www', api: 'v1', from: '7.0.1_abcdef0', to: '7.0.0_1234567' },
			};
			const content = await mount(self);

			content.querySelector('.button_rollback_api').click();
			await settle();

			assert.strictEqual(self.confirms.length, 1);
			assert.deepEqual(self.calls, [
				{ action: 'rollback_api', options: { name: 'www', api: 'v1' } },
			]);
			assert.strictEqual(self.reloads, 1);
		});

		it('remove_host is confirm-gated and reloads', async function () {
			const self = build_widget(ok_value([build_host()]));
			self.next_response = { ok: true, data: { host: 'www', removed: true } };
			const content = await mount(self);

			content.querySelector('.button_remove_host').click();
			await settle();

			assert.strictEqual(self.confirms.length, 1);
			assert.deepEqual(self.calls, [{ action: 'remove_host', options: { name: 'www' } }]);
			assert.strictEqual(self.reloads, 1);
		});

		it('reconcile_media_copy: only on a row carrying a media_copy check (phase 5)', async () => {
			const self = build_widget(ok_value([build_host()]));
			const content = await mount(self);
			assert.isNull(
				content.querySelector('.button_reconcile_media_copy'),
				'a row without a media_copy check offers no media-copy button',
			);
		});

		it('reconcile_media_copy is confirm-gated, sends {name}, shows the server sentence as TEXT and reloads', async () => {
			const host = build_host({
				checks: [
					...build_host().checks,
					{ id: 'media_copy', state: 'blocked', detail: 'unverified_deletions:1' },
				],
			});
			const self = build_widget(ok_value([host]));
			self.next_response = {
				ok: true,
				data: true,
				msg: "<b>'www'</b>: drift 2, applied 2.",
				report: { drift: 2, applied: 2, detail: { hosts: {} } },
				running: false,
			};
			const content = await mount(self);
			const button = content.querySelector('.button_reconcile_media_copy');
			assert.isNotNull(button, 'the copy-mode row offers the button');

			self.confirm_answer = false;
			button.click();
			await settle();
			assert.strictEqual(self.confirms.length, 1, 'the operator was asked');
			assert.include(self.confirms[0], 'www');
			assert.deepEqual(self.calls, [], 'a declined confirm sends nothing');

			self.confirm_answer = true;
			button.click();
			await settle();
			assert.deepEqual(self.calls, [{ action: 'reconcile_media_copy', options: { name: 'www' } }]);
			assert.strictEqual(self.reloads, 1);
			const response = content.querySelector('.body_response');
			assert.include(response.textContent, "<b>'www'</b>: drift 2", 'the server sentence, as text');
			assert.isNull(response.querySelector('b'), 'never parsed as HTML');
		});

		it('probe_public (phase 6): no confirm, never disabled by the pairing, sends {name}, server sentence as TEXT, reloads', async () => {
			const self = build_widget(ok_value([build_host({ pairing_proved: false })]));
			self.next_response = {
				ok: true,
				data: { state: 'failed', at: '2026-10-05T10:00:00.000Z' },
				msg: "Error. 'www': <b>the gate is OPEN</b>",
			};
			const content = await mount(self);
			const button = content.querySelector('.button_probe_public');
			assert.isNotNull(button, 'every root row offers the public probe');
			assert.isFalse(button.disabled, 'it dials no agent: an unproved pairing does not disable it');

			button.click();
			await settle();
			assert.strictEqual(self.confirms.length, 0, 'an observation asks nothing');
			assert.deepEqual(self.calls, [{ action: 'probe_public', options: { name: 'www' } }]);
			assert.strictEqual(self.reloads, 1);
			const response = content.querySelector('.body_response');
			assert.include(
				response.textContent,
				'<b>the gate is OPEN</b>',
				'the server sentence, as text',
			);
			assert.isNull(response.querySelector('b'), 'never parsed as HTML');
		});

		it('public_probe facts: when, and the server detail as TEXT (phase 6)', async () => {
			const host = build_host({
				checks: [
					...build_host().checks,
					{ id: 'public_gate', state: 'unknown', detail: 'unproven' },
				],
				public_probe: {
					state: 'unknown',
					at: '2026-10-05T10:00:00.000Z',
					published_status: null,
					unpublished_status: null,
					detail: '<img src=x onerror="window.__probe_xss=1">',
				},
			});
			const content = await mount(build_widget(ok_value([host])));
			const text = content.textContent;
			assert.include(text, '2026-10-05T10:00:00.000Z');
			assert.include(text, '<img src=x');
			assert.isNull(content.querySelector('img'), 'the detail is never parsed as HTML');
			assert.isUndefined(window.__probe_xss);
		});

		it('set_host_fields sends the edited fields; a blank field is null', async function () {
			const self = build_widget(ok_value([build_host()]));
			self.next_response = {
				ok: true,
				data: { host: 'www', fields: ['public_url', 'qualities', 'probe'] },
			};
			const content = await mount(self);
			const form = content.querySelector('.host_edit');

			assert.strictEqual(
				form.querySelector('input[name="qualities"]').value,
				'1.5MB, web',
				'prefilled from the row',
			);
			assert.strictEqual(
				form.querySelector('input[name="probe_published"]').value,
				'image/web/0/probe_published.jpg',
				'probe prefilled from the row',
			);
			form.querySelector('input[name="public_url"]').value = ' https://public.example.test ';
			form.querySelector('input[name="probe_published"]').value = '';
			form.querySelector('input[name="probe_unpublished"]').value =
				'image/web/0/probe_unpublished.jpg';
			form.querySelector('.button_save_host').click();
			await settle();

			assert.strictEqual(self.confirms.length, 0, 'saving settings asks nothing');
			assert.deepEqual(self.calls, [
				{
					action: 'set_host_fields',
					options: {
						name: 'www',
						public_url: 'https://public.example.test',
						qualities: ['1.5MB', 'web'],
						probe: { published: null, unpublished: 'image/web/0/probe_unpublished.jpg' },
					},
				},
			]);
			assert.strictEqual(self.reloads, 1);
		});

		it('read_host_fields: blank inputs are null, qualities split on commas', function () {
			const input = (value) => ({ value: value });
			assert.deepEqual(
				read_host_fields('www', {
					public_url: input(''),
					qualities: input(' , ,'),
					probe_published: input('  '),
					probe_unpublished: input(''),
				}),
				{
					name: 'www',
					public_url: null,
					qualities: null,
					probe: { published: null, unpublished: null },
				},
				'empty qualities = the engine default (null), never an empty list',
			);
			assert.deepEqual(
				read_host_fields('www', {
					public_url: input('https://www.example.test'),
					qualities: input('web,1.5MB , 3MB'),
					probe_published: input('a.jpg'),
					probe_unpublished: input('b.jpg'),
				}).qualities,
				['web', '1.5MB', '3MB'],
			);
		});
	});

	describe('shared check_row', function () {
		it('keeps the update_code prefix by default (update_code / serve_code unchanged)', function () {
			const parent = document.createElement('div');
			check_row(parent, { id: 'superuser', state: 'ok' });
			assert.strictEqual(
				parent.querySelector('.dd_k').textContent,
				labels()['update_code_check_superuser'] || 'superuser',
			);
		});
	});
});

describe('SYSTEM MAP receives OPEN_WIDGET_EVENT', function () {
	this.timeout(10000);

	const WIDGETS = [
		{ id: 'media_control', label: 'Media control', category: 'media' },
		{ id: 'publication_hosts', label: 'Publication hosts', category: 'publication' },
	];

	const build = (show_map) =>
		build_map_view({ id: 'area_maintenance_test' }, WIDGETS, { show_map });

	const selected_chip = (root) => root.querySelector('.tool_chip.sel');

	it('a live map switches to the map view and opens the asked widget', async function () {
		let shown = 0;
		const map = build(() => {
			shown++;
		});
		container.appendChild(map.node);
		try {
			document.dispatchEvent(
				new CustomEvent(OPEN_WIDGET_EVENT, { detail: { id: 'publication_hosts' } }),
			);
			assert.strictEqual(shown, 1, 'the map view is shown first');
			const chip = selected_chip(map.node);
			assert.ok(chip, 'a tool chip is selected');
			assert.strictEqual(
				chip.dataset.id,
				'publication_hosts',
				'the asked widget is the one opened',
			);
		} finally {
			map.destroy();
			map.node.remove();
		}
	});

	it('an unknown id does nothing', async function () {
		let shown = 0;
		const map = build(() => {
			shown++;
		});
		container.appendChild(map.node);
		try {
			const before = selected_chip(map.node);
			document.dispatchEvent(
				new CustomEvent(OPEN_WIDGET_EVENT, { detail: { id: 'no_such_widget' } }),
			);
			assert.strictEqual(shown, 0, 'the view is not switched');
			assert.strictEqual(selected_chip(map.node), before, 'the selection is unchanged');
		} finally {
			map.destroy();
			map.node.remove();
		}
	});

	it('a map no longer in the document, or destroyed, never acts', async function () {
		let shown = 0;
		const detached = build(() => {
			shown++;
		});
		try {
			document.dispatchEvent(
				new CustomEvent(OPEN_WIDGET_EVENT, { detail: { id: 'publication_hosts' } }),
			);
			assert.strictEqual(shown, 0, 'a stale (detached) map ignores the event');
		} finally {
			detached.destroy();
		}
		const live = build(() => {
			shown++;
		});
		container.appendChild(live.node);
		live.destroy();
		try {
			document.dispatchEvent(
				new CustomEvent(OPEN_WIDGET_EVENT, { detail: { id: 'publication_hosts' } }),
			);
			assert.strictEqual(shown, 0, 'destroy() removed the listener');
		} finally {
			live.node.remove();
		}
	});

	it('shows the selected widget module id in the context header', function () {
		const map = build(() => {});
		container.appendChild(map.node);
		try {
			document.dispatchEvent(
				new CustomEvent(OPEN_WIDGET_EVENT, { detail: { id: 'publication_hosts' } }),
			);
			const id_el = map.node.querySelector('.ctx_head .ctx_widget_id');
			assert.ok(id_el, 'the context header carries a widget-id node');
			assert.strictEqual(
				id_el.textContent,
				'publication_hosts',
				'the selected widget module id is shown (non-intrusive header badge)',
			);
		} finally {
			map.destroy();
			map.node.remove();
		}
	});
});

describe('MEDIA_CONTROL link line', function () {
	this.timeout(10000);

	it('renders one read-only line and asks the dashboard to open publication_hosts', async function () {
		const self = new media_control();
		self.id = 'media_control';
		self.caller = null;
		self.events_tokens = [];
		self.value = {
			mode: 'private',
			mode_source: 'DEDALO_MEDIA_ACCESS_MODE',
			markers: { base_exists: true, pub_count: 0, auth_count: 0 },
			htaccess: { exists: true, up_to_date: true },
			engine: { reachable: true, media_index_enabled: true, pub_markers: 0, databases: [] },
			is_root: false,
		};
		const content = await self.list({ render_level: 'content' });
		container.appendChild(content);

		let seen = null;
		const on_open = (e) => {
			seen = e.detail;
		};
		document.addEventListener(OPEN_WIDGET_EVENT, on_open);
		try {
			const rows = content.querySelectorAll('.dd_readout .publication_hosts_link');
			assert.strictEqual(rows.length, 1, 'exactly one line, inside the status readout');
			rows[0].querySelector('button').click();
			assert.deepEqual(
				seen,
				{ id: 'publication_hosts' },
				'the dashboard is asked to open publication_hosts',
			);
		} finally {
			document.removeEventListener(OPEN_WIDGET_EVENT, on_open);
			content.remove();
		}
	});
});

// @license-end
