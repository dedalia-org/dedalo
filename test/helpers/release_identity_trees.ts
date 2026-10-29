/**
 * REAL git trees for the release-identity gates (design gates 1 and 7): one
 * builder, so the engine's resolver (release_identity_native) and the shell twin
 * (release_identity_shell_parity) are judged over the SAME histories, read from
 * the ONE truth table test/fixtures/release_identity/truth_table.json.
 *
 * A repository carries the repo's REAL build_info.txt placeholder and REAL
 * `.gitattributes` export-subst line (never a copy that could drift), plus a
 * version.ts declaring the table's triple — the shell twin reads the triple
 * from the tree, as the engine reads its own. Nothing is stubbed: what an
 * archive says is what git wrote.
 *
 * Writes only under the caller's scratch directory.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_INFO_PATH } from '../../src/core/update/build_stamp.ts';
import { INSTALL_STAMP_PATH } from '../../src/core/update/install_stamp.ts';
import type { ReleaseIdentity } from '../../src/core/update/release_identity.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** `date`: the annotated tag's own date (describe prefers the NEWEST tag of a commit). */
export type TagStep = { tag: string; annotated: boolean; date?: string } | { commit: true };

export interface TruthRow {
	name: string;
	steps: TagStep[];
	version: string;
	kind: ReleaseIdentity['kind'];
	/** A regular expression the ENGINE's notice matches; null = no notice. */
	notice: string | null;
}

export const TRUTH_TABLE = JSON.parse(
	readFileSync(join(REPO_ROOT, 'test', 'fixtures', 'release_identity', 'truth_table.json'), 'utf8'),
) as { triple: [number, number, number]; rows: TruthRow[] };

/** The repo's REAL export-subst line(s) and placeholder — never a copy. */
export const REAL_ATTRIBUTES = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8')
	.split('\n')
	.filter((line) => /\bexport-subst\b/.test(line) && !line.trimStart().startsWith('#'))
	.join('\n');
export const REAL_PLACEHOLDER = readFileSync(join(REPO_ROOT, BUILD_INFO_PATH), 'utf8');

/** version.ts's path inside a tree. */
export const VERSION_TS_PATH = 'src/core/update/version.ts';

/**
 * A version.ts declaring `triple` (the DATA triple) and `nextDevTriple` (the
 * release an untagged build precedes), the way the real one does
 * (Object.freeze([a, b, c])). The next triple defaults to the data triple: the
 * next release is the data release until it is tagged (VERSIONING_SPEC §5).
 */
export function versionTsOf(triple: readonly number[], nextDevTriple?: readonly number[]): string {
	const next = nextDevTriple ?? triple;
	return `export const DEDALO_DATA_VERSION = Object.freeze([${triple.join(', ')}]);
export const DEDALO_NEXT_RELEASE = Object.freeze([${next.join(', ')}]);
`;
}

/** The builders over one scratch root (each gate owns and removes its root). */
export function releaseTrees(scratchRoot: string) {
	let counter = 0;

	function scratch(name: string): string {
		counter += 1;
		const dir = join(scratchRoot, `${counter}_${name}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	/** git() with extra environment (a tag's GIT_COMMITTER_DATE); hermetic config. */
	function gitWith(extra: Record<string, string>, cwd: string, ...args: string[]): string {
		const run = Bun.spawnSync(
			['git', '-c', 'user.name=gate', '-c', 'user.email=gate@example.org', ...args],
			{
				cwd,
				env: {
					PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
					HOME: scratchRoot,
					GIT_CONFIG_NOSYSTEM: '1',
					...extra,
				},
			},
		);
		if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
		return run.stdout.toString().trim();
	}

	function git(cwd: string, ...args: string[]): string {
		return gitWith({}, cwd, ...args);
	}

	/** A real repository: one commit carrying the real stamp file and version.ts, then `steps`. */
	function repoWith(
		name: string,
		steps: TagStep[],
		triple: readonly number[] = TRUTH_TABLE.triple,
	): string {
		const dir = scratch(name.replace(/\W+/g, '_').slice(0, 40));
		mkdirSync(join(dir, 'src', 'core', 'update'), { recursive: true });
		writeFileSync(join(dir, BUILD_INFO_PATH), REAL_PLACEHOLDER);
		writeFileSync(join(dir, VERSION_TS_PATH), versionTsOf(triple));
		writeFileSync(join(dir, '.gitattributes'), `${REAL_ATTRIBUTES}\n`);
		writeFileSync(join(dir, 'tracked.txt'), 'release body\n');
		git(dir, 'init', '-q', '-b', 'master');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-q', '-m', 'release commit');
		for (const step of steps) {
			if ('commit' in step) git(dir, 'commit', '-q', '--allow-empty', '-m', 'one more');
			else if (step.annotated)
				gitWith(
					step.date === undefined ? {} : { GIT_COMMITTER_DATE: step.date },
					dir,
					'tag',
					'-a',
					step.tag,
					'-m',
					step.tag,
				);
			else git(dir, 'tag', step.tag);
		}
		return dir;
	}

	/** `git archive` of HEAD, extracted the way a release lands: real expansion, no `.git`. */
	function archiveOf(repo: string): string {
		const out = scratch('archive');
		const tar = join(out, '..', `${counter}.tar`);
		git(repo, 'archive', '--format=tar', '-o', tar, 'HEAD');
		const run = Bun.spawnSync(['tar', '-xf', tar, '-C', out]);
		if (run.exitCode !== 0) throw new Error(`tar: ${run.stderr.toString()}`);
		return out;
	}

	/** An install stamp of `channel` (a digest parseInstallStamp trusts). */
	function stampChannel(tree: string, channel: 'master' | 'dev'): void {
		writeFileSync(
			join(tree, INSTALL_STAMP_PATH),
			JSON.stringify({ digest: 'a'.repeat(64), channel }),
		);
	}

	return { scratch, git, gitWith, repoWith, archiveOf, stampChannel };
}
