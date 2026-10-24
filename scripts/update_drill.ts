/**
 * update_drill — THE CODE-UPDATER'S REAL-SCENARIO GATE (`bun run test:update`).
 *
 * The unit gates (test/unit/code_update.test.ts) drive the pipeline through its
 * seams against synthetic trees; the browser suite drives the widget DOM with
 * fake values; the rollback drill stubs systemctl. What NOTHING exercised is
 * the scenario the operator actually lives: two REAL engine processes talking
 * over real HTTP, a release built and served by one, discovered and installed
 * by the other, the serving process dying mid-job BY DESIGN, a supervisor
 * bringing it back on the new tree, and /health answering on the new version.
 *
 * NOTE the smoke boot binds a unix socket UNDER THE SCRATCH DIR, and macOS caps
 * a socket path at 104 bytes. On a machine whose `TMPDIR` is long (the default
 * per-user `/var/folders/…` is ~49 chars) every run dies at `preflight` with
 * "failed its pre-swap boot check". Run it with a short scratch root —
 * `TMPDIR=/tmp/dd bun run test:update` — rather than hunting a phantom bug.
 *
 * `--dev` rehearses the DEVELOPER CHANNEL instead: the archive is the tip of
 * `master` with no release tag (so it is built and served as `<v>-dev.zip`) and
 * installed OVER THE SAME VERSION, which is how integrated, unreleased work
 * reaches a real installation. It is the only pass that proves the identity story —
 * with the version fixed on both sides of the swap, only the installed archive
 * digest can tell the new tree from a rolled-back one.
 *
 * The release pass (no `--dev`) first runs THE PRERELEASE LEG (gate 17 of the
 * release-identity design, the only end-to-end proof of the prerelease
 * channel): the clone cuts `v<to>-beta.1`, `-beta.2` and `v<to>` on three
 * commits (annotated); the master, opted into the prerelease channel and
 * running THIS checkout (it never runs the betas it publishes), builds each
 * through *Build prerelease* / *Build release* — a rebuild of a published
 * identity, and a prerelease below the stable, refused; a second consumer on
 * the prerelease channel walks `<from>` → beta.1 → beta.2 → `<to>` across
 * three planned-death restarts, /health naming the exact identity and the
 * installed digest at every hop; and a stable-channel asker (with and without
 * a channel token, and one already running beta.1) is offered no beta at any
 * point. Steps 5–9 below then run unchanged against the same master.
 *
 * This drill IS that scenario, end to end, entirely on scratch surfaces:
 *
 *   RELEASE.md steps 1–8 (the master side)
 *     1. a throwaway `git clone --shared` of THIS checkout gets the release
 *        commit a human release manager would make (RELEASE.md steps 1–2):
 *        version triple bumped to the rung's TO end + `.bun-version` pinned to
 *        the RUNNING bun, committed on `master` and tagged `v<version>` (only
 *        a release TAG claims the published `<v>.zip` name);
 *     2. a REAL master instance boots (suite database, scratch state) with
 *        IS_A_CODE_SERVER + DEDALO_CODE_SERVER_GIT_DIR + DEDALO_CODE_FILES_DIR;
 *     3. the release archive is built THROUGH THE WIRE
 *        (widget_request serve_code → build_version_from_git_master), sidecar included;
 *     4. the serving URL is probed anonymously (code_serving.ts).
 *
 *   STAGING_VALIDATION §I1/I2-class assertions (the consumer side)
 *     5. a FULL COPY of this checkout becomes the consumer install, booted
 *        under a supervisor loop (the systemd Restart=always stand-in,
 *        DEDALO_SUPERVISED=true) on its own port/socket/session/state;
 *     6. the maintenance panel's exact wire calls are replayed:
 *        get_widget_value (reachability probe against OUR master) →
 *        get_code_update_info (manifest, code-gated; wrong code refused) →
 *        set_maintenance_mode ON → widget_request update_code;
 *    6d. NEGATIVE, UNWAIVED (OPS-1): the consumer's database-backup dir holds
 *        only a REAL archive cut to 60% — the dump every cheap check calls a
 *        backup. The unwaived update must refuse (`update.refused`, naming
 *        `truncated`) and leave the version, package.json, the code-backup dir
 *        and the sentinel exactly as they were;
 *     7. NEGATIVE: a tampered sha256 must die in the VERIFY phase frame,
 *        leave the live tree byte-identical, no backup dir, no sentinel — this
 *        one is sent WAIVED, so the waiver door is exercised end to end;
 *     8. then the happy path, UNWAIVED over a complete real archive: {pid,pfile} handle → get_process_status SSE
 *        frames download→…→restart(expected_version) → the process DIES
 *        mid-stream (the designed handoff) → the supervisor respawns the NEW
 *        tree → /health answers the RELEASE version with no .dev tag (both
 *        markers moved — RELEASE.md step 11);
 *     9. disk truth: sentinel status "confirmed" (boot_confirm), exactly one
 *        dedalo_<from>_* backup carrying package.json+node_modules+.git (the
 *        rollback-bootability contract), the quarantine's fresh node_modules
 *        live, staging swept, and one more status poll answering the terminal
 *        `interrupted` frame (the dead-owner contract the client's switch to
 *        health polling leans on).
 *
 * WHAT STANDS IN FOR WHAT (honest limits): the systemd units are a bash loop;
 * the release commit is made in the throwaway clone (never in this checkout);
 * the database backup the precondition judges is a REAL custom-format archive of
 * the suite database's dd_ontology table (`pg_dump -F c -t dd_ontology`, a READ,
 * ~0.2 s), not a dump of the whole database — the precondition's question is
 * whether pg_restore can read the newest archive end to end, and a real archive
 * of one table answers it exactly as a whole-database one would. It lives in the
 * consumer's OWN backup dir (DEDALO_BACKUP_DIR, scratch). The earlier claim that
 * a real dump "adds minutes" was measured false. Everything else — build, manifest auth,
 * serving, probe, job stream, refusal battery, swap, restart, boot confirm —
 * is the production code path with no seams.
 *
 * Prerequisites: `bun run test:db:setup` (the drill refuses without the suite
 * database's marker), network for the quarantine's `bun install`, zip/unzip/
 * zipinfo/git on PATH, ~3 GB free in TMPDIR (the consumer copy). Runtime ≈
 * 2–5 min warm. `--keep` leaves the scratch dir for post-mortem.
 *
 * One more honest limit: the consumer copy is configured from the OPERATOR
 * CONFIG (scripts/lib/operator_config.ts — `../private/.env` if present,
 * overlaid by the catalog keys of the process environment; never PATH, HOME or
 * a runner's token), written as its own `.env` (0600, inside the scratch dir,
 * swept in `finally`) — a real install is configured by its own file and this
 * is the only way the required keys resolve. On a hosted runner there is no
 * private file at all and the whole configuration is the environment
 * scripts/ci/hosted_env.sh composes, which is what lets the drill run there
 * (scripts/ci/instance_tier.sh). `--keep` therefore leaves the operator's real
 * secrets on disk in TMPDIR: delete the scratch dir when the post-mortem is done.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDir, projectRoot } from '../src/config/env.ts';
import { libpqTransportArgs, resolvePgTransport } from '../src/config/pg_transport.ts';
import { PLAIN_HTTP_DEV_LISTENER_ENV } from '../src/config/tcp_listener.ts';
import { DEDALO_ENGINE_VERSION, readReleaseIdentityOf } from '../src/core/update/build_stamp.ts';
import { UPDATE_CATALOG, type UpdateDescriptor } from '../src/core/update/catalog.ts';
import { parseReleaseVersion } from '../src/core/update/release_identity.ts';
import { compareVersionArrays, DEDALO_VERSION } from '../src/core/update/version.ts';
import { scratchDir } from '../test/helpers/scratch_dir.ts';
import {
	assertServedDatabase,
	findFreePort,
	localSuiteFingerprint,
	probeServedDatabase,
	resolveSuiteDatabase,
} from './client_test_server.ts';
import { operatorConfig, renderEnvFile } from './lib/operator_config.ts';
import {
	cloneForReleaseCommit,
	overlayWorkingTree,
	tagNextCommit,
	type WorkingTreeOverlay,
} from './lib/release_clone.ts';

// ---------------------------------------------------------------------------
// Fixed drill facts
// ---------------------------------------------------------------------------

/**
 * THE RUNG THE DRILL REHEARSES, DERIVED AT RUNTIME — never a literal.
 *
 * The pair was hardcoded `7.0.0 → 7.0.1`, which made the drill a bomb timed to
 * the exact moment it matters: cutting 7.0.1 (bumping DEDALO_VERSION_TRIPLE)
 * would have reddened the one gate that rehearses cutting a release.
 *
 * So the rung comes from `UPDATE_CATALOG`, which is the engine's own statement
 * of which upgrades exist: the NEWEST descriptor names both ends —
 * `updateFrom*` is the version a consumer upgrades FROM, `version*` the release
 * it lands on. That is also the pair a release manager just authored, so the
 * drill always rehearses the most recent real release rather than a fossil.
 *
 * Neither end is assumed to equal the running engine: the consumer tree is
 * pinned to `from` and the release clone to `to`, so the drill keeps working
 * when the checkout has already moved past both.
 */
function newestCatalogRung(): { from: number[]; to: number[] } {
	const descriptors = Object.values(UPDATE_CATALOG) as UpdateDescriptor[];
	if (descriptors.length === 0) {
		throw new Error(
			'UPDATE_CATALOG is EMPTY, so there is no upgrade rung to rehearse. The drill will not ' +
				'invent one: the master advertises releases by walking this catalog, so a synthetic ' +
				'target would exercise a path no consumer can reach. Add the descriptor for the next ' +
				'release (engineering/RELEASE.md) and re-run.',
		);
	}
	const newest = descriptors.reduce((best, entry) => {
		const a = [entry.versionMajor, entry.versionMedium, entry.versionMinor];
		const b = [best.versionMajor, best.versionMedium, best.versionMinor];
		return compareVersionArrays(a, b) === 1 ? entry : best;
	});
	return {
		from: [newest.updateFromMajor, newest.updateFromMedium, newest.updateFromMinor],
		to: [newest.versionMajor, newest.versionMedium, newest.versionMinor],
	};
}

/**
 * `--dev` rehearses the DEVELOPER CHANNEL instead of a published rung: the
 * archive is built from the tip of `master`, untagged (so `code_build_plan.ts`
 * names it `<v>-dev.zip`), the consumer is NOT moved a rung — it installs the
 * SAME version over itself, which is the whole point of the channel.
 *
 * It is the only drill that can prove the identity story: with the version
 * fixed on both sides of the swap, "did the new tree boot?" can only be
 * answered by the installed archive digest (/health `install_digest`), and the
 * rolled-back tree would answer the version check just as happily.
 */
const DEV_CHANNEL_MODE = process.argv.includes('--dev');
/** Both channels commit on `master` (the developer channel's ref); only the release pass TAGS it. */
const RELEASE_BRANCH = 'master';
/** The channel the build is asked for: the release pass builds its tag, `--dev` the tip of `master`. */
const BUILD_CHANNEL: 'master' | 'dev' = DEV_CHANNEL_MODE ? 'dev' : 'master';

const RUNG = newestCatalogRung();
/** The version the consumer install is pinned to (the upgrade's FROM end). */
const CURRENT_VERSION = RUNG.from.join('.');
/**
 * The version the release clone is bumped to and the master publishes. On the
 * dev channel there IS no bump: a `master` build carries the version of the
 * last release, and installing it over the same version is the feature.
 */
const RELEASE_VERSION = DEV_CHANNEL_MODE ? CURRENT_VERSION : RUNG.to.join('.');
/** The literal `DEDALO_VERSION_TRIPLE` bodies the two trees must carry. */
const CURRENT_TRIPLE_LITERAL = `[${RUNG.from.join(', ')}]`;
const RELEASE_TRIPLE_LITERAL = DEV_CHANNEL_MODE
	? CURRENT_TRIPLE_LITERAL
	: `[${RUNG.to.join(', ')}]`;
/**
 * THE PRERELEASE LEG (RELEASE_IDENTITY_DESIGN §2.8 items 3/7, gate 17) rides
 * the release pass, never `--dev`: the release clone cuts `v<to>-beta.1`, then
 * `-beta.2`, then the stable `v<to>` (each on its own commit, annotated), the
 * master — opted into the prerelease channel and running THIS checkout, so a
 * code server that never ran the betas it publishes — builds each through the
 * panel's *Build prerelease* action, and a consumer on the prerelease channel
 * walks beta.1 → beta.2 → stable across three planned-death restarts, /health
 * answering the exact identity at every hop. A stable-channel asker is shown
 * none of the betas at any point. The stable consumer of steps 5–9 then
 * rehearses the release channel over the same master and the same `<to>.zip`.
 */
const PRERELEASE_LEG = !DEV_CHANNEL_MODE;
/** The prerelease identities the leg cuts, in walk order (the stable `<to>` comes last). */
const PRERELEASE_IDENTITIES = [`${RUNG.to.join('.')}-beta.1`, `${RUNG.to.join('.')}-beta.2`];
/**
 * The tag STEP 1 cuts with the release commit: the first beta on the release
 * pass (the leg tags the rest), none on `--dev` (a branch tip names no release).
 */
const FIRST_TAG = PRERELEASE_LEG ? `v${PRERELEASE_IDENTITIES[0]}` : undefined;
/** The archive's file name on each channel (code_build_plan.ts releaseFileName). */
const RELEASE_FILE_NAME = DEV_CHANNEL_MODE
	? `${RELEASE_VERSION}-dev.zip`
	: `${RELEASE_VERSION}.zip`;
/** Shared secret: the consumer's CODE_SERVERS code and the master's accepted code. */
const DRILL_CODE = 'dedalo_update_drill_shared_code';
const API_PATH = '/api/v1/json';
/**
 * The whole-run ceiling. It must stay ABOVE the sum of the per-step budgets
 * below (boots 120s + 150s, streams 120s + 180s + 420s, post-restart health 150s,
 * plus the git/copy/build work — and on the release pass the prerelease leg's
 * second consumer: a boot 150s + three hops of 420s + 150s + 30s) — otherwise a cold machine trips this generic
 * deadline instead of the step that is actually slow, and the failure names
 * the wrong thing. Warm runtime is 2–5 min; this is a hang-breaker, not a
 * performance budget.
 */
const TOTAL_DEADLINE_MS = 50 * 60 * 1000;

interface Envelope {
	ok?: boolean;
	request_id?: string;
	data?: unknown;
	msg?: string;
	errors?: string[];
	pid?: number;
	pfile?: string;
	csrf_token?: string;
	error?: { code?: string; message?: string; public_message?: string };
	[key: string]: unknown;
}

interface PhaseFrame {
	phase?: string;
	expected_version?: string;
	message?: string;
	phases?: { id: string; status: string }[];
}

interface JobFrame {
	pid: number | null;
	pfile: string;
	is_running: boolean;
	data: PhaseFrame | null;
	errors: string[];
	total_time: number;
	/** The typed failure body of a job that threw (media/jobs.ts frameOf). */
	error?: { code?: string; message?: string };
}

interface Auth {
	cookie: string;
	csrf: string;
}

interface HealthBody {
	result?: string;
	version?: string;
	/** sha256 of the installed archive (install_stamp.ts) — the same-version identity. */
	install_digest?: string | null;
	db?: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Wire helpers — exactly what data_manager.request puts on the wire
// ---------------------------------------------------------------------------

let deadline = 0;

function checkDeadline(label: string): void {
	if (Date.now() > deadline) {
		throw new Error(`drill deadline exceeded at: ${label}`);
	}
}

function must(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`FAIL: ${message}`);
	}
}

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
	const response = await fetch(`${origin}${API_PATH}`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	return (await response.json()) as Envelope;
}

async function wireLogin(origin: string, username: string, password: string): Promise<Auth> {
	const response = await fetch(`${origin}${API_PATH}`, {
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

async function fetchHealth(origin: string): Promise<HealthBody> {
	const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
	return (await response.json()) as HealthBody;
}

/**
 * The release identity the materialized consumer will answer on /health,
 * read from ITS OWN evidence by the engine's own resolver (build_stamp.ts
 * readReleaseIdentityOf): the expanded build_info.txt of the HEAD archive, no
 * install stamp, and the data triple the consumer was pinned to (RUNG.from).
 * Never the bare triple: HEAD exactly at `v7.0.0-beta.6` archives an identity
 * of `7.0.0-beta.6`, an untagged HEAD one of `7.0.0.dev` (a tag naming another
 * triple than the pinned one, too) — only a pre-describe two-field stamp says
 * the bare triple. The data triple is asserted separately: whatever the
 * identity, it must belong to the rung's FROM end.
 */
async function consumerIdentityOf(consumerTree: string): Promise<string> {
	const identity = await readReleaseIdentityOf(consumerTree, {
		triple: RUNG.from as [number, number, number],
	});
	const parsed = parseReleaseVersion(identity.version);
	must(
		parsed !== null && parsed.triple.join('.') === CURRENT_VERSION,
		`consumer identity ${identity.version} does not belong to the rung's FROM end ${CURRENT_VERSION}`,
	);
	return identity.version;
}

async function waitHealthy(
	origin: string,
	options: { expectedVersion: string; fingerprint: string; timeoutMs: number; label: string },
): Promise<void> {
	const until = Date.now() + options.timeoutMs;
	let last = 'no answer yet';
	let iteration = 0;
	let loggedNullFingerprint = false;
	while (Date.now() < until) {
		checkDeadline(options.label);
		iteration += 1;
		try {
			const served = await probeServedDatabase(origin, 2000);
			if (served.status === 200) {
				if (served.fingerprint === null && !loggedNullFingerprint) {
					loggedNullFingerprint = true;
					console.log(
						`[drill][wait:${options.label}] a 200 without a fingerprint: ${JSON.stringify(await fetchHealth(origin))}`,
					);
				}
				assertServedDatabase({ origin, expected: options.fingerprint, served });
				const body = await fetchHealth(origin);
				if (body.version === options.expectedVersion && body.db === 'ok') return;
				last = `version ${String(body.version)} db ${String(body.db)}`;
			} else {
				last = `/health ${served.status}`;
			}
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		if (iteration % 10 === 1) {
			console.log(`[drill][wait:${options.label}] probe ${iteration}: ${last.slice(0, 160)}`);
		}
		await Bun.sleep(500);
	}
	throw new Error(`[${options.label}] ${origin} never became healthy (${last})`);
}

/**
 * Follow the job-status SSE stream until it ends: a terminal frame, server
 * death (the planned restart kills the connection mid-stream), or timeout.
 * Framing per core/api/job_stream.ts: `data:\n{json}` padded with spaces,
 * terminated `\n\n`.
 */
async function followJobStream(
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
		const response = await fetch(`${origin}${API_PATH}`, {
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
				update_rate: 400,
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
				checkDeadline('job stream');
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf('\n\n');
				while (boundary !== -1) {
					const chunk = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const payload = chunk.replace(/^data:\n/, '').trim();
					try {
						frames.push(JSON.parse(payload) as JobFrame);
					} catch {
						// padding-split artifact — the next chunk carries the rest
					}
					boundary = buffer.indexOf('\n\n');
				}
				const last = frames.at(-1);
				if (last !== undefined && last.is_running !== true) break;
			}
		}
	} catch {
		// connection died mid-stream = the planned restart handoff
	} finally {
		clearTimeout(timer);
	}
	return frames;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface ManagedProcess {
	stop: () => Promise<void>;
}

function spawnServer(args: string[], cwd: string, env: Record<string, string>): ManagedProcess {
	const child = Bun.spawn(args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
	console.log(`[drill] spawned pid ${child.pid}: ${args.join(' ')} (cwd ${cwd})`);
	return {
		stop: async () => {
			if (!child.killed) child.kill('SIGTERM');
			await Promise.race([child.exited, Bun.sleep(8000).then(() => undefined)]);
			if (child.exitCode === null) child.kill('SIGKILL');
			await child.exited;
		},
	};
}

/** The systemd Restart=always stand-in: respawn whatever the loop runs, forever. */
function spawnSupervisor(
	command: string,
	cwd: string,
	env: Record<string, string>,
): ManagedProcess {
	const child = Bun.spawn(['/bin/bash', '-c', command], {
		cwd,
		env,
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: true,
	});
	return {
		stop: async () => {
			try {
				process.kill(-child.pid, 'SIGTERM'); // the whole group: bash + current bun
			} catch {
				/* already gone */
			}
			await Promise.race([child.exited, Bun.sleep(6000).then(() => undefined)]);
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				/* already gone */
			}
			await child.exited;
		},
	};
}

// ---------------------------------------------------------------------------
// The instance environment — every runtime surface scoped to the drill
// ---------------------------------------------------------------------------

function instanceEnvironment(options: {
	suiteDb: string;
	port: number;
	socketPath: string;
	sessionDbPath: string;
	stateFilePath: string;
	scratch: string;
	extra: Record<string, string>;
}): Record<string, string> {
	const role = options.extra.DRILL_ROLE ?? 'instance';
	const backupRoot = join(options.scratch, `${role}_code_backups`);
	mkdirSync(backupRoot, { recursive: true });
	mkdirSync(join(options.scratch, 'ontology_io'), { recursive: true });
	mkdirSync(join(options.scratch, 'transform_definitions'), { recursive: true });
	return {
		// THE OPERATOR'S CONFIGURATION FIRST, as the base every surface below
		// overrides. The spawn env REPLACES the parent environment, so without this
		// a server booted here would resolve its config from its tree's private
		// file alone — which on a hosted runner does not exist (the environment IS
		// the configuration there, scripts/ci/hosted_env.sh). Catalog keys only:
		// see scripts/lib/operator_config.ts for what never crosses.
		...operatorConfig(),
		DB_NAME: options.suiteDb,
		DEDALO_DATABASE_CONN: options.suiteDb,
		// Without these the server cannot exec its own toolchain (git for the
		// release build, magick probes).
		PATH: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? tmpdir(),
		SERVER_TCP_PORT: String(options.port),
		// PLAIN HTTP: the drill's origins are `http://127.0.0.1:<port>`, and
		// operatorConfig() above carries the developer's TLS pair (with paths that
		// need not resolve from the scratch tree).
		...PLAIN_HTTP_DEV_LISTENER_ENV,
		SERVER_UNIX_SOCKET: options.socketPath,
		DEDALO_TS_STATE_PATH: options.stateFilePath,
		DEDALO_SESSION_DB_PATH: options.sessionDbPath,
		DEDALO_MEDIA_PROCESSES_DIR: join(options.scratch, `${role}_processes`),
		DEDALO_BACKUP_PATH: backupRoot,
		ONTOLOGY_DATA_IO_DIR: join(options.scratch, 'ontology_io'),
		DEDALO_TRANSFORM_DEFINITIONS_DIR: join(options.scratch, 'transform_definitions'),
		DEDALO_ONTOLOGY_RECOVERY_PATH: join(options.scratch, 'recovery_dump.sql.gz'),
		DEDALO_GEOIP_ENABLED: 'false',
		DIFFUSION_JOBS_TABLE: 'dedalo_ts_test_drill_diffusion_jobs',
		DIFFUSION_ACTIVITY_TABLE: 'dedalo_ts_test_drill_diffusion_activity',
		DEDALO_DEV_MODE: 'true',
		...options.extra,
	};
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/**
 * The one-line source edit a release commit makes (RELEASE.md step 1), applied
 * to whichever tree needs pinning: the clone to the release version, the
 * consumer copy to the version it upgrades FROM.
 *
 * The match is the GENERIC triple shape, not this release's digits — the whole
 * point of deriving the rung is defeated by a regex that only recognises one
 * version. It is anchored on the `as [number, number, number]` assertion, which
 * exists exactly once in version.ts.
 */
function setVersionTriple(text: string, tripleLiteral: string, whose: string): string {
	const replaced = text.replace(
		/\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,?\s*\]\s*\)\s*as\s*\[number,\s*number,\s*number\]/,
		`${tripleLiteral}) as [number, number, number]`,
	);
	if (replaced === text) {
		throw new Error(`could not patch DEDALO_VERSION_TRIPLE in the ${whose}`);
	}
	return replaced;
}

/**
 * The exact body update_code.js::update_code puts on the wire. Since
 * 2026-08-25 that includes `waive_backup` (the version modal's checkbox), so
 * this is the client's body verbatim. UNWAIVED by default: the consumer has a
 * real database backup (see the header), and the precondition is part of what
 * the drill rehearses. Only the tampered-digest leg waives, to keep the waiver
 * door exercised end to end.
 */
function updateRequestBody(
	file: {
		version: string;
		url: string;
		sha256?: string;
		/** Forwarded VERBATIM from the manifest item — the dev channel travels here. */
		channel?: string;
		/** A prerelease item's identity (`7.0.1-beta.2`), forwarded verbatim like the rest. */
		release?: string;
	},
	{ waiveBackup = false }: { waiveBackup?: boolean } = {},
): Record<string, unknown> {
	return {
		dd_api: 'dd_area_maintenance_api',
		action: 'widget_request',
		prevent_lock: true,
		source: { type: 'widget', model: 'update_code', action: 'update_code' },
		options: {
			file,
			info: {
				version: RELEASE_VERSION,
				date: new Date().toISOString(),
				entity_id: 1,
				entity: 'drill',
				host: '',
			},
			waive_backup: waiveBackup,
		},
	};
}

/**
 * A REAL custom-format archive of the suite database's `dd_ontology` (a READ),
 * made with the engine's own pg_dump resolver. The unwaived legs are only worth
 * running when pg_restore can judge what they plant, so a host without the
 * PostgreSQL client tools REFUSES here — never a silent skip.
 */
async function buildDrillArchive(scratch: string, suiteDb: string): Promise<string> {
	// Dynamic: config.ts freezes the connection at import, and main() has
	// repointed DB_NAME at the suite database before this runs.
	const { resolvePgDump, resolvePgRestore } = await import(
		'../src/core/area_maintenance/backup.ts'
	);
	const { config } = await import('../src/config/config.ts');
	if (config.db.database !== suiteDb) {
		throw new Error(
			`the drill's config resolved database '${config.db.database}', not the suite database '${suiteDb}' — refusing to read anything else`,
		);
	}
	if (resolvePgRestore() === null) {
		throw new Error(
			'no pg_restore on this host: the unwaived backup legs (6d, 8) cannot prove anything. Install the PostgreSQL client tools (or set DEDALO_PG_BIN_PATH).',
		);
	}
	const out = join(scratch, 'drill_source.custom.backup');
	const dump = Bun.spawnSync(
		[
			resolvePgDump(),
			// The engine's ONE transport rule (DB_SOCKET wins) — the pool's route.
			...libpqTransportArgs(resolvePgTransport(config.db)),
			'-U',
			config.db.user,
			'-F',
			'c',
			'-b',
			'-t',
			'dd_ontology',
			'-f',
			out,
			config.db.database,
		],
		{
			stdout: 'ignore',
			stderr: 'pipe',
			env: {
				...(process.env as Record<string, string>),
				...(config.db.password !== '' ? { PGPASSWORD: config.db.password } : {}),
			},
		},
	);
	if (dump.exitCode !== 0 || !existsSync(out)) {
		throw new Error(
			`pg_dump of ${config.db.database}.dd_ontology failed: ${new TextDecoder().decode(dump.stderr ?? new Uint8Array()).trim()}`,
		);
	}
	return out;
}

/** Plant `bytes` as a database backup `minutesOld` minutes old. */
function plantDatabaseBackup(path: string, bytes: Uint8Array, minutesOld: number): void {
	writeFileSync(path, bytes, { mode: 0o600 });
	const when = new Date(Date.now() - minutesOld * 60_000);
	utimesSync(path, when, when);
}

/**
 * The consumer's OLD install: a pristine `git archive HEAD` export plus this
 * checkout's node_modules. A deployed install holds exactly the release's
 * files — never a dev checkout's operator dirs (rewrite/, audits/, agent
 * aliases, .DS_Store) — and the pipeline's ROOT WHITELIST correctly refuses
 * any tree carrying them. Exporting HEAD gives the honest previous release:
 * byte-identical to what the new release replaces, its build stamp EXPANDED
 * by export-subst exactly as a release zip's is, with nothing untracked at the
 * root. What that stamp makes the consumer call itself depends on HEAD (an
 * exact release tag, an untagged commit, a pre-describe two-field placeholder)
 * — the caller reads it back with the engine's own resolver
 * (consumerIdentityOf), never assumes it.
 */
function materializeConsumer(fromRoot: string, to: string): Promise<void> {
	return (async () => {
		mkdirSync(to, { recursive: true });
		// bun's stdin sink is a FileSink, not a WritableStream — pipe in the shell.
		const child = Bun.spawn(
			['bash', '-c', `git -C '${fromRoot}' archive --format=tar HEAD | tar -x -C '${to}'`],
			{ stdout: 'ignore', stderr: 'inherit' },
		);
		if ((await child.exited) !== 0) {
			throw new Error(`git archive | tar failed (exit ${await child.exited})`);
		}
		// Belt for the same invariant: `.gitattributes` export-ignore already
		// keeps the agent-alias symlinks out of any archive, but a DEPLOYED
		// install never carries them, so neither does the consumer — even if a
		// future alias lands before its rule does.
		for (const alias of ['.claude', 'CLAUDE.md']) {
			rmSync(join(to, alias), { recursive: true, force: true });
		}
		// The checkout's UNCOMMITTED edits, as the release clone gets them: the
		// consumer is the code under test, never a HEAD that predates it.
		reportOverlay('consumer', overlayWorkingTree(fromRoot, to));
		// PIN the consumer to the rung's FROM end. The export carries HEAD's
		// triple, which stops being the upgrade's starting point the moment the
		// checkout moves past it — after cutting a release, HEAD IS the release,
		// and a consumer already on it would be asked to install itself (which
		// assertLinearUpgrade refuses as a same-version install). Idempotent when
		// HEAD already is the FROM end.
		const consumerVersionTs = join(to, 'src', 'core', 'update', 'version.ts');
		writeFileSync(
			consumerVersionTs,
			setVersionTriple(
				readFileSync(consumerVersionTs, 'utf8'),
				CURRENT_TRIPLE_LITERAL,
				'consumer install',
			),
		);
		Bun.spawnSync(['cp', '-R', join(fromRoot, 'node_modules'), join(to, 'node_modules')], {
			stdout: 'ignore',
			stderr: 'inherit',
		});
		if (!existsSync(join(to, 'package.json'))) {
			throw new Error(`consumer materialization failed: ${to} has no package.json`);
		}
	})();
}

/**
 * Say LOUDLY when a tree is not HEAD: a drill that tested the working tree must
 * not be mistaken for one that tested the commit (and the reverse).
 */
function reportOverlay(whose: string, overlay: WorkingTreeOverlay): void {
	const touched = overlay.copied.length + overlay.removed.length;
	if (touched === 0 && overlay.skipped.length === 0) return;
	console.log(
		`[drill] ${whose}: HEAD + ${overlay.copied.length} uncommitted file(s) of the checkout, ${overlay.removed.length} deleted — the drill tests the WORKING TREE`,
	);
	if (overlay.skipped.length > 0) {
		console.log(
			`[drill] ${whose}: left out (untracked root file or symlink): ${overlay.skipped.join(', ')}`,
		);
	}
}

/** A sealed state file: a finished install, so neither instance's boot is refused (exit 78). */
function sealStateFile(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ install_status: 'sealed' })}\n`);
}

// ---------------------------------------------------------------------------
// Shared legs — the master's build, the manifest ask, a consumer, one hop
// ---------------------------------------------------------------------------

/** A manifest item, exactly as the master advertises it (code_manifest.ts CodeReleaseItem). */
interface ReleaseItem {
	version: string;
	url: string;
	sha256?: string;
	channel?: string;
	release?: string;
}

/**
 * The serve_code panel's build buttons, through the wire. The prerelease
 * button sends the CHANNEL alone, as the panel does (a triple names no single
 * prerelease — the server picks the newest prerelease tag above the newest
 * stable one); the release and developer passes keep the version claim the
 * build checks against the ref's own version.ts.
 */
function buildThroughWire(
	masterOrigin: string,
	masterAuth: Auth,
	channel: 'master' | 'prerelease' | 'dev',
): Promise<Envelope> {
	return apiPost(
		masterOrigin,
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: { type: 'widget', model: 'serve_code', action: 'build_version_from_git_master' },
			options: channel === 'prerelease' ? { channel } : { version: RELEASE_VERSION, channel },
		},
		masterAuth,
	);
}

/**
 * A build that must succeed, checked against the disk exactly where RELEASE.md
 * step 7 looks: the archive `<X>/<X.Y>/<fileName>` and a sidecar naming the
 * same digest the build answered.
 */
async function buildOrFail(
	masterOrigin: string,
	masterAuth: Auth,
	channel: 'master' | 'prerelease' | 'dev',
	codeFilesDir: string,
	fileName: string,
): Promise<string> {
	const built = await buildThroughWire(masterOrigin, masterAuth, channel);
	must(
		built.ok === true,
		`master build (${channel}) refused: ${JSON.stringify(built.error ?? built)}`,
	);
	const builtData = built.data as Record<string, unknown>;
	const builtSha = typeof builtData?.sha256 === 'string' ? builtData.sha256 : '';
	must(/^[a-f0-9]{64}$/.test(builtSha), `built sha256 (${channel}) is not 64 hex chars`);
	const zip = join(codeFilesDir, String(RUNG.to[0]), `${RUNG.to[0]}.${RUNG.to[1]}`, fileName);
	must(existsSync(zip), `release archive missing at ${zip}`);
	const sidecar = (readFileSync(`${zip}.sha256`, 'utf8').trim().split(/\s+/)[0] ?? '').trim();
	must(sidecar === builtSha, `sidecar digest of ${fileName} does not match the build answer`);
	console.log(`[drill] built ${fileName} (${channel}) sha256 ${builtSha.slice(0, 12)}…`);
	return builtSha;
}

/**
 * get_code_update_info exactly as update_code.js sends it: `version` the
 * asker's DATA triple, `release` its identity, `channel` its panel choice
 * (absent = the release channel, as an older client sends it).
 */
async function askManifest(
	masterOrigin: string,
	ask: { version: string; release?: string; channel?: string },
): Promise<{ files: ReleaseItem[]; info: { version: string; channels?: string[] } }> {
	const manifest = await apiPost(masterOrigin, {
		dd_api: 'dd_utils_api',
		action: 'get_code_update_info',
		prevent_lock: true,
		source: {},
		options: { ...ask, code: DRILL_CODE },
	});
	must(
		manifest.ok === true,
		`manifest refused (${JSON.stringify(ask)}): ${JSON.stringify(manifest.error ?? manifest)}`,
	);
	const data = manifest.data as {
		files: ReleaseItem[];
		info: { version: string; channels?: string[] };
	};
	must(Array.isArray(data?.files), `manifest (${JSON.stringify(ask)}) carries no files list`);
	return data;
}

/** What a manifest answer offers, as identities — the readable form every leg assertion prints. */
function offeredIdentities(files: readonly ReleaseItem[]): string[] {
	return files.map((item) => item.release ?? item.version);
}

/** Everything one supervised consumer install is, once it answers /health. */
interface Consumer {
	role: string;
	tree: string;
	origin: string;
	auth: Auth;
	/** Its CODE backups (DEDALO_BACKUP_PATH): the swap's backup dirs + the sentinel. */
	backupRoot: string;
	/** Its DATABASE backups (DEDALO_BACKUP_DIR): what the update precondition judges. */
	dbBackupDir: string;
	supervisor: ManagedProcess;
}

/**
 * A CONSUMER install (STEP 5): a pristine HEAD export pinned to the rung's FROM
 * end, configured by its own rendered `.env`, booted under the supervisor loop
 * on its own port/socket/session/state/backup dirs (named after `role`, so two
 * consumers of one run never share a surface), and logged in. Returns once
 * /health answers the identity the tree's own stamp resolves to.
 */
async function bootConsumer(options: {
	role: string;
	scratch: string;
	suiteDb: string;
	fingerprint: string;
	testMediaRoot: string;
	masterOrigin: string;
	portFloor: number;
	/** The suite login credential (src/core/test_data/suite_login.ts). */
	password: string;
	onSupervisor: (supervisor: ManagedProcess) => void;
}): Promise<Consumer & { identity: string }> {
	const { role, scratch } = options;
	const tree = join(scratch, role);
	console.log(`[drill] copying the checkout as the ${role} install…`);
	await materializeConsumer(projectRoot, tree);
	const identity = await consumerIdentityOf(tree);
	console.log(`[drill] the ${role} calls itself ${identity} (data ${CURRENT_VERSION})`);
	// A real install is configured by its own <private>/.env; give the copy
	// one — the OPERATOR CONFIG rendered as a file (0600): the private file if
	// there is one, overlaid by the catalog keys of this process's environment,
	// so the required keys resolve on a developer machine AND on a hosted
	// runner that has no file, while EVERY runtime surface below stays pinned
	// to the scratch dirs — process env outranks the file, exactly as in
	// production. Never a byte copy of the live file, and never the runner's
	// PATH or token: scripts/lib/operator_config.ts.
	const consumerPrivateDir = join(scratch, `${role}_private`);
	mkdirSync(consumerPrivateDir, { recursive: true });
	const consumerEnvFile = join(consumerPrivateDir, '.env');
	writeFileSync(consumerEnvFile, renderEnvFile(operatorConfig()), { mode: 0o600 });
	const backupRoot = join(scratch, `${role}_code_backups`);
	// The consumer's DATABASE backups (what the update precondition judges) —
	// its own scratch dir, never the operator's backups.
	const dbBackupDir = join(scratch, `${role}_db_backups`);
	mkdirSync(dbBackupDir, { recursive: true });
	const port = await findFreePort(options.portFloor);
	const origin = `http://127.0.0.1:${port}`;
	const env = instanceEnvironment({
		suiteDb: options.suiteDb,
		port,
		socketPath: join(scratch, `${role}.sock`),
		sessionDbPath: join(scratch, `${role}_sessions.sqlite`),
		stateFilePath: join(scratch, `${role}_state.json`),
		scratch,
		extra: {
			DRILL_ROLE: role,
			DEDALO_TEST_MEDIA_ROOT: options.testMediaRoot,
			DEDALO_BACKUP_DIR: dbBackupDir,
			CODE_SERVERS: JSON.stringify([
				{ name: 'drill master', url: `${options.masterOrigin}${API_PATH}`, code: DRILL_CODE },
			]),
			// A pure CONSUMER: this role must not depend on the live .env's
			// IS_A_CODE_SERVER (the panel asserts the negative) nor inherit its
			// code-master paths — census-registered keys an operator points at
			// THEIR master would land inside this tree and refuse the swap.
			IS_A_CODE_SERVER: 'false',
			DEDALO_CODE_FILES_DIR: '',
			DEDALO_CODE_SERVER_GIT_DIR: '',
			DEDALO_SOURCE_VERSION_LOCAL_DIR: '',
			DEDALO_SUPERVISED: 'true',
		},
	});
	env.BUN = process.execPath;
	// The loop must RE-RESOLVE the app path every iteration: after the swap
	// renames, the shell's inherited cwd follows the OLD tree's inode into
	// the backup dir (systemd re-resolves WorkingDirectory per spawn — this
	// is the same contract).
	env.APP_DIR = tree;
	const supervisedLoop =
		'while :; do cd "$APP_DIR" || exit 9; "$BUN" run src/server.ts; code=$?; echo "[supervisor] exit $code — respawning"; sleep 0.3; done';
	console.log(`[drill] starting the ${role} on ${origin} under a supervisor…`);
	sealStateFile(join(scratch, `${role}_state.json`));
	const supervisor = spawnSupervisor(supervisedLoop, tree, env);
	options.onSupervisor(supervisor);
	await waitHealthy(origin, {
		// The RELEASE IDENTITY its expanded stamp resolves to (consumerIdentityOf)
		// — /health names the identity, never the bare data triple.
		expectedVersion: identity,
		fingerprint: options.fingerprint,
		timeoutMs: 150_000,
		label: `${role} boot`,
	});
	const auth = await wireLogin(origin, 'root', options.password);
	return { role, tree, origin, auth, backupRoot, dbBackupDir, supervisor, identity };
}

/** Maintenance mode ON through the operator's own action (STEP 6c) — idempotent. */
async function maintenanceOn(consumer: Consumer): Promise<void> {
	const flipped = await apiPost(
		consumer.origin,
		{
			dd_api: 'dd_area_maintenance_api',
			action: 'widget_request',
			prevent_lock: true,
			source: { type: 'widget', model: 'check_config', action: 'set_maintenance_mode' },
			options: { value: true },
		},
		consumer.auth,
	);
	must(flipped.ok === true, `set_maintenance_mode refused: ${JSON.stringify(flipped.error)}`);
}

/**
 * ONE HOP of the prerelease walk: the item installed UNWAIVED over a complete
 * restore point, the stream dying at the planned restart, and the proof the
 * NEW tree is live — read three independent ways, because a same-triple hop
 * (beta.1 → beta.2 → stable) leaves the data version unchanged and so the
 * version alone can never tell the new tree from a rolled-back one:
 *  - /health answers the EXACT identity (`7.0.1-beta.2`, never the triple) AND
 *    the digest of the archive just installed;
 *  - the sentinel is confirmed by boot_confirm for that digest;
 *  - the tree's install stamp names that digest and the channel the item was
 *    offered on.
 */
async function installHop(
	consumer: Consumer,
	item: ReleaseItem,
	expectedIdentity: string,
	hopsBefore: number,
): Promise<void> {
	const sha = item.sha256 ?? '';
	await maintenanceOn(consumer);
	console.log(
		`[drill][${consumer.role}] installing ${expectedIdentity} (the stream will DIE at restart — by design)…`,
	);
	const submitted = await apiPost(consumer.origin, updateRequestBody(item), consumer.auth);
	must(
		submitted.ok === true,
		`[${consumer.role}] update to ${expectedIdentity} refused: ${JSON.stringify(submitted.error)}`,
	);
	const pid = typeof submitted.pid === 'number' ? submitted.pid : 0;
	const pfile = typeof submitted.pfile === 'string' ? submitted.pfile : '';
	must(pid !== 0 && pfile !== '', `[${consumer.role}] no pid/pfile handle returned`);
	const frames = await followJobStream(consumer.origin, consumer.auth, pid, pfile, 420_000);
	const phases = frames
		.map((frame) => frame.data?.phase)
		.filter((p): p is string => typeof p === 'string');
	console.log(
		`[drill][${consumer.role}] phases streamed: ${phases.join(' -> ') || '<connection died before frames>'}`,
	);
	const failed = frames.find((frame) => frame.is_running === false && frame.error !== undefined);
	must(
		failed === undefined,
		`[${consumer.role}] the ${expectedIdentity} job failed: ${JSON.stringify(failed)}`,
	);
	const restartFrame = frames.find((frame) => frame.data?.phase === 'restart');
	if (restartFrame !== undefined) {
		// The IDENTITY, not the triple: on a same-triple hop the triple would
		// let the client accept the rolled-back tree as "restarted".
		must(
			restartFrame.data?.expected_version === expectedIdentity,
			`[${consumer.role}] restart frame expects ${String(restartFrame.data?.expected_version)}, not ${expectedIdentity}`,
		);
	}
	const until = Date.now() + 150_000;
	let health: HealthBody = {};
	while (Date.now() < until) {
		checkDeadline(`${consumer.role} health after ${expectedIdentity}`);
		try {
			health = await fetchHealth(consumer.origin);
			if (
				health.db === 'ok' &&
				health.version === expectedIdentity &&
				health.install_digest === sha
			) {
				break;
			}
		} catch {
			/* down — keep polling */
		}
		await Bun.sleep(700);
	}
	must(
		health.version === expectedIdentity && health.install_digest === sha,
		`[${consumer.role}] never came back on ${expectedIdentity} / ${sha}: ${JSON.stringify(health)}`,
	);
	console.log(
		`[drill][${consumer.role}] /health answers ${expectedIdentity} — the new tree is LIVE`,
	);

	const sentinelPath = join(consumer.backupRoot, 'last_code_update.json');
	const sentinelUntil = Date.now() + 30_000;
	let sentinel: Record<string, unknown> = {};
	while (Date.now() < sentinelUntil) {
		try {
			sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
			if (sentinel.status === 'confirmed' && sentinel.installDigest === sha) break;
		} catch {
			/* not written yet */
		}
		await Bun.sleep(500);
	}
	must(
		sentinel.status === 'confirmed' && sentinel.installDigest === sha,
		`[${consumer.role}] sentinel not confirmed for ${expectedIdentity}: ${JSON.stringify(sentinel)}`,
	);
	const stamp = JSON.parse(
		readFileSync(join(consumer.tree, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
	) as Record<string, unknown>;
	must(stamp.digest === sha, `[${consumer.role}] the live tree is stamped with another archive`);
	const offeredOn = item.channel ?? 'master';
	must(
		stamp.channel === offeredOn,
		`[${consumer.role}] the live tree records channel ${String(stamp.channel)}, the item was offered on ${offeredOn}`,
	);
	// One backup per hop: every swap kept the tree it replaced (rollback).
	const backups = readdirSync(consumer.backupRoot).filter((n) => n.startsWith('dedalo_'));
	must(
		backups.length === hopsBefore + 1,
		`[${consumer.role}] expected ${hopsBefore + 1} code backup dir(s) after ${expectedIdentity}, got ${backups.join(', ')}`,
	);
}

/**
 * THE PRERELEASE LEG (gate 17 — see PRERELEASE_LEG). Runs between the master's
 * boot and the stable consumer; leaves the master holding beta.1, beta.2 and
 * the stable `<to>.zip`, and answers the stable archive's digest, which steps
 * 5–9 then install on the release channel.
 */
async function prereleaseLeg(ctx: {
	masterOrigin: string;
	masterAuth: Auth;
	cloneDir: string;
	codeFilesDir: string;
	manifestBase: string;
	drillArchive: string;
	bootConsumer: () => Promise<Consumer & { identity: string }>;
}): Promise<string> {
	const { masterOrigin, masterAuth, cloneDir, codeFilesDir } = ctx;
	const [beta1, beta2] = PRERELEASE_IDENTITIES as [string, string];
	const releaseDir = join(codeFilesDir, String(RUNG.to[0]), `${RUNG.to[0]}.${RUNG.to[1]}`);
	// What a STABLE consumer at the FROM end asks — on the release channel, and
	// with no channel at all (an older client's body). It must be shown NO beta,
	// at every point of the sequence, also while a beta is the newest thing the
	// master holds.
	const stableAsks = [
		{ version: CURRENT_VERSION, release: CURRENT_VERSION, channel: 'master' },
		{ version: CURRENT_VERSION },
	];
	const assertStableAskersSee = async (expected: string[], when: string): Promise<void> => {
		for (const ask of stableAsks) {
			const { files } = await askManifest(masterOrigin, ask);
			must(
				JSON.stringify(offeredIdentities(files)) === JSON.stringify(expected),
				`${when}: a stable asker ${JSON.stringify(ask)} was offered ${JSON.stringify(offeredIdentities(files))}, expected ${JSON.stringify(expected)}`,
			);
			must(
				files.every((item) => item.channel === undefined && item.release === undefined),
				`${when}: a stable asker was offered a channel-marked item: ${JSON.stringify(files)}`,
			);
		}
	};

	// --- beta.1: Build prerelease on a master that never ran it --------------
	const beta1Sha = await buildOrFail(
		masterOrigin,
		masterAuth,
		'prerelease',
		codeFilesDir,
		`${beta1}.zip`,
	);
	// IMMUTABLE (§2.8 item 1): the same identity is never rebuilt, and the
	// published bytes do not move.
	const beta1Bytes = readFileSync(join(releaseDir, `${beta1}.zip`));
	const rebuilt = await buildThroughWire(masterOrigin, masterAuth, 'prerelease');
	// The REASON, not only the code: about ten refusals share `update.refused`
	// (code_build.ts), so the code alone would pass on any of them.
	must(
		rebuilt.ok !== true &&
			rebuilt.error?.code === 'update.refused' &&
			(rebuilt.error.message ?? '').includes(`Release ${beta1} is already published`),
		`a second Build prerelease of ${beta1} was not refused as IMMUTABLE: ${JSON.stringify(rebuilt.error ?? rebuilt)}`,
	);
	must(
		readFileSync(join(releaseDir, `${beta1}.zip`)).equals(beta1Bytes),
		`the refused rebuild changed the published ${beta1}.zip`,
	);
	await assertStableAskersSee([], `after ${beta1}`);

	// The PRERELEASE consumer, at the FROM end.
	const consumer = await ctx.bootConsumer();
	plantDatabaseBackup(
		join(consumer.dbBackupDir, 'drill_complete.custom.backup'),
		readFileSync(ctx.drillArchive),
		5,
	);
	const firstAsk = await askManifest(masterOrigin, {
		version: CURRENT_VERSION,
		release: consumer.identity,
		channel: 'prerelease',
	});
	must(
		JSON.stringify(firstAsk.info.channels) === JSON.stringify(['master', 'prerelease']),
		`the opted-in master does not report the prerelease channel honoured: ${JSON.stringify(firstAsk.info)}`,
	);
	must(
		JSON.stringify(offeredIdentities(firstAsk.files)) === JSON.stringify([beta1]),
		`the prerelease asker at ${consumer.identity} was offered ${JSON.stringify(offeredIdentities(firstAsk.files))}, expected [${beta1}]`,
	);
	const beta1Item = firstAsk.files[0] as ReleaseItem;
	must(
		beta1Item.channel === 'prerelease' &&
			beta1Item.version === RELEASE_VERSION &&
			beta1Item.sha256 === beta1Sha,
		`the ${beta1} item is malformed: ${JSON.stringify(beta1Item)}`,
	);
	must(
		new URL(beta1Item.url).origin === new URL(ctx.manifestBase).origin &&
			beta1Item.url.endsWith(`/${beta1}.zip`),
		`the ${beta1} item URL is not the master's prerelease archive: ${beta1Item.url}`,
	);
	const servedBeta = await fetch(beta1Item.url);
	must(servedBeta.ok, `the ${beta1} serving URL answered ${servedBeta.status}`);
	await servedBeta.body?.cancel();
	await installHop(consumer, beta1Item, beta1, 0);

	// --- beta.2: the same-triple hop ----------------------------------------
	await tagNextCommit(cloneDir, `v${beta2}`);
	const beta2Sha = await buildOrFail(
		masterOrigin,
		masterAuth,
		'prerelease',
		codeFilesDir,
		`${beta2}.zip`,
	);
	await assertStableAskersSee([], `after ${beta2}`);
	// A stable-channel asker that ALREADY runs beta.1 is not walked to beta.2
	// either: the channel, not the running identity, is the opt-in.
	const stableAtBeta1 = await askManifest(masterOrigin, {
		version: RELEASE_VERSION,
		release: beta1,
		channel: 'master',
	});
	must(
		stableAtBeta1.files.length === 0,
		`a release-channel asker at ${beta1} was offered ${JSON.stringify(offeredIdentities(stableAtBeta1.files))}`,
	);
	const secondAsk = await askManifest(masterOrigin, {
		version: RELEASE_VERSION,
		release: beta1,
		channel: 'prerelease',
	});
	must(
		JSON.stringify(offeredIdentities(secondAsk.files)) === JSON.stringify([beta2]),
		`the prerelease asker at ${beta1} was offered ${JSON.stringify(offeredIdentities(secondAsk.files))}, expected [${beta2}]`,
	);
	const beta2Item = secondAsk.files[0] as ReleaseItem;
	must(beta2Item.sha256 === beta2Sha, `the ${beta2} item digest is not the build's`);
	await installHop(consumer, beta2Item, beta2, 1);

	// --- the stable release: beta.2 → <to> ----------------------------------
	await tagNextCommit(cloneDir, `v${RELEASE_VERSION}`);
	const stableSha = await buildOrFail(
		masterOrigin,
		masterAuth,
		'master',
		codeFilesDir,
		RELEASE_FILE_NAME,
	);
	// A beta the stable release superseded is never built again.
	const superseded = await buildThroughWire(masterOrigin, masterAuth, 'prerelease');
	// The REASON: a broken superseded filter would pick the published beta.2 and
	// be refused as immutable instead — same code, wrong guarantee.
	must(
		superseded.ok !== true &&
			superseded.error?.code === 'update.refused' &&
			(superseded.error.message ?? '').includes('No prerelease to build'),
		`Build prerelease after ${RELEASE_VERSION} was not refused as SUPERSEDED: ${JSON.stringify(superseded.error ?? superseded)}`,
	);
	await assertStableAskersSee([RELEASE_VERSION], `after ${RELEASE_VERSION}`);
	const thirdAsk = await askManifest(masterOrigin, {
		version: RELEASE_VERSION,
		release: beta2,
		channel: 'prerelease',
	});
	must(
		JSON.stringify(offeredIdentities(thirdAsk.files)) === JSON.stringify([RELEASE_VERSION]),
		`the prerelease asker at ${beta2} was offered ${JSON.stringify(offeredIdentities(thirdAsk.files))}, expected [${RELEASE_VERSION}]`,
	);
	const stableItem = thirdAsk.files[0] as ReleaseItem;
	must(
		stableItem.sha256 === stableSha && stableItem.channel === undefined,
		`the ${RELEASE_VERSION} item is not the published release: ${JSON.stringify(stableItem)}`,
	);
	await installHop(consumer, stableItem, RELEASE_VERSION, 2);
	// At the stable release there is nothing above it on any channel.
	const afterStable = await askManifest(masterOrigin, {
		version: RELEASE_VERSION,
		release: RELEASE_VERSION,
		channel: 'prerelease',
	});
	must(
		afterStable.files.length === 0,
		`the consumer at ${RELEASE_VERSION} is still offered ${JSON.stringify(offeredIdentities(afterStable.files))}`,
	);

	// Free the second consumer (its tree is a full copy) before the stable one boots.
	await consumer.supervisor.stop();
	rmSync(consumer.tree, { recursive: true, force: true });
	console.log(
		`[drill] PRERELEASE LEG PASS — ${CURRENT_VERSION} -> ${beta1} -> ${beta2} -> ${RELEASE_VERSION} across three planned-death restarts; stable askers offered no beta.`,
	);
	return stableSha;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	deadline = Date.now() + TOTAL_DEADLINE_MS;
	const keepScratch = process.argv.includes('--keep');
	const { suiteDb } = resolveSuiteDatabase();

	// Point THIS process at the suite database before any engine import freezes
	// a connection (same seam as the client runner); the marker assertion is
	// the drill's proof that it may touch this database at all.
	process.env.DB_NAME = suiteDb;
	process.env.DEDALO_DATABASE_CONN = suiteDb;
	const fingerprint = await localSuiteFingerprint();
	// The ONE media tree both instances serve from — created and marked, so the
	// engine's media-root refusal is armed and the LIVE media root is never
	// resolved (the census's media entry would otherwise fall through to the
	// master's <live private>/media default).
	const { ensureTestMediaRoot, markProcessesDir } = await import(
		'../test/helpers/test_media_root.ts'
	);
	const testMediaRoot = ensureTestMediaRoot(suiteDb);
	const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
		'../src/core/test_data/suite_login.ts'
	);
	await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);

	const scratch = scratchDir('update_drill');
	mkdirSync(scratch, { recursive: true });
	// Each instance's job registry (instanceEnvironment: `<role>_processes`),
	// DECLARED: the instances run armed (DEDALO_TEST_MEDIA_ROOT), and an armed job
	// manager refuses an unmarked processes dir (src/core/media/jobs.ts).
	for (const role of ['master', 'consumer', 'prerelease_consumer', 'instance']) {
		markProcessesDir(join(scratch, `${role}_processes`));
	}

	let master: ManagedProcess | null = null;
	// Every consumer's supervisor loop (the prerelease leg's and the stable one),
	// stopped in `finally` whatever step failed.
	const supervisors: ManagedProcess[] = [];

	try {
		// ---------------------------------------------------------------
		// STEP 1 — the release commit, in a throwaway shared clone
		// ---------------------------------------------------------------
		const cloneDir = join(scratch, 'release_clone');
		console.log('[drill] cloning the checkout for the release commit…');
		// scripts/lib/release_clone.ts: clone → `checkout -B` → edit → commit. The
		// branch is taken with `checkout -B`, never `branch -m`: a PR checkout is a
		// DETACHED HEAD (refs/remotes/pull/N/merge) and `branch -m` refuses it. Only a
		// release TAG claims the published <v>.zip name (code_build_plan.ts); `--dev`
		// deliberately tags nothing and builds the `master` tip, so the build lands
		// as `<v>-dev.zip` — a real developer build, not a release under another name.
		const cloned = await cloneForReleaseCommit({
			source: projectRoot,
			cloneDir,
			releaseBranch: RELEASE_BRANCH,
			// The release pass cuts the FIRST BETA here; the prerelease leg tags
			// `-beta.2` and the stable on later commits (tagNextCommit). Inherited
			// release tags of the rung's `to` triple or above are dropped first: the
			// leg's betas and stable must be the ONLY identities of that triple, or
			// a real `v<to>` (the release just cut) refuses beta.1 as superseded and
			// a real `v<to>-rc.N` is built in its place.
			...(FIRST_TAG === undefined ? {} : { tag: FIRST_TAG, dropReleaseTagsFrom: RUNG.to }),
			message: `release ${RELEASE_VERSION} (update drill)`,
			edit: (dir) => {
				// The release carries the checkout's UNCOMMITTED edits too — the
				// code under test (overlayWorkingTree; a no-op on a clean checkout).
				reportOverlay('release clone', overlayWorkingTree(projectRoot, dir));
				const versionTsPath = join(dir, 'src', 'core', 'update', 'version.ts');
				writeFileSync(
					versionTsPath,
					setVersionTriple(
						readFileSync(versionTsPath, 'utf8'),
						RELEASE_TRIPLE_LITERAL,
						'release clone',
					),
				);
				writeFileSync(join(dir, '.bun-version'), Bun.version);
				// The clone INHERITS the repo's export rules — it never repairs them.
				// A drill that patched a missing `export-ignore` would go green on the
				// very regression it exists to catch (the 2026-08-23 alias-symlink bug),
				// so a clone whose archive still carries a symlink entry is a HARD STOP
				// here, pointing at the gate that owns the invariant.
				const exported = Bun.spawnSync(
					['bash', '-c', `git -C '${dir}' archive --format=tar HEAD | tar -tvf -`],
					{ stdout: 'pipe', stderr: 'pipe' },
				);
				const symlinkEntries = exported.stdout
					.toString()
					.split('\n')
					.filter((line) => /^l[rwxsStT-]{9}\s/.test(line));
				must(
					symlinkEntries.length === 0,
					`the release clone's archive carries symlink entries, so the installer ` +
						`would refuse it outright — add the missing \`export-ignore\` rules to ` +
						`.gitattributes (gate: test/unit/release_archive_tripwire.test.ts):\n` +
						symlinkEntries.join('\n'),
				);
			},
		});
		if (cloned.droppedTags.length > 0) {
			console.log(
				`[drill] release clone: dropped ${cloned.droppedTags.length} inherited release tag(s) ` +
					`at or above ${RUNG.to.join('.')} so the leg's tags are that triple's only ones: ` +
					cloned.droppedTags.join(', '),
			);
		}

		// ---------------------------------------------------------------
		// STEPS 2–4 — the MASTER: boot, build through the wire, serve
		// ---------------------------------------------------------------
		const masterPort = await findFreePort(4391);
		const masterOrigin = `http://127.0.0.1:${masterPort}`;
		const codeFilesDir = join(scratch, 'code_files');
		const masterEnv = instanceEnvironment({
			suiteDb,
			port: masterPort,
			socketPath: join(scratch, 'master.sock'),
			sessionDbPath: join(scratch, 'master_sessions.sqlite'),
			stateFilePath: join(scratch, 'master_state.json'),
			scratch,
			extra: {
				DRILL_ROLE: 'master',
				// The master IS this checkout as the operator configured it: its
				// private dir is the drill's own (the DEDALO_PRIVATE_DIR override
				// included — under `ci:local` that is the empty runner-condition dir,
				// and the master must not fall back to the developer's real file).
				DEDALO_PRIVATE_DIR: privateDir,
				DEDALO_TEST_MEDIA_ROOT: testMediaRoot,
				IS_A_CODE_SERVER: 'true',
				// The master half of the dev channel's TWO switches: without it the
				// master answers a `channel:'dev'` ask with releases only (which the
				// release pass of this drill relies on staying true).
				...(DEV_CHANNEL_MODE ? { DEDALO_CODE_SERVER_DEV_CHANNEL: 'true' } : {}),
				// The master half of the PRERELEASE channel (the release pass only):
				// a separate switch, so the betas never expose branch builds — and
				// the release-channel assertions of steps 6b run against a master
				// that DOES hold prereleases, which is the exposure they must withhold.
				...(PRERELEASE_LEG ? { DEDALO_CODE_SERVER_PRERELEASE_CHANNEL: 'true' } : {}),
				DEDALO_CODE_FILES_DIR: codeFilesDir,
				DEDALO_CODE_SERVER_GIT_DIR: cloneDir,
				CODE_SERVERS: JSON.stringify([
					{ name: 'drill peer', url: `${masterOrigin}${API_PATH}`, code: DRILL_CODE },
				]),
				DEDALO_HOST: `127.0.0.1:${masterPort}`,
				DEDALO_PROTOCOL: 'http://',
			},
		});
		console.log(`[drill] starting the MASTER on ${masterOrigin}…`);
		sealStateFile(join(scratch, 'master_state.json'));
		master = spawnServer([process.execPath, 'run', 'src/server.ts'], projectRoot, masterEnv);
		await waitHealthy(masterOrigin, {
			// The master runs THIS CHECKOUT unpatched, so it answers whatever the
			// engine currently is — which is NOT the rung's FROM end once the
			// checkout has moved past it. Its own version gates nothing here: the
			// manifest keys on the CALLER's version, and the build is asked for an
			// explicit release version below.
			expectedVersion: DEDALO_ENGINE_VERSION,
			fingerprint,
			timeoutMs: 120_000,
			label: 'master boot',
		});

		const masterAuth = await wireLogin(masterOrigin, 'root', SUITE_LOGIN_PASSWORD);
		// STEP 4's serving base, and the restore point every unwaived install
		// runs over (both consumers plant it).
		const manifestBase = `${masterOrigin}/dedalo/install/code`;
		const drillArchive = await buildDrillArchive(scratch, suiteDb);
		const consumerOptions = (role: string, portFloor: number) => ({
			role,
			scratch,
			suiteDb,
			fingerprint,
			testMediaRoot,
			masterOrigin,
			portFloor,
			password: SUITE_LOGIN_PASSWORD,
			onSupervisor: (started: ManagedProcess) => supervisors.push(started),
		});

		// STEP 3 — the archive the stable consumer installs, built THROUGH THE
		// WIRE. On the release pass the prerelease leg builds it (beta.1 → beta.2
		// → the stable, in tag order) and walks its own consumer up to it first;
		// `--dev` builds the tip of `master`.
		const builtSha = PRERELEASE_LEG
			? await prereleaseLeg({
					masterOrigin,
					masterAuth,
					cloneDir,
					codeFilesDir,
					manifestBase,
					drillArchive,
					bootConsumer: () => bootConsumer(consumerOptions('prerelease_consumer', masterPort + 1)),
				})
			: await buildOrFail(masterOrigin, masterAuth, BUILD_CHANNEL, codeFilesDir, RELEASE_FILE_NAME);

		// STEP 4 — the serving URL answers anonymously (code_serving route).
		const served = await fetch(`${manifestBase}/${RELEASE_VERSION}/${RELEASE_FILE_NAME}`);
		must(served.ok, `serving URL answered ${served.status}`);
		await served.body?.cancel();

		// ---------------------------------------------------------------
		// STEP 5 — the CONSUMER: a full copy under a supervisor loop
		// ---------------------------------------------------------------
		const consumer = await bootConsumer(consumerOptions('consumer', masterPort + 1));
		const {
			tree: consumerTree,
			origin: consumerOrigin,
			auth: consumerAuth,
			backupRoot: consumerBackupRoot,
			dbBackupDir: consumerDbBackupDir,
			identity: consumerIdentity,
		} = consumer;
		const livePackageJsonBefore = readFileSync(join(consumerTree, 'package.json'), 'utf8');

		// ---------------------------------------------------------------
		// STEP 6a — the panel value: our master probes reachable
		// ---------------------------------------------------------------
		const panel = await apiPost(
			consumerOrigin,
			{
				dd_api: 'dd_area_maintenance_api',
				action: 'get_widget_value',
				prevent_lock: true,
				source: { model: 'update_code' },
			},
			consumerAuth,
		);
		must(panel.ok === true, `get_widget_value refused: ${JSON.stringify(panel.error ?? panel)}`);
		const panelData = panel.data as {
			servers: Record<string, unknown>[];
			is_a_code_server: boolean;
		};
		must(Array.isArray(panelData.servers) && panelData.servers.length >= 1, 'no servers listed');
		must(panelData.servers[0]?.response_code === 200, 'our master did not probe reachable');
		must(panelData.is_a_code_server === false, 'consumer misreports itself a code server');

		// ---------------------------------------------------------------
		// STEP 6b — the manifest: code-gated, advertising exactly one rung
		// ---------------------------------------------------------------
		const manifest = await apiPost(masterOrigin, {
			dd_api: 'dd_utils_api',
			action: 'get_code_update_info',
			prevent_lock: true,
			source: {},
			options: {
				version: CURRENT_VERSION,
				code: DRILL_CODE,
				...(DEV_CHANNEL_MODE ? { channel: 'dev' } : {}),
			},
		});
		must(manifest.ok === true, `manifest refused: ${JSON.stringify(manifest.error ?? manifest)}`);
		const info = manifest.data as {
			files: ReleaseItem[];
			info: { version: string };
		};
		// `info.version` is the MASTER's OWN version (code_manifest.ts passes
		// `serverVersion: DEDALO_VERSION_TRIPLE`), NOT the rung's FROM end — the
		// two only coincided while this checkout still sat on 7.0.0. The master
		// here runs this unpatched checkout, so the honest expectation is the
		// running engine's DATA version (version.ts) — never derived from the
		// release identity, which may be `7.0.0-beta.6` on a tagged checkout.
		const masterDataVersion = DEDALO_VERSION;
		must(
			info.info.version === masterDataVersion,
			`manifest reports server version ${info.info.version}, expected ${masterDataVersion}`,
		);
		// On the dev channel the master answers with the developer build FIRST and
		// may add published rungs behind it; on the release channel it is exactly
		// the one rung.
		must(
			Array.isArray(info.files) &&
				(DEV_CHANNEL_MODE ? info.files.length >= 1 : info.files.length === 1),
			`expected ${DEV_CHANNEL_MODE ? 'at least the developer build' : `exactly the ${RELEASE_VERSION} rung`}`,
		);
		const file = info.files[0] as ReleaseItem;
		must(file.version === RELEASE_VERSION, 'wrong rung advertised');
		if (PRERELEASE_LEG) {
			// The master holds beta.1 and beta.2 of this very rung by now: the
			// release-channel ask must still be the published release, unmarked.
			must(
				file.channel === undefined && file.release === undefined,
				`the release channel was offered a prerelease item: ${JSON.stringify(file)}`,
			);
		}
		if (DEV_CHANNEL_MODE) {
			must(file.channel === 'dev', 'the developer build is not marked channel:dev');
			must(file.url.endsWith('-dev.zip'), `the advertised URL is not the dev archive: ${file.url}`);
			// The point of the whole exercise: the version does NOT move.
			must(file.version === CURRENT_VERSION, 'the dev build should carry the INSTALLED version');
		}
		must(new URL(file.url).origin === new URL(manifestBase).origin, 'manifest URL off-origin');
		must(file.sha256 === builtSha, 'advertised digest differs from the sidecar');

		const badCode = await apiPost(masterOrigin, {
			dd_api: 'dd_utils_api',
			action: 'get_code_update_info',
			prevent_lock: true,
			source: {},
			options: { version: CURRENT_VERSION, code: 'not_the_code' },
		});
		must(
			badCode.ok !== true && badCode.error?.code === 'update_server.refused',
			'a wrong code must be refused with update_server.refused',
		);

		// ---------------------------------------------------------------
		// STEP 6c — maintenance mode ON, through the operator's own action
		// ---------------------------------------------------------------
		await maintenanceOn(consumer);

		// ---------------------------------------------------------------
		// STEP 6d — NEGATIVE, UNWAIVED: a truncated dump is not a restore point
		// ---------------------------------------------------------------
		// The finding (OPS-1): the precondition asked `pg_restore --list`, which
		// reads only the header and TOC at the FRONT of the archive, so a dump
		// that died at 60% counted as a fresh backup and the unwaived update swapped
		// the tree. Plant exactly that — a REAL archive's first 60%, ten minutes
		// old — and nothing else.
		const archiveBytes = readFileSync(drillArchive);
		const cutPath = join(consumerDbBackupDir, 'drill_died_at_60_percent.custom.backup');
		plantDatabaseBackup(
			cutPath,
			archiveBytes.subarray(0, Math.floor(archiveBytes.length * 0.6)),
			10,
		);
		console.log('[drill] submitting the UNWAIVED update over a truncated dump (must refuse)…');
		const unwaived = await apiPost(consumerOrigin, updateRequestBody(file), consumerAuth);
		must(unwaived.ok === true, 'unwaived submit should still answer ok (background job)');
		const unwaivedPid = typeof unwaived.pid === 'number' ? unwaived.pid : 0;
		const unwaivedPfile = typeof unwaived.pfile === 'string' ? unwaived.pfile : '';
		must(unwaivedPid !== 0 && unwaivedPfile !== '', 'no pid/pfile handle returned (unwaived)');
		const unwaivedFrames = await followJobStream(
			consumerOrigin,
			consumerAuth,
			unwaivedPid,
			unwaivedPfile,
			120_000,
		);
		const lastUnwaived = unwaivedFrames.at(-1);
		must(
			lastUnwaived !== undefined && lastUnwaived.is_running === false,
			`unwaived job never ended (phases: ${unwaivedFrames.map((frame) => frame.data?.phase).join(' -> ')})`,
		);
		must(
			lastUnwaived.error?.code === 'update.refused',
			`an unwaived update over a truncated dump was not refused: ${JSON.stringify(lastUnwaived)}`,
		);
		must(
			JSON.stringify(lastUnwaived).includes('truncated'),
			`the refusal does not name the truncated dump: ${JSON.stringify(lastUnwaived)}`,
		);
		const healthyAfterUnwaived = await fetchHealth(consumerOrigin);
		must(
			healthyAfterUnwaived.version === consumerIdentity,
			'server moved off the old version on a refused (unwaived) update',
		);
		must(
			readFileSync(join(consumerTree, 'package.json'), 'utf8') === livePackageJsonBefore,
			'live tree changed on a refused (unwaived) update',
		);
		must(
			readdirSync(consumerBackupRoot).filter((n) => n.startsWith('dedalo_')).length === 0,
			'a code backup dir appeared on a refused (unwaived) update',
		);
		must(
			!existsSync(join(consumerBackupRoot, 'last_code_update.json')),
			'a sentinel appeared on a refused (unwaived) update',
		);
		// Retire the cut the way the engine does (kept, renamed out of the
		// `*.backup` grammar) and plant the complete archive, NEWER, so steps 7–8
		// run over a genuine restore point.
		renameSync(cutPath, `${cutPath}.failed`);
		plantDatabaseBackup(join(consumerDbBackupDir, 'drill_complete.custom.backup'), archiveBytes, 5);

		// ---------------------------------------------------------------
		// STEP 7 — NEGATIVE: a tampered digest dies in VERIFY, touches nothing
		// ---------------------------------------------------------------
		console.log('[drill] submitting the TAMPERED-digest update (must fail in verify)…');
		const tampered = await apiPost(
			consumerOrigin,
			// WAIVED on purpose: the one leg that keeps the waiver door exercised.
			updateRequestBody({ ...file, sha256: 'a'.repeat(64) }, { waiveBackup: true }),
			consumerAuth,
		);
		must(tampered.ok === true, 'tampered submit should still answer ok (background job)');
		const tamperedPid = typeof tampered.pid === 'number' ? tampered.pid : 0;
		const tamperedPfile = typeof tampered.pfile === 'string' ? tampered.pfile : '';
		must(tamperedPid !== 0 && tamperedPfile !== '', 'no pid/pfile handle returned');
		const tamperedFrames = await followJobStream(
			consumerOrigin,
			consumerAuth,
			tamperedPid,
			tamperedPfile,
			180_000,
		);
		const lastTampered = tamperedFrames.at(-1);
		must(
			lastTampered !== undefined && lastTampered.is_running === false,
			'tampered job never ended',
		);
		must(
			JSON.stringify(tamperedFrames.map((frame) => frame.data)).includes('checksum mismatch'),
			'verify phase did not report the mismatch',
		);
		const healthyAfterNegative = await fetchHealth(consumerOrigin);
		must(healthyAfterNegative.version === consumerIdentity, 'server moved off the old version');
		must(
			readFileSync(join(consumerTree, 'package.json'), 'utf8') === livePackageJsonBefore,
			'live tree changed on a refused update',
		);
		must(
			readdirSync(consumerBackupRoot).filter((n) => n.startsWith('dedalo_')).length === 0,
			'a backup dir appeared on a refused update',
		);
		must(
			!existsSync(join(consumerBackupRoot, 'last_code_update.json')),
			'a sentinel appeared on a refused update',
		);

		// ---------------------------------------------------------------
		// STEP 8 — HAPPY PATH: install the release across a planned restart
		// ---------------------------------------------------------------
		console.log(
			`[drill] installing ${RELEASE_VERSION} (the stream will DIE at restart — by design)…`,
		);
		const submitted = await apiPost(consumerOrigin, updateRequestBody(file), consumerAuth);
		must(submitted.ok === true, `update submit refused: ${JSON.stringify(submitted.error)}`);
		const pid = typeof submitted.pid === 'number' ? submitted.pid : 0;
		const pfile = typeof submitted.pfile === 'string' ? submitted.pfile : '';
		must(pid !== 0 && pfile !== '', 'no pid/pfile handle returned');

		const frames = await followJobStream(consumerOrigin, consumerAuth, pid, pfile, 420_000);
		const phases = frames
			.map((frame) => frame.data?.phase)
			.filter((p): p is string => typeof p === 'string');
		console.log(
			`[drill] phases streamed: ${phases.join(' -> ') || '<connection died before frames>'}`,
		);
		const restartFrame = frames.find((frame) => frame.data?.phase === 'restart');
		if (restartFrame !== undefined) {
			must(
				restartFrame.data?.expected_version === RELEASE_VERSION,
				'restart frame lacks expected_version',
			);
		}

		// The supervisor brings the NEW tree up; /health must answer the release.
		//
		// ON THE DEV CHANNEL THE VERSION CANNOT BE THE PROOF. The installed tree
		// carries the version it replaced, so the string only gains its `.dev`
		// tag (install_stamp channel → build_stamp) — and a ROLLED-BACK tree
		// would answer with a version just as expected-looking. What actually
		// separates the two is `install_digest`: the sha256 of the archive that
		// was verified and swapped in.
		const expectedHealthVersion = DEV_CHANNEL_MODE ? `${RELEASE_VERSION}.dev` : RELEASE_VERSION;
		const healthLanded = (body: HealthBody): boolean =>
			body.db === 'ok' &&
			body.version === expectedHealthVersion &&
			(!DEV_CHANNEL_MODE || body.install_digest === builtSha);
		const healthUntil = Date.now() + 150_000;
		let health: HealthBody = {};
		while (Date.now() < healthUntil) {
			checkDeadline('post-restart health');
			try {
				health = await fetchHealth(consumerOrigin);
				if (healthLanded(health)) break;
			} catch {
				/* down — keep polling */
			}
			await Bun.sleep(700);
		}
		must(
			health.version === expectedHealthVersion,
			`server never came back on ${expectedHealthVersion}: ${JSON.stringify(health)}`,
		);
		if (DEV_CHANNEL_MODE) {
			must(
				health.install_digest === builtSha,
				`/health names archive ${String(health.install_digest)}, expected the one just installed (${builtSha}) — a same-version rollback looks exactly like this`,
			);
			console.log('[drill] /health install_digest matches the installed archive');
		}
		console.log(`[drill] /health answers ${String(health.version)} — the new tree is LIVE`);

		// ---------------------------------------------------------------
		// STEP 9 — the disk truth after a successful update
		// ---------------------------------------------------------------
		// boot_confirm flips the sentinel once the RUNNING version matches.
		const sentinelPath = join(consumerBackupRoot, 'last_code_update.json');
		const sentinelUntil = Date.now() + 30_000;
		let sentinel: Record<string, unknown> = {};
		while (Date.now() < sentinelUntil) {
			try {
				sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8')) as Record<string, unknown>;
				if (sentinel.status === 'confirmed') break;
			} catch {
				/* not written yet */
			}
			await Bun.sleep(500);
		}
		must(sentinel.status === 'confirmed', `sentinel not confirmed: ${JSON.stringify(sentinel)}`);
		must(
			sentinel.version === RELEASE_VERSION && sentinel.previousVersion === CURRENT_VERSION,
			'sentinel names the wrong versions',
		);
		must(
			sentinel.installDigest === builtSha,
			`sentinel installDigest ${String(sentinel.installDigest)} is not the installed archive ${builtSha}`,
		);
		if (DEV_CHANNEL_MODE) {
			// The confirmation above is only meaningful BECAUSE the digest differs
			// while the versions do not: boot_confirm compared versions until
			// 2026-08-24, and on this exact path that check confirms a rollback.
			must(
				sentinel.version === sentinel.previousVersion,
				'the dev drill is not rehearsing a same-version install',
			);
			const stamp = JSON.parse(
				readFileSync(join(consumerTree, 'src', 'core', 'update', 'install_stamp.json'), 'utf8'),
			) as Record<string, unknown>;
			must(stamp.digest === builtSha, 'the installed tree is stamped with another archive');
			must(stamp.channel === 'dev', 'the installed tree does not know it is a developer build');
		}

		const backups = readdirSync(consumerBackupRoot).filter((n) => n.startsWith('dedalo_'));
		must(backups.length === 1, `expected exactly one backup dir, got ${backups.join(', ')}`);
		const backupDir = join(consumerBackupRoot, backups[0] as string);
		for (const carried of ['package.json', 'node_modules']) {
			must(existsSync(join(backupDir, carried)), `backup lost ${carried} (rollback bootability)`);
		}
		must(
			existsSync(join(consumerTree, 'node_modules')),
			'new tree has no node_modules (quarantine install missing)',
		);
		must(!existsSync(join(consumerBackupRoot, '.code_staging')), 'staging dir was not swept');
		// NOTE on the dev channel this says little (both trees declare the same
		// triple) — the load-bearing tree assertion there is the install stamp
		// checked above, which names the exact archive.
		must(
			readFileSync(join(consumerTree, 'src', 'core', 'update', 'version.ts'), 'utf8').includes(
				RELEASE_TRIPLE_LITERAL,
			),
			`live tree is not the ${RELEASE_VERSION} code`,
		);
		must(
			!readFileSync(join(consumerTree, 'src', 'core', 'update', 'build_info.txt'), 'utf8').includes(
				'$Format:',
			),
			'build stamp did not expand (RELEASE.md step 11)',
		);

		// The final poll answers ONE terminal frame. Which one depends on timing
		// (both are correct): the job HANDLER returns before the deferred exit,
		// so the record is usually already 'done' carrying the pipeline's
		// installed-version envelope; if death won the race, the new boot's
		// dead-owner reconcile marks it 'interrupted' instead.
		const interrupted = await followJobStream(consumerOrigin, consumerAuth, pid, pfile, 15_000);
		const terminal = interrupted[0];
		must(
			terminal !== undefined && terminal.is_running === false,
			'no terminal frame after the restart',
		);
		const terminalText = JSON.stringify(interrupted);
		must(
			terminalText.includes('interrupted') ||
				terminalText.includes(`Installed Dédalo ${RELEASE_VERSION}`),
			`terminal frame neither interrupted nor the installed-version result: ${terminalText.slice(0, 300)}`,
		);

		console.log(
			`[drill] PASS — build -> serve -> discover -> refuse-bad-sha -> install -> planned-death restart -> confirmed sentinel.`,
		);
	} finally {
		for (const started of supervisors) await started.stop();
		if (master !== null) await master.stop();
		if (keepScratch) {
			console.log(`[drill] --keep: scratch left at ${scratch}`);
		} else {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
}

try {
	await main();
	process.exit(0);
} catch (error) {
	console.error(
		`\n[drill] ${(error instanceof Error ? error.stack : String(error)) ?? 'unknown failure'}`,
	);
	process.exit(1);
}
