/**
 * release_root_entries_tripwire — THE ROOT OF A RELEASE IS A DECISION.
 *
 * Every top-level entry a release archive ships lands on every install, and
 * the code updater's root whitelist (`src/core/update/code_update.ts`
 * `refuseUnaccountedLiveEntries`) reads the live root against it. `.vscode`
 * reached releases only because someone committed an editor config; once it
 * was untracked (0ebc82b616) every install that had taken an older release
 * refused the next update over it — unclearable without shell access
 * (2026-10-07).
 *
 * Two halves:
 *  - The shipped root set (git-tracked roots minus `export-ignore`, i.e. what
 *    `git archive` emits) must equal `engineering/release_root_entries.json`
 *    EXACTLY. Adding an entry is then an edit in review, not a side effect.
 *    Removing one is safe for stamped installs (install_stamp.ts
 *    `root_entries`): the updater retires it into the backup.
 *    The list is also READ at runtime (2026-11-06): an UNSTAMPED tree (a
 *    checkout, a hand copy) takes it as its release-root record
 *    (install_stamp.ts `installedRootEntriesOf`), so the update panel's
 *    `root_entries` line and the swap decide there too — one more reason it
 *    must equal what `git archive` ships.
 *  - Editor/OS config names never ship, whatever the list says.
 *
 * Reads the INDEX (`git ls-files`), not HEAD, so a staged root entry fails
 * before it is committed. No database.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../../src/config/env.ts';
import { IGNORED_ROOT_ENTRIES } from '../../src/core/update/code_update.ts';
import { trackedRepoFiles } from '../helpers/css_reference_corpus.ts';

const LIST_PATH = 'engineering/release_root_entries.json';

/** Editor / IDE config dirs: per-developer state, never a release file. */
const EDITOR_CONFIG_ENTRIES = new Set(['.vscode', '.idea', '.fleet', '.zed']);

/** The `export-ignore` verdict for each named root (attributes only, no listing). */
function exportIgnoreAttrs(roots: readonly string[]): string {
	const run = Bun.spawnSync(
		['git', '-C', projectRoot, 'check-attr', '-z', 'export-ignore', '--', ...roots],
		{ stdout: 'pipe', stderr: 'pipe' },
	);
	expect(run.exitCode).toBe(0);
	return run.stdout.toString();
}

/** The top-level entries `git archive` would emit from the index. */
function shippedRootEntries(): string[] {
	const roots = [...new Set(trackedRepoFiles().map((path) => path.split('/')[0] as string))];
	const exportIgnored = new Set(
		exportIgnoreAttrs(roots)
			// -z output: path NUL attr NUL value NUL, repeated
			.split('\0')
			.reduce<string[][]>((triples, field, index) => {
				if (index % 3 === 0) triples.push([field]);
				else triples.at(-1)?.push(field);
				return triples;
			}, [])
			.filter(([, , value]) => value === 'set')
			.map(([path]) => path as string),
	);
	return roots.filter((root) => !exportIgnored.has(root)).sort();
}

function pinnedRootEntries(): string[] {
	const doc = JSON.parse(readFileSync(join(projectRoot, LIST_PATH), 'utf8')) as {
		root_entries: string[];
	};
	return [...doc.root_entries].sort();
}

describe('release root entries', () => {
	test('the shipped root set equals the pinned list exactly', () => {
		const shipped = shippedRootEntries();
		// A listing that found nothing is a broken listing, never a pass.
		expect(shipped.length).toBeGreaterThan(20);
		expect(shipped).toContain('src');
		expect(shipped).toContain('package.json');

		const pinned = pinnedRootEntries();
		const added = shipped.filter((entry) => !pinned.includes(entry));
		const removed = pinned.filter((entry) => !shipped.includes(entry));
		expect(
			{ added, removed },
			`the release root changed. ADDED entries ship to every install: add them to ${LIST_PATH} ` +
				`deliberately (or export-ignore / untrack them). REMOVED entries: drop them from the list — ` +
				`stamped installs retire them into the backup on update (install_stamp.ts root_entries); ` +
				`installs stamped before 2026-10-07 refuse once and need the entry removed by hand.`,
		).toEqual({ added: [], removed: [] });
	});

	test('editor and OS config never ships', () => {
		const leaked = shippedRootEntries().filter(
			(entry) => EDITOR_CONFIG_ENTRIES.has(entry) || IGNORED_ROOT_ENTRIES.has(entry),
		);
		expect(
			leaked,
			'per-developer/OS config is tracked at the root and would ship in every release — untrack it (.gitignore) instead',
		).toEqual([]);
	});

	test('the pinned list itself names no editor or OS config', () => {
		const pinned = pinnedRootEntries();
		expect(pinned.length).toBeGreaterThan(10);
		expect(
			pinned.filter((entry) => EDITOR_CONFIG_ENTRIES.has(entry) || IGNORED_ROOT_ENTRIES.has(entry)),
		).toEqual([]);
	});
});
