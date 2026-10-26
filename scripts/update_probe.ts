/**
 * update_probe — THE MUSEUM-CYCLE PROBE AGAINST THE REAL STACKS
 * (`bun run probe:update`, optional `--drive`).
 *
 * Roles: the DOCKER simple stack (http://127.0.0.1/dedalo/, containers
 * dedalo-dedalo-1 + nginx + postgres) plays the MUSEUM INSTALLATION; the local
 * dev server (bun run dev, :4000) plays the MASTER CODE SERVER. This script
 * prepares everything the cycle needs and can then DRIVE the whole update
 * through the wire, exactly like the operator's panel does.
 *
 * What "prepared" means, in order:
 *
 *   1. FACTS — master + consumer health, the consumer's runtime Bun (the
 *      release pin must match IT, not this Mac), zip tooling inside the
 *      container, and THE ONE ORIGIN every hop shares: the manifest's
 *      file.url, the consumer's CODE_SERVERS entry (browser discovery call)
 *      and the consumer-side download must all carry the SAME origin, and it
 *      must be reachable from BOTH the host browser and the container. The
 *      current LAN IP satisfies both (Docker Desktop NATs out to it);
 *      localhost fails inside the container, host.docker.internal fails on
 *      the host. The live .env's DEDALO_HOST may be a STALE older IP — the
 *      probe appends the corrected value (append-only file, last line wins)
 *      and gates on a dev-server restart, because the supervisor
 *      (scripts/dev.ts) respawns ONLY on exit 75 and a config reload needs a
 *      fresh process.
 *   2. RELEASE — a throwaway `git clone --shared` gets the release commit
 *      (version triple [7,0,1], .bun-version pinned to the CONSUMER'S Bun,
 *      agent-alias export-ignore rules), commits it on branch `master`, tags it
 *      `v<version>` (a published release IS a tag — policy 2026-09-29), cuts
 *      the archive with the builder's exact mechanics
 *      (`git archive --format=zip --prefix=dedalo_code/`) into the master's
 *      real DEDALO_CODE_FILES_DIR layout (<repo>/code/7/7.0/) beside its
 *      sha256 sidecar. The manifest (dd_utils_api:get_code_update_info) and
 *      the serving route then advertise it LIVE — no master restart needed
 *      for publication, because the files-dir contents are checked per
 *      request. (The wire twin — widget_request serve_code.build_version_from_git_master
 *      — runs when DEDALO_CODE_SERVER_GIT_DIR points at a local checkout;
 *      scripts/update_drill.ts exercises exactly that path.)
 *   3. MUSEUM TREE — the image-baked stack cannot tree-swap (channel 'image',
 *      refused BY DESIGN: a swap into the writable layer dies with the next
 *      recreation). A museum install that owns its tree is a BIND MOUNT: the
 *      probe materializes a pristine `git archive HEAD` export (the OLD
 *      release, alias symlinks stripped) plus the image's own linux-built
 *      node_modules (docker cp — never host-installed modules in a linux
 *      container) under ../update_probe/opt/, mounts that dir AT
 *      /opt/dedalo via a compose override so the swapped tree AND the backup
 *      root share one filesystem (the rename-swap same-device assert), and
 *      recreates the container with census-safe paths (backups, ontology IO,
 *      transform definitions OUTSIDE the tree) plus the CODE_SERVERS entry
 *      naming the master.
 *   4. VERIFY — container healthy again, deployment channel now `tree_swap`
 *      (asserted INSIDE the container through the engine's own detector),
 *      serving URL answering from the container, manifest offering exactly
 *      7.0.1 with the sidecar digest.
 *
 *   --drive finishes the job over the wire like update_drill does: login,
 *   panel value, maintenance ON, tampered-sha refusal first, then the real
 *   update — SSE phase frames, planned death, container restart onto the new
 *   tree, /health answering 7.0.1, sentinel confirmed ON THE HOST FS. Needs
 *   the museum install's login (--user/--pass; its users were set by ITS
 *   installer and are unknown here).
 *
 * Safety: never touches the master's data or the museum's database beyond the
 * update itself; every mutation is listed above and reversible (remove the
 * override + `docker compose -f docker-compose.simple.yml --env-file .dedalo.env up -d` puts the
 * image-baked stack back; the pre-swap tree stays in ../update_probe/opt).
 */

import {
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { privateDir, projectRoot } from '../src/config/env.ts';
import { PLAIN_HTTP_DEV_LISTENER_ENV } from '../src/config/tcp_listener.ts';
import { parseReleaseVersion } from '../src/core/update/release_identity.ts';

// ---------------------------------------------------------------------------
// Fixed facts of this probe
// ---------------------------------------------------------------------------

/**
 * The cycle is REPEATABLE: the versions are derived from the museum's own
 * /health (present since the first update) — CURRENT = what it reports,
 * RELEASE = the next patch rung. The master's catalog must already carry that
 * rung (src/core/update/catalog.ts; --watch reloads it).
 */
const CONSUMER_CONTAINER = 'dedalo-dedalo-1';
const COMPOSE_BASE = 'docker-compose.simple.yml';
/**
 * The env file install.sh writes the museum's TLS decision into. Compose reads
 * it ONLY when handed `--env-file`, and this probe drives the REAL docker
 * install: without it, recreating the stack resolves the plain-HTTP defaults and
 * a TLS museum loses HTTPS (P1-6 / OPS-02).
 */
const COMPOSE_ENV_FILE = '.dedalo.env';
const COMPOSE_OVERRIDE = 'docker-compose.update-probe.yml';
const NGINX_HEALTH = 'http://127.0.0.1/health';
const MASTER_PORT = '4000';
const PROBE_DIR = join(projectRoot, '..', 'update_probe');
const CODE_FILES_DIR = join(projectRoot, 'code');

interface Envelope {
	ok?: boolean;
	data?: unknown;
	version?: string;
	pid?: number;
	pfile?: string;
	csrf_token?: string;
	error?: { code?: string };
	msg?: string;
	[key: string]: unknown;
}

interface Auth {
	cookie: string;
	csrf: string;
}

/** The DEDALO_VERSION_TRIPLE a tree declares ('7.0.1'), or null. Whitespace- and
 * line-break-insensitive: the committed source spans three lines, the probe's
 * own bump writes one. */
function treeTripleOf(versionTsPath: string): string | null {
	try {
		const matched = /Object\.freeze\(\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]\)/.exec(
			readFileSync(versionTsPath, 'utf8'),
		);
		return matched === null ? null : `${matched[1]}.${matched[2]}.${matched[3]}`;
	} catch {
		return null;
	}
}

function must(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

async function run(
	cmd: string[],
	label: string,
	options: { capture?: boolean } = {},
): Promise<string> {
	const capture = options.capture !== false;
	const child = Bun.spawn(cmd, {
		stdout: capture ? 'pipe' : 'inherit',
		stderr: capture ? 'pipe' : 'inherit',
	});
	if (!capture) {
		const code = await child.exited;
		if (code !== 0) throw new Error(`${label} failed (${code})`);
		return '';
	}
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (code !== 0) {
		const stderr = await new Response(child.stderr).text();
		throw new Error(`${label} failed (${code}): ${stderr.trim().slice(0, 400)}`);
	}
	return out.trim();
}

function sh(script: string, label: string): Promise<string> {
	return run(['/bin/bash', '-c', script], label);
}

async function dockerExec(container: string, cmd: string[], label: string): Promise<string> {
	return run(['docker', 'exec', container, ...cmd], label, { capture: true });
}

// ---------------------------------------------------------------------------
// Env-file access (append-only law: a corrected line APPENDS; the parser's
// last-occurrence rule makes it win on the next process spawn)
// ---------------------------------------------------------------------------

function envFileLastValue(key: string): string | null {
	try {
		const lines = readFileSync(join(privateDir, '.env'), 'utf8').split('\n');
		let found: string | null = null;
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith(`${key}=`)) found = trimmed.slice(key.length + 1).trim();
		}
		return found?.replace(/^"|"$/g, '') ?? null;
	} catch {
		return null;
	}
}

function appendEnvLine(key: string, value: string, why: string): void {
	const path = join(privateDir, '.env');
	const previous = readFileSync(path, 'utf8');
	writeFileSync(
		path,
		`${previous}${previous.endsWith('\n') || previous === '' ? '' : '\n'}${key}=${value}\n`,
	);
	console.log(`[probe] ${path}: appended ${key}=${value} (${why})`);
}

/**
 * Why the museum's .dedalo.env cannot name its image, or null when it can. The
 * message carries the exact lines to append (a LOCAL build, pinned at the version
 * the museum reports: what this probe's museum has always been) and the one
 * command that produces that image.
 */
function museumImageSourceProblem(museumVersion: string): string | null {
	let text = '';
	try {
		text = readFileSync(join(projectRoot, COMPOSE_ENV_FILE), 'utf8');
	} catch {
		// A missing file is the same answer: nothing names the image.
	}
	if (/^DEDALO_IMAGE=\S+/m.test(text) && /^DEDALO_VERSION=\S+/m.test(text)) return null;
	return [
		`${COMPOSE_ENV_FILE} does not name the museum's image (DEDALO_IMAGE / DEDALO_VERSION are missing).`,
		'The compose stacks no longer build from the checkout; they run the pinned image those lines name.',
		`Append to ${join(projectRoot, COMPOSE_ENV_FILE)}:`,
		'  DEDALO_COMPOSE_FILE=docker-compose.simple.yml',
		'  DEDALO_IMAGE=localhost/dedalo',
		`  DEDALO_VERSION=${museumVersion}`,
		'  DEDALO_IMAGE_MODE=build',
		'  DEDALO_IMAGE_VERIFY=none',
		"then build that image once (a clean snapshot of the checkout's last commit — the updater's builder):",
		`  ./deploy/dedalo-image-build.sh "$PWD" localhost/dedalo:${museumVersion}`,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Wire helpers (the museum side speaks the same envelope as everything else)
// ---------------------------------------------------------------------------

async function apiPost(
	origin: string,
	body: Record<string, unknown>,
	auth?: Auth,
): Promise<Envelope> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (auth !== undefined) {
		headers.Cookie = auth.cookie;
		headers['X-Dedalo-Csrf-Token'] = auth.csrf;
	}
	const response = await fetch(`${origin}/api/v1/json`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	return (await response.json()) as Envelope;
}

async function wireLogin(origin: string, username: string, password: string): Promise<Auth> {
	const response = await fetch(`${origin}/api/v1/json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			dd_api: 'dd_utils_api',
			action: 'login',
			prevent_lock: true,
			source: {},
			options: { username, auth: password },
		}),
	});
	const setCookie = response.headers.get('set-cookie') ?? '';
	const json = (await response.json()) as Envelope;
	if (!setCookie.startsWith('dedalo_ts_session=') || typeof json.csrf_token !== 'string') {
		throw new Error(`login failed on ${origin}: http ${response.status}`);
	}
	return { cookie: setCookie.split(';')[0] ?? '', csrf: json.csrf_token };
}

async function healthOf(url: string): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const drive = args.includes('--drive');
	/**
	 * `--dev` rehearses the DEVELOPER CHANNEL: the archive is cut from the
	 * untagged tip of `master` (so it is built and served as `<v>-dev.zip`) and
	 * installed over THE SAME VERSION — no bump, which is how integrated,
	 * unreleased work reaches a museum install. It is also the BOOTSTRAP: a museum whose
	 * tree predates the channel is re-materialized from HEAD on the way through.
	 */
	const devChannel = args.includes('--dev');
	const restartMaster = args.includes('--restart-master');
	const driveUser = args.find((a) => a.startsWith('--user='))?.slice(7) ?? 'root';
	const drivePassArg = args.find((a) => a.startsWith('--pass='))?.slice(7);

	console.log('=== update probe — facts ===');

	// --- the shared origin --------------------------------------------------
	// The interface comes from the DEFAULT ROUTE, not a guessed name. This used
	// to be a hardcoded `en0 || en1`, which is only the common case: on a Mac
	// whose default route is en11 (2026-08-25) BOTH lookups exit non-zero, `sh`
	// threw "detect LAN IP failed (1)", and the probe died before its first
	// fact — while the message below promised an `UPDATE_PROBE_ORIGIN` escape
	// hatch that WAS NEVER IMPLEMENTED and, being after a throwing `sh`, could
	// not have printed anyway. The hatch is real now, and it is honoured first
	// so an operator can always override the detection.
	const originOverride = (process.env.UPDATE_PROBE_ORIGIN ?? '').trim();
	let origin: string;
	// host:port as the .env's DEDALO_HOST wants it — derived from whichever
	// branch produced the origin, so an overridden origin still writes a
	// CONSISTENT advertised host rather than the detected one.
	let originHost: string;
	if (originOverride !== '') {
		// VALIDATED before it can reach a write. The rest of the script hardcodes
		// MASTER_PORT: it finds the master pid by that port (:408), restarts the
		// dev server bound to it (:481) and matches the consumer's CODE_SERVERS
		// entry on `:${MASTER_PORT}` (:669). An override on another port, or with
		// a scheme the engine does not advertise, therefore could never converge —
		// `advertisedOrigin !== origin` on EVERY run, so the probe would append a
		// fresh DEDALO_HOST line to the APPEND-ONLY ../private/.env each time and
		// still fail. Refuse it loudly instead, before anything is written.
		let parsed: URL;
		try {
			parsed = new URL(originOverride);
		} catch {
			throw new Error(`UPDATE_PROBE_ORIGIN is not a URL: ${originOverride}`);
		}
		must(
			parsed.protocol === 'http:' || parsed.protocol === 'https:',
			`UPDATE_PROBE_ORIGIN must be http(s), got ${parsed.protocol}`,
		);
		must(parsed.hostname !== '', 'UPDATE_PROBE_ORIGIN has no host');
		must(
			parsed.pathname === '/' || parsed.pathname === '',
			`UPDATE_PROBE_ORIGIN must be a bare origin (no path), got ${parsed.pathname}`,
		);
		must(
			parsed.port === MASTER_PORT,
			`UPDATE_PROBE_ORIGIN must use port ${MASTER_PORT} — the probe finds, restarts and matches the master on that port`,
		);
		origin = `${parsed.protocol}//${parsed.host}`;
		originHost = parsed.host;
		console.log(`[probe] origin overridden by UPDATE_PROBE_ORIGIN: ${origin}`);
	} else {
		const lanIp = (
			await sh(
				// default-route interface first, then the historical guesses.
				`iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}'); ` +
					`{ [ -n "$iface" ] && ipconfig getifaddr "$iface"; } 2>/dev/null || ` +
					`ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true`,
				'detect LAN IP',
			)
		).trim();
		must(
			lanIp !== '',
			'no LAN IP found (default route, en0, en1) — set UPDATE_PROBE_ORIGIN=http://<ip>:PORT manually',
		);
		origin = `http://${lanIp}:${MASTER_PORT}`;
		originHost = `${lanIp}:${MASTER_PORT}`;
	}
	console.log(`[probe] shared origin: ${origin}`);

	const masterHealth = await healthOf(`${origin}/health`);
	must(masterHealth !== null && masterHealth.db === 'ok', `master unreachable at ${origin}/health`);
	const consumerHealth = await healthOf(NGINX_HEALTH);
	must(
		consumerHealth !== null && consumerHealth.db === 'ok',
		`museum unhealthy at ${NGINX_HEALTH}`,
	);
	console.log(
		`[probe] master: ${String(masterHealth.version)} (${String(masterHealth.entity)}) · museum: ${String(consumerHealth.version ?? '<pre-version-health>')} (${String(consumerHealth.entity)})`,
	);

	// The cycle's versions.
	//
	// RELEASE CHANNEL: derived from the museum itself (repeatable probe) —
	// CURRENT = what it serves now, RELEASE = the next patch rung.
	//
	// DEV CHANNEL: derived from THIS CHECKOUT. A developer build carries the
	// version its own `version.ts` declares and installs over it, so the museum
	// is brought TO that version (re-materialized below when it does not match)
	// rather than the version being derived from the museum.
	//
	// The museum's /health names its RELEASE IDENTITY (`7.0.1`, `7.0.1-dev` on a
	// developer build, `7.0.1-beta.2` on a prerelease): its DATA triple is what
	// the cycle walks from, and the strict triple test below would otherwise
	// refuse to start a second cycle on a dev or prerelease museum.
	const museumIdentity = parseReleaseVersion(String(consumerHealth.version ?? ''));
	const museumVersion =
		museumIdentity === null
			? String(consumerHealth.version ?? '')
			: museumIdentity.triple.join('.');
	must(
		/^\d+\.\d+\.\d+$/.test(museumVersion),
		`the museum's /health carries no parseable version ('${museumVersion}') — it must be on a post-2026-08 build for repeat cycles`,
	);
	const checkoutVersion = treeTripleOf(join(projectRoot, 'src', 'core', 'update', 'version.ts'));
	must(
		!devChannel || checkoutVersion !== null,
		'could not read DEDALO_VERSION_TRIPLE from this checkout — the dev build takes its version from there',
	);
	const CURRENT_VERSION = devChannel ? (checkoutVersion as string) : museumVersion;
	const triple = CURRENT_VERSION.split('.').map(Number);
	const RELEASE_VERSION = devChannel
		? CURRENT_VERSION
		: `${triple[0]}.${triple[1]}.${(triple[2] ?? 0) + 1}`;
	/** The archive's name on each channel (code_build_plan.ts releaseFileName). */
	const RELEASE_FILE = devChannel ? `${RELEASE_VERSION}-dev.zip` : `${RELEASE_VERSION}.zip`;
	console.log(
		devChannel
			? `[probe] DEV cycle: ${CURRENT_VERSION} -> ${RELEASE_VERSION} (same version, ${RELEASE_FILE})`
			: `[probe] cycle: ${CURRENT_VERSION} -> ${RELEASE_VERSION}`,
	);
	if (devChannel && museumVersion !== CURRENT_VERSION) {
		console.log(
			`[probe] the museum serves ${museumVersion} but the dev build is ${CURRENT_VERSION} — its tree will be re-materialized to match (the bootstrap)`,
		);
	}

	// THE RUNG MUST EXIST IN THE CATALOG — asserted here, before ~180 MB of
	// archive is cut and before the museum is touched at all.
	//
	// The probe invents its rung from the museum's own /health (patch + 1), but
	// `buildCodeUpdateInfo` walks UPDATE_CATALOG to decide what a master may
	// advertise, and that catalog is hand-written. Nothing on the prepare path
	// could notice the gap: the serving route is catalog-independent (the zip
	// downloads fine), and the manifest was only ever fetched under --drive. So
	// a museum sitting at the last catalogued rung got a cheerful "PREPARED"
	// and a printed operator procedure for a release the master can never
	// offer — the panel simply shows nothing, with no error to search for.
	// A SAME-VERSION dev build needs NO descriptor: `buildCodeUpdateInfo` offers
	// it from the caller's own version, never from a catalog walk (see the
	// 2026-08-24 wire-contract entry). The assertion below is release-only.
	if (!devChannel) {
		const { UPDATE_CATALOG } = await import('../src/core/update/catalog.ts');
		const rungKey = RELEASE_VERSION.split('.').join('');
		must(
			UPDATE_CATALOG[rungKey] !== undefined,
			`UPDATE_CATALOG has no '${rungKey}' descriptor, so the master can never ADVERTISE ${RELEASE_VERSION} (buildCodeUpdateInfo walks the catalog) — the museum's panel would just show nothing. Add the descriptor to src/core/update/catalog.ts, or reset the museum tree to a version whose next rung IS catalogued.`,
		);
	}

	// --- the museum's image source (installer unification D2) ----------------
	// The stacks no longer build: they RUN ${DEDALO_IMAGE}:${DEDALO_VERSION} from
	// .dedalo.env. A museum installed before that has no such lines, so recreating
	// it below would look for the default localhost/dedalo:local, which does not
	// exist — refuse BEFORE anything is touched, and say exactly what to add.
	const imageSourceProblem = museumImageSourceProblem(museumVersion);
	must(imageSourceProblem === null, imageSourceProblem ?? '');

	// --- the consumer's runtime facts --------------------------------------
	const consumerBun = await dockerExec(
		CONSUMER_CONTAINER,
		['bun', '--version'],
		'container bun version',
	);
	console.log(`[probe] museum runtime Bun: ${consumerBun}`);
	for (const tool of ['zipinfo', 'unzip', 'git']) {
		await dockerExec(CONSUMER_CONTAINER, ['which', tool], `container ${tool}`);
	}
	const containerReach = await dockerExec(
		CONSUMER_CONTAINER,
		['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '4', `${origin}/health`],
		'container -> master',
	);
	must(containerReach === '200', `the container cannot reach ${origin} (got ${containerReach})`);

	// --- step 1: the master must ADVERTISE the shared origin ----------------
	const { readString } = await import('../src/config/readers.ts');
	const protocol = readString('DEDALO_PROTOCOL');
	const currentHost = readString('DEDALO_HOST');
	const advertisedOrigin = `${protocol}${currentHost === '' ? 'localhost' : currentHost}`;
	// The RUNNING server froze config at import: a corrected .env line is inert
	// until it respawns. Stale = the env file changed after the :4000 process
	// started (or the value itself is wrong) — either way the master must be
	// restarted onto the new origin before its manifest can advertise it.
	const listenerPid = (
		await sh(`lsof -t -sTCP:LISTEN -iTCP:${MASTER_PORT} | head -1`, 'find master pid')
	).trim();
	let runningServerIsStale = false;
	if (listenerPid !== '') {
		const startedAt = (await sh(`ps -o lstart= -p ${listenerPid}`, 'server start time')).trim();
		const envMtimeEpoch = Math.floor(
			(await Bun.file(join(privateDir, '.env')).lastModified) / 1000,
		);
		const startedEpoch = Math.floor(new Date(startedAt).getTime() / 1000);
		runningServerIsStale = Number.isFinite(startedEpoch) && envMtimeEpoch >= startedEpoch;
	}
	let needsRestart = advertisedOrigin !== origin || runningServerIsStale;
	if (advertisedOrigin !== origin) {
		const envHostRaw = envFileLastValue('DEDALO_HOST');
		appendEnvLine(
			'DEDALO_HOST',
			originHost,
			`stale value ${envHostRaw ?? '<unset>'}: the manifest would advertise an origin no container can download from`,
		);
	}
	// The code-master paths must parse CLEAN: an inline `# comment` after the
	// value becomes PART OF THE VALUE (quotes are stripped only when the WHOLE
	// value is quoted), so the running engine's files-dir was garbage and every
	// release URL answered 404. Append canonical bare paths.
	//
	// A CONFIGURED value is the operator's, not ours. This used to overwrite
	// DEDALO_CODE_FILES_DIR whenever it merely DIFFERED from <repo>/code, and
	// to append DEDALO_CODE_SERVER_GIT_DIR — a key the probe never reads, since
	// it cuts the archive from its own throwaway clone — shadowing a
	// deliberate `ssh://…` setting in an append-only file that cannot be
	// un-appended. Now: fill in only what is UNSET, and where a set value is
	// genuinely unusable, name it and stop rather than silently shadow it.
	const wantedFilesDir = join(projectRoot, 'code');
	const configuredFilesDir = readString('DEDALO_CODE_FILES_DIR');
	if (configuredFilesDir === undefined || configuredFilesDir === '') {
		appendEnvLine('DEDALO_CODE_FILES_DIR', wantedFilesDir, 'was unset');
		needsRestart = true;
	} else if (!existsSync(configuredFilesDir)) {
		// An inline `# comment` after a value becomes PART OF THE VALUE (quotes
		// are stripped only when the WHOLE value is quoted), which is how this
		// key silently became garbage and every release URL answered 404.
		must(
			false,
			`DEDALO_CODE_FILES_DIR is set to '${configuredFilesDir}', which does not exist. Fix that line in ../private/.env (a bare path, no inline # comment) — the probe will not shadow a value you set.`,
		);
	} else if (configuredFilesDir !== wantedFilesDir) {
		console.log(
			`[probe] note: publishing into the CONFIGURED DEDALO_CODE_FILES_DIR (${configuredFilesDir}), not <repo>/code`,
		);
	}
	if (needsRestart) {
		console.log(
			`[probe] GATE: the dev server freezes config at import — restart it to load DEDALO_HOST / CODE_FILES_DIR / CODE_SERVER_GIT_DIR:
    Ctrl-C the 'bun run dev' session, start it again, then RERUN this command.
    (or rerun with --restart-master to have the probe stop + relaunch it detached)`,
		);
		if (!restartMaster) process.exit(2);
		const devPid = (
			await sh(`pgrep -f 'bun run scripts/dev.ts' | head -1`, 'find dev supervisor')
		).trim();
		must(devPid !== '', 'dev supervisor (scripts/dev.ts) not found — start it by hand, then rerun');
		mkdirSync(PROBE_DIR, { recursive: true });
		// Relaunch detached: the session leaves the user's terminal, its logs go
		// to a file under the probe dir (documented in the output below).
		const devLogPath = join(PROBE_DIR, 'master_dev.log');
		const devLog = openSync(devLogPath, 'a');
		run(['kill', devPid], 'stop dev session', { capture: false }).catch(() => {});
		await Bun.sleep(1500);
		Bun.spawn(['bun', 'run', 'dev'], {
			cwd: projectRoot,
			// The dev session may have gotten its TCP port from the SHELL, not
			// from .env — a detached relaunch must carry it or the master binds
			// unix-socket-only and the whole probe loses its origin.
			// And its ADDRESS: the museum container reaches the master over the
			// LAN IP, which the default loopback bind (SERVER_TCP_HOST) refuses.
			env: {
				...(process.env as Record<string, string>),
				SERVER_TCP_PORT: MASTER_PORT,
				SERVER_TCP_HOST: '0.0.0.0',
				// PLAIN HTTP: the museum container names the master by an http://
				// LAN origin and does not trust this machine's local authority.
				...PLAIN_HTTP_DEV_LISTENER_ENV,
			},
			stdio: ['ignore', devLog, devLog],
			detached: true,
			unref: true,
		} as never);
		console.log(`[probe] stopped dev pid ${devPid}; relaunched detached (log: ${devLogPath})`);
		console.log('[probe] waiting for the relaunched master…');
		const deadline = Date.now() + 60_000;
		for (;;) {
			await Bun.sleep(1000);
			const h = await healthOf(`${origin}/health`);
			if (h !== null && h.db === 'ok') break;
			must(Date.now() < deadline, 'master did not come back on the new origin');
		}
		console.log(`[probe] master back on ${origin}`);
	}

	// --- step 2: cut the release into the master's real files dir ----------
	const cloneDir = join(PROBE_DIR, 'release_clone');
	rmSync(cloneDir, { recursive: true, force: true });
	mkdirSync(PROBE_DIR, { recursive: true });
	await run(['git', 'clone', '--shared', '--quiet', projectRoot, cloneDir], 'clone');
	const versionTsPath = join(cloneDir, 'src', 'core', 'update', 'version.ts');
	const versionTs = readFileSync(versionTsPath, 'utf8');
	// HEAD's own triple is whatever the dev checkout declares (7.0.0 today);
	// the RELEASE triple comes from the cycle, so repeat cycles need no edit here.
	const headTriple = versionTs.match(
		/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,?\s*\]\s*\)\s*as\s*\[number,\s*number,\s*number\]/,
	);
	must(headTriple !== null, 'could not locate DEDALO_VERSION_TRIPLE in the cloned version.ts');
	const bumped = versionTs.replace(
		headTriple[0],
		`[${RELEASE_VERSION.split('.').join(', ')}]) as [number, number, number]`,
	);
	writeFileSync(versionTsPath, bumped);
	writeFileSync(join(cloneDir, '.bun-version'), consumerBun);
	const gaPath = join(cloneDir, '.gitattributes');
	const ga = readFileSync(gaPath, 'utf8');
	const missingRules = ['/.claude export-ignore', '/CLAUDE.md export-ignore'].filter(
		(rule) => !ga.includes(rule),
	);
	if (missingRules.length > 0) {
		writeFileSync(
			gaPath,
			`${ga}\n# update probe: agent-tooling aliases never ship in a release\n${missingRules.join('\n')}\n`,
		);
	}
	await run(['git', '-C', cloneDir, 'add', '-A'], 'stage release commit');
	await run(
		[
			'git',
			'-C',
			cloneDir,
			'-c',
			'user.name=update probe',
			'-c',
			'user.email=probe@localhost',
			'commit',
			'-m',
			`release ${RELEASE_VERSION} (museum probe)`,
		],
		'release commit',
	);
	// Both cycles commit on `master` (the developer channel's ref); only a
	// release TAG claims the published `<v>.zip` name (code_build_plan.ts), so
	// the release cycle tags the commit and archives the TAG, while the dev
	// cycle archives the untagged `master` tip — a real developer build that can
	// never overwrite the published release of the same version.
	await run(['git', '-C', cloneDir, 'branch', '-M', 'master'], 'branch master');
	const releaseRef = devChannel ? 'master' : `refs/tags/v${RELEASE_VERSION}`;
	if (!devChannel) {
		// ANNOTATED, like every real release tag: the archive's %(describe) ignores
		// lightweight tags, and the release would call itself `.dev`.
		await run(
			[
				'git',
				'-C',
				cloneDir,
				'-c',
				'user.name=museum probe',
				'-c',
				'user.email=probe@localhost',
				'tag',
				'-f',
				'-a',
				'-m',
				`v${RELEASE_VERSION}`,
				`v${RELEASE_VERSION}`,
			],
			'release tag',
		);
	}
	const targetDir = join(CODE_FILES_DIR, '7', '7.0');
	mkdirSync(targetDir, { recursive: true });
	const zipPath = join(targetDir, RELEASE_FILE);
	await run(
		[
			'git',
			'-C',
			cloneDir,
			'archive',
			'--format=zip',
			'--prefix=dedalo_code/',
			'-o',
			zipPath,
			releaseRef,
		],
		'cut archive',
	);
	const { createHash } = await import('node:crypto');
	const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
	writeFileSync(`${zipPath}.sha256`, `${digest}  ${RELEASE_FILE}\n`);
	console.log(
		`[probe] release published: ${zipPath} (${readdirSync(targetDir).join(', ')}) — served live by the master`,
	);

	// --- step 3: the museum tree, bind-mounted -----------------------------
	const optDir = join(PROBE_DIR, 'opt');
	const treeDir = join(optDir, 'master_dedalo');
	// REPEAT CYCLES: after a successful update the on-disk tree IS the museum's
	// CURRENT install (the swap put it there) — exactly the OLD release the
	// next cycle replaces. Re-exporting HEAD would time-travel it to 7.0.0.
	// Reuse it verbatim when its version matches what the museum serves;
	// only sweep root junk. A first preparation still exports HEAD + modules.
	const liveVersionTs = join(treeDir, 'src', 'core', 'update', 'version.ts');
	// PARSE the triple; do NOT substring-match it. `includes('[7, 0, 0]')` only
	// ever matched the SINGLE-LINE form this probe's own bump writes — the
	// committed version.ts spreads the triple across three lines, so a tree
	// exported straight from git (a hand reset, or a first preparation) was
	// never recognised as current. The probe then took the re-materialize
	// branch against a tree it should have reused and, with the container still
	// holding the bind mount, wiped it half-way before failing on EACCES.
	const treeIsCurrent =
		existsSync(liveVersionTs) && treeTripleOf(liveVersionTs) === triple.join('.');
	if (treeIsCurrent) {
		for (const junk of ['.claude', 'CLAUDE.md', '.DS_Store']) {
			rmSync(join(treeDir, junk), { recursive: true, force: true });
		}
		console.log(`[probe] museum tree already holds ${CURRENT_VERSION} — reused as the old release`);
	} else {
		// STOP THE CONSUMER FIRST. This branch deletes the very tree the running
		// container has bind-mounted at /opt/dedalo; on Docker Desktop the mount
		// makes the directory itself undeletable, so `rmSync` emptied the tree
		// and THEN threw EACCES on the mount point — turning a re-materialize
		// into a half-wiped museum whose engine only kept answering because the
		// running process already held its modules in memory. Recreating the
		// container is step 5 anyway, so stopping here costs nothing.
		await run(
			['docker', 'compose', '-f', COMPOSE_BASE, '--env-file', COMPOSE_ENV_FILE, 'stop', 'dedalo'],
			'stop the museum before re-materializing its tree',
		);
		const modulesDir = join(treeDir, 'node_modules');
		const savedModules = join(PROBE_DIR, 'node_modules.keep');
		const hadModules = existsSync(modulesDir);
		if (hadModules) {
			rmSync(savedModules, { recursive: true, force: true });
			renameSync(modulesDir, savedModules);
		}
		rmSync(treeDir, { recursive: true, force: true });
		mkdirSync(join(optDir, 'backups', 'code'), { recursive: true });
		mkdirSync(treeDir, { recursive: true });
		await sh(
			`git -C '${projectRoot}' archive --format=tar HEAD | tar -x -C '${treeDir}'`,
			'export HEAD',
		);
		// The alias symlinks ship in HEAD until the .gitattributes commit lands; a
		// deployed install never carries them. Finder's .DS_Store is the same class
		// of root junk the whitelist would refuse the swap over.
		for (const junk of ['.claude', 'CLAUDE.md', '.DS_Store']) {
			rmSync(join(treeDir, junk), { recursive: true, force: true });
		}
		if (hadModules) {
			renameSync(savedModules, modulesDir);
		} else {
			// linux-built modules: host-installed ones carry darwin binaries a linux
			// container cannot load. Source: the still-image-baked container; once
			// THIS tree is mounted (reruns), the image itself via a throwaway.
			const firstSwitch = !existsSync(join(PROBE_DIR, '.switched'));
			if (firstSwitch) {
				await run(
					[
						'docker',
						'cp',
						`${CONSUMER_CONTAINER}:/opt/dedalo/master_dedalo/node_modules`,
						modulesDir,
					],
					'docker cp node_modules',
				);
			} else {
				const tempId = (
					await run(['docker', 'create', 'dedalo-dedalo'], 'create throwaway for modules')
				).trim();
				try {
					await run(
						['docker', 'cp', `${tempId}:/opt/dedalo/master_dedalo/node_modules`, modulesDir],
						'docker cp node_modules (from image)',
					);
				} finally {
					await run(['docker', 'rm', '-f', tempId], 'drop throwaway');
				}
			}
		}
	}
	must(existsSync(join(treeDir, 'package.json')), 'materialized museum tree incomplete');

	// --- step 4: the compose override --------------------------------------
	// Read the SHARED SECRET off the master's own CODE_SERVERS ('Local code
	// server'): the codes there are exactly what the master accepts.
	const configuredServers = readString('CODE_SERVERS');
	const localEntry = (
		JSON.parse(configuredServers || '[]') as { url: string; code: string }[]
	).find((entry) => entry.url.includes(`:${MASTER_PORT}`));
	const sharedCode = localEntry?.code ?? '';
	must(
		/^[A-Za-z0-9_-]{8,}$/.test(sharedCode),
		'no usable shared code found in master CODE_SERVERS',
	);

	const overridePath = join(projectRoot, COMPOSE_OVERRIDE);
	writeFileSync(
		overridePath,
		`# GENERATED by scripts/update_probe.ts — the museum-install probe override.
# Remove it + \`docker compose -f ${COMPOSE_BASE} --env-file ${COMPOSE_ENV_FILE} up -d\` restores the image-baked stack.
services:
  dedalo:
    volumes:
      # The museum OWNS its tree: a bind mount makes the deployment channel
      # tree_swap (an image-baked tree is refused BY DESIGN). Mounting the PARENT
      # keeps the swap target and the code-backup root on ONE filesystem, which
      # the rename-swap same-device assert requires.
      - ${join(PROBE_DIR, 'opt')}:/opt/dedalo
    environment:
      DEDALO_BACKUP_PATH: /opt/dedalo/backups/code
      ONTOLOGY_DATA_IO_DIR: /private/import/ontology
      DEDALO_TRANSFORM_DEFINITIONS_DIR: /private/transform_definition_files
      CODE_SERVERS: '${JSON.stringify([
				{ name: 'Local dev master', url: `${origin}/dedalo/core/api/v1/json/`, code: sharedCode },
			])}'
  # NO nginx override. nginx serves the client from the stack's \`client\` volume,
  # which the ENGINE fills at every start with the client of the tree it booted
  # (src/core/install/client_publish.ts). With the museum tree bind-mounted above,
  # the engine republishes THAT tree's client — and after the swap's restart, the
  # new one — so the browser always drives the client of the server being updated.
  # (The old re-mount of the museum's client into nginx existed only because the
  # base stack bound the MASTER's ./client there; it no longer does.)
`,
	);
	console.log(`[probe] wrote ${overridePath}`);

	// --- step 5: switch the stack over -------------------------------------
	await run(
		[
			'docker',
			'compose',
			'-f',
			COMPOSE_BASE,
			'-f',
			COMPOSE_OVERRIDE,
			'--env-file',
			COMPOSE_ENV_FILE,
			'up',
			'-d',
		],
		'recreate museum with bind-mounted tree',
	);
	// From here on the container serves THIS tree — the image is only a fallback
	// source for node_modules (see step 3).
	writeFileSync(join(PROBE_DIR, '.switched'), `${new Date().toISOString()}\n`);
	console.log('[probe] waiting for the museum to come back healthy…');
	{
		const deadline = Date.now() + 120_000;
		for (;;) {
			const h = await healthOf(NGINX_HEALTH);
			if (h !== null && h.db === 'ok') break;
			must(Date.now() < deadline, 'museum did not come back healthy after the switch');
			await Bun.sleep(1000);
		}
	}
	const channelVerdict = await dockerExec(
		CONSUMER_CONTAINER,
		[
			'bun',
			'-e',
			`const {detectDeploymentChannel}=await import('/opt/dedalo/master_dedalo/src/core/update/channel.ts');const {projectRoot}=await import('/opt/dedalo/master_dedalo/src/config/env.ts');console.log(detectDeploymentChannel(projectRoot));`,
		],
		'channel verdict inside the container',
	);
	must(channelVerdict === 'tree_swap', `channel is '${channelVerdict}' — the updater would refuse`);
	const servingCode = await dockerExec(
		CONSUMER_CONTAINER,
		[
			'curl',
			'-s',
			'-o',
			'/dev/null',
			'-w',
			'%{http_code}',
			'-m',
			'10',
			`${origin}/dedalo/install/code/${RELEASE_VERSION}/${RELEASE_FILE}.sha256`,
		],
		'serving URL from the container',
	);
	must(servingCode === '200', `serving URL answered ${servingCode} from the container`);

	// --- done (or drive) ----------------------------------------------------
	if (!drive) {
		// The dev cycle differs in two places an operator WILL trip over: the
		// build is only offered once the panel's own switch asks for it, and the
		// version cannot be the proof that it landed.
		const devTick = devChannel
			? `
      · tick DEVELOPER BUILDS first — without it the master offers releases only`
			: '';
		const passBar = devChannel
			? `/health answers ${RELEASE_VERSION}.dev and its install_digest
    becomes ${digest.slice(0, 16)}… (the VERSION cannot move on this channel —
    the panel shows the same change as 'Installed archive')`
			: `/health answers ${RELEASE_VERSION}; the panel shows the new
    version + build stamp`;
		console.log(`
=== PREPARED. The operator cycle, in the browser ===
 1. open http://127.0.0.1/dedalo/ and log in as the museum's admin
 2. System Map → area_maintenance → the UPDATE CODE panel:
      · 'Local dev master' must show REACHABLE (green radio)${devTick}
      · select it → the modal lists ${RELEASE_VERSION}${devChannel ? ' (developer build, listed first)' : ''} with its checksum
 3. flip MAINTENANCE MODE on (check_config panel)
 4. confirm the update → watch the phase track
      download → verify → extract → deps → preflight → swap → restart…
    …the page's stream DIES at restart (BY DESIGN): it switches to polling
    /health; the container exits 75 and Docker brings the NEW tree up.
 5. pass bar: ${passBar}; sentinel
      ../update_probe/opt/backups/code/last_code_update.json
    reads status:"confirmed"; one dedalo_<current>_* backup beside it holds the
    OLD tree (package.json + node_modules).
Or let the probe drive it: bun run probe:update${devChannel ? ' --dev' : ''} --drive --user=root --pass=<the museum's admin password>
`);
		return;
	}

	// --- drive mode ----------------------------------------------------------
	must(
		drivePassArg !== undefined && drivePassArg.length >= 8,
		'pass the museum password: --pass=…',
	);
	const auth = await wireLogin('http://127.0.0.1', driveUser, drivePassArg as string);
	const panel = await apiPost(
		'http://127.0.0.1',
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'get_widget_value',
			prevent_lock: true,
			source: { model: 'update_code' },
		},
		auth,
	);
	must(panel.ok === true, `panel value refused: ${JSON.stringify(panel.error ?? panel)}`);
	const servers = (panel.data as { servers: Record<string, unknown>[] }).servers;
	console.log(
		`[probe] panel sees ${servers.length} code server(s), first reachable=${servers[0]?.response_code === 200}`,
	);

	const flipped = await apiPost(
		'http://127.0.0.1',
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: { type: 'widget', model: 'check_config', action: 'set_maintenance_mode' },
			options: { value: true },
		},
		auth,
	);
	must(flipped.ok === true, `maintenance flip refused: ${JSON.stringify(flipped.error)}`);

	console.log('[probe] submitting the TAMPERED-digest attempt…');
	const manifest = await apiPost(origin, {
		dd_api: 'dd_utils_api',
		action: 'get_code_update_info',
		prevent_lock: true,
		source: {},
		options: {
			version: CURRENT_VERSION,
			code: sharedCode,
			// The consumer half of the dev channel's two switches (the panel's
			// "Developer builds" tick). The master answers releases only without it.
			...(devChannel ? { channel: 'dev' } : {}),
		},
	});
	must(manifest.ok === true, `manifest refused: ${JSON.stringify(manifest.error)}`);
	const info = manifest.data as {
		files: { version: string; url: string; sha256?: string; channel?: string }[];
	};
	if (devChannel) {
		// The developer build leads the list; published rungs may follow it.
		const lead = info.files[0];
		must(
			lead?.channel === 'dev' && lead?.version === RELEASE_VERSION,
			`manifest did not lead with the ${RELEASE_VERSION} developer build: ${JSON.stringify(info.files)}`,
		);
		must(
			lead.url.endsWith('-dev.zip'),
			`the advertised developer URL is not the dev archive: ${lead.url}`,
		);
	} else {
		must(
			info.files.length === 1 && info.files[0]?.version === RELEASE_VERSION,
			`manifest did not offer exactly ${RELEASE_VERSION}`,
		);
	}
	// Forwarded VERBATIM into the update request — `channel` travels with it.
	const file = info.files[0] as {
		version: string;
		url: string;
		sha256?: string;
		channel?: string;
	};

	const tampered = await apiPost(
		'http://127.0.0.1',
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: { type: 'widget', model: 'update_code', action: 'update_code' },
			// WAIVED, with a reason: this probes the REAL docker museum stack, whose
			// database this probe must never dump — so there is no backup for the
			// precondition to judge. The unwaived leg is update_drill's (6d, 8).
			options: { file: { ...file, sha256: 'a'.repeat(64) }, waive_backup: true },
		},
		auth,
	);
	must(tampered.ok === true, 'tampered submit should answer ok (background job)');
	const tamperedFrames = await collectJobStream(
		'http://127.0.0.1',
		auth,
		Number(tampered.pid),
		String(tampered.pfile),
		180_000,
	);
	must(
		JSON.stringify(tamperedFrames).includes('checksum mismatch'),
		'the tampered attempt did not die in verify',
	);
	console.log('[probe] tampered attempt refused in verify ✓');

	console.log(`[probe] installing ${RELEASE_VERSION}…`);
	const submitted = await apiPost(
		'http://127.0.0.1',
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: { type: 'widget', model: 'update_code', action: 'update_code' },
			// WAIVED for the same reason as the tampered leg above: the real museum
			// stack's database is not this probe's to dump.
			options: { file, waive_backup: true },
		},
		auth,
	);
	must(submitted.ok === true, `submit refused: ${JSON.stringify(submitted.error)}`);
	const frames = await collectJobStream(
		'http://127.0.0.1',
		auth,
		Number(submitted.pid),
		String(submitted.pfile),
		600_000,
	);
	console.log(
		`[probe] phases: ${
			frames
				.map((f) => f.data?.phase)
				.filter(Boolean)
				.join(' -> ') || '<stream died at restart>'
		}`,
	);

	// WHAT COUNTS AS "IT LANDED".
	// Release channel: the version moves, so the version is the proof.
	// Dev channel: the version CANNOT move (that is the point) — it only gains
	// its `.dev` tag — and a rolled-back tree would answer with the very version
	// we are waiting for. The installed archive digest is the token that moves.
	const expectedHealthVersion = devChannel ? `${RELEASE_VERSION}.dev` : RELEASE_VERSION;
	const deadline = Date.now() + 240_000;
	let updated = false;
	while (Date.now() < deadline) {
		const h = await healthOf(NGINX_HEALTH);
		if (
			h !== null &&
			h.db === 'ok' &&
			h.version === expectedHealthVersion &&
			(!devChannel || h.install_digest === digest)
		) {
			updated = true;
			break;
		}
		await Bun.sleep(1500);
	}
	must(
		updated,
		devChannel
			? `the museum never answered ${expectedHealthVersion} with the installed archive ${digest} on ${NGINX_HEALTH} — a same-version ROLLBACK looks exactly like this`
			: `the museum never answered ${RELEASE_VERSION} on ${NGINX_HEALTH}`,
	);
	const sentinelPath = join(optDir, 'backups', 'code', 'last_code_update.json');
	const sentinelUntil = Date.now() + 45_000;
	let sentinel: Record<string, unknown> = {};
	while (Date.now() < sentinelUntil) {
		try {
			sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
			if (sentinel.status === 'confirmed') break;
		} catch {
			/* not yet */
		}
		await Bun.sleep(800);
	}
	must(sentinel.status === 'confirmed', `sentinel not confirmed: ${JSON.stringify(sentinel)}`);
	must(
		sentinel.version === RELEASE_VERSION && sentinel.previousVersion === CURRENT_VERSION,
		'sentinel names the wrong versions',
	);
	must(
		sentinel.installDigest === digest,
		`sentinel installDigest ${String(sentinel.installDigest)} is not the archive just installed (${digest})`,
	);
	const backups = readdirSync(join(optDir, 'backups', 'code')).filter((n) =>
		n.startsWith(`dedalo_${CURRENT_VERSION}_`),
	);
	must(backups.length >= 1, `no ${CURRENT_VERSION} backup dir found`);
	must(
		readFileSync(join(treeDir, 'src', 'core', 'update', 'version.ts'), 'utf8').includes(
			RELEASE_VERSION.split('.').join(', '),
		),
		`the live tree is not the ${RELEASE_VERSION} code`,
	);
	if (devChannel) {
		// On this channel the version says nothing (both trees declare it), so the
		// tree's own stamp is the assertion that carries weight.
		const stamp = JSON.parse(
			readFileSync(join(treeDir, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
		) as Record<string, unknown>;
		must(stamp.digest === digest, 'the live tree is stamped with another archive');
		must(stamp.channel === 'dev', 'the live tree does not know it is a developer build');
	}
	console.log(
		`[probe] PASS — museum updated ${CURRENT_VERSION} -> ${RELEASE_VERSION}; sentinel confirmed; backup ${backups[0]}`,
	);
}

interface PhaseFrame {
	phase?: string;
	message?: string;
}

interface JobFrame {
	is_running: boolean;
	data: PhaseFrame | null;
	errors: string[];
}

/** Follow the job-status stream until a terminal frame or the connection dies. */
async function collectJobStream(
	origin: string,
	auth: Auth,
	pid: number,
	pfile: string,
	timeoutMs: number,
): Promise<JobFrame[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const frames: JobFrame[] = [];
	try {
		const response = await fetch(`${origin}/api/v1/json`, {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				Cookie: auth.cookie,
				'X-Dedalo-Csrf-Token': auth.csrf,
			},
			body: JSON.stringify({
				dd_api: 'dd_utils_api',
				action: 'get_process_status',
				update_rate: 500,
				prevent_lock: true,
				source: {},
				options: { pid, pfile },
			}),
		});
		if (response.body !== null) {
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					const chunk = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					try {
						frames.push(JSON.parse(chunk.replace(/^data:\n/, '').trim()) as JobFrame);
					} catch {
						/* padding split artifact */
					}
					boundary = buffer.indexOf('\n\n');
				}
				const last = frames.at(-1);
				if (last !== undefined && last.is_running !== true) break;
			}
		}
	} catch {
		/* connection died mid-stream = the planned restart handoff */
	} finally {
		clearTimeout(timer);
	}
	return frames;
}

try {
	await main();
	process.exit(0);
} catch (error) {
	console.error(
		`\n[probe] ${(error instanceof Error ? error.stack : String(error)) ?? 'unknown failure'}`,
	);
	process.exit(1);
}
