/**
 * Unit gate: the TS-NATIVE server state (check_config widget flags +
 * ts_state.json) and its enforcement — maintenance mode refuses non-superuser
 * logins in the TS auth flow — plus the TS-native runtime_info panel (Bun
 * runtime info, in-memory cache clears, expired-session pruning; merged from
 * php_runtime — WC-030).
 * These surfaces are ENGINE-NATIVE by design: the PHP widgets write the PHP
 * install's config_core.php, which a coexisting TS server must not touch.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, readEnv } from '../../src/config/env.ts';
import {
	dispatchGetWidgetValue,
	dispatchWidgetRequest,
} from '../../src/core/area_maintenance/widgets/registry.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { login } from '../../src/core/security/auth.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	ensureSuiteLoginPassword,
	SUITE_LOGIN_PASSWORD,
} from '../../src/core/test_data/suite_login.ts';
import { requireSuiteMariadb, SUITE_MARIADB_DATABASES } from '../helpers/suite_mariadb.ts';

const STATE_PATH = readEnv('DEDALO_TS_STATE_PATH');
if (STATE_PATH === undefined) {
	// The preload (test/preload/session_db.ts) must have pointed the process at
	// a scratch state file — flipping maintenance_mode in the LIVE
	// ../private/ts_state.json puts a running production server into maintenance
	// mode, and a killed run leaves it there (S1-18 pattern).
	throw new Error(
		'server_state.test.ts: DEDALO_TS_STATE_PATH is not set — refusing to run against the live server state file (S1-18)',
	);
}

const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;

function call(widget: string, action: string, options: Record<string, unknown> = {}) {
	return dispatchWidgetRequest(ADMIN, { model: widget, action }, options) as unknown as Promise<
		Record<string, unknown>
	>;
}

/** The DedaloError a widget action rejected with (fails when it answered instead). */
async function refusedCall(
	widget: string,
	action: string,
	options: Record<string, unknown> = {},
): Promise<DedaloError> {
	try {
		await call(widget, action, options);
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error(`expected ${widget}.${action} to refuse, it answered`);
}

// check_config (get_value AND the catalog's eager value) audits the published
// languages, opening a pool per diffusion target the ontology declares: acquire the
// lane's suite MariaDB first (PUB-05) so those pools are proved to land there.
beforeAll(async () => {
	await requireSuiteMariadb(import.meta.path, SUITE_MARIADB_DATABASES());
}, 120_000); // a cold suite MariaDB lane installs and starts a server

afterAll(() => {
	// never leave runtime overrides behind
	setServerState({
		maintenance_mode: false,
		notification: false,
		areas_deny: null,
		areas_allow: null,
		menu_skip_tipos: null,
	});
});

describe('TS-native server state (check_config) + runtime panel (runtime_info)', () => {
	test('scratch seam: state writes land in the DEDALO_TS_STATE_PATH scratch file', () => {
		// Guard equivalent of session_store_reset_guard.test.ts (S1-18): the
		// preload plumbed the override BEFORE server_state.ts could touch the
		// live private file, and writes observably land on the scratch path.
		expect(STATE_PATH).not.toContain('private/ts_state.json');
		setServerState({ notification: 'scratch-seam probe' });
		expect(existsSync(STATE_PATH as string)).toBe(true);
		expect(getServerState().notification).toBe('scratch-seam probe');
		setServerState({ notification: false });
	});

	test('state flags round-trip through the widget handlers', async () => {
		const on = await call('check_config', 'set_maintenance_mode', { value: true });
		expect(on.data).toBe(true);
		expect(getServerState().maintenance_mode).toBe(true);

		const note = await call('check_config', 'set_notification', { value: 'Upgrading tonight' });
		expect(note.data).toBe(true);
		expect(getServerState().notification).toBe('Upgrading tonight');

		const off = await call('check_config', 'set_maintenance_mode', { value: false });
		expect(off.data).toBe(true);
		expect(getServerState().maintenance_mode).toBe(false);

		// PHP contract: non-bool maintenance value refuses
		const bad = await refusedCall('check_config', 'set_maintenance_mode', { value: 'yes' });
		expect(bad.code).toBe('maintenance.action_refused');
	});

	test('recovery_mode is retired: a legacy state file sheds it, the toggle is gone', async () => {
		// WC-2026-11-12-recovery-mode-retired — a ts_state.json written before keeps the key.
		writeFileSync(
			STATE_PATH as string,
			JSON.stringify({ maintenance_mode: false, recovery_mode: true }),
		);
		expect('recovery_mode' in getServerState()).toBe(false);
		setServerState({ notification: false });
		expect(readFileSync(STATE_PATH as string, 'utf8')).not.toContain('recovery_mode');
		const gone = await refusedCall('check_config', 'set_recovery_mode', { value: true });
		expect(gone.code).toBeDefined();
	});

	// BUILDS its credential: the old shape logged in with config.phpReference.*
	// (the APPLICATION install's password) against the suite database, whose seed
	// ships root with no password — one database's secret tried on another. No
	// oracle gating is needed any more, so the case always runs.
	test('maintenance mode refuses non-superuser logins; superuser passes', async () => {
		await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
		setServerState({ maintenance_mode: true });
		try {
			// a non-existent user under maintenance still gets the ambiguous
			// failure (the gate must not leak account existence)…
			const stranger = await login('no_such_user_zz', 'x', '127.0.0.1');
			expect(stranger.ok).toBe(false);

			// …and the SUPERUSER may still log in
			const root = await login('root', SUITE_LOGIN_PASSWORD, '127.0.0.1');
			expect(root.ok).toBe(true);
			expect(root.userId).toBe(-1);
		} finally {
			setServerState({ maintenance_mode: false });
		}
	});

	test('check_config.get_value reports the TS config sources + db status', async () => {
		const body = (await dispatchGetWidgetValue(ADMIN, {
			model: 'check_config',
		})) as unknown as Record<string, unknown>;
		const result = body.data as {
			db_status: Record<string, boolean>;
			config_sources: { name: string; required: boolean; exists: boolean }[];
			state: { maintenance_mode: boolean };
		};
		// db_status is the installer::get_db_status() OBJECT shape the byte-identical
		// client renderer (render_check_config.js) reads per-check — NOT a string, or
		// every row reads `undefined` and the panel paints red on a healthy DB.
		expect(typeof result.db_status).toBe('object');
		for (const key of [
			'config_db_name_check',
			'config_user_name_check',
			'config_pw_check',
			'config_information_check',
			'config_info_key_check',
			'config_check',
			'db_connection_check',
			'db_writable_check',
			'global_status',
		]) {
			expect(typeof result.db_status[key]).toBe('boolean');
		}
		// This test runs against a live, writable DB → connection + write probes pass.
		expect(result.db_status.db_connection_check).toBe(true);
		expect(result.db_status.db_writable_check).toBe(true);
		const env = result.config_sources.find((source) => source.name === '.env');
		expect(env?.required).toBe(true);
		// The panel reports the TRUTH of the file, not this machine's: a developer has
		// ../private/.env, a CI tier has none by design (env_guard --no-private-env).
		expect(env?.exists).toBe(existsSync(join(privateDir, '.env')));
		expect(typeof result.state.maintenance_mode).toBe('boolean');
		// The session store is reported at its REAL filename (dedalo_ts_sessions.sqlite,
		// or the DEDALO_SESSION_DB_PATH override) and is PRESENT — the old hardcoded
		// `sessions.sqlite` guess never existed and always painted the row absent.
		const sessionSource = result.config_sources.find((source) => source.name.endsWith('.sqlite'));
		expect(sessionSource?.exists).toBe(true);
	});

	test('check_config eagerValue pre-loads the folded-card payload (kills the false danger)', async () => {
		// The catalog pre-loads this onto the widget descriptor so the FOLDED
		// dashboard card paints from REAL status. A null payload would let
		// render_check_config re-derive danger-red from an empty db_status — the
		// exact bug this fixes (folded = red on a healthy install).
		const { widget } = await import('../../src/core/area_maintenance/widgets/check_config.ts');
		const value = (await widget.eagerValue?.()) as {
			db_status: Record<string, boolean>;
			config_sources: { name: string; exists: boolean }[];
			db_info: {
				identity: string;
				server: string | null;
				schema_ok: boolean | null;
				migration_level: number | null;
				pool: { in_use: number; max: number; waiters: number };
			} | null;
			runtime_mode: {
				maintenance: boolean;
				recovery: boolean;
				notification: boolean;
				diffusion_native: boolean;
				dev_mode: boolean;
			};
		} | null;
		expect(value).not.toBeNull();
		// db_status is the OBJECT shape (per-check booleans + global_status), never a
		// string — a string reads `undefined` on every *_check and paints red.
		expect(typeof value?.db_status.global_status).toBe('boolean');
		expect(value?.db_status.db_connection_check).toBe(true);
		expect(value?.db_status.db_writable_check).toBe(true);
		// WC-027 db_info: which DB + engine + schema/migration + pool. The pool gauge
		// is always present (module-level counters); the live-probe fields are filled
		// because the harness has a connected, writable DB (asserted above).
		expect(value?.db_info).not.toBeNull();
		expect(typeof value?.db_info?.identity).toBe('string');
		expect(value?.db_info?.pool.max).toBeGreaterThan(0);
		expect(typeof value?.db_info?.server).toBe('string');
		expect(typeof value?.db_info?.schema_ok).toBe('boolean');
		expect(typeof value?.db_info?.migration_level).toBe('number');
		// WC-027 runtime_mode: the "what mode am I in" strip — four booleans.
		for (const key of ['maintenance', 'notification', 'diffusion_native', 'dev_mode'] as const) {
			expect(typeof value?.runtime_mode[key]).toBe('boolean');
		}
	});

	test('runtime_info panel reports the Bun runtime; cache + session clears run', async () => {
		const body = (await dispatchGetWidgetValue(ADMIN, {
			model: 'runtime_info',
		})) as unknown as Record<string, unknown>;
		const info = (body.data as { info?: Record<string, unknown> }).info as Record<string, unknown>;
		expect(info.engine).toBe('bun');
		expect(String(info.version)).toBe(Bun.version);
		expect(Number(info.memory_rss)).toBeGreaterThan(0);

		// The clear goes through the invalidation HUB, so the report names the two
		// families rather than a hand-maintained cache list — a second list beside
		// the hub's is exactly how the UI-label dictionary went unflushed.
		const caches = await call('runtime_info', 'clear_cache_files');
		expect((caches.data as { cleared: string[] }).cleared).toEqual(['ontology_derived', 'tools']);

		// …and the hub only covers a cache that REGISTERED with it. The UI-label
		// dictionary is the one that proved this: it was cached, the panel said
		// 'labels', and a label deploy still needed a server restart.
		const { clearLabelsCache } = await import('../../src/core/labels/catalog.ts');
		const { isOntologyCacheClearerRegistered } = await import(
			'../../src/core/ontology/cache_invalidation.ts'
		);
		expect(isOntologyCacheClearerRegistered(clearLabelsCache)).toBe(true);

		const sessions = await call('runtime_info', 'clear_session_files');
		expect(typeof (sessions.data as { pruned: number }).pruned).toBe('number');
	});

	test('config_areas: runtime deny list edits the LIVE menu (guarded areas protected)', async () => {
		const { getMenuTreeDatalist } = await import('../../src/core/api/handlers/menu.ts');
		const before = await getMenuTreeDatalist();
		const beforeNodes = before.tree_datalist as unknown as { tipo: string; model?: string }[];
		const victim = beforeNodes.find(
			(node) => !['area_root', 'area_maintenance', 'area_admin'].includes(node.model ?? ''),
		);
		expect(victim).toBeDefined();
		try {
			// save a deny list containing the victim + a guarded area + an invalid tipo
			const guarded = await call('config_areas', 'save_config_areas', {
				areas_deny: [victim?.tipo, 'dd88', 'zz_not_a_tipo'],
				areas_allow: [],
			});
			const prepared = guarded.data as {
				areas_deny: string[];
				invalid: string[];
				removed_guarded: string[];
			};
			expect(prepared.areas_deny).toEqual([victim?.tipo as string]);
			expect(prepared.invalid).toContain('zz_not_a_tipo');
			expect(prepared.removed_guarded).toContain('dd88');
			// PHP save message (the client renders msg verbatim)
			expect(guarded.msg).toStartWith('OK. Configuration saved. Changes apply on the next request');
			expect(guarded.msg).toContain('Protected areas cannot be denied and were kept enabled.');
			expect(guarded.msg).toContain('Invalid tipos were ignored.');

			// the LIVE menu now excludes the denied area
			const after = await getMenuTreeDatalist();
			const afterNodes = after.tree_datalist as unknown as { tipo: string }[];
			expect(afterNodes.some((node) => node.tipo === victim?.tipo)).toBe(false);

			// panel reads the effective values back — and the `areas` catalog (PHP
			// area::get_all_areas) must STILL contain the denied node, flagged, or
			// the client renders its chip as "(unknown tipo)" and the search box can
			// never find it to re-enable it
			const panel = (await dispatchGetWidgetValue(ADMIN, {
				model: 'config_areas',
			})) as unknown as {
				data?: {
					areas_deny?: string[];
					writable?: boolean;
					areas?: { tipo: string; label: string; denied: boolean; allowed: boolean }[];
				};
			};
			expect(panel.data?.areas_deny).toEqual([victim?.tipo as string]);
			expect(panel.data?.writable).toBe(true);
			const deniedNode = panel.data?.areas?.find((area) => area.tipo === victim?.tipo);
			expect(deniedNode).toBeDefined();
			expect(deniedNode?.denied).toBe(true);
			expect(typeof deniedNode?.label).toBe('string');
		} finally {
			setServerState({ areas_deny: null, areas_allow: null });
		}
	});

	test('menu_skip_tipos: client contract — options.tipos in, result.tipos out, root areas guarded', async () => {
		// The catalog is the tipo source: a plain 'area' grouper (the skip
		// use-case) and a top-level area (must be rejected into `removed`).
		const catalog = (await dispatchGetWidgetValue(ADMIN, {
			model: 'menu_skip_tipos',
		})) as unknown as {
			data?: { areas?: { tipo: string; model: string }[]; skip_tipos?: string[] };
		};
		const areas = catalog.data?.areas ?? [];
		const grouper = areas.find((area) => area.model === 'area');
		const rootArea = areas.find((area) => area.model === 'area_activity');
		expect(grouper).toBeDefined();
		expect(rootArea).toBeDefined();
		try {
			// the byte-identical client sends `options.tipos` (menu_skip_tipos.js)…
			const saved = await call('menu_skip_tipos', 'save_menu_skip_tipos', {
				tipos: [grouper?.tipo, rootArea?.tipo, 'zz_bogus'],
			});
			// …and reflects `result.tipos` back into its chips (render_menu_skip_tipos.js)
			const result = saved.data as { tipos: string[]; invalid: string[]; removed: string[] };
			expect(result.tipos).toEqual([grouper?.tipo as string]);
			expect(result.invalid).toEqual(['zz_bogus']);
			expect(result.removed).toEqual([rootArea?.tipo as string]);
			expect(saved.msg).toStartWith('OK. Configuration saved. Changes apply on the next request');
			expect(saved.msg).toContain('Top-level areas cannot be skipped and were ignored.');
			expect(saved.msg).toContain('Invalid tipos were ignored.');

			// the list actually PERSISTED (the old handler read the wrong options
			// key and silently saved [])
			expect(getServerState().menu_skip_tipos).toEqual([grouper?.tipo as string]);

			// panel read-back: effective skip list + the catalog STILL contains the
			// skipped grouper (it is the label/search source for the widget's chips)
			const panel = (await dispatchGetWidgetValue(ADMIN, {
				model: 'menu_skip_tipos',
			})) as unknown as {
				data?: { skip_tipos?: string[]; areas?: { tipo: string }[]; writable?: boolean };
			};
			expect(panel.data?.skip_tipos).toEqual([grouper?.tipo as string]);
			expect(panel.data?.writable).toBe(true);
			expect(panel.data?.areas?.some((area) => area.tipo === grouper?.tipo)).toBe(true);
		} finally {
			setServerState({ menu_skip_tipos: null });
		}
	});
});
