/**
 * TRIPWIRE — there is NO install surface on the wire, and a box that is not installed
 * REFUSES TO START (2026-10-12, terminal installer phase 5 —
 * engineering/wire_contract/WC-2026-10-12-install-surface-removed.md).
 *
 * WHY. Until this change a server on a fresh box booted on sentinels and served a
 * browser install wizard: two session-less actions (`dd_utils_api:get_install_context`,
 * `dd_utils_api:install`) whose steps rewrote `../private/.env`, spawned psql and
 * restarted the process, guarded only by a seal flag and an address allowlist. Every
 * route now installs through the terminal installer, so that surface is pure attack
 * surface. This gate holds the two OUTCOMES that keep it gone:
 *
 *  (a) THE ACTION TABLE. Enumerated from the real registry (listRegisteredActions), every
 *      (class, action) pair outside a FROZEN literal pre-auth allowlist (written here,
 *      never imported — importing NO_LOGIN_ACTIONS would let the gate follow a widening)
 *      is driven through the REAL dispatcher with no session and must answer
 *      `auth.not_logged`; NO_LOGIN_ACTIONS itself equals the frozen list. The two removed
 *      actions answer `request.unknown_action` with AND without a session (the Gate-1
 *      body: a probe cannot tell they ever existed). No ACTION_IDEMPOTENCY key names an
 *      unregistered pair. And the server's import closure reaches none of the modules that
 *      WRITE an install — the `.env` writer, the executor, its step table and runs — so a
 *      handler cannot grow a path back to them unseen.
 *  (b) THE BOOT. The real `src/server.ts` is SPAWNED with an environment built from
 *      scratch (no DB/ENTITY/DEDALO key inherited) against a scratch private dir, with the
 *      unix socket path AND the TCP port already held by this test and a counting listener
 *      standing in for Postgres. Not installed / sealed-but-no-.env / an unfinished
 *      install each exit NOT_INSTALLED_EXIT_CODE (78 — not 75, the restart code the
 *      supervisors respawn on, not 0, not 1) with the one refusal line, the held socket and
 *      port were never contested (a server that tried to bind would have died differently:
 *      the double-start guard / EADDRINUSE), the Postgres stand-in saw ZERO connections,
 *      and the scratch private dir is byte-identical afterwards. A PARTIAL config (1–3 of
 *      the 4 keys) is misconfigured, not unconfigured: it exits non-zero and neither 75
 *      nor 78 (the precise missing-key error).
 *
 * Hermetic: no database (the dispatcher refuses at the auth gate, before any handler; the
 * spawned server refuses before any import that could connect).
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOT_INSTALLED_EXIT_CODE } from '../../src/config/install_state.ts';
import {
	ACTION_IDEMPOTENCY,
	type ApiRequestContext,
	dispatchRqo,
	listRegisteredActions,
	NO_LOGIN_ACTIONS,
} from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { RESTART_EXIT_CODE } from '../../src/core/update/restart.ts';
import { REPO_ROOT, reachableModules } from '../helpers/request_path_closure.ts';
import { removeScratchDir, scratchDir } from '../helpers/scratch_dir.ts';

/**
 * THE pre-auth surface, frozen. Widening it is a security decision taken HERE, in the
 * same change, with its reason — never by adding a pair to NO_LOGIN_ACTIONS alone.
 */
const FROZEN_PRE_AUTH: readonly string[] = Object.freeze([
	'dd_utils_api:login',
	'dd_core_api:get_environment',
	'dd_core_api:start',
	'dd_utils_api:get_login_context',
	'dd_utils_api:change_lang',
	'dd_utils_api:request_password_reset',
	'dd_utils_api:confirm_password_reset',
	// gated pre-auth (Gate 1c: receiver flag + address allowlist), WC-017
	'dd_error_report_api:receive_report',
	'dd_utils_api:get_server_ready_status',
	'dd_utils_api:get_ontology_update_info',
	'dd_utils_api:get_code_update_info',
]);

/** The actions this change removed — they must never be routable again. */
const REMOVED = ['dd_utils_api:get_install_context', 'dd_utils_api:install'] as const;

/**
 * The `.env` writer and the step runs every install step goes through. The executor
 * and its step table import step_runs.ts, so a closure without step_runs.ts holds
 * neither of them either (an import closure is closed under import).
 */
const ENV_WRITER = 'src/core/install/config_persist.ts';
const STEP_RUNS_MODULE = 'src/core/install/step_runs.ts';

function anonymous(): ApiRequestContext {
	return { requestId: 'zznis', clientIp: 'local', session: null, csrfCandidate: null };
}

/** The error code a dispatch answered with, or null on success. */
async function codeOf(key: string, context: ApiRequestContext): Promise<string | null> {
	const [apiClass, action] = key.split(':') as [string, string];
	const result = await dispatchRqo({ dd_api: apiClass, action, options: {} } as Rqo, context);
	if (result.body.ok !== false) return null;
	return (result.body.error as { code: string }).code;
}

// ── (a) the action table ────────────────────────────────────────────────────

describe('no pre-auth install action exists (a)', () => {
	// Every refusal is logged by the dispatcher; ~80 of them are noise here, not signal.
	let quiet: ReturnType<typeof spyOn>[] = [];
	beforeEach(() => {
		quiet = [
			spyOn(console, 'error').mockImplementation(() => {}),
			spyOn(console, 'warn').mockImplementation(() => {}),
			spyOn(console, 'log').mockImplementation(() => {}),
			spyOn(console, 'info').mockImplementation(() => {}),
		];
	});
	afterEach(() => {
		for (const spy of quiet) spy.mockRestore();
	});
	const registered = listRegisteredActions().map((pair) => `${pair.apiClass}:${pair.action}`);

	test('the registry is real (anti-vacuity) and the pre-auth set is exactly the frozen list', () => {
		expect(registered.length).toBeGreaterThan(80);
		expect([...NO_LOGIN_ACTIONS].sort()).toEqual([...FROZEN_PRE_AUTH].sort());
	});

	test('every registered action outside the frozen list refuses a session-less request with auth.not_logged', async () => {
		const guarded = registered.filter((key) => !FROZEN_PRE_AUTH.includes(key));
		expect(guarded.length).toBeGreaterThan(70);
		const open: string[] = [];
		for (const key of guarded) {
			const code = await codeOf(key, anonymous());
			if (code !== 'auth.not_logged') open.push(`${key} → ${code ?? 'ok'}`);
		}
		expect(open, 'an action answered WITHOUT a session').toEqual([]);
	});

	test('the removed install actions are not registered: request.unknown_action, with or without a session', async () => {
		for (const key of REMOVED) expect(registered).not.toContain(key);
		const withSession: ApiRequestContext = {
			...anonymous(),
			session: { userId: -1 } as unknown as NonNullable<ApiRequestContext['session']>,
		};
		for (const key of REMOVED) {
			expect(await codeOf(key, anonymous()), key).toBe('request.unknown_action');
			// Gate 1 answers before any session is read: the fake session is never touched.
			expect(await codeOf(key, withSession), key).toBe('request.unknown_action');
		}
		// positive control: a registered guarded action is NOT unknown (Gate 1 discriminates)
		expect(await codeOf('dd_core_api:read', anonymous())).toBe('auth.not_logged');
	});

	test('no ACTION_IDEMPOTENCY key names an unregistered pair', () => {
		expect(ACTION_IDEMPOTENCY.size).toBeGreaterThan(80);
		const known = new Set(registered);
		expect([...ACTION_IDEMPOTENCY.keys()].filter((key) => !known.has(key))).toEqual([]);
	});

	test("the server's import closure reaches no module that writes an install", () => {
		const reachable = reachableModules().map((file) => file.slice(REPO_ROOT.length + 1));
		// anti-vacuity: the walk is real and it does enter src/core/install (Maintenance ›
		// Import hierarchies), so an absence below is a measured one
		expect(reachable.length).toBeGreaterThan(500);
		expect(reachable).toContain('src/core/install/hierarchy_import.ts');
		expect(reachable).not.toContain(ENV_WRITER);
		expect(reachable).not.toContain(STEP_RUNS_MODULE);
	});
});

// ── (b) the boot ────────────────────────────────────────────────────────────

const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_zznis_boot_'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * "Byte-identical afterwards", without a tree walk: the scratch private dir is FRESH and
 * flat, holding at most the two files a case plants. Its own mtime moves when ANY entry
 * is created or removed in it (a session store, a state file, a sub-directory), and the
 * two planted files are compared by content — together, every way a boot could write.
 */
function snapshot(dir: string): string {
	const digest = (name: string): string => {
		const path = join(dir, name);
		return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '-';
	};
	return `${statSync(dir).mtimeMs}|${digest('ts_state.json')}|${digest('.env')}`;
}

interface BootOutcome {
	exitCode: number | null;
	stderr: string;
	dbConnections: number;
	portContacts: number;
	socketStillOurs: boolean;
	privateUnchanged: boolean;
}

/**
 * Spawn the real server against a fresh scratch private dir. `env` (the four keys, or
 * none) and `state` (an install_status, or no state file) shape the box. The socket and
 * the TCP port are HELD by this process; a counting listener stands in for Postgres.
 */
async function boot(
	name: string,
	env: Record<string, string>,
	state: string | null,
	envFile: string | null = null,
): Promise<BootOutcome> {
	const root = join(SCRATCH, name);
	const privateDir = join(root, 'private');
	mkdirSync(privateDir, { recursive: true });
	const statePath = join(privateDir, 'ts_state.json');
	if (state !== null) writeFileSync(statePath, JSON.stringify({ install_status: state }));
	if (envFile !== null) writeFileSync(join(privateDir, '.env'), envFile);
	const before = snapshot(privateDir);

	let dbConnections = 0;
	const postgres = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { open: () => void dbConnections++, data: () => {} },
	});
	let portContacts = 0;
	const held = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { open: () => void portContacts++, data: () => {} },
	});
	// Short path: macOS caps a unix socket path at 104 bytes — a private
	// scratch dir of its own (never a guessable name in the shared temp dir).
	const socketDir = scratchDir('nis');
	const socketPath = join(socketDir, 's.sock');
	const heldSocket = Bun.listen({ unix: socketPath, socket: { data: () => {} } });

	try {
		const proc = Bun.spawn([process.execPath, 'src/server.ts'], {
			cwd: REPO_ROOT,
			// Built from scratch: nothing of this process's configuration leaks in.
			env: {
				PATH: Bun.env.PATH ?? '/usr/bin:/bin',
				HOME: root,
				TMPDIR: tmpdir(),
				DEDALO_PRIVATE_DIR: privateDir,
				DEDALO_TS_STATE_PATH: statePath,
				DEDALO_SESSION_DB_PATH: join(privateDir, 'sessions.sqlite'),
				SERVER_UNIX_SOCKET: socketPath,
				SERVER_TCP_PORT: String(held.port),
				DB_PORT: String(postgres.port),
				...env,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		// A server that did NOT refuse keeps running (a regression): kill it so the case
		// fails on its exit code instead of hanging the runner.
		const killer = setTimeout(() => proc.kill(), 20000);
		const exitCode = await proc.exited;
		clearTimeout(killer);
		const stderr = await new Response(proc.stderr).text();
		await Bun.sleep(50); // let any late connect attempt land on the counters
		return {
			exitCode,
			stderr,
			dbConnections,
			portContacts,
			socketStillOurs: statSync(socketPath).isSocket(),
			privateUnchanged: snapshot(privateDir) === before,
		};
	} finally {
		heldSocket.stop(true);
		held.stop(true);
		postgres.stop(true);
		removeScratchDir(socketDir);
	}
}

const KEYS = { ENTITY: 'zznis', DB_NAME: 'zznis', DB_HOST: '127.0.0.1', DB_USER: 'zznis' };

/** The assertions every REFUSED boot shares. */
function expectRefused(outcome: BootOutcome, sentence: string): void {
	expect(outcome.exitCode, outcome.stderr.slice(-1500)).toBe(NOT_INSTALLED_EXIT_CODE);
	expect([0, 1, RESTART_EXIT_CODE]).not.toContain(outcome.exitCode);
	expect(outcome.stderr).toContain('[boot] REFUSED — ');
	expect(outcome.stderr).toContain(sentence);
	expect(outcome.stderr.match(/\[boot\] REFUSED/g)?.length, 'ONE journal line').toBe(1);
	expect(outcome.dbConnections, 'no database connection attempted').toBe(0);
	expect(outcome.portContacts, 'the held TCP port was never contacted').toBe(0);
	expect(outcome.socketStillOurs, 'the held socket was not taken').toBe(true);
	expect(outcome.privateUnchanged, 'the private dir is byte-identical').toBe(true);
}

describe('a box that is not installed refuses to start (b)', () => {
	test('no keys, no state → exit 78, "not installed … dedalo:install", no listener, no write', async () => {
		const outcome = await boot('fresh', {}, null);
		expectRefused(outcome, 'not installed:');
		expect(outcome.stderr).toContain('dedalo:install');
	}, 30000);

	test('no keys, SEALED → exit 78, "restore .env from backup" (never "run the installer")', async () => {
		const outcome = await boot('sealed', {}, 'sealed');
		expectRefused(outcome, 'configuration missing:');
		expect(outcome.stderr).toContain('Restore .env from backup');
	}, 30000);

	test('no keys, a .env naming none of them → exit 78, "do not reinstall"', async () => {
		const outcome = await boot('incomplete', {}, null, 'DEDALO_SOME_OTHER_KEY=1\n');
		expectRefused(outcome, 'configuration incomplete:');
	}, 30000);

	test('keys set, terminal_installing → exit 78, "--resume", no database connection', async () => {
		const outcome = await boot('unfinished', KEYS, 'terminal_installing');
		expectRefused(outcome, 'install not finished');
		expect(outcome.stderr).toContain('--resume');
	}, 30000);

	test('PARTIAL keys → a non-zero exit that is neither the restart nor the refusal code', async () => {
		const outcome = await boot('partial', { ENTITY: 'zznis' }, null);
		expect(outcome.exitCode).not.toBe(0);
		expect(outcome.exitCode).not.toBe(RESTART_EXIT_CODE);
		expect(outcome.exitCode).not.toBe(NOT_INSTALLED_EXIT_CODE);
		expect(outcome.stderr).toMatch(/Missing required config key '[A-Z_]+'/);
	}, 30000);
});
