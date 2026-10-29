/**
 * deploy/dedalo-image-updater.sh, EXECUTED — the opt-in HOST image updater
 * (installer unification D4, design 5.7–5.8).
 *
 * The updater is the only component with docker access that acts on what the
 * code-update panel recorded: it beats a heartbeat into the engine, records an
 * orphaned request as interrupted, claims the pending request, re-checks it
 * against its OWN floors (a UUID, a version tag, no downgrade against the
 * pinned DEDALO_VERSION), runs deploy/dedalo-image-update.sh with exactly
 * three flags, and hands the outcome back to the engine.
 *
 * HOW. Each case builds a scratch STACK DIRECTORY holding the real updater, the
 * real host library and generated registry list, a stack file, a `.dedalo.env`
 * and a FAKE deploy/dedalo-image-update.sh that records its argv and cwd and
 * writes the outcome a situation asks for. A stub `docker` is first on PATH:
 * for `compose … exec|run … bun scripts/ops/image_update_channel.ts <verb>` it
 * runs the REAL channel CLI (`bun <repo>/scripts/ops/image_update_channel.ts
 * <verb> --dir <scratch channel>`), so every file the panel reads afterwards was
 * written by the engine's own code. The assertions read OUTCOMES: the channel
 * files through the panel's own reader, the fake update's argv, the order of
 * the calls, and what never ran.
 *
 * The unit verbs run against a scratch unit directory and a stub `systemctl`
 * (and a stub `id` for the root, owner-name and docker-group checks) — nothing
 * touches this machine's systemd or reads its account database.
 *
 * Hermetic: no database, no network, no real docker.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ImageUpdateRequest,
	INFLIGHT_FILE,
	REQUEST_FILE,
	readChannelStatus,
	readHostUpdaterState,
	writeChannelFile,
	writeRequest,
} from '../../src/core/update/image_update_channel.ts';
import { parseImageTag } from '../../src/core/update/version_walk.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'ops', 'image_update_channel.ts');
// realpath: the updater resolves its stack dir physically (/private/var on macOS).
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dedalo-image-updater-')));
let scratchCount = 0;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const IMAGE = 'ghcr.io/example-org/dedalo';
const REPO_DIGEST = `sha256:${'c'.repeat(64)}`;
const ARGV_FLAGS_NEVER = ['--no-backup', '--skip-version-check', '--ref'];

// ---------------------------------------------------------------------------
// The stubs.
// ---------------------------------------------------------------------------

/**
 * docker. Compose argv is `compose -f … --env-file F <sub> …`; each call is
 * logged as `compose <sub> <rest>`. exec/run of the channel CLI runs the REAL
 * CLI against the scratch channel dir; flags in the state dir simulate an image
 * without the CLI, a failing `run`, or a compromised engine's claim answer.
 */
const DOCKER_STUB = `#!/bin/bash
S="$STUB_STATE"
log() { printf '%s\\n' "$*" >> "$S/calls.log"; }
if [ "$1" = compose ]; then
	shift
	while [ $# -gt 0 ]; do
		case "$1" in
			-f | --env-file) shift 2 ;;
			*) break ;;
		esac
	done
	sub="$1"; shift
	log "compose $sub $*"
	case "$sub" in
		ps) if [ -e "$S/running" ]; then echo cid-dedalo; fi; exit 0 ;;
		exec | run)
			while [ $# -gt 0 ]; do
				case "$1" in
					-T | --rm | --no-deps) shift ;;
					*) break ;;
				esac
			done
			[ "$1" = dedalo ] && [ "$2" = bun ] && [ "$3" = scripts/ops/image_update_channel.ts ] || exit 9
			verb="$4"
			if [ -e "$S/no_cli" ]; then echo 'error: Module not found "scripts/ops/image_update_channel.ts"' >&2; exit 1; fi
			if [ -e "$S/\${sub}_fail" ]; then exit 1; fi
			if [ "$verb" = claim ] && [ -e "$S/claim_out" ]; then cat "$S/claim_out"; exit 0; fi
			exec "${process.execPath}" "${CLI}" "$verb" --dir "$S/channel"
			;;
	esac
	exit 0
fi
log "docker $*"
if [ "$1" = image ] && [ "$2" = inspect ] && [ -e "$S/repo_digest" ]; then
	for ref in "$@"; do :; done
	printf '%s@%s\\n' "\${ref%:*}" "${REPO_DIGEST}"
fi
exit 0
`;

/** The update script, faked: argv + cwd recorded, the outcome the situation asks for. */
const FAKE_UPDATE = `#!/bin/bash
S="$STUB_STATE"
printf '%s\\n' "$*" > "$S/update_argv"
pwd -P > "$S/update_cwd"
printf 'update %s\\n' "$*" >> "$S/calls.log"
out='' id='' to=''
while [ $# -gt 0 ]; do
	case "$1" in
		--outcome-file) out="$2"; shift 2 ;;
		--request-id) id="$2"; shift 2 ;;
		--version) to="$2"; shift 2 ;;
		*) shift ;;
	esac
done
[ -e "$S/update_silent" ] && exit 1
status="$(cat "$S/update_status" 2>/dev/null || echo green)"
detail="$(cat "$S/update_detail" 2>/dev/null || echo healthy)"
printf '{"schema":1,"request_id":"%s","from":"7.0.0","to":"%s","mode":"pull","image":"${IMAGE}","status":"%s","detail":"%s","backup":"/backups/db/pre-image-update.dump","digest":null,"started_at":"2026-10-09T10:00:00Z","finished_at":"2026-10-09T10:05:00Z"}\\n' "$id" "$to" "$status" "$detail" > "$out"
[ "$status" = green ]
`;

/**
 * id: `-u` from the state (default 0, root); `-un <uid>` names the stack dir's
 * owner `u<uid>` (an `owner_nameless` flag: no account, as a bare uid has);
 * `-nG <user>` names the docker group. Every account probe the unit verbs make
 * goes through here — never through this machine's passwd, which a CI
 * container's bare uid 1001 does not have.
 */
const ID_STUB = `#!/bin/bash
case "$1" in
	-u) cat "$STUB_STATE/uid" 2>/dev/null || echo 0 ;;
	-un)
		[ -e "$STUB_STATE/owner_nameless" ] && { echo "id: $2: no such user" >&2; exit 1; }
		echo "u$2" ;;
	-nG) cat "$STUB_STATE/groups" 2>/dev/null || echo "$2 docker" ;;
	*) exit 64 ;;
esac
`;

const SYSTEMCTL_STUB = `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$STUB_STATE/calls.log"
`;

// ---------------------------------------------------------------------------
// The scratch stack.
// ---------------------------------------------------------------------------

interface Situation {
	pinned?: string;
	mode?: 'pull' | 'build';
	/** Flags (files) in the state dir, with optional content. */
	state?: Record<string, string>;
	/** Replace the whole .dedalo.env. */
	envText?: string;
	/** Stub binaries to leave out of PATH. */
	without?: string[];
	/** The stack dir's basename (to plant an unsafe path). */
	stackName?: string;
}

interface Stack {
	dir: string;
	state: string;
	bin: string;
	channel: string;
	units: string;
}

function makeStack(situation: Situation = {}): Stack {
	scratchCount += 1;
	const root = join(SCRATCH, `case-${scratchCount}`);
	const dir = join(root, situation.stackName ?? 'stack');
	const state = join(root, 'state');
	const bin = join(root, 'bin');
	const units = join(root, 'units');
	for (const path of [join(dir, 'deploy'), state, bin, units]) mkdirSync(path, { recursive: true });
	for (const file of ['dedalo-image-updater.sh', 'dedalo-image-lib.sh', 'image_registries.sh']) {
		copyFileSync(join(REPO_ROOT, 'deploy', file), join(dir, 'deploy', file));
	}
	writeFileSync(join(dir, 'deploy', 'dedalo-image-update.sh'), FAKE_UPDATE);
	chmodSync(join(dir, 'deploy', 'dedalo-image-update.sh'), 0o755);
	writeFileSync(join(dir, 'docker-compose.simple.yml'), 'services: {}\n');
	const envText =
		situation.envText ??
		[
			'# Written by install.sh — compose variable substitution only.',
			'POSTGRES_PASSWORD=s3cret',
			'DEDALO_COMPOSE_FILE=docker-compose.simple.yml',
			`DEDALO_IMAGE=${IMAGE}`,
			`DEDALO_VERSION=${situation.pinned ?? '7.0.0'}`,
			`DEDALO_IMAGE_MODE=${situation.mode ?? 'pull'}`,
			'DEDALO_IMAGE_VERIFY=none',
			'',
		].join('\n');
	writeFileSync(join(dir, '.dedalo.env'), envText, { mode: 0o600 });
	const stubs: Record<string, string> = {
		docker: DOCKER_STUB,
		id: ID_STUB,
		systemctl: SYSTEMCTL_STUB,
	};
	for (const [name, body] of Object.entries(stubs)) {
		if (situation.without?.includes(name)) continue;
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	for (const [name, content] of Object.entries({ running: '', ...situation.state })) {
		writeFileSync(join(state, name), content);
	}
	return { dir, state, bin, channel: join(state, 'channel'), units };
}

interface Result {
	code: number;
	stdout: string;
	stderr: string;
	calls: string[];
}

function runUpdater(stack: Stack, args: string[] = []): Result {
	const run = Bun.spawnSync(
		['bash', join(stack.dir, 'deploy', 'dedalo-image-updater.sh'), ...args],
		{
			// Not the stack dir: the updater must find its stack itself.
			cwd: stack.state,
			env: {
				PATH: `${stack.bin}:/usr/bin:/bin`,
				STUB_STATE: stack.state,
				TMPDIR: stack.state,
				HOME: process.env.HOME ?? stack.state,
			},
		},
	);
	const log = join(stack.state, 'calls.log');
	return {
		code: run.exitCode ?? -1,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
		calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
	};
}

function request(tag: string, id: string = crypto.randomUUID()): ImageUpdateRequest {
	const parsed = parseImageTag(tag);
	if (parsed === null) throw new Error(`bad fixture tag ${tag}`);
	return {
		schema: 1,
		id,
		tag,
		version: parsed.version,
		channel: parsed.channel,
		from_version: '7.0.0',
		requested_at: '2026-10-09T09:00:00.000Z',
		requested_by: 1,
	};
}

async function placeRequest(stack: Stack, tag: string): Promise<ImageUpdateRequest> {
	const pending = request(tag);
	expect(await writeRequest(pending, stack.channel)).toEqual({ ok: true });
	return pending;
}

/** The index of the first call matching `re` (-1 when none). */
function at(calls: readonly string[], re: RegExp): number {
	return calls.findIndex((call) => re.test(call));
}

const HEARTBEAT = /^compose exec -T dedalo bun scripts\/ops\/image_update_channel\.ts heartbeat$/;
const CLAIM = /^compose exec -T dedalo bun scripts\/ops\/image_update_channel\.ts claim$/;
const ORPHAN = /^compose exec -T dedalo bun scripts\/ops\/image_update_channel\.ts orphan$/;
const RUN_OUTCOME =
	/^compose run --rm --no-deps -T dedalo bun scripts\/ops\/image_update_channel\.ts outcome$/;
const EXEC_OUTCOME = /^compose exec -T dedalo bun scripts\/ops\/image_update_channel\.ts outcome$/;

// ---------------------------------------------------------------------------
// run — the pass.
// ---------------------------------------------------------------------------

describe('a pass with nothing requested', () => {
	test('beats the heartbeat the panel reads as ALIVE, with the pinned source — and updates nothing', async () => {
		const stack = makeStack({ state: { repo_digest: '' } });
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		const host = await readHostUpdaterState(new Date(), stack.channel);
		expect(host.state).toBe('alive');
		expect(host).toMatchObject({
			interval_seconds: 60,
			mode: 'pull',
			image: IMAGE,
			pinned: '7.0.0',
			verify: 'none',
			running_digest: REPO_DIGEST,
		});
		// the heartbeat is the engine's stamp, not the host's: seen_at is recent
		expect(Date.now() - Date.parse(host.seen_at ?? '')).toBeLessThan(60_000);
		expect(at(result.calls, HEARTBEAT)).toBeGreaterThan(-1);
		expect(at(result.calls, CLAIM)).toBeGreaterThan(at(result.calls, HEARTBEAT));
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
		expect((await readChannelStatus(new Date(), stack.channel)).last_outcome).toBeNull();
	});

	test('a build-mode install reports no running digest (a local build has none)', async () => {
		const stack = makeStack({ mode: 'build' });
		expect(runUpdater(stack).code).toBe(0);
		const host = await readHostUpdaterState(new Date(), stack.channel);
		expect(host.state).toBe('alive');
		expect(host.mode).toBe('build');
		expect(host.running_digest).toBeNull();
	});
});

describe('a requested update', () => {
	test('is claimed, run with EXACTLY the three flags from the stack dir, and its outcome recorded', async () => {
		const stack = makeStack();
		const pending = await placeRequest(stack, '7.0.1');
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		const argv = readFileSync(join(stack.state, 'update_argv'), 'utf8').trim().split(' ');
		expect(argv.slice(0, 4)).toEqual(['--version', '7.0.1', '--request-id', pending.id]);
		expect(argv[4]).toBe('--outcome-file');
		expect(argv).toHaveLength(6);
		for (const flag of ARGV_FLAGS_NEVER) expect(argv).not.toContain(flag);
		expect(readFileSync(join(stack.state, 'update_cwd'), 'utf8').trim()).toBe(stack.dir);
		// the outcome reached the engine untouched, and the request is done
		const status = await readChannelStatus(new Date(), stack.channel);
		expect(status.request).toBeNull();
		expect(existsSync(join(stack.channel, INFLIGHT_FILE))).toBe(false);
		expect(existsSync(join(stack.channel, REQUEST_FILE))).toBe(false);
		expect(status.last_outcome).toMatchObject({
			request_id: pending.id,
			to: '7.0.1',
			status: 'green',
			detail: 'healthy',
			backup: '/backups/db/pre-image-update.dump',
		});
		// the order of effects: heartbeat → orphan → claim → update → record (run) → heartbeat
		const order = [HEARTBEAT, ORPHAN, CLAIM, /^update /, RUN_OUTCOME].map((re) =>
			at(result.calls, re),
		);
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(result.calls.filter((call) => HEARTBEAT.test(call))).toHaveLength(2);
	});

	test('a failed update is recorded as the update script reported it, and the pass still exits 0', async () => {
		const stack = makeStack({
			state: { update_status: 'rolled_back', update_detail: 'unhealthy' },
		});
		const pending = await placeRequest(stack, '7.0.1');
		expect(runUpdater(stack).code).toBe(0);
		expect((await readChannelStatus(new Date(), stack.channel)).last_outcome).toMatchObject({
			request_id: pending.id,
			status: 'rolled_back',
			detail: 'unhealthy',
		});
	});

	test('an update script that dies without an outcome is recorded as failed / interrupted', async () => {
		const stack = makeStack({ state: { update_silent: '' } });
		const pending = await placeRequest(stack, '7.0.1');
		expect(runUpdater(stack).code).toBe(0);
		const status = await readChannelStatus(new Date(), stack.channel);
		expect(status.last_outcome).toMatchObject({
			request_id: pending.id,
			from: '7.0.0',
			to: '7.0.1',
			status: 'failed',
			detail: 'interrupted',
		});
		expect(status.request).toBeNull();
	});

	test('when the one-off container cannot record, the running engine does', async () => {
		const stack = makeStack({ state: { run_fail: '' } });
		const pending = await placeRequest(stack, '7.0.1');
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(at(result.calls, RUN_OUTCOME)).toBeGreaterThan(-1);
		expect(at(result.calls, EXEC_OUTCOME)).toBeGreaterThan(at(result.calls, RUN_OUTCOME));
		expect((await readChannelStatus(new Date(), stack.channel)).last_outcome?.request_id).toBe(
			pending.id,
		);
	});

	test('a -dev request is refused even over a -dev pin: Docker has no nightly images (positive control: a release still runs)', async () => {
		const stack = makeStack({ pinned: '7.0.0-dev' });
		const pending = await placeRequest(stack, '7.0.0-dev');
		expect(runUpdater(stack).code).toBe(0);
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
		const status = await readChannelStatus(new Date(), stack.channel);
		expect(status.last_outcome).toMatchObject({
			request_id: pending.id,
			to: '7.0.0-dev',
			status: 'refused',
			detail: 'version_refused',
		});
		const release = makeStack({ pinned: '7.0.0' });
		await placeRequest(release, '7.0.1');
		expect(runUpdater(release).code).toBe(0);
		expect(readFileSync(join(release.state, 'update_argv'), 'utf8')).toStartWith(
			'--version 7.0.1 ',
		);
	});
});

describe('the host floors hold whatever the engine says', () => {
	const cases: { name: string; pinned: string; tag: string; detail: string }[] = [
		{ name: 'a downgrade', pinned: '7.0.2', tag: '7.0.1', detail: 'downgrade_refused' },
		{
			name: 'the pinned release again',
			pinned: '7.0.1',
			tag: '7.0.1',
			detail: 'downgrade_refused',
		},
		{
			name: 'an older -dev image (no nightly image: refused before the walk)',
			pinned: '7.0.2-dev',
			tag: '7.0.1-dev',
			detail: 'version_refused',
		},
		// A request never moves a RELEASE installation onto developer images (build mode
		// would check out the remote's master tip and run this program from it).
		{
			name: 'a -dev image over a release',
			pinned: '7.0.0',
			tag: '7.0.0-dev',
			detail: 'version_refused',
		},
		{
			name: 'a newer -dev image over a release',
			pinned: '7.0.0',
			tag: '7.0.1-dev',
			detail: 'version_refused',
		},
	];
	for (const entry of cases) {
		test(`${entry.name} (${entry.tag} over a pinned ${entry.pinned}) is refused, recorded, never run`, async () => {
			const stack = makeStack({ pinned: entry.pinned });
			const pending = await placeRequest(stack, entry.tag);
			expect(runUpdater(stack).code).toBe(0);
			expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
			const status = await readChannelStatus(new Date(), stack.channel);
			expect(status.last_outcome).toMatchObject({
				request_id: pending.id,
				from: entry.pinned,
				to: entry.tag,
				status: 'refused',
				detail: entry.detail,
			});
			expect(status.request).toBeNull();
		});
	}

	// The host floor orders prerelease tags as releases are ordered (design step 6), and a
	// prerelease-pinned stack (the installer pins every beta at its own tag) beats its
	// heartbeat. The claim is answered raw: the engine's own request grammar reaches
	// prereleases only with the identity walk (design step 9c), but the HOST holds the floor.
	test('prereleases: beta.6 → beta.7 runs; beta.7 → beta.6 and 7.0.0 → rc.1 are steps back, refused and recorded, never run', async () => {
		const id = crypto.randomUUID();
		const forward = makeStack({
			pinned: '7.0.0-beta.6',
			state: { claim_out: `${id} 7.0.0-beta.7\n` },
		});
		const ran = runUpdater(forward);
		expect(ran.code, ran.stderr).toBe(0);
		expect(readFileSync(join(forward.state, 'update_argv'), 'utf8')).toStartWith(
			'--version 7.0.0-beta.7 ',
		);
		for (const [pinned, tag] of [
			['7.0.0-beta.7', '7.0.0-beta.6'],
			['7.0.0', '7.0.0-rc.1'],
		] as const) {
			const back = makeStack({ pinned, state: { claim_out: `${id} ${tag}\n` } });
			const result = runUpdater(back);
			expect(result.code).toBe(0);
			expect(existsSync(join(back.state, 'update_argv')), `${tag} over ${pinned}`).toBe(false);
			expect((await readChannelStatus(new Date(), back.channel)).last_outcome).toMatchObject({
				from: pinned,
				to: tag,
				status: 'refused',
				detail: 'downgrade_refused',
			});
		}
	});

	test('a tag that is not a version (a compromised engine answering claim) is refused and recorded', async () => {
		const id = crypto.randomUUID();
		for (const tag of ['latest', '7.0.1;id', '7.0.1 --no-backup', 'v7.0.1']) {
			const stack = makeStack({ state: { claim_out: `${id} ${tag}\n` } });
			const result = runUpdater(stack);
			expect(result.code).toBe(0);
			expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
			expect((await readChannelStatus(new Date(), stack.channel)).last_outcome).toMatchObject({
				request_id: id,
				to: '',
				status: 'refused',
				detail: 'version_refused',
			});
		}
	});

	test('a request id that is not a UUID is an internal error: nothing runs, nothing is recorded', async () => {
		const stack = makeStack({ state: { claim_out: 'not-a-uuid 7.0.1\n' } });
		const result = runUpdater(stack);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('not a UUID');
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
		expect((await readChannelStatus(new Date(), stack.channel)).last_outcome).toBeNull();
	});
});

describe('a request a previous pass never finished', () => {
	test('is recorded as failed / interrupted, cleared, and not re-run', async () => {
		const stack = makeStack();
		const orphan = { ...request('7.0.1'), claimed_at: '2026-10-09T09:01:00.000Z' };
		await writeChannelFile(stack.channel, INFLIGHT_FILE, orphan);
		expect((await readChannelStatus(new Date(), stack.channel)).request?.state).toBe('claimed');
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('never finished');
		const status = await readChannelStatus(new Date(), stack.channel);
		expect(status.request).toBeNull();
		expect(status.last_outcome).toMatchObject({
			request_id: orphan.id,
			to: '7.0.1',
			status: 'failed',
			detail: 'interrupted',
		});
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
	});
});

describe('passes that do nothing, and say so', () => {
	test('a held lock: another pass is running — no docker call at all', async () => {
		const stack = makeStack();
		await placeRequest(stack, '7.0.1');
		const lock = join(stack.dir, '.dedalo-image-updater.lock');
		mkdirSync(lock);
		writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('already running');
		expect(result.calls).toEqual([]);
		expect((await readChannelStatus(new Date(), stack.channel)).request?.state).toBe('requested');
		// the lock of a DEAD holder is taken over (positive control), and released
		writeFileSync(join(lock, 'pid'), '999999\n');
		const taken = runUpdater(stack);
		expect(taken.code).toBe(0);
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	test('an image older than the channel (no CLI) is a logged no-op', async () => {
		const stack = makeStack({ state: { no_cli: '' } });
		await placeRequest(stack, '7.0.1');
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('older than its update channel');
		expect(at(result.calls, HEARTBEAT)).toBeGreaterThan(-1);
		expect(at(result.calls, CLAIM)).toBe(-1);
		expect(existsSync(join(stack.state, 'update_argv'))).toBe(false);
	});

	test('the engine not running: no heartbeat, no claim', async () => {
		const stack = makeStack();
		rmSync(join(stack.state, 'running'));
		await placeRequest(stack, '7.0.1');
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('not running');
		expect(at(result.calls, /^compose ps /)).toBeGreaterThan(-1);
		expect(at(result.calls, HEARTBEAT)).toBe(-1);
		expect((await readHostUpdaterState(new Date(), stack.channel)).state).toBe('absent');
	});

	test('an incomplete .dedalo.env (a pre-image-pin install): no docker call at all', () => {
		const stack = makeStack({
			envText: 'POSTGRES_PASSWORD=s3cret\nDEDALO_COMPOSE_FILE=docker-compose.simple.yml\n',
		});
		const result = runUpdater(stack);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain('DEDALO_IMAGE missing');
		expect(result.calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The units.
// ---------------------------------------------------------------------------

function unitArgs(stack: Stack, verb: string): string[] {
	return [verb, '--stack-dir', stack.dir, '--unit-dir', stack.units];
}

describe('install-units / print-units / uninstall-units', () => {
	// The stack dir's REAL owner uid, named by the stub id: proves the owner
	// probe read the directory and its name reached the unit.
	const owner = `u${process.getuid?.() ?? -1}`;

	test('install-units writes both units with the stack dir and its owner substituted, then enables the timer', () => {
		const stack = makeStack();
		const result = runUpdater(stack, unitArgs(stack, 'install-units'));
		expect(result.stderr).toContain('installed');
		expect(result.code).toBe(0);
		const service = readFileSync(join(stack.units, 'dedalo-image-updater.service'), 'utf8');
		const timer = readFileSync(join(stack.units, 'dedalo-image-updater.timer'), 'utf8');
		for (const line of [
			'Type=oneshot',
			`User=${owner}`,
			`WorkingDirectory=${stack.dir}`,
			`ExecStart=/bin/bash ${stack.dir}/deploy/dedalo-image-updater.sh --stack-dir ${stack.dir}`,
			'TimeoutStartSec=2h',
			'NoNewPrivileges=yes',
			'PrivateTmp=yes',
			'After=docker.service',
			'Requires=docker.service',
		]) {
			expect(service.split('\n')).toContain(line);
		}
		for (const line of [
			'OnBootSec=2min',
			'OnUnitInactiveSec=60s',
			'AccuracySec=10s',
			'WantedBy=timers.target',
		]) {
			expect(timer.split('\n')).toContain(line);
		}
		expect(result.calls).toEqual([
			'systemctl daemon-reload',
			'systemctl enable --now dedalo-image-updater.timer',
		]);
		// print-units renders the same two files
		const printed = runUpdater(stack, unitArgs(stack, 'print-units'));
		expect(printed.code).toBe(0);
		expect(printed.stdout).toContain(service);
		expect(printed.stdout).toContain(timer);
		// …and uninstall-units reverses it
		const removed = runUpdater(stack, ['uninstall-units', '--unit-dir', stack.units]);
		expect(removed.code).toBe(0);
		expect(existsSync(join(stack.units, 'dedalo-image-updater.service'))).toBe(false);
		expect(existsSync(join(stack.units, 'dedalo-image-updater.timer'))).toBe(false);
		expect(removed.calls.slice(-2)).toEqual([
			'systemctl disable --now dedalo-image-updater.timer',
			'systemctl daemon-reload',
		]);
	});

	test('--user names the account the units run as', () => {
		const stack = makeStack();
		const printed = runUpdater(stack, [...unitArgs(stack, 'print-units'), '--user', 'dedalo']);
		expect(printed.code).toBe(0);
		expect(printed.stdout.split('\n')).toContain('User=dedalo');
	});

	const refusals: { name: string; situation: Situation; args?: string[]; says: string }[] = [
		{ name: 'a stack path with a space', situation: { stackName: 'my stack' }, says: 'whitespace' },
		{ name: 'a stack path with a quote', situation: { stackName: "o'stack" }, says: 'quotes' },
		{
			name: 'a stack path with a systemd specifier',
			situation: { stackName: 'st%hack' },
			says: 'special',
		},
		{
			name: 'a host without systemctl',
			situation: { without: ['systemctl'] },
			args: ['--systemctl', 'systemctl-not-installed'],
			says: 'no systemctl-not-installed here',
		},
		{ name: 'not root', situation: { state: { uid: '1000' } }, says: 'need root' },
		{
			name: 'an owner with no account name',
			situation: { state: { owner_nameless: '' } },
			says: 'has no account name on this host',
		},
		{
			name: 'an owner outside the docker group',
			situation: { state: { groups: 'staff wheel' } },
			says: 'not in the docker group',
		},
		{
			name: 'an unsafe account name',
			situation: {},
			args: ['--user', 'a;b'],
			says: 'account name',
		},
	];
	for (const entry of refusals) {
		test(`install-units refuses ${entry.name}, writing nothing`, () => {
			const stack = makeStack(entry.situation);
			const result = runUpdater(stack, [
				...unitArgs(stack, 'install-units'),
				...(entry.args ?? []),
			]);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(entry.says);
			expect(existsSync(join(stack.units, 'dedalo-image-updater.service'))).toBe(false);
			expect(result.calls).toEqual([]);
		});
	}

	test('an unknown verb or flag is a usage error', () => {
		const stack = makeStack();
		expect(runUpdater(stack, ['upgrade-now']).code).toBe(2);
		expect(runUpdater(stack, ['run', '--no-backup']).code).toBe(2);
		expect(runUpdater(stack, ['run', '--stack-dir']).code).toBe(2);
	});
});
