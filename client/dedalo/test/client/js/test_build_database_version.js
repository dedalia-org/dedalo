// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/

/**
 * TEST_BUILD_DATABASE_VERSION
 * The install-database panel of the `build_database_version` maintenance widget
 * (WC-2026-11-26-build-database-version-panel).
 *
 * Pinned:
 *  - the pure helpers: the seed-state badge and the one-line release summary;
 *  - before the value loads (collapsed widget): only the intro — no readouts,
 *    no pickers and NO preflight request;
 *  - loaded: the source and output pickers, and a preflight for the default
 *    choice; a new pick re-runs it with that choice;
 *  - the Build button follows the preflight: enabled only on `ok`, and a failed
 *    check shows its exact fix.
 *
 * Backend-free: `data_manager.request` and the job-handle lookup are patched;
 * the value and report shapes are the ones test/unit/seed_panel_native.test.ts
 * pins on the server.
 */

import { build_database_version } from '../../../core/area_maintenance/widgets/build_database_version/js/build_database_version.js';
import {
	release_text,
	seed_state_badge,
} from '../../../core/area_maintenance/widgets/build_database_version/js/render_build_database_version.js';
import { data_manager } from '../../../core/common/js/data_manager.js';

// DOM container
const container = document.getElementById('content');

/** The server's panel value (build_database_version.ts getValue). */
const panel_value = () => {
	return {
		parts: { schema: 'install/db/seed', migrations: 15, core_tlds: ['dd', 'rsc', 'lg'] },
		sources: [
			{ id: 'master:zz_master', kind: 'master', location: 'https://zz-master.test' },
			{
				id: 'shipped',
				kind: 'shipped',
				location: 'install/import/ontology/7.0',
				release: { version: '7.0.0', date: '2026-11-25T19:36:25+01:00', host: 'zz-master.test' },
			},
		],
		default_source: 'master:zz_master',
		targets: [
			{ id: 'private', available: true, location: '/zz/private/seed_builds' },
			{ id: 'checkout', available: false, location: 'install/db/dedalo_install.pgsql.gz' },
		],
		checkout_seed: {
			file: 'install/db/dedalo_install.pgsql.gz',
			bytes: 1800000,
			release: { version: '7.0.0', date: '2026-11-25T19:36:25+01:00' },
			state: 'current',
			findings: [],
		},
		last_build: null,
	};
};

/** One preflight report (seed_panel.ts seedPreflight). */
const report = (ok) => {
	return {
		ok: ok,
		checks: [
			{ id: 'pg_tools', ok: true, detail: 'psql and pg_dump found' },
			ok
				? { id: 'database_role', ok: true, detail: 'may create databases' }
				: {
						id: 'database_role',
						ok: false,
						detail: "database user 'zz' may not create databases",
						fix: 'ALTER ROLE "zz" CREATEDB; -- ZZ_FIX_MARKER',
					},
		],
	};
};

const build_self = (value) => {
	const self = new build_database_version();
	self.id = 'test_build_database_version';
	self.model = 'build_database_version';
	self.value = value;
	self.caller = null;
	self.events_tokens = [];
	return self;
};

const render = async (self) => {
	const content_data = await self.list({ render_level: 'content' });
	container.appendChild(content_data);
	return content_data;
};

/**
 * Patch data_manager.request with a queue of answers (`sent` collects the
 * request bodies) and the job-handle lookup with "no running build".
 */
const patch_request = (answers) => {
	const original = data_manager.request;
	const original_local = data_manager.get_local_db_data;
	const sent = [];
	// the panel's remembered choice (render_build_database_version.js CHOICE_KEY): each test starts clean
	window.localStorage.removeItem('dedalo_seed_panel_choice');
	data_manager.request = async (options) => {
		sent.push(options.body);
		const next = answers.shift();
		if (next === undefined) {
			throw new Error('the panel sent more requests than the test answers');
		}
		return next;
	};
	data_manager.get_local_db_data = async () => undefined;
	return {
		sent: sent,
		restore: () => {
			data_manager.request = original;
			data_manager.get_local_db_data = original_local;
			window.localStorage.removeItem('dedalo_seed_panel_choice');
		},
	};
};
const ok = (data) => {
	return { ok: true, data: data };
};

const settle = async () => {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

describe('BUILD_DATABASE_VERSION WIDGET', function () {
	this.timeout(10000);

	describe('pure helpers', () => {
		it('seed_state_badge: current / stale / anything else', () => {
			assert.equal(seed_state_badge('current').cls, 'pill_ok');
			assert.equal(seed_state_badge('stale').cls, 'pill_warning');
			assert.equal(seed_state_badge('missing').cls, 'pill_danger');
			assert.equal(seed_state_badge(undefined).cls, 'pill_danger');
		});

		it('release_text: version · day · host, and a dash for nothing', () => {
			assert.equal(
				release_text({
					version: '7.0.0',
					date: '2026-11-25T19:36:25+01:00',
					host: 'zz-master.test',
				}),
				'7.0.0 · 2026-11-25 · zz-master.test',
			);
			assert.equal(
				release_text({ version: '7.0.0', date: '2026-11-25T19:36:25+01:00' }),
				'7.0.0 · 2026-11-25',
			);
			assert.equal(release_text(null), '—');
		});
	});

	describe('the panel', () => {
		it('not loaded yet: the intro only, and no preflight request', async () => {
			const patch = patch_request([]);
			try {
				const content_data = await render(build_self(undefined));
				await settle();
				assert.equal(patch.sent.length, 0, 'no request before the value loads');
				assert.isNull(content_data.querySelector('.seed_picker'));
				assert.isNull(content_data.querySelector('.button_build'));
				content_data.remove();
			} finally {
				patch.restore();
			}
		});

		it('loaded: pickers, a preflight for the default choice, Build enabled on ok', async () => {
			const patch = patch_request([ok(report(true)), ok(report(true))]);
			try {
				const content_data = await render(build_self(panel_value()));
				await settle();
				assert.equal(patch.sent.length, 1);
				assert.equal(patch.sent[0].source.action, 'seed_preflight');
				assert.deepEqual(patch.sent[0].options, { source: 'master:zz_master', target: 'private' });
				const sources = content_data.querySelectorAll('input[name="seed_source"]');
				assert.equal(sources.length, 2);
				const checkout = content_data.querySelector('input[name="seed_target"][value="checkout"]');
				assert.isTrue(checkout.disabled, 'an unavailable output is not selectable');
				assert.isFalse(content_data.querySelector('.button_build').disabled);

				// a new pick re-runs the preflight with it
				const shipped = content_data.querySelector('input[name="seed_source"][value="shipped"]');
				shipped.checked = true;
				shipped.dispatchEvent(new Event('change'));
				await settle();
				assert.equal(patch.sent.length, 2);
				assert.deepEqual(patch.sent[1].options, { source: 'shipped', target: 'private' });
				content_data.remove();
			} finally {
				patch.restore();
			}
		});

		it('the last choice survives a re-render; a stale or disabled one falls back to the default', async () => {
			const patch = patch_request([
				ok(report(true)),
				ok(report(true)),
				ok(report(true)),
				ok(report(true)),
			]);
			try {
				const first = await render(build_self(panel_value()));
				await settle();
				const shipped = first.querySelector('input[name="seed_source"][value="shipped"]');
				shipped.checked = true;
				shipped.dispatchEvent(new Event('change'));
				await settle();
				first.remove();

				// "reload": a fresh render preflights and checks the remembered pick
				const second = await render(build_self(panel_value()));
				await settle();
				assert.deepEqual(patch.sent[2].options, { source: 'shipped', target: 'private' });
				assert.isTrue(second.querySelector('input[name="seed_source"][value="shipped"]').checked);
				second.remove();

				// a remembered option the server no longer offers (or offers disabled) is ignored
				window.localStorage.setItem(
					'dedalo_seed_panel_choice',
					JSON.stringify({ source: 'master:gone', target: 'checkout' }),
				);
				const third = await render(build_self(panel_value()));
				await settle();
				assert.deepEqual(patch.sent[3].options, { source: 'master:zz_master', target: 'private' });
				third.remove();
			} finally {
				patch.restore();
			}
		});

		it('a failed check: Build stays disabled and the exact fix is shown', async () => {
			const patch = patch_request([ok(report(false))]);
			try {
				const content_data = await render(build_self(panel_value()));
				await settle();
				assert.isTrue(content_data.querySelector('.button_build').disabled);
				const fix = content_data.querySelector('.seed_fix');
				assert.isNotNull(fix);
				assert.include(fix.textContent, 'ZZ_FIX_MARKER');
				content_data.remove();
			} finally {
				patch.restore();
			}
		});
	});
});

// @license-end
