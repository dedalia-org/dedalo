/**
 * ORPHANED_UNSAVED WRITERS ARE CONFINED — a source census over the browser trees.
 *
 * `events.js` keeps the registry of orphaned unsaved instances (a failed save
 * whose owner was released from the instance cache — contract:
 * engineering/wire_contract/WC-2026-10-30-section-record-row-box.md, addendum
 * "edit-safety primitives"). Its writers leave events.js only as a ONCE-only
 * capability that component_common.js claims at load; the exported view has no
 * mutators. The outcome half (any later claim throws, whatever spelling reaches
 * it) is pinned by component_settle_native.test.ts W4. THIS gate is the source
 * half: no browser module other than the two owners names a writer in ANY
 * spelling — a call, an import specifier (aliased or not), a re-export, a
 * bracket-access string — and no module mutates the exported view.
 *
 * Corpus: the shared browser lister (test/helpers/browser_corpus.ts, git's view
 * of client/ + tools/, tracked and untracked, never ignored), UNFILTERED — a
 * tool's own lib/ helper is still the tool's code — minus minified builds.
 * Floored PER ROOT so a root the lister stopped reaching cannot hide behind the
 * other, plus a floor that the scan reached tool modules importing events.js.
 * Self-tested: the pure `violations` scan flags planted samples (C1).
 *
 * Honest limit: an installation's ADDITIONAL tool roots (config) are not in the
 * repo and so not in this census; the load-order refusal (W4) is what holds
 * there, and only when that tool loads after component_common.js.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserSourcesUnfiltered } from '../helpers/browser_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The two owners, by repo path — never a path suffix. */
const ALLOWED_FILES = new Set([
	'client/dedalo/core/component_common/js/component_common.js',
	'client/dedalo/core/common/js/events.js',
]);
const WRITER_NAME =
	/\b(claim_orphaned_unsaved_writers|add_orphaned_unsaved|delete_orphaned_unsaved|orphaned_unsaved_writers)\b/;
const SET_MUTATION = /\borphaned_unsaved\s*\.\s*(add|delete|clear)\s*\(/;

/** The scan, as a pure function so it can be proven on planted samples. */
const violations = (repo_path: string, source: string): string[] => {
	const found: string[] = [];
	if (SET_MUTATION.test(source)) found.push(`${repo_path}: mutates orphaned_unsaved`);
	if (!ALLOWED_FILES.has(repo_path) && WRITER_NAME.test(source)) {
		found.push(`${repo_path}: names an orphaned_unsaved writer`);
	}
	return found;
};

describe('orphaned_unsaved writers are confined', () => {
	test('C1. the scan flags planted writers in every spelling (it can fail)', () => {
		const x = 'client/dedalo/core/x/js/x.js';
		const tool = 'tools/tool_x/js/tool_x.js';
		expect(violations(x, 'orphaned_unsaved.delete(i)')).toHaveLength(1);
		expect(violations(x, 'orphaned_unsaved .clear()')).toHaveLength(1);
		expect(violations(x, 'const w = claim_orphaned_unsaved_writers()')).toHaveLength(1);
		expect(
			violations(
				x,
				"import { claim_orphaned_unsaved_writers as grab } from '../../common/js/events.js'",
			),
			'an aliased import',
		).toHaveLength(1);
		expect(
			violations(x, "events['claim_orphaned_unsaved_writers']()"),
			'bracket access',
		).toHaveLength(1);
		expect(
			violations(x, "export { claim_orphaned_unsaved_writers as c } from './events.js'"),
			'a re-export',
		).toHaveLength(1);
		expect(violations(tool, 'delete_orphaned_unsaved (i)'), 'a tool file').toHaveLength(1);
		expect(
			violations(
				'client/dedalo/core/component_common/js/component_common.js',
				'orphaned_unsaved_writers.delete(i)',
			),
		).toHaveLength(0);
		expect(
			violations(
				'tools/core/component_common/js/component_common.js',
				'orphaned_unsaved_writers.delete(i)',
			),
			'the allowance is the repo path, never a path suffix',
		).toHaveLength(1);
		expect(
			violations('client/dedalo/core/common/js/events.js', 'orphaned_unsaved.add(i)'),
			'even an owner never mutates the exported view',
		).toHaveLength(1);
		expect(violations(x, 'orphaned_unsaved.has(i)')).toHaveLength(0);
	});

	test('C2. no browser module outside component_common/events names a writer', () => {
		const files = browserSourcesUnfiltered().filter(
			(file) => !file.endsWith('.min.js') && !file.endsWith('-min.js'),
		);
		const client_files = files.filter((file) => file.startsWith('client/'));
		const tool_files = files.filter((file) => file.startsWith('tools/'));
		const found: string[] = [];
		const tool_files_importing_events = tool_files.filter((file) =>
			/common\/js\/events\.js/.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
		);
		for (const file of files) {
			found.push(...violations(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
		}
		// floor PER ROOT: a root the lister stopped reaching cannot hide behind another
		expect(client_files.length, 'the scan read no client file').toBeGreaterThan(100);
		expect(tool_files.length, 'the scan read no tool client file').toBeGreaterThan(50);
		expect(
			tool_files_importing_events.length,
			'the scan reached no tool module that can import the writers',
		).toBeGreaterThan(0);
		// both owners are in the corpus (else the allowance guards a ghost)
		expect(files.filter((file) => ALLOWED_FILES.has(file)).length).toBeGreaterThanOrEqual(2);
		expect(found).toEqual([]);
	});
});
