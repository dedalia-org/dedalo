/**
 * MEDIA JOB TARGET TRIPWIRE — every background job says what it is working on.
 *
 * THE INVARIANT: a `mediaJobs.submit(...)` call either stamps a `target`
 * (JobTarget: the record/component/tier it will change) or is named in
 * EXEMPT_SUBMITTERS below with a reason.
 *
 * WHY IT IS MECHANICAL RATHER THAN A COMMENT (DEC-12 "tripwired or deleted"):
 * the whole media-job-visibility change rests on being able to ask "what is
 * running for this record?". A single untargeted submitter is invisible to
 * `jobsForRecord`, so the versions panel silently reverts to the empty-cell lie
 * for that one path — and nothing else fails. That is precisely the shape of a
 * regression a test must catch instead of an operator.
 *
 * The scan is deliberately dumb (a source scan, not a type check): the target is
 * OPTIONAL on JobRecord because the exempt jobs genuinely have none, so the
 * compiler cannot hold this line.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SCAN_ROOTS = ['src', 'tools'];

/**
 * Submitters that legitimately have NO record target, each with the reason.
 * A new entry here is a DECISION: it says "this job changes nothing a record
 * owns", and it makes that job invisible to the record-scoped surfaces.
 */
const EXEMPT_SUBMITTERS: ReadonlyMap<string, string> = new Map([
	[
		'src/core/area_maintenance/widgets/update_data_version.ts',
		'Install-wide data migration: it targets the DATABASE, not a record — no section/component exists to attach it to.',
	],
	[
		'src/core/area_maintenance/widgets/move_common.ts',
		'The move_* bulk transform (its EXECUTE and its DRY RUN): it rewrites — or, dry, reads — definition-file-selected tipos/locators across every matrix table of the install — no single section/component owns it (the same class as the data-migration job above).',
	],
	[
		'src/core/area_maintenance/backup.ts',
		'The whole-DATABASE dump (make_backup): it reads every record and changes none — its output is a file in the backup directory, owned by no section or component.',
	],
	[
		'src/core/area_maintenance/widgets/unit_test.ts',
		'The test-suite runner: it produces a report, not a media derivative.',
	],
	[
		'src/core/area_maintenance/widgets/update_code.ts',
		'Install-wide CODE update: it replaces the engine tree on disk and restarts the process — there is no record, section or component it could be attached to (the same class as the data-migration job above).',
	],
	[
		'src/core/relations/declared_order_reconcile.ts',
		'The declared-order SWEEP after an ontology change (submitSweepJob): it re-sorts every stored record of the changed portal tipos across the install — the scope is a set of component definitions, not one record, so no section_id/component target exists (the same class as the move_* bulk transform above).',
	],
	[
		'src/core/tools/background.ts',
		'The GENERIC tool-background bridge: it runs whatever handler a tool declared backgroundRunnable, so it cannot know a target here. A tool whose background action IS record-scoped stamps its own target inside its handler.',
	],
]);

/** Every .ts file under the scan roots. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			collectSourceFiles(full, out);
		} else if (name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/**
 * The submit call's argument text, from `submit(` to the matching close paren.
 * Brace/paren counting rather than a regex: the worker body is a whole async
 * arrow function full of both.
 */
function submitCallBodies(source: string): string[] {
	const bodies: string[] = [];
	const marker = /mediaJobs\.submit\s*\(/g;
	let match: RegExpExecArray | null = marker.exec(source);
	while (match !== null) {
		let depth = 1;
		let index = match.index + match[0].length;
		const start = index;
		while (index < source.length && depth > 0) {
			const char = source[index];
			if (char === '(') depth += 1;
			else if (char === ')') depth -= 1;
			index += 1;
		}
		bodies.push(source.slice(start, index - 1));
		match = marker.exec(source);
	}
	return bodies;
}

describe('media job target tripwire', () => {
	test('every mediaJobs.submit stamps a target or is an exempt submitter', () => {
		const offenders: string[] = [];
		const exemptSeen = new Set<string>();

		for (const root of SCAN_ROOTS) {
			for (const file of collectSourceFiles(join(REPO_ROOT, root))) {
				const relative = file.slice(REPO_ROOT.length + 1);
				if (relative.includes('/media/jobs.ts')) continue; // the manager itself
				const source = readFileSync(file, 'utf-8');
				const bodies = submitCallBodies(source);
				if (bodies.length === 0) continue;
				if (EXEMPT_SUBMITTERS.has(relative)) {
					exemptSeen.add(relative);
					continue;
				}
				for (const body of bodies) {
					// `target: {…}` AND the shorthand `{ userId, target }` — a scan that
					// saw only the colon form would redden a correctly-stamped submitter
					// and teach the next person to add an exemption for a non-problem.
					if (!/\btarget\s*[:,}]/.test(body)) {
						offenders.push(relative);
					}
				}
			}
		}

		expect(offenders).toEqual([]);

		// A stale exemption is its own defect: it claims a job is record-less long
		// after that submitter moved or gained a target, and it silently widens the
		// hole for the next one.
		const stale = [...EXEMPT_SUBMITTERS.keys()].filter((path) => !exemptSeen.has(path));
		expect(stale).toEqual([]);
	});

	test('every exemption carries a non-trivial reason', () => {
		for (const [path, reason] of EXEMPT_SUBMITTERS) {
			expect(reason.length, `${path} needs a real reason, not a placeholder`).toBeGreaterThan(40);
		}
	});
});
