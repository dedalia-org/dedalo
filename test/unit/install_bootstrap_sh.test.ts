/**
 * install.sh IS THE BOOTSTRAP, AND ONLY THAT (terminal installer phase 4,
 * 2026-10-12): Linux on x86_64/aarch64, the RELEASE verified first, Bun at the
 * release's pin verified against the release's committed hash table (and Bun's
 * own SHASUMS when fetched), the installer's dependencies, then `exec` of the
 * TypeScript installer with the operator's arguments untouched.
 *
 * EXECUTED, never read: the script runs under `sh` (dash on Debian/Ubuntu — no
 * bash-isms) with STUB `uname`, `curl` and `bun` first on PATH and real
 * fixture archives (zip/tar built here), in a scratch HOME — nothing is
 * downloaded, nothing runs as root.
 *
 *  (a) END TO END: a verified `--release` archive is staged, its pin read, the
 *      fake Bun zip fetched and checked against ITS table and the fetched
 *      SHASUMS, the dependencies installed (`--frozen-lockfile --production
 *      --ignore-scripts`), and the installer exec'd with EXACTLY the operator's
 *      argv (spaces, quotes, a literal `$HOME`, a leading `--`), stdin kept;
 *      `--no-env-file --no-install --config=<the release's bunfig>`. A secret in
 *      the environment reaches the installer and NO argv (curl's, bun's).
 *      On macOS (Darwin, Apple silicon) the same run verifies the darwin asset
 *      against the release's `.bun-sha256-darwin` — the docker and trial routes
 *      run from a Mac with Docker Desktop (the production route's own System
 *      check refuses a Mac); a Linux table alone does not vouch for it.
 *  (b) REFUSALS (exit 3, nothing exec'd): neither Linux nor macOS; `--release` without its
 *      sha256 (no "confirm on the terminal" instead); a wrong sha256 (nothing
 *      extracted); an archive naming a member outside itself; a cached Bun zip
 *      that no longer matches the table (re-hashed on EVERY reuse, then
 *      removed); Bun's SHASUMS disagreeing with the table (both refused);
 *      `--wizard` (retired); a missing `unzip` or `curl` (require_tool — the
 *      bootstrap runs before host_packages, so it names the package).
 *  (d) UNDER SUDO (campaign 3 C3-24): `--route production` on a Linux system
 *      the route does not support is refused BEFORE anything is fetched or
 *      installed, with the installer's own sentence — the shell table held
 *      equal to os_support.ts OS_ROWS; root in a checkout that is not root's
 *      installs the dependencies AS ITS OWNER (runuser, a root-owned 0755 copy
 *      of the verified Bun) and never itself; root in its own tree keeps Bun's
 *      package cache under the cache root (never /root/.bun).
 *  (c) THE SAME VERDICTS AS THE PUBLICATION HOST AGENT'S BOOTSTRAP
 *      (publication/host_agent/deploy/install.sh — the model it follows): its
 *      `pick_asset` and `verify_bun` against this one's `pick_asset` and
 *      `verify_bun_zip` + `unpack_bun`, over the same fixtures — accept and
 *      refuse alike.
 *
 * DB-FREE, network-free (the hermetic tier runs it). Needs `zip` and `tar`
 * (the CI image ships them — absent is RED, never a skip).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	OS_ROWS,
	osRowOf,
	parseOsRelease,
	unsupportedOsSentence,
} from '../../src/core/install/host/os_support.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');
const AGENT_SH = join(REPO_ROOT, 'publication/host_agent/deploy/install.sh');
const scratch = mkdtempSync(join(tmpdir(), 'dedalo_install_bootstrap_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PIN = '1.4.2';
/**
 * The x86_64 Bun asset install.sh picks ON THIS HOST: the stubbed `uname -m` says
 * x86_64, but pick_asset reads the REAL /proc/cpuinfo (AVX2 → bun-linux-x64, else
 * -baseline). Pinning one name made the gate pass on an AVX2-less arm64 image and
 * fail on GitHub's x64 runner (2026-10-13). Same rule as install.sh, so the fixture
 * is the asset the script really asks for; DECOY_ASSET is the other one.
 */
function hostX64Asset(): string {
	const cpuinfo = existsSync('/proc/cpuinfo') ? readFileSync('/proc/cpuinfo', 'utf8') : '';
	return /\bavx2\b/.test(cpuinfo) ? 'bun-linux-x64' : 'bun-linux-x64-baseline';
}
const ASSET = hostX64Asset();
const DECOY_ASSET = ASSET === 'bun-linux-x64' ? 'bun-linux-x64-baseline' : 'bun-linux-x64';
const SIGNED_BY = 'F'.repeat(40);
const SECRET = 'Zz-Bootstrap-Secret-91q';

let counter = 0;
function dir(name: string): string {
	counter += 1;
	const path = join(scratch, `${counter}_${name}`);
	mkdirSync(path, { recursive: true });
	return path;
}

function sha256File(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(
	argv: string[],
	options: { cwd: string; env?: Record<string, string>; stdin?: string },
) {
	const child = Bun.spawnSync(argv, {
		cwd: options.cwd,
		env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...options.env },
		stdin: options.stdin === undefined ? undefined : new TextEncoder().encode(options.stdin),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		code: child.exitCode ?? -1,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * A fake Bun zip (`<asset>/bun`): a shell script answering `--version` with
 * `version`, and recording every other call — its argv NUL-separated, whether
 * a secret was in its environment, its stdin — into $BUN_RECORD.
 */
function bunZip(at: string, version = PIN, asset = ASSET): string {
	const stage = dir('bunzip');
	mkdirSync(join(stage, asset));
	writeFileSync(
		join(stage, asset, 'bun'),
		[
			'#!/bin/sh',
			`if [ "$1" = --version ]; then echo ${version}; exit 0; fi`,
			'[ -n "${BUN_RECORD:-}" ] || exit 0',
			'printf "%s\\0" "$@" >> "$BUN_RECORD"',
			'printf "\\n--env:%s\\n" "${DEDALO_INSTALL_ROOT_PASSWORD:+present}" >> "$BUN_RECORD"',
			'case " $* " in *" install "*) exit 0 ;; esac',
			'printf "\\n--stdin:%s\\n" "$(cat)" >> "$BUN_RECORD"',
			'',
		].join('\n'),
	);
	chmodSync(join(stage, asset, 'bun'), 0o755);
	const zip = join(at, `${asset}.zip`);
	const made = run(['zip', '-q', '-r', zip, asset], { cwd: stage });
	expect(made.code, made.stderr).toBe(0);
	return zip;
}

const LINUX_ASSETS = ['bun-linux-aarch64', 'bun-linux-x64-baseline', 'bun-linux-x64'];
const DARWIN_ASSETS = ['bun-darwin-aarch64', 'bun-darwin-x64-baseline', 'bun-darwin-x64'];

/** A committed hash table (`.bun-sha256` / `.bun-sha256-darwin`): pin, signer, one row per asset. */
function table(zipSha: string, pin = PIN, assets = LINUX_ASSETS, asset = ASSET): string {
	return [
		`# bun-v${pin}`,
		`# signed-by: ${SIGNED_BY}`,
		...assets.map((name) => `${name === asset ? zipSha : 'e'.repeat(64)}  ${name}.zip`),
		'',
	].join('\n');
}

/** A release archive (tar.gz, one top-level dedalo_code/) of a tree pinned to `zipSha`. */
function release(zipSha: string, extra: (tree: string) => void = () => {}): string {
	const stage = dir('release');
	const tree = join(stage, 'dedalo_code');
	mkdirSync(join(tree, 'scripts'), { recursive: true });
	writeFileSync(join(tree, 'scripts/install.ts'), 'console.log("the installer");\n');
	writeFileSync(join(tree, '.bun-version'), `${PIN}\n`);
	writeFileSync(join(tree, '.bun-sha256'), table(zipSha));
	writeFileSync(join(tree, 'package.json'), '{}\n');
	writeFileSync(join(tree, 'bun.lock'), '{}\n');
	writeFileSync(join(tree, 'bunfig.toml'), 'console.depth = 1\n');
	extra(tree);
	const archive = join(stage, 'dedalo_code.tar.gz');
	const made = run(['tar', '-czf', archive, 'dedalo_code'], { cwd: stage });
	expect(made.code, made.stderr).toBe(0);
	return archive;
}

/** Stubs first on PATH: uname (Linux x86_64 unless told), curl (serves FIXTURES/<basename>, logs argv). */
function stubs(fixtures: string, kernel = 'Linux', machine = 'x86_64'): string {
	const bin = dir('bin');
	writeFileSync(
		join(bin, 'uname'),
		`#!/bin/sh\ncase "$1" in -s) echo ${kernel} ;; -m) echo ${machine} ;; *) echo ${kernel} ;; esac\n`,
	);
	writeFileSync(
		join(bin, 'curl'),
		[
			'#!/bin/sh',
			'printf "%s\\0" "$@" >> "$CURL_LOG"; printf "\\n" >> "$CURL_LOG"',
			'out=""; url=""',
			'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) url=$1; shift ;; esac; done',
			`cp "${fixtures}/$(basename "$url")" "$out"`,
			'',
		].join('\n'),
	);
	chmodSync(join(bin, 'uname'), 0o755);
	chmodSync(join(bin, 'curl'), 0o755);
	return bin;
}

interface BootRun {
	code: number;
	stderr: string;
	/** The exec'd installer's argv (null: nothing exec'd). */
	installer: string[] | null;
	/** Every bun call's argv (dependencies included). */
	calls: string[][];
	secretSeen: boolean;
	stdin: string | null;
	curl: string;
	cache: string;
}

/**
 * A scratch host root (the installer's own seam, marked) whose os-release the
 * production gate reads — never this machine's (default: a supported system).
 */
function hostRoot(
	osRelease = 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n',
): string {
	const root = dir('hostroot');
	mkdirSync(join(root, '.dedalo_install_scratch'));
	mkdirSync(join(root, 'etc'));
	writeFileSync(join(root, 'etc/os-release'), osRelease);
	return root;
}

/** Run the bootstrap end to end. */
function boot(
	args: string[],
	options: {
		fixtures: string;
		kernel?: string;
		machine?: string;
		stdin?: string;
		cache?: string;
		root?: string;
	},
): BootRun {
	const home = dir('home');
	const cache = options.cache ?? dir('cache');
	const record = join(home, 'bun.record');
	const curlLog = join(home, 'curl.log');
	const result = run(['sh', INSTALL_SH, ...args], {
		cwd: home,
		env: {
			PATH: `${stubs(options.fixtures, options.kernel, options.machine)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			HOME: home,
			XDG_CACHE_HOME: cache,
			BUN_RECORD: record,
			CURL_LOG: curlLog,
			DEDALO_INSTALL_ROOT_PASSWORD: SECRET,
			DEDALO_INSTALL_HOST_ROOT: options.root ?? hostRoot(),
		},
		...(options.stdin === undefined ? {} : { stdin: options.stdin }),
	});
	const text = existsSync(record) ? readFileSync(record, 'utf8') : '';
	const blocks = text
		.split(/\n--env:[^\n]*\n(?:--stdin:[^\n]*\n)?/)
		.filter((block) => block !== '');
	const calls = blocks.map((block) =>
		block.split('\0').filter((word, index, all) => index < all.length - 1 || word !== ''),
	);
	const installer =
		calls.find((argv) => argv.some((word) => word.endsWith('/scripts/install.ts'))) ?? null;
	return {
		code: result.code,
		stderr: result.stderr,
		installer,
		calls,
		secretSeen: /--env:present/.test(text),
		stdin: /--stdin:([^\n]*)/.exec(text)?.[1] ?? null,
		curl: existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '',
		cache,
	};
}

/** A fixture set: the Bun zip, Bun's SHASUMS (agreeing unless told), a release pinned to the zip. */
function fixtureSet(options: { sumsSha?: string } = {}) {
	const fixtures = dir('fixtures');
	const zip = bunZip(fixtures);
	const sha = sha256File(zip);
	writeFileSync(
		join(fixtures, 'SHASUMS256.txt'),
		`${options.sumsSha ?? sha}  ${ASSET}.zip\n${'0'.repeat(64)}  ${DECOY_ASSET}.zip\n`,
	);
	const archive = release(sha);
	return { fixtures, zip, sha, archive, archiveSha: sha256File(archive) };
}

// ── (a) end to end ───────────────────────────────────────────────────────────

describe('the bootstrap runs end to end under sh (a)', () => {
	test('release verified first, Bun verified, dependencies installed, the installer exec’d with the argv untouched', () => {
		const set = fixtureSet();
		const operatorArgs = [
			'--route',
			'production',
			'--entity-label',
			'Museo \'Nacional\' de "Arte"',
			'--information=$HOME a  b',
			'--',
			'--odd',
		];
		const result = boot(
			['--release', set.archive, '--release-sha256', set.archiveSha, '--', ...operatorArgs],
			{
				fixtures: set.fixtures,
				stdin: 'typed by the operator',
			},
		);
		expect(result.stderr).toContain('Installing the installer');
		expect(result.code, result.stderr).toBe(0);
		// The dependencies: the release's lockfile, production, no lifecycle scripts — and, its
		// stdout a pipe (the installer's plain mode), no progress bar (campaign 3b N25).
		expect(result.calls[0]).toEqual([
			'install',
			'--frozen-lockfile',
			'--production',
			'--ignore-scripts',
			'--no-progress',
		]);
		// The installer: the hand-over flags, the release's bunfig, then EXACTLY the operator's argv.
		const argv = result.installer ?? [];
		expect(argv.slice(0, 2)).toEqual(['--no-env-file', '--no-install']);
		expect(argv[2]).toMatch(
			/^--config=.*\/release\/[0-9a-f]{64}\/tree\/dedalo_code\/bunfig\.toml$/,
		);
		expect(argv[3]).toMatch(/\/release\/[0-9a-f]{64}\/tree\/dedalo_code\/scripts\/install\.ts$/);
		expect(argv.slice(4)).toEqual(operatorArgs);
		expect(result.stdin).toBe('typed by the operator');
		// The secret reached the installer through its environment — and no argv.
		expect(result.secretSeen).toBe(true);
		expect(result.calls.flat().some((word) => word.includes(SECRET))).toBe(false);
		expect(result.curl).not.toContain(SECRET);
		// What was fetched: the zip and Bun's SHASUMS, https only, from the pin's release.
		const fetched = result.curl
			.split('\n')
			.filter((line) => line !== '')
			.map((line) =>
				line
					.split('\0')
					.filter((word) => word !== '')
					.at(-1),
			);
		expect(fetched).toEqual([
			`https://github.com/oven-sh/bun/releases/download/bun-v${PIN}/${ASSET}.zip`,
			`https://github.com/oven-sh/bun/releases/download/bun-v${PIN}/SHASUMS256.txt`,
		]);
		expect(result.curl).toContain('--proto\0=https\0');
		// The cache: the verified zip kept (a host step reuses it), private.
		expect(existsSync(join(result.cache, 'dedalo-install/bun', PIN, `${ASSET}.zip`))).toBe(true);
		expect(statMode(join(result.cache, 'dedalo-install'))).toBe(0o700);
	});

	test('a second run reuses the cached zip, RE-HASHED (no download); a tampered one is refused and removed', () => {
		const set = fixtureSet();
		const cache = dir('cache');
		const args = ['--release', set.archive, '--release-sha256', set.archiveSha, '--', '--plan'];
		expect(boot(args, { fixtures: set.fixtures, cache }).code).toBe(0);
		const again = boot(args, { fixtures: set.fixtures, cache });
		expect(again.code, again.stderr).toBe(0);
		expect(again.curl).toBe('');
		const cached = join(cache, 'dedalo-install/bun', PIN, `${ASSET}.zip`);
		writeFileSync(cached, 'tampered bytes');
		const tampered = boot(args, { fixtures: set.fixtures, cache });
		expect(tampered.code).toBe(3);
		expect(tampered.stderr).toContain('not the pinned release (removed)');
		expect(tampered.installer).toBeNull();
		expect(existsSync(cached)).toBe(false);
	});
});

function statMode(path: string): number {
	return Bun.spawnSync([
		'stat',
		process.platform === 'darwin' ? '-f' : '-c',
		process.platform === 'darwin' ? '%Lp' : '%a',
		path,
	])
		.stdout.toString()
		.trim()
		.split('')
		.reduce((mode, digit) => mode * 8 + Number(digit), 0);
}

// ── (b) refusals ─────────────────────────────────────────────────────────────

describe('macOS: the docker and trial routes start from a Mac (Docker Desktop) (a)', () => {
	const DARWIN = 'bun-darwin-aarch64';

	/** A release vouching for the darwin zip in `.bun-sha256-darwin` (and NOT in the Linux table). */
	function darwinSet(withDarwinTable: boolean) {
		const fixtures = dir('fixtures_darwin');
		const zip = bunZip(fixtures, PIN, DARWIN);
		const sha = sha256File(zip);
		writeFileSync(join(fixtures, 'SHASUMS256.txt'), `${sha}  ${DARWIN}.zip\n`);
		const archive = release('e'.repeat(64), (tree) => {
			if (withDarwinTable)
				writeFileSync(join(tree, '.bun-sha256-darwin'), table(sha, PIN, DARWIN_ASSETS, DARWIN));
		});
		return { fixtures, archive, archiveSha: sha256File(archive) };
	}

	test('Apple silicon: the darwin asset, verified against .bun-sha256-darwin, the installer exec’d', () => {
		const set = darwinSet(true);
		const result = boot(
			['--release', set.archive, '--release-sha256', set.archiveSha, '--', '--route', 'trial'],
			{ fixtures: set.fixtures, kernel: 'Darwin', machine: 'arm64' },
		);
		expect(result.code, result.stderr).toBe(0);
		expect(result.curl).toContain(`/bun-v${PIN}/${DARWIN}.zip`);
		expect((result.installer ?? []).slice(-2)).toEqual(['--route', 'trial']);
	});

	test('a release without the darwin table: refused, nothing exec’d (the Linux table never vouches for it)', () => {
		const set = darwinSet(false);
		const result = boot(
			['--release', set.archive, '--release-sha256', set.archiveSha, '--', '--route', 'trial'],
			{ fixtures: set.fixtures, kernel: 'Darwin', machine: 'arm64' },
		);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain('no .bun-sha256-darwin');
		expect(result.installer).toBeNull();
	});
});

describe('the bootstrap refuses, exit 3, nothing exec’d (b)', () => {
	const set = fixtureSet();

	const cases: { name: string; args: () => string[]; kernel?: string; sentence: string }[] = [
		{
			name: 'neither Linux nor macOS',
			args: () => ['--', '--plan'],
			kernel: 'FreeBSD',
			sentence:
				'this installer runs on Linux, or on macOS for the trial and Docker routes (this is FreeBSD)',
		},
		{
			name: '--release without its sha256',
			args: () => ['--release', set.archive],
			sentence: '--release needs --release-sha256',
		},
		{
			name: '--release with a wrong sha256',
			args: () => ['--release', set.archive, '--release-sha256', 'a'.repeat(64)],
			sentence: 'refused (nothing was extracted)',
		},
		{
			name: '--release-sha256 without --release',
			args: () => ['--release-sha256', 'a'.repeat(64)],
			sentence: '--release-sha256 without --release',
		},
		{ name: '--wizard (retired)', args: () => ['--wizard'], sentence: '--wizard is retired' },
		{
			name: 'a non-https mirror',
			args: () => ['--mirror', 'http://mirror.example.org'],
			sentence: '--mirror must start with https://',
		},
	];
	for (const item of cases) {
		test(item.name, () => {
			const result = boot(item.args(), {
				fixtures: set.fixtures,
				...(item.kernel === undefined ? {} : { kernel: item.kernel }),
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toContain(item.sentence);
			expect(result.installer).toBeNull();
		});
	}

	// The bootstrap runs BEFORE host_packages: a minimal host without unzip or curl
	// is refused naming the package, never a bare "unzip: not found" mid-run.
	test('a missing unzip / curl is refused naming the package to install (require_tool)', () => {
		const empty = dir('empty_path');
		for (const tool of ['unzip', 'curl']) {
			const result = run(
				[
					'/bin/sh',
					'-c',
					`set -- --lib; . "${INSTALL_SH}"; PATH="${empty}"; require_tool ${tool} 'for the test'; echo reached`,
				],
				{ cwd: scratch },
			);
			expect(result.code, tool).toBe(3);
			expect(result.stdout).not.toContain('reached');
			expect(result.stderr).toContain(`${tool} is not installed and is needed for the test`);
			expect(result.stderr).toContain(`apt-get install ${tool}`);
		}
		const present = run(
			['/bin/sh', '-c', `set -- --lib; . "${INSTALL_SH}"; require_tool sh 'x'; echo reached`],
			{ cwd: scratch },
		);
		expect(present.code, present.stderr).toBe(0);
		expect(present.stdout).toContain('reached');
	});

	test('an archive naming a member outside itself is refused before extraction (the member check)', () => {
		const stage = dir('evil');
		// The archive's member list, as stage_release lists it, judged before anything is extracted.
		const names = join(stage, 'names');
		for (const [list, ok] of [
			['dedalo_code/\ndedalo_code/x\n', true],
			['dedalo_code/../evil\n', false],
			['/etc/passwd\n', false],
			['./x\n', false],
		] as const) {
			writeFileSync(names, list);
			const verdict = run(
				['sh', '-c', `set -- --lib; . "${INSTALL_SH}"; member_names_ok "${names}"`],
				{ cwd: stage },
			);
			expect(verdict.code === 0, list).toBe(ok);
		}
	});

	test("Bun's SHASUMS disagreeing with the committed table: both refused", () => {
		const bad = fixtureSet({ sumsSha: 'b'.repeat(64) });
		const result = boot(['--release', bad.archive, '--release-sha256', bad.archiveSha], {
			fixtures: bad.fixtures,
		});
		expect(result.code).toBe(3);
		expect(result.stderr).toContain('SHASUMS256.txt disagrees with .bun-sha256');
		expect(result.installer).toBeNull();
	});
});

// ── (c) the host agent's verdicts ────────────────────────────────────────────

describe("the same verdicts as the publication host agent's bootstrap (c)", () => {
	/** Run `body` with a script's library loaded (and $SHA256 resolved). */
	function lib(script: string, body: string, cwd: string) {
		return run(['sh', '-c', `set -- --lib; . "${script}"; resolve_sha256; ${body}`], { cwd });
	}

	test('pick_asset: the same asset (or refusal) for every CPU', () => {
		const work = dir('cpu');
		writeFileSync(join(work, 'avx2'), 'flags : fpu avx avx2\n');
		writeFileSync(join(work, 'noavx2'), 'flags : fpu sse2\n');
		for (const [machine, cpuinfo] of [
			['x86_64', 'avx2'],
			['x86_64', 'noavx2'],
			['x86_64', 'absent'],
			['aarch64', 'avx2'],
			['arm64', 'avx2'],
			['riscv64', 'avx2'],
		] as const) {
			const ours = lib(INSTALL_SH, `pick_asset ${machine} ${cpuinfo}`, work);
			const theirs = lib(AGENT_SH, `pick_asset ${machine} ${cpuinfo}`, work);
			expect({ machine, cpuinfo, code: ours.code, out: ours.stdout }).toEqual({
				machine,
				cpuinfo,
				code: theirs.code,
				out: theirs.stdout,
			});
		}
	});

	test('verify: accept and refuse alike over the same zips, tables and SHASUMS', () => {
		const fixtures = dir('vfix');
		const zip = bunZip(fixtures);
		const sha = sha256File(zip);
		const wrongVersion = bunZip(dir('vwrong'), '9.9.9');
		const cases: { name: string; zip: string; table: string; sums: string | null }[] = [
			{ name: 'good, no SHASUMS', zip, table: table(sha), sums: null },
			{ name: 'good, SHASUMS agree', zip, table: table(sha), sums: `${sha}  ${ASSET}.zip\n` },
			{ name: 'zip not the table’s', zip, table: table('c'.repeat(64)), sums: null },
			{
				name: 'SHASUMS disagree',
				zip,
				table: table(sha),
				sums: `${'d'.repeat(64)}  ${ASSET}.zip\n`,
			},
			{
				name: 'SHASUMS names the asset twice',
				zip,
				table: table(sha),
				sums: `${sha}  ${ASSET}.zip\n${sha}  ${ASSET}.zip\n`,
			},
			{ name: 'table for another pin', zip, table: table(sha, '1.0.0'), sums: null },
			{
				name: 'table without its signer line',
				zip,
				table: table(sha).replace(/^# signed-by.*\n/m, ''),
				sums: null,
			},
			{
				name: 'a binary answering another version',
				zip: wrongVersion,
				table: table(sha256File(wrongVersion)),
				sums: null,
			},
		];
		const verdicts: boolean[] = [];
		for (const item of cases) {
			const work = dir('verify');
			writeFileSync(join(work, 'table'), item.table);
			const sums = item.sums === null ? '-' : join(work, 'sums');
			if (item.sums !== null) writeFileSync(sums, item.sums);
			const copy = (name: string) => {
				const target = join(work, name);
				writeFileSync(target, readFileSync(item.zip));
				return target;
			};
			const ours = lib(
				INSTALL_SH,
				`verify_bun_zip "${copy('ours.zip')}" "${sums}" ${ASSET} ${PIN} "${join(work, 'table')}" && unpack_bun "${join(work, 'ours.zip')}" ${ASSET} "${join(work, 'ours_run')}" ${PIN}`,
				work,
			);
			const theirs = lib(
				AGENT_SH,
				`verify_bun "${copy('theirs.zip')}" "${sums}" ${ASSET} ${PIN} "${join(work, 'table')}" "${join(work, 'theirs_run')}"`,
				work,
			);
			expect({ case: item.name, ok: ours.code === 0 }).toEqual({
				case: item.name,
				ok: theirs.code === 0,
			});
			verdicts.push(ours.code === 0);
		}
		// Not vacuous: the fixtures produce BOTH verdicts.
		expect(verdicts.filter(Boolean).length).toBe(2);
		expect(verdicts.filter((ok) => !ok).length).toBe(cases.length - 2);
	});
});

// ── (d) under sudo: the OS gate first, root never writes in a user's checkout ─

describe('under sudo: the production OS gate, and the dependencies as the checkout owner (d — campaign 3 C3-24)', () => {
	/** Run `body` with the bootstrap's library loaded. */
	function lib(body: string, env: Record<string, string> = {}, cwd = scratch) {
		return run(['sh', '-c', `set -- --lib; . "${INSTALL_SH}"; ${body}`], {
			cwd,
			env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...env },
		});
	}

	/** An os-release file. */
	function osRelease(id: string, version: string, pretty: string): string {
		const path = join(dir('osr'), 'os-release');
		writeFileSync(path, `ID="${id}"\nVERSION_ID="${version}"\nPRETTY_NAME="${pretty}"\n`);
		return path;
	}

	test("the shell table IS os_support.ts's: every supported row passes, its words are supportedOsList()", () => {
		for (const row of OS_ROWS) {
			for (const id of row.ids) {
				const version = row.versionMajor.includes('.') ? row.versionMajor : `${row.versionMajor}.1`;
				const file = osRelease(id, version, `${id} ${version}`);
				const gate = lib(`production_os_gate "${file}" Linux --route production; echo passed`);
				expect(gate.stdout, `${id} ${version}`).toBe('passed\n');
				expect(osRowOf(parseOsRelease(readFileSync(file, 'utf8')))?.id).toBe(row.id);
			}
		}
		for (const [id, version, pretty] of [
			['ubuntu', '24.04', 'Ubuntu 24.04.3 LTS'],
			['rhel', '9.6', 'Red Hat Enterprise Linux 9.6 (Plow)'],
			['debian', '12', 'Debian GNU/Linux 12 (bookworm)'],
			['fedora', '42', 'Fedora Linux 42'],
			['ubuntu', '26.10', 'Ubuntu 26.10'],
		] as const) {
			const file = osRelease(id, version, pretty);
			expect(osRowOf(parseOsRelease(readFileSync(file, 'utf8')))).toBeNull();
			const gate = lib(`production_os_gate "${file}" Linux --route=production; echo passed`);
			expect(gate.code, pretty).toBe(3);
			expect(gate.stderr).toBe(`install.sh: ${unsupportedOsSentence(pretty)}\n`);
		}
	});

	test('only --route production is gated (docker, trial, an interactive start: the installer decides)', () => {
		const file = osRelease('ubuntu', '24.04', 'Ubuntu 24.04.3 LTS');
		for (const args of ['--route docker', '--route trial', '', '--plan --instance x']) {
			expect(lib(`production_os_gate "${file}" Linux ${args}; echo passed`).stdout, args).toBe(
				'passed\n',
			);
		}
		expect(lib(`production_os_gate "${file}" Darwin --route production; echo passed`).stdout).toBe(
			'passed\n',
		);
	});

	test('end to end: --route production on an unsupported system — refused before any download or bun install', () => {
		const set = fixtureSet();
		const result = boot(
			['--release', set.archive, '--release-sha256', set.archiveSha, '--', '--route', 'production'],
			{
				fixtures: set.fixtures,
				root: hostRoot('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n'),
			},
		);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain(unsupportedOsSentence('Ubuntu 24.04.3 LTS'));
		expect(result.curl).toBe('');
		expect(result.calls).toEqual([]);
	});

	test("root in a checkout that is NOT root's: the dependencies are installed BY ITS OWNER (runuser), never by root", () => {
		const work = dir('sudo');
		const tree = join(work, 'checkout');
		mkdirSync(tree);
		const cache = join(work, 'cache');
		mkdirSync(cache);
		const bin = join(work, 'bin');
		mkdirSync(bin);
		const log = join(work, 'log');
		// The verified Bun (root's, in the 0700 cache): records how it was called.
		const bun = join(cache, 'bun-verified');
		writeFileSync(
			bun,
			`#!/bin/sh\nprintf 'bun %s|%s\\n' "$*" "\${BUN_INSTALL_CACHE_DIR:-}" >> "${log}"\n`,
		);
		chmodSync(bun, 0o755);
		writeFileSync(
			join(bin, 'getent'),
			'#!/bin/sh\necho "operator:x:$2:$2::/home/operator:/bin/sh"\n',
		);
		writeFileSync(
			join(bin, 'runuser'),
			`#!/bin/sh\nprintf 'runuser %s\\n' "$*" >> "${log}"\n[ "$1" = -u ] && shift 2\n[ "$1" = -- ] && shift\nexec "$@"\n`,
		);
		chmodSync(join(bin, 'getent'), 0o755);
		chmodSync(join(bin, 'runuser'), 0o755);
		const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` };
		const done = lib(`install_deps "${bun}" "${tree}" 0 "${cache}" Linux ${PIN}`, env, work);
		expect(done.code, done.stderr).toBe(0);
		const shared = join(cache, 'bun-shared', PIN, 'bun');
		const lines = readFileSync(log, 'utf8').trim().split('\n');
		expect(lines).toEqual([
			`runuser -u operator -- ${shared} install --frozen-lockfile --production --ignore-scripts`,
			'bun install --frozen-lockfile --production --ignore-scripts|',
		]);
		// The copy it runs is root's to replace, not the operator's: 0755 (others read and run it).
		expect(statMode(shared)).toBe(0o755);
		expect(statMode(join(cache, 'bun-shared', PIN))).toBe(0o755);
		expect(done.stderr).toContain(`as operator (the owner of ${tree}`);
		// Root's own tree (a staged --release): root installs, its package cache under the cache root.
		writeFileSync(log, '');
		const own = lib(`install_deps "${bun}" "${tree}" 0 "${cache}" Darwin ${PIN}`, env, work);
		expect(own.code, own.stderr).toBe(0);
		expect(readFileSync(log, 'utf8')).toBe(
			`bun install --frozen-lockfile --production --ignore-scripts|${cache}/bun-install-cache\n`,
		);
		// Not root: as before (its own HOME's cache), no runuser.
		writeFileSync(log, '');
		expect(
			lib(`install_deps "${bun}" "${tree}" 1000 "${cache}" Linux ${PIN}`, env, work).code,
		).toBe(0);
		expect(readFileSync(log, 'utf8')).toBe(
			'bun install --frozen-lockfile --production --ignore-scripts|\n',
		);
	});

	test("root's installer Bun keeps no cache in /root/.bun (campaign C4 S4: the transpiler cache)", () => {
		const cache = dir('rootcache');
		const probe =
			'echo "${BUN_RUNTIME_TRANSPILER_CACHE_PATH-unset}|${BUN_INSTALL_CACHE_DIR-unset}"';
		expect(lib(`root_bun_env 0 "${cache}"; ${probe}`).stdout).toBe(
			`0|${cache}/bun-install-cache\n`,
		);
		// Not root: its own HOME's Bun caches are its business — nothing set.
		expect(lib(`root_bun_env 1000 "${cache}"; ${probe}`).stdout).toBe('unset|unset\n');
	});

	test('plain mode: the dependency install runs uncoloured (NO_COLOR, FORCE_COLOR=0 — campaign 3 C3-58)', () => {
		const work = dir('plain');
		const tree = join(work, 'checkout');
		mkdirSync(tree);
		const cache = join(work, 'cache');
		mkdirSync(cache);
		const log = join(work, 'log');
		// The verified Bun records the colour switches it was run with, and its last argument
		// (`--no-progress` in plain mode: a progress bar moves the cursor — campaign 3b N25).
		const bun = join(cache, 'bun-verified');
		writeFileSync(
			bun,
			`#!/bin/sh\nfor last; do :; done\nprintf '%s|%s|%s\\n' "\${NO_COLOR:-unset}" "\${FORCE_COLOR:-unset}" "$last" >> "${log}"\n`,
		);
		chmodSync(bun, 0o755);
		const deps = `install_deps "${bun}" "${tree}" 1000 "${cache}" Darwin ${PIN}`;
		const colours = (args: string, term: string): string => {
			writeFileSync(log, '');
			const done = lib(`plain_colours ${args}; ${deps}`, { TERM: term }, work);
			expect(done.code, done.stderr).toBe(0);
			return readFileSync(log, 'utf8');
		};
		expect(colours('--plain', 'xterm-256color')).toBe('1|0|--no-progress\n');
		expect(colours('', 'dumb')).toBe('1|0|--no-progress\n');
		// stdout is a pipe here: the installer's plain mode, so uncoloured too.
		expect(colours('--route trial', 'xterm-256color')).toBe('1|0|--no-progress\n');
		// CONTROL: without plain_colours (the full screen), the bar is the bun default.
		writeFileSync(log, '');
		expect(lib(deps, { TERM: 'xterm-256color' }, work).code).toBe(0);
		expect(readFileSync(log, 'utf8')).toBe('unset|unset|--ignore-scripts\n');
		// A full terminal and no --plain: the full-screen run keeps its colours. Measured under a pty
		// where `script` provides one (BSD and util-linux spell it differently).
		const body = `set -- --lib; . "${INSTALL_SH}"; plain_output --route trial && echo plain || echo full`;
		const pty =
			process.platform === 'darwin'
				? ['script', '-q', '/dev/null', 'sh', '-c', body]
				: ['script', '-qec', `sh -c '${body}'`, '/dev/null'];
		if (Bun.which('script') !== null) {
			const full = run(pty, { cwd: work, env: { TERM: 'xterm-256color' } });
			expect(full.stdout).toContain('full');
			expect(full.stdout).not.toContain('plain');
		}
	});

	test('deps_user: a root-owned tree is installed by root itself (nothing to drop to)', () => {
		expect(lib('deps_user / 0 Linux; echo "[$(deps_user / 0 Linux)]"').stdout).toContain('[]');
	});
});
