// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, before, after, assert, page_globals */
/*eslint no-undef: "error"*/

/**
 * TEST_UPDATE_CODE
 * First area_maintenance browser suite: the update_code widget panel and the
 * shared server picker's cross-widget contract.
 *
 * The regression this suite exists for (2026-08-23): `render_servers_list` used
 * to publish `ontology_server_select_change` on EVERY radio change. update_code
 * reuses that picker on the same dashboard as update_ontology, so selecting a
 * CODE server reset the ontology widget's reference row while its own radio
 * stayed checked. The picker now publishes NOTHING itself — selection travels
 * through the caller's `on_change` callback, which only update_ontology's own
 * caller wires to the event.
 *
 * Backend-free: fake `value.servers` descriptors (a reachable server is
 * `response_code:200` + a result whose `data` is truthy), test-only
 * localStorage keys (cleaned up), no widget get_value round-trip.
 */

import { area_maintenance } from '../../../core/area_maintenance/js/area_maintenance.js';
import { serve_code } from '../../../core/area_maintenance/widgets/serve_code/js/serve_code.js';
import {
	render_info_modal,
	render_restore_modal,
} from '../../../core/area_maintenance/widgets/update_code/js/render_update_code.js';
import {
	backup_waiver_check,
	image_update_command,
	panel_blocked,
	refresh_readiness,
	render_consumer_status,
} from '../../../core/area_maintenance/widgets/update_code/js/render_update_status.js';
import { update_code } from '../../../core/area_maintenance/widgets/update_code/js/update_code.js';
import {
	apply_phase_frame,
	init_phase_state,
	UPDATE_PHASES,
} from '../../../core/area_maintenance/widgets/update_code/js/update_code_phases.js';
import {
	build_import_files,
	render_servers_list,
	render_update_ontology,
} from '../../../core/area_maintenance/widgets/update_ontology/js/render_update_ontology.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { ui } from '../../../core/common/js/ui.js';

// DOM container
const container = document.getElementById('content');

// fixtures
const CODE_STORAGE_KEY = 'dedalo.test.update_code.server';
const ONTOLOGY_STORAGE_KEY = 'dedalo.test.update_ontology.server';

const build_server = (name, url) => {
	return {
		name: name,
		url: url,
		code: 'test_code',
		response_code: 200,
		result: { data: true }, // response_data(result) truthy → reachable
	};
};

describe('UPDATE_CODE WIDGET', function () {
	this.timeout(10000);

	after(() => {
		// test-only storage keys never leak into the app's remembered choices
		try {
			localStorage.removeItem(CODE_STORAGE_KEY);
			localStorage.removeItem(ONTOLOGY_STORAGE_KEY);
		} catch (_error) {
			/* private mode */
		}
	});

	describe('panel render', () => {
		it('renders the version readout and the server picker (no staging path, no beta toggle)', async () => {
			const self = new update_code();
			self.id = 'test_update_code';
			self.value = {
				servers: [build_server('code server A', 'https://a.example.test/api')],
				is_a_code_server: false,
			};
			self.caller = null;
			self.events_tokens = [];

			const content_data = await self.list({ render_level: 'content' });
			container.appendChild(content_data);

			// version/build readout (shared widget kit)
			const readout = content_data.querySelector('.dd_readout');
			assert.ok(readout, 'the panel renders a dd_readout');
			assert.strictEqual(
				readout.querySelectorAll('.dd_row').length,
				2,
				'current version + current build rows',
			);

			// the shared server picker markup
			assert.ok(
				content_data.querySelector('.server_picker'),
				'the panel renders the shared server picker',
			);
			assert.ok(
				content_data.querySelector('.server_picker input[type="radio"]'),
				'the picker renders a radio row',
			);

			// dead surfaces stay dead
			assert.strictEqual(
				content_data.querySelector('.beta_updates_container'),
				null,
				'no beta toggle',
			);
			assert.notInclude(
				content_data.textContent,
				'dedalo_source_version_local_dir',
				'no staging path line',
			);

			content_data.remove();
		});

		it('the offer is always in view, and the chosen one is remembered', async () => {
			const CHANNEL_KEY = 'dedalo.update_code.channel';
			let saved = null;
			try {
				saved = localStorage.getItem(CHANNEL_KEY);
				localStorage.removeItem(CHANNEL_KEY);
			} catch (_error) {
				/* private mode */
			}

			const render = async () => {
				const self = new update_code();
				self.id = 'test_update_code';
				self.value = {
					servers: [build_server('code server A', 'https://a.example.test/api')],
					is_a_code_server: false,
				};
				self.caller = null;
				self.events_tokens = [];
				const content_data = await self.list({ render_level: 'content' });
				container.appendChild(content_data);
				return content_data;
			};
			const checked = (cd) => cd.querySelector('.channel_row input.channel_radio:checked')?.value;

			try {
				const first = await render();
				const row = first.querySelector('.update_actions >.channel_row');
				assert.ok(row, 'the offer row sits directly in the actions zone');
				assert.strictEqual(row.closest('details'), null, 'never folded');
				assert.strictEqual(checked(first), 'master', 'published releases until a choice is made');

				const dev = row.querySelector('input.channel_radio[value="dev"]');
				dev.checked = true;
				dev.dispatchEvent(new Event('change'));
				first.remove();

				const second = await render();
				assert.strictEqual(checked(second), 'dev', 'the next render restores the choice');
				assert.isNotEmpty(second.querySelector('.channel_note').textContent, 'and shows its note');
				second.remove();
			} finally {
				try {
					saved === null
						? localStorage.removeItem(CHANNEL_KEY)
						: localStorage.setItem(CHANNEL_KEY, saved);
				} catch (_error) {
					/* private mode */
				}
			}
		});

		it('before the value loads: only the readout, marked as the loader slot — no picker, no actions', async () => {
			const self = new update_code();
			self.id = 'test_update_code_preload';
			self.caller = null;
			self.events_tokens = [];

			const content_data = await self.list({ render_level: 'content' });
			container.appendChild(content_data);
			try {
				assert.ok(
					content_data.querySelector('.widget_load_slot .dd_readout'),
					'the readout is the spinner slot',
				);
				assert.strictEqual(content_data.querySelector('.server_picker'), null, 'no picker yet');
				assert.strictEqual(
					content_data.querySelector('button.button_submit'),
					null,
					'no check button yet',
				);
			} finally {
				content_data.remove();
			}
		});
	});

	describe('server picker cross-widget contract', () => {
		it('selecting a CODE server publishes nothing and leaves a co-mounted ontology row alone', () => {
			let published = 0;
			let last_payload;
			const token = event_manager.subscribe('ontology_server_select_change', (payload) => {
				published++;
				last_payload = payload;
			});

			// the ontology widget's reference row stand-in: the subscriber the
			// bleed used to reset (set_server(null) on every foreign click)
			let reference_server = { name: 'kept' };
			const reference_token = event_manager.subscribe('ontology_server_select_change', () => {
				reference_server = null;
			});

			try {
				// CODE picker: update_code passes NO on_change
				const code_servers = [build_server('code server', 'https://code.example.test/api')];
				const code_picker = render_servers_list(
					{ servers: code_servers },
					'CODE_SERVERS',
					CODE_STORAGE_KEY,
				);
				container.appendChild(code_picker);

				const code_radio = code_picker.querySelector('input[type="radio"]');
				code_radio.checked = true;
				code_radio.dispatchEvent(new Event('change'));

				assert.strictEqual(published, 0, 'a CODE selection publishes no ontology event');
				assert.ok(reference_server, 'the ontology reference row is untouched by a CODE selection');
				assert.strictEqual(
					code_servers[0].active,
					true,
					'the CODE picker still marks its own selection',
				);

				// ontology-style picker: its caller's on_change publishes, as before
				const onto_servers = [build_server('master', 'https://master.example.test/api')];
				onto_servers[0].tld = ['test'];
				const onto_picker = render_servers_list(
					{ servers: onto_servers },
					'ONTOLOGY_SERVERS',
					ONTOLOGY_STORAGE_KEY,
					(server) => {
						event_manager.publish(
							'ontology_server_select_change',
							server ? server.tld || null : null,
						);
					},
				);
				container.appendChild(onto_picker);

				const onto_radio = onto_picker.querySelector('input[type="radio"]');
				onto_radio.checked = true;
				onto_radio.dispatchEvent(new Event('change'));

				assert.strictEqual(published, 1, 'an ONTOLOGY selection still publishes exactly once');
				assert.deepEqual(last_payload, ['test'], 'the payload is still the tld list');

				code_picker.remove();
				onto_picker.remove();
			} finally {
				event_manager.unsubscribe(token);
				event_manager.unsubscribe(reference_token);
			}
		});
	});

	describe('waive-backup control', () => {
		// The panel value the modal reads. `checks` is the server's readiness
		// vocabulary (core/update/status.ts): {id, state, detail}, where the
		// state is 'ok' exactly when the pipeline will not refuse on that account.
		const build_self = (backup_state, detail, extra_checks = []) => {
			const self = new update_code();
			self.id = 'test_update_code_modal';
			self.value = {
				servers: [],
				is_a_code_server: false,
				consumer: {
					ready: true,
					checks: [
						{ id: 'superuser', state: 'ok' },
						{ id: 'backup_fresh', state: backup_state, detail: detail },
						...extra_checks,
					],
				},
			};
			self.caller = null;
			self.events_tokens = [];
			return self;
		};
		const versions_info = {
			info: { version: '9.9.9', host: 'code.example.test', entity: 'Test' },
			files: [
				{ version: '9.9.10', url: 'https://code.example.test/9.9.10.zip', date: '2026-08-25' },
			],
		};
		const open_modal = (self) => {
			const body_response = ui.create_dom_element({ element_type: 'div', parent: container });
			const modal = render_info_modal(self, versions_info, body_response);
			return { modal: modal, body_response: body_response };
		};
		const close = (opened) => {
			if (opened.modal && typeof opened.modal.close === 'function') {
				opened.modal.close();
			}
			opened.body_response.remove();
		};

		it('a STALE backup offers the waiver, with the age fact and the caution', () => {
			const opened = open_modal(build_self('warn', '73'));
			try {
				// scoped to THIS modal: a previous test's node may still be closing
				const row = opened.modal.querySelector('.waive_backup_row');
				assert.ok(row, 'a stale backup renders the waive row');

				// the <label> WRAPS the input (no id/for pair to keep in sync)
				const input = row.querySelector('input[type="checkbox"].waive_backup_check');
				assert.ok(input, 'the row carries a checkbox');
				assert.strictEqual(
					input.parentElement.className,
					'waive_backup_label',
					'the label wraps the input',
				);
				assert.strictEqual(input.checked, false, 'it is never pre-armed');

				// the server sends a FACT, the client the wording
				const note = row.querySelector('.waive_backup_note');
				assert.ok(note, 'the row carries its caution note');
				assert.include(note.textContent, '73', 'the measured age is stated');
				assert.include(note.className, 'state_warning', 'in the shared severity vocabulary');

				// it sits ABOVE the Update button: read before pressed
				const button = row.parentElement.querySelector('button.success');
				assert.ok(button, 'the modal renders the Update button');
				assert.strictEqual(
					row.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
					Node.DOCUMENT_POSITION_FOLLOWING,
					'the waive row precedes the Update button',
				);
			} finally {
				close(opened);
			}
		});

		it('NO backup at all still offers it (detail "none", no age to state)', () => {
			const opened = open_modal(build_self('warn', 'none'));
			try {
				const row = opened.modal.querySelector('.waive_backup_row');
				assert.ok(row, 'a missing backup renders the waive row too');
				// the raw server FACT ('none') is never shown; only a measured age is
				assert.notMatch(
					row.querySelector('.waive_backup_note').textContent,
					/\bnone\b|NaN/,
					'the raw fact is never rendered',
				);
			} finally {
				close(opened);
			}
		});

		it('a FRESH backup renders no waiver at all', () => {
			// Nothing to waive → no invitation to disarm a guard that is not in
			// the way. This is the assertion that makes the control honest.
			const opened = open_modal(build_self('ok', '2'));
			try {
				assert.strictEqual(
					opened.modal.querySelector('.waive_backup_row'),
					null,
					'a fresh backup renders no waive row',
				);
			} finally {
				close(opened);
			}
		});

		it('a BLOCKED check keeps Update disabled and names it; maintenance mode gets its switch', () => {
			// The pipeline WILL refuse a blocked check, so the choice must not be
			// actionable — the operator learns it here, not after the click.
			const self = build_self('ok', '2', [
				{ id: 'maintenance_mode', state: 'blocked' },
				{ id: 'supervisor', state: 'blocked' },
			]);
			self.value.consumer.ready = false;
			const opened = open_modal(self);
			try {
				const gate = opened.modal.querySelector('.update_gate');
				assert.ok(gate, 'the gate renders');
				assert.ok(
					gate.querySelector('.maintenance_prereq .button_enable_maintenance'),
					'maintenance mode comes with its switch',
				);
				assert.strictEqual(
					gate.querySelectorAll('.dd_note.state_danger').length,
					2,
					'one note per blocked check',
				);
				const button = gate.parentElement.querySelector('button.success');
				assert.strictEqual(button.disabled, true, 'Update is disabled while a check blocks');
				assert.strictEqual(
					gate.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
					Node.DOCUMENT_POSITION_FOLLOWING,
					'the gate precedes the Update button',
				);
				// choosing a version must not re-arm it
				const radio = opened.modal.querySelector('input[type="radio"]');
				radio.checked = true;
				radio.dispatchEvent(new Event('change'));
				assert.strictEqual(button.disabled, true, 'selecting a version keeps it disabled');
			} finally {
				close(opened);
			}
		});

		it('nothing blocked: no gate content and Update is live', () => {
			const opened = open_modal(build_self('ok', '2'));
			try {
				assert.strictEqual(
					opened.modal.querySelector('.update_gate').childElementCount,
					0,
					'an empty gate',
				);
				assert.strictEqual(
					opened.modal.querySelector('button.success').disabled,
					false,
					'Update is live',
				);
			} finally {
				close(opened);
			}
		});

		it('the ticked box is what the wire body carries', async () => {
			// The model layer is the wire: a checkbox the server never hears
			// about is decoration. Both states, through the real method.
			const self = build_self('warn', '73');
			const sent = [];
			const original = window.fetch;
			// update_code.prototype.update_code goes through data_manager; drive
			// the method directly and read the options bag it assembles by
			// intercepting at the transport.
			assert.strictEqual(typeof self.update_code, 'function', 'the model exposes update_code');
			window.fetch = async (url, options) => {
				sent.push(JSON.parse(options.body));
				return new Response(JSON.stringify({ ok: true, data: null }), {
					headers: { 'Content-Type': 'application/json' },
				});
			};
			try {
				await self.update_code({
					info: versions_info.info,
					file_active: versions_info.files[0],
					waive_backup: true,
				});
				await self.update_code({ info: versions_info.info, file_active: versions_info.files[0] });
				assert.isAtLeast(sent.length, 2, 'both calls reached the transport');
				assert.strictEqual(sent[0].options.waive_backup, true, 'a ticked box travels as true');
				assert.strictEqual(
					sent[sent.length - 1].options.waive_backup,
					false,
					'an untouched box travels as false, never absent',
				);
			} finally {
				window.fetch = original;
			}
		});
	});

	describe('readiness headline (version, blocks only; backup is the modal’s)', () => {
		// 2026-11-06 simplification: the panel heads with the installed version
		// and the verdict; only BLOCKED checks stay in view; warnings fold under
		// Details; backup_fresh is not on the panel at all (the version modal
		// offers its waiver).
		const render = (consumer) => {
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			render_consumer_status(wrapper, consumer);
			return wrapper;
		};
		const consumer_with = (backup_state, extra_checks) => {
			return {
				ready: true,
				engine: {},
				tree: {},
				checks: [
					{ id: 'superuser', state: 'ok' },
					{ id: 'backup_fresh', state: backup_state, detail: backup_state === 'ok' ? '2' : '73' },
				].concat(extra_checks || []),
			};
		};

		it('a stale or unknown backup never reaches the panel', () => {
			for (const state of ['warn', 'unknown']) {
				const wrapper = render(consumer_with(state));
				try {
					const headline = wrapper.querySelector('.status_verdict');
					assert.ok(headline, 'the consumer half renders a headline verdict');
					assert.include(headline.className, 'state_ok', 'the backup does not colour the headline');
					assert.notInclude(wrapper.textContent, '73', 'no backup row anywhere, Details included');
				} finally {
					wrapper.remove();
				}
			}
		});

		it('the installed version heads the panel', () => {
			const consumer = consumer_with('ok');
			consumer.engine = {
				engine_version: '7.0.0-beta.9',
				date: '2026-10-02T09:22:10+02:00',
				posture: 'release',
				install_source: 'https://code.example.test/dedalo/install/code/7/7.0/7.0.0-beta.9.zip',
			};
			const wrapper = render(consumer);
			try {
				const hero = wrapper.querySelector('.installed_version_value');
				assert.ok(hero, 'a version block');
				assert.strictEqual(hero.textContent, '7.0.0-beta.9');
				const when = wrapper.querySelector('.installed_version_date').textContent;
				assert.include(when, '2026-10-02T09:22:10+02:00', 'with its build date verbatim');
				assert.include(when, 'code.example.test', 'and the code server it came from');
				assert.strictEqual(
					wrapper.firstElementChild.firstElementChild.classList.contains('installed_version'),
					true,
					'first thing rendered',
				);
			} finally {
				wrapper.remove();
			}
		});

		it('disk space reads free AND needed; a measuring line says so in words', () => {
			const GB = 1024 ** 3;
			const consumer = consumer_with('ok', [
				{ id: 'disk_space', state: 'blocked', detail: `${GB}/${3 * GB}`, scope: '/x/backups/code' },
			]);
			consumer.ready = false;
			const wrapper = render(consumer);
			try {
				const row = wrapper.querySelector('.attention_checks .check_row.state_blocked');
				assert.ok(row, 'a shortfall blocks, in view');
				const detail = row.querySelector('.check_detail').textContent;
				assert.include(detail, '·', 'free · needed');
				assert.notInclude(detail, '/', 'never the raw pair');
				assert.ok(row.querySelector('.check_fix'), 'with its fix steps');
			} finally {
				wrapper.remove();
			}
			const measuring = render(
				consumer_with('ok', [{ id: 'disk_space', state: 'unknown', detail: 'measuring' }]),
			);
			try {
				const text = measuring.querySelector(
					'.all_checks_block .check_row.state_unknown .check_detail',
				).textContent;
				assert.notStrictEqual(text, 'measuring', 'a reason id is worded, never shown raw');
			} finally {
				measuring.remove();
			}
		});

		it('a block carries its numbered fix steps; an ok row does not', () => {
			const consumer = consumer_with('ok', [
				{
					id: 'runtime_data_outside_tree',
					state: 'blocked',
					detail: 'code_server_git_dir (DEDALO_CODE_SERVER_GIT_DIR): /x',
				},
			]);
			consumer.ready = false;
			const wrapper = render(consumer);
			try {
				const fix = wrapper.querySelector('.attention_checks .check_fix');
				assert.ok(fix, 'the blocked row explains how to fix it');
				assert.isAbove(
					fix.querySelectorAll('ol.check_fix_steps > li').length,
					1,
					'as numbered steps',
				);
				assert.ok(wrapper.querySelector('.attention_checks .check_note'), 'with its why');
				assert.isNull(
					wrapper.querySelector('.check_row.state_ok .check_fix'),
					'never on an ok row',
				);
			} finally {
				wrapper.remove();
			}
		});

		it('warnings fold under a CLOSED Details; only blocks stay in view', () => {
			const consumer = consumer_with('ok', [
				{ id: 'staging_clean', state: 'warn' },
				{ id: 'channel', state: 'blocked', detail: 'XBLOCK' },
			]);
			consumer.ready = false;
			const wrapper = render(consumer);
			try {
				const attention = wrapper.querySelector('.attention_checks');
				assert.ok(attention, 'the block is in view');
				assert.include(attention.textContent, 'XBLOCK');
				assert.strictEqual(
					attention.querySelectorAll('.check_row').length,
					1,
					'the warning is not',
				);
				const details = wrapper.querySelector('details.update_details');
				assert.ok(details, 'a Details fold');
				assert.strictEqual(details.open, false, 'closed');
				assert.ok(
					details.querySelector('.all_checks_block .state_warn'),
					'the warning lives in Details',
				);
			} finally {
				wrapper.remove();
			}
		});

		it('maintenance mode is no lock: the modal switches it on', () => {
			const blocked = consumer_with('warn');
			blocked.ready = false; // the server counts it…
			blocked.checks.push({ id: 'maintenance_mode', state: 'blocked' });
			const wrapper = render(blocked);
			try {
				const headline = wrapper.querySelector('.status_verdict');
				assert.include(headline.className, 'state_ok', '…the panel does not');
				assert.isFalse(panel_blocked(blocked), 'one predicate for verdict and hint');
				assert.isNull(wrapper.querySelector('.maintenance_prereq'), 'no switch on the panel');
				assert.isNull(wrapper.querySelector('.attention_checks'), 'no attention row');
				assert.strictEqual(
					wrapper.querySelectorAll('.all_checks_block .check_row').length,
					1,
					'not listed in Details either (only superuser)',
				);
				blocked.checks.push({ id: 'superuser', state: 'blocked' });
				assert.isTrue(panel_blocked(blocked), 'a real block still blocks');
			} finally {
				wrapper.remove();
			}
		});
	});

	describe('restore modal — the downgrade waiver', () => {
		// The DECISION the source-shape gate cannot see (test/unit/
		// client_update_code_render.test.ts says so): the submit unlocks only
		// when the checkbox is ticked, and the checkbox is asked for only when
		// the code actually changes — the SERVER's rule (code_restore.ts
		// restoreChangesCode, U-07): another RELEASE IDENTITY, or two known
		// archive digests that differ. Never the shared data triple.
		const point_of = (version, digest = 'a'.repeat(64)) => {
			return {
				name: 'dedalo_' + version + '_abc1234_2026-08-25T10-00-00',
				stamp: Date.now(),
				bootable: true,
				version: version,
				data_version: '7.0.0',
				bun_pin: null,
				digest: digest,
				restorable: true,
				restorable_reason: null,
			};
		};
		const engine_of = (engine_version, install_digest = 'a'.repeat(64)) => {
			return { version: '7.0.0', engine_version: engine_version, install_digest: install_digest };
		};
		const open_restore = (point, engine) => {
			const self = new update_code();
			self.id = 'test_update_code_restore_modal';
			self.value = {};
			self.caller = null;
			self.events_tokens = [];
			const body_response = ui.create_dom_element({ element_type: 'div', parent: container });
			return {
				modal: render_restore_modal(self, point, body_response, engine),
				body_response: body_response,
			};
		};
		const close = (opened) => {
			if (opened.modal && typeof opened.modal.close === 'function') {
				opened.modal.close();
			}
			opened.body_response.remove();
		};

		it('the SAME identity and digest asks for no waiver and the submit is live', () => {
			const opened = open_restore(point_of('7.0.0-beta.7'), engine_of('7.0.0-beta.7'));
			try {
				assert.strictEqual(
					opened.modal.querySelector('.confirm_downgrade_row'),
					null,
					'no waiver where nothing changes',
				);
				const button = opened.modal.querySelector('button.button_restore_submit');
				assert.ok(button, 'the modal renders the Restore button');
				assert.strictEqual(button.disabled, false, 'and it is not gated');
			} finally {
				close(opened);
			}
		});

		it('another identity of the SAME data triple asks for the waiver (U-07)', () => {
			// beta.5 over beta.7: both declare data triple 7.0.0
			const opened = open_restore(point_of('7.0.0-beta.5'), engine_of('7.0.0-beta.7'));
			try {
				assert.ok(
					opened.modal.querySelector('.confirm_downgrade_row'),
					'a release-identity change asks',
				);
			} finally {
				close(opened);
			}
		});

		it('the same identity from another known digest asks for the waiver', () => {
			const opened = open_restore(point_of('7.0.0-dev', 'b'.repeat(64)), engine_of('7.0.0-dev'));
			try {
				assert.ok(
					opened.modal.querySelector('.confirm_downgrade_row'),
					'two builds of one identity differ',
				);
			} finally {
				close(opened);
			}
		});

		it('an unknown digest is no evidence: the same identity asks for no waiver', () => {
			const opened = open_restore(point_of('7.0.0-dev', null), engine_of('7.0.0-dev'));
			try {
				assert.strictEqual(
					opened.modal.querySelector('.confirm_downgrade_row'),
					null,
					'the identity decides',
				);
			} finally {
				close(opened);
			}
		});

		it('a DIFFERENT version locks the submit until the waiver is ticked', () => {
			const opened = open_restore(point_of('6.9.9'), engine_of('7.0.0'));
			try {
				const row = opened.modal.querySelector('.confirm_downgrade_row');
				assert.ok(row, 'a version change renders the waiver row');
				// the <label> WRAPS the input (the house pattern), and names the target
				const input = row.querySelector('input[type="checkbox"].confirm_downgrade_check');
				assert.ok(input, 'the row carries a checkbox');
				assert.strictEqual(
					input.parentElement.className,
					'confirm_downgrade_label',
					'the label wraps the input',
				);
				assert.strictEqual(input.checked, false, 'it is never pre-armed');
				assert.include(
					input.parentElement.textContent,
					'6.9.9',
					'the waiver names the version it waives to',
				);

				const button = opened.modal.querySelector('button.button_restore_submit');
				assert.strictEqual(
					button.disabled,
					true,
					'the submit is locked while the waiver is not given',
				);
				input.checked = true;
				input.dispatchEvent(new Event('change'));
				assert.strictEqual(button.disabled, false, 'ticking it unlocks the submit');
				input.checked = false;
				input.dispatchEvent(new Event('change'));
				assert.strictEqual(button.disabled, true, 'un-ticking it locks it again');
			} finally {
				close(opened);
			}
		});

		it('a point whose version cannot be read always asks for the waiver', () => {
			// version:null means the compare cannot be made; the hazard is then
			// assumed, never waived away by silence.
			const opened = open_restore(point_of(null), engine_of('7.0.0'));
			try {
				assert.ok(
					opened.modal.querySelector('.confirm_downgrade_row'),
					'an unreadable version still asks',
				);
			} finally {
				close(opened);
			}
		});
	});

	describe('restore modal — the database-backup waiver (a destructive door)', () => {
		// A restore goes through core/update/door_class.ts (destructive_shared): it
		// refuses without a recent DATABASE backup. The modal offers the waiver on
		// the SAME predicate as the update modal (backup_waiver_check), and the
		// box's state travels as `waive_backup` — false when untouched, never absent.
		const point = {
			name: 'dedalo_7.0.0_abc1234_2026-08-25T10-00-00',
			stamp: Date.now(),
			bootable: true,
			version: '7.0.0',
			data_version: '7.0.0',
			bun_pin: null,
			digest: 'a'.repeat(64),
			restorable: true,
			restorable_reason: null,
		};
		const engine = { version: '7.0.0', engine_version: '7.0.0', install_digest: 'a'.repeat(64) };
		const open_with = (backup_state) => {
			const self = new update_code();
			self.id = 'test_update_code_restore_waive';
			self.value = {
				consumer: { checks: [{ id: 'backup_fresh', state: backup_state, detail: '73' }] },
			};
			self.caller = null;
			self.events_tokens = [];
			self.sent = [];
			self.restore_code = async (options) => {
				self.sent.push(options);
				return { ok: false, error: { code: 'update.refused', message: 'stub: stop here' } };
			};
			const body_response = ui.create_dom_element({ element_type: 'div', parent: container });
			return {
				self,
				modal: render_restore_modal(self, point, body_response, engine),
				body_response,
			};
		};
		const close = (opened) => {
			if (opened.modal && typeof opened.modal.close === 'function') {
				opened.modal.close();
			}
			opened.body_response.remove();
		};
		const submit = async (opened) => {
			const before = opened.self.sent.length;
			opened.modal.querySelector('button.button_restore_submit').click();
			const until = Date.now() + 5000;
			while (opened.self.sent.length === before && Date.now() < until) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.strictEqual(opened.self.sent.length, before + 1, 'the submit reached restore_code');
			return opened.self.sent.at(-1);
		};

		it('a fresh backup offers no waiver', () => {
			const opened = open_with('ok');
			try {
				assert.strictEqual(
					opened.modal.querySelector('.waive_backup_row'),
					null,
					'no guard to disarm',
				);
			} finally {
				close(opened);
			}
		});

		it('a stale backup offers it, and its state travels as waive_backup', async () => {
			const original_confirm = ui.confirm;
			ui.confirm = async () => true;
			const opened = open_with('warn');
			try {
				const check = opened.modal.querySelector(
					'.waive_backup_row input[type="checkbox"].waive_backup_check',
				);
				assert.ok(check, 'the waiver row carries a checkbox');
				assert.strictEqual(check.checked, false, 'never pre-armed');
				const untouched = await submit(opened);
				assert.strictEqual(
					untouched.waive_backup,
					false,
					'untouched travels as false, never absent',
				);
				opened.modal.querySelector('button.button_restore_submit').disabled = false;
				check.checked = true;
				const ticked = await submit(opened);
				assert.strictEqual(ticked.waive_backup, true, 'a ticked box travels as true');
				assert.strictEqual(ticked.name, point.name, 'with the point it restores');
			} finally {
				ui.confirm = original_confirm;
				close(opened);
			}
		});
	});

	describe('refresh_readiness (the panel re-stated in place)', () => {
		const consumer = (gate) => ({
			ready: gate.state !== 'blocked',
			engine: {},
			tree: {},
			checks: [
				{ id: 'superuser', state: 'ok' },
				{ id: 'channel', state: gate.state, detail: gate.detail },
			],
		});

		it('replaces exactly one block, in position, with the new verdict', () => {
			// The DOM surgery is non-obvious: render_readiness APPENDS the rebuilt
			// block at the end of the wrapper and replaceChild then moves it into
			// the old one's slot. A refactor that stops stamping .readiness_block,
			// or returns the readout instead of its parent, leaves the source-shape
			// gates green while the panel silently stops refreshing — or grows a
			// second block.
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			render_consumer_status(wrapper, consumer({ state: 'ok', detail: '2' }));
			try {
				const before = [...wrapper.children].indexOf(wrapper.querySelector('.readiness_block'));
				assert.strictEqual(
					wrapper.querySelectorAll('.readiness_block').length,
					1,
					'one block to start with',
				);
				assert.include(wrapper.querySelector('.status_verdict').className, 'state_ok');

				const answered = refresh_readiness(wrapper, consumer({ state: 'blocked', detail: '73' }));

				assert.strictEqual(answered, true, 'it reports that it replaced a block');
				assert.strictEqual(
					wrapper.querySelectorAll('.readiness_block').length,
					1,
					'still exactly one block — no duplicate',
				);
				assert.strictEqual(
					[...wrapper.children].indexOf(wrapper.querySelector('.readiness_block')),
					before,
					'in the same position',
				);
				assert.include(
					wrapper.querySelector('.status_verdict').className,
					'state_danger',
					'restated from the new value',
				);
				assert.strictEqual(
					wrapper.querySelectorAll('.all_checks_block').length,
					1,
					'Details list restated, not duplicated',
				);
				assert.include(wrapper.textContent, '73', 'carrying the new age fact');
			} finally {
				wrapper.remove();
			}
		});

		it('answers false when there is no block to replace, so the caller can re-render', () => {
			// the FALLBACK painting (a payload without `consumer`): there is no
			// readiness block, and silently doing nothing would strand the panel
			// on version+build while the modal offers a waiver for a check the
			// panel never shows.
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			try {
				assert.strictEqual(
					refresh_readiness(wrapper, consumer({ state: 'warn', detail: '73' })),
					false,
				);
				assert.strictEqual(
					refresh_readiness(null, consumer({ state: 'ok', detail: '2' })),
					false,
					'no root',
				);
				assert.strictEqual(refresh_readiness(wrapper, null), false, 'no consumer');
			} finally {
				wrapper.remove();
			}
		});

		it('backup_waiver_check is the one predicate, and it is scoped', () => {
			const consumer = (backup) => ({
				checks: [
					{ id: 'superuser', state: 'ok' },
					{ id: 'backup_fresh', state: backup.state, detail: backup.detail },
				],
			});

			assert.isNull(
				backup_waiver_check(consumer({ state: 'ok', detail: '2' })),
				'a fresh backup needs no waiver',
			);
			assert.isNotNull(
				backup_waiver_check(consumer({ state: 'warn', detail: '73' })),
				'a stale one does',
			);
			assert.isNotNull(
				backup_waiver_check(consumer({ state: 'unknown', detail: 'boom' })),
				'so does an unmeasurable one',
			);
			assert.isNull(
				backup_waiver_check({ checks: [{ id: 'staging_clean', state: 'warn' }] }),
				'a non-waivable warning is not a waiver',
			);
			assert.isNull(backup_waiver_check(null), 'no payload, no waiver');
			assert.isNull(backup_waiver_check({}), 'no checks, no waiver');
		});
	});

	describe('folded status (the action in view, the reference facts one click away)', () => {
		// the folds remember the operator's choice under the REAL keys: save
		// and restore whatever this origin held, never leave a test value behind
		const FOLD_KEYS = ['installation', 'checks', 'last_update', 'restore_points'].map(
			(key) => 'dedalo.update_code.fold.' + key,
		);
		const saved = {};
		const read_key = (key) => {
			try {
				return localStorage.getItem(key);
			} catch (_error) {
				return null;
			}
		};
		before(() => {
			FOLD_KEYS.forEach((key) => {
				saved[key] = read_key(key);
				try {
					localStorage.removeItem(key);
				} catch (_error) {
					/* private mode */
				}
			});
		});
		after(() => {
			FOLD_KEYS.forEach((key) => {
				try {
					saved[key] === null
						? localStorage.removeItem(key)
						: localStorage.setItem(key, saved[key]);
				} catch (_error) {
					/* private mode */
				}
			});
		});

		const consumer = (last_status) => ({
			ready: true,
			engine: { engine_version: '7.0.0' },
			tree: {},
			checks: [
				{ id: 'superuser', state: 'ok' },
				{ id: 'disk_space', state: 'unknown', detail: '1024' },
				{ id: 'staging_clean', state: 'warn' },
				{ id: 'backup_fresh', state: 'warn', detail: '73' },
			],
			last_update: { previousVersion: '7.0.0', version: '7.0.1', stamp: 'x', status: last_status },
			restore_points: [],
		});
		const render = (c) => {
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			render_consumer_status(wrapper, c);
			return wrapper;
		};

		it('only what needs attention stays unfolded; the complete list is folded with counts', () => {
			const wrapper = render(consumer('confirmed'));
			try {
				assert.isNull(
					wrapper.querySelector('.attention_checks'),
					'nothing blocks: no row in view, warnings included',
				);
				const all = wrapper.querySelector('details.fold_checks');
				assert.ok(all, 'the complete list is a fold');
				assert.isFalse(all.open, 'folded by default');
				assert.strictEqual(
					all.querySelectorAll('.check_row').length,
					3,
					'complete, minus backup_fresh',
				);
				assert.include(
					all.querySelector('summary').textContent,
					'1',
					'its summary counts the states',
				);
				// every other block folds too, on its one-line hint
				assert.isFalse(wrapper.querySelector('details.fold_installation').open);
				assert.include(
					wrapper.querySelector('details.fold_installation summary').textContent,
					'7.0.0',
				);
				assert.isFalse(
					wrapper.querySelector('details.fold_last_update').open,
					'a confirmed update folds',
				);
			} finally {
				wrapper.remove();
			}
		});

		// `toggle` is QUEUED: wait for it (the widget's own listener, registered
		// first, has run by then) before reading what was stored
		const toggled = (details) =>
			new Promise((resolve) => {
				details.addEventListener('toggle', resolve, { once: true });
			});

		it('a fold opened by the operator is opened again on the next render', async () => {
			const first = render(consumer('confirmed'));
			try {
				const details = first.querySelector('details.fold_installation');
				const done = toggled(details);
				details.querySelector('summary').click();
				await done;
				assert.strictEqual(
					read_key('dedalo.update_code.fold.installation'),
					'1',
					'the click is remembered',
				);
			} finally {
				first.remove();
			}
			const second = render(consumer('confirmed'));
			try {
				const details = second.querySelector('details.fold_installation');
				assert.isTrue(details.open, 'reopened from memory');
				// the render's own queued toggle is skipped, not stored
				await toggled(details);
				assert.strictEqual(read_key('dedalo.update_code.fold.installation'), '1');
				const done = toggled(details);
				details.querySelector('summary').click();
				await done;
				assert.strictEqual(
					read_key('dedalo.update_code.fold.installation'),
					'0',
					'and closing is remembered too',
				);
			} finally {
				second.remove();
			}
		});

		it('an unconfirmed last update is shown open, without overwriting the preference', async () => {
			const wrapper = render(consumer('pending'));
			try {
				const details = wrapper.querySelector('details.fold_last_update');
				assert.isTrue(details.open, 'pending needs no click to be seen');
				await toggled(details);
				assert.isNull(
					read_key('dedalo.update_code.fold.last_update'),
					'forced open is not a stored choice',
				);
			} finally {
				wrapper.remove();
			}
		});
	});

	describe('image channel (a container installation)', () => {
		// consumer.image as the server sends it (core/update/image_channel.ts):
		// facts and ids only — the words are the client's.
		const image_block = (host_state, request) => ({
			source: {
				mode: 'pull',
				repository: 'ghcr.io/test/dedalo',
				official: { id: 'mirror_x', label: 'Test Mirror', role: 'mirror' },
			},
			update_command: { program: 'deploy/dedalo-image-update.sh', version_flag: '--version' },
			host_updater: {
				state: host_state,
				seen_at: host_state === 'absent' ? null : '2026-10-09T11:59:00.000Z',
				interval_seconds: host_state === 'absent' ? null : 60,
				mode: host_state === 'absent' ? null : 'pull',
				image: host_state === 'absent' ? null : 'ghcr.io/test/dedalo',
				pinned: host_state === 'absent' ? null : '9.9.9',
				verify: host_state === 'absent' ? null : 'cosign',
				running_digest: null,
			},
			request: request || null,
			last_outcome: {
				schema: 1,
				request_id: null,
				from: '9.9.8',
				to: '9.9.9',
				mode: 'pull',
				image: 'ghcr.io/test/dedalo',
				status: 'rolled_back',
				detail: 'health_timeout',
				backup: null,
				digest: null,
				started_at: null,
				finished_at: null,
				recorded_at: '2026-10-09T10:00:00.000Z',
			},
		});
		const consumer = (image) => ({
			engine: { version: '9.9.9', engine_version: '9.9.9', posture: 'release' },
			ready: false,
			checks: [
				{ id: 'channel', state: 'blocked', detail: 'image' },
				{ id: 'superuser', state: 'ok' },
			],
			restore_points: [],
			tree: {},
			image: image,
		});
		const PENDING = {
			id: '0b9f1c2e-6d4a-4c1b-9a8e-3f2d1c0b9a8e',
			tag: '9.9.10',
			version: '9.9.10',
			channel: 'master',
			from_version: '9.9.9',
			requested_at: '2026-10-09T11:58:00.000Z',
			requested_by: -1,
			state: 'requested',
			claimed_at: null,
		};
		const build_self = (image) => {
			const self = new update_code();
			self.id = 'test_update_code_image';
			self.value = { servers: [], is_a_code_server: false, consumer: consumer(image) };
			self.caller = null;
			self.events_tokens = [];
			return self;
		};
		const versions_info = {
			info: { version: '9.9.10', host: 'code.example.test', entity: 'Test' },
			files: [
				{
					version: '9.9.10',
					url: 'https://code.example.test/9.9.10.zip',
					date: '2026-10-09',
					notes: {
						date: '2026-10-08',
						action_needed: ['Rename DEDALO_X to DEDALO_Y.'],
						entries: [{ type: 'fixed', audience: 'user', title: 'Search is faster.' }],
					},
				},
				{
					version: '9.9.9',
					url: 'https://code.example.test/9.9.9-dev.zip',
					date: '2026-10-09',
					channel: 'dev',
				},
			],
		};
		const open_modal = (self) => {
			const body_response = ui.create_dom_element({ element_type: 'div', parent: container });
			return {
				modal: render_info_modal(self, versions_info, body_response),
				body_response: body_response,
			};
		};
		const close = (opened) => {
			if (opened.modal && typeof opened.modal.close === 'function') {
				opened.modal.close();
			}
			opened.body_response.remove();
		};

		it('renders the Image updates block and folds the tree-swap readiness without a verdict', () => {
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			try {
				let cancelled = null;
				render_consumer_status(wrapper, consumer(image_block('alive', PENDING)), null, null, {
					on_cancel: (request) => {
						cancelled = request;
					},
				});
				const block = wrapper.querySelector('.image_updates');
				assert.ok(block, 'the image block is rendered');
				assert.include(block.textContent, 'ghcr.io/test/dedalo', 'the repository is stated');
				assert.include(block.textContent, 'Test Mirror', 'the official registry is named');
				assert.ok(block.querySelector('.host_updater_alive'), 'the host updater state is shown');
				assert.ok(block.querySelector('.image_outcome_rolled_back'), 'the last outcome is shown');
				assert.include(
					block.textContent,
					'health_timeout',
					'the outcome detail is the id, as text',
				);
				// the pending request, with its Cancel
				const cancel = block.querySelector(
					'.image_request_requested button.button_cancel_image_request',
				);
				assert.ok(cancel, 'an unclaimed request can be cancelled');
				cancel.click();
				assert.strictEqual(cancelled && cancelled.id, PENDING.id);
				// no "Update blocked" headline over an installation whose path is open
				assert.isNull(
					wrapper.querySelector('.status_verdict'),
					'no readiness verdict on an image install',
				);
				const folded = wrapper.querySelector('details.fold_tree_swap_readiness');
				assert.ok(folded, 'the tree-swap checks are folded under their own title');
				assert.ok(
					folded.classList.contains('all_checks_block'),
					'refresh_readiness can still find it',
				);
				// …and refresh_readiness re-states the folded variant in place
				assert.isTrue(refresh_readiness(wrapper, consumer(image_block('alive'))));
				assert.isNull(wrapper.querySelector('.status_verdict'));
			} finally {
				wrapper.remove();
			}
		});

		it('a claimed request has no Cancel; an absent host updater says how to run updates', () => {
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			try {
				render_consumer_status(
					wrapper,
					consumer(
						image_block('absent', {
							...PENDING,
							state: 'claimed',
							claimed_at: '2026-10-09T11:59:00.000Z',
						}),
					),
					null,
					null,
					{ on_cancel: () => {} },
				);
				assert.isNull(
					wrapper.querySelector('.button_cancel_image_request'),
					'claimed: nothing to cancel',
				);
				assert.ok(wrapper.querySelector('.host_updater_absent'));
				assert.ok(
					wrapper.querySelector('.host_updater_note'),
					'the absent state explains the alternative',
				);
			} finally {
				wrapper.remove();
			}
		});

		it('a tree-swap installation renders no image block at all', () => {
			const wrapper = ui.create_dom_element({ element_type: 'div', parent: container });
			try {
				// a tree-swap status carries NO image key at all (not image: undefined)
				const { image: _image, ...plain } = consumer(undefined);
				render_consumer_status(wrapper, plain);
				assert.isNull(wrapper.querySelector('.image_updates'));
				assert.ok(
					wrapper.querySelector('.status_verdict'),
					'the headline verdict stays on a tree-swap install',
				);
			} finally {
				wrapper.remove();
			}
		});

		it('the modal shows the notes, the command for the selected release, and no in-container Update', () => {
			const opened = open_modal(build_self(image_block('stale')));
			try {
				const notes = opened.modal.querySelector('.release_notes');
				assert.ok(notes, 'the published release shows its notes');
				assert.isTrue(notes.open, 'an action needed opens the notes by itself');
				assert.include(notes.textContent, 'Rename DEDALO_X to DEDALO_Y.');
				assert.include(notes.textContent, 'Search is faster.');
				assert.strictEqual(
					opened.modal.querySelectorAll('.release_notes').length,
					1,
					'the dev item carries none',
				);

				const command = opened.modal.querySelector('.image_command');
				assert.ok(command, 'the host command is shown');
				assert.strictEqual(command.textContent, './deploy/dedalo-image-update.sh --version 9.9.10');
				assert.isNull(
					opened.modal.querySelector('button.success:not(.button_request_image_update)'),
					'no in-container Update button',
				);
				assert.isNull(
					opened.modal.querySelector('.button_request_image_update'),
					'no request button while the host updater is not alive',
				);
				assert.isNull(
					opened.modal.querySelector('.waive_backup_row'),
					'no backup waiver: the host script takes the backup',
				);

				// selecting the developer item re-states the command with its -dev tag
				const radios = opened.modal.querySelectorAll('input[type="radio"]');
				radios[1].checked = true;
				radios[1].dispatchEvent(new Event('change'));
				assert.strictEqual(
					command.textContent,
					'./deploy/dedalo-image-update.sh --version 9.9.9-dev',
				);
			} finally {
				close(opened);
			}
		});

		it('"Request this update" appears only when the host updater is alive and nothing is pending', () => {
			const alive = open_modal(build_self(image_block('alive')));
			try {
				assert.ok(
					alive.modal.querySelector('.button_request_image_update'),
					'alive and idle: offered',
				);
			} finally {
				close(alive);
			}
			const pending = open_modal(build_self(image_block('alive', PENDING)));
			try {
				assert.isNull(
					pending.modal.querySelector('.button_request_image_update'),
					'a request is pending: not offered',
				);
			} finally {
				close(pending);
			}
		});

		it('the command is composed only from a strict X.Y.Z version (it is pasted into a root shell)', () => {
			const image = image_block('alive');
			assert.strictEqual(
				image_update_command(image, { version: '9.9.10' }),
				'./deploy/dedalo-image-update.sh --version 9.9.10',
			);
			assert.strictEqual(
				image_update_command(image, { version: '9.9.10', channel: 'dev' }),
				'./deploy/dedalo-image-update.sh --version 9.9.10-dev',
			);
			assert.isNull(image_update_command(image, { version: '9.9.10; rm -rf /' }));
			assert.isNull(image_update_command(image, { version: '$(id)' }));
			assert.isNull(image_update_command({}, { version: '9.9.10' }), 'no program fact, no command');
		});

		it('a PRERELEASE item installs its own identity tag, never the stable image of its triple', () => {
			const image = image_block('alive');
			// version is the bare DATA triple; the image is the identity's (`:9.9.10-beta.2`)
			assert.strictEqual(
				image_update_command(image, {
					version: '9.9.10',
					channel: 'prerelease',
					release: '9.9.10-beta.2',
				}),
				'./deploy/dedalo-image-update.sh --version 9.9.10-beta.2',
			);
			// a malformed identity is no command at all — never a fallback to `:9.9.10`
			assert.isNull(image_update_command(image, { version: '9.9.10', channel: 'prerelease' }));
			assert.isNull(
				image_update_command(image, {
					version: '9.9.10',
					channel: 'prerelease',
					release: '9.9.10-beta.2; id',
				}),
			);
		});
	});

	describe('phase reducer (served module)', () => {
		it('a restart-phase interruption switches to health polling; a pre-swap one is indeterminate', () => {
			assert.strictEqual(UPDATE_PHASES[UPDATE_PHASES.length - 1], 'health');

			let state = init_phase_state('9.9.9');
			state = apply_phase_frame(state, {
				phase: 'restart',
				phases: [
					{ id: 'swap', status: 'done' },
					{ id: 'restart', status: 'running' },
				],
			});
			state = apply_phase_frame(state, { interrupted: true });
			assert.strictEqual(state.mode, 'polling');

			// pre-swap the stream's death says nothing about the job: the server
			// side may still be running → 'interrupted', never 'failed'
			let dead = init_phase_state('9.9.9');
			dead = apply_phase_frame(dead, {
				phase: 'extract',
				phases: [{ id: 'extract', status: 'running' }],
			});
			dead = apply_phase_frame(dead, { interrupted: true });
			assert.strictEqual(dead.mode, 'interrupted');

			// only a frame that actually reports a failed phase says failed
			let failed = init_phase_state('9.9.9');
			failed = apply_phase_frame(failed, {
				phase: 'verify',
				phases: [{ id: 'verify', status: 'failed' }],
				message: 'checksum mismatch',
			});
			assert.strictEqual(failed.mode, 'failed');
		});
	});

	// keep the ui import honest (build_wrapper_edit path is exercised elsewhere)
	void ui;
});

// THE UPDATE_ONTOLOGY IMPORT FILE LIST (Phase 2 of the update panel). The
// master's manifest declares each ontology's `dependencies` ({tld, main,
// mandatory}); the import records them on the registry row (hierarchy60) so
// this server re-serves them (WC-2026-10-10-ontology-dependencies-hierarchy60).
// The panel is the only thing between the manifest and the import, so the
// forward is pinned here on the SHIPPED builder: declared → forwarded
// unchanged (an empty list is a declaration too); absent → no key at all
// (absent ≠ []: [] would record "declares none"). Backend-free.
describe('SERVE_CODE panel (published release, blocks, builds; the rest under Details)', () => {
	const container = document.getElementById('content');

	const code_server = (checks, releases) => ({
		ready: !checks.some((check) => check.state === 'blocked'),
		checks: checks,
		source: {
			release_ref: 'v9.9.9',
			release_version: '9.9.9',
			dev_ref: 'master',
			dev_version: '9.9.10',
			branch: 'master',
		},
		releases: releases,
		advertises: { for_version: '9.9.9', files: [], rungs: [] },
	});
	const render = async (value) => {
		const self = new serve_code();
		self.id = 'test_serve_code';
		self.value = value;
		self.caller = null;
		self.events_tokens = [];
		const content_data = await self.list({ render_level: 'content' });
		container.appendChild(content_data);
		return content_data;
	};

	it('the published release heads the panel; only blocks stay in view, with their fix', async () => {
		const content_data = await render({
			is_a_code_server: true,
			code_server: code_server(
				[
					{ id: 'git_dir', state: 'ok', detail: '/srv/git' },
					{ id: 'advertised_origin', state: 'blocked', detail: 'localhost' },
					{ id: 'worktree_clean', state: 'warn' },
				],
				[
					{
						channel: 'master',
						version: '9.9.9',
						file: '9.9.9.zip',
						bytes: 1024,
						stamp: Date.now(),
					},
				],
			),
		});
		try {
			const status = content_data.querySelector('.code_server_status');
			assert.strictEqual(
				status.firstElementChild.classList.contains('published_version'),
				true,
				'the version heads the panel',
			);
			assert.strictEqual(status.querySelector('.published_version_value').textContent, '9.9.9');

			const attention = status.querySelectorAll('.readiness_block .attention_checks .check_row');
			assert.strictEqual(attention.length, 1, 'only the blocked check is in view');
			assert.ok(attention[0].querySelector('.check_fix_steps li'), 'with numbered fix steps');

			assert.strictEqual(
				status.querySelectorAll('.build_row').length,
				3,
				'the three build rows stay in view',
			);
			assert.strictEqual(
				status.querySelector('.build_row').closest('details'),
				null,
				'never folded',
			);

			const details = status.querySelector('details.serve_details');
			assert.ok(details, 'one Details fold');
			assert.strictEqual(details.open, false, 'closed');
			assert.strictEqual(
				details.querySelectorAll('.fold_serve_checks .check_row').length,
				3,
				'every check inside',
			);
			assert.ok(details.querySelector('.fold_serve_source'), 'build source inside');
			assert.ok(details.querySelector('.fold_serve_refs'), 'tags inside');
			assert.ok(details.querySelector('.fold_serve_offered'), 'offer inside');
		} finally {
			content_data.remove();
		}
	});

	it('nothing published says so, in words', async () => {
		const content_data = await render({
			is_a_code_server: true,
			code_server: code_server([{ id: 'git_dir', state: 'ok' }], []),
		});
		try {
			const value = content_data.querySelector('.published_version_value');
			assert.isTrue(value.classList.contains('none'));
			assert.notStrictEqual(value.textContent, '', 'a sentence, not blank');
			assert.strictEqual(
				content_data.querySelector('.readiness_block .attention_checks'),
				null,
				'nothing blocks: no attention list',
			);
		} finally {
			content_data.remove();
		}
	});
}); //end SERVE_CODE panel

describe('UPDATE_ONTOLOGY import file list (build_import_files)', () => {
	const manifest = () => ({
		files: [
			{ tld: 'zzb', url: 'zzb.copy.gz' },
			{ tld: 'matrix_dd', url: 'matrix_dd.copy.gz' },
			{ tld: 'zza', url: 'zza.copy.gz' },
			{ tld: 'zzc', url: 'zzc.copy.gz' },
			{ tld: 'zzskip', url: 'zzskip.copy.gz' },
		],
		info: {
			active_ontologies: [
				{
					tld: 'zza',
					typology_id: 1,
					name_data: { 'lg-eng': 'A' },
					dependencies: [{ tld: 'zzb', main: 'zzb1', mandatory: true }],
				},
				{ tld: 'zzb', typology_id: 2, name_data: { 'lg-eng': 'B' } },
				{ tld: 'zzc', typology_id: 3, name_data: { 'lg-eng': 'C' }, dependencies: [] },
				{
					tld: 'zzskip',
					typology_id: 4,
					name_data: { 'lg-eng': 'S' },
					dependencies: [{ tld: 'zza', main: 'zza1', mandatory: false }],
				},
			],
		},
	});

	it('matrix_dd first, then exactly the selected TLDs, enriched from the manifest info', () => {
		const files = build_import_files(manifest(), ['zza', 'zzb', 'zzc']);
		assert.deepEqual(
			files.map((file) => file.tld),
			['matrix_dd', 'zzb', 'zza', 'zzc'],
		);
		const zza = files.find((file) => file.tld === 'zza');
		assert.strictEqual(zza.typology_id, 1);
		assert.deepEqual(zza.name_data, { 'lg-eng': 'A' });
		assert.strictEqual(zza.url, 'zza.copy.gz');
		// matrix_dd is imported once, first, even when the operator also typed it
		assert.deepEqual(
			build_import_files(manifest(), ['matrix_dd', 'zza']).map((file) => file.tld),
			['matrix_dd', 'zza'],
		);
	});

	it('declared dependencies reach the import UNCHANGED; an empty declaration stays []', () => {
		const files = build_import_files(manifest(), ['zza', 'zzb', 'zzc']);
		assert.deepEqual(files.find((file) => file.tld === 'zza').dependencies, [
			{ tld: 'zzb', main: 'zzb1', mandatory: true },
		]);
		assert.deepEqual(files.find((file) => file.tld === 'zzc').dependencies, []);
	});

	it('an ontology that declares none sends NO dependencies key (absent ≠ [])', () => {
		const files = build_import_files(manifest(), ['zza', 'zzb', 'zzc']);
		assert.isFalse(
			Object.hasOwn(
				files.find((file) => file.tld === 'zzb'),
				'dependencies',
			),
		);
		assert.isFalse(
			Object.hasOwn(
				files.find((file) => file.tld === 'matrix_dd'),
				'dependencies',
			),
		);
	});

	it('the manifest it was given is not mutated', () => {
		const given = manifest();
		build_import_files(given, ['zza', 'zzb', 'zzc']);
		assert.deepEqual(given, manifest());
	});
});

// The ontology update is an UPDATE RUN that refuses without a recent backup;
// the panel's waive-backup checkbox is the operator's journaled escape hatch.
// A box the server never hears about is decoration: this drives the REAL
// rendered form (area_maintenance init_form) through a real submit and reads
// the options bag the widget's update_ontology receives. Backend-free: the
// manifest fetch is answered at the transport, the import itself is stubbed.
describe('UPDATE_ONTOLOGY waive-backup control', () => {
	const build_self = () => {
		const self = {
			id: 'update_ontology',
			events_tokens: [],
			value: {
				current_ontology: {},
				active_ontology_tlds: ['zza'],
				servers: [
					{
						name: 'master',
						url: 'https://m.example/dedalo/core/api/v1/json/',
						code: 'c',
						response_code: 200,
						result: { ok: true, data: true },
					},
				],
			},
			sent: [],
			form: null,
		};
		self.caller = {
			init_form: (widget_object) => {
				self.form = area_maintenance.prototype.init_form(widget_object);
				return self.form;
			},
		};
		self.update_ontology = async (options) => {
			self.sent.push(options);
			self.answered?.();
			return { ok: true, data: true, msg: 'OK' };
		};
		return self;
	};

	const submit_once = async (self) => {
		const answered = new Promise((resolve) => {
			self.answered = resolve;
		});
		self.form.dispatchEvent(new Event('submit', { cancelable: true }));
		await Promise.race([
			answered,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('update_ontology was never called')), 5000),
			),
		]);
	};

	it('the checkbox state travels as waive_backup (ticked → true, untouched → false)', async () => {
		const self = build_self();
		const original_fetch = window.fetch;
		const original_confirm = window.confirm;
		window.fetch = async () =>
			new Response(
				JSON.stringify({
					ok: true,
					data: {
						files: [
							{ tld: 'matrix_dd', url: 'matrix_dd.copy.gz' },
							{ tld: 'zza', url: 'zza.copy.gz' },
						],
						info: { version: '7.0.0', active_ontologies: [] },
					},
				}),
				{ headers: { 'Content-Type': 'application/json' } },
			);
		window.confirm = () => true;
		try {
			await render_update_ontology.prototype.list.call(self, { render_level: 'content' });
			assert.ok(self.form, 'the real form rendered');
			const check = self.form.querySelector('input[type="checkbox"].waive_backup_check');
			assert.ok(check, 'the waive-backup checkbox is in the form');
			assert.strictEqual(check.checked, false, 'unticked by default');
			const tlds_input = self.form.querySelector('input[name="active_ontology_tlds"]');
			tlds_input.value = 'zza';
			self.value.servers[0].active = true;

			check.checked = true;
			await submit_once(self);
			check.checked = false;
			await submit_once(self);

			assert.strictEqual(self.sent.length, 2, 'both submits reached update_ontology');
			assert.strictEqual(self.sent[0].waive_backup, true, 'a ticked box travels as true');
			assert.strictEqual(
				self.sent[1].waive_backup,
				false,
				'an untouched box travels as false, never absent',
			);
			assert.deepEqual(
				self.sent[0].files.map((file) => file.tld),
				['matrix_dd', 'zza'],
				'the selection travels with it',
			);
		} finally {
			window.fetch = original_fetch;
			window.confirm = original_confirm;
			for (const token of self.events_tokens) event_manager.unsubscribe(token);
		}
	});
});

// @license-end
