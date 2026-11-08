/**
 * "FINISHED" MEANS SERVED — the developer route's last step and its final
 * screen (TODO-053; design DEV_ROUTE_SERVE §1.3, owner answer D4: boot the
 * engine once).
 *
 * WHY. The developer route used to end with "install complete" and a pointer
 * to the browser — a claim nothing had checked: no listener was written, so
 * `bun run dev` served only its unix socket; the development dependencies were
 * missing, so it crashed on `less` (TODO-052). The install is now complete
 * only once the operator's own command has served:
 *
 *  1. `bun run dev` — the ENTRY the operator types (scripts/dev.ts: the CSS
 *     watcher + the supervised server), never the server alone, so a missing
 *     development dependency reds HERE (dev.ts stops when its CSS watcher dies);
 *     started once in the background from the checkout, with the WRITTEN
 *     `<private>/.env` (every key the file names is removed from the child's
 *     environment, so the file is what it reads — never the installer's seeded
 *     copy);
 *  2. GET /health on the development listener the file names, over HTTPS with
 *     the local authority as the ONLY trust anchor (`curl --cacert`: the
 *     machine's trust store is the trust step's business, not this check's —
 *     a "not trusted yet" machine still serves). curl, not fetch: Bun's TLS
 *     client refuses the name-constrained authority ("unsupported name
 *     constraint type", measured on Bun 1.4.3), and curl is what install.sh
 *     already requires;
 *  3. a root login over that listener: every cookie it SETS carries `Secure`
 *     exactly when the listener speaks HTTPS (the SESSION_COOKIE_SECURE
 *     derivation, read off the Set-Cookie headers — a round-trip cannot see
 *     it: curl and browsers return a Secure cookie over http:// to the
 *     loopback name this check uses), then a session-gated, admin-only
 *     request with the same cookie jar — the cookie is CARRIED;
 *  4. stopped again, and the port waited free, so the operator's own
 *     `bun run dev` right after does not collide with the check.
 *
 * A red check FAILS the step, so the install is not reported complete, and
 * names the cause: the port taken (by another program — checked BEFORE the
 * boot, or a foreign server answering /health would pass for ours), the
 * certificate refused (the server's own boot refusal, key and path named), the
 * database unreachable (/health's `db: down`), a development dependency
 * missing (the package named), the unix socket held by another Dédalo server,
 * the certificate not verifying against the authority, the login refused.
 * The install is sealed by then, so the plan's answers are fixed (a --resume
 * with another --dev-port / --socket is refused): a remedy names the key in
 * the WRITTEN .env, which `--resume` reads again when it re-runs this check.
 * Root never runs it in a user's tree (ownerRed): the server it boots writes
 * there.
 *
 * The command it boots, and the screen names, is {@link devStartCommand}:
 * plain `bun run dev`, or prefixed with DEDALO_PRIVATE_DIR when the install
 * wrote another private dir than the one the operator's shell resolves.
 *
 * THE FINAL SCREEN reads the same written file ({@link devServedView}): the
 * command, every URL a browser opens it by (one function: dev_listener_address.ts
 * devListenerUrls), the root login, and the authority's path, SHA-256 and
 * whether this machine trusts it NOW (measured — dev_trust.ts).
 *
 * Gate: test/unit/install_dev_serve_native.test.ts.
 */

import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { devListenerUrls } from '../../config/dev_listener_address.ts';
import { liveProcessEnv, privateDir as operatorPrivateDir, projectRoot } from '../../config/env.ts';
import { type DevTcpListener, devTcpListener } from '../../config/tcp_listener.ts';
import { DEV_CA_NAME, machineIpv4Addresses } from './dev_certificate.ts';
import { ownerRefusal } from './dev_dependencies.ts';
import { nextFreePort, probeListenPort } from './dev_listener_check.ts';
import { installPrivateDir } from './paths.ts';
import { trackInstallChild } from './pg_exec.ts';
import type { DevServedView } from './run_events.ts';
import { readInstallEnv } from './run_files.ts';

export type { DevServedView };

/** The command the operator types (package.json `dev`) — and the one this check runs. */
export const DEV_START_COMMAND = 'bun run dev';

/**
 * The command that starts THIS install's server from the operator's shell.
 * `bun run dev` reads the private dir the operator's environment resolves
 * (config/env.ts privateDir); an install written elsewhere
 * (DEDALO_INSTALL_PRIVATE_DIR) is read only when the command names it — the
 * check boots it that way too (devServeEnv), so the screen must say the same
 * command, never one that reads another .env (owner answer D4: the check boots
 * the way the operator will).
 */
export function devStartCommand(dir: string, operatorDir: string = operatorPrivateDir): string {
	return resolve(dir) === resolve(operatorDir)
		? DEV_START_COMMAND
		: `DEDALO_PRIVATE_DIR=${resolve(dir)} ${DEV_START_COMMAND}`;
}

/** Why the check is red. */
export type DevServeCause =
	| 'no_listener'
	| 'port_in_use'
	| 'socket_in_use'
	| 'certificate'
	| 'certificate_untrusted'
	| 'database_unreachable'
	| 'dev_dependency_missing'
	| 'boot_refused'
	| 'boot_failed'
	| 'login_failed'
	| 'timeout'
	| 'curl_missing'
	| 'owner'
	| 'cookie_flag';

export interface DevServeResult {
	/** Did `bun run dev` serve (health, login, still running)? */
	served: boolean;
	cause: DevServeCause | null;
	/** The verdict's sentence (the cause named when red). */
	message: string;
	/** The page URL the check served (the written keys'), '' when none was written. */
	url: string;
	/** `verified`: a root login over the listener; `not_checked`: no password in hand (a resume). */
	login: 'verified' | 'not_checked';
	warnings: string[];
}

export interface DevServeOptions {
	/** The checkout `bun run dev` runs in (default: this engine's tree). */
	root?: string;
	/** The private dir whose `.env` the install wrote (default: the installer's). */
	privateDir?: string;
	/** The root password set by this install; '' = /health only (a resume that was not given it). */
	rootPassword: string;
	/** How long the listener may take to answer /health (a first boot migrates). */
	bootTimeoutMs?: number;
	/** How long /health may answer `db: down` before the check says so (the server caches it 5 s). */
	databaseGraceMs?: number;
	/** The environment the child starts from (default: this process's, as it is now). */
	baseEnv?: Readonly<Record<string, string>>;
	/** The curl binary (default: the one on PATH). */
	curl?: string | null;
	/** The effective uid (default: this process's) — the gate's seam for a root run. */
	euid?: number | null;
}

/** Keys the installer's process carries that a server of this install must not inherit. */
const INSTALLER_ONLY_ENV = ['PGAPPNAME', 'DEDALO_INSTALL_PRIVATE_DIR'] as const;

/**
 * The environment `bun run dev` starts with: the operator's (this process's),
 * minus every key the written .env names — so the server reads the FILE, as
 * it will when the operator types the command — minus the installer's own
 * session name, with the private dir pointed at the one the install wrote.
 */
export function devServeEnv(
	written: Readonly<Record<string, string>>,
	base: Readonly<Record<string, string>>,
	privateDir: string,
): Record<string, string> {
	const env: Record<string, string> = { ...base };
	for (const key of Object.keys(written)) delete env[key];
	for (const key of INSTALLER_ONLY_ENV) delete env[key];
	env.DEDALO_PRIVATE_DIR = privateDir;
	return env;
}

/** A value the written file names, trimmed ('' when it names none). */
function writtenValue(written: Readonly<Record<string, string>>, key: string): string {
	return written[key]?.trim() ?? '';
}

/** The pair the written file names; a half pair is the server's refusal to make (the boot names it). */
function writtenTlsPair(
	written: Readonly<Record<string, string>>,
): { certFile: string; keyFile: string } | null {
	const certFile = writtenValue(written, 'SERVER_TCP_TLS_CERT_FILE');
	const keyFile = writtenValue(written, 'SERVER_TCP_TLS_KEY_FILE');
	return certFile !== '' && keyFile !== '' ? { certFile, keyFile } : null;
}

/** The listener the written file opens (the server's own reader), or why there is none. */
function writtenListener(
	written: Readonly<Record<string, string>>,
): { listener: DevTcpListener } | { refusal: string } {
	// '' — never undefined: devTcpListener's defaults read THIS process's configuration,
	// and a key the file does not name is unset for the server it describes.
	const listener = devTcpListener(
		writtenValue(written, 'SERVER_TCP_PORT'),
		writtenValue(written, 'SERVER_TCP_HOST'),
		writtenTlsPair(written),
	);
	if (listener === null) {
		return {
			refusal:
				'the .env names no SERVER_TCP_PORT: `bun run dev` would serve only its unix socket, which no browser reaches',
		};
	}
	return { listener };
}

/** The authority a pair chains to: the local CA beside it (the generator's layout), or null. */
function anchorOf(listener: DevTcpListener): string | null {
	if (listener.tls === null) return null;
	const ca = join(dirname(listener.tls.certFile), DEV_CA_NAME);
	return existsSync(ca) ? ca : null;
}

// ── the child's output ───────────────────────────────────────────────────────

const OUTPUT_LIMIT = 64 * 1024;

/** Collect what the child prints (bounded: the tail is what names a failure). */
class OutputTail {
	private text = '';

	follow(stream: ReadableStream<Uint8Array> | number | undefined): void {
		if (stream === undefined || typeof stream === 'number') return;
		void (async () => {
			const decoder = new TextDecoder();
			try {
				for await (const chunk of stream) this.add(decoder.decode(chunk, { stream: true }));
			} catch {
				// the child is gone: what was read is what there is
			}
		})();
	}

	private add(part: string): void {
		this.text += part;
		if (this.text.length > OUTPUT_LIMIT) this.text = this.text.slice(-OUTPUT_LIMIT);
	}

	get value(): string {
		return this.text;
	}
}

/** The last meaningful lines of `text`, joined (the dev_dependencies.ts shape). */
function lastLines(text: string, count: number): string {
	return text
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== '')
		.slice(-count)
		.join(' | ');
}

type Listening = Pick<DevTcpListener, 'hostname' | 'port'>;

/** One recognisable way the entry dies: its printed pattern, and the cause it names. */
interface ExitPattern {
	readonly pattern: RegExp;
	readonly name: (
		match: RegExpExecArray,
		listener: Listening,
		envFile: string,
	) => {
		cause: DevServeCause;
		msg: string;
	};
}

/** The two keys a certificate refusal of the boot names (tcp_listener.ts). */
const TLS_KEYS = ['SERVER_TCP_TLS_CERT_FILE', 'SERVER_TCP_TLS_KEY_FILE'] as const;

/** Each pattern is a sentence THIS engine (or bun's resolver) writes; the first match wins. */
const EXIT_PATTERNS: readonly ExitPattern[] = [
	{
		pattern: /Cannot find (?:package|module) '([^']+)'/,
		name: (match) => ({
			cause: 'dev_dependency_missing',
			msg: `\`${DEV_START_COMMAND}\` stopped: a development dependency is missing (${match[1]}) — install them in the checkout with \`bun install\` (a developer install's install_dev_dependencies step does it)`,
		}),
	},
	{
		pattern: /\[boot\] REFUSED — (.+?) \(exit \d+/,
		name: (match) => ({
			cause: TLS_KEYS.some((key) => match[1]?.includes(key)) ? 'certificate' : 'boot_refused',
			msg: `the server refused to start: ${match[1]}`,
		}),
	},
	{
		pattern: /already listening on (\S+) — refusing to steal its socket/,
		name: (match, _listener, envFile) => ({
			cause: 'socket_in_use',
			msg: `another Dédalo server already listens on the unix socket ${match[1]} (SERVER_UNIX_SOCKET): stop it, or give this install its own socket — set SERVER_UNIX_SOCKET=<path> in ${envFile}`,
		}),
	},
	{
		pattern: /EADDRINUSE|address already in use/i,
		name: (_match, listener, envFile) => ({
			cause: 'port_in_use',
			msg: `port ${listener.port} (SERVER_TCP_PORT) was taken on ${listener.hostname} while the server started: stop the other program, or set SERVER_TCP_PORT to a free port in ${envFile}`,
		}),
	},
];

/**
 * Why `bun run dev` exited before it served, named from what it printed. The
 * check runs AFTER the seal (install_finish), where the plan's answers are
 * fixed (a --resume with another --dev-port / --socket is refused as answers
 * differing from the saved plan): a remedy names the key in the written
 * `envFile`, which the check reads again on --resume.
 */
export function exitCause(
	code: number | null,
	output: string,
	listener: Listening,
	envFile = '<private>/.env',
): { cause: DevServeCause; msg: string } {
	for (const { pattern, name } of EXIT_PATTERNS) {
		const match = pattern.exec(output);
		if (match !== null) return name(match, listener, envFile);
	}
	return {
		cause: 'boot_failed',
		msg: `\`${DEV_START_COMMAND}\` exited ${code ?? 'on a signal'} before it served: ${lastLines(output, 3) || '(it printed nothing)'}`,
	};
}

// ── curl over the listener ───────────────────────────────────────────────────

interface CurlAnswer {
	/** curl's exit code (0 = a response arrived). */
	exit: number;
	status: number;
	body: string;
	err: string;
}

/** curl(1) exit 7: nothing accepted the connection. */
const CURL_COULD_NOT_CONNECT = 7;

/**
 * The uncaught error a crashed boot printed, or null — bun's own report: an
 * `error: …` line (a plain Error) or `<Name>Error: …` (a subclass such as
 * DedaloError), then the error's own properties (`code: "…"`, possibly over
 * several lines) and its stack frames.
 */
export function crashedBoot(output: string): string | null {
	return /^(?:error|\w*Error): (.+)$[\s\S]*?^\s+at \S/m.exec(output)?.[1]?.trim() ?? null;
}

/** curl's exits for a TLS handshake or verification failure (curl(1) EXIT CODES). */
const CURL_TLS_EXITS: ReadonlySet<number> = new Set([
	35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 83, 90, 91,
]);

class Curl {
	constructor(
		private readonly binary: string,
		private readonly anchor: readonly string[],
	) {}

	/** One request; the body (if any) goes through stdin, so no secret is on a command line. */
	async request(url: string, extra: readonly string[] = [], stdin?: string): Promise<CurlAnswer> {
		const child = Bun.spawn(
			[
				this.binary,
				'-sS',
				// A developer's HTTPS_PROXY must not carry a request for this machine's own listener.
				'--noproxy',
				'*',
				'--max-time',
				'10',
				...this.anchor,
				...extra,
				'-o',
				'-',
				'-w',
				'\n%{http_code}',
				url,
			],
			{
				stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		trackInstallChild(child);
		const [exit, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const cut = out.lastIndexOf('\n');
		return {
			exit,
			status: Number(out.slice(cut + 1)) || 0,
			body: cut < 0 ? '' : out.slice(0, cut),
			err: err.trim(),
		};
	}
}

/** The JSON body, or null. */
function json(body: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(body) as unknown;
		return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

// ── the check ────────────────────────────────────────────────────────────────

interface Running {
	readonly child: Subprocess<'ignore', 'pipe', 'pipe'>;
	readonly output: OutputTail;
}

/**
 * `bun run dev` is typed against the operator's PATH (and dev.ts spawns `bun`
 * by name). `sh install.sh` runs the installer with a Bun from its own cache,
 * which need not be on that PATH: the check then runs with the installer's
 * Bun put first on the child's PATH — and SAYS so, because the operator's
 * command will not find it (never a silent substitute).
 */
function bunOnPath(env: Record<string, string>): string[] {
	if (Bun.which('bun', { PATH: env.PATH ?? '' }) !== null) return [];
	const dir = dirname(process.execPath);
	env.PATH = env.PATH === undefined || env.PATH === '' ? dir : `${dir}:${env.PATH}`;
	return [
		`\`bun\` is not on your PATH, so \`${DEV_START_COMMAND}\` will not start from your shell: install Bun at the checkout's pin (docs/install/dev_quickstart.md, step 3) or add ${dir} to PATH — this check ran with the installer's own Bun`,
	];
}

/** Start the operator's entry, from the checkout, with the written file. */
function startDev(root: string, env: Record<string, string>): Running {
	// Resolved against the CHILD's PATH (the operator's), the one `bun run dev` is typed against.
	const bun = Bun.which('bun', { PATH: env.PATH ?? '' }) ?? process.execPath;
	const child = Bun.spawn([bun, 'run', 'dev'], {
		cwd: root,
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	trackInstallChild(child);
	const output = new OutputTail();
	output.follow(child.stdout);
	output.follow(child.stderr);
	return { child, output };
}

/** Stop it the way Ctrl-C does (dev.ts forwards to both children), then wait for the port. */
async function stopDev(running: Running, listener: DevTcpListener): Promise<string[]> {
	const { child } = running;
	if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
	const exited = await Promise.race([
		child.exited.then(() => true),
		Bun.sleep(15_000).then(() => false),
	]);
	if (!exited) {
		child.kill('SIGKILL');
		await child.exited;
	}
	// dev.ts exits as soon as it has signalled the server, which then drains: the
	// port is free only once the server is gone.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if ((await probeListenPort(listener.hostname, listener.port)).kind === 'free') return [];
		await Bun.sleep(250);
	}
	return [
		`the check's server still held port ${listener.port} 15 s after it was stopped — if \`${DEV_START_COMMAND}\` says the port is in use, stop the leftover \`bun\` process`,
	];
}

const red = (
	cause: DevServeCause,
	message: string,
	url: string,
	warnings: string[] = [],
): DevServeResult => ({ served: false, cause, message, url, login: 'not_checked', warnings });

/** Has the child exited (it must still be serving when the check ends)? */
function gone(running: Running): boolean {
	return running.child.exitCode !== null || running.child.signalCode !== null;
}

/** The red of an entry that exited: the cause its output names. */
async function exitedRed(
	running: Running,
	listener: DevTcpListener,
	envFile: string,
): Promise<DevServeResult> {
	await running.child.exited;
	const { cause, msg } = exitCause(running.child.exitCode, running.output.value, listener, envFile);
	return red(cause, msg, listener.url);
}

/** What one /health attempt says: healthy (null), a red, or WAIT. */
const WAIT = 'wait' as const;
type Attempt = DevServeResult | null | typeof WAIT;

/** The state of one /health wait (what an attempt reads beyond its own answer). */
interface HealthWait {
	readonly running: Running;
	readonly curl: Curl;
	readonly listener: DevTcpListener;
	readonly anchor: string | null;
	readonly origin: string;
	readonly envFile: string;
	readonly databaseGraceMs: number;
	/** When /health first answered `db: down` (the server caches its check 5 s). */
	databaseDownSince: number | null;
	/** When nothing listened after an uncaught error was printed (see crashRed). */
	crashSince: number | null;
}

const healthy = (answer: CurlAnswer): boolean =>
	answer.exit === 0 && answer.status === 200 && json(answer.body)?.result === 'ok';

const databaseDown = (answer: CurlAnswer): boolean =>
	answer.exit === 0 && answer.status === 503 && json(answer.body)?.db === 'down';

/**
 * How long nothing may listen after an uncaught error was printed before the
 * boot counts as crashed. A server that LOGS an error with its stack while it
 * boots (a diffusion init that cannot reach its database) still listens a
 * moment later; a crashed one under `bun --watch` never does.
 */
const CRASH_GRACE_MS = 5000;

/**
 * `bun --watch` does NOT exit when the server throws at boot: it waits for a
 * file change. Nothing listening, for CRASH_GRACE_MS after an uncaught error
 * was printed = a crashed boot, said then instead of after the whole timeout.
 */
function crashRed(wait: HealthWait, answer: CurlAnswer): DevServeResult | null {
	const crash =
		answer.exit === CURL_COULD_NOT_CONNECT ? crashedBoot(wait.running.output.value) : null;
	if (crash === null) {
		wait.crashSince = null;
		return null;
	}
	wait.crashSince ??= Date.now();
	if (Date.now() - wait.crashSince < CRASH_GRACE_MS) return null;
	return red(
		'boot_failed',
		`the server crashed at boot (\`${DEV_START_COMMAND}\` keeps waiting for a file change): ${crash}`,
		wait.listener.url,
	);
}

/** A TLS handshake or verification failure: the certificate does not verify against the anchor. */
function tlsRed(wait: HealthWait, answer: CurlAnswer): DevServeResult | null {
	if (!CURL_TLS_EXITS.has(answer.exit)) return null;
	const against = wait.anchor === null ? '' : ` against the local authority ${wait.anchor}`;
	return red(
		'certificate_untrusted',
		`the development listener's certificate does not verify${against} for ${new URL(wait.origin).hostname} (curl exit ${answer.exit}: ${answer.err || 'no detail'})`,
		wait.listener.url,
	);
}

/** /health answers `db: down`: red once it has said so for the whole grace. */
function databaseRed(wait: HealthWait, answer: CurlAnswer): DevServeResult | null {
	if (!databaseDown(answer)) return null;
	wait.databaseDownSince ??= Date.now();
	if (Date.now() - wait.databaseDownSince < wait.databaseGraceMs) return null;
	return red(
		'database_unreachable',
		`the server started but cannot reach its database (/health on ${wait.origin} answers db: down) — start PostgreSQL, or check DB_HOST / DB_PORT / DB_SOCKET in the .env`,
		wait.listener.url,
	);
}

/** One /health attempt. */
async function healthAttempt(wait: HealthWait): Promise<Attempt> {
	if (gone(wait.running)) return exitedRed(wait.running, wait.listener, wait.envFile);
	const answer = await wait.curl.request(`${wait.origin}/health`);
	if (healthy(answer)) return null;
	return crashRed(wait, answer) ?? tlsRed(wait, answer) ?? databaseRed(wait, answer) ?? WAIT;
}

/** The /health wait: healthy (null), or the red that ended it. */
async function awaitHealth(
	wait: HealthWait,
	bootTimeoutMs: number,
): Promise<DevServeResult | null> {
	const deadline = Date.now() + bootTimeoutMs;
	while (Date.now() < deadline) {
		const attempt = await healthAttempt(wait);
		if (attempt !== WAIT) return attempt;
		await Bun.sleep(500);
	}
	return red(
		'timeout',
		`\`${DEV_START_COMMAND}\` did not answer /health on ${wait.origin} within ${Math.round(bootTimeoutMs / 1000)} s: ${lastLines(wait.running.output.value, 3) || '(it printed nothing)'}`,
		wait.listener.url,
	);
}

/** The login request's body (the password goes through curl's stdin, never its argv). */
function loginBody(password: string): string {
	return JSON.stringify({
		dd_api: 'dd_utils_api',
		action: 'login',
		source: {},
		options: { username: 'root', auth: password },
	});
}

/** The `Set-Cookie` values of a response's header block (curl -D), in order. */
export function setCookies(headers: string): string[] {
	return [...headers.matchAll(/^set-cookie:[ \t]*(.+?)\r?$/gim)].map((match) => match[1] ?? '');
}

/**
 * The SESSION_COOKIE_SECURE derivation, checked on what the login SET: every
 * cookie carries `Secure` exactly when the listener speaks HTTPS. The cookie
 * round-trip below cannot tell: curl (8.x) and browsers both send a `Secure`
 * cookie back over http:// to a LOOPBACK name — the one this check logs in
 * over — while a browser at http://<lan-ip> drops it and the login loops.
 * Null when right, else the red's sentence.
 */
export function cookieFlagRefusal(cookies: readonly string[], https: boolean): string | null {
	if (cookies.length === 0) return 'the root login set no cookie';
	const wrong = cookies.filter((cookie) => /;\s*secure\s*(?:;|$)/i.test(cookie) !== https);
	if (wrong.length === 0) return null;
	return wrongFlagSentence(wrong.map((cookie) => cookie.split('=')[0]?.trim()).join(', '), https);
}

/** The red's sentence for cookies (`names`) whose Secure flag contradicts the scheme. */
function wrongFlagSentence(names: string, https: boolean): string {
	return https
		? `the login's cookies (${names}) lack Secure over https:// — SESSION_COOKIE_SECURE must be true for an HTTPS listener`
		: `the login's cookies (${names}) are Secure over plain http:// — a browser on any non-loopback address drops them and the login loops: SESSION_COOKIE_SECURE must be false for an HTTP listener`;
}

type LoginRed = { cause: DevServeCause; msg: string };

/** After an accepted login: the cookies' Secure flag, then the cookie carried by the next request. */
async function afterLogin(
	curl: Curl,
	origin: string,
	jar: readonly string[],
	headerFile: string,
): Promise<LoginRed | null> {
	const headers = existsSync(headerFile) ? readFileSync(headerFile, 'utf8') : '';
	const flag = cookieFlagRefusal(setCookies(headers), origin.startsWith('https:'));
	if (flag !== null) return { cause: 'cookie_flag', msg: flag };
	const next = await curl.request(`${origin}/api/v1/counters`, jar);
	if (next.status === 200) return null;
	return {
		cause: 'login_failed',
		msg: `the root login over ${origin} succeeded, but the next request did not carry its session cookie (HTTP ${next.status || 'none'})`,
	};
}

/** The root login over the listener: its cookies' Secure flag, then the cookie carried by the next request. */
async function loginOver(curl: Curl, origin: string, password: string): Promise<LoginRed | null> {
	const jarDir = mkdtempSync(join(tmpdir(), 'dedalo_dev_serve_'));
	const jar = ['-c', join(jarDir, 'cookies'), '-b', join(jarDir, 'cookies')];
	const headerFile = join(jarDir, 'headers');
	try {
		const login = await curl.request(
			`${origin}/api/v1/json`,
			[...jar, '-D', headerFile, '-H', 'Content-Type: application/json', '--data-binary', '@-'],
			loginBody(password),
		);
		if (login.exit !== 0 || json(login.body)?.ok !== true) {
			return {
				cause: 'login_failed',
				msg: `the root login over ${origin} was refused (HTTP ${login.status || 'none'}) — the password set by this install did not log in through the development listener`,
			};
		}
		return await afterLogin(curl, origin, jar, headerFile);
	} finally {
		rmSync(jarDir, { recursive: true, force: true });
	}
}

/** What a check needs once the written file is read and the port is free. */
interface Prepared {
	readonly written: Readonly<Record<string, string>>;
	readonly listener: DevTcpListener;
	readonly anchor: string | null;
	readonly curl: Curl;
	readonly envFile: string;
	/** The command this install starts with (devStartCommand of the private dir it wrote). */
	readonly start: string;
	readonly warnings: string[];
}

/** The curl anchor: the local authority, none over plain HTTP, `--insecure` for a pair without one (warned). */
function curlAnchor(listener: DevTcpListener, anchor: string | null): string[] {
	if (listener.tls === null) return [];
	return anchor === null ? ['--insecure'] : ['--cacert', anchor];
}

/** A pair with no local authority beside it is presented, never chain-checked here: said. */
function anchorWarnings(listener: DevTcpListener, anchor: string | null): string[] {
	if (listener.tls === null || anchor !== null) return [];
	return [
		`the development certificate (${listener.tls.certFile}) has no local authority beside it: its chain is not checked here, only that the server presents it`,
	];
}

/**
 * Before the boot: a program already on the port would answer /health for
 * ours. The remedy is the WRITTEN key, never --dev-port: the check runs after
 * the seal, where a --resume with another answer is refused (see exitCause).
 */
async function portRed(listener: DevTcpListener, envFile: string): Promise<DevServeResult | null> {
	const port = await probeListenPort(listener.hostname, listener.port);
	if (port.kind !== 'in_use') return null;
	const next = await nextFreePort(listener.hostname, listener.port);
	const value = next === null ? 'a free port' : String(next);
	return red(
		'port_in_use',
		`port ${listener.port} (SERVER_TCP_PORT) is already in use on ${listener.hostname} — another program (a running \`${DEV_START_COMMAND}\`?) holds it: stop it, or set SERVER_TCP_PORT=${value} in ${envFile}`,
		listener.url,
	);
}

/**
 * Root never boots the server in a user's tree: `bun run dev` writes the
 * session store and the logs under the private dir, and the CSS watcher writes
 * client/**\/main.css — root-owned, the developer's own `bun run dev` can no
 * longer write them. A `sudo … --resume` re-runs only this step (done steps
 * are verified, not re-run), so the earlier steps' refusals never fire: this
 * one is the step's own.
 */
function ownerRed(
	root: string,
	dir: string,
	euidOption: number | null | undefined,
): DevServeResult | null {
	const euid = euidOption === undefined ? (process.geteuid?.() ?? null) : euidOption;
	for (const tree of [root, dir]) {
		const refusal = ownerRefusal(euid, statSync(tree).uid);
		if (refusal !== null) return red('owner', refusal, '');
	}
	return null;
}

/** Everything that can refuse BEFORE a boot: the written listener, curl, the port. */
async function prepare(
	privateDir: string,
	curlOption: string | null | undefined,
): Promise<Prepared | DevServeResult> {
	const envFile = join(privateDir, '.env');
	const written = readInstallEnv(envFile) ?? {};
	const resolved = writtenListener(written);
	if ('refusal' in resolved) return red('no_listener', resolved.refusal, '');
	const { listener } = resolved;
	const binary = curlOption === undefined ? Bun.which('curl') : curlOption;
	if (binary === null) {
		return red(
			'curl_missing',
			'curl is not installed: the check that `bun run dev` serves needs it (install.sh does too)',
			listener.url,
		);
	}
	const busy = await portRed(listener, envFile);
	if (busy !== null) return busy;
	const anchor = anchorOf(listener);
	const curl = new Curl(binary, curlAnchor(listener, anchor));
	const start = devStartCommand(privateDir);
	return {
		written,
		listener,
		anchor,
		curl,
		envFile,
		start,
		warnings: anchorWarnings(listener, anchor),
	};
}

/**
 * Serve once and stop (see the header). Never throws for what it measures: a
 * red result names the cause; the step turns it into a refusal.
 */
export async function verifyDevServe(options: DevServeOptions): Promise<DevServeResult> {
	const privateDir = options.privateDir ?? installPrivateDir();
	const root = options.root ?? projectRoot;
	const notOwner = ownerRed(root, privateDir, options.euid);
	if (notOwner !== null) return notOwner;
	const prepared = await prepare(privateDir, options.curl);
	if ('served' in prepared) return prepared;
	const { listener, warnings } = prepared;
	const env = devServeEnv(prepared.written, options.baseEnv ?? liveProcessEnv(), privateDir);
	warnings.push(...bunOnPath(env));
	const running = startDev(root, env);
	let result: DevServeResult;
	try {
		result = await checkRunning(running, prepared, options);
	} finally {
		warnings.push(...(await stopDev(running, listener)));
	}
	return { ...result, warnings: [...result.warnings, ...warnings] };
}

/** The green result. */
function servedResult(
	listener: DevTcpListener,
	anchored: boolean,
	verified: boolean,
	start: string,
): DevServeResult {
	const tls = anchored ? ' (verified against the local authority)' : '';
	const login = verified
		? ', root login verified over it'
		: ' (root login not re-verified: the password was not re-asked)';
	return {
		served: true,
		cause: null,
		message: `\`${start}\` served ${listener.url}: /health ok${tls}${login}; stopped again`,
		url: listener.url,
		login: verified ? 'verified' : 'not_checked',
		warnings: [],
	};
}

/** The /health wait of one running entry. */
function healthWait(running: Running, prepared: Prepared, options: DevServeOptions): HealthWait {
	return {
		running,
		curl: prepared.curl,
		listener: prepared.listener,
		anchor: prepared.anchor,
		origin: new URL(prepared.listener.url).origin,
		envFile: prepared.envFile,
		databaseGraceMs: options.databaseGraceMs ?? 12_000,
		databaseDownSince: null,
		crashSince: null,
	};
}

/** Health, then the login, then: is it still serving? */
async function checkRunning(
	running: Running,
	prepared: Prepared,
	options: DevServeOptions,
): Promise<DevServeResult> {
	const wait = healthWait(running, prepared, options);
	const unhealthy = await awaitHealth(wait, options.bootTimeoutMs ?? 180_000);
	if (unhealthy !== null) return unhealthy;
	const { listener } = prepared;
	const verified = options.rootPassword !== '';
	const login = verified ? await loginOver(prepared.curl, wait.origin, options.rootPassword) : null;
	if (login !== null) return red(login.cause, login.msg, listener.url);
	// dev.ts stops when its CSS watcher dies: an entry that already stopped did not serve.
	if (gone(running)) return exitedRed(running, listener, prepared.envFile);
	return servedResult(listener, prepared.anchor !== null, verified, prepared.start);
}

// ── the final screen ─────────────────────────────────────────────────────────

/**
 * The final screen's facts, from the WRITTEN .env — null when it opens no
 * development listener (every route but developer).
 */
export async function devServedView(
	privateDir: string = installPrivateDir(),
	lan: () => readonly string[] = machineIpv4Addresses,
): Promise<DevServedView | null> {
	const written = readInstallEnv(join(privateDir, '.env'));
	if (written === null) return null;
	const resolved = writtenListener(written);
	if ('refusal' in resolved) return null;
	const { listener } = resolved;
	const wildcard = listener.hostname === '0.0.0.0' || listener.hostname === '::';
	const bound = devListenerUrls(
		listener.hostname,
		listener.port,
		listener.tls !== null,
		wildcard ? lan() : [],
	);
	return {
		start: devStartCommand(privateDir),
		urls: openableUrls(bound, listener, written),
		network: listener.networkReachable,
		tls: await tlsView(listener),
	};
}

/** The leaf certificate of a PEM file (its first block), or null when unreadable. */
function leafOf(certFile: string): X509Certificate | null {
	try {
		const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(
			readFileSync(certFile, 'utf8'),
		)?.[0];
		return pem === undefined ? null : new X509Certificate(pem);
	} catch {
		return null;
	}
}

/** Does `leaf` answer the host of `url` (a DNS name or an IP literal)? */
function certifies(leaf: X509Certificate, url: string): boolean {
	const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
	return isIP(host) === 0 ? leaf.checkHost(host) !== undefined : leaf.checkIP(host) !== undefined;
}

/**
 * The addresses the final screen offers (campaign C4 S4: with the operator's
 * own certificate for `museo.example.org`, it listed 127.0.0.1, localhost and
 * the LAN IP — none of which that certificate names — and not the public
 * address). The public address (DEDALO_HOST) first when written; then each
 * bound address the certificate names (all of them when it names none).
 * Plain HTTP names every one. A
 * certificate that cannot be read leaves the bound list as it is (the boot
 * refuses it anyway).
 */
export function openableUrls(
	bound: readonly string[],
	listener: DevTcpListener,
	written: Readonly<Record<string, string>>,
): string[] {
	const host = written.DEDALO_HOST ?? '';
	// No DEDALO_PROTOCOL: the engine's own default (config catalog: `http://`).
	const publicUrl =
		host === '' ? [] : [`${written.DEDALO_PROTOCOL || 'http://'}${host}/dedalo/core/page/`];
	const all = [...new Set([...publicUrl, ...bound])];
	if (listener.tls === null) return all;
	const leaf = leafOf(listener.tls.certFile);
	if (leaf === null) return all;
	const certified = [...new Set([...publicUrl, ...bound.filter((url) => certifies(leaf, url))])];
	// A certificate naming none of them and no public address: the bound list,
	// never an empty "open" line (the browser then names the mismatch itself).
	return certified.length > 0 ? certified : all;
}

async function tlsView(listener: DevTcpListener): Promise<DevServedView['tls']> {
	if (listener.tls === null) return null;
	const anchor = anchorOf(listener);
	if (anchor === null) return { kind: 'files', certFile: listener.tls.certFile };
	const dir = dirname(anchor);
	const { devCaFingerprint } = await import('./dev_tls.ts');
	const { devAuthorityTrustedOnMachine, manualTrustSteps } = await import('./dev_trust.ts');
	return {
		kind: 'local_ca',
		caFile: anchor,
		fingerprint: devCaFingerprint(dir),
		trusted: await devAuthorityTrustedOnMachine(dir),
		manual: manualTrustSteps(process.platform, anchor),
	};
}
