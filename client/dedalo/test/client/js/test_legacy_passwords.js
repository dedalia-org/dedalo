// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/

/**
 * TEST_LEGACY_PASSWORDS
 * The `legacy_passwords` maintenance widget (owner ruling 2026-11-19, T2 B1
 * follow-up D08-a; WC-2026-11-19-maintenance-legacy-passwords-widget): the
 * accounts still on a Dédalo v6 password, and their conversion from the server.
 *
 * Pinned:
 *  - the census the admin reads (and no count, no form, before the value loads);
 *  - nothing to convert → no form, no keys asked for;
 *  - CHECK sends a dry run with the typed values and walks the server's batches
 *    (`next_after`) to ONE summed report; CONVERT asks first, sends
 *    `execute: true`, and re-states the count from the server's recount;
 *  - accounts that could not be converted are listed by name, as TEXT;
 *  - the typed key values are never pre-filled, never kept on the instance and
 *    never written to browser storage;
 *  - a failed batch shows the server's error and keeps what was done before it.
 *
 * Backend-free: `data_manager.request` is patched; the server's value and
 * report shapes are the ones test/unit/legacy_password_migration.test.ts
 * pins on the real door.
 */

import {
	add_batch,
	empty_report,
	legacy_passwords,
	next_cursor,
} from '../../../core/area_maintenance/widgets/legacy_passwords/js/legacy_passwords.js';
import { data_manager } from '../../../core/common/js/data_manager.js';

// DOM container
const container = document.getElementById('content');

/** The typed keys of this test — markers no other text on the page contains. */
const INFORMATION = 'ZZ_TYPED_INFORMATION_5512';
const INFO_KEY = 'zz_typed_info_key_5512';

/** The server's panel value (legacy_passwords.ts get_value). */
const panel_value = (legacy) => {
	return {
		accounts: 12,
		argon2: 12 - legacy,
		legacy: legacy,
		command: 'bun run dedalo:migrate-passwords',
		default_info_key: 'my_entity',
		batch: 25,
	};
};

/** One server batch report (legacy_passwords.ts migrate). */
const batch_report = (extra) => {
	return {
		execute: false,
		accounts: 12,
		argon2: 7,
		legacy: 5,
		examined: 0,
		recoverable: 0,
		converted: 0,
		failed: 0,
		skipped: 0,
		remaining: 5,
		next_after: null,
		failed_accounts: [],
		...extra,
	};
};

const build_self = (value) => {
	const self = new legacy_passwords();
	self.id = 'test_legacy_passwords';
	self.model = 'legacy_passwords';
	self.value = value;
	self.caller = null;
	self.events_tokens = [];
	// the run re-states the panel through refresh(); the suite reads what it was
	// asked to do instead of rebuilding a whole widget host
	self.refreshed = [];
	self.refresh = async (options) => {
		self.refreshed.push(options);
		return true;
	};
	return self;
};

const render = async (self) => {
	const content_data = await self.list({ render_level: 'content' });
	container.appendChild(content_data);
	return content_data;
};

/**
 * Patch data_manager.request with a queue of answers; `sent` collects the
 * request bodies. Restored by the returned function.
 */
const patch_request = (answers) => {
	const original = data_manager.request;
	const sent = [];
	data_manager.request = async (options) => {
		sent.push(options.body);
		const next = answers.shift();
		if (next === undefined) {
			throw new Error('the widget asked for more batches than the server offered');
		}
		return next;
	};
	return {
		sent: sent,
		restore: () => {
			data_manager.request = original;
		},
	};
};
const ok = (data) => {
	return { ok: true, data: data };
};

const settle = async () => {
	// the click handler runs async; idle callbacks and microtasks settle
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const set_keys = (content_data) => {
	content_data.querySelector('input.information').value = INFORMATION;
	content_data.querySelector('input.info_key').value = INFO_KEY;
};

describe('LEGACY_PASSWORDS WIDGET', function () {
	this.timeout(10000);

	describe('the sum of a run (pure)', () => {
		it('batches add up; remaining is the last recount; a failed account is listed once', () => {
			const a = { section_id: 7, username: 'ana' };
			const b = { section_id: 9, username: 'ben' };
			let total = empty_report(true);
			total = add_batch(
				total,
				batch_report({
					examined: 2,
					recoverable: 1,
					converted: 1,
					failed: 1,
					remaining: 4,
					failed_accounts: [a],
				}),
			);
			total = add_batch(
				total,
				batch_report({
					examined: 3,
					recoverable: 2,
					converted: 1,
					skipped: 1,
					failed: 1,
					remaining: 3,
					failed_accounts: [a, b],
				}),
			);
			assert.deepEqual(total, {
				execute: true,
				batches: 2,
				examined: 5,
				recoverable: 3,
				converted: 2,
				failed: 2,
				skipped: 1,
				remaining: 3,
				failed_accounts: [a, b],
			});
		});

		it('the cursor only moves forward: a repeated or missing one ends the run', () => {
			assert.strictEqual(next_cursor(null, { next_after: 40 }), 40);
			assert.strictEqual(next_cursor(40, { next_after: 65 }), 65);
			assert.strictEqual(next_cursor(40, { next_after: 40 }), null, 'no progress: stop');
			assert.strictEqual(next_cursor(40, { next_after: 12 }), null, 'backwards: stop');
			assert.strictEqual(next_cursor(40, { next_after: null }), null, 'the server is done');
			assert.strictEqual(next_cursor(40, {}), null);
			assert.strictEqual(next_cursor(null, { next_after: '41' }), null, 'a number, nothing looser');
		});
	});

	describe('the panel', () => {
		it('the census: accounts, already converted, and the ones that cannot log in (danger)', async () => {
			const content_data = await render(build_self(panel_value(5)));
			try {
				const values = [...content_data.querySelectorAll('.legacy_passwords_census .dd_v')].map(
					(node) => node.textContent,
				);
				assert.deepEqual(values, ['12', '7', '5']);
				const legacy = content_data.querySelector('.dd_v.legacy_count');
				assert.include(legacy.className, 'state_danger');
				// the form: two EMPTY masked fields, never pre-filled from the server
				const inputs = [...content_data.querySelectorAll('.legacy_passwords_form input')];
				assert.deepEqual(
					inputs.map((input) => [input.name, input.type, input.value]),
					[
						['information', 'password', ''],
						['info_key', 'password', ''],
					],
				);
				assert.include(
					content_data.querySelector('input.info_key').placeholder,
					'my_entity',
					'what an empty info key stands for',
				);
				assert.include(
					content_data.querySelector('.legacy_passwords_cli_hint').textContent,
					'bun run dedalo:migrate-passwords',
					'the command line stays an option',
				);
				assert.ok(content_data.querySelector('button.legacy_passwords_check'));
				assert.ok(content_data.querySelector('button.legacy_passwords_convert'));
				assert.notInclude(content_data.textContent, '${', 'every placeholder is filled');
			} finally {
				content_data.remove();
			}
		});

		it('nothing to convert: says so, and asks for no keys', async () => {
			const content_data = await render(build_self(panel_value(0)));
			try {
				assert.ok(content_data.querySelector('.dd_note.state_ok.legacy_passwords_none'));
				assert.include(content_data.querySelector('.dd_v.legacy_count').className, 'state_ok');
				assert.isNull(content_data.querySelector('.legacy_passwords_form'));
				assert.isNull(content_data.querySelector('input'));
				assert.isNull(content_data.querySelector('button'));
			} finally {
				content_data.remove();
			}
		});

		it('before the value is loaded: no count and no form (never a guessed state)', async () => {
			const content_data = await render(build_self(null));
			try {
				assert.ok(content_data.querySelector('.legacy_passwords_lead'), 'the lead renders');
				assert.isNull(content_data.querySelector('.legacy_passwords_census'));
				assert.isNull(content_data.querySelector('.legacy_passwords_form'));
				assert.isNull(content_data.querySelector('.legacy_passwords_none'));
			} finally {
				content_data.remove();
			}
		});
	});

	describe('check (dry run)', () => {
		it('sends the typed values with execute:false, walks the batches, renders ONE summed report', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			const evil = { section_id: 31, username: '<img src=x onerror="window.__lp_xss=1">' };
			const patched = patch_request([
				ok(batch_report({ examined: 2, recoverable: 2, next_after: 20 })),
				ok(
					batch_report({
						examined: 2,
						recoverable: 1,
						failed: 1,
						next_after: 31,
						failed_accounts: [evil],
					}),
				),
				ok(batch_report({ examined: 1, recoverable: 1, next_after: null })),
			]);
			try {
				set_keys(content_data);
				content_data.querySelector('button.legacy_passwords_check').click();
				await settle();

				assert.strictEqual(patched.sent.length, 3, 'one request per batch');
				for (const body of patched.sent) {
					assert.strictEqual(body.dd_api, 'dd_area_maintenance_api');
					assert.strictEqual(body.action, 'widget_request');
					assert.deepEqual(body.source, {
						type: 'widget',
						model: 'legacy_passwords',
						action: 'migrate',
					});
					assert.strictEqual(body.options.execute, false, 'a check never writes');
					assert.strictEqual(body.options.information, INFORMATION);
					assert.strictEqual(body.options.info_key, INFO_KEY);
				}
				assert.deepEqual(
					patched.sent.map((body) => body.options.after),
					[undefined, 20, 31],
					'each batch starts where the previous one ended',
				);

				const report = content_data.querySelector('.legacy_passwords_report_text');
				assert.ok(report, 'the report renders');
				assert.include(report.className, 'state_warning', 'some could not be converted');
				for (const number of ['5', '4', '1']) {
					assert.include(report.textContent, number);
				}
				assert.notInclude(report.textContent, '${');
				// who could not be converted — as TEXT
				const item = content_data.querySelector('.legacy_passwords_failed_list li');
				assert.strictEqual(item.textContent, `${evil.username} (31)`);
				assert.isNull(item.querySelector('img'), 'an account name is never markup');
				assert.isUndefined(window.__lp_xss);
				assert.ok(content_data.querySelector('.legacy_passwords_failed_hint'));
				// a check changes no count and re-states nothing
				assert.deepEqual(self.refreshed, []);
				assert.strictEqual(self.value.legacy, 5);
			} finally {
				patched.restore();
				content_data.remove();
			}
		});

		it('the typed values are not kept: not on the instance, not in browser storage', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			const patched = patch_request([ok(batch_report({ examined: 5, recoverable: 5 }))]);
			try {
				set_keys(content_data);
				content_data.querySelector('button.legacy_passwords_check').click();
				await settle();
				const kept = JSON.stringify([self.value, self.last_report]);
				const stored = JSON.stringify([{ ...localStorage }, { ...sessionStorage }]);
				for (const secret of [INFORMATION, INFO_KEY]) {
					assert.notInclude(kept, secret, 'on the instance');
					assert.notInclude(stored, secret, 'in browser storage');
					assert.notInclude(content_data.textContent, secret, 'printed on the panel');
				}
				// FLOOR: the request did carry them (there was something to keep).
				assert.strictEqual(patched.sent[0].options.information, INFORMATION);
			} finally {
				patched.restore();
				content_data.remove();
			}
		});
	});

	describe('convert', () => {
		const with_confirm = async (answer, run) => {
			const original = window.confirm;
			const asked = [];
			window.confirm = (text) => {
				asked.push(text);
				return answer;
			};
			try {
				await run(asked);
			} finally {
				window.confirm = original;
			}
		};

		it('asks first — a refused confirmation sends nothing', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			const patched = patch_request([]);
			try {
				await with_confirm(false, async (asked) => {
					set_keys(content_data);
					content_data.querySelector('button.legacy_passwords_convert').click();
					await settle();
					assert.strictEqual(asked.length, 1, 'the operator was asked');
					assert.strictEqual(asked[0], get_label.legacy_passwords_confirm);
				});
				assert.deepEqual(patched.sent, [], 'nothing was sent');
				assert.deepEqual(self.refreshed, []);
			} finally {
				patched.restore();
				content_data.remove();
			}
		});

		it('confirmed: execute:true in every batch, and the panel is re-stated from the server recount', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			const stuck = { section_id: 44, username: 'old.account' };
			const patched = patch_request([
				ok(
					batch_report({
						execute: true,
						examined: 3,
						recoverable: 3,
						converted: 3,
						remaining: 2,
						next_after: 30,
					}),
				),
				ok(
					batch_report({
						execute: true,
						examined: 2,
						recoverable: 1,
						converted: 1,
						failed: 1,
						remaining: 1,
						next_after: null,
						failed_accounts: [stuck],
					}),
				),
			]);
			try {
				await with_confirm(true, async () => {
					set_keys(content_data);
					content_data.querySelector('button.legacy_passwords_convert').click();
					await settle();
				});
				assert.deepEqual(
					patched.sent.map((body) => [body.options.execute, body.options.after]),
					[
						[true, undefined],
						[true, 30],
					],
				);
				// the count is the server's recount, not arithmetic done here
				assert.strictEqual(self.value.legacy, 1);
				assert.strictEqual(self.value.argon2, 11);
				assert.strictEqual(self.value.accounts, 12);
				assert.deepEqual(self.refreshed, [{ build_autoload: false, destroy: true }]);
				assert.deepEqual(self.last_report.failed_accounts, [stuck]);
				assert.strictEqual(self.last_report.converted, 4);

				// …and the re-stated panel shows the new count with the run's report
				const again = await render(self);
				try {
					assert.strictEqual(again.querySelector('.dd_v.legacy_count').textContent, '1');
					assert.include(again.querySelector('.legacy_passwords_report_text').textContent, '4');
					assert.strictEqual(
						again.querySelector('.legacy_passwords_failed_list li').textContent,
						'old.account (44)',
					);
					// a fresh form: the typed values did not survive the run
					assert.strictEqual(again.querySelector('input.information').value, '');
					assert.strictEqual(again.querySelector('input.info_key').value, '');
				} finally {
					again.remove();
				}
			} finally {
				patched.restore();
				content_data.remove();
			}
		});

		it('a batch the server refuses: its sentence is shown, and what was converted before it stands', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			const patched = patch_request([
				ok(
					batch_report({
						execute: true,
						examined: 3,
						recoverable: 3,
						converted: 3,
						remaining: 2,
						next_after: 30,
					}),
				),
				{
					ok: false,
					error: {
						is_api_error: true,
						code: 'maintenance.action_refused',
						category: 'caller',
						message: 'Error. The batch was refused for this test.',
					},
				},
			]);
			try {
				await with_confirm(true, async () => {
					content_data.querySelector('button.legacy_passwords_convert').click();
					await settle();
				});
				assert.strictEqual(patched.sent.length, 2, 'the run stopped at the refusal');
				assert.include(
					content_data.querySelector('.body_response').textContent,
					'The batch was refused for this test',
				);
				assert.strictEqual(self.last_report.converted, 3, 'the first batch is not forgotten');
				assert.strictEqual(self.value.legacy, 2, 'nor is its recount');
				assert.deepEqual(self.refreshed, [], 'the error stays in view: no re-render over it');
				// buttons are usable again
				assert.isFalse(content_data.querySelector('button.legacy_passwords_check').disabled);
			} finally {
				patched.restore();
				content_data.remove();
			}
		});

		it('an answer that is no report is not an empty batch: the run stops and says so', async () => {
			const self = build_self(panel_value(5));
			const content_data = await render(self);
			// `data` present but not a report (and no error either)
			const patched = patch_request([ok(true), ok(batch_report({ examined: 5, converted: 5 }))]);
			try {
				await with_confirm(true, async () => {
					content_data.querySelector('button.legacy_passwords_convert').click();
					await settle();
				});
				assert.strictEqual(patched.sent.length, 1, 'no further batch was sent');
				assert.isNull(self.last_report, 'nothing is reported as done');
				assert.strictEqual(self.value.legacy, 5, 'the count is not touched');
				assert.deepEqual(self.refreshed, []);
				const said = content_data.querySelector('.body_response').textContent;
				assert.isAbove(said.length, 0, 'the panel says the run stopped');
				assert.notInclude(said, '${');
				assert.notMatch(said, /\b0\b.*\b0\b/, 'never a report of zeros');
			} finally {
				patched.restore();
				content_data.remove();
			}
		});
	});
});

// @license-end
