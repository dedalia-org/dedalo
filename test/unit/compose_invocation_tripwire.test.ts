/**
 * TRIPWIRE — a TLS install cannot lose its TLS (P1-6, closes OPS-02 + OPS-04).
 *
 * `install.sh` puts the whole TLS decision into `.dedalo.env` — which compose
 * reads ONLY when handed `--env-file`, and which is deliberately not named
 * `.env` because the engine's own loader auto-loads that from the working
 * directory. The script's `compose()` helper always passed the flag. Every
 * operator-facing command OUTSIDE that helper omitted it: the guided path's own
 * printed "Logs:" and "Stop:" lines, and `docs/install/quickstart.md`'s
 * everyday commands including `up -d`.
 *
 * Run any of them on a TLS install and compose resolves the defaults instead:
 * plain HTTP on 80 with no `listen 443` at all, and an empty certbot renewal
 * profile. On a museum server HTTPS disappears, everything is in clear text,
 * and the certificate expires unrenewed within 90 days. Nothing says so.
 *
 * AND THE DEFAULTS CONTRADICTED THEMSELVES (OPS-04). `docker-compose.simple.yml`
 * defaulted `SESSION_COOKIE_SECURE` to `true` while defaulting the proxy to the
 * PLAIN-HTTP `nginx.simple.conf` — against its own header, 78 lines above,
 * saying "no TLS — plain HTTP, so SESSION_COOKIE_SECURE must be false". A
 * browser silently discards a `Secure` cookie over http://, so an operator
 * completed the wizard, chose a root password, and could never log in.
 *
 * CENSUS: TOTAL over `docs/install/**`, the deploy/ host scripts — and, since
 * the terminal installer (phase 4, 2026-10-12) took the stack over from
 * install.sh, the TypeScript stack steps' compose commands, EXECUTED: every
 * command the docker/trial host steps run is BUILT (src/core/install/host/stack/
 * compose.ts) for real plans of every route and TLS mode and read back — each
 * carries the stack file, the installer's override and `--env-file .dedalo.env`.
 * The TLS pairing install.sh used to write is the TS `.dedalo.env` renderer's
 * now: for every TLS mode it offers, the proxy config it names and the cookie's
 * Secure flag are ONE decision (decided from the config's own text). install.sh
 * itself — a POSIX bootstrap now — drives no compose at all.
 *
 * THE HOST LIBRARY (installer unification D2, 2026-10-09). The Docker-host tools
 * (install.sh's build, deploy/dedalo-image-update.sh, the host image updater)
 * reach compose through ONE function, `dedalo_compose` in
 * deploy/dedalo-image-lib.sh, whose argv always ends in `--env-file <file>` and
 * which refuses a missing env file. A call to it is compliant BY CONSTRUCTION —
 * which is only true if the library really does that, so the library is
 * EXECUTED here against a stub docker: the argv it hands compose is read back,
 * and a missing env file must reach no docker at all. The deploy/ half of the
 * census is DERIVED: every deploy/*.sh that drives compose, directly or through
 * the library, so a new host script is in the census the day it is written.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecCommand, HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { readyProbe } from '../../src/core/install/host/stack/database.ts';
import { stackEngineCommand } from '../../src/core/install/host/stack/engine_delegate.ts';
import { renderEnvFile, renderStackNginx } from '../../src/core/install/host/stack/files.ts';
import {
	ENV_FILE as INSTALLER_ENV_FILE,
	nginxConfOf,
	OVERRIDE_FILE,
	stackFileOf,
} from '../../src/core/install/host/stack/layout.ts';
import { STACK_HOST_STEPS } from '../../src/core/install/host/stack/table.ts';
import { socketHealthProbe } from '../../src/core/install/host/stack/up.ts';
import type { StackHostStepId } from '../../src/core/install/install_plan.ts';
import { stackPlanCtx } from '../helpers/install_host_scratch.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';

// The installer's release identity is the checkout's: a dev checkout names no image,
// so these cases are written for a STABLE installer (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = 'install.sh';

// ── the TypeScript stack steps' compose commands (phase 4) ───────────────────

/** Real docker/trial plans: every route × TLS mode × image source the installer offers. */
const STACK_PLANS: readonly Record<string, unknown>[] = [
	{ route: 'trial', entity: 'trial_museum' },
	{ route: 'trial', entity: 'trial_museum', image_source: 'build' },
	{
		route: 'docker',
		entity: 'museo',
		server_name: 'dedalo.example.org',
		letsencrypt_email: 'ops@example.org',
	},
	{ route: 'docker', entity: 'museo', server_name: 'dedalo.example.org', tls_mode: 'local_ca' },
	{
		route: 'docker',
		entity: 'museo',
		server_name: 'dedalo.example.org',
		tls_mode: 'files',
		tls_cert_path: '/etc/ssl/museo/fullchain.pem',
		tls_key_path: '/etc/ssl/museo/privkey.pem',
	},
];

/** Every exec a plan's stack steps list (their `unless` probes too) + the step-run probes. */
function stackExecs(ctx: HostPlanCtx): ExecCommand[] {
	const listed = (ctx.plan.steps as StackHostStepId[]).flatMap((step) =>
		STACK_HOST_STEPS[step].commands(ctx),
	);
	const execs = listed.filter((command): command is ExecCommand => command.kind === 'exec');
	return [
		...execs,
		...execs.flatMap((command) => (command.unless === undefined ? [] : [command.unless])),
		readyProbe(ctx),
		socketHealthProbe(ctx),
		stackEngineCommand(ctx, true),
	];
}

/** The compose invocations among them (argv[1] === 'compose'). */
function composeInvocations(ctx: HostPlanCtx): string[][] {
	return stackExecs(ctx)
		.map((command) => [...command.argv])
		.filter((argv) => argv[1] === 'compose');
}
const SIMPLE_STACK = 'docker-compose.simple.yml';

/** The env file install.sh writes, and the flag that makes compose read it. */
const ENV_FILE = '.dedalo.env';

/** The Docker-host library every host tool reaches compose through. */
const HOST_LIB = 'deploy/dedalo-image-lib.sh';

/**
 * Invocations that must NOT carry the env file, each with the reason. EMPTY since
 * 2026-10-12: its one entry was the quickstart's "no-certificate variant" — a bare
 * `up -d` with no install.sh run, which served the browser install wizard. The wizard
 * is gone (WC-2026-10-12-install-surface-removed): a stack started without an install
 * refuses to boot, so no honest bare invocation remains. The shape is kept so a future
 * exemption is a visible, reasoned edit.
 */
const BARE_BY_DESIGN: {
	file: string;
	rawLine: string;
	underHeading: string;
	reason: string;
}[] = [];

/**
 * Is this line inside the section that starts at `heading`? A section ends at
 * the next line that starts a heading or admonition at the same level.
 */
function isUnderHeading(file: string, targetLine: number, heading: string): boolean {
	const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
	let inside = false;
	for (const [index, raw] of lines.entries()) {
		if (raw.trimEnd() === heading) {
			inside = true;
			continue;
		}
		if (inside && /^(#{1,6} |\?{3} |!{3} )/.test(raw)) inside = false;
		if (index + 1 === targetLine) return inside;
	}
	return false;
}

function docsInstallFiles(): string[] {
	return readdirSync(join(REPO_ROOT, 'docs', 'install'))
		.filter((name) => name.endsWith('.md'))
		.map((name) => join('docs', 'install', name))
		.sort();
}

/**
 * The OTHER places that drive this stack. The first census called itself TOTAL
 * over install.sh + docs/install and was not: `deploy/dedalo-image-update.sh`
 * (the update path PRODUCTION.md and the engine's own refusal instruct an
 * operator to run), `deploy/dedalo-tls-rotate.sh` and `scripts/update_probe.ts`
 * all drove the simple stack bare. The image-update one is the worst of them —
 * it recreates ONLY the `dedalo` service, so nginx keeps serving HTTPS while the
 * engine comes back with the plain-HTTP defaults and the session cookie quietly
 * loses its Secure flag on a live TLS site.
 */
function deployAndScriptFiles(): string[] {
	const deployScripts = readdirSync(join(REPO_ROOT, 'deploy'))
		.filter((name) => name.endsWith('.sh'))
		.map((name) => join('deploy', name))
		.filter((file) => DRIVES_COMPOSE.test(readFileSync(join(REPO_ROOT, file), 'utf8')))
		.sort();
	return [...deployScripts, 'scripts/update_probe.ts'];
}

/** A shell script drives compose directly, or through the host library. */
const DRIVES_COMPOSE = /docker compose|\bdedalo_compose\b/;

/** A CALL of the library's compose function (not its definition, not `_args`). */
const LIBRARY_CALL = /(^|[\s;&|({])dedalo_compose\s/;

/**
 * Join backslash-continued lines and `&&`-chains before scanning.
 *
 * The first version of this census was LINE-GRANULAR, and a review planted three
 * realistic evasions it could not see: a command split across lines with `\`, a
 * `cmd && docker compose …` chain, and the compose file arriving through a shell
 * variable. A rule that only reads one physical line at a time is a rule about
 * formatting, not about commands.
 */
function logicalLines(source: string): { line: number; text: string; raw: string }[] {
	const physical = source.split('\n');
	const out: { line: number; text: string; raw: string }[] = [];
	let buffer = '';
	let start = 0;
	for (const [index, raw] of physical.entries()) {
		if (buffer === '') start = index + 1;
		const trimmedEnd = raw.trimEnd();
		if (trimmedEnd.endsWith('\\')) {
			buffer += `${trimmedEnd.slice(0, -1).trim()} `;
			continue;
		}
		const joined = buffer + raw.trim();
		out.push({ line: start, text: joined, raw: buffer === '' ? raw : joined });
		buffer = '';
	}
	if (buffer !== '') out.push({ line: start, text: buffer.trim(), raw: buffer.trim() });
	return out;
}

/** Every line mentioning the simple stack by name — the stack install.sh writes for. */
function simpleStackInvocations(file: string): { line: number; text: string; raw: string }[] {
	return invocationsIn(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
}

/**
 * The invocations in `source` (the text of `file`). A deploy/ SHELL script is
 * judged on EVERY compose command it runs, whatever names the stack — a script
 * there is a host tool, and `-f "$STACK"` must not escape by spelling — with
 * full-line comments skipped. Everywhere, a call of the library's
 * `dedalo_compose` is an invocation (judged by the library gate below).
 */
function invocationsIn(
	file: string,
	source: string,
): { line: number; text: string; raw: string }[] {
	const found: { line: number; text: string; raw: string }[] = [];
	const hostScript = file.startsWith('deploy/') && file.endsWith('.sh');
	for (const entry of logicalLines(source)) {
		if (hostScript && /^\s*#/.test(entry.raw)) continue;
		// SEGMENT the line: `… --env-file X stop && docker compose -f … up -d` used
		// to pass, because `--env-file` appeared SOMEWHERE on it and the bare half
		// rode the compliant half's flag. Each command is judged on its own.
		for (const text of entry.text.split(/&&|\|\||;/)) {
			if (isInvocation(text, hostScript)) {
				found.push({ line: entry.line, text: text.trim(), raw: entry.raw });
			}
		}
	}
	return found;
}

function isInvocation(text: string, hostScript: boolean): boolean {
	if (LIBRARY_CALL.test(text)) return true;
	if (!/docker'?,?\s*'?compose|docker compose/.test(text)) return false;
	// `docker compose version` is a capability probe, not a stack invocation.
	if (/docker compose version/.test(text)) return false;
	if (hostScript) return true;
	// install.sh names the file through a variable; the docs and the TS probe
	// spell it out.
	return (
		text.includes(SIMPLE_STACK) || text.includes('$COMPOSE_FILE') || text.includes('COMPOSE_BASE')
	);
}

/**
 * Is this invocation compliant? The env-file spellings, the deploy scripts'
 * ENV_FILE_ARGS idiom, the TS probe's argv constant — and the host library: a
 * `dedalo_compose` call, or the library's own `docker compose
 * "${compose_argv[@]}"`, whose argv the library gate below EXECUTES.
 */
function carriesEnvFile(file: string, text: string): boolean {
	// The exact file, not any file: `--env-file .env` names the one file
	// install.sh says must never be used, because the engine's own loader
	// auto-loads that from the working directory.
	if (text.includes(`--env-file ${ENV_FILE}`) || text.includes(`'${ENV_FILE}'`)) return true;
	// install.sh and the deploy scripts pass it through their own variable.
	// The variable's VALUE is pinned by its own test below, so this is not
	// a hole: `--env-file .env` — the one file install.sh says must never
	// be used — still fails, because it matches none of these.
	// Any quoting: install.sh builds some messages by concatenating a
	// single-quoted string with a double-quoted expansion, so the flag can
	// read `--env-file '"$ENV_FILE"'`.
	if (/--env-file\s+['"]*\$\{?ENV_FILE\}?/.test(text)) return true;
	// The sanctioned SHELL idiom for "pass it when it exists", used by the
	// deploy scripts which also serve the full stack (no such file there).
	if (text.includes('ENV_FILE_ARGS')) return true;
	// The TS probe passes it as an argv element.
	if (text.includes('COMPOSE_ENV_FILE')) return true;
	// The host library: its argv carries the env file, proven by execution below.
	if (LIBRARY_CALL.test(text)) return true;
	return file === HOST_LIB && text.includes('"${compose_argv[@]}"');
}

describe('a TLS install cannot lose its TLS', () => {
	const targets = [...docsInstallFiles(), ...deployAndScriptFiles()];

	test('the census actually finds invocations (anti-vacuity)', () => {
		// A matcher that found nothing would make the rule below pass forever.
		const total = targets.flatMap((file) => simpleStackInvocations(file));
		expect(total.length).toBeGreaterThan(8);
		// The installer's own: every plan's stack steps run compose many times.
		for (const raw of STACK_PLANS)
			expect(composeInvocations(stackPlanCtx(raw)).length, String(raw.route)).toBeGreaterThan(5);
	});

	test('install.sh (the bootstrap) drives no compose at all — the installer does', () => {
		const lines = readFileSync(join(REPO_ROOT, INSTALL_SH), 'utf8')
			.split('\n')
			.filter((line) => !/^\s*#/.test(line));
		expect(lines.filter((line) => /docker|compose/.test(line))).toEqual([]);
	});

	test("every compose command the installer's stack steps run carries the stack, its override and --env-file .dedalo.env", () => {
		const offenders: string[] = [];
		for (const raw of STACK_PLANS) {
			const ctx = stackPlanCtx(raw);
			for (const argv of composeInvocations(ctx)) {
				const line = argv.join(' ');
				const files = argv.slice(2, argv.indexOf('--env-file') + 2).join(' ');
				const stack = `-f ${stackFileOf(ctx.answers)}`;
				if (!files.startsWith(stack) || !files.includes(`-f ${OVERRIDE_FILE}`))
					offenders.push(`${String(raw.route)}: ${line}`);
				if (argv[argv.indexOf('--env-file') + 1] !== ENV_FILE)
					offenders.push(`${String(raw.route)}: ${line}`);
			}
		}
		expect(INSTALLER_ENV_FILE).toBe(ENV_FILE);
		expect(offenders).toEqual([]);
	});

	test('the deploy census is derived, and holds every host tool that drives compose', () => {
		const derived = deployAndScriptFiles();
		expect(derived.length).toBeGreaterThan(3);
		for (const file of [
			HOST_LIB,
			'deploy/dedalo-image-update.sh',
			'deploy/dedalo-tls-rotate.sh',
			'scripts/update_probe.ts',
		]) {
			expect(derived, `${file} must be in the derived census`).toContain(file);
		}
		// The updater reaches compose ONLY through the library (its `dc`; since C3-46 its
		// build mode builds through dedalo_image_build, not compose — one call site left).
		expect(simpleStackInvocations('deploy/dedalo-image-update.sh').length).toBeGreaterThan(0);
		expect(
			readFileSync(join(REPO_ROOT, 'deploy/dedalo-image-update.sh'), 'utf8')
				.split('\n')
				.filter((line) => !/^\s*#/.test(line) && /docker compose/.test(line)),
			'deploy/dedalo-image-update.sh runs `docker compose` itself instead of through dedalo_compose',
		).toEqual([]);
	});

	test('positive control: a bare host-script command is caught whatever names the stack', () => {
		const planted = [
			'#!/usr/bin/env bash',
			'# a comment saying docker compose up is not a command',
			'docker compose -f "$STACK" up -d dedalo',
			'docker compose -f "$STACK" --env-file "$ENV_FILE" up -d dedalo',
			'dedalo_compose "$ENV_FILE" plain up -d dedalo',
			'docker compose version',
		].join('\n');
		const found = invocationsIn('deploy/planted.sh', planted);
		expect(found.map((entry) => entry.line)).toEqual([3, 4, 5]);
		const bare = found.filter((entry) => !carriesEnvFile('deploy/planted.sh', entry.text));
		expect(bare.map((entry) => entry.line)).toEqual([3]);
		// The library's own argv idiom is trusted only IN the library.
		const idiom = 'docker compose "${compose_argv[@]}" "$@"';
		expect(carriesEnvFile(HOST_LIB, idiom)).toBe(true);
		expect(carriesEnvFile('deploy/planted.sh', idiom)).toBe(false);
	});

	test('every simple-stack invocation carries the env file', () => {
		const offenders: string[] = [];
		for (const file of targets) {
			for (const { line, text, raw } of simpleStackInvocations(file)) {
				if (carriesEnvFile(file, text)) continue;
				const excused = BARE_BY_DESIGN.some(
					(entry) =>
						entry.file === file &&
						entry.rawLine === raw &&
						isUnderHeading(file, line, entry.underHeading),
				);
				if (!excused) offenders.push(`${file}:${line}  ${text}`);
			}
		}
		expect(
			offenders,
			`A compose command without --env-file ${ENV_FILE} resolves the BUILT-IN defaults: ` +
				'plain HTTP, no listen 443, no certbot renewal. On a TLS install that silently ' +
				'removes HTTPS and lets the certificate expire. Add the flag, or add the line to ' +
				`BARE_BY_DESIGN with the reason it must stay bare.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	test('each BARE_BY_DESIGN exemption is still present and still reasoned', () => {
		// A stale exemption silently re-opens the hole it documents.
		for (const entry of BARE_BY_DESIGN) {
			expect(
				entry.reason.length,
				`${entry.file}: an exemption needs a real reason`,
			).toBeGreaterThan(80);
			const lines = readFileSync(join(REPO_ROOT, entry.file), 'utf8').split('\n');
			const matches = lines.filter(
				(line, index) =>
					line === entry.rawLine && isUnderHeading(entry.file, index + 1, entry.underHeading),
			).length;
			expect(
				matches,
				`${entry.file} must contain the excused line EXACTLY ONCE (found ${matches}). ` +
					'Zero means the exemption is stale and must be deleted; more than one means a ' +
					'second bare invocation is riding this excuse.',
			).toBe(1);
		}
	});

	test('the two compose defaults are ONE decision and agree', () => {
		// The OPS-04 shape: a Secure cookie over the plain-HTTP proxy this file's
		// own header says must not have one. Read the DEFAULTS, not the comments.
		const stack = readFileSync(join(REPO_ROOT, SIMPLE_STACK), 'utf8');
		const proxyDefault = stack.match(/\$\{DEDALO_NGINX_CONF:-([\w.]+)\}/)?.[1];
		const cookieDefault = stack.match(
			/SESSION_COOKIE_SECURE:\s*\$\{SESSION_COOKIE_SECURE:-(\w+)\}/,
		)?.[1];
		expect(
			proxyDefault,
			'DEDALO_NGINX_CONF default not found — has the stack changed shape?',
		).toBeString();
		expect(cookieDefault, 'SESSION_COOKIE_SECURE default not found').toBeString();

		// The plain-HTTP conf is the one WITHOUT a TLS listener. Decide from the
		// file, not from its name: a rename must not silently flip the meaning.
		// COMMENTS STRIPPED. A raw match turned a doc line saying "this stack does
		// NOT listen 443" into proof that it does, reddening the gate while nothing
		// about the stack had changed.
		const proxyConf = readFileSync(join(REPO_ROOT, 'deploy', proxyDefault ?? ''), 'utf8')
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		const servesTls = /listen\s+443/.test(proxyConf);
		expect(
			cookieDefault,
			`${SIMPLE_STACK} defaults the proxy to ${proxyDefault} (TLS: ${servesTls}) but defaults ` +
				`SESSION_COOKIE_SECURE to ${cookieDefault}. A browser silently DISCARDS a Secure ` +
				'cookie over http://, so every login appears to succeed and then does nothing — the ' +
				'operator finishes the wizard, chooses a root password, and can never log in. These ' +
				'two defaults are one decision.',
		).toBe(String(servesTls));
	});

	test('the installer writes both keys, paired, for every TLS mode it offers (the proxy config decides)', () => {
		// The default agreeing is not enough: the file the installer WRITES must pair
		// them too, or the guided path reintroduces the contradiction. Decided from
		// the config the env file NAMES (its text, comments stripped), never its name.
		const unpaired: string[] = [];
		for (const raw of STACK_PLANS) {
			const ctx = stackPlanCtx(raw);
			const env = renderEnvFile(ctx, 'pw');
			const conf = env.match(/^DEDALO_NGINX_CONF=(.+)$/m)?.[1];
			const cookie = env.match(/^SESSION_COOKIE_SECURE=(.+)$/m)?.[1];
			expect(conf, String(raw.route)).toBe(nginxConfOf(ctx.answers));
			const text =
				conf === nginxConfOf({ ...ctx.answers, route: 'trial' })
					? readFileSync(join(REPO_ROOT, 'deploy', conf ?? ''), 'utf8')
					: renderStackNginx(ctx);
			const servesTls = /listen\s+443/.test(
				text
					.split('\n')
					.filter((line) => !line.trimStart().startsWith('#'))
					.join('\n'),
			);
			if (cookie !== String(servesTls))
				unpaired.push(
					`${String(raw.route)} ${String(raw.tls_mode ?? '')}: ${conf} (TLS ${servesTls}) with SESSION_COOKIE_SECURE=${cookie}`,
				);
		}
		expect(
			unpaired,
			'A TLS mode names a proxy configuration without the cookie policy that goes with it. ' +
				'They are ONE decision: a TLS proxy needs a Secure cookie, a plain-HTTP proxy must not have one.',
		).toEqual([]);
		// Not vacuous: both outcomes occur.
		const cookies = STACK_PLANS.map(
			(raw) => renderEnvFile(stackPlanCtx(raw), 'pw').match(/^SESSION_COOKIE_SECURE=(.+)$/m)?.[1],
		);
		expect(new Set(cookies)).toEqual(new Set(['true', 'false']));
	});

	test('the env file every invocation names is really .dedalo.env', () => {
		// The flag test accepts $ENV_FILE, so the VALUE has to be pinned: compose would
		// read `.env` too, but so would the engine's loader from the working directory.
		expect(INSTALLER_ENV_FILE).toBe('.dedalo.env');
		expect(
			carriesEnvFile(
				'docs/install/x.md',
				'docker compose -f docker-compose.yml --env-file .env up -d',
			),
		).toBe(false);
		expect(
			carriesEnvFile(
				'docs/install/x.md',
				'docker compose -f docker-compose.yml --env-file .dedalo.env up -d',
			),
		).toBe(true);
	});
});

describe('the host library always hands compose the env file', () => {
	function runLibrary(
		envFile: string | null,
		variant: string,
	): {
		code: number;
		argv: string[] | null;
	} {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-compose-lib-'));
		try {
			const bin = join(dir, 'bin');
			Bun.spawnSync(['mkdir', '-p', bin]);
			writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ARGV_OUT"\n');
			chmodSync(join(bin, 'docker'), 0o755);
			writeFileSync(join(dir, SIMPLE_STACK), 'services: {}\n');
			if (envFile !== null) {
				writeFileSync(
					join(dir, envFile),
					`POSTGRES_DB=dedalo\nDEDALO_COMPOSE_FILE=${SIMPLE_STACK}\n`,
				);
			}
			const script = `set -euo pipefail\n. "$1"\ndedalo_compose "$2" "$3" up -d dedalo`;
			const run = Bun.spawnSync(
				['bash', '-c', script, 'lib', join(REPO_ROOT, HOST_LIB), envFile ?? ENV_FILE, variant],
				{ cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, ARGV_OUT: join(dir, 'argv') } },
			);
			let argv: string[] | null = null;
			try {
				argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1);
			} catch {
				argv = null;
			}
			return { code: run.exitCode ?? -1, argv };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test('plain: -f <the stack the env file names> --env-file <that file>, then the command', () => {
		const { code, argv } = runLibrary(ENV_FILE, 'plain');
		expect(code).toBe(0);
		expect(argv).toEqual([
			'compose',
			'-f',
			SIMPLE_STACK,
			'--env-file',
			ENV_FILE,
			'up',
			'-d',
			'dedalo',
		]);
	});

	test('build: the override joins the stack, the env file still travels', () => {
		const { code, argv } = runLibrary(ENV_FILE, 'build');
		expect(code).toBe(0);
		expect(argv).toEqual([
			'compose',
			'-f',
			SIMPLE_STACK,
			'-f',
			'deploy/compose.build.yml',
			'--env-file',
			ENV_FILE,
			'up',
			'-d',
			'dedalo',
		]);
	});

	test('no env file: refused, and docker is never run', () => {
		const { code, argv } = runLibrary(null, 'plain');
		expect(code).not.toBe(0);
		expect(argv).toBeNull();
	});
});
