/**
 * THE SHELL TWIN OF THE RELEASE IDENTITY (design gate 7; closes gate 8's shell
 * leg) — deploy/dedalo-image-lib.sh, EXECUTED under bash, held to the engine's
 * src/core/update/release_identity.ts over SHARED fixtures:
 *
 *  A. IDENTITY — dedalo_release_identity over the REAL git trees of the ONE
 *     truth table (test/fixtures/release_identity/truth_table.json, built by the
 *     helper gate 1 uses), each as a checkout AND as a `git archive`-extracted
 *     tree: bash says exactly what the engine's readReleaseIdentityOf says of
 *     the same directory, and what the table says. Then the evidence the table
 *     does not vary: legacy stamps × install channel, a dev-channel archive of a
 *     tag (Q5), no git, a git that never answers (bounded), an inherited GIT_DIR,
 *     a translated git.
 *  B. GRAMMAR — `.dedalo.env DEDALO_VERSION` / `--version` (dedalo_version_grammar,
 *     and dedalo_env_problems over a real file) accepts exactly the image tags
 *     identityOfImageTag accepts; dedalo_identity_grammar exactly the identities
 *     parseReleaseVersion accepts; the two spellings map as imageTagOf maps them.
 *  C. ORDER — dedalo_identity_cmp is driven by test/fixtures/release_identity/
 *     ordering.json, the SAME file the engine's and the changelog's comparators
 *     are held to: every ascending pair both ways, each dev identity strictly below its stable, every
 *     non-identity refused (status 2). dedalo_version_cmp orders image tags as
 *     their identities.
 *  D. deploy/deploy.sh (design map, deploy.sh:83-84) refuses a release ref the
 *     tree cannot call itself (a lightweight tag) before restarting anything.
 *
 * DB-free; spawns bash + git + tar: hermetic tier.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_INFO_PATH, readReleaseIdentityOf } from '../../src/core/update/build_stamp.ts';
import {
	compareReleaseIdentities,
	identityOfImageTag,
	imageTagOf,
	parseReleaseVersion,
} from '../../src/core/update/release_identity.ts';
import {
	REAL_PLACEHOLDER,
	releaseTrees,
	TRUTH_TABLE,
	VERSION_TS_PATH,
	versionTsOf,
} from '../helpers/release_identity_trees.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const LIB = join(REPO_ROOT, 'deploy', 'dedalo-image-lib.sh');
const ORDERING = JSON.parse(
	readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'release_identity', 'ordering.json'), 'utf8'),
) as {
	ascending: string[];
	dev: string[];
	dev_below_stable: [string, string][];
	not_identities: string[];
};

const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo-identity-shell-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const trees = releaseTrees(SCRATCH);
const TRIPLE = TRUTH_TABLE.triple;

/** A PATH with git on it (the developer's and the CI image's places). */
const PATH_WITH_GIT = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
const BASH = Bun.which('bash', { PATH: PATH_WITH_GIT }) as string;

/**
 * A PATH holding every tool the library uses EXCEPT git (git sits in /usr/bin
 * beside them, so a PATH cannot simply omit a directory).
 */
const NO_GIT_PATH = (() => {
	const dir = join(SCRATCH, 'no_git_bin');
	mkdirSync(dir);
	for (const tool of [
		'cat',
		'tr',
		'grep',
		'head',
		'tail',
		'sed',
		'mktemp',
		'date',
		'rm',
		'sleep',
		'dirname',
	]) {
		const found = Bun.which(tool, { PATH: PATH_WITH_GIT });
		if (found !== null) symlinkSync(found, join(dir, tool));
	}
	return dir;
})();

interface BashRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run `body` under `set -euo pipefail` with the library sourced; `$1…` = args. */
function bash(
	body: string,
	options: { args?: string[]; env?: Record<string, string>; cwd?: string } = {},
): BashRun {
	const run = Bun.spawnSync(
		[
			BASH,
			'-c',
			`set -euo pipefail\n. ${JSON.stringify(LIB)}\n${body}`,
			'lib',
			...(options.args ?? []),
		],
		{
			cwd: options.cwd ?? SCRATCH,
			env: { PATH: PATH_WITH_GIT, HOME: SCRATCH, ...options.env },
		},
	);
	return {
		code: run.exitCode ?? -1,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
}

/** The shell twin's identity of `tree`; null when it refused (status ≠ 0). */
function shellIdentity(tree: string, env: Record<string, string> = {}): string | null {
	const run = bash('dedalo_release_identity "$1"', { args: [tree], env });
	return run.code === 0 ? run.stdout : null;
}

function engineIdentity(tree: string, git?: string) {
	return readReleaseIdentityOf(tree, { triple: TRIPLE, ...(git === undefined ? {} : { git }) });
}

// ---------------------------------------------------------------------------
// A. The identity of real trees
// ---------------------------------------------------------------------------

describe('A. dedalo_release_identity ≡ readReleaseIdentityOf over the shared truth table', () => {
	test('the table is a real one (anti-vacuity): every kind, several dev causes', () => {
		const kinds = new Set(TRUTH_TABLE.rows.map((row) => row.kind));
		expect([...kinds].sort()).toEqual(['dev', 'prerelease', 'stable']);
		expect(TRUTH_TABLE.rows.filter((row) => row.kind === 'dev').length).toBeGreaterThanOrEqual(5);
	});

	for (const row of TRUTH_TABLE.rows) {
		describe(row.name, () => {
			const repo = trees.repoWith(row.name, row.steps);

			test(`checkout → ${row.version}, as the engine says`, async () => {
				const engine = await engineIdentity(repo);
				expect(engine.version).toBe(row.version);
				expect(shellIdentity(repo)).toBe(engine.version);
			});

			test(`git-archive-extracted → ${row.version}, as the engine says (no git asked)`, async () => {
				const tree = trees.archiveOf(repo);
				const engine = await engineIdentity(tree, join(SCRATCH, 'no-such-git'));
				expect(engine.version).toBe(row.version);
				// no git on PATH at all: an archive judges from its stamp alone
				expect(shellIdentity(tree, { PATH: NO_GIT_PATH })).toBe(engine.version);
			});
		});
	}

	test('CONTROL (C3i-F1): an archive of v7.0.0-beta.6 never says 7.0.0 — not even on the master channel', async () => {
		const tree = trees.archiveOf(
			trees.repoWith('control', [{ tag: 'v7.0.0-beta.6', annotated: true }]),
		);
		trees.stampChannel(tree, 'master');
		expect(shellIdentity(tree)).toBe('7.0.0-beta.6');
		expect((await engineIdentity(tree)).version).toBe('7.0.0-beta.6');
	});

	describe('rules 4/5 — the install channel', () => {
		const LEGACY = 'a334a7b6e05f0c1d2e3f4a5b6c7d8e9f00112233 2026-08-23T10:15:00+02:00\n';
		const cases: [string, string, 'master' | 'dev' | null | 'bad_digest'][] = [
			['legacy stamp, unstamped install', LEGACY, null],
			['legacy stamp, master channel', LEGACY, 'master'],
			['legacy stamp, dev channel', LEGACY, 'dev'],
			['legacy stamp, a dev stamp whose digest is not trusted', LEGACY, 'bad_digest'],
			[
				'untagged three-field stamp (the trailing space), master channel',
				'a334a7b6e05f 2026-08-23T10:15:00+02:00 \n',
				'master',
			],
			[
				'exact tag, DEV channel (Q5: the tag wins)',
				'a334a7b6e05f 2026-08-23T10:15:00+02:00 v7.0.0-rc.2\n',
				'dev',
			],
			[
				'an old git left the describe field unexpanded',
				'a334a7b6e05f 2026-08-23T10:15:00+02:00 %(describe:match=v[0-9]*,abbrev=40)\n',
				null,
			],
			[
				'leading blank lines and a CRLF',
				'\n\n  a334a7b6e05f 2026-08-23T10:15:00+02:00 v7.0.0\r\n',
				null,
			],
			['malformed stamp', 'not a stamp at all\n', null],
		];
		const expected = new Map<string, string>([
			['legacy stamp, unstamped install', '7.0.0'],
			['legacy stamp, master channel', '7.0.0'],
			['legacy stamp, dev channel', '7.0.0-dev'],
			['legacy stamp, a dev stamp whose digest is not trusted', '7.0.0'],
			['untagged three-field stamp (the trailing space), master channel', '7.0.0-dev'],
			['exact tag, DEV channel (Q5: the tag wins)', '7.0.0-rc.2'],
			['an old git left the describe field unexpanded', '7.0.0-dev'],
			['leading blank lines and a CRLF', '7.0.0'],
			['malformed stamp', '7.0.0-dev'],
		]);
		for (const [name, stamp, channel] of cases) {
			test(`${name} → ${expected.get(name)}`, async () => {
				const tree = trees.scratch('stamp');
				mkdirSync(join(tree, 'src', 'core', 'update'), { recursive: true });
				writeFileSync(join(tree, BUILD_INFO_PATH), stamp);
				writeFileSync(join(tree, VERSION_TS_PATH), versionTsOf(TRIPLE));
				if (channel === 'bad_digest') {
					writeFileSync(
						join(tree, 'src', 'core', 'update', 'install_stamp.json'),
						JSON.stringify({ digest: 'not-a-digest', channel: 'dev' }),
					);
				} else if (channel !== null) trees.stampChannel(tree, channel);
				const engine = (await engineIdentity(tree)).version;
				expect(engine).toBe(expected.get(name) as string);
				expect(shellIdentity(tree)).toBe(engine);
			});
		}
	});

	test('no .git: a tree holding the placeholder is .dev — nothing to ask', async () => {
		const tree = trees.scratch('no_git');
		mkdirSync(join(tree, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(tree, BUILD_INFO_PATH), REAL_PLACEHOLDER);
		writeFileSync(join(tree, VERSION_TS_PATH), versionTsOf(TRIPLE));
		expect((await engineIdentity(tree)).version).toBe('7.0.0-dev');
		expect(shellIdentity(tree)).toBe('7.0.0-dev');
	});

	test('a tree that declares no version is refused (status 1), never given an identity', () => {
		const tree = trees.scratch('no_version');
		expect(bash('dedalo_release_identity "$1"', { args: [tree] }).code).toBe(1);
	});

	test('no git binary: a checkout is .dev (the control: with git it is the tag)', async () => {
		const repo = trees.repoWith('no_git_binary', [{ tag: 'v7.0.0', annotated: true }]);
		expect(shellIdentity(repo)).toBe('7.0.0');
		expect(shellIdentity(repo, { PATH: NO_GIT_PATH })).toBe(
			(await engineIdentity(repo, join(SCRATCH, 'no-such-git'))).version,
		);
		expect(shellIdentity(repo, { PATH: NO_GIT_PATH })).toBe('7.0.0-dev');
	});

	test('a git that never answers is BOUNDED (≈ 3 s): .dev, even when it leaves a grandchild holding its pipes', () => {
		const repo = trees.repoWith('hung_git', [{ tag: 'v7.0.0', annotated: true }]);
		const bin = trees.scratch('hung_bin');
		const pidFile = join(bin, 'grandchild.pid');
		writeFileSync(
			join(bin, 'git'),
			`#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\nexec sleep 30\n`,
		);
		chmodSync(join(bin, 'git'), 0o755);
		const started = performance.now();
		try {
			expect(shellIdentity(repo, { PATH: `${bin}:${NO_GIT_PATH}` })).toBe('7.0.0-dev');
			const elapsed = performance.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(2900);
			expect(elapsed).toBeLessThan(7000);
		} finally {
			try {
				process.kill(Number.parseInt(readFileSync(pidFile, 'utf8'), 10), 'SIGKILL');
			} catch {
				// already gone
			}
		}
	}, 15_000);

	test('an inherited GIT_DIR does not make the checkout describe ANOTHER repository', () => {
		const tagged = trees.repoWith('foreign_tagged', [{ tag: 'v7.0.0', annotated: true }]);
		const untagged = trees.repoWith('own_untagged', []);
		expect(shellIdentity(untagged, { GIT_DIR: join(tagged, '.git'), GIT_WORK_TREE: tagged })).toBe(
			'7.0.0-dev',
		);
		expect(shellIdentity(tagged, { GIT_DIR: join(untagged, '.git') })).toBe('7.0.0');
	});

	test("a TRANSLATED git's untagged answer is the normal untagged answer — and any other failure is too (.dev either way)", () => {
		const repo = trees.repoWith('translated', []);
		const bin = trees.scratch('translated_bin');
		writeFileSync(
			join(bin, 'git'),
			[
				'#!/bin/sh',
				'case "${LC_ALL:-${LC_MESSAGES:-${LANG:-C}}}" in',
				'  C|POSIX) echo "fatal: no tag exactly matches \'abc\'" >&2 ;;',
				'  *) echo "fatal: ninguna etiqueta coincide exactamente con \'abc\'" >&2 ;;',
				'esac',
				'exit 128',
				'',
			].join('\n'),
		);
		chmodSync(join(bin, 'git'), 0o755);
		const env = { PATH: `${bin}:${NO_GIT_PATH}`, LANG: 'es_ES.UTF-8', LC_ALL: 'es_ES.UTF-8' };
		expect(shellIdentity(repo, env)).toBe('7.0.0-dev');
		// the lookup ran in the C locale: the stub saw it and answered in English
		const said = bash('dedalo_checkout_describe "$1"; echo "status=$?"', { args: [repo], env });
		expect(said.stdout).toBe('status=0\n');
	});
});

// ---------------------------------------------------------------------------
// B. The grammars
// ---------------------------------------------------------------------------

/** Every string the grammars are judged over: both fixtures, both spellings, the edges. */
const CORPUS = [
	...new Set([
		...ORDERING.ascending,
		...ORDERING.not_identities,
		...ORDERING.dev_below_stable.flat(),
		...ORDERING.ascending.map((v) => `${v}-dev`),
		...ORDERING.ascending.map((v) => `${v}.dev`),
		'7.0.0-dev',
		'07.0.0-dev',
		'7.0.0-dev-dev',
		'7.0.0-DEV',
		'7.0.0-rc.1-dev',
		'v7.0.0-dev',
		'7.0.0-beta.6\n',
		'7.0.0 ',
		'99999999999999999999.0.0',
		'latest',
	]),
];

/** Run a predicate over the whole corpus in ONE bash: one line `0|1` per value. */
function bashVerdicts(predicate: string, values: readonly string[]): boolean[] {
	// NUL-separated: a value may hold a newline (and must then be refused).
	const raw = join(SCRATCH, `corpus_${predicate}.bin`);
	writeFileSync(raw, `${values.join('\0')}\0`);
	const run = bash(
		`while IFS= read -r -d '' v; do if ${predicate} "$v"; then echo 1; else echo 0; fi; done < "$1"`,
		{ args: [raw] },
	);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout
		.trim()
		.split('\n')
		.map((line) => line === '1');
}

describe('B. the grammars are the engine grammars', () => {
	test('the corpus accepts AND refuses (anti-vacuity)', () => {
		const accepted = CORPUS.filter((v) => identityOfImageTag(v) !== null).length;
		expect(accepted).toBeGreaterThan(20);
		expect(CORPUS.length - accepted).toBeGreaterThan(20);
	});

	test('image tag (DEDALO_VERSION, --version): dedalo_version_grammar ≡ identityOfImageTag !== null', () => {
		const verdicts = bashVerdicts('dedalo_version_grammar', CORPUS);
		expect(verdicts.length).toBe(CORPUS.length);
		CORPUS.forEach((value, i) => {
			expect({ value, bash: verdicts[i] }).toEqual({
				value,
				bash: identityOfImageTag(value) !== null,
			});
		});
	});

	test('identity: dedalo_identity_grammar ≡ parseReleaseVersion !== null', () => {
		const verdicts = bashVerdicts('dedalo_identity_grammar', CORPUS);
		CORPUS.forEach((value, i) => {
			expect({ value, bash: verdicts[i] }).toEqual({
				value,
				bash: parseReleaseVersion(value) !== null,
			});
		});
	});

	test('the spellings: dedalo_image_tag_of ≡ imageTagOf, dedalo_identity_of_tag ≡ identityOfImageTag', () => {
		const identities = CORPUS.filter((v) => parseReleaseVersion(v) !== null);
		const tags = CORPUS.filter((v) => identityOfImageTag(v) !== null);
		expect(identities.some((v) => v.endsWith('-dev'))).toBe(true);
		expect(tags.some((v) => v.endsWith('-dev'))).toBe(true);
		const run = bash(
			'for v in $1; do printf "%s\\n" "$(dedalo_image_tag_of "$v")"; done; echo --; for v in $2; do printf "%s\\n" "$(dedalo_identity_of_tag "$v")"; done',
			{ args: [identities.join(' '), tags.join(' ')] },
		);
		const [toTags, toIdentities] = run.stdout.split('--\n');
		expect((toTags ?? '').trim().split('\n')).toEqual(identities.map(imageTagOf));
		expect((toIdentities ?? '').trim().split('\n')).toEqual(
			tags.map((t) => identityOfImageTag(t) as string),
		);
	});

	test('.dedalo.env: dedalo_env_problems calls DEDALO_VERSION invalid exactly when the engine grammar refuses it', () => {
		const dir = trees.scratch('env');
		writeFileSync(join(dir, 'docker-compose.simple.yml'), 'services: {}\n');
		const sample = [
			'7.0.0',
			'7.0.0-beta.7',
			'7.0.1-rc.2',
			'7.0.0-alpha.0',
			'7.0.0-dev',
			'7.0.0.dev', // the retired spelling: refused
			'7.0.0-pre.1',
			'7.0.0-beta',
			'07.0.0',
			'7.0.0-beta.01',
		];
		for (const version of sample) {
			writeFileSync(
				join(dir, '.dedalo.env'),
				[
					'DEDALO_COMPOSE_FILE=docker-compose.simple.yml',
					'DEDALO_IMAGE=localhost/dedalo',
					`DEDALO_VERSION=${version}`,
					'DEDALO_IMAGE_MODE=build',
					'DEDALO_IMAGE_VERIFY=none',
					'',
				].join('\n'),
			);
			const said = bash('dedalo_env_problems .dedalo.env', { cwd: dir }).stdout;
			expect({ version, said }).toEqual({
				version,
				said: identityOfImageTag(version) === null ? 'DEDALO_VERSION invalid\n' : '',
			});
		}
	});
});

// ---------------------------------------------------------------------------
// C. The order — the ONE ordering fixture (gate 8's shell leg)
// ---------------------------------------------------------------------------

/** dedalo_identity_cmp (or another function) over many pairs in ONE bash: `<order> <status>` per pair. */
function bashOrders(
	fn: string,
	pairs: readonly [string, string][],
): { order: string; status: number }[] {
	const raw = join(SCRATCH, `pairs_${fn}.bin`);
	writeFileSync(raw, `${pairs.flat().join('\0')}\0`);
	const run = bash(
		`while IFS= read -r -d '' a && IFS= read -r -d '' b; do s=0; o="$(${fn} "$a" "$b")" || s=$?; printf '%s %s\\n' "\${o:-none}" "$s"; done < "$1"`,
		{ args: [raw] },
	);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout
		.trim()
		.split('\n')
		.map((line) => {
			const [order, status] = line.split(' ');
			return { order: order as string, status: Number(status) };
		});
}

describe('C. semver order: dedalo_identity_cmp is held to ordering.json', () => {
	const list = ORDERING.ascending;
	const pairs: [string, string][] = [];
	for (const a of list) for (const b of list) pairs.push([a, b]);

	test('every pair of the ascending list is ordered, both ways (and the engine agrees)', () => {
		const orders = bashOrders('dedalo_identity_cmp', pairs);
		expect(orders.length).toBe(list.length ** 2);
		pairs.forEach(([a, b], k) => {
			const expected = Math.sign(list.indexOf(a) - list.indexOf(b));
			expect({ a, b, ...orders[k] }).toEqual({ a, b, order: String(expected), status: 0 });
			expect(Math.sign(compareReleaseIdentities(a, b))).toBe(expected);
		});
	});

	test('a dev identity sorts strictly BELOW the stable of its triple (both ways)', () => {
		const devPairs = ORDERING.dev_below_stable.flatMap(([dev, stable]) => [
			[dev, stable] as [string, string],
			[stable, dev] as [string, string],
		]);
		expect(devPairs.length).toBeGreaterThan(0);
		// the pairs alternate dev-first (-1) and stable-first (1)
		bashOrders('dedalo_identity_cmp', devPairs).forEach((result, k) => {
			expect(result).toEqual({ order: k % 2 === 0 ? '-1' : '1', status: 0 });
		});
	});

	test('every non-identity is REFUSED (status 2, no order printed) — on either side', () => {
		const bad = ORDERING.not_identities.flatMap((v) => [
			[v, '7.0.0'] as [string, string],
			['7.0.0', v] as [string, string],
		]);
		const results = bashOrders('dedalo_identity_cmp', bad);
		results.forEach((result, k) => {
			expect({ pair: bad[k], ...result }).toEqual({ pair: bad[k], order: 'none', status: 2 });
		});
	});

	test('dedalo_version_cmp orders IMAGE TAGS as the identities they name (imageTagOf of the fixture)', () => {
		const tagPairs: [string, string][] = [
			...pairs.map(([a, b]) => [imageTagOf(a), imageTagOf(b)] as [string, string]),
			...ORDERING.dev_below_stable.map(
				([dev, stable]) => [imageTagOf(dev), stable] as [string, string],
			),
		];
		const results = bashOrders('dedalo_version_cmp', tagPairs);
		tagPairs.forEach(([a, b], k) => {
			const expected = Math.sign(
				compareReleaseIdentities(identityOfImageTag(a) as string, identityOfImageTag(b) as string),
			);
			expect({ a, b, ...results[k] }).toEqual({ a, b, order: String(expected), status: 0 });
		});
		// an identity's .dev spelling is no image tag
		expect(bashOrders('dedalo_version_cmp', [['7.0.0.dev', '7.0.0']])).toEqual([
			{ order: 'none', status: 2 },
		]);
	});
});

// ---------------------------------------------------------------------------
// D. deploy/deploy.sh: a release ref must BE that release
// ---------------------------------------------------------------------------

describe('D. deploy.sh refuses a release ref the tree cannot call itself, before restarting anything', () => {
	/**
	 * A checkout deploy over a stub `ssh` that runs the remote script HERE (bash -s,
	 * the assignments as its environment), stub `sudo`/`curl` and a stub pinned bun.
	 */
	function deployFixture(): { repo: string; bin: string; log: string; bun: string } {
		const root = trees.scratch('deploy');
		const bin = join(root, 'bin');
		const log = join(root, 'calls.log');
		mkdirSync(bin);
		const repo = trees.repoWith('deploy_repo', [], [7, 0, 1]);
		mkdirSync(join(repo, 'deploy'));
		writeFileSync(join(repo, 'deploy', 'dedalo-image-lib.sh'), readFileSync(LIB));
		writeFileSync(join(repo, '.bun-version'), '1.0.0\n');
		trees.git(repo, 'add', '-A');
		trees.git(repo, 'commit', '-q', '-m', 'deployable');
		const stubs: Record<string, string> = {
			ssh: '#!/bin/bash\nshift 3\nlast=$#\nset -- "${@:1:$((last - 1))}"\nexec env "$@" bash -s\n',
			sudo: `#!/bin/sh\necho "sudo $*" >> ${JSON.stringify(log)}\n`,
			curl: '#!/bin/sh\nexit 0\n',
			bun: '#!/bin/sh\n[ "$1" = --version ] && echo 1.0.0\nexit 0\n',
		};
		for (const [name, body] of Object.entries(stubs)) {
			writeFileSync(join(bin, name), body);
			chmodSync(join(bin, name), 0o755);
		}
		return { repo, bin, log, bun: join(bin, 'bun') };
	}

	function deploy(fixture: ReturnType<typeof deployFixture>, ref: string) {
		const run = Bun.spawnSync(
			[
				BASH,
				join(REPO_ROOT, 'deploy', 'deploy.sh'),
				'--host',
				'gate@localhost',
				'--ref',
				ref,
				'--app-dir',
				fixture.repo,
				'--bun',
				fixture.bun,
			],
			{
				env: {
					PATH: `${fixture.bin}:${PATH_WITH_GIT}`,
					HOME: SCRATCH,
					GIT_CONFIG_NOSYSTEM: '1',
				},
			},
		);
		let restarted = '';
		try {
			restarted = readFileSync(fixture.log, 'utf8');
		} catch {
			// never restarted
		}
		return {
			code: run.exitCode,
			out: `${run.stdout.toString()}${run.stderr.toString()}`,
			restarted,
			head: trees.git(fixture.repo, 'rev-parse', 'HEAD'),
		};
	}

	test('an ANNOTATED release tag is deployed, and named', () => {
		const fixture = deployFixture();
		trees.git(fixture.repo, 'tag', '-a', 'v7.0.1', '-m', 'v7.0.1');
		const result = deploy(fixture, 'v7.0.1');
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain('v7.0.1 is release identity 7.0.1');
		expect(result.out).toMatch(/GREEN at [0-9a-f]{40} \(7\.0\.1\)/);
		expect(result.restarted).toContain('systemctl restart');
	});

	test('a LIGHTWEIGHT release tag (the engine would run as 7.0.1-dev) is refused: nothing restarted, the checkout returned', () => {
		const fixture = deployFixture();
		const before = trees.git(fixture.repo, 'rev-parse', 'HEAD');
		trees.git(fixture.repo, 'commit', '-q', '--allow-empty', '-m', 'later');
		trees.git(fixture.repo, 'tag', 'v7.0.1');
		trees.git(fixture.repo, 'checkout', '-q', '--detach', before);
		const result = deploy(fixture, 'v7.0.1');
		expect(result.code).toBe(1);
		expect(result.out).toContain('it says 7.0.1-dev');
		expect(result.restarted).toBe('');
		expect(result.head).toBe(before);
	});

	test('a branch is not a release ref: deployed, named by its -dev identity', () => {
		const fixture = deployFixture();
		trees.git(fixture.repo, 'branch', 'feature-x');
		const result = deploy(fixture, 'feature-x');
		expect(result.code, result.out).toBe(0);
		expect(result.out).toContain('feature-x is release identity 7.0.1-dev');
	});
});
