/**
 * Server-side release BUILD (UPDATE_PROCESS Phase 4, WC-024) — the pure
 * refusal/planning half (`planCodeBuild`) exhaustively, plus ONE real
 * `git archive` integration drill in a TEMP git repo outside the repo tree.
 *
 * The GATE ORDER is the contract, not an implementation detail: code-server
 * flag → dirs → version → ref. Each order assertion feeds a bad value to a
 * LATER gate and proves the EARLIER refusal still wins.
 *
 * No DB. Needs `git` for the integration block; skips LOUDLY if absent.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as realConfigModule from '../../src/config/config.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { buildVersionFromGit } from '../../src/core/update/code_build.ts';
import {
	BUILD_INFO_TREE_PATH,
	newestPublishableTag,
	parseDeclaredTriple,
	placeholderNamesItsTag,
	planCodeBuild,
	prereleaseTagAbove,
	releaseTagIdentity,
	releaseTagsNewestFirst,
	releaseTagVersion,
} from '../../src/core/update/code_build_plan.ts';
import { MIN_GIT_FOR_DESCRIBE } from '../../src/core/update/release_identity.ts';
import { DEDALO_VERSION } from '../../src/core/update/version.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

// Snapshot the REAL config module ONCE at top level: mock.restore() does NOT
// revert mock.module, so afterAll must re-install it or the mocked config
// leaks into every other file of this suite.
const REAL_CONFIG = { ...realConfigModule };

const ROOT = scratchDir('code_build');

const OK_CFG = {
	isCodeServer: true,
	codeServerGitDir: '/g',
	codeFilesDir: '/f',
} as const;

let gitAvailable = false;
/** Known at DEFINITION time, so a git-less run SKIPS by name instead of passing empty. */
const GIT_PRESENT = Bun.spawnSync(['git', '--version'], {
	stdout: 'ignore',
	stderr: 'ignore',
}).success;

beforeAll(async () => {
	mkdirSync(ROOT, { recursive: true });
	const probe = Bun.spawn(['git', '--version'], { stdout: 'ignore', stderr: 'ignore' });
	gitAvailable = (await probe.exited) === 0;
});
afterAll(() => {
	mock.module('../../src/config/config.ts', () => REAL_CONFIG);
	mock.restore();
	rmSync(ROOT, { recursive: true, force: true });
});

/**
 * What makes a scratch repository's archives carry their release tag: THIS
 * repository's own build_info.txt placeholder and its export-subst rule — read
 * from the real files, so a drift in either reaches these gates. A tag build
 * reads the stamp back out of its archive and refuses one that does not call
 * itself the tag (code_build.ts refuseUnlessArchiveIsIdentity).
 */
const BUILD_INFO_PLACEHOLDER = readFileSync(
	join(import.meta.dir, '../../src/core/update/build_info.txt'),
	'utf8',
);
function writeReleaseStamp(repo: string): void {
	mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
	writeFileSync(join(repo, 'src', 'core', 'update', 'build_info.txt'), BUILD_INFO_PLACEHOLDER);
	writeFileSync(join(repo, '.gitattributes'), 'src/core/update/build_info.txt export-subst\n');
}

/** Narrow to the refusal arm (and fail loudly, not silently, when it is not). */
function refusal(plan: ReturnType<typeof planCodeBuild>): { msg: string; error: string } {
	expect(plan.ok).toBe(false);
	if (plan.ok !== false) throw new Error('expected a refusal plan');
	return { msg: plan.msg, error: plan.error };
}

describe('planCodeBuild — gate order', () => {
	test('gate 1 wins: a non-code-server refuses before dirs/version/ref are looked at', () => {
		// every later gate is ALSO violated here; only the first message may show.
		const plan = planCodeBuild(
			{ version: 'x.y.z', ref: '--output=/tmp/evil' },
			{ isCodeServer: false, codeServerGitDir: undefined, codeFilesDir: undefined },
		);
		expect(refusal(plan)).toEqual({
			msg: 'Error. This instance is not a code server',
			error: 'not a code server',
		});
	});

	test('the flag is an identity check: a truthy non-true value still refuses', () => {
		const plan = planCodeBuild(
			{ version: '7.0.1' },
			{
				...OK_CFG,
				isCodeServer: 1 as unknown as boolean,
			},
		);
		expect(refusal(plan).error).toBe('not a code server');
	});

	test('gate 2 wins: missing dirs refuse before the (invalid) version is parsed', () => {
		const plan = planCodeBuild(
			{ version: 'x.y.z', ref: 'a;b' },
			{ isCodeServer: true, codeServerGitDir: undefined, codeFilesDir: '/f' },
		);
		expect(refusal(plan)).toEqual({
			msg: 'Error. Define DEDALO_CODE_SERVER_GIT_DIR and DEDALO_CODE_FILES_DIR to build releases',
			error: 'code build dirs unconfigured',
		});
	});

	test('gate 2 also fires when only the files dir is missing', () => {
		const plan = planCodeBuild(
			{ version: '7.0.1' },
			{ isCodeServer: true, codeServerGitDir: '/g', codeFilesDir: undefined },
		);
		expect(refusal(plan).error).toBe('code build dirs unconfigured');
	});

	test('gate 3 wins: an invalid version refuses before the (invalid) ref', () => {
		const plan = planCodeBuild({ version: 'x.y.z', ref: '--output=/tmp/evil' }, OK_CFG);
		expect(refusal(plan)).toEqual({
			msg: 'Error. Invalid version number',
			error: 'invalid version: x.y.z',
		});
	});

	test('gate 4 is last: a valid version with an invalid ref reports the ref', () => {
		const plan = planCodeBuild({ version: '7.0.1', ref: '--output=/tmp/evil' }, OK_CFG);
		expect(refusal(plan)).toEqual({
			msg: 'Error. Invalid git ref',
			error: 'invalid ref: --output=/tmp/evil',
		});
	});
});

describe('planCodeBuild — version guard', () => {
	for (const bad of ['7.0', '7.0.1.2', 'x.y.z', '7.0.-1', '', '7.0.1.1.dev', '7.0.1x', '7.0.1.5']) {
		test(`rejects version ${JSON.stringify(bad)}`, () => {
			const plan = planCodeBuild({ version: bad, ref: 'main' }, OK_CFG);
			expect(refusal(plan)).toEqual({
				msg: 'Error. Invalid version number',
				error: `invalid version: ${bad}`,
			});
		});
	}

	test("accepts '7.0.1' from its release tag and builds the confined PUBLISHED path", () => {
		const plan = planCodeBuild({ version: '7.0.1', ref: 'refs/tags/v7.0.1' }, OK_CFG);
		expect(plan.ok).toBe(true);
		if (plan.ok !== true) throw new Error('expected an ok plan');
		expect(plan).toEqual({
			ok: true,
			gitDir: '/g',
			ref: 'refs/tags/v7.0.1',
			versionString: '7.0.1',
			identity: '7.0.1',
			targetDir: '/f/7/7.0',
			filePath: '/f/7/7.0/7.0.1.zip',
		});
	});

	test('release channel: only a vX.Y.Z release TAG claims the published <v>.zip name', () => {
		// Policy 2026-09-29: a release is a tagged version; `master` is the
		// DEVELOPER channel. The published name is what code_manifest.ts
		// advertises; a branch build must NEVER overwrite it — any other ref
		// (master included) gets the -dev suffix (built, served, advertised only
		// on request).
		for (const tagRef of ['v7.0.1', 'refs/tags/v7.0.1']) {
			const plan = planCodeBuild({ version: '7.0.1', ref: tagRef }, OK_CFG);
			if (plan.ok !== true) throw new Error('expected an ok plan');
			expect(plan.filePath).toBe('/f/7/7.0/7.0.1.zip');
		}
		for (const devRef of [
			'master',
			'refs/heads/master',
			'main',
			'v7',
			'refs/heads/v7',
			'refs/heads/v7.0.1',
			'refs/heads/v7.0.1-beta.1',
			// not the shared grammar: a foreign label, a non-canonical number
			'v7.0.1-pre.1',
			'v7.0.1-beta.01',
			'7.0.1',
			'x/master',
		]) {
			const plan = planCodeBuild({ version: '7.0.1', ref: devRef }, OK_CFG);
			if (plan.ok !== true) throw new Error('expected an ok plan');
			expect(plan.filePath).toBe('/f/7/7.0/7.0.1-dev.zip');
			expect(plan.identity, devRef).toBeNull();
		}
	});

	test('a PRERELEASE tag claims its identity name beside the release (design §2.8 item 1)', () => {
		for (const [tagRef, identity] of [
			['v7.0.1-beta.1', '7.0.1-beta.1'],
			['refs/tags/v7.0.1-rc.12', '7.0.1-rc.12'],
			['v7.0.1-alpha.0', '7.0.1-alpha.0'],
		] as const) {
			const plan = planCodeBuild({ version: '7.0.1', ref: tagRef }, OK_CFG);
			if (plan.ok !== true) throw new Error(`expected an ok plan for ${tagRef}`);
			expect(plan.identity).toBe(identity);
			// same <X>/<X.Y>/ dir as the release; never the release's own name
			expect(plan.targetDir).toBe('/f/7/7.0');
			expect(plan.filePath).toBe(`/f/7/7.0/${identity}.zip`);
		}
		// the tag names its DATA triple, and it must be the bytes' own
		const lying = planCodeBuild({ version: '7.0.1', ref: 'refs/tags/v7.0.2-beta.1' }, OK_CFG);
		expect(refusal(lying).error).toBe('tag/version mismatch: refs/tags/v7.0.2-beta.1 vs 7.0.1');
	});

	test("accepts the prerelease form '7.0.1.dev' and normalises it to '7.0.1'", () => {
		const plan = planCodeBuild({ version: '7.0.1.dev', ref: 'refs/tags/v7.0.1' }, OK_CFG);
		if (plan.ok !== true) throw new Error('expected an ok plan');
		expect(plan.versionString).toBe('7.0.1');
		expect(plan.filePath).toBe('/f/7/7.0/7.0.1.zip');
		// the DEFAULT ref is the NORMALISED version's release tag
		const defaulted = planCodeBuild({ version: '7.0.1.dev' }, OK_CFG);
		if (defaulted.ok !== true) throw new Error('expected an ok plan');
		expect(defaulted.ref).toBe('refs/tags/v7.0.1');
	});

	// FOUND, NOT FIXED (moved faithfully): `parseVersionString` maps segments
	// through `Number`, which coerces '' → 0 and trims whitespace. So sloppy
	// version strings are silently ACCEPTED and normalised. Pinned here so the
	// quirk cannot change unnoticed; it is not exploitable — the release path is
	// rebuilt from the parsed integer triple, never from the raw input.
	for (const [sloppy, normalised] of [
		['7..1', '7.0.1'],
		['7. 0 .1', '7.0.1'],
		['7.0.1e0', '7.0.1'],
	] as const) {
		test(`quirk: ${JSON.stringify(sloppy)} is accepted and normalised to ${normalised}`, () => {
			// explicit ref: some of these sloppy strings are not valid git refs,
			// and the ref gate would otherwise mask the version behaviour.
			const plan = planCodeBuild({ version: sloppy, ref: 'refs/tags/v7.0.1' }, OK_CFG);
			if (plan.ok !== true) throw new Error('expected an ok plan');
			expect(plan.versionString).toBe(normalised);
			expect(plan.filePath).toBe(`/f/7/7.0/${normalised}.zip`);
		});
	}

	test('a multi-digit / zero triple lands in the right major.minor directory', () => {
		// omitted ref defaults to the version's release tag — the published name
		const plan = planCodeBuild({ version: '10.12.0' }, OK_CFG);
		if (plan.ok !== true) throw new Error('expected an ok plan');
		expect(plan.targetDir).toBe('/f/10/10.12');
		expect(plan.filePath).toBe('/f/10/10.12/10.12.0.zip');
	});

	test('a release tag whose name disagrees with its declared version is REFUSED', () => {
		// v7.0.2 cut on a commit still declaring 7.0.1: neither name is honest
		const plan = planCodeBuild({ version: '7.0.1', ref: 'refs/tags/v7.0.2' }, OK_CFG);
		expect(refusal(plan).error).toBe('tag/version mismatch: refs/tags/v7.0.2 vs 7.0.1');
	});
});

describe('planCodeBuild — git ref allowlist (CMD-05)', () => {
	for (const bad of [
		'--output=/tmp/evil',
		'-o',
		'a;b',
		'a b',
		'a$(x)',
		'',
		'a|b',
		'a&b',
		'a`b`',
		'-main',
		'.'.repeat(0) + 'x'.repeat(201),
	]) {
		test(`rejects ref ${JSON.stringify(bad.length > 40 ? `${bad.length}-char ref` : bad)}`, () => {
			const plan = planCodeBuild({ version: '7.0.1', ref: bad }, OK_CFG);
			expect(refusal(plan)).toEqual({
				msg: 'Error. Invalid git ref',
				error: `invalid ref: ${bad}`,
			});
		});
	}

	for (const good of ['main', 'refs/heads/v7', 'master', 'release-7.0.1', 'x'.repeat(200)]) {
		test(`accepts ref ${good.length > 40 ? `${good.length}-char ref` : JSON.stringify(good)}`, () => {
			const plan = planCodeBuild({ version: '7.0.1', ref: good }, OK_CFG);
			if (plan.ok !== true) throw new Error('expected an ok plan');
			expect(plan.ref).toBe(good);
			// the ref selects ONLY the channel suffix — no ref bytes in the path
			expect(plan.filePath).toBe('/f/7/7.0/7.0.1-dev.zip');
		});
	}

	test("'refs/heads/../../x' is ACCEPTED BY DESIGN — the ref is never used as a path", () => {
		// Not a traversal hole: the ref is only handed to `git archive` as a ref
		// to resolve; the output path is derived solely from the version triple.
		const plan = planCodeBuild({ version: '7.0.1', ref: 'refs/heads/../../x' }, OK_CFG);
		if (plan.ok !== true) throw new Error('expected an ok plan');
		expect(plan.ref).toBe('refs/heads/../../x');
		expect(plan.filePath).toBe('/f/7/7.0/7.0.1-dev.zip');
	});

	test('an empty explicit ref does NOT fall back to the version (?? not ||)', () => {
		const plan = planCodeBuild({ version: '7.0.1', ref: '' }, OK_CFG);
		expect(refusal(plan).error).toBe('invalid ref: ');
	});

	test("an omitted ref defaults to the version's release tag", () => {
		const plan = planCodeBuild({ version: '7.0.1' }, OK_CFG);
		if (plan.ok !== true) throw new Error('expected an ok plan');
		expect(plan.ref).toBe('refs/tags/v7.0.1');
	});
});

describe('release tag helpers', () => {
	test('releaseTagVersion accepts only stable vX.Y.Z tags', () => {
		expect(releaseTagVersion('v7.0.1')).toBe('7.0.1');
		expect(releaseTagVersion('refs/tags/v10.2.30')).toBe('10.2.30');
		for (const not of [
			'7.0.1',
			'v7.0.1-beta.5',
			'v7.0',
			'refs/heads/v7.0.1',
			'master',
			'v7',
			// non-canonical: would re-qualify as a refs/tags/v7.0.2 that does not exist
			'v07.0.2',
			'v7.00.1',
		]) {
			expect(releaseTagVersion(not), not).toBeNull();
		}
	});

	test('releaseTagIdentity reads stable AND prerelease tags through the shared grammar', () => {
		expect(releaseTagIdentity('v7.0.1')).toBe('7.0.1');
		expect(releaseTagIdentity('refs/tags/v7.0.1-beta.12')).toBe('7.0.1-beta.12');
		expect(releaseTagVersion('v7.0.1-beta.12')).toBeNull(); // the RELEASE channel's rule
		for (const not of [
			'v7.0.1-pre.1',
			'v7.0.1-beta',
			'v7.0.1-beta.01',
			'v7.0.1.dev',
			'refs/heads/v7.0.1-beta.1',
			'7.0.1-beta.1',
		]) {
			expect(releaseTagIdentity(not), not).toBeNull();
		}
	});

	test('releaseTagsNewestFirst orders by SEMVER precedence (compareReleaseIdentities), never lexically', () => {
		const tags = [
			'v6.9.7',
			'v7.10.0',
			'v7.9.3',
			'v8.0.0-beta.1',
			'v7.0.0-alpha.1',
			'v7.0.0-beta.9',
			'v7.0.0-beta.10',
			'v7.0.0-rc.1',
			'v7.0.0',
			'v7', // no release identity
			'v7.0.0-pre.1', // foreign label
		];
		expect(releaseTagsNewestFirst(tags)).toEqual([
			'v8.0.0-beta.1',
			'v7.10.0',
			'v7.9.3',
			'v7.0.0',
			'v7.0.0-rc.1',
			'v7.0.0-beta.10',
			'v7.0.0-beta.9',
			'v7.0.0-alpha.1',
			'v6.9.7',
		]);
		expect(releaseTagsNewestFirst(tags, 'stable')).toEqual([
			'v7.10.0',
			'v7.9.3',
			'v7.0.0',
			'v6.9.7',
		]);
		expect(releaseTagsNewestFirst(tags, 'prerelease')).toEqual([
			'v8.0.0-beta.1',
			'v7.0.0-rc.1',
			'v7.0.0-beta.10',
			'v7.0.0-beta.9',
			'v7.0.0-alpha.1',
		]);
	});

	test('prereleaseTagAbove: only a prerelease above the newest release is built', () => {
		expect(prereleaseTagAbove('v7.0.1-beta.2', 'v7.0.0')).toBe('v7.0.1-beta.2');
		expect(prereleaseTagAbove('v7.0.0-beta.6', null)).toBe('v7.0.0-beta.6'); // no release yet
		// superseded: the release of its own triple, or a newer one, exists
		expect(prereleaseTagAbove('v7.0.1-rc.1', 'v7.0.1')).toBeNull();
		expect(prereleaseTagAbove('v7.0.0-rc.9', 'v7.0.1')).toBeNull();
		expect(prereleaseTagAbove(null, 'v7.0.1')).toBeNull();
		// a stable tag is never "a prerelease"
		expect(prereleaseTagAbove('v7.0.2', 'v7.0.1')).toBeNull();
	});

	test('placeholderNamesItsTag: only a placeholder carrying the describe field names its tag', async () => {
		const { BUILD_INFO_PATH } = await import('../../src/core/update/build_stamp.ts');
		expect(BUILD_INFO_TREE_PATH).toBe(BUILD_INFO_PATH);
		// the real committed placeholder names its tag
		expect(placeholderNamesItsTag(BUILD_INFO_PLACEHOLDER)).toBe(true);
		expect(placeholderNamesItsTag('$Format:%H %cI %(describe)$\n')).toBe(true);
		// the legacy two-field placeholder (every pre-stamp tag) and garbage do not
		expect(placeholderNamesItsTag('$Format:%H %cI$\n')).toBe(false);
		expect(placeholderNamesItsTag('')).toBe(false);
		expect(placeholderNamesItsTag('$Format:%H %cI$\n%(describe)\n')).toBe(false);
		expect(placeholderNamesItsTag('$Format:%H %cI %(describer)$')).toBe(false);
	});

	test('newestPublishableTag skips tags whose tree is not this engine (the v6 case)', () => {
		// THIS repository while v7 is in beta: every v7 tag is a prerelease, so the
		// newest STABLE tag is the PHP-era v6.9.7 — which must never surface.
		const engineTrees = new Set(['v7.0.1']);
		const isEngineTree = (tag: string) => engineTrees.has(tag);
		expect(newestPublishableTag(['v6.9.7', 'v7.0.0-beta.5'], isEngineTree)).toBeNull();
		expect(newestPublishableTag(['v6.9.7', 'v7.0.1', 'v7.0.0-beta.5'], isEngineTree)).toBe(
			'v7.0.1',
		);
		expect(newestPublishableTag([], isEngineTree)).toBeNull();
	});
});

describe('buildVersionFromGit — rewired to planCodeBuild', () => {
	test('the refusal gates are GONE from code_build.ts (no un-wired revert)', () => {
		const source = readFileSync(
			join(import.meta.dir, '../../src/core/update/code_build.ts'),
			'utf8',
		);
		// the moved inline logic must not exist here any more…
		expect(source).not.toContain('GIT_REF_RE');
		expect(source).not.toContain('parseVersionString');
		expect(source).not.toContain('not a code server');
		expect(source).not.toContain('code build dirs unconfigured');
		expect(source).not.toContain('Invalid version number');
		expect(source).not.toContain('unconfined release path');
		// …and the call site must actually run the extraction. The options object
		// is now BUILT (the version is derived from the ref's own bytes before
		// planning, see parseDeclaredTriple), so the call no longer forwards
		// `options` verbatim — what matters is that planCodeBuild is what
		// decides, and that the ref allowlist is still the planner's ONE copy.
		expect(source).toContain("from './code_build_plan.ts'");
		expect(source).toContain('planCodeBuild(');
		expect(source).toContain('isSafeGitRef(');
	});

	test('the refusal path THROWS the registered update.refused code (P1 sweep)', async () => {
		// The first gate is asserted against a MOCKED non-code-server config, not
		// against the ambient one: reading `realConfigModule.config` made the gate
		// depend on the developer's own `../private/.env` and turned this case red
		// on any machine actually set up as a code master (2026-08-16).
		mock.module('../../src/config/config.ts', () => ({
			...REAL_CONFIG,
			config: {
				...REAL_CONFIG.config,
				update: { ...REAL_CONFIG.config.update, isCodeServer: false },
			},
		}));
		try {
			const error = await buildVersionFromGit({ version: '7.0.1' }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(isDedaloError(error)).toBe(true);
			expect((error as { code: string }).code).toBe('update.refused');
			// the operator sentence reaches the wire (update.refused is public-disclosure)
			expect((error as { publicMessage?: string }).publicMessage).toBe(
				'Error. This instance is not a code server',
			);
			// the machine detail stays LOG-side only
			expect((error as Error).message).toContain('not a code server');
		} finally {
			mock.module('../../src/config/config.ts', () => REAL_CONFIG);
		}
	});
});

describe('buildVersionFromGit — real git archive', () => {
	test('archives a tag into a confined zip with a sha256 sidecar', async () => {
		if (!gitAvailable) {
			console.warn('[UNCOVERED] git is absent — code_build git-archive drill NOT executed');
			return;
		}
		const base = join(ROOT, 'ok');
		const repo = join(base, 'repo');
		const filesDir = join(base, 'files');
		mkdirSync(repo, { recursive: true });
		mkdirSync(filesDir, { recursive: true });
		writeFileSync(join(repo, 'package.json'), '{"name":"dedalo"}');
		writeReleaseStamp(repo);
		const git = async (...args: string[]) => {
			const child = Bun.spawn(['git', '-C', repo, ...args], {
				stdout: 'ignore',
				stderr: 'pipe',
				env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
			});
			const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
		};
		await git('init', '-q');
		await git('config', 'user.email', 'test@dedalo.dev');
		await git('config', 'user.name', 'test');
		await git('add', '-A');
		await git('commit', '-q', '-m', 'seed');
		// the PUBLISHED channel is a release TAG; `master` is the developer channel
		await git('branch', '-M', 'master');
		await git('tag', '-a', '-m', 'release', 'v7.0.1');

		try {
			mock.module('../../src/config/config.ts', () => ({
				...REAL_CONFIG,
				config: {
					...REAL_CONFIG.config,
					update: {
						...REAL_CONFIG.config.update,
						isCodeServer: true,
						codeServerGitDir: repo,
						codeFilesDir: filesDir,
					},
				},
			}));

			const out = await buildVersionFromGit({ version: '7.0.1', channel: 'master' });
			expect(out.ok).toBe(true);

			const expected = join(filesDir, '7', '7.0', '7.0.1.zip');
			expect(out.file_path).toBe(expected);
			const zip = readFileSync(expected);
			expect(zip.length).toBeGreaterThan(0);
			// the installer's required prefix is inside the archive
			expect(zip.toString('binary')).toContain('dedalo_code/package.json');
			expect(out.msg).toBe(`OK. Built release 7.0.1.zip (${zip.length} bytes)`);

			// WC-024 sidecar: "<sha256>  <file>\n"
			const { createHash } = await import('node:crypto');
			const digest = createHash('sha256').update(zip).digest('hex');
			expect(out.sha256).toBe(digest);
			expect(readFileSync(`${expected}.sha256`, 'utf8')).toBe(`${digest}  7.0.1.zip\n`);

			// a bad ref: refused by git itself, no sidecar written
			const bad = await buildVersionFromGit({ version: '7.0.2', ref: 'no-such-ref' }).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(isDedaloError(bad)).toBe(true);
			expect((bad as { code: string }).code).toBe('update.failed');
			expect((bad as { publicMessage?: string }).publicMessage).toBe('Error. git archive failed');
			// git's stderr is the LOG-side detail, never the wire sentence
			expect((bad as Error).message).toStartWith('git archive failed: ');
			expect((bad as Error).message.length).toBeGreaterThan('git archive failed: '.length);
			// non-tag ref → the artifact would be 7.0.2-dev.zip; no sidecar either way
			expect(existsSync(join(filesDir, '7', '7.0', '7.0.2-dev.zip.sha256'))).toBe(false);

			// the DEVELOPER channel archives `master` under the -dev name and
			// leaves the published archive of the same version untouched
			const publishedBefore = readFileSync(`${expected}.sha256`, 'utf8');
			await Bun.write(join(repo, 'dev.txt'), 'unreleased');
			await git('add', 'dev.txt');
			await git('commit', '-q', '-m', 'unreleased work');
			const dev = await buildVersionFromGit({ version: '7.0.1', channel: 'dev' });
			expect(dev.file_path).toBe(join(filesDir, '7', '7.0', '7.0.1-dev.zip'));
			expect(readFileSync(dev.file_path as string).toString('binary')).toContain(
				'dedalo_code/dev.txt',
			);
			expect(readFileSync(`${expected}.sha256`, 'utf8')).toBe(publishedBefore);
			expect(readFileSync(expected).toString('binary')).not.toContain('dedalo_code/dev.txt');
		} finally {
			mock.module('../../src/config/config.ts', () => REAL_CONFIG);
			mock.restore();
		}
	}, 60000);
});

describe('buildVersionFromGit — a git too old to stamp the release tag is refused', () => {
	test.if(GIT_PRESENT)(
		`a git older than ${MIN_GIT_FOR_DESCRIBE} refuses BEFORE anything is written; the minimum builds`,
		async () => {
			const base = join(ROOT, 'oldgit');
			const repo = join(base, 'repo');
			const filesDir = join(base, 'files');
			const bin = join(base, 'bin');
			mkdirSync(repo, { recursive: true });
			mkdirSync(filesDir, { recursive: true });
			mkdirSync(bin, { recursive: true });
			const realGit = Bun.which('git') as string;
			// The stub answers `git … --version` with STUB_GIT_VERSION; every other call is real git.
			writeFileSync(
				join(bin, 'git'),
				`#!/bin/sh\nfor a in "$@"; do [ "$a" = --version ] && { echo "$STUB_GIT_VERSION"; exit 0; }; done\nexec ${realGit} "$@"\n`,
				{ mode: 0o755 },
			);
			const gitEnv = {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			};
			const g = (...args: string[]) =>
				expect(Bun.spawnSync([realGit, '-C', repo, ...args], { env: gitEnv }).exitCode).toBe(0);
			writeFileSync(join(repo, 'package.json'), '{"name":"dedalo"}');
			writeReleaseStamp(repo);
			g('init', '-q', '-b', 'master');
			g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
			g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');
			g('-c', 'user.email=t@t', '-c', 'user.name=t', 'tag', '-a', '-m', 'release', 'v7.0.1');
			const savedPath = process.env.PATH;
			const savedVersion = process.env.STUB_GIT_VERSION;
			try {
				mock.module('../../src/config/config.ts', () => ({
					...REAL_CONFIG,
					config: {
						...REAL_CONFIG.config,
						update: {
							...REAL_CONFIG.config.update,
							isCodeServer: true,
							codeServerGitDir: repo,
							codeFilesDir: filesDir,
						},
					},
				}));
				process.env.PATH = `${bin}:${savedPath ?? '/usr/bin:/bin'}`;
				process.env.STUB_GIT_VERSION = 'git version 2.34.8';
				const refused = await buildVersionFromGit({ version: '7.0.1', channel: 'master' }).then(
					() => null,
					(caught: unknown) => caught,
				);
				expect(isDedaloError(refused)).toBe(true);
				expect((refused as { code: string }).code).toBe('update.refused');
				expect((refused as { publicMessage?: string }).publicMessage).toContain(
					`older than ${MIN_GIT_FOR_DESCRIBE}`,
				);
				expect((refused as Error).message).toContain('git 2.34 cannot expand %(describe');
				// Nothing provisioned, nothing archived.
				expect(existsSync(join(filesDir, '7'))).toBe(false);
				process.env.STUB_GIT_VERSION = `git version ${MIN_GIT_FOR_DESCRIBE}.0`;
				const built = await buildVersionFromGit({ version: '7.0.1', channel: 'master' });
				expect(built.ok).toBe(true);
				expect(existsSync(join(filesDir, '7', '7.0', '7.0.1.zip'))).toBe(true);
			} finally {
				process.env.PATH = savedPath;
				if (savedVersion === undefined) delete process.env.STUB_GIT_VERSION;
				else process.env.STUB_GIT_VERSION = savedVersion;
				mock.module('../../src/config/config.ts', () => REAL_CONFIG);
				mock.restore();
			}
		},
		60000,
	);
});

// ---------------------------------------------------------------------------
// A RELEASE IS NAMED AFTER ITS OWN BYTES.
//
// The build used to take the artifact's version from the RUNNING MASTER
// PROCESS (DEDALO_VERSION) while the bytes came from an independently chosen
// git ref, with nothing comparing the two. Two live consequences, both
// measured 2026-08-24 on the dev master:
//   - a master left running across a version bump keeps naming archives after
//     the OLD version, so <v>.zip holds a tree that is not version v;
//   - a master whose ref declares the version it ALREADY runs publishes a
//     same-version zip that assertLinearUpgrade refuses as a downgrade — an
//     uninstallable release produced by the button that exists to publish.
// ---------------------------------------------------------------------------
describe('the release channel builds the NEWEST release tag (policy 2026-09-29)', () => {
	test.skipIf(!GIT_PRESENT)(
		'no version asked: newest stable tag; no tag at all: refused (SKIPPED when git is absent)',
		async () => {
			const base = join(ROOT, 'tags');
			const repo = join(base, 'repo');
			const filesDir = join(base, 'files');
			mkdirSync(join(repo, 'src', 'core', 'update'), { recursive: true });
			mkdirSync(filesDir, { recursive: true });
			const git = async (...args: string[]) => {
				const child = Bun.spawn(['git', '-C', repo, ...args], {
					stdout: 'ignore',
					stderr: 'pipe',
					env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
				});
				const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
			};
			const commitVersion = async (triple: string) => {
				writeFileSync(
					join(repo, 'src', 'core', 'update', 'version.ts'),
					`export const V = Object.freeze([${triple.replaceAll('.', ', ')}]);\n`,
				);
				await git('add', '-A');
				await git('commit', '-q', '-m', triple);
			};
			await git('init', '-q');
			await git('config', 'user.email', 'test@dedalo.dev');
			await git('config', 'user.name', 'test');
			// the PHP-era history the real repository carries: a stable tag whose tree
			// has no version.ts — the newest STABLE tag while v7 is still in beta
			writeFileSync(join(repo, 'index.php'), '<?php');
			writeReleaseStamp(repo);
			await git('add', '-A');
			await git('commit', '-q', '-m', 'php era');
			await git('tag', 'v6.9.7');
			await commitVersion('7.0.1');
			await git('branch', '-M', 'master');

			try {
				mock.module('../../src/config/config.ts', () => ({
					...REAL_CONFIG,
					config: {
						...REAL_CONFIG.config,
						update: {
							...REAL_CONFIG.config.update,
							isCodeServer: true,
							codeServerGitDir: repo,
							codeFilesDir: filesDir,
						},
					},
				}));

				// only a v6 tag and a prerelease tag: NOTHING publishable (dev only)
				await git('tag', 'v7.0.1-beta.1');
				const none = await buildVersionFromGit({ channel: 'master' }).then(
					() => null,
					(caught: unknown) => caught,
				);
				expect((none as { code: string }).code).toBe('update.refused');
				expect((none as { publicMessage?: string }).publicMessage).toContain('No release tag');
				expect(existsSync(join(filesDir, '6'))).toBe(false);
				// …while the developer channel still builds
				const beta = await buildVersionFromGit({ channel: 'dev' });
				expect(beta.file_path).toBe(join(filesDir, '7', '7.0', '7.0.1-dev.zip'));

				// an ASKED tag that does not exist is named, before any dir or archive
				const missing = await buildVersionFromGit({ channel: 'master', version: '7.0.5' }).then(
					() => null,
					(caught: unknown) => caught,
				);
				expect((missing as { code: string }).code).toBe('update.refused');
				expect((missing as { publicMessage?: string }).publicMessage).toContain(
					'No release tag v7.0.5',
				);

				await git('tag', '-a', '-m', 'release', 'v7.0.1');
				await commitVersion('7.0.2');
				await git('tag', '-a', '-m', 'release', 'v7.0.2');
				await commitVersion('7.0.3'); // master moves on: never published
				const out = await buildVersionFromGit({ channel: 'master' });
				expect(out.file_path).toBe(join(filesDir, '7', '7.0', '7.0.2.zip'));

				// the dev channel is master's tip, named after master's own version
				const dev = await buildVersionFromGit({ channel: 'dev' });
				expect(dev.file_path).toBe(join(filesDir, '7', '7.0', '7.0.3-dev.zip'));

				// a tag whose bytes declare another version is refused
				await git('tag', 'v7.0.9');
				const lying = await buildVersionFromGit({ ref: 'v7.0.9' }).then(
					() => null,
					(caught: unknown) => caught,
				);
				expect((lying as { code: string }).code).toBe('update.refused');
				expect(existsSync(join(filesDir, '7', '7.0', '7.0.9.zip'))).toBe(false);
				expect(existsSync(join(filesDir, '7', '7.0', '7.0.3.zip'))).toBe(false);
			} finally {
				mock.module('../../src/config/config.ts', () => REAL_CONFIG);
				mock.restore();
			}
		},
		60000,
	);
});

describe('the release version comes from the ref, not the process', () => {
	test('parseDeclaredTriple reads both the committed and the bumped spelling', () => {
		// The committed source spreads the triple over three lines; a probe's
		// bump writes it on one. A substring match on one spelling silently
		// misreads the other (that exact bug half-wiped the probe museum).
		const committed = readFileSync(
			join(import.meta.dir, '../../src/core/update/version.ts'),
			'utf8',
		);
		expect(parseDeclaredTriple(committed)).toBe(DEDALO_VERSION);
		expect(parseDeclaredTriple('Object.freeze([7, 0, 4]) as [number, number, number]')).toBe(
			'7.0.4',
		);
		expect(parseDeclaredTriple('Object.freeze([\n\t8, 1, 12,\n])')).toBe('8.1.12');
		expect(parseDeclaredTriple('no triple here')).toBeNull();
	});

	test('the widget no longer names the artifact from the running process', () => {
		// The regression this whole change exists to prevent: if the widget ever
		// re-imports DEDALO_VERSION to default `version`, the process is naming
		// releases again.
		const widget = readFileSync(
			join(import.meta.dir, '../../src/core/area_maintenance/widgets/serve_code.ts'),
			'utf8',
		);
		// the slice must find its function: a moved handler made this pass on ''
		expect(widget).toContain('async function buildVersionOwned');
		const build = widget.slice(widget.indexOf('async function buildVersionOwned'));
		const body = build.slice(0, build.indexOf('\n}'));
		expect(body).not.toContain('DEDALO_VERSION');
	});

	test('the ref allowlist has exactly ONE definition', () => {
		// code_build.ts validates the ref before its pre-plan `git show` read;
		// that must reuse the planner's predicate, never re-declare the regex.
		const plan = readFileSync(
			join(import.meta.dir, '../../src/core/update/code_build_plan.ts'),
			'utf8',
		);
		const build = readFileSync(
			join(import.meta.dir, '../../src/core/update/code_build.ts'),
			'utf8',
		);
		expect(plan.match(/\[A-Za-z0-9\._\/\]\[A-Za-z0-9\._\/-\]/g)?.length ?? 0).toBe(1);
		expect(build).not.toContain('A-Za-z0-9');
	});
});

// ---------------------------------------------------------------------------
// GATE 13 (RELEASE_IDENTITY_DESIGN §3, §2.8 items 1 + 7): A PRERELEASE TAG IS A
// RELEASE. The code server builds it beside the stable release under its own
// identity name, the archive calls itself the tag (read back out of the bytes),
// a published identity is never rebuilt, a tag whose bytes are another version
// is refused — and a server RUNNING the current version builds and serves the
// NEXT triple's prerelease (it never has to run a beta to publish it).
// Real git, real archives, real serving resolver; config mocked to a scratch
// code server. Owner-gated by nothing here: the widget's gate is serve_code's.
// ---------------------------------------------------------------------------
describe('GATE 13 — prerelease builds: identity name, self-naming archive, immutability', () => {
	test.skipIf(!GIT_PRESENT)(
		'a server running X.Y.Z builds + serves X.Y.(Z+1)-beta.N; rebuild refused; lightweight / mismatched / superseded tags refused',
		async () => {
			const { DEDALO_VERSION_TRIPLE } = await import('../../src/core/update/version.ts');
			const { resolveCodeReleaseFile, serveCodeReleaseRequest } = await import(
				'../../src/core/update/code_serving.ts'
			);
			const { codeServerStatus } = await import('../../src/core/update/status.ts');
			const { parseBuildInfo, resolveReleaseIdentity } = await import(
				'../../src/core/update/release_identity.ts'
			);
			const { createHash } = await import('node:crypto');
			const { readdirSync, statSync } = await import('node:fs');
			const [major, minor, patch] = DEDALO_VERSION_TRIPLE;
			const RUNNING = `${major}.${minor}.${patch}`;
			const NEXT = `${major}.${minor}.${patch + 1}`;
			const AFTER = `${major}.${minor}.${patch + 2}`;
			const dir = `${major}/${major}.${minor}`;

			const base = join(ROOT, 'prerelease');
			const repo = join(base, 'repo');
			const filesDir = join(base, 'files');
			const releaseDir = join(filesDir, dir);
			mkdirSync(repo, { recursive: true });
			mkdirSync(filesDir, { recursive: true });
			const env = {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			};
			const git = (...args: string[]) => {
				const r = Bun.spawnSync(
					['git', '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
					{
						env,
						stdout: 'pipe',
						stderr: 'pipe',
					},
				);
				if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
				return r.stdout.toString().trim();
			};
			const commitVersion = (triple: string, note: string) => {
				writeFileSync(
					join(repo, 'src', 'core', 'update', 'version.ts'),
					`export const V = Object.freeze([${triple.replaceAll('.', ', ')}]);\n`,
				);
				writeFileSync(join(repo, 'note.txt'), note);
				git('add', '-A');
				git('commit', '-q', '-m', note);
			};
			const refusalOf = async (options: Parameters<typeof buildVersionFromGit>[0]) => {
				const caught = await buildVersionFromGit(options).then(
					() => null,
					(error: unknown) => error,
				);
				expect(isDedaloError(caught)).toBe(true);
				return caught as { code: string; publicMessage?: string; message: string };
			};
			const digestOf = (path: string) =>
				createHash('sha256').update(readFileSync(path)).digest('hex');
			const partials = () => readdirSync(releaseDir).filter((name) => name.includes('.partial'));
			const stampIn = (zip: string) =>
				Bun.spawnSync(['unzip', '-p', zip, 'dedalo_code/src/core/update/build_info.txt'], {
					stdout: 'pipe',
				}).stdout.toString();

			git('init', '-q', '-b', 'master');
			writeReleaseStamp(repo);
			commitVersion(RUNNING, 'the running release');
			git('tag', '-a', '-m', 'release', `v${RUNNING}`);
			commitVersion(NEXT, 'the next triple, in beta');
			git('tag', '-a', '-m', 'beta', `v${NEXT}-beta.1`);

			try {
				mock.module('../../src/config/config.ts', () => ({
					...REAL_CONFIG,
					config: {
						...REAL_CONFIG.config,
						update: {
							...REAL_CONFIG.config.update,
							isCodeServer: true,
							codeServerGitDir: repo,
							codeFilesDir: filesDir,
						},
					},
				}));
				const serving = { isCodeServer: true, codeFilesDir: filesDir };

				// Build release is UNCHANGED: the newest STABLE tag, never the newer beta.
				const stable = await buildVersionFromGit({ channel: 'master' });
				expect(stable.file_path).toBe(join(releaseDir, `${RUNNING}.zip`));

				// Build prerelease: the next triple's beta, named after its IDENTITY.
				const beta = await buildVersionFromGit({ channel: 'prerelease' });
				const betaZip = join(releaseDir, `${NEXT}-beta.1.zip`);
				expect(beta.file_path).toBe(betaZip);
				expect(beta.msg).toContain(`Built release ${NEXT}-beta.1.zip`);
				const digest = digestOf(betaZip);
				expect(beta.sha256).toBe(digest);
				expect(readFileSync(`${betaZip}.sha256`, 'utf8')).toBe(`${digest}  ${NEXT}-beta.1.zip\n`);
				// …and the archive CALLS ITSELF the tag, resolved as an installed engine resolves it
				const info = parseBuildInfo(stampIn(betaZip));
				expect(info.describe).toBe(`v${NEXT}-beta.1`);
				const said = resolveReleaseIdentity({
					triple: [major, minor, patch + 1],
					describe: info.describe,
					provenance: { stamp: 'other', channel: 'master' },
				});
				expect(said.version).toBe(`${NEXT}-beta.1`);
				expect(said.kind).toBe('prerelease');
				// The running engine is NOT that version (§2.8 item 7: the master never runs the beta).
				expect(RUNNING).not.toBe(NEXT);

				// SERVED at the URL grammar of its triple — bytes and sidecar.
				const url = `/dedalo/install/code/${NEXT}/${NEXT}-beta.1.zip`;
				expect(resolveCodeReleaseFile(url, serving)?.path).toBe(betaZip);
				expect(resolveCodeReleaseFile(`${url}.sha256`, serving)?.path).toBe(`${betaZip}.sha256`);
				const served = await serveCodeReleaseRequest(url, serving);
				expect(served.status).toBe(200);
				expect(
					createHash('sha256')
						.update(new Uint8Array(await served.arrayBuffer()))
						.digest('hex'),
				).toBe(digest);
				// never under a neighbour triple's dir
				expect(
					resolveCodeReleaseFile(`/dedalo/install/code/${RUNNING}/${NEXT}-beta.1.zip`, serving),
				).toBeNull();

				// IMMUTABLE: the same identity is never rebuilt; the bytes stay, nothing staged is left.
				const mtime = statSync(betaZip).mtimeMs;
				const again = await refusalOf({ channel: 'prerelease' });
				expect(again.code).toBe('update.refused');
				expect(again.publicMessage).toContain(`Release ${NEXT}-beta.1 is already published`);
				expect(digestOf(betaZip)).toBe(digest);
				expect(statSync(betaZip).mtimeMs).toBe(mtime);
				// …a stable release alike, and through an explicit ref too
				const stableDigest = digestOf(join(releaseDir, `${RUNNING}.zip`));
				expect((await refusalOf({ channel: 'master' })).publicMessage).toContain('immutable');
				expect((await refusalOf({ ref: `v${NEXT}-beta.1` })).publicMessage).toContain('immutable');
				expect(digestOf(join(releaseDir, `${RUNNING}.zip`))).toBe(stableDigest);
				expect(partials()).toEqual([]);

				// A LIGHTWEIGHT tag: its archive calls itself the previous tag / .dev — refused,
				// nothing published under its name, nothing staged left behind.
				commitVersion(NEXT, 'beta.2 work');
				git('tag', `v${NEXT}-beta.2`);
				const light = await refusalOf({ channel: 'prerelease' });
				expect(light.code).toBe('update.refused');
				expect(light.publicMessage).toContain(
					`The archive of tag v${NEXT}-beta.2 would not call itself ${NEXT}-beta.2`,
				);
				expect(light.publicMessage).toContain('ANNOTATED');
				expect(existsSync(join(releaseDir, `${NEXT}-beta.2.zip`))).toBe(false);
				expect(partials()).toEqual([]);
				git('tag', '-d', `v${NEXT}-beta.2`);

				// A tag naming ANOTHER triple than its bytes' version.ts: refused before any archive.
				git('tag', '-a', '-m', 'wrong', `v${AFTER}-beta.1`);
				const lying = await refusalOf({ channel: 'prerelease' });
				expect(lying.code).toBe('update.refused');
				expect(lying.publicMessage).toContain(`names version ${AFTER}`);
				expect(readdirSync(releaseDir).some((name) => name.startsWith(AFTER))).toBe(false);
				git('tag', '-d', `v${AFTER}-beta.1`);

				// An INTERRUPTED build's archive (no sidecar — never installable) is replaced.
				const orphan = join(releaseDir, `${NEXT}-beta.3.zip`);
				writeFileSync(orphan, 'half an archive');
				git('tag', '-a', '-m', 'beta', `v${NEXT}-beta.3`);
				const beta3 = await buildVersionFromGit({ channel: 'prerelease' });
				expect(beta3.file_path).toBe(orphan);
				expect(readFileSync(orphan).toString('binary')).toContain('dedalo_code/note.txt');
				expect(parseBuildInfo(stampIn(orphan)).describe).toBe(`v${NEXT}-beta.3`);

				// The PANEL reads the same rule and the same disk.
				const panel = codeServerStatus('https://example.test/dedalo/install/code');
				expect(panel.source.release_ref).toBe(`v${RUNNING}`);
				expect(panel.source.prerelease_ref).toBe(`v${NEXT}-beta.3`);
				expect(panel.source.prerelease_version).toBe(NEXT);
				const listed = panel.releases.find((release) => release.identity === `${NEXT}-beta.3`);
				expect(listed?.channel).toBe('prerelease');
				expect(listed?.version).toBe(NEXT);
				expect(listed?.url).toBe(
					`https://example.test/dedalo/install/code/${NEXT}/${NEXT}-beta.3.zip`,
				);

				// A PRE-STAMP tree (the legacy two-field placeholder every prerelease cut before
				// 2026-10-15 carries — v7.0.0-beta.6 among them): even ANNOTATED, its archive
				// cannot name itself. Never offered (the panel and the channel skip it — the
				// newest STAMPED beta stays the candidate), and an explicit build is refused
				// with the legacy reason — not the re-tagging advice, which cannot fix it.
				writeFileSync(join(repo, 'src', 'core', 'update', 'build_info.txt'), '$Format:%H %cI$\n');
				commitVersion(NEXT, 'a beta cut before the release stamp');
				git('tag', '-a', '-m', 'beta', `v${NEXT}-beta.4`);
				expect(
					codeServerStatus('https://example.test/dedalo/install/code').source.prerelease_ref,
				).toBe(`v${NEXT}-beta.3`);
				expect((await refusalOf({ channel: 'prerelease' })).publicMessage).toContain(
					`Release ${NEXT}-beta.3 is already published`,
				);
				const legacy = await refusalOf({ ref: `v${NEXT}-beta.4` });
				expect(legacy.code).toBe('update.refused');
				expect(legacy.publicMessage).toContain(
					`tag v${NEXT}-beta.4 predates the release-identity stamp`,
				);
				expect(legacy.publicMessage).not.toContain('ANNOTATED');
				expect(existsSync(join(releaseDir, `${NEXT}-beta.4.zip`))).toBe(false);
				expect(partials()).toEqual([]);
				git('tag', '-d', `v${NEXT}-beta.4`);
				writeReleaseStamp(repo);
				commitVersion(NEXT, 'the release stamp is back');

				// SUPERSEDED: once v<NEXT> is released, no beta of it (or below) is built.
				git('tag', '-a', '-m', 'release', `v${NEXT}`);
				const none = await refusalOf({ channel: 'prerelease' });
				expect(none.code).toBe('update.refused');
				expect(none.publicMessage).toContain('No prerelease to build');
				expect(
					codeServerStatus('https://example.test/dedalo/install/code').source.prerelease_ref,
				).toBeNull();
				expect(partials()).toEqual([]);

				// The read-back guards a STABLE tag as much as a prerelease: a LIGHTWEIGHT
				// v<AFTER> would publish an archive whose engine calls itself <AFTER>.dev
				// (its stamp describes past v<NEXT>) — refused through the channel and an
				// explicit ref alike, nothing published, nothing staged left behind.
				commitVersion(AFTER, 'a stable cut with a lightweight tag');
				git('tag', `v${AFTER}`);
				for (const options of [{ channel: 'master' as const }, { ref: `v${AFTER}` }]) {
					const lightStable = await refusalOf(options);
					expect(lightStable.code).toBe('update.refused');
					expect(lightStable.publicMessage).toContain(
						`The archive of tag v${AFTER} would not call itself ${AFTER}`,
					);
					expect(lightStable.publicMessage).toContain('ANNOTATED');
					expect(existsSync(join(releaseDir, `${AFTER}.zip`))).toBe(false);
					expect(partials()).toEqual([]);
				}
			} finally {
				mock.module('../../src/config/config.ts', () => REAL_CONFIG);
				mock.restore();
			}
		},
		120000,
	);
});

describe('GATE 13 — the publish CLAIMS an identity name (a racing build never overwrites)', () => {
	test('a published name that appeared after the pre-check is refused, its bytes kept; an orphan is replaced; a dev build is replaced', async () => {
		const { publishArchive } = await import('../../src/core/update/code_build.ts');
		const dir = join(ROOT, 'claim');
		mkdirSync(dir, { recursive: true });
		const target = join(dir, '7.0.1-beta.1.zip');
		const staged = join(dir, 'staged.partial');
		// A racing build published first (it was not there at this build's pre-check: orphan=false).
		writeFileSync(target, 'the published bytes');
		writeFileSync(staged, 'this build');
		let caught: unknown = null;
		try {
			publishArchive(staged, target, '7.0.1-beta.1', false);
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught)).toBe(true);
		expect((caught as { publicMessage?: string }).publicMessage).toContain('immutable');
		expect(readFileSync(target, 'utf8')).toBe('the published bytes');
		// An orphan this build found at its pre-check (no sidecar) is replaced.
		publishArchive(staged, target, '7.0.1-beta.1', true);
		expect(readFileSync(target, 'utf8')).toBe('this build');
		// A developer build replaces its -dev.zip.
		const dev = join(dir, '7.0.1-dev.zip');
		writeFileSync(dev, 'old dev');
		writeFileSync(staged, 'new dev');
		publishArchive(staged, dev, null, false);
		expect(readFileSync(dev, 'utf8')).toBe('new dev');
	});
});
