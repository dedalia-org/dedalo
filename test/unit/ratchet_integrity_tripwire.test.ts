/**
 * TRIPWIRE — every ratchet refuses its own LAUNDERING (P2-18).
 *
 * The repo's generators exist so debt cannot grow unnoticed. Measured, debt
 * grew: the crap ratchet's frozen `functionsOverCap` went
 * 672 → 701 → 697 → 702 → 691 across its life — a NET +19 over-cap functions
 * and +1 over-cap file since the day it was created.
 *
 * Three separate holes made that possible, and they are one shape:
 *
 *  - `raisedEntries()` compared each file's MAXIMUM complexity plus "new
 *    over-cap file", and never `summary.functionsOverCap` — the exact case the
 *    census exists for, a new over-cap function hiding under a file already at
 *    its frozen max. Worse, the census leg's failure message named the FLAGLESS
 *    regeneration as the remedy, so the reflex path WAS the laundering path.
 *  - `scripts/ci/audit.ts` had no anti-laundering guard at all: `--update`
 *    overwrote `accepted` with whatever `bun audit` reported this minute, and
 *    the RED message hands the developer that exact command. A NEW advisory
 *    could be accepted by running the thing the failure told you to run.
 *  - `observer_shrink_budget.json` — the ceiling on how many observer locators
 *    an ops sweep may delete over HERITAGE RELATION DATA — had no shrink-only
 *    rule, and the only gate over it built its fixture FROM the limits, so it
 *    asserted a property of `>`: `{1e12, 1e12}` passed byte-identically.
 *
 * THE META-RULE, and why it is here rather than in each generator: a script
 * that writes a baseline must be able to REFUSE. The census is derived from
 * `scripts/` so a seventh generator cannot ship ungoverned.
 *
 * THE SECOND HALF (GATE-20, GATE-22): refusing is not enough when the refusal
 * compares the wrong thing, or when the reason for overriding it lives where no
 * gate reads. Measured at HEAD before this half: the advisory refusal compared
 * COUNTS, so a swap (one advisory withdrawn, one new) laundered flaglessly; no
 * accepted advisory carried a reason; and nothing compared the crap baseline's
 * `summary` against anything outside the file, so a merge resolution could
 * raise it with no generator run and no reason. The legs below prove, on
 * CONSTRUCTED fixtures (positive controls) and on the COMMITTED artifacts:
 *  - `newlyAcceptedKeys` compares identities — a swap is a regression;
 *  - every accepted advisory carries a reason the ONE shared validator accepts,
 *    and the generator writes `--reason` INTO the entry;
 *  - the crap baseline carries an append-only `ledger`; `summary` must equal
 *    its last line and every growth line carries a validated reason. The
 *    reference is IN the artifact and not a git merge-base on purpose: the
 *    hermetic tier checks out shallow inside a container, so a git-reading
 *    gate would be vacuous exactly where it must run.
 *
 * THE THIRD ROUND (the reviewers' refutation of the second): the generator's
 * refusal is a DECISION, and the first cut of that decision was proved by
 * grepping the block that made it — measured, `&& false` on the condition
 * left the gate green. Both decisions are now pure exported functions
 * (`updateDecision`) proved here on their OUTCOMES. And both generators had
 * turned "I could not read the previous baseline" into "compare against
 * nothing": a merge-conflicted (unparseable) artifact DISABLED the refusal,
 * so resolving a conflict by running the fix command laundered everything.
 * Now: unparseable → refuse; absent → every entry is new → refuse without the
 * flag. Finally the crap ledger's first line is pinned in code
 * (`LEDGER_BIRTH`) so a truncated or rewritten opener cannot restart the
 * history at an unreasoned number, and `ledgerPrefixProblems` proves
 * append-only against a git reference where history exists.
 *
 * THE FOURTH ROUND: the READER was the unguarded seam. "Unparseable → refuse"
 * was proved only on a hand-built `{kind:'unparseable'}` — measured, the reader
 * mutated to return `absent` on a parse failure left both gates green while a
 * conflict-marker file was bootstrapped over with `--allow-regression`. Both
 * readers are now driven on a real conflict-marker file, and both generators
 * are run as subprocesses over a scratch `--baseline` (read BEFORE any network
 * or measurement) to prove the exit code, not the fixture. A raise-by-ONE
 * per-file fixture pins the tolerance (`value > before + 2` was green).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import {
	ADVISORY_REASON_MIN_WORDS,
	type Baseline as AdvisoryBaseline,
	type BaselineEntry as AdvisoryEntry,
	acceptedEntryProblems,
	updateDecision as advisoryUpdateDecision,
	newlyAcceptedKeys,
	readPreviousBaseline as readPreviousAdvisoryBaseline,
} from '../../scripts/ci/audit.ts';
import {
	appendLedger,
	type ComplexityBaseline,
	updateDecision as crapUpdateDecision,
	LEDGER_BIRTH,
	LEDGER_REASON_MIN_WORDS,
	type LedgerEntry,
	ledgerPrefixProblems,
	ledgerProblems,
	loadBaseline,
	readPreviousBaseline as readPreviousCrapBaseline,
} from '../../scripts/crap_baseline.ts';
import {
	readFlagValue,
	THIN_REASONS,
	thinReasonProblem,
} from '../../scripts/lib/reason_validator.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Scratch artifacts for the READER legs: a real conflict-marker file (what a
 * half-resolved merge leaves on disk), a JSON that is not the artifact, and a
 * path that does not exist. The generators are pointed at them with
 * `--baseline`, so the committed artifacts are never touched.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'ratchet_integrity_'));
const CONFLICTED = join(SCRATCH, 'conflicted.json');
const NOT_THE_ARTIFACT = join(SCRATCH, 'wrong_shape.json');
const ABSENT = join(SCRATCH, 'never_written.json');
writeFileSync(
	CONFLICTED,
	'<<<<<<< HEAD\n{"generated":"2026-09-01","accepted":{}}\n=======\n{"generated":"2026-09-02","accepted":{}}\n>>>>>>> theirs\n',
);
writeFileSync(NOT_THE_ARTIFACT, '{"generated":"2026-09-01","note":"a map that is not there"}\n');
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Run a generator as a subprocess (offline; every probe here returns before any network). */
function runGenerator(args: string[]): { exitCode: number; stderr: string; stdout: string } {
	const run = Bun.spawnSync(['bun', 'run', ...args], {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: run.exitCode,
		stderr: run.stderr.toString(),
		stdout: run.stdout.toString(),
	};
}

/**
 * A generator: a script that rewrites a committed baseline.
 *
 * NOT "writes a file in its own body". The first draft of this census required
 * BOTH a `--update` literal AND a direct `Bun.write`/`writeFileSync` in the same
 * file, and so MISSED `unit_baseline.ts` and `parity_baseline.ts` — which
 * rewrite by DEFAULT (no flag) and delegate the write to
 * `scripts/lib/red_baseline.ts`. They are correctly guarded there; the point is
 * that my census could not see them, which is the same "the list is not the
 * corpus" defect this whole row is about. A generator is now anything that
 * writes a baseline directly OR through the shared writer.
 */
function generators(): { file: string; source: string }[] {
	const found: { file: string; source: string }[] = [];
	for (const dir of ['scripts', 'scripts/ci'] as const) {
		for (const rel of new Glob('*.ts').scanSync({ cwd: join(REPO_ROOT, dir) })) {
			const file = `${dir}/${rel}`;
			const source = readFileSync(join(REPO_ROOT, file), 'utf8');
			const writesDirectly =
				/['"]--update['"]/.test(source) && /Bun\.write|writeFileSync/.test(source);
			const writesViaSharedWriter = /red_baseline\.ts/.test(source);
			if (!writesDirectly && !writesViaSharedWriter) continue;
			found.push({ file, source });
		}
	}
	return found.sort((a, b) => a.file.localeCompare(b.file));
}

/** The refusal a generator must be able to make, in any of its spellings. */
const REFUSES =
	/--allow-regression|REFUSED|REFUSING|only shrinks|refuses to raise|ABOVE the recorded/;

describe('every ratchet refuses its own laundering', () => {
	const all = generators();

	test('the census finds the generators (anti-vacuity)', () => {
		// Derived, not listed: a glob that matched nothing would make the rule
		// below police zero scripts.
		expect(all.length).toBeGreaterThanOrEqual(6);
		const files = all.map((entry) => entry.file);
		expect(files).toContain('scripts/ci/audit.ts');
		expect(files).toContain('scripts/crap_baseline.ts');
		// The two that delegate their write — the ones the first draft could not see.
		expect(files).toContain('scripts/unit_baseline.ts');
		expect(files).toContain('scripts/parity_baseline.ts');
	});

	test('a generator that rewrites a baseline can REFUSE to raise it', () => {
		// A DELEGATING generator is judged by its WRITER, not by its own prose.
		// Measured: neutering the shared writer's guard left this green, because
		// parity_baseline.ts and unit_baseline.ts both DESCRIBE --allow-regression
		// in their headers. Matching prose instead of the guard is the same defect
		// this row is about, one level up.
		const sharedWriter = readFileSync(join(REPO_ROOT, 'scripts/lib/red_baseline.ts'), 'utf8');
		// The writer reads the flag from its argv (whether it negates it inline or
		// hands it to a refusal predicate) and its REFUSING message precedes its write.
		const sharedWriterRefuses =
			/args\.has\('--allow-regression'\)/.test(sharedWriter) &&
			sharedWriter.indexOf('REFUSING') > -1 &&
			sharedWriter.indexOf('REFUSING') < sharedWriter.lastIndexOf('writeFileSync(');
		const permissive = all
			.filter((entry) => {
				if (/red_baseline\.ts/.test(entry.source)) return !sharedWriterRefuses;
				return !REFUSES.test(entry.source);
			})
			.map((e) => e.file);
		expect(
			permissive,
			'These scripts rewrite a committed baseline on --update with no way to refuse a ' +
				'REGRESSION. A ratchet that records whatever it measured is not a ratchet, it is ' +
				'a diary — and when the RED message names the regeneration as the remedy, the ' +
				`reflex path is the laundering path.\n  ${permissive.join('\n  ')}`,
		).toEqual([]);
	});

	test('the crap ratchet guards its SUMMARY counters, not only per-file maxima', () => {
		// The specific hole that let +19 over-cap functions through: a new over-cap
		// function under a file already at its frozen max moves no per-file entry.
		const source = readFileSync(join(REPO_ROOT, 'scripts/crap_baseline.ts'), 'utf8');
		// BOUNDED to the function body. Slicing to end-of-file let later mentions
		// of the same identifiers satisfy this — measured: deleting the guard
		// entirely left the assertion green.
		const start = source.indexOf('export function raisedEntries');
		const guard = source.slice(start, source.indexOf('\nfunction ', start));
		expect(guard.length).toBeGreaterThan(200);
		expect(guard, 'raisedEntries ignores summary.functionsOverCap again').toContain(
			'functionsOverCap',
		);
		expect(guard).toContain('filesOverCap');
	});

	test('the dependency ratchet cannot accept MORE advisories by reflex', () => {
		const source = readFileSync(join(REPO_ROOT, 'scripts/ci/audit.ts'), 'utf8');
		// BOUNDED to the `if (update)` block: the block must carry out the exported
		// decision (proved on its outcomes in the GATE-20 describe below) and
		// refuse BEFORE the write. Measured before this shape: a spelling check on
		// the condition stayed green with the condition neutered to `&& false`.
		const start = source.indexOf('if (update) {');
		const updateBlock = source.slice(start, source.indexOf('\n\tconst committed =', start));
		expect(updateBlock.length).toBeGreaterThan(100);
		expect(updateBlock, 'the --update path no longer defers to updateDecision').toContain(
			'updateDecision(',
		);
		expect(updateBlock.indexOf("decision.kind === 'refuse'")).toBeGreaterThan(-1);
		expect(updateBlock.indexOf("decision.kind === 'refuse'")).toBeLessThan(
			updateBlock.indexOf('Bun.write'),
		);
		// The CHECK path re-reads the reasons (a merged or hand-edited artifact
		// never went through --update) through the same three-state reader, and
		// the RED message names the flagged command, never the bare one.
		const checkPath = source.slice(source.indexOf('\n\tconst committed =', start));
		expect(checkPath.length).toBeGreaterThan(200);
		expect(checkPath, 'the check path does not validate entry reasons').toContain(
			'acceptedEntryProblems(baseline)',
		);
		// An unreadable baseline is refused by OUTCOME (the reader leg below runs
		// the script); here only that the write follows the same reader's verdict.
		expect(checkPath).toContain("committed.kind !== 'present'");
		const redMessage = checkPath.slice(
			checkPath.indexOf('advisories that the committed baseline does not accept'),
		);
		expect(redMessage).toContain('--update --allow-regression --reason');
		expect(redMessage, 'the RED message prescribes the bare laundering command').not.toMatch(
			/--update\\n/,
		);
	});

	test('the ONE reason-blacklist lives in scripts/lib/reason_validator.ts and nowhere else', () => {
		// GATE-23: the new-file exemption check validated by WORD COUNT while its
		// own failure message promised the blacklist that lived 180 lines away in
		// another describe block — so "This is temporary and we will refactor it
		// later on" was accepted by the rule whose message named it as rejected.
		// The cure is ONE declaration, tree-wide: every site imports the predicate.
		const VALIDATOR = 'scripts/lib/reason_validator.ts';
		const scanned: string[] = [];
		const redeclared: string[] = [];
		for (const dir of ['scripts', 'test'] as const) {
			for (const rel of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, dir) })) {
				const file = `${dir}/${rel}`;
				scanned.push(file);
				if (file === VALIDATOR) continue;
				if (/\bTHIN_REASONS\s*=/.test(readFileSync(join(REPO_ROOT, file), 'utf8')))
					redeclared.push(file);
			}
		}
		expect(scanned.length, 'the census saw too few files to mean anything').toBeGreaterThan(300);
		expect(scanned).toContain(VALIDATOR);
		expect(
			redeclared,
			'THIN_REASONS is declared ONCE, in the shared validator; a second copy is the drift GATE-23 was',
		).toEqual([]);
		// ...and the crap gate applies the shared predicate at BOTH sites (the
		// new-file exemption and the coverage-exempt list).
		const gate = readFileSync(join(REPO_ROOT, 'test/unit/crap_complexity_ratchet.test.ts'), 'utf8');
		expect((gate.match(/thinReasonProblem\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(gate).not.toMatch(/THIN_REASONS/);
		// The predicate itself, both ways: the sentence GATE-23 named, and a
		// substantive one.
		expect(
			thinReasonProblem('This is temporary and we will refactor it later on', 8),
		).not.toBeNull();
		expect(thinReasonProblem('   ', 8)).not.toBeNull();
		expect(thinReasonProblem(undefined, 8)).not.toBeNull();
		expect(THIN_REASONS.test('we will refactor soon')).toBe(true);
		expect(
			thinReasonProblem(
				'An exhaustive switch over the wire enum of eleven relation kinds; every arm is one line and a table would hide the dispatch.',
				12,
			),
		).toBeNull();
		// THE DEAD TOKEN (reviewers' fifth round): `\btemporar\b` matched nothing —
		// "temporary" was promised as rejected by every failure message and accepted
		// by the predicate. A control that says ONLY "temporary", no other thin word.
		expect(THIN_REASONS.test('temporary')).toBe(true);
		expect(THIN_REASONS.test('contemporary art')).toBe(false);
		expect(
			thinReasonProblem(
				'This is a temporary acceptance while we wait for the upstream fix to land',
				12,
			),
		).toContain('temporary');
		// THE WORD FLOOR is measured, not spelled: a reason free of every thin word,
		// SHORT of the floor, is refused at that floor — and accepted one word
		// above it. (Measured: `words < 2` in place of `words < minWords` left every
		// gate green when no fixture sat between 2 and 11 words.)
		expect(thinReasonProblem(SHORT_HONEST_REASON, 8)).toContain('4 words');
		expect(thinReasonProblem(SHORT_HONEST_REASON, 12)).toContain('fewer than the 12');
		expect(thinReasonProblem(ELEVEN_WORD_REASON.split(/\s+/).slice(0, 8).join(' '), 8)).toBeNull();
		expect(thinReasonProblem(ELEVEN_WORD_REASON.split(/\s+/).slice(0, 7).join(' '), 8)).toContain(
			'7 words',
		);
		expect(thinReasonProblem(ELEVEN_WORD_REASON, 12)).toContain('11 words');
		expect(thinReasonProblem(`${ELEVEN_WORD_REASON} entirely.`, 12)).toBeNull();
	});
});

/** A fixture advisory entry with a reason that passes the shared validator. */
function advisory(id: number, pkg: string, reason?: string): AdvisoryEntry {
	return {
		id,
		severity: 'high',
		package: pkg,
		title: `${pkg}: fixture advisory ${id}`,
		...(reason === undefined ? {} : { reason }),
	};
}

/**
 * Reasons that are HONEST but SHORT: no blacklisted word, under every floor. The
 * word floor is the only thing standing between them and the artifact, so each
 * decision below is proved to refuse them — a constant floor is a spelling
 * until a fixture sits under it.
 */
const SHORT_HONEST_REASON = 'Unreachable from engine code';
const ELEVEN_WORD_REASON =
	'The exhaustive dispatch over the wire enum gained three arms unavoidably';
/** Says only "temporary" — the token the first blacklist could never match. */
const TEMPORARY_ONLY_REASON =
	'This is a temporary acceptance while we wait for the upstream fix to land in a release.';

const GOOD_ADVISORY_REASON =
	'Transitive only through the fixture runtime, unreachable from engine code; the published fix is a major bump tracked under the fixture row.';
const GOOD_LEDGER_LIKE_REASON =
	'Reachable only from the site-builder template lockfile, which never runs in the engine process; the fix waits on its upstream major.';

describe('GATE-20 — the dependency ratchet compares identities and records reasons in the artifact', () => {
	test('a SWAP (one advisory vanished, one new, equal count) is a regression', () => {
		// The count comparison this replaced: after (2) > before (2) is FALSE, so a
		// swap laundered flaglessly. Identity says otherwise.
		const previous = { '.': [advisory(1, 'a'), advisory(2, 'b')] };
		const swapped = { '.': [advisory(1, 'a'), advisory(3, 'c')] };
		expect(newlyAcceptedKeys(previous, swapped)).toEqual(['.::c::3']);
		// Same id under another package dir is a different identity too.
		expect(
			newlyAcceptedKeys(previous, { '.': [advisory(1, 'a')], sub: [advisory(2, 'b')] }),
		).toEqual(['sub::b::2']);
		// Controls: identical, and shrinking, are not regressions.
		expect(newlyAcceptedKeys(previous, previous)).toEqual([]);
		expect(newlyAcceptedKeys(previous, { '.': [advisory(1, 'a')] })).toEqual([]);
		expect(newlyAcceptedKeys({}, { '.': [advisory(9, 'z')] })).toEqual(['.::z::9']);
	});

	test('the --update DECISION: a swap, a missing and a conflicted baseline all refuse without the flag; the flag needs a reason; the reason lands in the new entry', () => {
		const held = {
			'.': [advisory(1, 'a', GOOD_ADVISORY_REASON), advisory(2, 'b', GOOD_ADVISORY_REASON)],
		};
		const swapped = { '.': [advisory(1, 'a'), advisory(3, 'c')] };
		const present = {
			kind: 'present' as const,
			baseline: { generated: '2026-01-01', note: '', accepted: held },
		};
		const bare = ['bun', 'audit.ts', '--update'];
		const flagged = [...bare, '--allow-regression'];
		// The count comparison it replaced said "2 vs 2, nothing new". The decision says no.
		const swap = advisoryUpdateDecision(present, swapped, bare, '2026-02-02');
		expect(swap.kind).toBe('refuse');
		if (swap.kind === 'refuse') expect(swap.message).toContain('.::c::3');
		// A missing baseline is a bootstrap where EVERY advisory is new, never an empty comparison.
		const absent = advisoryUpdateDecision({ kind: 'absent' }, swapped, bare, '2026-02-02');
		expect(absent.kind).toBe('refuse');
		if (absent.kind === 'refuse') expect(absent.message).toContain('every advisory is new');
		// A conflicted file is REFUSED even with the flag and a reason: the generator never guesses.
		const conflicted = advisoryUpdateDecision(
			{ kind: 'unparseable', error: 'SyntaxError: <<<<<<<' },
			swapped,
			[...flagged, '--reason', GOOD_ADVISORY_REASON],
			'2026-02-02',
		);
		expect(conflicted.kind).toBe('refuse');
		if (conflicted.kind === 'refuse') expect(conflicted.message).toContain('not the artifact');
		// The flag without a reason, or with a thin one, refuses.
		expect(advisoryUpdateDecision(present, swapped, flagged, '2026-02-02').kind).toBe('refuse');
		expect(
			advisoryUpdateDecision(
				present,
				swapped,
				[
					...flagged,
					'--reason',
					'This is temporary and we will refactor it later on, once upstream has shipped its fix.',
				],
				'2026-02-02',
			).kind,
		).toBe('refuse');
		// A short honest reason (4 words) and the once-dead "temporary" both refuse.
		for (const reason of [SHORT_HONEST_REASON, ELEVEN_WORD_REASON, TEMPORARY_ONLY_REASON]) {
			const short = advisoryUpdateDecision(
				present,
				swapped,
				[...flagged, '--reason', reason],
				'2026-02-02',
			);
			expect(short.kind, `accepted the reason "${reason}"`).toBe('refuse');
			if (short.kind === 'refuse') expect(short.message).toContain('--reason');
		}
		// Flag + reason: the NEW entry carries this run's reason; the KEPT entry keeps its own.
		const written = advisoryUpdateDecision(
			present,
			swapped,
			[...flagged, '--reason', GOOD_LEDGER_LIKE_REASON],
			'2026-02-02',
		);
		expect(written.kind).toBe('write');
		if (written.kind === 'write') {
			expect(written.next.generated).toBe('2026-02-02');
			const byId = new Map(written.next.accepted['.']?.map((e) => [e.id, e.reason]));
			expect(byId.get(3)).toBe(GOOD_LEDGER_LIKE_REASON);
			expect(byId.get(1)).toBe(GOOD_ADVISORY_REASON);
			expect(byId.has(2)).toBe(false);
			expect(acceptedEntryProblems(written.next)).toEqual([]);
		}
		// Controls: an unchanged census writes without any flag; a shrink too.
		expect(advisoryUpdateDecision(present, held, bare, '2026-02-02').kind).toBe('write');
		expect(
			advisoryUpdateDecision(present, { '.': [advisory(1, 'a')] }, bare, '2026-02-02').kind,
		).toBe('write');
	});

	test('the READER: a conflict-marker file is `unparseable`, never `absent` — and the script refuses it by exit code, before any network', async () => {
		// The seam the fourth round found: `updateDecision(unparseable)` was proved
		// on a hand-built fixture while the reader itself was never driven. With
		// the reader mutated to `absent` on a parse failure, a conflict marker was
		// silently bootstrapped over. This leg drives the reader on the real thing.
		expect((await readPreviousAdvisoryBaseline(CONFLICTED)).kind).toBe('unparseable');
		expect((await readPreviousAdvisoryBaseline(NOT_THE_ARTIFACT)).kind).toBe('unparseable');
		expect((await readPreviousAdvisoryBaseline(ABSENT)).kind).toBe('absent');
		const committed = await readPreviousAdvisoryBaseline();
		expect(committed.kind).toBe('present');
		// ...and the OUTCOME through main(): --update with flag AND reason over the
		// conflicted file exits 1 naming the conflict; the check path over a
		// conflicted or a missing artifact exits 1. All three return before
		// `bun audit` is spawned, so this is hermetic.
		const script = 'scripts/ci/audit.ts';
		const flagged = runGenerator([
			script,
			'--update',
			'--allow-regression',
			'--reason',
			GOOD_ADVISORY_REASON,
			'--baseline',
			CONFLICTED,
		]);
		expect(flagged.exitCode).toBe(1);
		expect(flagged.stderr).toContain('not the artifact');
		expect(flagged.stdout).not.toContain('== audit: .');
		const checkConflicted = runGenerator([script, '--baseline', CONFLICTED]);
		expect(checkConflicted.exitCode).toBe(1);
		expect(checkConflicted.stderr).toContain('not the artifact');
		const checkAbsent = runGenerator([script, '--baseline', ABSENT]);
		expect(checkAbsent.exitCode).toBe(1);
		expect(checkAbsent.stderr).toContain('missing');
	});

	test("a KEPT entry whose reason is thin takes this run's --reason; without one the refusal names the way out", () => {
		// Measured: `kept ?? reason` preserved a thin kept reason forever, so the
		// refusal's advice ("re-run with --reason") could never succeed and the
		// only exit was a hand edit of the artifact.
		const thinKept = {
			kind: 'present' as const,
			baseline: {
				generated: '2026-01-01',
				note: '',
				accepted: { '.': [advisory(1, 'a', 'accepted'), advisory(2, 'b', GOOD_ADVISORY_REASON)] },
			},
		};
		const bare = ['bun', 'audit.ts', '--update'];
		const refused = advisoryUpdateDecision(
			thinKept,
			thinKept.baseline.accepted,
			bare,
			'2026-02-02',
		);
		expect(refused.kind).toBe('refuse');
		if (refused.kind === 'refuse') {
			expect(refused.message).toContain('.::a::1');
			expect(refused.message).toContain('--reason');
		}
		const repaired = advisoryUpdateDecision(
			thinKept,
			thinKept.baseline.accepted,
			[...bare, '--reason', GOOD_LEDGER_LIKE_REASON],
			'2026-02-02',
		);
		expect(repaired.kind).toBe('write');
		if (repaired.kind === 'write') {
			const byId = new Map(repaired.next.accepted['.']?.map((e) => [e.id, e.reason]));
			expect(byId.get(1)).toBe(GOOD_LEDGER_LIKE_REASON);
			// A VALID kept reason is never overwritten by this run's.
			expect(byId.get(2)).toBe(GOOD_ADVISORY_REASON);
		}
	});

	test('a reason-less or thin accepted entry is a problem; a reasoned one is not (positive control)', () => {
		const fixture = (entries: AdvisoryEntry[]): AdvisoryBaseline => ({
			generated: '2026-01-01',
			note: '',
			accepted: { '.': entries },
		});
		expect(acceptedEntryProblems(fixture([advisory(1, 'a', GOOD_ADVISORY_REASON)]))).toEqual([]);
		const bad = acceptedEntryProblems(
			fixture([
				advisory(1, 'a'),
				advisory(2, 'b', 'accepted'),
				advisory(
					3,
					'c',
					'This is temporary and we will refactor it later on, once the upstream fix has been released.',
				),
				advisory(4, 'd', GOOD_ADVISORY_REASON),
				advisory(5, 'e', SHORT_HONEST_REASON),
				advisory(6, 'f', ELEVEN_WORD_REASON),
				advisory(7, 'g', TEMPORARY_ONLY_REASON),
			]),
		);
		expect(bad.map((line) => line.split(':')[0])).toEqual(['.', '.', '.', '.', '.', '.']);
		expect(bad.filter((line) => line.startsWith('.::a::1'))).toHaveLength(1);
		expect(bad.filter((line) => line.startsWith('.::b::2'))).toHaveLength(1);
		expect(bad.filter((line) => line.startsWith('.::c::3'))).toHaveLength(1);
		expect(bad.filter((line) => line.startsWith('.::e::5'))).toHaveLength(1);
		expect(bad.filter((line) => line.startsWith('.::f::6'))).toHaveLength(1);
		expect(bad.filter((line) => line.startsWith('.::g::7'))).toHaveLength(1);
		expect(ADVISORY_REASON_MIN_WORDS).toBeGreaterThanOrEqual(12);
	});

	test('the COMMITTED baseline: every accepted advisory carries a validated reason', () => {
		const baseline = JSON.parse(
			readFileSync(join(REPO_ROOT, 'engineering/dependency_audit_baseline.json'), 'utf8'),
		) as AdvisoryBaseline;
		// Anti-vacuity: the artifact covers every locked package (the audit's own
		// census is asserted by dependency_integrity_tripwire); here, that the map
		// is a map and was read.
		expect(Object.keys(baseline.accepted).length).toBeGreaterThanOrEqual(1);
		expect(
			acceptedEntryProblems(baseline),
			'engineering/dependency_audit_baseline.json holds an accepted advisory with no valid reason. An advisory is accepted for a reason written INTO its entry (why it is accepted rather than fixed); record it with `bun run scripts/ci/audit.ts --update --reason "<text>"`.',
		).toEqual([]);
	});
});

describe('GATE-22 — the crap baseline carries its own history, and summary must agree with it', () => {
	const fixture = (
		summary: [number, number],
		ledger: ComplexityBaseline['ledger'],
	): ComplexityBaseline => ({
		_: '',
		generated: '',
		cap: 6,
		root: 'src/core',
		summary: {
			files: 500,
			functions: 4000,
			functionsOverCap: summary[0],
			filesOverCap: summary[1],
		},
		ledger,
		files: {},
	});
	const GOOD_LEDGER_REASON =
		'The wire enum gained three relation kinds and the exhaustive dispatch over them grew by the same three arms; a table would hide the dispatch.';
	// Every fixture history begins where the real one does: the pinned birth.
	const B = LEDGER_BIRTH;
	const birth: [number, number] = [B.functionsOverCap, B.filesOverCap];
	const line = (f: number, d: number, reason?: string) => ({
		generated: '2026-09-02',
		functionsOverCap: f,
		filesOverCap: d,
		...(reason === undefined ? {} : { reason }),
	});

	test('the ledger is born ONCE: LEDGER_BIRTH is history, and a ledger not starting there is RED (positive control)', () => {
		// A constant in code, like `cap`: the artifact cannot restart its own
		// history at today's census. Pinned to the day the ledger was created.
		expect(B).toEqual({ generated: '2026-09-01', functionsOverCap: 688, filesOverCap: 268 });
		expect(Object.isFrozen(B)).toBe(true);
		expect(ledgerProblems(fixture(birth, [{ ...B }]))).toEqual([]);
		// The reviewer's forgeries: (A) summary raised AND the single line
		// overwritten to match; (B) the ledger truncated to a fresh opener.
		const overwritten = ledgerProblems(fixture([720, 280], [line(720, 280)]));
		expect(overwritten).toHaveLength(1);
		expect(overwritten[0]).toContain('must begin at its birth');
		expect(ledgerProblems(fixture([720, 268], [{ ...B, functionsOverCap: 720 }]))).toHaveLength(1);
		expect(ledgerProblems(fixture(birth, [{ ...B, generated: '2026-09-02' }]))).toHaveLength(1);
		// A reasoned growth ABOVE the birth is the only green way up.
		expect(
			ledgerProblems(fixture([720, 280], [{ ...B }, line(720, 280, GOOD_LEDGER_REASON)])),
		).toEqual([]);
	});

	test('summary must equal the LAST ledger line — a merge or hand edit that raises it is RED (positive control)', () => {
		const consistent = fixture(birth, [{ ...B }]);
		expect(ledgerProblems(consistent)).toEqual([]);
		// The GATE-22 shape: the counters were written without the generator.
		const merged = fixture([720, 280], [{ ...B }]);
		const problems = ledgerProblems(merged);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('does not equal the last ledger line');
		// EACH counter alone: a merge where functions net out flat and only a new
		// over-cap FILE remains launders if only the first counter is compared.
		const filesOnly = ledgerProblems(fixture([B.functionsOverCap, B.filesOverCap + 1], [{ ...B }]));
		expect(filesOnly).toHaveLength(1);
		expect(filesOnly[0]).toContain('does not equal the last ledger line');
		const functionsOnly = ledgerProblems(
			fixture([B.functionsOverCap + 1, B.filesOverCap], [{ ...B }]),
		);
		expect(functionsOnly).toHaveLength(1);
		// No ledger at all is not "no rules".
		expect(ledgerProblems(fixture(birth, []))).toHaveLength(1);
		expect(ledgerProblems({ ...consistent, ledger: undefined as unknown as [] })).toHaveLength(1);
		// A malformed line cannot pass as a reasoned one.
		expect(
			ledgerProblems(fixture(birth, [{ ...B }, { ...line(690, 268), generated: 'yesterday' }])),
		).not.toEqual([]);
	});

	test('a GROWTH line needs a reason the shared validator accepts; a shrink does not (positive control)', () => {
		const grownBare = fixture([700, 268], [{ ...B }, line(700, 268)]);
		expect(ledgerProblems(grownBare)).toHaveLength(1);
		expect(ledgerProblems(grownBare)[0]).toContain('GREW');
		const grownThin = fixture(
			[688, 269],
			[
				{ ...B },
				line(
					688,
					269,
					'This is temporary and we will refactor it later on, once the new module has settled down.',
				),
			],
		);
		expect(ledgerProblems(grownThin)).toHaveLength(1);
		const grownReasoned = fixture([700, 268], [{ ...B }, line(700, 268, GOOD_LEDGER_REASON)]);
		expect(ledgerProblems(grownReasoned)).toEqual([]);
		const shrunk = fixture([600, 200], [{ ...B }, line(600, 200)]);
		expect(ledgerProblems(shrunk)).toEqual([]);
		expect(LEDGER_REASON_MIN_WORDS).toBeGreaterThanOrEqual(12);
		// EVERY line is held to the rule, not only the last: an unreasoned growth
		// in the MIDDLE, laundered by a trailing shrink line that summary matches.
		// (Measured: `index === ledger.length - 1` on the reason check was green.)
		const middleGrowth = fixture([719, 280], [{ ...B }, line(720, 280), line(719, 280)]);
		const middle = ledgerProblems(middleGrowth);
		expect(middle).toHaveLength(1);
		expect(middle[0]).toStartWith('ledger[1]');
		expect(
			ledgerProblems(
				fixture([719, 280], [{ ...B }, line(720, 280, GOOD_LEDGER_REASON), line(719, 280)]),
			),
		).toEqual([]);
		// FLAT counters are not a shrink: the generator appends a flat line only
		// for a per-file raise, and that line needs its reason like any growth.
		// (Measured: dropping the strict-less clause made flat lines free.)
		const flatBare = fixture(birth, [{ ...B }, line(...birth)]);
		expect(ledgerProblems(flatBare)).toHaveLength(1);
		expect(ledgerProblems(flatBare)[0]).toContain('flat counters');
		expect(ledgerProblems(fixture(birth, [{ ...B }, line(...birth, GOOD_LEDGER_REASON)]))).toEqual(
			[],
		);
		// One counter up and the other down is a growth, not a shrink.
		const mixed = fixture([687, 269], [{ ...B }, line(687, 269)]);
		expect(ledgerProblems(mixed)).toHaveLength(1);
		expect(ledgerProblems(mixed)[0]).toContain('GREW');
		// The word floor and the once-dead token, on a ledger line.
		for (const reason of [SHORT_HONEST_REASON, ELEVEN_WORD_REASON, TEMPORARY_ONLY_REASON]) {
			expect(
				ledgerProblems(fixture([700, 268], [{ ...B }, line(700, 268, reason)])),
				`accepted the reason "${reason}"`,
			).toHaveLength(1);
		}
	});

	test('append-only is PROVED where history exists: a reference ledger must be a prefix of the working one', () => {
		// The edit the hermetic predicate cannot see — a rewritten middle line —
		// is exactly what a git reference (the merge-base, on a full checkout) can.
		const reference = fixture([700, 268], [{ ...B }, line(700, 268, GOOD_LEDGER_REASON)]);
		expect(ledgerPrefixProblems(reference, reference)).toEqual([]);
		const appended = fixture([650, 260], [...reference.ledger, line(650, 260)]);
		expect(ledgerPrefixProblems(reference, appended)).toEqual([]);
		// The rewritten last line (and the summary raised to match): the line is
		// flagged AND the raised counter has no line beyond the prefix — two problems.
		const rewritten = fixture([720, 268], [{ ...B }, line(720, 268, GOOD_LEDGER_REASON)]);
		expect(ledgerPrefixProblems(reference, rewritten)).toHaveLength(2);
		expect(ledgerPrefixProblems(reference, rewritten).join('\n')).toContain('rewritten');
		const reasonSwapped = fixture([700, 268], [{ ...B }, line(700, 268, 'x')]);
		expect(ledgerPrefixProblems(reference, reasonSwapped)).toHaveLength(1);
		const dateMoved = fixture(
			[700, 268],
			[{ ...B }, { ...line(700, 268, GOOD_LEDGER_REASON), generated: '2026-09-03' }],
		);
		expect(ledgerPrefixProblems(reference, dateMoved)).toHaveLength(1);
		// A per-file entry raised over the reference with the counters flat is a
		// growth the counters cannot see; against a reference it must have a line.
		const fileRaised = { ...reference, files: { 'src/core/x.ts': 12 } };
		const referenceWithFile = { ...reference, files: { 'src/core/x.ts': 9 } };
		expect(ledgerPrefixProblems(referenceWithFile, fileRaised)).toHaveLength(1);
		expect(ledgerPrefixProblems(referenceWithFile, fileRaised)[0]).toContain(
			'raised over the reference',
		);
		expect(
			ledgerPrefixProblems(referenceWithFile, {
				...fileRaised,
				ledger: [...reference.ledger, line(700, 268, GOOD_LEDGER_REASON)],
			}),
		).toEqual([]);
		// THE LAUNDERING VARIANT (2026-09-02 review): the raise paired with a
		// simplification elsewhere, so the appended line is a NET SHRINK — which
		// needs no reason by design. "A line was appended" is not the rule; "the
		// raise has a reasoned line" is. Both the pure predicate and the exit code.
		const raiseUnderShrink = {
			...fileRaised,
			summary: { ...fileRaised.summary, functionsOverCap: 699 },
			ledger: [...reference.ledger, line(699, 268)],
		};
		expect(ledgerProblems(raiseUnderShrink)).toEqual([]);
		expect(ledgerPrefixProblems(referenceWithFile, raiseUnderShrink)).toHaveLength(1);
		expect(ledgerPrefixProblems(referenceWithFile, raiseUnderShrink)[0]).toContain(
			'carry no validated reason',
		);
		// ...a shrink line PLUS a reasoned line is fine; a thin reason is not.
		expect(
			ledgerPrefixProblems(referenceWithFile, {
				...raiseUnderShrink,
				summary: { ...fileRaised.summary, functionsOverCap: 700 },
				ledger: [...raiseUnderShrink.ledger, line(700, 268, GOOD_LEDGER_REASON)],
			}),
		).toEqual([]);
		for (const reason of [SHORT_HONEST_REASON, ELEVEN_WORD_REASON, TEMPORARY_ONLY_REASON]) {
			expect(
				ledgerPrefixProblems(referenceWithFile, {
					...raiseUnderShrink,
					ledger: [...reference.ledger, line(699, 268, reason)],
				}),
				`accepted the reason "${reason}" on a raise`,
			).toHaveLength(1);
		}
		const truncated = fixture(birth, [{ ...B }]);
		expect(ledgerPrefixProblems(reference, truncated)).toHaveLength(1);
		expect(ledgerPrefixProblems(reference, truncated)[0]).toContain('truncated');
		// A pre-ledger reference (no history yet) constrains nothing — stated, not hidden.
		expect(
			ledgerPrefixProblems({ ...reference, ledger: undefined as unknown as [] }, appended),
		).toEqual([]);
		// ...and --check honours the flag by OUTCOME: an explicit reference that
		// does not resolve is a red run, never a skipped leg (a spelling check on
		// the wiring stayed green with the branch neutered to `if (false)`).
		const run = Bun.spawnSync(
			['bun', 'run', 'scripts/crap_baseline.ts', '--check', '--reference', 'no-such-revision-ever'],
			{ cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
		);
		expect(run.exitCode).toBe(1);
		expect(run.stderr.toString()).toContain('--reference no-such-revision-ever');
		// ...and the EXIT CODE of a prefix problem itself (the no-such-revision run
		// exits 1 through the loader's throw, which says nothing about the branch
		// that turns `ledgerPrefixProblems` into a red run — measured, that branch
		// neutered to `> 1000` was green). `--reference` reads an existing file
		// as the artifact, so the working tree and the reference are both scratch:
		// a reference whose history the working artifact REWROTE, one it
		// TRUNCATED, and an identical one as the control.
		const committed = loadBaseline();
		const CURRENT = join(SCRATCH, 'current.json');
		const REFERENCE = join(SCRATCH, 'reference.json');
		const scratch = (artifact: ComplexityBaseline) =>
			writeFileSync(CURRENT, `${JSON.stringify(artifact, null, '\t')}\n`);
		const checkAgainst = (artifact: ComplexityBaseline) => {
			writeFileSync(REFERENCE, `${JSON.stringify(artifact, null, '\t')}\n`);
			return runGenerator([
				'scripts/crap_baseline.ts',
				'--check',
				'--baseline',
				CURRENT,
				'--reference',
				REFERENCE,
			]);
		};
		scratch(committed);
		const identical = checkAgainst(committed);
		expect(identical.stderr).not.toContain('DEBT LEDGER');
		const grownHistory = checkAgainst({
			...committed,
			ledger: [...committed.ledger, line(600, 200)],
		});
		expect(grownHistory.exitCode).toBe(1);
		expect(grownHistory.stderr).toContain('DEBT LEDGER');
		expect(grownHistory.stderr).toContain('truncated');
		const rewrittenHistory = checkAgainst({
			...committed,
			ledger: [{ ...B, reason: GOOD_LEDGER_REASON }, ...committed.ledger.slice(1)],
		});
		expect(rewrittenHistory.exitCode).toBe(1);
		expect(rewrittenHistory.stderr).toContain('rewritten');
		// The flat-counter per-file hand raise — the edit only a reference sees.
		const [someFile, someMax] = Object.entries(committed.files)[0] as [string, number];
		scratch({ ...committed, files: { ...committed.files, [someFile]: someMax + 5 } });
		const handRaised = checkAgainst(committed);
		expect(handRaised.exitCode).toBe(1);
		expect(handRaised.stderr).toContain('raised over the reference');
		// The same raise laundered under an appended unreasoned NET-SHRINK line.
		const lastLine = committed.ledger.at(-1) as LedgerEntry;
		scratch({
			...committed,
			files: { ...committed.files, [someFile]: someMax + 5 },
			summary: { ...committed.summary, functionsOverCap: lastLine.functionsOverCap - 1 },
			ledger: [...committed.ledger, line(lastLine.functionsOverCap - 1, lastLine.filesOverCap)],
		});
		const laundered = checkAgainst(committed);
		expect(laundered.exitCode).toBe(1);
		expect(laundered.stderr).toContain('carry no validated reason');
		// An EMPTY reference is a red run, not a comparison against the index:
		// `git show ':<path>'` reads the index, so `--reference ""` (what
		// `--reference "$(git merge-base …)"` yields when merge-base fails) was a
		// green run over nothing — and so was a bare trailing `--reference`.
		scratch(committed);
		for (const argv of [
			['scripts/crap_baseline.ts', '--check', '--baseline', CURRENT, '--reference', ''],
			['scripts/crap_baseline.ts', '--check', '--baseline', CURRENT, '--reference=  '],
			['scripts/crap_baseline.ts', '--check', '--baseline', CURRENT, '--reference'],
		]) {
			const empty = runGenerator(argv);
			expect(empty.exitCode, `argv ${JSON.stringify(argv.slice(4))}`).toBe(1);
			expect(empty.stderr).toContain('--reference');
		}
		rmSync(CURRENT, { force: true });
		rmSync(REFERENCE, { force: true });
		// ~8 `bun run scripts/crap_baseline.ts` children, each loading the generator cold:
		// a few seconds on a desk, past the suite's 30 s on a contended hosted runner
		// (GitHub ci 41327866839 died at 30014 ms). The work is real; the cap is sized to it.
	}, 120000);

	test('the generator appends on change only, carries the reason into the line, and refuses its own unreasoned growth', () => {
		const previous = fixture(birth, [{ ...B }]);
		// Unchanged census: the ledger is carried byte-identically (idempotent --update).
		expect(appendLedger(previous, fixture(birth, []), null, '2026-09-05').ledger).toEqual(
			previous.ledger,
		);
		// Growth without a reason: the writer's own predicate is what refuses it.
		const bare = appendLedger(previous, fixture([689, 268], []), null, '2026-09-05');
		expect(bare.ledger).toHaveLength(2);
		expect(ledgerProblems(bare)).toHaveLength(1);
		// Growth with a reason: the reason is IN the appended line.
		const reasoned = appendLedger(
			previous,
			fixture([689, 268], []),
			GOOD_LEDGER_REASON,
			'2026-09-05',
		);
		expect(reasoned.ledger.at(-1)).toEqual({
			generated: '2026-09-05',
			functionsOverCap: 689,
			filesOverCap: 268,
			reason: GOOD_LEDGER_REASON,
		});
		expect(ledgerProblems(reasoned)).toEqual([]);
	});

	test('the --update DECISION: a conflicted baseline refuses outright; a missing one is a bootstrap that still takes the flag; growth takes flag AND reason', () => {
		const measured = fixture([689, 268], []);
		measured.files = { 'src/core/x.ts': 9 };
		const present = { kind: 'present' as const, baseline: fixture(birth, [{ ...B }]) };
		const plain = { allowRegression: false, reason: null, today: '2026-09-05' };
		const flagged = { ...plain, allowRegression: true };
		// Conflicted: refused even with flag + reason — the generator never guesses.
		const conflicted = crapUpdateDecision(
			{ kind: 'unparseable', error: 'not valid JSON' },
			measured,
			{ ...flagged, reason: GOOD_LEDGER_REASON },
		);
		expect(conflicted.kind).toBe('refuse');
		if (conflicted.kind === 'refuse') expect(conflicted.message).toContain('not the artifact');
		// Absent: every over-cap file is new — the flag applies in full.
		const absent = crapUpdateDecision({ kind: 'absent' }, measured, plain);
		expect(absent.kind).toBe('refuse');
		if (absent.kind === 'refuse') expect(absent.message).toContain('every over-cap file is new');
		// Growth without the flag; the flag without a reason; a thin reason.
		expect(crapUpdateDecision(present, measured, plain).kind).toBe('refuse');
		expect(crapUpdateDecision(present, measured, flagged).kind).toBe('refuse');
		expect(
			crapUpdateDecision(present, measured, {
				...flagged,
				reason:
					'This is temporary and we will refactor it later on, once the new module has settled down.',
			}).kind,
		).toBe('refuse');
		for (const reason of [SHORT_HONEST_REASON, ELEVEN_WORD_REASON, TEMPORARY_ONLY_REASON]) {
			expect(
				crapUpdateDecision(present, measured, { ...flagged, reason }).kind,
				`accepted the reason "${reason}"`,
			).toBe('refuse');
		}
		// Flag + reason: written, with the reason in the appended line and the
		// history intact behind it — and the bootstrap's ledger begins at the birth.
		const written = crapUpdateDecision(present, measured, {
			...flagged,
			reason: GOOD_LEDGER_REASON,
		});
		expect(written.kind).toBe('write');
		if (written.kind === 'write') {
			expect(written.baseline.ledger[0]).toEqual({ ...B });
			expect(written.baseline.ledger.at(-1)).toEqual({
				generated: '2026-09-05',
				functionsOverCap: 689,
				filesOverCap: 268,
				reason: GOOD_LEDGER_REASON,
			});
			expect(ledgerProblems(written.baseline)).toEqual([]);
		}
		const bootstrapped = crapUpdateDecision({ kind: 'absent' }, measured, {
			...flagged,
			reason: GOOD_LEDGER_REASON,
		});
		expect(bootstrapped.kind).toBe('write');
		if (bootstrapped.kind === 'write') expect(bootstrapped.baseline.ledger[0]).toEqual({ ...B });
		// A per-file raise with the counters FLAT is still a regression: refused
		// without the flag, refused with the flag and no reason, and with a reason
		// it lands as a flat, reasoned ledger line (the reason cannot vanish).
		const flatRaise = fixture(birth, []);
		flatRaise.files = { 'src/core/x.ts': 12 };
		const presentWithFile = {
			kind: 'present' as const,
			baseline: { ...fixture(birth, [{ ...B }]), files: { 'src/core/x.ts': 9 } },
		};
		expect(crapUpdateDecision(presentWithFile, flatRaise, plain).kind).toBe('refuse');
		expect(crapUpdateDecision(presentWithFile, flatRaise, flagged).kind).toBe('refuse');
		const flatWritten = crapUpdateDecision(presentWithFile, flatRaise, {
			...flagged,
			reason: GOOD_LEDGER_REASON,
		});
		expect(flatWritten.kind).toBe('write');
		if (flatWritten.kind === 'write') {
			expect(flatWritten.baseline.ledger).toHaveLength(2);
			expect(flatWritten.baseline.ledger.at(-1)).toEqual({
				...line(...birth, GOOD_LEDGER_REASON),
				generated: '2026-09-05',
			});
		}
		// The tolerance is ZERO: a per-file raise by exactly ONE is a regression
		// (measured: `value > before + 2` left the 9 -> 12 fixture green).
		const raisedByOne = fixture(birth, []);
		raisedByOne.files = { 'src/core/x.ts': 10 };
		expect(crapUpdateDecision(presentWithFile, raisedByOne, plain).kind).toBe('refuse');
		expect(crapUpdateDecision(presentWithFile, raisedByOne, flagged).kind).toBe('refuse');
		// A file-for-file SWAP with the counters flat (one over-cap file gone, a
		// NEW one at the same complexity) is new debt: the NEW-file branch of
		// raisedEntries is the only thing that sees it. (Measured: with that
		// branch removed, a plain --update froze the swap.)
		const swapped = fixture(birth, []);
		swapped.files = { 'src/core/y.ts': 9 };
		expect(crapUpdateDecision(presentWithFile, swapped, plain).kind).toBe('refuse');
		const swapRefusal = crapUpdateDecision(presentWithFile, swapped, plain);
		if (swapRefusal.kind === 'refuse') expect(swapRefusal.message).toContain('NEW over-cap file');
		expect(crapUpdateDecision(presentWithFile, swapped, flagged).kind).toBe('refuse');
		const swapWritten = crapUpdateDecision(presentWithFile, swapped, {
			...flagged,
			reason: GOOD_LEDGER_REASON,
		});
		expect(swapWritten.kind).toBe('write');
		if (swapWritten.kind === 'write') expect(swapWritten.baseline.ledger).toHaveLength(2);
		// Controls: unchanged and shrunk censuses write with no flag at all.
		expect(crapUpdateDecision(present, fixture(birth, []), plain).kind).toBe('write');
		expect(crapUpdateDecision(present, fixture([600, 200], []), plain).kind).toBe('write');
		// ...and the --update path is wired to the decision, refusing BEFORE the write.
		const source = readFileSync(join(REPO_ROOT, 'scripts/crap_baseline.ts'), 'utf8');
		const start = source.indexOf('\tif (update) {');
		const updateBlock = source.slice(start, source.indexOf('writeFileSync(', start));
		expect(updateBlock.length).toBeGreaterThan(100);
		expect(updateBlock).toContain('updateDecision(readPreviousBaseline(baselinePath)');
		expect(updateBlock).toContain("decision.kind === 'refuse'");
	});

	test('the READER: a conflict-marker file is `unparseable`, never `absent` — and --update refuses it by exit code, flag and reason notwithstanding', () => {
		// Same seam as the advisory leg: the reader itself, driven on a real
		// conflict-marker file, then the script's exit code over a scratch copy.
		expect(readPreviousCrapBaseline(CONFLICTED).kind).toBe('unparseable');
		expect(readPreviousCrapBaseline(NOT_THE_ARTIFACT).kind).toBe('unparseable');
		expect(readPreviousCrapBaseline(ABSENT).kind).toBe('absent');
		expect(readPreviousCrapBaseline().kind).toBe('present');
		expect(() => loadBaseline(CONFLICTED)).toThrow('not valid JSON');
		expect(() => loadBaseline(ABSENT)).toThrow('missing');
		const script = 'scripts/crap_baseline.ts';
		const flagged = runGenerator([
			script,
			'--update',
			'--allow-regression',
			'--reason',
			GOOD_LEDGER_REASON,
			'--baseline',
			CONFLICTED,
		]);
		expect(flagged.exitCode).toBe(1);
		expect(flagged.stderr).toContain('not the artifact');
		expect(readFileSync(CONFLICTED, 'utf8')).toContain('<<<<<<< HEAD');
		// The check path over the same file is red too — and over a missing one.
		expect(runGenerator([script, '--check', '--baseline', CONFLICTED]).exitCode).toBe(1);
		expect(runGenerator([script, '--check', '--baseline', ABSENT]).exitCode).toBe(1);
		// A missing file with the flag and a reason is the ONE way a bootstrap
		// happens, and it writes a ledger born at LEDGER_BIRTH — never today.
		const bootstrap = runGenerator([
			script,
			'--update',
			'--allow-regression',
			'--reason',
			GOOD_LEDGER_REASON,
			'--baseline',
			ABSENT,
		]);
		expect(bootstrap.exitCode).toBe(0);
		const born = loadBaseline(ABSENT);
		expect(born.ledger[0]).toEqual({ ...B });
		expect(ledgerProblems(born)).toEqual([]);
		rmSync(ABSENT, { force: true });
		// The value-taking flags share ONE reader.
		expect(readFlagValue(['--baseline', '--check'], '--baseline')).toBeNull();
		expect(readFlagValue(['--baseline=x'], '--baseline')).toBe('x');
	});

	test('the COMMITTED baseline: born at LEDGER_BIRTH, summary equals its last ledger line and every growth is reasoned', () => {
		const baseline = loadBaseline();
		expect(baseline.ledger.length).toBeGreaterThanOrEqual(1);
		expect(baseline.ledger[0]).toEqual({ ...B });
		expect(baseline.summary.functionsOverCap).toBeGreaterThan(0);
		expect(
			ledgerProblems(baseline),
			'engineering/crap_complexity_baseline.json was written without the generator, its history was truncated, or its debt grew without a reason in the ledger. Never hand-edit it: `bun run scripts/crap_baseline.ts --update` (growth: `--allow-regression --reason "<text>"`).',
		).toEqual([]);
	});
});
