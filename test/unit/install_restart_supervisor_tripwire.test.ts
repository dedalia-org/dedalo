/**
 * TRIPWIRE — the restart supervisor contract, and the not-installed exit no supervisor
 * may restart.
 *
 * PLANNED RESTART (exit 75). A code update or a code restore (src/core/update/
 * code_update.ts, code_restore.ts) swaps the tree and then EXITS the server on purpose:
 * `config` and the module graph are read once at import, so only a fresh process runs
 * the new code. That is only half a mechanism — something must bring the process back.
 * (Until 2026-10-12 the browser install wizard's persist_config was the other
 * requester; it is gone — WC-2026-10-12-install-surface-removed.) This was once
 * hypothetical-proof: restart.ts justified its exit by naming a `start:supervised` loop
 * that WAS NEVER WRITTEN, and every dev on `bun run dev` got a dead server.
 *
 * REFUSED BOOT (exit 78, NOT_INSTALLED_EXIT_CODE, src/config/install_state.ts). A box
 * that is not installed refuses to start; restarting it only re-reads the same missing
 * configuration and fills the journal. Every systemd unit and dev supervisor this repo
 * ships must STOP on it (a container cannot: Docker has no per-exit-code restart policy,
 * so the compose engine restarts with backoff — engineering/PRODUCTION.md §7.1).
 *
 * So the contract is mechanical, not prose:
 *   1. the supervised run scripts EXIST in package.json, and
 *   2. they respawn on exactly RESTART_EXIT_CODE — the one the server actually exits
 *      with — and on nothing else (^C exits 0 and must QUIT, a crash must NOT hot-loop,
 *      a refusal (78) must stop) — the inline loops are EXECUTED against a stub server;
 *   3. the systemd units do not count the planned exit as a failure, and carry
 *      RestartPreventExitStatus=78 (never SuccessExitStatus=78), and the watchdog does
 *      not restart a unit that failed with 78 (driven below);
 *   4. the systemd unit CREATES the socket directory (RuntimeDirectory), and every
 *      shipped consumer of the socket agrees on one canonical /run/dedalo path — a
 *      fresh-install 502 traced to a missing /run/dedalo and a /tmp-vs-/run drift.
 */

import { describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_INSTALLED_EXIT_CODE } from '../../src/config/install_state.ts';
import { certificatePaths, siteText } from '../../src/core/install/host/production/web.ts';
import { RESTART_EXIT_CODE } from '../../src/core/update/restart.ts';
import { HOST_VARIANTS, productionPlanCtx, REPO_ROOT } from '../helpers/install_host_scratch.ts';

/**
 * The site file the PRODUCTION INSTALLER writes for an instance `site1` — the
 * multi-instance vhost an operator once copied from the manual is now RENDERED
 * (src/core/install/host/web/), so the rendered text is what these route gates
 * hold, by the same label the manual samples are held by.
 */
const INSTALLER_SITE_NGINX = 'installer site (nginx, instance site1)';
const INSTALLER_SITE_APACHE = 'installer site (apache, instance site1)';
function installerSite(web: 'nginx' | 'apache'): string {
	const variant = HOST_VARIANTS.find((v) => v.web === web && v.tls === 'letsencrypt');
	if (variant === undefined) throw new Error(`no ${web} host variant`);
	const ctx = productionPlanCtx(variant, REPO_ROOT, {
		instance: 'site1',
		server_name: 'site1.example.org',
	});
	return siteText(ctx, certificatePaths(ctx));
}
const RENDERED_SITES: ReadonlyMap<string, () => string> = new Map([
	[INSTALLER_SITE_NGINX, () => installerSite('nginx')],
	[INSTALLER_SITE_APACHE, () => installerSite('apache')],
]);

const pkg = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
	scripts: Record<string, string>;
};

/** The run scripts that must survive a planned restart (code update) unattended. */
const SUPERVISED_SCRIPTS = ['start:supervised', 'dev'];

describe('restart supervisor contract', () => {
	test('RESTART_EXIT_CODE is a real, non-zero, non-signal exit code', () => {
		// 0 would collide with a graceful shutdown; >125 collides with the shell's
		// signal/not-found encodings.
		expect(RESTART_EXIT_CODE).toBeGreaterThan(0);
		expect(RESTART_EXIT_CODE).toBeLessThan(126);
	});

	test('the server exits with RESTART_EXIT_CODE (not a bare 0) to ask for a restart', async () => {
		const src = await Bun.file(new URL('../../src/core/update/restart.ts', import.meta.url)).text();
		expect(src).toContain('process.exit(RESTART_EXIT_CODE)');
		// A literal exit(0) here would silently re-break the supervisor loops:
		// they cannot distinguish it from an operator ^C.
		expect(src).not.toContain('process.exit(0)');
	});

	for (const name of SUPERVISED_SCRIPTS) {
		test(`package.json '${name}' exists and respawns on exactly ${RESTART_EXIT_CODE}`, async () => {
			const script = pkg.scripts[name];
			// The failure this whole file exists to prevent: the code names a
			// supervisor script that nobody ever wrote.
			expect(script).toBeString();

			// A supervisor may be written two ways, and BOTH must satisfy the same contract:
			//
			//   (a) INLINE in package.json — a shell `while` loop (start:supervised);
			//   (b) DELEGATED to a TS file — `bun run scripts/<x>.ts` (dev, which also runs the
			//       CSS watcher, so it outgrew a one-line shell script).
			//
			// Resolve (b) to the file that actually holds the loop, then apply the SAME two
			// assertions to whichever source really implements it. Checking only the
			// package.json string would let a delegated supervisor drop the contract silently.
			const delegated = /bun run (scripts\/[\w./-]+\.ts)/.exec(script ?? '');
			const source =
				delegated?.[1] === undefined
					? (script as string)
					: await Bun.file(new URL(`../../${delegated[1]}`, import.meta.url)).text();

			// It must key on the SAME code the server exits with — not a stale copy. A TS
			// supervisor proves that by IMPORTING the constant; a shell one has no imports, so
			// it may only spell the number.
			if (delegated?.[1] === undefined) {
				expect(source).toContain(String(RESTART_EXIT_CODE));
				// ...and it must propagate any OTHER code instead of looping on it, so
				// ^C (exit 0) quits and a crash stops rather than spinning.
				expect(source).toContain('exit $code');
			} else {
				expect(source).toContain('RESTART_EXIT_CODE');
				expect(source).toContain('update/restart.ts');
				// Same rule, TS spelling: anything that is NOT the restart code is propagated.
				expect(source).toContain('code !== RESTART_EXIT_CODE');
				expect(source).toContain('process.exit(code)');
			}
		});
	}

	test('NOT_INSTALLED_EXIT_CODE is distinct from success, a crash and the restart code', () => {
		expect(NOT_INSTALLED_EXIT_CODE).toBe(78); // EX_CONFIG
		expect([0, 1, RESTART_EXIT_CODE]).not.toContain(NOT_INSTALLED_EXIT_CODE);
	});

	// The inline loops, EXECUTED: `bun` on PATH is a stub that logs each launch and exits
	// with the next code of a scripted sequence. A loop that respawned on 78 would launch
	// again (and, with the sequence exhausted, spin) — the cap below turns that into red.
	for (const name of ['start:supervised', 'dev:server']) {
		test(`package.json '${name}' respawns on ${RESTART_EXIT_CODE} and STOPS on ${NOT_INSTALLED_EXIT_CODE} (executed)`, () => {
			const script = pkg.scripts[name];
			expect(script).toBeString();
			const dir = mkdtempSync(join(tmpdir(), 'dedalo_zzi_supervisor_'));
			try {
				const log = join(dir, 'launches');
				const codes = join(dir, 'codes');
				writeFileSync(
					join(dir, 'bun'),
					[
						'#!/usr/bin/env bash',
						`echo launch >> "${log}"`,
						`n=$(wc -l < "${log}" | tr -d ' ')`,
						'[ "$n" -gt 5 ] && exit 99',
						`code=$(sed -n "\${n}p" "${codes}")`,
						'exit "${code:-99}"',
						'',
					].join('\n'),
				);
				chmodSync(join(dir, 'bun'), 0o755);
				const run = (sequence: number[]): { exitCode: number | null; launches: number } => {
					rmSync(log, { force: true });
					writeFileSync(codes, `${sequence.join('\n')}\n`);
					const proc = Bun.spawnSync(['bash', '-c', script as string], {
						env: { PATH: `${dir}:${Bun.env.PATH ?? ''}` },
						stdout: 'pipe',
						stderr: 'pipe',
					});
					const launches = existsSync(log)
						? readFileSync(log, 'utf8').trim().split('\n').length
						: 0;
					return { exitCode: proc.exitCode, launches };
				};
				expect(run([NOT_INSTALLED_EXIT_CODE])).toEqual({
					exitCode: NOT_INSTALLED_EXIT_CODE,
					launches: 1,
				});
				expect(run([RESTART_EXIT_CODE, NOT_INSTALLED_EXIT_CODE])).toEqual({
					exitCode: NOT_INSTALLED_EXIT_CODE,
					launches: 2,
				});
				expect(run([RESTART_EXIT_CODE, 0])).toEqual({ exitCode: 0, launches: 2 });
				expect(run([1])).toEqual({ exitCode: 1, launches: 1 });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test('the TS supervisor (scripts/dev.ts) propagates every non-restart code, 78 included', async () => {
		const source = await Bun.file(new URL('../../scripts/dev.ts', import.meta.url)).text();
		// One branch decides: anything !== RESTART_EXIT_CODE exits with that code. A
		// special case that respawned on 78 would have to name it — refused here.
		expect(source).toContain('code !== RESTART_EXIT_CODE');
		expect(source).not.toMatch(/===\s*78|NOT_INSTALLED_EXIT_CODE\s*\)/);
	});

	test('both systemd units refuse to restart a not-installed exit, and never book it a success', async () => {
		for (const path of ['deploy/dedalo-ts.service', 'deploy/systemd/dedalo-ts@.service']) {
			const unit = await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
			const prevent = unit.match(/^RestartPreventExitStatus=(.+)$/m)?.[1]?.split(/\s+/) ?? [];
			expect(prevent, path).toContain(String(NOT_INSTALLED_EXIT_CODE));
			const success = unit.match(/^SuccessExitStatus=(.+)$/m)?.[1]?.split(/\s+/) ?? [];
			expect(success, path).toContain(String(RESTART_EXIT_CODE));
			expect(success, path).not.toContain(String(NOT_INSTALLED_EXIT_CODE));
		}
	});

	test('systemd does not book the planned restart exit as a failure', async () => {
		const unit = await Bun.file(new URL('../../deploy/dedalo-ts.service', import.meta.url)).text();
		expect(unit).toContain(`SuccessExitStatus=${RESTART_EXIT_CODE}`);
		// Restart=always is what actually brings it back in production.
		expect(unit).toContain('Restart=always');
	});

	// Restart=always is NOT self-sufficient: systemd's default start-limit (5 starts
	// per 10 s) sits right on top of RestartSec=3, so a burst of PLANNED restarts or
	// a slow Postgres can leave the unit `failed` with nothing to bring it back —
	// the exact outage Restart=always is there to prevent.
	test('dedalo-ts.service widens the crash-loop budget past its own restart cadence', async () => {
		const unit = await Bun.file(new URL('../../deploy/dedalo-ts.service', import.meta.url)).text();
		const interval = unit.match(/^StartLimitIntervalSec=(\d+)$/m);
		const burst = unit.match(/^StartLimitBurst=(\d+)$/m);
		const restartSec = unit.match(/^RestartSec=(\d+)$/m);
		expect(interval).not.toBeNull();
		expect(burst).not.toBeNull();
		expect(restartSec).not.toBeNull();
		// The budget must allow at least `burst` restarts at the configured cadence,
		// i.e. the window has to be wider than burst × RestartSec.
		const windowSeconds = Number(interval?.[1]);
		const allowedStarts = Number(burst?.[1]);
		const cadenceSeconds = Number(restartSec?.[1]);
		expect(windowSeconds).toBeGreaterThan(allowedStarts * cadenceSeconds);
	});

	// engineering/PRODUCTION.md promises diffusion runners survive a restart. That
	// promise lives ENTIRELY in this line: systemd's default KillMode=control-group
	// SIGTERMs (then SIGKILLs) every runner alongside the server, truncating long
	// publications mid-flight while the doc still claims they survive.
	test('dedalo-ts.service signals only the server, so diffusion runners survive', async () => {
		const unit = await Bun.file(new URL('../../deploy/dedalo-ts.service', import.meta.url)).text();
		expect(unit).toMatch(/^KillMode=process$/m);
	});

	// The socket-directory contract (added after a fresh-install 502). The engine
	// binds SERVER_UNIX_SOCKET but does NOT create its parent dir, and /run is a
	// tmpfs wiped every reboot — so the shipped unit MUST create /run/dedalo via
	// RuntimeDirectory, and every shipped consumer of the socket MUST name the one
	// canonical path. A /tmp-vs-/run drift makes the watchdog probe the wrong socket
	// and fire OnFailure=dedalo-ts-restart every 30 s in a loop.
	const CANONICAL_SOCKET = '/run/dedalo/dedalo_ts.sock';
	const STALE_SOCKET = '/tmp/dedalo_ts.sock';

	test('dedalo-ts.service creates the socket dir with RuntimeDirectory=dedalo', async () => {
		const unit = await Bun.file(new URL('../../deploy/dedalo-ts.service', import.meta.url)).text();
		expect(unit).toContain('RuntimeDirectory=dedalo');
	});

	test('the watchdog and the reverse proxy agree on /run/dedalo (no /tmp drift)', async () => {
		const watchdog = await Bun.file(
			new URL('../../deploy/dedalo-ts-watchdog.service', import.meta.url),
		).text();
		const nginx = await Bun.file(new URL('../../deploy/nginx.conf', import.meta.url)).text();

		expect(watchdog).toContain(CANONICAL_SOCKET);
		expect(watchdog).not.toContain(STALE_SOCKET);
		// nginx's upstream must reach the same socket the engine binds.
		expect(nginx).toContain(CANONICAL_SOCKET);
		expect(nginx).not.toContain(STALE_SOCKET);

		// Same for the Apache twin: a drifted socket there is the same 502.
		const apache = await Bun.file(new URL('../../deploy/apache.conf', import.meta.url)).text();
		expect(apache).toContain(CANONICAL_SOCKET);
		expect(apache).not.toContain(STALE_SOCKET);
	});

	// THE /health ROUTE (2026-08-24): the engine serves its liveness check at the
	// ORIGIN ROOT (src/server.ts) and the BROWSER client probes it over HTTP
	// (data_manager.js getHealthUrl, the system_info + update_code widgets, service_worker.js).
	// A proxy config that does not route it does not fail loudly: the engine stays
	// healthy while the widget reports it down and the post-update restart poll
	// can never confirm the new version — observed as Apache AH01630 denying
	// /var/www/html/health. Every shipped proxy config must carry the route — AND
	// so must every proxy sample in the manual: an operator copy-pastes the
	// documented vhost, so a hole there reaches production exactly like a hole in
	// deploy/. Three samples were found empty on 2026-08-28 (the docs nginx block
	// and both multi-instance blocks), which is what this list prevents recurring. The
	// multi-instance vhost is now the installer's rendered site, held here the same way.
	test('every shipped proxy config and documented sample routes /health', async () => {
		// deploy/: the configs an operator installs verbatim.
		for (const path of ['deploy/nginx.conf', 'deploy/nginx.simple.conf']) {
			const conf = await Bun.file(new URL(`../../${path}`, import.meta.url)).text();
			expect(conf, `${path} must route /health`).toMatch(/location\s*=\s*\/health\s*\{/);
		}
		const apache = await Bun.file(new URL('../../deploy/apache.conf', import.meta.url)).text();
		expect(apache).toMatch(/^\s*ProxyPass\s+\/health\s+unix:/m);

		// docs/: the page ships BOTH flavours, so it must carry both rules — and so must
		// the site the production installer renders for an instance.
		const page = await Bun.file(
			new URL('../../docs/install/reverse_proxy.md', import.meta.url),
		).text();
		const nginxSite = installerSite('nginx');
		const apacheSite = installerSite('apache');
		expect(nginxSite, `${INSTALLER_SITE_NGINX} must route /health`).toMatch(
			/location\s*=\s*\/health\s*\{/,
		);
		expect(apacheSite, `${INSTALLER_SITE_APACHE} must route /health`).toMatch(
			/^\s*ProxyPass\s+\/health\s+unix:/m,
		);
		for (const path of ['docs/install/reverse_proxy.md']) {
			expect(page, `${path}: the nginx sample must route /health`).toMatch(
				/location\s*=\s*\/health\s*\{/,
			);
			expect(page, `${path}: the Apache sample must route /health`).toMatch(
				/^\s*ProxyPass\s+\/health\s+unix:/m,
			);
		}
	});

	// EVERY ENGINE ROUTE UNDER /dedalo/ MUST BE PROXIED (2026-08-28). /health was
	// not the only hole: `/dedalo/install/code/`, `/dedalo/ai_models/`,
	// `/dedalo/install/import/hierarchy/` and `/dedalo/upload_tmp/` were routed in
	// NO config and NO documented sample, while their siblings (lib/, tools/,
	// install/import/ontology/) were routed in all six. These paths have no client
	// subtree, so an omitted rule does not fall through to the engine: the
	// `/dedalo/` static alias answers 404 and the request never reaches the
	// socket. The code one is the sharp case — it is the URL the update manifest
	// ADVERTISES to remote installs, and serving a 404 there is exactly the defect
	// core/update/code_serving.ts was written to end.
	//
	// The list is DERIVED from src/, never hand-maintained here, so adding a route
	// and forgetting the proxy layer fails HERE rather than in an operator's
	// install. Two derivations, because the engine declares routes two ways:
	// exported constants, and inline literals in the server.ts routing branches.
	// The second test below is what keeps the FIRST one honest — a route added in
	// either shape has to be classified before this file goes green.

	/** Route prefixes served from disk by the web server, never proxied. */
	const NEVER_PROXIED: ReadonlyMap<string, string> = new Map([
		[
			'/dedalo/media/',
			'media is served FROM DISK by the web server (engineering/PRODUCTION.md): ' +
				'putting the engine in the byte path breaks sendfile, Range and streaming',
		],
	]);

	/**
	 * Engine routes declared as an INLINE literal in a server.ts branch rather
	 * than an exported constant. Each needs a reason, and each is asserted below
	 * with its own matcher because two of them are not plain prefix rules.
	 */
	const LITERAL_ROUTES: ReadonlyMap<string, string> = new Map([
		[
			'/dedalo/install/import/ontology/',
			'ontology-master snapshots (server.ts serveOntologyIoFile); plain prefix rule',
		],
		[
			'/dedalo/core/api/',
			'the JSON API + raw/environment/counters twins; nginx serves it with a ' +
				'REGEX location, so it is asserted separately from the prefix rules',
		],
		[
			'/dedalo/core/component_text_area/tag/',
			'the inline-tag image factory; an EXACT (=) location, not a prefix',
		],
	]);

	/** Read a repo file by path, without percent-encoding surprises. */
	async function repoText(rel: string): Promise<string> {
		const rendered = RENDERED_SITES.get(rel);
		if (rendered !== undefined) return rendered();
		return await Bun.file(fileURLToPath(new URL(`../../${rel}`, import.meta.url))).text();
	}

	/**
	 * Every `/dedalo/…` route prefix the engine exports as a constant — in src/
	 * AND in the tools' server modules, whose routes the router dispatches
	 * through `ToolServerModule.httpRoutes` (e.g. tool_export's
	 * EXPORT_ARTIFACT_URL_PREFIX, unbuffered in nginx for multi-GB downloads).
	 * The last test below proves every LOADED tool route is in this set.
	 */
	async function derivedRoutePrefixes(): Promise<Set<string>> {
		const prefixes = new Set<string>();
		const files: string[] = [];
		const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
		for await (const rel of new Bun.Glob('**/*.ts').scan({ cwd: srcDir })) {
			files.push(`${srcDir}${rel}`);
		}
		const toolsDir = fileURLToPath(new URL('../../tools/', import.meta.url));
		for await (const rel of new Bun.Glob('tool_*/server/**/*.ts').scan({ cwd: toolsDir })) {
			if (!rel.endsWith('.test.ts')) files.push(`${toolsDir}${rel}`);
		}
		for (const file of files) {
			const text = await Bun.file(file).text();
			// Both shapes the engine uses today: _URL_PREFIX and _URL_BASE. Naming
			// alone is not trusted — the completeness test below cross-checks the
			// result against the routing branches themselves.
			for (const m of text.matchAll(/_URL_(?:PREFIX|BASE)\s*=\s*'(\/dedalo\/[^']*)'/g)) {
				const prefix = (m[1] as string).replace(/\/$/, '');
				if (!NEVER_PROXIED.has(`${prefix}/`)) prefixes.add(prefix);
			}
		}
		return prefixes;
	}

	/** A live (non-commented) rule, so a commented-out block cannot satisfy a gate. */
	function hasLiveRule(text: string, pattern: RegExp): boolean {
		return text.split('\n').some((line) => !line.trim().startsWith('#') && pattern.test(line));
	}

	test('every engine /dedalo/ route prefix is proxied in all configs and samples', async () => {
		const prefixes = await derivedRoutePrefixes();

		// Guard the derivation: a regex that silently stopped matching would make
		// this whole gate vacuous. Pinned to today's set, shrink-only by hand.
		expect([...prefixes].sort()).toEqual([
			'/dedalo/ai_models',
			'/dedalo/export/artifact',
			'/dedalo/install/code',
			'/dedalo/install/import/hierarchy',
			'/dedalo/lib',
			'/dedalo/tools',
			'/dedalo/upload_tmp',
		]);

		// Each file, with the upstream its own samples use. A rule that names the
		// WRONG upstream (dedalo_site2 in the site1 vhost) must not pass, so the
		// upstream is part of the assertion, not just the location line.
		const nginxFiles: ReadonlyArray<readonly [string, string]> = [
			['deploy/nginx.conf', 'dedalo_ts'],
			['deploy/nginx.simple.conf', 'dedalo_ts'],
			['deploy/nginx.simple-tls.conf.tpl', 'dedalo_ts'],
			['docs/install/reverse_proxy.md', 'dedalo_ts'],
			[INSTALLER_SITE_NGINX, 'dedalo_site1'],
		];
		const apacheFiles: ReadonlyArray<readonly [string, string]> = [
			['deploy/apache.conf', '/run/dedalo/dedalo_ts.sock'],
			['docs/install/reverse_proxy.md', '/run/dedalo/dedalo_ts.sock'],
			[INSTALLER_SITE_APACHE, '/run/dedalo-site1/dedalo_ts.sock'],
		];
		const all = [...prefixes, ...LITERAL_ROUTES.keys()]
			.map((p) => p.replace(/\/$/, ''))
			// The API prefix is served by a regex location in nginx; asserted below.
			.filter((p) => p !== '/dedalo/core/api');

		for (const [path, upstream] of nginxFiles) {
			const text = await repoText(path);
			for (const prefix of all) {
				// `location [=] <prefix>[/] { … proxy_pass http://<upstream>; }` —
				// the body is part of the match, so a rule with no proxy_pass, or one
				// aimed at another instance, fails.
				const block = new RegExp(
					`location\\s+(?:=\\s+)?${prefix}/?\\s*\\{[^}]*proxy_pass\\s+http://${upstream};`,
				);
				expect(block.test(text), `${path}: nginx must proxy ${prefix} to ${upstream}`).toBe(true);
				expect(
					hasLiveRule(text, new RegExp(`^\\s*location\\s+(?:=\\s+)?${prefix}/?\\s*\\{`)),
					`${path}: the ${prefix} rule must not be commented out`,
				).toBe(true);
			}
		}
		for (const [path, socket] of apacheFiles) {
			const text = await repoText(path);
			for (const prefix of all) {
				expect(
					hasLiveRule(text, new RegExp(`^\\s*ProxyPass\\s+${prefix}/?\\s+unix:${socket}\\|`)),
					`${path}: Apache must proxy ${prefix} to ${socket}`,
				).toBe(true);
			}
		}

		// The API twin, whose nginx form is a regex location.
		for (const [path] of nginxFiles) {
			const text = await repoText(path);
			expect(text, `${path}: nginx must route the /dedalo/core/api/ twin`).toContain(
				'dedalo/core/api/',
			);
		}
	});

	// COMPLETENESS: the derivation above trusts a NAMING CONVENTION, and four of
	// the engine's routes do not follow it (they are inline literals in a
	// server.ts branch). Without this test the gate would silently cover a subset
	// and still read as exhaustive — which is how the four holes survived. Every
	// `/dedalo/…` literal the ROUTER compares against must be classified: proxied,
	// literal-routed, never-proxied, or the client static tree itself.
	test('no engine /dedalo/ route escapes classification', async () => {
		const server = await repoText('src/server.ts');
		const prefixes = await derivedRoutePrefixes();

		// Everything server.ts routes on: startsWith/endsWith tests and the path Sets.
		const routed = new Set<string>();
		for (const m of server.matchAll(/(?:startsWith|endsWith)\('(\/dedalo\/[^']*)'\)/g)) {
			routed.add(m[1] as string);
		}
		for (const m of server.matchAll(/'(\/dedalo\/[^']*)'/g)) {
			routed.add(m[1] as string);
		}

		// Served from disk by the proxy (or answered by its own `location =` rule),
		// so they need no socket route. Each is here with its reason, not matched by
		// a catch-all regex — an unrecognised path must fail, not be absorbed.
		const CLIENT_STATIC: ReadonlyMap<string, string> = new Map([
			['/dedalo', 'entry-point redirect; nginx answers it with `location = /dedalo`'],
			['/dedalo/', 'entry-point redirect twin'],
			['/dedalo/core', 'entry-point redirect'],
			['/dedalo/core/', 'entry-point redirect'],
			['/dedalo/core/page/', 'the redirect TARGET — a real directory in the client tree'],
			['/dedalo/<mediaDir>/', 'a placeholder in a doc comment, not a routed path'],
		]);

		const classified = (path: string): boolean => {
			const bare = path.replace(/\/$/, '');
			if (prefixes.has(bare)) return true;
			if (CLIENT_STATIC.has(path)) return true;
			const startsWithKnown = (keys: Iterable<string>): boolean =>
				[...keys].some((p) => bare.startsWith(p.replace(/\/$/, '')));
			return startsWithKnown(NEVER_PROXIED.keys()) || startsWithKnown(LITERAL_ROUTES.keys());
		};

		const unclassified = [...routed].filter((path) => !classified(path));
		expect(
			unclassified,
			'A /dedalo/ path reached the router with no proxy classification. Add it to ' +
				'the six proxy configs and let it be derived, or record it in ' +
				'LITERAL_ROUTES / NEVER_PROXIED with a written reason.',
		).toEqual([]);
	});

	// The router's THIRD source of routes: the loaded tools' httpRoutes
	// (loader.ts toolHttpRouteFor). No literal in server.ts names them, so the
	// scan above cannot see them — the registry itself is asked here.
	test('every loaded tool route is a derived, proxied prefix', async () => {
		const { loadToolModules } = await import('../../src/core/tools/loader.ts');
		const prefixes = await derivedRoutePrefixes();
		const toolRoutes: string[] = [];
		for (const loaded of (await loadToolModules()).values()) {
			for (const route of loaded.module.httpRoutes ?? []) toolRoutes.push(route.pathPrefix);
		}
		// anti-vacuity: tool_export's download route is one of them
		expect(toolRoutes).toContain('/dedalo/export/artifact/');
		const unproxied = toolRoutes.filter((prefix) => !prefixes.has(prefix.replace(/\/$/, '')));
		expect(
			unproxied,
			'A tool serves a route the proxy census does not derive. Declare its prefix as an ' +
				'exported `*_URL_PREFIX` constant in the tool server module and add it to the six proxy configs.',
		).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// THE CODE-UPDATE ROLLBACK CONTRACT (2026-08-23): the update pipeline
	// (src/core/update/code_update.ts) writes a pending sentinel and restarts;
	// systemd must (a) fire the rollback when the new tree never boots
	// (OnFailure= on the main unit) and (b) let the watchdog SCRIPT choose
	// rollback-vs-restart itself (so its unit must NOT carry an OnFailure=
	// that would race the rollback it just started).
	// -----------------------------------------------------------------------

	test('dedalo-ts.service fires the rollback unit on failure', async () => {
		const unit = await Bun.file(new URL('../../deploy/dedalo-ts.service', import.meta.url)).text();
		expect(unit).toMatch(/^OnFailure=dedalo-ts-rollback\.service$/m);
	});

	test('the rollback unit exists and runs the rollback script on the canonical socket', async () => {
		const unit = await Bun.file(
			new URL('../../deploy/dedalo-ts-rollback.service', import.meta.url),
		).text();
		expect(unit).toContain('dedalo-code-rollback.sh');
		expect(unit).toContain(CANONICAL_SOCKET);
		expect(unit).not.toContain(STALE_SOCKET);
	});

	test('the watchdog unit runs the probe SCRIPT and carries no OnFailure of its own', async () => {
		const unit = await Bun.file(
			new URL('../../deploy/dedalo-ts-watchdog.service', import.meta.url),
		).text();
		// The remedy choice lives in the script; an OnFailure= restart here would
		// race the rollback the script just started.
		expect(unit).toMatch(/^ExecStart=.*dedalo-ts-watchdog\.sh/m);
		expect(unit).not.toMatch(/^OnFailure=/m);
	});

	test('the rollback + watchdog SCRIPTS agree with the pipeline on the sentinel and the socket', async () => {
		const rollback = await Bun.file(
			new URL('../../deploy/dedalo-code-rollback.sh', import.meta.url),
		).text();
		const watchdogSh = await Bun.file(
			new URL('../../deploy/dedalo-ts-watchdog.sh', import.meta.url),
		).text();
		const pipeline = await Bun.file(
			new URL('../../src/core/update/code_update.ts', import.meta.url),
		).text();
		// One sentinel name across writer and both readers.
		for (const text of [rollback, watchdogSh, pipeline]) {
			expect(text).toContain('last_code_update.json');
		}
		// The scripts key on the exact machine-written pending state.
		expect(rollback).toContain('"pending"');
		expect(watchdogSh).toContain('rollback_attempted');
		// Socket literal still agrees (script defaults).
		expect(rollback).toContain(CANONICAL_SOCKET);
		expect(watchdogSh).toContain(CANONICAL_SOCKET);
		// LOAD-BEARING: the backup keeps node_modules (rollback bootability) —
		// the pipeline must not preserve it forward across the swap.
		expect(pipeline).toMatch(/PRESERVE_ROOT_ENTRIES[^\n]*=\s*new Set\(\['\.git'\]\)/);
	});

	// -----------------------------------------------------------------------
	// SUPERVISOR REACHABILITY + BACKUP-ROOT RESOLUTION (2026-08-23 review):
	// (A) the rollback/watchdog scripts' INSTALLED location must be OUTSIDE
	//     the swapped tree — in crash window W1 (old tree renamed away, new
	//     tree not yet in) an in-tree ExecStart has no script to run and the
	//     install is bricked exactly when automatic rollback was the point;
	// (B) the scripts must resolve DEDALO_BACKUP_PATH the way the engine does
	//     (process env, then <private>/.env, then the default) — the units do
	//     not source .env, so a default-only script is silently inert on any
	//     install that relocated backups;
	// (C) a sentinel written pre-swap may name a backupDir that never got
	//     created — four explicit states, driven below against a real fixture.
	// -----------------------------------------------------------------------

	const deployDir = new URL('../../deploy/', import.meta.url).pathname;

	test('every shell script in deploy/ parses (bash -n)', () => {
		const scripts = readdirSync(deployDir).filter((f) => f.endsWith('.sh'));
		expect(scripts.length).toBeGreaterThanOrEqual(4);
		for (const script of scripts) {
			const proc = Bun.spawnSync(['bash', '-n', `${deployDir}${script}`], {
				stderr: 'pipe',
			});
			expect(`${script}: ${proc.stderr.toString()}`).toBe(`${script}: `);
			expect(proc.exitCode).toBe(0);
		}
	});

	test('rollback + watchdog units execute scripts OUTSIDE the app tree (finding A)', async () => {
		// The units name the layout by ROLE (2026-10-12, engineering/PRODUCTION.md
		// §2.2): INSTANCE_DIR holds the app tree, ROOT_BIN_DIR (root's, outside it)
		// the scripts root-started units run.
		const APP_DIR = 'INSTANCE_DIR/';
		for (const unitName of ['dedalo-ts-rollback.service', 'dedalo-ts-watchdog.service']) {
			const unit = await Bun.file(new URL(`../../deploy/${unitName}`, import.meta.url)).text();
			const exec = unit.match(/^ExecStart=(\S+)/m);
			expect(exec).not.toBeNull();
			// The load-bearing property: the executable survives the tree swap.
			expect(exec?.[1]?.startsWith(APP_DIR)).toBe(false);
			// And the out-of-tree home, so docs/units cannot drift apart.
			expect(exec?.[1]?.startsWith('ROOT_BIN_DIR/')).toBe(true);
		}
	});

	test('both scripts resolve DEDALO_BACKUP_PATH like the engine, not default-only (finding B)', async () => {
		for (const name of ['dedalo-code-rollback.sh', 'dedalo-ts-watchdog.sh']) {
			const script = await Bun.file(new URL(`../../deploy/${name}`, import.meta.url)).text();
			// process-env override…
			expect(script).toContain('DEDALO_BACKUP_PATH');
			// …then the engine's .env location, honoring DEDALO_PRIVATE_DIR…
			expect(script).toContain('DEDALO_PRIVATE_DIR');
			expect(script).toContain('/.env');
			// …and a LOUD degradation when the file is unreadable.
			expect(script).toContain('falling back to the default backup root');
		}
	});

	// --- fixture drills: the four sentinel states, on a real filesystem -----

	const ROLLBACK_SH = new URL('../../deploy/dedalo-code-rollback.sh', import.meta.url).pathname;

	interface Fixture {
		root: string;
		appDir: string;
		backupRoot: string;
		backupDir: string;
		sentinel: string;
		binDir: string;
		systemctlLog: string;
	}

	function makeFixture(): Fixture {
		const root = mkdtempSync(join(tmpdir(), 'dedalo_rollback_drill_'));
		const appDir = join(root, 'master_dedalo');
		const backupRoot = join(root, 'backups', 'code');
		const backupDir = join(backupRoot, 'backup_stamp1');
		const binDir = join(root, 'bin');
		const systemctlLog = join(root, 'systemctl.log');
		mkdirSync(backupRoot, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		// Stub systemctl (records calls) and curl (health always green).
		writeFileSync(
			join(binDir, 'systemctl'),
			`#!/usr/bin/env bash\necho "systemctl $*" >> "${systemctlLog}"\nexit 0\n`,
		);
		writeFileSync(join(binDir, 'curl'), '#!/usr/bin/env bash\nexit 0\n');
		chmodSync(join(binDir, 'systemctl'), 0o755);
		chmodSync(join(binDir, 'curl'), 0o755);
		return {
			root,
			appDir,
			backupRoot,
			backupDir,
			sentinel: join(backupRoot, 'last_code_update.json'),
			binDir,
			systemctlLog,
		};
	}

	function plantTree(dir: string, marker: string): void {
		mkdirSync(join(dir, 'src'), { recursive: true });
		writeFileSync(join(dir, 'src', 'server.ts'), `// ${marker}\n`);
	}

	function writePendingSentinel(f: Fixture, overrides: Record<string, unknown> = {}): void {
		writeFileSync(
			f.sentinel,
			`${JSON.stringify(
				{
					version: '7.1.0',
					previousVersion: '7.0.0',
					updateMode: 'tree_swap',
					stamp: 'stamp1',
					backupDir: f.backupDir,
					status: 'pending',
					rollback_attempted: false,
					...overrides,
				},
				null,
				'\t',
			)}\n`,
		);
	}

	function runRollback(
		f: Fixture,
		extraEnv: Record<string, string> = {},
		extraArgs: string[] = [],
	): { exitCode: number | null; out: string } {
		const proc = Bun.spawnSync(
			[
				'bash',
				ROLLBACK_SH,
				'--app-dir',
				f.appDir,
				...(extraArgs.length > 0 ? extraArgs : ['--backup-root', f.backupRoot]),
			],
			{
				env: {
					PATH: `${f.binDir}:${Bun.env.PATH ?? ''}`,
					...extraEnv,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		return { exitCode: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
	}

	function sentinelJson(f: Fixture): { status: string; rollback_attempted: boolean } {
		return JSON.parse(readFileSync(f.sentinel, 'utf8')) as {
			status: string;
			rollback_attempted: boolean;
		};
	}

	test('drill state 1 (W1): pending + backupDir exists + APP_DIR gone → restore', () => {
		const f = makeFixture();
		try {
			plantTree(f.backupDir, 'old-tree'); // APP_DIR intentionally absent
			writePendingSentinel(f);
			const r = runRollback(f);
			expect(r.out).toContain('state 1');
			expect(r.exitCode).toBe(0);
			// The backup became the live tree.
			expect(existsSync(join(f.appDir, 'src', 'server.ts'))).toBe(true);
			expect(existsSync(f.backupDir)).toBe(false);
			const s = sentinelJson(f);
			expect(s.status).toBe('rolled_back');
			expect(s.rollback_attempted).toBe(true);
			// The service was actually restarted.
			const calls = readFileSync(f.systemctlLog, 'utf8');
			expect(calls).toContain('systemctl start dedalo-ts');
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test('drill state 2: pending + backupDir missing + APP_DIR present → mark, exit 0, touch nothing', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'live-tree'); // backupDir intentionally never created
			writePendingSentinel(f);
			const r = runRollback(f);
			expect(r.out).toContain('state 2');
			expect(r.exitCode).toBe(0);
			// The live tree is untouched.
			expect(readFileSync(join(f.appDir, 'src', 'server.ts'), 'utf8')).toContain('live-tree');
			// Marked so nothing fires on it again…
			const s = sentinelJson(f);
			expect(s.rollback_attempted).toBe(true);
			// …and NO service restart was issued.
			expect(existsSync(f.systemctlLog)).toBe(false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test('drill state 3: pending + both present → park failed tree, restore backup', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'failed-new-tree');
			plantTree(f.backupDir, 'old-tree');
			writePendingSentinel(f);
			const r = runRollback(f);
			expect(r.out).toContain('state 3');
			expect(r.exitCode).toBe(0);
			const read = (p: string): string => readFileSync(p, 'utf8');
			expect(read(join(f.appDir, 'src', 'server.ts'))).toContain('old-tree');
			expect(read(join(f.backupRoot, 'failed_stamp1', 'src', 'server.ts'))).toContain(
				'failed-new-tree',
			);
			const s = sentinelJson(f);
			expect(s.status).toBe('rolled_back');
			expect(s.rollback_attempted).toBe(true);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test('drill state 4: confirmed / already-attempted / absent sentinel → exit 0, no action', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'live-tree');
			plantTree(f.backupDir, 'old-tree');
			for (const overrides of [{ status: 'confirmed' }, { rollback_attempted: true }] as Record<
				string,
				unknown
			>[]) {
				writePendingSentinel(f, overrides);
				const r = runRollback(f);
				expect(r.out).toContain('state 4');
				expect(r.exitCode).toBe(0);
			}
			// Absent sentinel.
			rmSync(f.sentinel);
			const r = runRollback(f);
			expect(r.out).toContain('state 4');
			expect(r.exitCode).toBe(0);
			// Never restarted, never moved anything.
			expect(existsSync(f.systemctlLog)).toBe(false);
			expect(readFileSync(join(f.appDir, 'src', 'server.ts'), 'utf8')).toContain('live-tree');
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test('drill finding B: backup root comes from <private>/.env when env/flag are absent', () => {
		const f = makeFixture();
		try {
			// A relocated backup root, declared ONLY in the private .env.
			const relocatedRoot = join(f.root, 'relocated_backups');
			mkdirSync(relocatedRoot, { recursive: true });
			const privateDir = join(f.root, 'private');
			mkdirSync(privateDir, { recursive: true });
			writeFileSync(
				join(privateDir, '.env'),
				`# comment line\nDEDALO_BACKUP_PATH="${relocatedRoot}"\n`,
			);
			// Sentinel + backup live at the RELOCATED root only.
			const backupDir = join(relocatedRoot, 'backup_stamp1');
			plantTree(f.appDir, 'failed-new-tree');
			plantTree(backupDir, 'old-tree');
			writeFileSync(
				join(relocatedRoot, 'last_code_update.json'),
				`${JSON.stringify({
					version: '7.1.0',
					previousVersion: '7.0.0',
					updateMode: 'tree_swap',
					stamp: 'stamp1',
					backupDir,
					status: 'pending',
					rollback_attempted: false,
				})}\n`,
			);
			// No --backup-root, no DEDALO_BACKUP_PATH in the process env.
			const r = runRollback(f, { DEDALO_PRIVATE_DIR: privateDir }, ['--service', 'dedalo-ts']);
			expect(r.out).toContain('state 3');
			expect(r.exitCode).toBe(0);
			expect(readFileSync(join(f.appDir, 'src', 'server.ts'), 'utf8')).toContain('old-tree');
			expect(existsSync(join(relocatedRoot, 'failed_stamp1'))).toBe(true);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	// --- the WATCHDOG's remedy, driven: which unit it starts -----------------
	// A templated multi-instance host (docs/install/multi_instance.md) runs ONE
	// out-of-tree script for every instance and names each instance's own
	// restart/rollback units. Defaults must stay the single-instance units.

	const WATCHDOG_SH = new URL('../../deploy/dedalo-ts-watchdog.sh', import.meta.url).pathname;

	function runWatchdog(
		f: Fixture,
		healthGreen: boolean,
		extraArgs: string[] = [],
		body = '',
	): { exitCode: number | null; calls: string } {
		// --fail-with-body: a red /health still prints its body (the boot facts)
		writeFileSync(
			join(f.binDir, 'curl'),
			`#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(body)}\nexit ${healthGreen ? 0 : 22}\n`,
		);
		chmodSync(join(f.binDir, 'curl'), 0o755);
		rmSync(f.systemctlLog, { force: true });
		const proc = Bun.spawnSync(
			['bash', WATCHDOG_SH, '--app-dir', f.appDir, '--backup-root', f.backupRoot, ...extraArgs],
			{ env: { PATH: `${f.binDir}:${Bun.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' },
		);
		const calls = existsSync(f.systemctlLog) ? readFileSync(f.systemctlLog, 'utf8') : '';
		return { exitCode: proc.exitCode, calls };
	}

	// --- the BOOT GRACE (finding F3, campaign 2 L7): a red probe of a server still
	// booting is skipped — driven against a stub `systemctl show` and a stub uptime
	// clock, every branch of in_boot_grace, and the no-grace default.

	interface GraceCase {
		name: string;
		state: string;
		/** ActiveEnterTimestampMonotonic, µs since boot. */
		entered: number;
		/** /proc/uptime seconds (null: an unreadable clock). */
		uptime: number | null;
		/** A /run/<dir>/booting marker naming a LIVE pid. */
		marker: boolean;
		flags: boolean;
		restarted: boolean;
	}

	const GRACE_CASES: GraceCase[] = [
		{
			name: 'activating',
			state: 'activating',
			entered: 0,
			uptime: 5000,
			marker: false,
			flags: true,
			restarted: false,
		},
		{
			name: 'active, entered 100 s ago (< 900)',
			state: 'active',
			entered: 4900e6,
			uptime: 5000,
			marker: false,
			flags: true,
			restarted: false,
		},
		{
			name: 'active, entered 4900 s ago',
			state: 'active',
			entered: 100e6,
			uptime: 5000,
			marker: false,
			flags: true,
			restarted: true,
		},
		{
			name: 'booting marker, live pid, 2000 s (< 4 × 900)',
			state: 'active',
			entered: 3000e6,
			uptime: 5000,
			marker: true,
			flags: true,
			restarted: false,
		},
		{
			name: 'booting marker, live pid, 4900 s (> 4 × 900)',
			state: 'active',
			entered: 100e6,
			uptime: 5000,
			marker: true,
			flags: true,
			restarted: true,
		},
		{
			name: 'an unreadable clock never reads as young',
			state: 'active',
			entered: 4900e6,
			uptime: null,
			marker: false,
			flags: true,
			restarted: true,
		},
		{
			name: 'no --service: no grace (the old behaviour)',
			state: 'activating',
			entered: 4900e6,
			uptime: 5000,
			marker: true,
			flags: false,
			restarted: true,
		},
	];

	function runGrace(f: Fixture, item: GraceCase): { exitCode: number | null; calls: string } {
		writeFileSync(join(f.root, 'active_state'), `${item.state}\n`);
		writeFileSync(join(f.root, 'entered'), `${item.entered}\n`);
		writeFileSync(
			join(f.binDir, 'systemctl'),
			[
				'#!/usr/bin/env bash',
				'if [ "$1" = show ]; then',
				`  case "$3" in ActiveState) cat "${f.root}/active_state" ;; ActiveEnterTimestampMonotonic) cat "${f.root}/entered" ;; esac`,
				'  exit 0',
				'fi',
				`echo "systemctl $*" >> "${f.systemctlLog}"`,
				'',
			].join('\n'),
		);
		chmodSync(join(f.binDir, 'systemctl'), 0o755);
		const uptime = join(f.root, 'uptime');
		rmSync(uptime, { force: true });
		if (item.uptime !== null) writeFileSync(uptime, `${item.uptime}.42 1234.56\n`);
		const socketDir = join(f.root, 'run');
		mkdirSync(socketDir, { recursive: true });
		rmSync(join(socketDir, 'booting'), { force: true });
		if (item.marker) writeFileSync(join(socketDir, 'booting'), `${process.pid}\n`);
		const flags = item.flags
			? ['--service', 'dedalo-ts@demo.service', '--grace', '900', '--uptime-file', uptime]
			: [];
		return runWatchdog(f, false, ['--socket', join(socketDir, 'dedalo_ts.sock'), ...flags]);
	}

	test('watchdog boot grace: a booting server is skipped, a dead one restarted — every branch', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'live-tree');
			const seen = GRACE_CASES.map((item) => {
				const run = runGrace(f, item);
				return {
					name: item.name,
					restarted: run.calls.includes('systemctl start dedalo-ts-restart.service'),
					exit: run.exitCode,
				};
			});
			expect(seen).toEqual(
				GRACE_CASES.map((item) => ({
					name: item.name,
					restarted: item.restarted,
					exit: item.restarted ? 1 : 0,
				})),
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	// --- the NOT-INSTALLED refusal (exit 78): the watchdog must not override the units'
	// RestartPreventExitStatus by starting the restart unit every 30 s. Driven against a
	// stub `systemctl show` answering each property in its own call; a crashed unit (a
	// non-78 status) is the control that still gets its restart.

	function runRefusal(
		f: Fixture,
		status: string,
	): { exitCode: number | null; calls: string; err: string } {
		writeFileSync(
			join(f.binDir, 'systemctl'),
			[
				'#!/usr/bin/env bash',
				'if [ "$1" = show ]; then',
				`  case "$3" in ActiveState) echo failed ;; ActiveEnterTimestampMonotonic) echo 0 ;; Result) echo exit-code ;; ExecMainStatus) echo ${status} ;; esac`,
				'  exit 0',
				'fi',
				`echo "systemctl $*" >> "${f.systemctlLog}"`,
				'',
			].join('\n'),
		);
		chmodSync(join(f.binDir, 'systemctl'), 0o755);
		writeFileSync(join(f.binDir, 'curl'), '#!/usr/bin/env bash\nexit 22\n');
		chmodSync(join(f.binDir, 'curl'), 0o755);
		rmSync(f.systemctlLog, { force: true });
		const socketDir = join(f.root, 'run');
		mkdirSync(socketDir, { recursive: true });
		const proc = Bun.spawnSync(
			[
				'bash',
				WATCHDOG_SH,
				'--app-dir',
				f.appDir,
				'--backup-root',
				f.backupRoot,
				'--socket',
				join(socketDir, 'dedalo_ts.sock'),
				'--service',
				'dedalo-ts@demo.service',
			],
			{ env: { PATH: `${f.binDir}:${Bun.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' },
		);
		const calls = existsSync(f.systemctlLog) ? readFileSync(f.systemctlLog, 'utf8') : '';
		return { exitCode: proc.exitCode, calls, err: proc.stderr.toString() };
	}

	test(`watchdog: a unit that failed with exit ${NOT_INSTALLED_EXIT_CODE} is NOT restarted (a crash still is)`, () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'live-tree');
			const refused = runRefusal(f, String(NOT_INSTALLED_EXIT_CODE));
			expect(refused.exitCode).toBe(0);
			expect(refused.calls).toBe('');
			expect(refused.err).toContain(
				`dedalo-ts@demo.service refused to start (exit ${NOT_INSTALLED_EXIT_CODE}: not installed / configuration missing) — not restarting`,
			);
			const crashed = runRefusal(f, '1');
			expect(crashed.exitCode).toBe(1);
			expect(crashed.calls).toBe('systemctl start dedalo-ts-restart.service\n');
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	// --- the per-instance rollback unit's flags: --check decides, --no-restart restarts nothing,
	// a sentinel naming a path outside the backup root (or a link) is refused.

	test('rollback --check / --no-restart / foreign paths: the instance-run half of dedalo-ts-rollback@', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'failed-new-tree');
			plantTree(f.backupDir, 'old-tree');
			// --check: nothing recorded → 1; pending, unattempted → 0; changes nothing.
			expect(runRollback(f, {}, ['--backup-root', f.backupRoot, '--check']).exitCode).toBe(1);
			writePendingSentinel(f);
			expect(runRollback(f, {}, ['--backup-root', f.backupRoot, '--check']).exitCode).toBe(0);
			expect(sentinelJson(f).rollback_attempted).toBe(false);
			// A backupDir outside the backup root: refused, nothing moved.
			const outside = join(f.root, 'elsewhere');
			plantTree(outside, 'foreign');
			writePendingSentinel(f, { backupDir: outside });
			const refused = runRollback(f, {}, ['--backup-root', f.backupRoot, '--no-restart']);
			expect(refused.exitCode).toBe(1);
			expect(refused.out).toContain('outside the backup root');
			expect(readFileSync(join(f.appDir, 'src', 'server.ts'), 'utf8')).toContain('failed-new-tree');
			// A sentinel that is a symbolic link: refused.
			rmSync(f.sentinel);
			writeFileSync(
				join(f.root, 'planted.json'),
				'{"status": "pending", "rollback_attempted": false}\n',
			);
			symlinkSync(join(f.root, 'planted.json'), f.sentinel);
			expect(runRollback(f, {}, ['--backup-root', f.backupRoot, '--no-restart']).out).toContain(
				'is a symbolic link',
			);
			rmSync(f.sentinel);
			// --no-restart: the restore happens, NO systemctl call (the unit restarts as root).
			writePendingSentinel(f);
			const restored = runRollback(f, {}, ['--backup-root', f.backupRoot, '--no-restart']);
			expect(restored.exitCode).toBe(0);
			expect(readFileSync(join(f.appDir, 'src', 'server.ts'), 'utf8')).toContain('old-tree');
			expect(existsSync(f.systemctlLog)).toBe(false);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test('watchdog drill: green → nothing; red → restart unit; red + pending update → rollback unit (default and named units)', () => {
		const f = makeFixture();
		try {
			plantTree(f.appDir, 'live-tree');
			const named = [
				'--restart-unit',
				'dedalo-ts-restart@site1.service',
				'--rollback-unit',
				'dedalo-ts-rollback@site1.service',
			];

			const green = runWatchdog(f, true, named);
			expect(green.exitCode).toBe(0);
			expect(green.calls).toBe('');

			// Red, no sentinel: a restart, of the unit the flags name.
			expect(runWatchdog(f, false).calls).toBe('systemctl start dedalo-ts-restart.service\n');
			const redNamed = runWatchdog(f, false, named);
			expect(redNamed.exitCode).toBe(1);
			expect(redNamed.calls).toBe('systemctl start dedalo-ts-restart@site1.service\n');

			// Red with a pending, unattempted update: the rollback, never a restart.
			writePendingSentinel(f);
			expect(runWatchdog(f, false).calls).toBe('systemctl start dedalo-ts-rollback.service\n');
			expect(runWatchdog(f, false, named).calls).toBe(
				'systemctl start dedalo-ts-rollback@site1.service\n',
			);

			// Already attempted: back to a restart.
			writePendingSentinel(f, { rollback_attempted: true });
			expect(runWatchdog(f, false, named).calls).toBe(
				'systemctl start dedalo-ts-restart@site1.service\n',
			);

			// BOOT FACTS (update audit 2026-10-29, U-01/U-04, D-2): a red /health
			// whose body says the boot migration failed, or the data version is
			// ahead of the code, NEEDS A HUMAN — no restart loop, no rollback.
			const schemaFailed = '{"result":"error","db":"ok","boot_schema":"failed"}';
			const dataAhead =
				'{"result":"error","db":"ok","boot_schema":"ok","data_version":{"state":"ahead","installed":"7.1.0","code":"7.0.0"}}';
			for (const body of [schemaFailed, dataAhead]) {
				const human = runWatchdog(f, false, named, body);
				expect(human.exitCode).toBe(1);
				expect(human.calls, body).toBe('');
			}
			// a data update merely PENDING is not a boot-fact red: a restart as before
			const pendingData =
				'{"result":"error","db":"down","data_version":{"state":"pending","installed":"7.0.0","code":"7.1.0"}}';
			expect(runWatchdog(f, false, named, pendingData).calls).toBe(
				'systemctl start dedalo-ts-restart@site1.service\n',
			);
			// a PENDING update still rolls back first: its failed migration moved nothing
			writePendingSentinel(f);
			expect(runWatchdog(f, false, named, schemaFailed).calls).toBe(
				'systemctl start dedalo-ts-rollback@site1.service\n',
			);
			// needs_restore is never rolled back; with no boot fact on THIS boot (a
			// human repaired the database, then the server hung) a restart is due
			writePendingSentinel(f, { status: 'needs_restore' });
			expect(runWatchdog(f, false, named, schemaFailed).calls).toBe('');
			expect(runWatchdog(f, false, named).calls).toBe(
				'systemctl start dedalo-ts-restart@site1.service\n',
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});
