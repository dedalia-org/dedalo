/**
 * "FINISHED" MEANS SERVED — the developer route's serve check and its final
 * screen (TODO-053; design DEV_ROUTE_SERVE §1.3 + §2 gates 5, 0's red-proof
 * and 6; owner answer D4: boot the engine once).
 *
 * Measured as OUTCOMES, through the operator's own entry (`bun run dev` →
 * scripts/dev.ts → the CSS watcher + the supervised server), the written
 * `.env`, real curl over the real listener, a real root login:
 *  A. GATE 5 green: HTTPS from the ONE local-CA generator, /health verified
 *     against the authority (the only trust anchor), a root login whose cookie
 *     the next request carries, the server stopped and the port free again;
 *  B. GATE 5 reds — each keeps the check red and NAMES the cause: the port
 *     held by another program (refused before any boot: a foreign server
 *     would otherwise answer /health for ours), the key unreadable (the
 *     server's own boot refusal, key + path), the database stopped
 *     (/health's `db: down`), the certificate not verifying against the
 *     anchor beside it (another authority's root), cookies whose Secure flag
 *     contradicts the listener's scheme, root running it in a user's tree;
 *     every remedy names the WRITTEN .env, never a flag a sealed --resume
 *     refuses;
 *  C. GATE 0's red-proof: the same checkout WITHOUT `less` in its
 *     node_modules (what the bootstrap's `--production` tree is) → the check
 *     reports the crash, naming the package; the control — the identical tree
 *     WITH `less` — serves. The only difference is the one package;
 *  D. the step keeps the install from being reported complete: the executor
 *     with the REAL verify_dev_server row (every other row faked) ends
 *     `failed` at that step with the cause; the green twin ends `complete`;
 *     no other route plans the step;
 *  E. the final screen: the view read back from the WRITTEN .env (URLs from
 *     the one function, LAN addresses on a wildcard bind, the authority's
 *     path + SHA-256 + trust), worded by the one text source on both front
 *     ends; dev_quickstart.md's quoted block and its key table are DERIVED
 *     from that text and from the developer plan (gate 6).
 *
 * Isolation: scratch private dirs, an ephemeral unix socket per boot, the
 * diffusion scheduler off, a marked processes dir, the preload's suite
 * database (root credential through ensureSuiteLoginPassword — the marker's
 * door), the trust seam (no machine store is read or written).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { devListenerUrls } from '../../src/config/dev_listener_address.ts';
import { parseEnvFile, privateDir, processEnvValue } from '../../src/config/env.ts';
import { DEV_LISTENER_ENV_KEYS } from '../../src/core/install/dev_listener.ts';
import { probeListenPort } from '../../src/core/install/dev_listener_check.ts';
import {
	cookieFlagRefusal,
	DEV_START_COMMAND,
	type DevServeResult,
	devServedView,
	devServeEnv,
	devStartCommand,
	exitCause,
	openableUrls,
	setCookies,
	verifyDevServe,
} from '../../src/core/install/dev_serve.ts';
import { executeInstall } from '../../src/core/install/executor.ts';
import { buildInstallPlan, type InstallPlan } from '../../src/core/install/install_plan.ts';
import { buildPlanFile } from '../../src/core/install/run_files.ts';
import { DONE_TEXT, type ServedEnding } from '../../src/core/install/screen_text.ts';
import { INSTALL_STEPS } from '../../src/core/install/steps.ts';
import { doneCard } from '../../src/core/install/ui/screens/done.ts';
import { plainReporter } from '../../src/core/install/ui_plain/reporter.ts';
import {
	ensureSuiteLoginPassword,
	SUITE_LOGIN_PASSWORD,
} from '../../src/core/test_data/suite_login.ts';
import { freeTcpPort } from '../helpers/free_tcp_port.ts';
import { BASE_RECORD } from '../helpers/install_answer_cases.ts';
import {
	fakeHost,
	fakeTable,
	recordingIo,
	withPrivateDir,
} from '../helpers/install_fake_executor.ts';
import { markProcessesDir } from '../helpers/test_media_root.ts';

const ROOT = resolve(import.meta.dir, '../..');
const GENERATOR = join(ROOT, 'deploy/dedalo-tls-rotate.sh');
// Short: macOS caps a unix socket path at 104 bytes.
const scratch = mkdtempSync(join(tmpdir(), 'zzdsv_'));
const CA_DIR = join(scratch, 'tls');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DEV = { route: 'developer', ...BASE_RECORD } as const;
/** A first boot migrates and warms caches: generous, but bounded. */
const BOOT = 150_000;

function run(argv: string[]): { code: number | null; out: string; err: string } {
	const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** A developer plan over an empty prior .env, its material in `tlsDir`. */
function devPlan(answers: Record<string, unknown> = {}, tlsDir = CA_DIR): InstallPlan {
	return buildInstallPlan({ ...DEV, ...answers }, { priorEnv: {}, devTlsDir: tlsDir });
}

let dirCount = 0;

/**
 * The rest of the configuration THIS test process runs with: every key the
 * private .env names that the process environment does not (those the child
 * inherits as they are — DB_NAME is the preload's suite database). The check
 * strips every key its .env names from the child's environment, so a key
 * repointed by a preload must NOT be written: the file would win, and name
 * the installation's database. Empty where no private .env exists (CI: the
 * environment carries everything).
 */
function effectiveBaseEnv(): Map<string, string> {
	const file = join(privateDir, '.env');
	const parsed = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
	const base = new Map<string, string>();
	for (const [key, value] of Object.entries(parsed)) {
		if (DEV_LISTENER_ENV_KEYS.includes(key) || key === 'SERVER_UNIX_SOCKET') continue;
		if (processEnvValue(key) === undefined) base.set(key, value);
	}
	return base;
}

/** One .env line, double-quoted the way parseEnvFile reads it back. */
const envLine = (key: string, value: string): string => `${key}="${value.replaceAll('"', '\\"')}"`;

/**
 * A private dir whose .env is this process's effective configuration plus the
 * developer plan's OWN Development-only section (the keys the install writes)
 * and this gate's isolation keys; `extra` last (wins).
 */
function privateDirFor(plan: InstallPlan, extra: Record<string, string> = {}): string {
	dirCount += 1;
	const dir = join(scratch, `p${dirCount}`);
	mkdirSync(dir, { recursive: true });
	const listener = plan.devListener;
	if (listener === null) throw new Error('not a developer plan');
	const env = effectiveBaseEnv();
	for (const item of listener.entries) env.set(item.key, item.value);
	env.set('SERVER_UNIX_SOCKET', join(scratch, `s${dirCount}.sock`));
	env.set('DEDALO_DIFFUSION_SCHEDULER_ENABLED', 'false');
	env.set('DEDALO_GEOIP_ENABLED', 'false');
	env.set('DEDALO_MEDIA_PROCESSES_DIR', markProcessesDir(join(scratch, `processes${dirCount}`)));
	for (const [key, value] of Object.entries(extra)) env.set(key, value);
	const lines = [...env].map(([key, value]) => envLine(key, value));
	writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
	return dir;
}

/** Hold `port` on 127.0.0.1 (another program) while `body` runs. */
async function holding<T>(port: number, body: () => Promise<T>): Promise<T> {
	const held = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });
	try {
		return await body();
	} finally {
		held.stop(true);
	}
}

async function expectPortFree(port: number): Promise<void> {
	expect((await probeListenPort('127.0.0.1', port)).kind, `port ${port} released`).toBe('free');
}

beforeAll(async () => {
	// The developer layout of the ONE local-CA generator (never a second one).
	const issued = run([
		'bash',
		GENERATOR,
		'--mode',
		'local-ca',
		'--host',
		'localhost',
		'--host',
		'127.0.0.1',
		'--dir',
		CA_DIR,
		'--no-reload',
		'--quiet',
	]);
	if (issued.code !== 0) throw new Error(`the local-CA generator failed: ${issued.err}`);
	// BUILD the situation: the suite seed ships `root` with no password.
	await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
});

// ── A. green ────────────────────────────────────────────────────────────────

describe('A. gate 5 green — `bun run dev` serves the written listener', () => {
	test(
		'https via the local authority: /health verified, root login carried, stopped, port free',
		async () => {
			const port = freeTcpPort();
			const plan = devPlan({ dev_port: String(port) });
			const result = await verifyDevServe({
				privateDir: privateDirFor(plan),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			expect(result.message).toContain('/health ok (verified against the local authority)');
			expect(result.served).toBe(true);
			expect(result.login).toBe('verified');
			expect(result.url).toBe(`https://localhost:${port}/dedalo/core/page/`);
			expect(result.url).toBe(plan.devListener?.url ?? '');
			expect(result.warnings).toEqual([]);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);
});

// ── B. the reds, each named ─────────────────────────────────────────────────

describe('B. gate 5 reds — the cause is named', () => {
	test('a port another program holds: refused before any boot, the WRITTEN key named with the next free port — never --dev-port (a sealed --resume refuses other answers)', async () => {
		const port = freeTcpPort();
		const plan = devPlan({ dev_port: String(port) });
		const dir = privateDirFor(plan);
		const result = await holding(port, () =>
			verifyDevServe({ privateDir: dir, rootPassword: SUITE_LOGIN_PASSWORD }),
		);
		expect(result.served).toBe(false);
		expect(result.cause).toBe('port_in_use');
		expect(result.message).toContain(`port ${port} (SERVER_TCP_PORT) is already in use`);
		expect(result.message).toMatch(
			new RegExp(`set SERVER_TCP_PORT=\\d+ in ${join(dir, '.env').replaceAll('.', '\\.')}$`),
		);
		expect(result.message).not.toContain('--dev-port');
	});

	test('root in a user’s tree: refused before any boot (the server it boots writes the session store, logs and CSS there)', async () => {
		// A .env with no listener: were the owner check gone, the check would answer no_listener.
		const dir = join(scratch, 'owner_refusal');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '.env'), 'DB_NAME=x\n');
		const tree = mkdtempSync(join(scratch, 'tree_'));
		// The gate's own files are owned by this (non-root) uid: a root run would not be "a user's tree".
		// statSync, not `stat -f %u`: that is BSD syntax; GNU stat (the CI image) reads -f as file-system status.
		const owner = String(statSync(tree).uid);
		const asRoot = await verifyDevServe({
			root: tree,
			privateDir: dir,
			rootPassword: SUITE_LOGIN_PASSWORD,
			euid: 0,
		});
		expect(asRoot.served).toBe(false);
		expect(asRoot.cause, asRoot.message).toBe('owner');
		expect(asRoot.message).toContain(`runs as the checkout's owner (uid ${owner}), not root`);
		expect(asRoot.message).toContain('without sudo');
		// The control: the owner itself reaches the next check.
		const asOwner = await verifyDevServe({
			root: tree,
			privateDir: dir,
			rootPassword: SUITE_LOGIN_PASSWORD,
			euid: Number(owner),
		});
		expect(asOwner.cause).toBe('no_listener');
	});

	test(
		'a certificate that does not chain to the anchor beside it: red certificate_untrusted, the anchor named (curl --cacert really verifies)',
		async () => {
			// Another authority from the ONE generator; its root put where the first pair's anchor is.
			const otherDir = join(scratch, 'tls_other_ca');
			const issued = run([
				'bash',
				GENERATOR,
				'--mode',
				'local-ca',
				'--host',
				'localhost',
				'--host',
				'127.0.0.1',
				'--dir',
				otherDir,
				'--no-reload',
				'--quiet',
			]);
			expect(issued.code, issued.err).toBe(0);
			const tlsDir = join(scratch, 'tls_wrong_anchor');
			cpSync(CA_DIR, tlsDir, { recursive: true });
			copyFileSync(join(otherDir, 'dedalo-local-ca.pem'), join(tlsDir, 'dedalo-local-ca.pem'));
			const port = freeTcpPort();
			const result = await verifyDevServe({
				privateDir: privateDirFor(devPlan({ dev_port: String(port) }, tlsDir)),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			expect(result.served).toBe(false);
			expect(result.cause, result.message).toBe('certificate_untrusted');
			expect(result.message).toContain(
				`does not verify against the local authority ${join(tlsDir, 'dedalo-local-ca.pem')} for localhost`,
			);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test(
		'plain HTTP: the root login serves, its cookies NOT Secure (the green http twin)',
		async () => {
			const port = freeTcpPort();
			const result = await verifyDevServe({
				privateDir: privateDirFor(devPlan({ dev_port: String(port), tls_mode: 'none' })),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			expect(result.message).toContain(`served http://localhost:${port}/dedalo/core/page/`);
			expect(result.message).toContain('root login verified');
			expect(result.served).toBe(true);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test(
		'plain HTTP with SESSION_COOKIE_SECURE=true: red cookie_flag — a round-trip over the loopback name would carry it anyway',
		async () => {
			const port = freeTcpPort();
			const result = await verifyDevServe({
				privateDir: privateDirFor(devPlan({ dev_port: String(port), tls_mode: 'none' }), {
					SESSION_COOKIE_SECURE: 'true',
				}),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			expect(result.served).toBe(false);
			expect(result.cause, result.message).toBe('cookie_flag');
			expect(result.message).toContain('are Secure over plain http://');
			expect(result.message).toContain('SESSION_COOKIE_SECURE must be false');
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test('the cookie flag is read off every Set-Cookie, per scheme', () => {
		const headers =
			'HTTP/1.1 200 OK\r\nSet-Cookie: dedalo_session=a; HttpOnly; SameSite=Lax; Path=/; Secure\r\nset-cookie: dedalo_media=b; HttpOnly; Path=/; Max-Age=60\r\n\r\n';
		const cookies = setCookies(headers);
		expect(cookies).toEqual([
			'dedalo_session=a; HttpOnly; SameSite=Lax; Path=/; Secure',
			'dedalo_media=b; HttpOnly; Path=/; Max-Age=60',
		]);
		expect(cookieFlagRefusal(cookies, true)).toContain('(dedalo_media) lack Secure over https://');
		expect(cookieFlagRefusal(cookies, false)).toContain('(dedalo_session) are Secure');
		expect(cookieFlagRefusal([cookies[0] as string], true)).toBeNull();
		expect(cookieFlagRefusal([cookies[1] as string], false)).toBeNull();
		expect(cookieFlagRefusal([], false)).toBe('the root login set no cookie');
	});

	test.if(process.geteuid?.() !== 0)(
		'an unreadable key: the server’s own boot refusal, key and path named (requires a non-root run: root reads a 000 file)',
		async () => {
			const tlsDir = join(scratch, 'tls_unreadable');
			cpSync(CA_DIR, tlsDir, { recursive: true });
			const keyFile = join(tlsDir, 'privkey.pem');
			chmodSync(keyFile, 0o000);
			const port = freeTcpPort();
			const plan = devPlan({ dev_port: String(port) }, tlsDir);
			try {
				const result = await verifyDevServe({
					privateDir: privateDirFor(plan),
					rootPassword: SUITE_LOGIN_PASSWORD,
					bootTimeoutMs: BOOT,
				});
				expect(result.served).toBe(false);
				expect(result.cause).toBe('certificate');
				expect(result.message).toContain('the server refused to start: SERVER_TCP_TLS_KEY_FILE');
				expect(result.message).toContain(keyFile);
				await expectPortFree(port);
			} finally {
				chmodSync(keyFile, 0o600);
			}
		},
		BOOT + 60_000,
	);

	test(
		'a stopped database: the server starts, /health answers db: down, the check says so',
		async () => {
			const port = freeTcpPort();
			const plan = devPlan({ dev_port: String(port), tls_mode: 'none' });
			// Nothing listens on this port: the database is "stopped".
			const dead = String(freeTcpPort());
			const result = await verifyDevServe({
				privateDir: privateDirFor(plan, { DB_HOST: '127.0.0.1', DB_PORT: dead, DB_SOCKET: '' }),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
				databaseGraceMs: 4000,
			});
			expect(result.served).toBe(false);
			expect(result.cause).toBe('database_unreachable');
			expect(result.message).toContain('cannot reach its database');
			expect(result.message).toContain(`http://localhost:${port}`);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test(
		'a root login the listener refuses: red, never "complete" on /health alone',
		async () => {
			const port = freeTcpPort();
			const result = await verifyDevServe({
				privateDir: privateDirFor(devPlan({ dev_port: String(port) })),
				rootPassword: `${SUITE_LOGIN_PASSWORD}-not-this-one`,
				bootTimeoutMs: BOOT,
			});
			expect(result.served).toBe(false);
			expect(result.cause).toBe('login_failed');
			expect(result.message).toContain(`the root login over https://localhost:${port} was refused`);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test(
		'a server that throws at boot (bun --watch keeps the entry alive): red at once, its error named — never the whole timeout',
		async () => {
			const port = freeTcpPort();
			const started = Date.now();
			const result = await verifyDevServe({
				// A relative socket is no socket to libpq: the pool refuses at import, so the boot throws.
				privateDir: privateDirFor(devPlan({ dev_port: String(port), tls_mode: 'none' }), {
					DB_SOCKET: 'relative/socket',
				}),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			expect(result.served).toBe(false);
			expect(result.cause, result.message).toBe('boot_failed');
			expect(result.message).toContain('the server crashed at boot');
			expect(result.message).toContain('DB_SOCKET');
			expect(Date.now() - started).toBeLessThan(60_000);
			await expectPortFree(port);
		},
		BOOT + 60_000,
	);

	test('the exit causes are told apart from what the entry printed', () => {
		const listener = { hostname: '127.0.0.1', port: 3500 };
		expect(
			exitCause(1, "error: Cannot find package 'less' from '/x/scripts/build_css.ts'", listener),
		).toEqual({
			cause: 'dev_dependency_missing',
			msg: expect.stringContaining('a development dependency is missing (less)'),
		});
		const socket = exitCause(
			1,
			'FATAL: another server instance is already listening on /tmp/dedalo_ts.sock — refusing to steal its socket.',
			listener,
			'/p/.env',
		);
		expect(socket.cause).toBe('socket_in_use');
		// After the seal: the written key, never --socket (a --resume with another answer is refused).
		expect(socket.msg).toContain('set SERVER_UNIX_SOCKET=<path> in /p/.env');
		expect(socket.msg).not.toContain('--socket');
		expect(
			exitCause(
				78,
				'[boot] REFUSED — not installed: x (exit 78; supervisors must not restart)',
				listener,
			),
		).toEqual({ cause: 'boot_refused', msg: 'the server refused to start: not installed: x' });
		const taken = exitCause(1, 'error: EADDRINUSE', listener, '/p/.env');
		expect(taken.cause).toBe('port_in_use');
		expect(taken.msg).toContain('set SERVER_TCP_PORT to a free port in /p/.env');
		expect(taken.msg).not.toContain('--dev-port');
		expect(exitCause(3, 'something\nelse broke', listener)).toEqual({
			cause: 'boot_failed',
			msg: `\`${DEV_START_COMMAND}\` exited 3 before it served: something | else broke`,
		});
	});

	test('the child reads the WRITTEN file: every key it names leaves the environment; the installer’s own session name too', () => {
		const env = devServeEnv(
			{ DB_NAME: 'written', SERVER_TCP_PORT: '3500' },
			{ DB_NAME: 'seeded', PATH: '/bin', PGAPPNAME: 'dedalo_install:1', HOME: '/h' },
			'/p',
		);
		expect(env).toEqual({ PATH: '/bin', HOME: '/h', DEDALO_PRIVATE_DIR: '/p' });
	});
});

// ── C. gate 0's red-proof ───────────────────────────────────────────────────

/**
 * A checkout twin whose node_modules links every package of the real one —
 * except `less` when `withLess` is false (the bootstrap's `--production` tree
 * lacks every devDependency; `less` is the one `bun run dev` dies on). The
 * entry (scripts/) is COPIED so `less` resolves from THIS tree's node_modules;
 * the engine (src/) is linked.
 */
function checkoutTwin(name: string, withLess: boolean): string {
	const tree = join(scratch, name);
	mkdirSync(join(tree, 'scripts'), { recursive: true });
	for (const file of ['dev.ts', 'build_css.ts']) {
		copyFileSync(join(ROOT, 'scripts', file), join(tree, 'scripts', file));
	}
	// What the entry and the server read beside the scripts (the CSS watcher watches client/ and tools/).
	for (const entry of ['src', 'client', 'tools', 'package.json', 'bunfig.toml', 'tsconfig.json']) {
		symlinkSync(join(ROOT, entry), join(tree, entry));
	}
	const modules = join(tree, 'node_modules');
	mkdirSync(modules);
	for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
		if (entry === 'less' && !withLess) continue;
		symlinkSync(join(ROOT, 'node_modules', entry), join(modules, entry));
	}
	return tree;
}

describe('C. gate 0 red-proof — a missing development dependency reds the check', () => {
	let red: DevServeResult;
	let control: DevServeResult;
	let redPort = 0;

	beforeAll(
		async () => {
			const missing = checkoutTwin('tree_without_less', false);
			const whole = checkoutTwin('tree_with_less', true);
			redPort = freeTcpPort();
			red = await verifyDevServe({
				root: missing,
				privateDir: privateDirFor(devPlan({ dev_port: String(redPort) })),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
			control = await verifyDevServe({
				root: whole,
				privateDir: privateDirFor(devPlan({ dev_port: String(freeTcpPort()) })),
				rootPassword: SUITE_LOGIN_PASSWORD,
				bootTimeoutMs: BOOT,
			});
		},
		2 * BOOT + 60_000,
	);

	test('without `less`: red, the package named, nothing left on the port', async () => {
		expect(red.served).toBe(false);
		expect(red.cause).toBe('dev_dependency_missing');
		expect(red.message).toContain('a development dependency is missing (less)');
		await expectPortFree(redPort);
	});

	test('the control — the same twin WITH `less` — serves', () => {
		expect(control.message).toContain('root login verified');
		expect(control.served).toBe(true);
	});
});

// ── D. the step keeps the install from being reported complete ──────────────

describe('D. the REAL step row in the executor: red → failed at verify_dev_server; green → complete', () => {
	async function runWith(privateDir: string, plan: InstallPlan) {
		const calls: string[] = [];
		const { host } = fakeHost();
		const table = fakeTable(calls, { verify_dev_server: INSTALL_STEPS.verify_dev_server });
		return withPrivateDir(privateDir, async () =>
			executeInstall(
				{
					mode: 'fresh',
					planFile: buildPlanFile(plan, { root_password: SUITE_LOGIN_PASSWORD }),
					plan,
					secrets: { root_password: SUITE_LOGIN_PASSWORD },
				},
				recordingIo().io,
				{ table, host },
			),
		);
	}

	test('the developer plan ends with the step, after the seal; no other route plans it', () => {
		const steps = devPlan().steps;
		expect(steps.at(-1)).toBe('verify_dev_server');
		expect(steps.at(-2)).toBe('install_finish');
		for (const answers of [
			{
				route: 'production',
				instance: 'prado',
				server_name: 'prado.example.org',
				letsencrypt_email: 'a@example.org',
			},
			{ route: 'docker', server_name: 'prado.example.org', letsencrypt_email: 'a@example.org' },
			{ route: 'trial' },
			{ route: 'developer', engine_only: true },
		]) {
			const plan = buildInstallPlan({ ...BASE_RECORD, ...answers }, { priorEnv: {} });
			expect(plan.steps, JSON.stringify(answers)).not.toContain('verify_dev_server');
		}
	});

	test('a held port: the run FAILS at verify_dev_server, the cause in its message', async () => {
		const port = freeTcpPort();
		const plan = devPlan({ dev_port: String(port) });
		const dir = privateDirFor(plan);
		// The fake persist_config writes nothing: the .env above is the "written" one.
		const outcome = await holding(port, () => runWith(dir, plan));
		expect(outcome.result).toBe('failed');
		expect(outcome.exitCode).toBe(1);
		expect(outcome.failedStep).toBe('verify_dev_server');
		expect(outcome.message).toContain(`port ${port} (SERVER_TCP_PORT) is already in use`);
		expect(outcome.message).toContain(`in ${join(dir, '.env')} — then --resume`);
		expect(outcome.message).not.toContain('--dev-port');
		// The install is sealed by now: --resume is offered, --abort (which refuses a seal) is not.
		const hint = outcome.hint.join('\n');
		expect(hint).toContain('--resume');
		expect(hint).not.toContain('--abort');
	});

	test(
		'a free port: the run completes',
		async () => {
			const plan = devPlan({ dev_port: String(freeTcpPort()) });
			const outcome = await runWith(privateDirFor(plan), plan);
			expect(outcome.message).toBeNull();
			expect(outcome.result).toBe('complete');
		},
		BOOT + 60_000,
	);
});

// ── E. the final screen and its docs ────────────────────────────────────────

/** The block every front end prints for `view` (the plain reporter's own sinks). */
async function plainClosing(view: ServedEnding): Promise<string[]> {
	const lines: string[] = [];
	const sink = (line: string) => lines.push(line);
	await plainReporter({
		sinks: { log: sink, warn: sink, error: sink },
		terminal: { isTTY: false, write: () => true },
	}).finish(
		{ exitCode: 0, result: 'complete', message: null, failedStep: null, hint: [] },
		{
			mode: 'fresh',
			rootVerified: true,
			ending: { route: 'engine', instance: '', keptLive: false, undone: [], served: view },
		},
	);
	return lines;
}

describe('E. the final screen — from the written keys, one text source, derived docs', () => {
	test('local CA on this machine: both loopback URLs, the authority’s path, SHA-256 and measured trust', async () => {
		const port = freeTcpPort();
		const view = await devServedView(privateDirFor(devPlan({ dev_port: String(port) })), () => [
			'192.0.2.7',
		]);
		expect(view).not.toBeNull();
		// A scratch private dir is not the one the operator's shell resolves: the command names it.
		expect(view?.start).toBe(
			`DEDALO_PRIVATE_DIR=${join(resolve(scratch), `p${dirCount}`)} bun run dev`,
		);
		expect(view?.urls).toEqual([
			`https://127.0.0.1:${port}/dedalo/core/page/`,
			`https://localhost:${port}/dedalo/core/page/`,
		]);
		expect(view?.network).toBe(false);
		const fingerprint = new Bun.CryptoHasher('sha256');
		const der = Buffer.from(
			readFileSync(join(CA_DIR, 'dedalo-local-ca.pem'), 'utf8')
				.replace(/-----[A-Z ]+-----/g, '')
				.replace(/\s+/g, ''),
			'base64',
		);
		fingerprint.update(der);
		const expected = (fingerprint.digest('hex').toUpperCase().match(/../g) ?? []).join(':');
		expect(view?.tls).toEqual({
			kind: 'local_ca',
			caFile: join(CA_DIR, 'dedalo-local-ca.pem'),
			fingerprint: expected,
			// The preload's seam: this machine's stores are not read.
			trusted: null,
			manual: expect.stringContaining(join(CA_DIR, 'dedalo-local-ca.pem')),
		});
	});

	test('opened to the network (0.0.0.0): the LAN URLs too; plain HTTP says so; another route: no block', async () => {
		const port = freeTcpPort();
		const plan = devPlan({ dev_port: String(port), dev_host: '0.0.0.0', tls_mode: 'none' });
		const view = await devServedView(privateDirFor(plan), () => ['192.0.2.7']);
		expect(view?.urls).toEqual([
			`http://127.0.0.1:${port}/dedalo/core/page/`,
			`http://localhost:${port}/dedalo/core/page/`,
			`http://192.0.2.7:${port}/dedalo/core/page/`,
		]);
		expect(view?.network).toBe(true);
		expect(view?.tls).toBeNull();
		const text = DONE_TEXT.served(view as ServedEnding).join('\n');
		expect(text).toContain('plain HTTP');
		expect(text).toContain('other machines reach it');
		// A .env with no development listener (every other route) has no served block.
		const other = join(scratch, 'other_route');
		mkdirSync(other);
		writeFileSync(join(other, '.env'), 'DB_NAME=x\n');
		expect(await devServedView(other)).toBeNull();
	});

	test('C4 S4: the Open list is the public address, then only what the certificate names', () => {
		const tls = {
			hostname: '0.0.0.0',
			port: 3500,
			url: '',
			networkReachable: true,
			tls: { certFile: join(CA_DIR, 'fullchain.pem'), keyFile: join(CA_DIR, 'privkey.pem') },
		} as unknown as Parameters<typeof openableUrls>[1];
		const bound = [
			'https://127.0.0.1:3500/dedalo/core/page/',
			'https://localhost:3500/dedalo/core/page/',
			'https://192.0.2.7:3500/dedalo/core/page/',
		];
		// The scratch leaf names localhost and 127.0.0.1 only: the LAN address is not offered.
		expect(
			openableUrls(bound, tls, {
				DEDALO_HOST: 'museo.example.org:3500',
				DEDALO_PROTOCOL: 'https://',
			}),
		).toEqual([
			'https://museo.example.org:3500/dedalo/core/page/',
			bound[0] as string,
			bound[1] as string,
		]);
		// Plain HTTP: every bound address, the public one first (its own protocol).
		const plain = { ...tls, tls: null } as Parameters<typeof openableUrls>[1];
		expect(
			openableUrls(bound, plain, { DEDALO_HOST: 'h:3500', DEDALO_PROTOCOL: 'http://' }),
		).toEqual(['http://h:3500/dedalo/core/page/', ...bound]);
		// No DEDALO_PROTOCOL: the engine default, http://.
		expect(openableUrls(bound, plain, { DEDALO_HOST: 'h:3500' })[0]).toBe(
			'http://h:3500/dedalo/core/page/',
		);
		// A certificate naming none of the bound hosts, no public address: never an empty list.
		const lan = ['https://192.0.2.7:3500/dedalo/core/page/'];
		expect(openableUrls(lan, tls, {})).toEqual(lan);
	});

	test('the plain CLI and the full screen tell the SAME lines (DONE_TEXT.served)', async () => {
		const view = await devServedView(privateDirFor(devPlan({ dev_port: '3500' })), () => []);
		const served = DONE_TEXT.served(view as ServedEnding);
		expect(served.length).toBeGreaterThanOrEqual(5);
		const plain = (await plainClosing(view as ServedEnding)).join('\n');
		const card = doneCard(
			{
				kind: 'run',
				outcome: { exitCode: 0, result: 'complete', message: null, failedStep: null, hint: [] },
				mode: 'fresh',
				rootVerified: true,
				shownOnce: [],
				ending: { route: 'engine', instance: '', keptLive: false, served: view as ServedEnding },
			},
			400,
		);
		const cardText = card.below
			.map((line) => line.map((segment) => segment.text).join(''))
			.join('\n');
		for (const line of served) {
			expect(plain).toContain(line);
			expect(cardText).toContain(line.trim());
		}
		expect(plain).toContain('install complete — root login verified');
		expect(
			DONE_TEXT.next({
				route: 'engine',
				instance: '',
				keptLive: false,
				served: view as ServedEnding,
			}),
		).toBe(
			`Start it with \`${view?.start}\`, then open https://127.0.0.1:3500/dedalo/core/page/ and log in as root.`,
		);
	});

	test('the start command: plain `bun run dev` for the private dir the shell resolves; DEDALO_PRIVATE_DIR named for any other', () => {
		expect(devStartCommand('/home/me/dedalo/private', '/home/me/dedalo/private/')).toBe(
			DEV_START_COMMAND,
		);
		expect(devStartCommand(privateDir)).toBe(DEV_START_COMMAND);
		expect(devStartCommand('/srv/elsewhere', '/home/me/dedalo/private')).toBe(
			'DEDALO_PRIVATE_DIR=/srv/elsewhere bun run dev',
		);
	});

	const QUICKSTART = readFileSync(join(ROOT, 'docs/install/dev_quickstart.md'), 'utf8');

	test('dev_quickstart.md quotes the final screen verbatim (rendered by DONE_TEXT.served)', () => {
		const view: ServedEnding = {
			start: DEV_START_COMMAND,
			urls: devListenerUrls('127.0.0.1', 3500, true),
			network: false,
			tls: {
				kind: 'local_ca',
				caFile: '/home/me/dev/dedalo/private/tls/dedalo-local-ca.pem',
				fingerprint: '3F:A2:…:9C',
				trusted: true,
				manual: '',
			},
		};
		const block = /<!-- dev-final-screen -->\n```text\n([\s\S]*?)```/.exec(QUICKSTART)?.[1];
		expect(block, 'dev_quickstart.md has the marked final-screen block').toBeDefined();
		expect(block).toBe(
			[`✔ ${DONE_TEXT.complete(true)}.`, '', ...DONE_TEXT.served(view).map((l) => `  ${l}`)].join(
				'\n',
			) + '\n',
		);
	});

	test('dev_quickstart.md’s key table IS the developer plan’s Development-only section, per TLS mode', () => {
		const table = /<!-- dev-env-table -->\n([\s\S]*?)\n\n/.exec(QUICKSTART)?.[1] ?? '';
		const rows = table
			.split('\n')
			.slice(2)
			.map((line) =>
				line
					.split('|')
					.slice(1, -1)
					.map((cell) => cell.trim().replace(/^`|`$/g, '')),
			);
		expect(rows.length, 'the marked table has rows').toBeGreaterThanOrEqual(7);
		const written = (mode: string): Map<string, string> =>
			new Map(
				(devPlan({ tls_mode: mode }, '<private>/tls').devListener?.entries ?? []).map((item) => [
					item.key,
					item.value,
				]),
			);
		const [localCa, none] = [written('local_ca'), written('none')];
		const NOT_WRITTEN = 'not written';
		expect(rows.map((row) => row[0])).toEqual([...localCa.keys()]);
		for (const [key, ca, plainHttp] of rows) {
			expect(ca, key).toBe(localCa.get(key as string));
			expect(plainHttp, key).toBe(none.get(key as string) ?? NOT_WRITTEN);
		}
	});
});
