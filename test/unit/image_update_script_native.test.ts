/**
 * deploy/dedalo-image-update.sh, EXECUTED — the code update of a Docker
 * installation (installer unification D2, design 3.9 + the outcome object 5.4).
 *
 * The script replaces the image the stack runs: a verified database backup,
 * the running image anchored as a rollback tag, the new image pulled (signature
 * checked when the install asks for it) or built from the release checkout,
 * DEDALO_VERSION re-pinned, the engine recreated, the healthcheck awaited — and,
 * on red, the old image re-tagged, re-pinned and brought back. Its source of
 * truth is `.dedalo.env`; the caller chooses only a version.
 *
 * HOW. Each case builds a scratch STACK DIRECTORY — the real deploy/ scripts
 * (updater, host library, generated registry list, build override), a stack
 * file, a `.dedalo.env`, a version.ts — and runs the real script with stub
 * `docker`, `git`, `cosign` and `sleep` first on PATH. The stubs record every
 * argv and simulate the states (engine running, backup service, health per
 * recreation, pull/build/verify failures, the engine's check-target verdict).
 * The assertions read the OUTCOMES: the env file afterwards (byte for byte),
 * the outcome JSON (validated against the 5.4 contract), the ORDER of effects,
 * and what was never touched (postgres, nginx).
 *
 * The engine CLI (`scripts/ops/image_update_channel.ts check-target`) is stubbed
 * to its contract (exit 0 ok, 3 refused + a reason id on stdout, anything else
 * unavailable) where a case sets the verdict; a case that names an `engine` is
 * answered by a REAL engine instead, so the prerelease cases meet the engine a
 * stack really runs (an always-ok stub once hid that every engine refused a
 * prerelease tag as `malformed_version`):
 *  - `engine: '<identity>'` — the CURRENT engine: this checkout's CLI run from an
 *    engine tree that calls itself that identity (test/helpers/engine_cli_tree.ts —
 *    the identity walk starts from what the image calls itself);
 *  - `engine: 'old'` — an engine that PREDATES the identity walk (7.0.0-beta.6
 *    and older, the old image a stack is often updated FROM): its exact
 *    check-target contract — the X.Y.Z(-dev) grammar, `malformed_version` for
 *    anything else, the triple walk from its X.Y.Z — over the unchanged data
 *    walk it ran (version_walk.ts assertLinearUpgrade). The host's data-walk
 *    re-ask exists for this engine.
 * A prerelease ask with no engine named is a loud stub failure, never an "ok".
 * Those cases name their versions from DEDALO_VERSION_TRIPLE (T).
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
import { BUILD_CONTEXT } from '../../src/core/install/host/stack/image.ts';
import { BUILD_INFO_PATH, readReleaseIdentityOf } from '../../src/core/update/build_stamp.ts';
import { loadImageRegistries } from '../../src/core/update/image_registries.ts';
import { DEDALO_VERSION_TRIPLE } from '../../src/core/update/version.ts';
import { engineCliAt } from '../helpers/engine_cli_tree.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
// realpath: the script resolves its env file against the PHYSICAL cwd (/private/var on macOS).
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'dedalo-image-update-')));
let scratchCount = 0;

/**
 * The engine that PREDATES the identity walk, as its check-target contract
 * (the header): written once, run by the pinned bun like the real CLI.
 */
const OLD_ENGINE_CLI = join(SCRATCH, 'old_engine_check_target.ts');
writeFileSync(
	OLD_ENGINE_CLI,
	`import { compareVersionArrays, DEDALO_VERSION_TRIPLE } from ${JSON.stringify(join(REPO_ROOT, 'src', 'core', 'update', 'version.ts'))};
import { assertLinearUpgrade } from ${JSON.stringify(join(REPO_ROOT, 'src', 'core', 'update', 'version_walk.ts'))};
const match = /^(\\d{1,6})\\.(\\d{1,6})\\.(\\d{1,6})(-dev)?$/.exec(process.argv[3] ?? '');
if (process.argv[2] !== 'check-target' || match === null) {
	console.log('malformed_version');
	process.exit(3);
}
const triple = [Number(match[1]), Number(match[2]), Number(match[3])];
if (assertLinearUpgrade(DEDALO_VERSION_TRIPLE, triple, match[4] ? 'dev' : 'master') === null) process.exit(0);
console.log(compareVersionArrays(triple, DEDALO_VERSION_TRIPLE) === 1 ? 'version_skip' : 'downgrade_or_same_version');
process.exit(3);
`,
);

/** One engine tree per identity, shared by the cases (a copy of the engine sources each). */
const ENGINE_TREES = new Map<string, string>();
function engineCliOf(engine: string): string {
	if (engine === 'old') return OLD_ENGINE_CLI;
	let cli = ENGINE_TREES.get(engine);
	if (cli === undefined) {
		cli = engineCliAt(join(SCRATCH, `engine-${ENGINE_TREES.size}`), engine);
		ENGINE_TREES.set(engine, cli);
	}
	return cli;
}

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const REPO_DIGEST = `sha256:${'b'.repeat(64)}`;
const BACKUP = '/backups/db/pre-image-update_2026-10-09.dump';
const REQUEST_ID = '0b9d3c8e-7f6a-4d2b-9c1e-5a4b3c2d1e0f';

// ---------------------------------------------------------------------------
// The stubs.
// ---------------------------------------------------------------------------

/**
 * docker. Compose argv is `compose -f … [-f …] --env-file F <sub> …`; every call
 * is logged with the env file's DEDALO_VERSION AT THAT MOMENT, so the order of
 * re-pin and recreation is a fact the log holds.
 */
const DOCKER_STUB = `#!/bin/bash
S="$STUB_STATE"
log() { printf '%s\\n' "$*" >> "$S/calls.log"; }
last_arg() { local a=''; for a in "$@"; do :; done; printf '%s' "$a"; }
if [ "$1" = compose ]; then
	shift
	envf='' files=''
	while [ $# -gt 0 ]; do
		case "$1" in
			-f) files="$files $2"; shift 2 ;;
			--env-file) envf="$2"; shift 2 ;;
			*) break ;;
		esac
	done
	pinned="$(grep '^DEDALO_VERSION=' "$envf" | tail -n 1)"
	log "compose[$files ][env=$envf][$pinned] $*"
	sub="$1"; shift
	case "$sub" in
		ps)
			svc="$(last_arg "$@")"
			if [ -e "$S/running_$svc" ]; then echo "cid-$svc"; fi
			;;
		exec)
			[ "$1" = -T ] && shift
			svc="$1"
			if [ "$svc" = dedalo ]; then
				# check_code set: the contract stub. An engine named (engine_cli): that
				# REAL engine answers — its grammar and walk are what a stack meets. A
				# prerelease ask with none named is a stub failure. Otherwise: ok.
				tag="$(last_arg "$@")"
				if [ -e "$S/check_code" ]; then
					cat "$S/check_out" 2>/dev/null || true
					exit "$(cat "$S/check_code")"
				fi
				[ -e "$S/engine_cli" ] && exec "$ENGINE_BUN" "$(cat "$S/engine_cli")" check-target "$tag"
				case "$tag" in
					*-alpha.* | *-beta.* | *-rc.*) echo 'stub_names_no_engine'; exit 9 ;;
				esac
				exit 0
			fi
			[ -e "$S/backup_fail" ] && { echo 'dedalo-db-backup: pg_dump failed' >&2; exit 1; }
			echo "dedalo-db-backup: dumping 'dedalo' -> ${BACKUP}"
			echo "dedalo-db-backup: verified ${BACKUP} (4242 bytes)"
			;;
		up)
			n=$(( $(cat "$S/up_count" 2>/dev/null || echo 0) + 1 ))
			echo "$n" > "$S/up_count"
			[ -e "$S/up_fail" ] && exit 1
			;;
		build)
			log "build-env DEDALO_VERSION=\${DEDALO_VERSION-unset}"
			[ -e "$S/build_fail" ] && exit 1
			;;
	esac
	exit 0
fi
log "docker $*"
case "$1" in
	inspect)
		case "$3" in
			*Health*)
				# health_<n>: the states of the n-th recreation, one per probe, the last
				# repeating; restarts_<n>: its RestartCount (default 0).
				n="$(cat "$S/up_count" 2>/dev/null || echo 0)"
				k=$(( $(cat "$S/probe_$n" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$S/probe_$n"
				st="$(tr ' ' '\n' < "$S/health_$n" 2>/dev/null | grep -v '^$' | sed -n "\${k}p")"
				[ -n "$st" ] || st="$(tr ' ' '\n' < "$S/health_$n" 2>/dev/null | grep -v '^$' | tail -n 1)"
				printf '%s %s\n' "$(cat "$S/restarts_$n" 2>/dev/null || echo 0)" "\${st:-healthy}" ;;
			*Image*) echo "${IMAGE_ID}" ;;
		esac
		;;
	pull) [ -e "$S/pull_fail" ] && exit 1 ;;
	build)
		# the context the build READ, kept for the assertions (the builder removes its own)
		ctx="$(last_arg "$@")"
		rm -rf "$S/context_seen"; cp -R "$ctx" "$S/context_seen"
		[ -e "$S/build_fail" ] && exit 1 ;;
	image)
		case "$2" in
			inspect)
				ref="$(last_arg "$@")"
				case "$*" in
					*Labels*) cat "$S/label" 2>/dev/null || printf '%s\\n' "\${ref##*:}" ;;
					*) printf '%s@%s\\n' "\${ref%:*}" "${REPO_DIGEST}" ;;
				esac ;;
			ls) cat "$S/tags" 2>/dev/null || true ;;
		esac
		;;
esac
exit 0
`;

/**
 * git: a checkout of the release ref rewrites version.ts to $STUB_STATE/target_triple
 * and records the ref as HEAD; `describe --exact-match` answers the exact tag of
 * HEAD — the ref itself when it is a `v…` tag (unless $STUB_STATE/lightweight: then
 * no annotated tag, as git says), $STUB_STATE/describe when that file exists (empty
 * = untagged), else "no tag"; `archive` tars $STUB_STATE/commit (the "committed"
 * tree) to its -o file, with version.ts and an EXPANDED build_info.txt in it, as
 * export-subst writes it.
 */
const GIT_STUB = `#!/bin/bash
S="$STUB_STATE"
printf '%s\\n' "git $*" >> "$S/calls.log"
while [ "$1" = -c ] || [ "$1" = -C ]; do shift 2; done
write_version() {
	printf 'export const DEDALO_VERSION_TRIPLE = Object.freeze([\\n\\t%s,\\n]);\\n' "$(printf '%s' "$1" | sed 's/\\./, /g')" > src/core/update/version.ts
}
exact_tag() {
	if [ -e "$S/describe" ]; then cat "$S/describe"; return 0; fi
	h="$(cat "$S/head_ref" 2>/dev/null || true)"
	case "$h" in v[0-9]*) [ -e "$S/lightweight" ] || printf '%s' "$h" ;; esac
}
case "$1" in
	describe)
		tag="$(exact_tag)"
		[ -n "$tag" ] && { echo "$tag"; exit 0; }
		echo "fatal: no tag exactly matches 'abc1234def'" >&2
		exit 128
		;;
	status) cat "$S/git_dirty" 2>/dev/null || true ;;
	rev-parse) echo prevsha0000 ;;
	symbolic-ref) echo master ;;
	fetch) exit 0 ;;
	archive)
		out=''
		while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
		mkdir -p "$S/commit/src/core/update"
		cp src/core/update/version.ts "$S/commit/src/core/update/version.ts"
		printf 'abc1234def 2026-10-15T00:00:00Z %s\\n' "$(exact_tag)" > "$S/commit/src/core/update/build_info.txt"
		tar -cf "$out" -C "$S/commit" .
		;;
	remote) cat "$S/git_remotes" 2>/dev/null || echo origin ;;
	checkout)
		for ref in "$@"; do :; done
		printf '%s' "$ref" > "$S/head_ref"
		if [ "$ref" = master ] || [ "$ref" = prevsha0000 ]; then write_version "$(cat "$S/orig_triple")"; exit 0; fi
		[ -e "$S/checkout_fail" ] && exit 1
		write_version "$(cat "$S/target_triple")"
		;;
esac
exit 0
`;

const COSIGN_STUB = `#!/bin/bash
printf '%s\\n' "cosign $*" >> "$STUB_STATE/calls.log"
exit "$(cat "$STUB_STATE/cosign_code" 2>/dev/null || echo 0)"
`;

const SLEEP_STUB = '#!/bin/sh\nexit 0\n';

// ---------------------------------------------------------------------------
// The scratch stack.
// ---------------------------------------------------------------------------

interface Situation {
	mode?: 'pull' | 'build';
	verify?: 'cosign' | 'none';
	image?: string;
	pinned?: string;
	/** Files created in the stub state dir (flags), with optional content. */
	state?: Record<string, string>;
	/** Replace the whole .dedalo.env. */
	envText?: string;
	cosign?: boolean;
	/** No `.git` in the stack directory (a release tree). */
	noGit?: boolean;
	/** The REAL engine that answers check-target: a release identity, or 'old' (see the header). */
	engine?: string;
}

interface Stack {
	dir: string;
	state: string;
	envFile: string;
	envBefore: string;
}

/** The data version (X.Y.Z) an image tag names. */
function tripleOf(tag: string): string {
	return (tag.match(/^\d+\.\d+\.\d+/) as RegExpMatchArray)[0];
}

function makeStack(situation: Situation = {}): Stack {
	scratchCount += 1;
	const root = join(SCRATCH, `case-${scratchCount}`);
	const dir = join(root, 'stack');
	const state = join(root, 'state');
	const bin = join(root, 'bin');
	for (const path of [join(dir, 'deploy'), join(dir, 'src', 'core', 'update'), state, bin]) {
		mkdirSync(path, { recursive: true });
	}
	for (const file of [
		'dedalo-image-update.sh',
		'dedalo-image-lib.sh',
		'image_registries.sh',
		'compose.build.yml',
	]) {
		copyFileSync(join(REPO_ROOT, 'deploy', file), join(dir, 'deploy', file));
	}
	writeFileSync(join(dir, 'docker-compose.simple.yml'), 'services: {}\n');
	if (situation.noGit !== true) mkdirSync(join(dir, '.git'));
	mkdirSync(join(state, 'commit'));
	writeFileSync(join(state, 'commit', 'committed.txt'), 'in the last commit\n');
	const pinned = situation.pinned ?? '7.0.0';
	writeFileSync(
		join(dir, 'src', 'core', 'update', 'version.ts'),
		`export const T = Object.freeze([${tripleOf(pinned).split('.').join(', ')}]);\n`,
	);
	const envText =
		situation.envText ??
		[
			'# Written by install.sh — compose variable substitution only.',
			'POSTGRES_DB=dedalo',
			'POSTGRES_PASSWORD=s3cret$with"odd',
			'DEDALO_NGINX_CONF=nginx.simple.conf',
			'SESSION_COOKIE_SECURE=false',
			'COMPOSE_PROFILES=',
			'DEDALO_COMPOSE_FILE=docker-compose.simple.yml',
			`DEDALO_IMAGE=${situation.image ?? 'ghcr.io/dedalia-org/dedalo'}`,
			`DEDALO_VERSION=${pinned}`,
			`DEDALO_IMAGE_MODE=${situation.mode ?? 'pull'}`,
			`DEDALO_IMAGE_VERIFY=${situation.verify ?? 'none'}`,
			'',
		].join('\n');
	const envFile = join(dir, '.dedalo.env');
	writeFileSync(envFile, envText, { mode: 0o600 });
	const stubs: Record<string, string> = { docker: DOCKER_STUB, git: GIT_STUB, sleep: SLEEP_STUB };
	if (situation.cosign !== false) stubs.cosign = COSIGN_STUB;
	for (const [name, body] of Object.entries(stubs)) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	const flags: Record<string, string> = {
		running_dedalo: '',
		running_backup: '',
		orig_triple: tripleOf(pinned),
		tags: 'rollback-20260101T000000Z\n7.0.0\nrollback-20261001T000000Z\n',
		...(situation.engine === undefined ? {} : { engine_cli: engineCliOf(situation.engine) }),
		...situation.state,
	};
	for (const [name, content] of Object.entries(flags)) writeFileSync(join(state, name), content);
	return { dir, state, envFile, envBefore: envText };
}

/** Run git in `cwd` (identity and config isolated from the host's). */
function git(cwd: string, ...args: string[]): void {
	const run = Bun.spawnSync(
		['git', '-c', 'user.name=gate', '-c', 'user.email=gate@example.org', ...args],
		{ cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } },
	);
	if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
}

/**
 * A build-mode stack that is a REAL git repository (git is NOT stubbed): master
 * at 7.0.0, the ANNOTATED tag v7.0.1 one commit ahead (release tags are annotated),
 * the repo's REAL build_info.txt placeholder, export-subst as in the repo; then what a live checkout holds and no commit does — an untracked
 * file at the root, one nested in the code tree, and .dedalo.env itself.
 */
function realGitStack(): Stack {
	const stack = makeStack({ mode: 'build', image: 'localhost/dedalo' });
	rmSync(join(stack.state, '..', 'bin', 'git'));
	rmSync(join(stack.dir, '.git'), { recursive: true });
	const { dir } = stack;
	writeFileSync(join(dir, BUILD_INFO_PATH), readFileSync(join(REPO_ROOT, BUILD_INFO_PATH)));
	writeFileSync(
		join(dir, '.gitattributes'),
		readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8')
			.split('\n')
			.filter((line) => line.includes('build_info.txt export-subst'))
			.join('\n'),
	);
	writeFileSync(join(dir, '.gitignore'), '/.dedalo-install/\n');
	git(dir, 'init', '-q', '-b', 'master');
	git(dir, 'add', '-A', '.', ':!.dedalo.env');
	git(dir, 'commit', '-q', '-m', '7.0.0');
	git(dir, 'checkout', '-q', '--detach');
	writeFileSync(
		join(dir, 'src', 'core', 'update', 'version.ts'),
		'export const T = Object.freeze([7, 0, 1]);\n',
	);
	git(dir, 'commit', '-q', '-am', '7.0.1');
	git(dir, 'tag', '-a', 'v7.0.1', '-m', 'release 7.0.1');
	git(dir, 'checkout', '-q', 'master');
	writeFileSync(join(dir, 'stray_untracked.txt'), 'never committed\n');
	writeFileSync(join(dir, 'src', 'core', 'stray_untracked.ts'), 'export const stray = 1;\n');
	return stack;
}

interface Result {
	code: number;
	stderr: string;
	calls: string[];
	outcome: Record<string, unknown> | null;
	env: string;
}

function runUpdate(stack: Stack, args: string[]): Result {
	const outcomeFile = join(stack.state, 'outcome.json');
	const run = Bun.spawnSync(
		[
			'bash',
			join(stack.dir, 'deploy', 'dedalo-image-update.sh'),
			...args,
			'--outcome-file',
			outcomeFile,
		],
		{
			cwd: stack.dir,
			env: {
				PATH: `${join(stack.state, '..', 'bin')}:/usr/bin:/bin`,
				STUB_STATE: stack.state,
				ENGINE_BUN: process.execPath,
			},
		},
	);
	const calls = existsSync(join(stack.state, 'calls.log'))
		? readFileSync(join(stack.state, 'calls.log'), 'utf8').split('\n').filter(Boolean)
		: [];
	return {
		code: run.exitCode ?? -1,
		stderr: new TextDecoder().decode(run.stderr),
		calls,
		outcome: existsSync(outcomeFile) ? JSON.parse(readFileSync(outcomeFile, 'utf8')) : null,
		env: readFileSync(stack.envFile, 'utf8'),
	};
}

/** The env file with DEDALO_VERSION replaced — what a correct re-pin leaves. */
function repinned(stack: Stack, version: string): string {
	return stack.envBefore.replace(/^DEDALO_VERSION=.*$/m, `DEDALO_VERSION=${version}`);
}

/** Index of the first call matching `pattern`; -1 when absent. */
function at(calls: string[], pattern: RegExp): number {
	return calls.findIndex((line) => pattern.test(line));
}

// ---------------------------------------------------------------------------
// The outcome contract (design 5.4).
// ---------------------------------------------------------------------------

const OUTCOME_KEYS = [
	'schema',
	'request_id',
	'from',
	'to',
	'mode',
	'image',
	'status',
	'detail',
	'backup',
	'digest',
	'started_at',
	'finished_at',
].sort();
const STATUSES = ['green', 'rolled_back', 'rollback_failed', 'refused', 'failed'];
const DETAILS = [
	'healthy',
	'health_timeout',
	'unhealthy',
	'pull_failed',
	'verify_failed',
	'build_failed',
	'backup_failed',
	'version_refused',
	'downgrade_refused',
	'not_running',
	'env_incomplete',
	'locked',
	'interrupted',
	'malformed_request',
];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VERSION = /^\d+\.\d+\.\d+(-dev|-(alpha|beta|rc)\.\d+)?$/;

/** Every violation of the 5.4 shape in `outcome`, as words. */
function outcomeViolations(outcome: Record<string, unknown> | null): string[] {
	if (outcome === null) return ['no outcome written'];
	const problems: string[] = [];
	const keys = Object.keys(outcome).sort();
	if (JSON.stringify(keys) !== JSON.stringify(OUTCOME_KEYS))
		problems.push(`keys ${keys.join(',')}`);
	const checks: [string, boolean][] = [
		['schema', outcome.schema === 1],
		[
			'request_id',
			outcome.request_id === null || /^[0-9a-f-]{36}$/.test(String(outcome.request_id)),
		],
		['from', outcome.from === '' || VERSION.test(String(outcome.from))],
		['to', outcome.to === '' || VERSION.test(String(outcome.to))],
		['mode', outcome.mode === null || outcome.mode === 'pull' || outcome.mode === 'build'],
		['image', typeof outcome.image === 'string'],
		['status', STATUSES.includes(String(outcome.status))],
		['detail', DETAILS.includes(String(outcome.detail))],
		['backup', outcome.backup === null || /^\/[\w./+:-]+$/.test(String(outcome.backup))],
		['digest', outcome.digest === null || /^sha256:[0-9a-f]{64}$/.test(String(outcome.digest))],
		['started_at', ISO.test(String(outcome.started_at))],
		['finished_at', ISO.test(String(outcome.finished_at))],
	];
	for (const [key, ok] of checks) if (!ok) problems.push(`${key}=${JSON.stringify(outcome[key])}`);
	return problems;
}

/** Postgres and nginx are never named by any compose call; every call carries the env file. */
function expectStackHygiene(stack: Stack, result: Result): void {
	const compose = result.calls.filter((line) => line.startsWith('compose['));
	for (const line of compose) {
		expect(line, 'a compose call named postgres or nginx').not.toMatch(/\b(postgres|nginx)\b/);
		expect(line).toContain(`[env=${stack.envFile}]`);
		expect(line).toContain('docker-compose.simple.yml');
	}
	expect(outcomeViolations(result.outcome)).toEqual([]);
}

// ---------------------------------------------------------------------------
// The cases.
// ---------------------------------------------------------------------------

describe('pull mode', () => {
	test('green: check → backup → anchor → pull → re-pin → up; the env keeps every other line', () => {
		const stack = makeStack();
		const result = runUpdate(stack, ['--version', '7.0.1', '--request-id', REQUEST_ID]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.env).toBe(repinned(stack, '7.0.1'));
		expect(result.outcome).toMatchObject({
			request_id: REQUEST_ID,
			from: '7.0.0',
			to: '7.0.1',
			mode: 'pull',
			image: 'ghcr.io/dedalia-org/dedalo',
			status: 'green',
			detail: 'healthy',
			backup: BACKUP,
			digest: REPO_DIGEST,
		});
		const order = [
			at(
				result.calls,
				/exec -T dedalo bun scripts\/ops\/image_update_channel\.ts check-target 7\.0\.1$/,
			),
			at(
				result.calls,
				/exec -T backup \/opt\/dedalo\/master_dedalo\/deploy\/dedalo-db-backup\.sh --label pre-image-update/,
			),
			at(
				result.calls,
				new RegExp(`^docker tag ${IMAGE_ID} ghcr\\.io/dedalia-org/dedalo:rollback-\\d{8}T\\d{6}Z$`),
			),
			at(result.calls, /^docker pull ghcr\.io\/dedalia-org\/dedalo:7\.0\.1$/),
			at(result.calls, /\[DEDALO_VERSION=7\.0\.1\] up -d dedalo backup$/),
		];
		expect(
			order.every((index) => index >= 0),
			result.calls.join('\n'),
		).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// Nothing was recreated BEFORE the re-pin.
		expect(at(result.calls, /\[DEDALO_VERSION=7\.0\.0\] up /)).toBe(-1);
		// Only the newest rollback tag survives.
		expect(result.calls).toContain(
			'docker rmi ghcr.io/dedalia-org/dedalo:rollback-20260101T000000Z',
		);
		expect(result.calls).toContain(
			'docker rmi ghcr.io/dedalia-org/dedalo:rollback-20261001T000000Z',
		);
		expect(result.calls.filter((line) => line.startsWith('docker rmi')).length).toBe(2);
		expect(result.calls.some((line) => line.startsWith('cosign'))).toBe(false);
		expectStackHygiene(stack, result);
	});

	test('DEDALO_IMAGE_VERIFY=cosign: the pulled DIGEST is verified with the official identity', () => {
		const stack = makeStack({ verify: 'cosign' });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.code, result.stderr).toBe(0);
		const list = loadImageRegistries();
		expect(result.calls).toContain(
			`cosign verify --certificate-identity-regexp ${list.signing.identity_regexp} --certificate-oidc-issuer ${list.signing.issuer} ghcr.io/dedalia-org/dedalo@${REPO_DIGEST}`,
		);
		expect(at(result.calls, /^cosign verify/)).toBeLessThan(
			at(result.calls, / up -d dedalo backup$/),
		);
		expectStackHygiene(stack, result);
	});

	test('a SIGNED image declaring another version (a re-pointed mirror tag): verify_failed, nothing changed', () => {
		// The genuinely signed 7.0.0 published under :7.0.1 would walk the install
		// backwards past the version floor; the signed label is what binds the tag.
		const stack = makeStack({ verify: 'cosign', state: { label: '7.0.0' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.code).toBe(1);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'verify_failed' });
		expect(result.calls).toContain(
			'docker image inspect --format {{index .Config.Labels "org.opencontainers.image.version"}} ghcr.io/dedalia-org/dedalo:7.0.1',
		);
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, / up /)).toBe(-1);
		expectStackHygiene(stack, result);
	});

	test('a signature that does not verify: failed/verify_failed, nothing re-pinned or recreated', () => {
		const stack = makeStack({ verify: 'cosign', state: { cosign_code: '1' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.code).toBe(1);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'verify_failed' });
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, / up /)).toBe(-1);
		expectStackHygiene(stack, result);
	});

	test('cosign required but not installed: refused at verification, nothing recreated', () => {
		const stack = makeStack({ verify: 'cosign', cosign: false });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'verify_failed' });
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, / up /)).toBe(-1);
	});

	test('a failed pull: failed/pull_failed, the stack untouched', () => {
		const stack = makeStack({ state: { pull_fail: '' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'pull_failed' });
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, / up /)).toBe(-1);
		expectStackHygiene(stack, result);
	});
});

describe('build mode', () => {
	test('green: the release tag is checked out, then built from a SNAPSHOT of it by the shared builder, as that version', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.code, result.stderr).toBe(0);
		const checkout = at(result.calls, /^git checkout -q --detach v7\.0\.1$/);
		const archive = at(result.calls, / archive --format=tar -o .* HEAD$/);
		const context = join(stack.dir, BUILD_CONTEXT);
		const build = result.calls.findIndex((call) => isBuildOf(call, '7.0.1', context));
		expect(checkout).toBeGreaterThan(-1);
		expect(archive).toBeGreaterThan(checkout);
		expect(build, result.calls.join('\n')).toBeGreaterThan(archive);
		// never the checkout through the override
		expect(at(result.calls, / build dedalo$/)).toBe(-1);
		// the build read the snapshot, which is gone afterwards
		expect(existsSync(join(stack.state, 'context_seen', 'committed.txt'))).toBe(true);
		expect(existsSync(context)).toBe(false);
		expect(existsSync(`${context}.tar`)).toBe(false);
		expect(at(result.calls, /^docker pull/)).toBe(-1);
		expect(result.env).toBe(repinned(stack, '7.0.1'));
		expect(result.outcome).toMatchObject({
			mode: 'build',
			status: 'green',
			digest: null,
			image: 'localhost/dedalo',
		});
		expectStackHygiene(stack, result);
	});

	test('the checked-out tree declares another version: refused, the checkout restored, nothing built', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.9' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.calls).toContain('git checkout -q master');
		expect(at(result.calls, /^docker build /)).toBe(-1);
		expect(result.env).toBe(stack.envBefore);
	});

	test('a -dev build whose commit declares ANOTHER data version: refused (with and without --ref), the checkout restored, nothing built', () => {
		// 7.0.2's migrations must never run under a 7.0.1-dev pin
		for (const ref of [[], ['--ref', 'feature/x']]) {
			const stack = makeStack({
				mode: 'build',
				image: 'localhost/dedalo',
				state: { target_triple: '7.0.2' },
			});
			const result = runUpdate(stack, ['--version', '7.0.1-dev', ...ref]);
			expect({ ref, detail: result.outcome?.detail }).toEqual({ ref, detail: 'version_refused' });
			expect(result.stderr).toContain('is 7.0.2.dev, not 7.0.1-dev');
			expect(at(result.calls, /^docker build /)).toBe(-1);
			expect(result.calls.at(-1)).toBe('git checkout -q master');
			expect(result.env).toBe(stack.envBefore);
		}
	});

	test('a failed build: failed/build_failed, the checkout restored', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1', build_fail: '' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'build_failed' });
		expect(result.calls.at(-1)).toBe('git checkout -q master');
		expect(result.env).toBe(stack.envBefore);
		// a red build removes its snapshot too
		expect(existsSync(join(stack.dir, BUILD_CONTEXT))).toBe(false);
	});

	test('not a git checkout (a release tree): refused with the sentence, nothing fetched, checked out or built', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			noGit: true,
			state: { target_triple: '7.0.1' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'build_failed' });
		expect(result.stderr).toContain(`${stack.dir} is not a git checkout`);
		expect(result.stderr).toContain('DEDALO_IMAGE_MODE=pull');
		expect(result.calls.filter((line) => line.startsWith('git '))).toEqual([]);
		expect(at(result.calls, /^docker build /)).toBe(-1);
		expect(result.env).toBe(stack.envBefore);
	});

	test('OUTCOME over a REAL git checkout: no uncommitted or untracked file in the build context, build_info expanded (no .dev)', async () => {
		const stack = realGitStack();
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.outcome).toMatchObject({ status: 'green', mode: 'build' });
		const context = join(stack.dir, BUILD_CONTEXT);
		expect(result.calls.filter((call) => isBuildOf(call, '7.0.1', context))).toHaveLength(1);
		const seen = join(stack.state, 'context_seen');
		// the release commit, as committed
		expect(readFileSync(join(seen, 'src', 'core', 'update', 'version.ts'), 'utf8')).toContain(
			'7, 0, 1',
		);
		// what the working tree holds and the commit does not never travels
		for (const stray of ['stray_untracked.txt', 'src/core/stray_untracked.ts', '.dedalo.env']) {
			expect(existsSync(join(stack.dir, stray)), `${stray} is in the checkout`).toBe(true);
			expect(existsSync(join(seen, stray)), `${stray} reached the build context`).toBe(false);
		}
		// export-subst expanded: the image calls itself by the tag it was built from
		expect(await readReleaseIdentityOf(seen, { triple: [7, 0, 1] })).toMatchObject({
			version: '7.0.1',
			kind: 'stable',
			tag: 'v7.0.1',
		});
		// the working tree is the untagged 7.0.0 commit: it would call itself .dev
		expect((await readReleaseIdentityOf(stack.dir, { triple: [7, 0, 0] })).version).toBe(
			'7.0.0.dev',
		);
		expect(existsSync(context)).toBe(false);
	});

	test('a REAL checkout with a dirty tracked file: refused before the checkout moves (the build never sees it)', () => {
		const stack = realGitStack();
		writeFileSync(join(stack.dir, 'docker-compose.simple.yml'), 'services: {} # local edit\n');
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'build_failed' });
		expect(result.stderr).toContain('local changes to tracked files');
		expect(at(result.calls, /^docker build /)).toBe(-1);
	});

	test('local changes to tracked files: refused before anything is checked out', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { git_dirty: ' M install.sh\n' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'build_failed' });
		expect(at(result.calls, /^git checkout/)).toBe(-1);
	});

	test("a developer build: the single remote's master, or --ref; --ref is refused for a release", () => {
		const dev = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1' },
		});
		expect(runUpdate(dev, ['--version', '7.0.1-dev']).calls).toContain(
			'git checkout -q --detach origin/master',
		);
		const ref = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1' },
		});
		expect(runUpdate(ref, ['--version', '7.0.1-dev', '--ref', 'feature/x']).calls).toContain(
			'git checkout -q --detach feature/x',
		);
		const two = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1', git_remotes: 'origin\nupstream\n' },
		});
		expect(runUpdate(two, ['--version', '7.0.1-dev']).outcome).toMatchObject({
			status: 'refused',
			detail: 'version_refused',
		});
		const release = makeStack({ mode: 'build', image: 'localhost/dedalo' });
		expect(runUpdate(release, ['--version', '7.0.1', '--ref', 'feature/x']).outcome).toMatchObject({
			status: 'refused',
			detail: 'version_refused',
		});
		const pull = makeStack();
		expect(runUpdate(pull, ['--version', '7.0.1-dev', '--ref', 'feature/x']).outcome).toMatchObject(
			{
				status: 'refused',
			},
		);
	});
});

// The real engine of this checkout walks from its own data version, so the
// prerelease cases name theirs from it: T is what the running engine is at.
const T = DEDALO_VERSION_TRIPLE.join('.');
const T_NEXT = [
	DEDALO_VERSION_TRIPLE[0],
	DEDALO_VERSION_TRIPLE[1],
	DEDALO_VERSION_TRIPLE[2] + 1,
].join('.');
const T_SKIP = [
	DEDALO_VERSION_TRIPLE[0],
	DEDALO_VERSION_TRIPLE[1],
	DEDALO_VERSION_TRIPLE[2] + 2,
].join('.');

/** The check-target asks the run made, in order. */
function engineAsks(calls: string[]): string[] {
	return calls
		.map((line) =>
			/ exec -T dedalo bun scripts\/ops\/image_update_channel\.ts check-target (\S+)$/.exec(line),
		)
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => match[1] as string);
}

describe('prereleases against an engine that PREDATES the identity walk (design step 6, owner Q3/Q4): the host re-asks the data walk', () => {
	test('the emulated old engine is that engine: a prerelease is malformed_version, its data walk answers (control)', () => {
		const ask = (tag: string) => {
			const run = Bun.spawnSync([process.execPath, OLD_ENGINE_CLI, 'check-target', tag]);
			return { out: run.stdout.toString().trim(), code: run.exitCode };
		};
		expect(ask(`${T}-beta.7`)).toEqual({ out: 'malformed_version', code: 3 });
		expect(ask(`${T}-dev`)).toEqual({ out: '', code: 0 });
		expect(ask(T)).toEqual({ out: 'downgrade_or_same_version', code: 3 });
		expect(ask(`${T_SKIP}-dev`)).toEqual({ out: 'version_skip', code: 3 });
	});

	test('pull: beta.6 → beta.7 moves forward; the engine is asked the DATA walk (X.Y.Z-dev) and agrees — no flag needed', () => {
		const stack = makeStack({ pinned: `${T}-beta.6`, engine: 'old' });
		const result = runUpdate(stack, ['--version', `${T}-beta.7`]);
		expect(result.code, result.stderr).toBe(0);
		expect(engineAsks(result.calls)).toEqual([`${T}-beta.7`, `${T}-dev`]);
		expect(result.stderr).toContain('does not know prerelease versions');
		expect(result.calls).toContain(`docker pull ghcr.io/dedalia-org/dedalo:${T}-beta.7`);
		expect(result.env).toBe(repinned(stack, `${T}-beta.7`));
		expect(result.outcome).toMatchObject({
			from: `${T}-beta.6`,
			to: `${T}-beta.7`,
			status: 'green',
		});
		expectStackHygiene(stack, result);
	});

	test('the data walk of a prerelease of ANOTHER X.Y.Z: the next rung is legal, a rung skip is the engine refusal no flag waives', () => {
		const next = makeStack({ pinned: T, engine: 'old' });
		const green = runUpdate(next, ['--version', `${T_NEXT}-beta.1`]);
		expect(green.code, green.stderr).toBe(0);
		expect(engineAsks(green.calls)).toEqual([`${T_NEXT}-beta.1`, `${T_NEXT}-dev`]);
		for (const flags of [[], ['--skip-version-check']]) {
			const skip = makeStack({ pinned: T, engine: 'old' });
			const refused = runUpdate(skip, ['--version', `${T_SKIP}-beta.1`, ...flags]);
			expect({ flags, detail: refused.outcome?.detail }).toEqual({
				flags,
				detail: 'version_refused',
			});
			expect(refused.stderr).toContain(`the engine refuses ${T_SKIP}-dev: version_skip`);
			expect(refused.env).toBe(skip.envBefore);
			expect(at(refused.calls, /^docker (tag|pull)|exec -T backup| up /)).toBe(-1);
		}
	});

	test('order: rc.1 → X.Y.Z forward (the engine, seeing X.Y.Z → X.Y.Z, is asked the data walk); beta.7 → beta.6 and X.Y.Z → rc.1 are steps back', () => {
		const forward = runUpdate(makeStack({ pinned: `${T}-rc.1`, engine: 'old' }), ['--version', T]);
		expect(forward.code, forward.stderr).toBe(0);
		expect(engineAsks(forward.calls)).toEqual([T, `${T}-dev`]);
		for (const [pinned, target] of [
			[`${T}-beta.7`, `${T}-beta.6`],
			[`${T}-rc.1`, `${T}-beta.10`],
			[T, `${T}-rc.1`],
		] as const) {
			const stack = makeStack({ pinned, engine: 'old' });
			const result = runUpdate(stack, ['--version', target]);
			expect({ pinned, target, detail: result.outcome?.detail }).toEqual({
				pinned,
				target,
				detail: 'downgrade_refused',
			});
			expect(result.env).toBe(stack.envBefore);
		}
	});

	test('the same X.Y.Z re-installed from a RELEASE pin is not blind: the engine refusal stands', () => {
		// A bare pin is not a prerelease, so X.Y.Z → X.Y.Z (waived at step 3) is
		// still the engine's downgrade_or_same_version — no data-walk re-ask.
		const stack = makeStack({ pinned: T, engine: 'old' });
		const result = runUpdate(stack, ['--version', T, '--skip-version-check']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(engineAsks(result.calls)).toEqual([T]);
	});

	test('Q4: a bare X.Y.Z pin (a beta BUILT before beta.7) → X.Y.Z-beta.7 is refused, the refusal names --skip-version-check and why; with it, the REAL engine lets it through', () => {
		const stack = makeStack({ pinned: T, engine: 'old' });
		const result = runUpdate(stack, ['--version', `${T}-beta.7`]);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'downgrade_refused' });
		expect(result.stderr).toContain('--skip-version-check');
		expect(result.stderr).toContain('built from a beta before 7.0.0-beta.7');
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, /^docker (tag|pull)|exec -T backup| up /)).toBe(-1);
		// …and the flag waives it ONCE, within the same data version — the documented
		// command (docs/install/docker.md) green end to end
		const waived = makeStack({ pinned: T, engine: 'old' });
		const green = runUpdate(waived, ['--version', `${T}-beta.7`, '--skip-version-check']);
		expect(green.code, green.stderr).toBe(0);
		expect(engineAsks(green.calls)).toEqual([`${T}-beta.7`, `${T}-dev`]);
		expect(green.env).toBe(repinned(waived, `${T}-beta.7`));
		expect(green.stderr).toContain(`waived (--skip-version-check: same data version ${T}`);
	});

	test('Q4: the flag never waives a step back to an OLDER data version (its migrations ran)', () => {
		for (const [pinned, target] of [
			['7.0.1', '7.0.0-beta.7'],
			['7.0.1-beta.1', '7.0.0'],
			['7.0.1', '6.9.9'],
		] as const) {
			const stack = makeStack({ pinned });
			const result = runUpdate(stack, ['--version', target, '--skip-version-check']);
			expect({ pinned, target, detail: result.outcome?.detail }).toEqual({
				pinned,
				target,
				detail: 'downgrade_refused',
			});
			expect(result.stderr).not.toContain('re-run ONCE');
			expect(result.env).toBe(stack.envBefore);
		}
	});
});

describe('prereleases against the CURRENT engine: the identity walk answers directly, no re-ask (design step 9c)', () => {
	test('the current engine reads a prerelease tag and walks it from what it calls itself — the premise the re-ask no longer needs', () => {
		const ask = (engine: string, tag: string) => {
			const run = Bun.spawnSync([process.execPath, engineCliOf(engine), 'check-target', tag]);
			return { out: run.stdout.toString().trim(), code: run.exitCode };
		};
		expect(ask(`${T}-beta.6`, `${T}-beta.7`)).toEqual({ out: '', code: 0 });
		expect(ask(`${T}-rc.1`, T)).toEqual({ out: '', code: 0 });
		expect(ask(`${T}-beta.7`, `${T}-beta.6`)).toEqual({ out: 'not_newer_release', code: 3 });
		expect(ask(T, `${T}-rc.1`)).toEqual({ out: 'not_newer_release', code: 3 });
		expect(ask(T, `${T_NEXT}-beta.1`)).toEqual({ out: '', code: 0 });
		expect(ask(T, `${T_SKIP}-beta.1`)).toEqual({ out: 'version_skip', code: 3 });
	});

	test('pull: beta.6 → beta.7 and rc.1 → X.Y.Z are asked ONCE, as themselves', () => {
		for (const [pinned, target] of [
			[`${T}-beta.6`, `${T}-beta.7`],
			[`${T}-rc.1`, T],
		] as const) {
			const stack = makeStack({ pinned, engine: pinned });
			const result = runUpdate(stack, ['--version', target]);
			expect(result.code, result.stderr).toBe(0);
			expect(engineAsks(result.calls)).toEqual([target]);
			expect(result.stderr).not.toContain('does not know prerelease versions');
			expect(result.env).toBe(repinned(stack, target));
			expectStackHygiene(stack, result);
		}
	});

	test('an INFORMED refusal is never re-asked away: the engine runs a newer beta than the pin says', () => {
		// the pin says beta.6 (step 3 lets beta.7 through), the image calls itself
		// beta.8: the engine's not_newer_release stands — the old engine's blind
		// downgrade_or_same_version is the only refusal the host re-asks
		const stack = makeStack({ pinned: `${T}-beta.6`, engine: `${T}-beta.8` });
		const result = runUpdate(stack, ['--version', `${T}-beta.7`, '--skip-version-check']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.stderr).toContain(`the engine refuses ${T}-beta.7: not_newer_release`);
		expect(engineAsks(result.calls)).toEqual([`${T}-beta.7`]);
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, /^docker (tag|pull)|exec -T backup| up /)).toBe(-1);
	});

	test('a rung skip to a prerelease is the engine refusal, asked once', () => {
		const stack = makeStack({ pinned: T, engine: T });
		const result = runUpdate(stack, ['--version', `${T_SKIP}-beta.1`, '--skip-version-check']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.stderr).toContain(`the engine refuses ${T_SKIP}-beta.1: version_skip`);
		expect(engineAsks(result.calls)).toEqual([`${T_SKIP}-beta.1`]);
	});

	test('build: the prerelease TAG is checked out and built, labelled with its identity', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			pinned: `${T}-beta.6`,
			state: { target_triple: T },
			engine: `${T}-beta.6`,
		});
		const result = runUpdate(stack, ['--version', `${T}-beta.7`]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.calls).toContain(`git checkout -q --detach v${T}-beta.7`);
		const context = join(stack.dir, BUILD_CONTEXT);
		expect(result.calls.filter((call) => isBuildOf(call, `${T}-beta.7`, context))).toHaveLength(1);
		expect(result.env).toBe(repinned(stack, `${T}-beta.7`));
	});

	test('build, --ref (Q3): a prerelease may be named by another ref — when that commit IS the prerelease', () => {
		const named = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			pinned: `${T}-beta.6`,
			state: { target_triple: T, describe: `v${T}-beta.7` },
			engine: `${T}-beta.6`,
		});
		const green = runUpdate(named, ['--version', `${T}-beta.7`, '--ref', 'release/beta-7']);
		expect(green.code, green.stderr).toBe(0);
		expect(green.calls).toContain('git checkout -q --detach release/beta-7');
		// a ref at ANOTHER release: refused before anything is built, the checkout restored
		const other = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			pinned: `${T}-beta.6`,
			state: { target_triple: T, describe: `v${T}-beta.6` },
			engine: `${T}-beta.6`,
		});
		const refused = runUpdate(other, ['--version', `${T}-beta.7`, '--ref', 'release/beta-6']);
		expect(refused.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(refused.stderr).toContain(`release/beta-6 is ${T}-beta.6, not ${T}-beta.7`);
		expect(at(refused.calls, /^docker build /)).toBe(-1);
		expect(refused.calls.at(-1)).toBe('git checkout -q master');
		expect(refused.env).toBe(other.envBefore);
	});

	test('build: a LIGHTWEIGHT prerelease tag is no release (the image would call itself X.Y.Z.dev): refused, nothing built', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			pinned: `${T}-beta.6`,
			state: { target_triple: T, lightweight: '' },
			engine: `${T}-beta.6`,
		});
		const result = runUpdate(stack, ['--version', `${T}-beta.7`]);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.stderr).toContain(`v${T}-beta.7 is ${T}.dev, not ${T}-beta.7`);
		expect(at(result.calls, /^docker build /)).toBe(-1);
		expect(result.env).toBe(stack.envBefore);
	});

	test('build, REAL git: a lightweight v7.0.1 (the annotated one deleted) is refused; the annotated one builds', () => {
		const stack = realGitStack();
		git(stack.dir, 'tag', '-d', 'v7.0.1');
		git(stack.dir, 'tag', 'v7.0.1', 'HEAD@{1}');
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.stderr).toContain('v7.0.1 is 7.0.1.dev, not 7.0.1');
		expect(at(result.calls, /^docker build /)).toBe(-1);
	});
});

describe('red → rollback', () => {
	test('unhealthy: the rollback image is re-tagged as the old version, re-pinned, recreated without building', () => {
		// Unhealthy until the deadline (a short one: unhealthy is waited through).
		const stack = makeStack({ state: { health_1: 'unhealthy' } });
		const result = runUpdate(stack, ['--version', '7.0.1', '--health-timeout', '10']);
		expect(result.code).toBe(1);
		expect(result.outcome).toMatchObject({
			status: 'rolled_back',
			detail: 'unhealthy',
			backup: BACKUP,
		});
		const anchor = result.calls.find((line) => /^docker tag sha256:/.test(line)) as string;
		const rollbackRef = anchor.split(' ')[3] as string;
		expect(rollbackRef).toMatch(/^ghcr\.io\/dedalia-org\/dedalo:rollback-\d{8}T\d{6}Z$/);
		const retag = at(
			result.calls,
			new RegExp(
				`^docker tag ${escapeRegExp(rollbackRef)} ghcr\\.io/dedalia-org/dedalo:7\\.0\\.0$`,
			),
		);
		const back = at(result.calls, /\[DEDALO_VERSION=7\.0\.0\] up -d --no-build dedalo backup$/);
		expect(retag).toBeGreaterThan(-1);
		expect(back).toBeGreaterThan(retag);
		expect(result.env).toBe(stack.envBefore);
		// A failed update keeps every rollback tag.
		expect(result.calls.some((line) => line.startsWith('docker rmi'))).toBe(false);
		expectStackHygiene(stack, result);
	});

	test('`unhealthy` during a long boot migration is NOT red: it waits, and green on the first healthy probe', () => {
		// Docker reports unhealthy ~2 min in while migrations run before the socket binds;
		// the documented --health-timeout, not that flip, is the budget.
		const stack = makeStack({
			state: { health_1: 'starting unhealthy unhealthy unhealthy unhealthy healthy' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1', '--health-timeout', '60']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.outcome).toMatchObject({ status: 'green', detail: 'healthy' });
		const probes = result.calls.filter((line) =>
			line.startsWith('docker inspect --format {{.RestartCount}}'),
		);
		expect(probes.length).toBe(6);
		expect(result.calls.some((line) => line.includes('up -d --no-build'))).toBe(false);
	});

	test('a RESTART of the engine process is red at once (a crash, not a slow boot)', () => {
		const stack = makeStack({ state: { health_1: 'starting', restarts_1: '1' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'rolled_back', detail: 'unhealthy' });
		const probes = result.calls.filter((line) =>
			line.startsWith('docker inspect --format {{.RestartCount}}'),
		);
		expect(probes.length).toBe(2); // one on the new image, one green on the rollback
		expect(result.stderr).toContain('the engine process restarted (1 time(s))');
	});

	test('the rollback is unhealthy too: rollback_failed', () => {
		const stack = makeStack({ state: { health_1: 'unhealthy', health_2: 'unhealthy' } });
		const result = runUpdate(stack, ['--version', '7.0.1', '--health-timeout', '10']);
		expect(result.code).toBe(1);
		expect(result.outcome).toMatchObject({ status: 'rollback_failed', detail: 'unhealthy' });
		expect(result.env).toBe(stack.envBefore);
	});

	test('`starting` until the timeout: health_timeout, rolled back', () => {
		const stack = makeStack({ state: { health_1: 'starting' } });
		const result = runUpdate(stack, ['--version', '7.0.1', '--health-timeout', '10']);
		expect(result.outcome).toMatchObject({ status: 'rolled_back', detail: 'health_timeout' });
		// 10 s at 5 s a probe = 2 probes on the new image before giving up.
		const probes = result.calls.filter((line) =>
			line.startsWith('docker inspect --format {{.RestartCount}}'),
		);
		expect(probes.length).toBe(3);
	});

	test('build mode rollback also restores the previous checkout', () => {
		const stack = makeStack({
			mode: 'build',
			image: 'localhost/dedalo',
			state: { target_triple: '7.0.1', health_1: 'unhealthy' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1', '--health-timeout', '10']);
		expect(result.outcome).toMatchObject({ status: 'rolled_back', mode: 'build' });
		expect(at(result.calls, /^git checkout -q master$/)).toBeLessThan(
			at(result.calls, / up -d --no-build /),
		);
		expect(at(result.calls, /^git checkout -q master$/)).toBeGreaterThan(-1);
	});
});

describe('the backup', () => {
	test('required: refused when the backup service is not running — nothing anchored, pulled or pinned', () => {
		const stack = makeStack({ state: { running_backup: '' } });
		rmSync(join(stack.state, 'running_backup'));
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({
			status: 'refused',
			detail: 'backup_failed',
			backup: null,
		});
		expect(at(result.calls, /^docker (tag|pull)/)).toBe(-1);
		expect(result.env).toBe(stack.envBefore);
	});

	test('a backup that fails: failed/backup_failed, nothing changed', () => {
		const stack = makeStack({ state: { backup_fail: '' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'failed', detail: 'backup_failed' });
		expect(at(result.calls, /^docker (tag|pull)/)).toBe(-1);
	});

	test('--no-backup waives it: green, backup null, no backup exec at all', () => {
		const stack = makeStack();
		rmSync(join(stack.state, 'running_backup'));
		const result = runUpdate(stack, ['--version', '7.0.1', '--no-backup']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.outcome).toMatchObject({ status: 'green', backup: null });
		expect(at(result.calls, /exec -T backup/)).toBe(-1);
	});
});

describe('refusals before anything changes', () => {
	const unchanged = (stack: Stack, result: Result): void => {
		expect(result.env).toBe(stack.envBefore);
		expect(at(result.calls, /^docker (tag|pull)|exec -T backup| up /)).toBe(-1);
		expectStackHygiene(stack, result);
	};

	test('grammar: not a version → version_refused', () => {
		for (const bad of [
			'7.0',
			'v7.0.1',
			'7.0.1-pre.1',
			'7.0.1-beta',
			'07.0.1',
			'7.0.1.dev',
			'latest',
		]) {
			const stack = makeStack();
			const result = runUpdate(stack, ['--version', bad]);
			expect({ bad, outcome: result.outcome?.detail }).toEqual({ bad, outcome: 'version_refused' });
			unchanged(stack, result);
		}
	});

	test('downgrade and same version refused; the same version is allowed only as -dev', () => {
		for (const target of ['6.9.9', '7.0.0']) {
			const stack = makeStack();
			const result = runUpdate(stack, ['--version', target]);
			expect({ target, detail: result.outcome?.detail }).toEqual({
				target,
				detail: 'downgrade_refused',
			});
			unchanged(stack, result);
		}
		const dev = makeStack();
		const result = runUpdate(dev, ['--version', '7.0.0-dev']);
		expect(result.code, result.stderr).toBe(0);
		expect(result.env).toBe(repinned(dev, '7.0.0-dev'));
		// A -dev pin may be re-installed at the same version too.
		const again = makeStack({ pinned: '7.0.0-dev' });
		expect(runUpdate(again, ['--version', '7.0.0-dev']).code).toBe(0);
	});

	test('the engine refuses the walk (exit 3): version_refused, with its reason', () => {
		const stack = makeStack({ state: { check_code: '3', check_out: 'version_skip\n' } });
		const result = runUpdate(stack, ['--version', '7.0.2']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		expect(result.stderr).toContain('version_skip');
		unchanged(stack, result);
		// --skip-version-check does NOT override a refusal.
		const skipped = makeStack({ state: { check_code: '3', check_out: 'version_skip\n' } });
		expect(runUpdate(skipped, ['--version', '7.0.2', '--skip-version-check']).outcome?.detail).toBe(
			'version_refused',
		);
	});

	test('the check is unavailable (any other exit): refused unless --skip-version-check', () => {
		const stack = makeStack({ state: { check_code: '127' } });
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'version_refused' });
		unchanged(stack, result);
		const waived = makeStack({ state: { check_code: '127' } });
		expect(runUpdate(waived, ['--version', '7.0.1', '--skip-version-check']).outcome?.status).toBe(
			'green',
		);
	});

	test('the engine is not running: not_running', () => {
		const stack = makeStack();
		rmSync(join(stack.state, 'running_dedalo'));
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'not_running' });
		unchanged(stack, result);
	});

	test('an incomplete .dedalo.env: env_incomplete, and the exact lines to add', () => {
		// The checkout is AT the beta tag (version.ts 7.0.0): the suggested pin is the image
		// tag of its release identity, never the bare data version (C3i-F1).
		const stack = makeStack({
			envText: 'POSTGRES_PASSWORD=x\nDEDALO_NGINX_CONF=nginx.simple.conf\nDEDALO_IMAGE=bad"image\n',
			state: { describe: 'v7.0.0-beta.6' },
		});
		const result = runUpdate(stack, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({
			status: 'refused',
			detail: 'env_incomplete',
			mode: null,
			image: '',
		});
		for (const line of [
			'DEDALO_COMPOSE_FILE=docker-compose.simple.yml',
			'DEDALO_IMAGE=localhost/dedalo',
			'DEDALO_VERSION=7.0.0-beta.6',
			'DEDALO_IMAGE_MODE=build',
			'DEDALO_IMAGE_VERIFY=none',
		]) {
			// A bare line of its own — no indentation, no inline comment — so pasting it
			// verbatim gives a line compose and the updater read identically.
			expect(result.stderr.split('\n')).toContain(line);
		}
		// nothing but the read-only question to git (which tag is this checkout at?)
		expect(
			result.calls.filter((call) => !/ describe --exact-match --match v\[0-9\]\* HEAD$/.test(call)),
		).toEqual([]);
		expect(result.calls.length).toBe(1);
		// an untagged checkout suggests its -dev tag
		const untagged = makeStack({ envText: 'POSTGRES_PASSWORD=x\n', state: { describe: '' } });
		expect(runUpdate(untagged, ['--version', '7.0.1']).stderr.split('\n')).toContain(
			'DEDALO_VERSION=7.0.0-dev',
		);
		expect(outcomeViolations(result.outcome)).toEqual([]);
	});

	test('one run at a time: a live holder refuses (locked); a dead holder is taken over', () => {
		const held = makeStack();
		mkdirSync(join(held.dir, '.dedalo-image-update.lock'));
		writeFileSync(join(held.dir, '.dedalo-image-update.lock', 'pid'), `${process.pid}\n`);
		const result = runUpdate(held, ['--version', '7.0.1']);
		expect(result.outcome).toMatchObject({ status: 'refused', detail: 'locked' });
		expect(result.calls).toEqual([]);
		// The refused run did not remove the holder's lock.
		expect(existsSync(join(held.dir, '.dedalo-image-update.lock', 'pid'))).toBe(true);

		const stale = makeStack();
		mkdirSync(join(stale.dir, '.dedalo-image-update.lock'));
		writeFileSync(join(stale.dir, '.dedalo-image-update.lock', 'pid'), '999999\n');
		expect(runUpdate(stale, ['--version', '7.0.1']).outcome?.status).toBe('green');
		// …and a finished run leaves no lock behind.
		expect(existsSync(join(stale.dir, '.dedalo-image-update.lock'))).toBe(false);
	});

	test('usage errors exit 2 and write no outcome; a request id must be a UUID', () => {
		for (const args of [
			[],
			['--version'],
			['--version', '7.0.1', '--request-id', 'x"y'],
			['--mode', 'pull'],
			['--version', '7.0.1', '--health-timeout', '0'],
		]) {
			const stack = makeStack();
			const result = runUpdate(stack, args);
			expect({ args, code: result.code }).toEqual({ args, code: 2 });
			expect(result.outcome).toBeNull();
			expect(result.calls).toEqual([]);
		}
	});
});

describe('the script itself', () => {
	test('bash -n, set -euo pipefail, and no retired interface', () => {
		const path = join(REPO_ROOT, 'deploy', 'dedalo-image-update.sh');
		expect(Bun.spawnSync(['bash', '-n', path]).exitCode).toBe(0);
		expect(
			Bun.spawnSync(['bash', '-n', join(REPO_ROOT, 'deploy', 'dedalo-image-lib.sh')]).exitCode,
		).toBe(0);
		const source = readFileSync(path, 'utf8');
		expect(source).toMatch(/^set -euo pipefail$/m);
		const code = source.split('\n').filter((line) => !/^\s*#/.test(line));
		expect(code.length).toBeGreaterThan(100);
		for (const retired of ['DEDALO_IMAGE_UPDATE_MODE', '--mode)', '--image)', '--tag)']) {
			expect(
				code.filter((line) => line.includes(retired)),
				retired,
			).toEqual([]);
		}
		// Executed as one parsed unit: build mode checks out another version of this file.
		expect(source.trimEnd().split('\n').at(-1)).toBe('main "$@"; exit');
	});
});

/**
 * Is `call` the shared builder's `docker build` of `context` as `version` — its
 * tag, and its OWN version label (campaign 3b N1: never the base image's)?
 */
function isBuildOf(call: string, version: string, context: string): boolean {
	return (
		call.startsWith(`docker build --tag localhost/dedalo:${version} `) &&
		call.includes(` --label org.opencontainers.image.version=${version} `) &&
		call.endsWith(` ${context}`)
	);
}
