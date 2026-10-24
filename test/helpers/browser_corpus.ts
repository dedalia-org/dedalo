/**
 * THE BROWSER CORPUS — the one lister that owns the browser trees.
 *
 * `client/` and `tools/**\/js` are source (AGENTS.md: the client is the
 * PRIMARY, TS-OWNED client source), so every gate that scans them must scan
 * the SAME files. Three gates each grew their own walk — a corpus that can
 * drift per gate is a census nobody can trust, and `census_derivation_tripwire`
 * refuses a gate that chooses its own root in-file. This module owns the roots;
 * the gates import a shape and never name a directory.
 *
 * Two shapes, because the two censuses are legitimately different:
 *   `browserSources()`        — git's view: tracked AND untracked (a module not
 *                               yet `git add`ed is still SERVED), never ignored.
 *   `firstPartyClientFiles()` — the on-disk walk of first-party code only: the
 *                               app client plus every tool client, with the
 *                               vendored, test and server subtrees skipped —
 *                               and, like git's view, never an IGNORED file
 *                               (a developer's `client/dedalo/dev_tools/` is
 *                               theirs, not the engine's: it made
 *                               render_escape_tripwire red on one machine).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The browser roots. The ONLY place they are named. */
export const CLIENT_JS_ROOTS = ['client', 'tools'];

/** Not first-party client code: vendored libraries, the suites, server code. */
const SKIP_DIRS = new Set(['lib', 'node_modules', 'test', 'server']);

/**
 * Every .js under the browser trees in git's view — tracked AND untracked (a
 * module not yet `git add`ed is still served), never ignored, and never a
 * tracked file DELETED in the working tree (`--cached` still lists it until the
 * deletion is committed, but nothing serves it). Unfiltered: the ONE git walk
 * both shapes derive from.
 */
const gitBrowserView = (): string[] =>
	execFileSync(
		'git',
		[
			'ls-files',
			'--cached',
			'--others',
			'--exclude-standard',
			'--',
			...CLIENT_JS_ROOTS.map((r) => `${r}/**/*.js`),
		],
		{
			cwd: REPO_ROOT,
			encoding: 'utf8',
		},
	)
		.split('\n')
		.filter((file) => file !== '' && existsSync(join(REPO_ROOT, file)));

/**
 * Every .js under the browser trees in git's view, UNFILTERED — for a census
 * whose rule is not "first-party minus vendored" (a tool's own helper under a
 * `lib/` directory is still the tool's code: tool_lossless_writeback's client
 * census reads every tools/**\/js file but the `-min.js` builds).
 */
export const browserSourcesUnfiltered = (): string[] => gitBrowserView();

/**
 * Every .js under the browser trees, excluding vendored libraries — tracked AND
 * untracked (a module not yet `git add`ed is still served), never ignored.
 */
export const browserSources = (): string[] =>
	gitBrowserView().filter(
		(f) => !/\/(?:lib|vendor|node_modules)\//.test(f) && !f.endsWith('.min.js'),
	);

function walk(dir: string, out: string[]): void {
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(name)) walk(path, out);
		} else if (name.endsWith('.js')) {
			out.push(path);
		}
	}
}

/** Every first-party client .js file: the app client + every tool's client. */
export function firstPartyClientFiles(): string[] {
	const out: string[] = [];
	walk(join(REPO_ROOT, 'client/dedalo'), out);
	walk(join(REPO_ROOT, 'tools'), out);
	const notIgnored = new Set(gitBrowserView());
	return out
		.map((p) => relative(REPO_ROOT, p))
		.filter((f) => notIgnored.has(f))
		.sort();
}
