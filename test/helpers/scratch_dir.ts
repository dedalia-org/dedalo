/**
 * SCRATCH DIRECTORIES FOR GATES AND SCRIPTS — the ONE way a test, a drill or a
 * probe asks the OS temp directory for room.
 *
 * WHY THIS EXISTS. The tree's old idiom was a NAMED path under the shared temp
 * dir — `${tmpdir()}/dedalo_<name>_${process.pid}` — then `mkdirSync` and
 * writes under it. On Linux `/tmp` is shared and sticky: a local user who
 * pre-creates that name (pids and `Date.now()` are guessable), or plants a
 * symlink there, redirects the gate's writes or feeds it bytes (CodeQL
 * js/insecure-temporary-file, js/file-system-race). `mkdtempSync` closes it
 * structurally: the directory is created ATOMICALLY with a random suffix and
 * mode 0700, so nobody else can have prepared it and nobody else can enter it.
 * Everything a caller then builds BENEATH it is private by inheritance.
 *
 * THE LAW. `predictable_tmp_tripwire` refuses any path built under the temp root
 * with a caller-chosen name outside a `mkdtemp` call (measured on the AST by
 * scripts/lib/predictable_tmp_census.ts). Route through here.
 *
 * NOT FOR THE SUITE MEDIA ROOT. `../private/test_media/<suite db>` is a fixed,
 * marked, rebuildable tree (test/helpers/test_media_root.ts) — not a temp path.
 * A media gate's OWN throwaway root is a scratch dir plus its marker:
 * `markMediaRoot(scratchDir('x'))` or `scratchMediaRoot()` in
 * test/helpers/media_scratch_root.ts.
 *
 * CONFIG-FREE on purpose (node built-ins only): a gate that must not evaluate
 * the engine's config, and the scripts, can import it.
 */

import { mkdtempSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** Every scratch dir name starts with this — what {@link removeScratchDir} checks. */
export const SCRATCH_PREFIX = 'dedalo_';

export interface ScratchDirOptions {
	/**
	 * Return the REAL path (macOS `$TMPDIR` is `/var/…`, a symlink to
	 * `/private/var/…`). For a gate that compares paths a child process resolved,
	 * or hands the root to code that refuses symlinked ancestors.
	 */
	readonly realpath?: boolean;
	/**
	 * Parent directory (default: the OS temp dir). Only `/tmp` is a sensible
	 * alternative — for a unix socket whose path must stay under macOS's 104-byte
	 * cap — and only those two are accepted by {@link removeScratchDir}.
	 */
	readonly parent?: string;
}

/**
 * A FRESH private directory: `<tmp>/dedalo_<name>_XXXXXX`, created atomically,
 * mode 0700, random suffix. `name` is a readable label only — it is sanitized to
 * one path segment and never makes the path predictable.
 */
export function scratchDir(name: string, options: ScratchDirOptions = {}): string {
	// `dedalo_x_` / `dedalo-x-` (the old mkdtemp-prefix spelling) reads as `x`.
	const label =
		name
			.replace(/[^A-Za-z0-9_.-]/g, '_')
			.replace(/^dedalo[_-]/, '')
			.replace(/[_-]+$/, '')
			.slice(0, 48) || 'scratch';
	const dir = mkdtempSync(join(options.parent ?? tmpdir(), `${SCRATCH_PREFIX}${label}_`));
	return options.realpath === true ? realpathSync(dir) : dir;
}

/**
 * A path for ONE file inside its own fresh scratch dir (the dir exists; the file
 * does not). Remove both with `removeScratchDir(dirname(path))`.
 */
export function scratchFile(
	name: string,
	fileName: string,
	options: ScratchDirOptions = {},
): string {
	return join(scratchDir(name, options), basename(fileName));
}

/**
 * A path that is ABSENT and that nobody else can predict: a fresh scratch dir is
 * made (mkdtemp, random suffix) and REMOVED again, and the path under that
 * vanished random name is returned. For refusal gates that need "a directory that
 * does not exist" — a fixed `join(tmpdir(), 'no_such_x')` is one any local user
 * can make exist. Nothing is left behind, so there is nothing to clean up.
 */
export function absentScratchPath(name: string, ...segments: string[]): string {
	const dir = scratchDir(name);
	rmdirSync(dir);
	return join(dir, ...segments);
}

/**
 * Remove a scratch dir this helper created (recursive, idempotent). REFUSES a
 * path that is not a `dedalo_*` entry directly under the OS temp dir or `/tmp` — a cleanup
 * helper that `rm -rf`s whatever it is given is how a mis-joined path deletes a
 * real tree.
 */
export function removeScratchDir(dir: string | undefined): void {
	if (dir === undefined || dir === '') return;
	const target = resolve(dir);
	const parents = new Set<string>();
	for (const base of [tmpdir(), '/tmp']) {
		parents.add(resolve(base));
		try {
			parents.add(realpathSync(base));
		} catch {
			// A missing `/tmp` (exotic container) simply is not a parent.
		}
	}
	if (!basename(target).startsWith(SCRATCH_PREFIX) || !parents.has(dirname(target))) {
		throw new Error(
			`removeScratchDir: REFUSED '${target}' — not a ${SCRATCH_PREFIX}* scratch dir directly under the OS temp dir or /tmp. NOTHING WAS DELETED.`,
		);
	}
	rmSync(target, { recursive: true, force: true });
}
