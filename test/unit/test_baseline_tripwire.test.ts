/**
 * TEST BASELINE ARTIFACTS — the schema gate over engineering/test_baseline/.
 *
 * WHY. The suite baseline used to be a failset text file diffed by eye, and
 * that measure had four verified holes (bun's default reporter names only
 * failures; three '(fail) (unnamed)' lines collapse under set-compare; no file
 * attribution; a deregistered test SHRINKS the failset and scores as a pass —
 * see the header of scripts/test_baseline.ts). The replacement is a per-test,
 * three-state, file-attributed record written by `bun run test:baseline`. This
 * gate makes those artifacts trustworthy: WHEN PRESENT they parse to the
 * declared schema, name only files that exist on disk, and the
 * FLAPPING/ORDER_SENSITIVE set carries the shrink-only ratchet's paper trail
 * (an entry newer than the seed campaign must have an accepted_growth reason).
 *
 * ONE IMPLEMENTATION OF THE SCHEMA. The validators live in
 * scripts/test_baseline.ts and are IMPORTED here — the generator validates its
 * own output with the same functions this gate runs, so the tool cannot write
 * an artifact its gate rejects, and a second drift-prone schema copy never
 * exists. (The script's runner is behind `import.meta.main`; importing it
 * executes nothing.)
 *
 * FRESH-CLONE BEHAVIOUR. Before any campaign has run the artifacts do not
 * exist, and this gate SKIPS LOUDLY — a console line naming the command that
 * produces them — never silently: absence is a fact worth printing, not a
 * green worth trusting. A file that EXISTS but does not parse is red, always;
 * ENOENT is the only acquittal.
 *
 * MID-CAMPAIGN BEHAVIOUR (load-bearing): the campaign's child runs execute
 * THIS gate against the artifacts the campaign is writing. runs.json with
 * `complete: false` is therefore legal schema (the tool writes atomically —
 * temp + rename — so a torn read cannot happen), and this gate does NOT
 * require the three artifacts to agree on a commit: order_sensitive.json from
 * the prior campaign lawfully coexists with an in-flight runs.json.
 *
 * WHAT THIS GATE CANNOT SEE, stated plainly: it validates STRUCTURE and the
 * ratchet's reason ledger, not truth — a deliberate delete-and-reseed of
 * order_sensitive.json resets first_seen and only the git diff of the artifact
 * shows it. The write-time refusal lives in the tool (--accept-growth); this
 * gate is the second lock, not the only one.
 *
 * HERMETIC: filesystem reads only. No DB, no network, no child process.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	assertCapAdjacentArtifact,
	assertOrderSensitiveArtifact,
	assertRunsArtifact,
	assertTimingsArtifact,
	CAP_ADJACENT_SCHEMA,
	capAdjacentEntries,
	classify,
	compareCandidate,
	DEFAULT_ARTIFACT_DIR,
	makeKey,
	ORDER_SENSITIVE_SCHEMA,
	parseJunitCases,
	REPO_ROOT,
	RUNS_SCHEMA,
} from '../../scripts/test_baseline.ts';

/** A test file that exists BY CONSTRUCTION: this one. Synthetic artifacts key
 * against it so the exists-on-disk rule is exercised with a real path. */
const SELF = 'test/unit/test_baseline_tripwire.test.ts';
const SELF_KEY = makeKey(SELF, 'suite > some test');

const RERUN_HINT =
	'[test_baseline_tripwire] engineering/test_baseline/%s absent — no campaign recorded yet. ' +
	'Run `bun run test:baseline` (or `bun run test:timings`) to produce it; skipping its checks LOUDLY, not silently.';

/** ENOENT ⇒ loud skip (returns undefined). ANY other defect — unreadable,
 * unparseable — propagates and reddens the gate: only absence acquits. */
function loadArtifact(name: string): unknown {
	const path = join(DEFAULT_ARTIFACT_DIR, name);
	if (!existsSync(path)) {
		console.warn(RERUN_HINT.replace('%s', name));
		return undefined;
	}
	return JSON.parse(readFileSync(path, 'utf8'));
}

// ── synthetic VALID artifacts (the base every positive control mutates) ──────
// deep-cloned per use; a mutation in one control must not leak into the next.

const SHA = 'a'.repeat(40);
const NOW = '2026-08-25T00:00:00.000Z';

function validRuns(): Record<string, unknown> {
	return {
		schema: RUNS_SCHEMA,
		generated: NOW,
		commit: SHA,
		timeout_ms: 30000,
		cap_adjacent_threshold: 0.3,
		files: null,
		fixed_runs_planned: 2,
		order_runs_planned: 1,
		order_seeds: [12345],
		keys: [SELF_KEY],
		runs: [
			{
				kind: 'fixed',
				index: 0,
				seed: null,
				started: NOW,
				wall_ms: 100,
				exit_code: 0,
				statuses: 'p',
				durations_ms: [1.5],
			},
			{
				kind: 'fixed',
				index: 1,
				seed: null,
				started: NOW,
				wall_ms: 100,
				exit_code: 0,
				statuses: 'p',
				durations_ms: [1.5],
			},
			{
				kind: 'order',
				index: 2,
				seed: 12345,
				started: NOW,
				wall_ms: 100,
				exit_code: 1,
				statuses: 'f',
				durations_ms: [9500],
			},
		],
		complete: true,
		summary: { stable_green: 0, stable_red: 0, flapping: 0, order_sensitive: 1, cap_adjacent: 1 },
	};
}

function validOrderSensitive(): Record<string, unknown> {
	return {
		schema: ORDER_SENSITIVE_SCHEMA,
		generated: NOW,
		commit: SHA,
		seeded: NOW,
		fixed_runs: 2,
		order_runs: 1,
		seeds: [12345],
		entries: [
			{
				key: SELF_KEY,
				file: SELF,
				classification: 'ORDER_SENSITIVE',
				outcomes: { pass: 2, fail: 1, skip: 0, absent: 0 },
				first_seen: NOW,
			},
		],
		accepted_growth: [],
	};
}

function validCapAdjacent(): Record<string, unknown> {
	return {
		schema: CAP_ADJACENT_SCHEMA,
		generated: NOW,
		commit: SHA,
		timeout_ms: 30000,
		threshold: 0.3,
		entries: [{ key: SELF_KEY, file: SELF, worst_ms: 9500, ratio: 0.317 }],
	};
}

function validTimings(): Record<string, unknown> {
	return {
		version: 1,
		files: { [SELF]: 120 },
		meta: { generated: NOW, commit: SHA, command: 'bun run test:timings' },
	};
}

/** `array[0]` under noUncheckedIndexedAccess, for sabotage lambdas that break
 * a first entry the base-valid artifact is GUARANTEED to have. */
function firstOf<T>(value: unknown): T {
	return (value as T[])[0] as T;
}

describe('test baseline artifacts — schema, provenance, shrink-only ratchet', () => {
	// ── the real artifacts, when a campaign has recorded them ─────────────────

	test('runs.json (when present) parses, names real files, and is FULL-SUITE scope', () => {
		const raw = loadArtifact('runs.json');
		if (raw === undefined) return; // loud skip printed above
		const artifact = assertRunsArtifact(raw);
		// A file-scoped (tiny-mode) campaign must live in its own --out-dir; one
		// committed HERE would quietly narrow what "the baseline" measures.
		expect(
			artifact.files,
			'engineering/test_baseline/runs.json is file-scoped — the committed baseline must cover the full suite; tiny-mode campaigns take --out-dir',
		).toBeNull();
	});

	test('order_sensitive.json (when present) parses and its ratchet ledger is intact', () => {
		const raw = loadArtifact('order_sensitive.json');
		if (raw === undefined) return;
		assertOrderSensitiveArtifact(raw); // includes the first_seen/seeded/reason rule
	});

	test('cap_adjacent.json (when present) parses and every entry really exceeds the threshold', () => {
		const raw = loadArtifact('cap_adjacent.json');
		if (raw === undefined) return;
		assertCapAdjacentArtifact(raw);
	});

	test('timings.json (when present) is bun-consumable AND carries wrapper provenance', () => {
		const raw = loadArtifact('timings.json');
		if (raw === undefined) return;
		assertTimingsArtifact(raw);
	});

	// ── POSITIVE CONTROLS: each synthetic defect MUST redden the validator ───
	// The base artifacts pass (asserted first — a validator rejecting its own
	// valid shape would make every control below vacuous), then one field is
	// broken per control and the validator must throw.

	test('positive control: the valid synthetic artifacts PASS (else every control is vacuous)', () => {
		expect(() => assertRunsArtifact(validRuns())).not.toThrow();
		expect(() => assertOrderSensitiveArtifact(validOrderSensitive())).not.toThrow();
		expect(() => assertCapAdjacentArtifact(validCapAdjacent())).not.toThrow();
		expect(() => assertTimingsArtifact(validTimings())).not.toThrow();
	});

	test('positive controls: runs.json defects are RED', () => {
		const controls: [string, (a: Record<string, unknown>) => void][] = [
			['not an object at all', () => assertRunsArtifact('[]')],
			['wrong schema tag', (a) => (a.schema = 'dedalo.test_baseline.runs/0')],
			['no commit provenance', (a) => (a.commit = 'HEAD')],
			// ANTI-VACUITY FLOOR: an EMPTIED measurement must be red, never green.
			['zero keys (measured nothing)', (a) => (a.keys = [])],
			['zero runs (recorded nothing)', (a) => (a.runs = [])],
			[
				'key naming a file not on disk',
				(a) => (a.keys = [makeKey('test/unit/no_such_file.test.ts', 'x')]),
			],
			['statuses shorter than keys', (a) => (firstOf<{ statuses: string }>(a.runs).statuses = '')],
			[
				'status char outside p/f/s/a',
				(a) => (firstOf<{ statuses: string }>(a.runs).statuses = 'x'),
			],
			// `?? fail(...)` treats an undefined summary exactly like a missing one.
			['complete without summary', (a) => (a.summary = undefined)],
			['files scoped but empty', (a) => (a.files = [])],
		];
		for (const [label, sabotage] of controls) {
			const artifact = validRuns();
			expect(() => {
				sabotage(artifact);
				assertRunsArtifact(artifact);
			}, `control not detected: ${label}`).toThrow();
		}
	});

	test('positive controls: order_sensitive.json defects are RED — including a reason-less growth', () => {
		const controls: [string, (a: Record<string, unknown>) => void][] = [
			['wrong schema tag', (a) => (a.schema = 'nope')],
			[
				'entry file disagrees with its key',
				(a) => (firstOf<{ file: string }>(a.entries).file = 'test/unit/other.test.ts'),
			],
			[
				'unknown classification',
				(a) => (firstOf<{ classification: string }>(a.entries).classification = 'SOMETIMES'),
			],
			[
				'outcomes do not sum to the run count',
				(a) => (firstOf<{ outcomes: { pass: number } }>(a.entries).outcomes.pass = 99),
			],
			// THE RATCHET RULE: an entry newer than the seed campaign with no
			// accepted_growth reason is exactly the hand-edit this gate exists for.
			[
				'post-seed entry without an accepted_growth reason',
				(a) => (firstOf<{ first_seen: string }>(a.entries).first_seen = '2026-09-01T00:00:00.000Z'),
			],
			[
				'accepted_growth with an empty reason',
				(a) => (a.accepted_growth = [{ key: SELF_KEY, date: NOW, reason: '  ' }]),
			],
		];
		for (const [label, sabotage] of controls) {
			const artifact = validOrderSensitive();
			expect(() => {
				sabotage(artifact);
				assertOrderSensitiveArtifact(artifact);
			}, `control not detected: ${label}`).toThrow();
		}
	});

	test('positive controls: cap_adjacent.json and timings.json defects are RED', () => {
		const cap = validCapAdjacent();
		firstOf<{ worst_ms: number }>(cap.entries).worst_ms = 100; // below threshold ⇒ fabricated
		expect(() => assertCapAdjacentArtifact(cap)).toThrow();
		const cap2 = validCapAdjacent();
		firstOf<{ ratio: number }>(cap2.entries).ratio = 0.9; // disagrees with worst_ms
		expect(() => assertCapAdjacentArtifact(cap2)).toThrow();

		const bare = validTimings();
		bare.meta = undefined; // a bare `bun test --update-timings` strips provenance
		expect(() => assertTimingsArtifact(bare)).toThrow();
		const empty = validTimings();
		empty.files = {}; // timed nothing ⇒ anti-vacuity floor
		expect(() => assertTimingsArtifact(empty)).toThrow();
	});

	// ── ANTI-VACUITY of the MEASURE itself: the parser + classifiers see the
	// states the whole design exists to record. A parser that dropped failures,
	// skips or durations would make every campaign green and worthless. ───────

	test('ANTI-VACUITY: the JUnit parser SEES pass, fail, skip and per-case duration', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3">
  <testsuite name="${SELF}" file="${SELF}" tests="3">
    <testsuite name="suite" file="${SELF}" line="1" tests="3">
      <testcase name="green one" classname="suite" time="0.002" file="${SELF}" line="2" />
      <testcase name="red one" classname="suite" time="9.5" file="${SELF}" line="3">
        <failure type="AssertionError">expected &lt;a&gt; to be &quot;b&quot;</failure>
      </testcase>
      <testcase name="skipped one" classname="suite" time="0" file="${SELF}" line="4">
        <skipped />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;
		const cases = parseJunitCases(xml);
		expect(cases.length).toBe(3);
		expect(cases.map((c) => c.status)).toEqual(['pass', 'fail', 'skip']);
		expect(cases.every((c) => c.file === SELF)).toBe(true);
		expect(cases[1]?.durationMs).toBeCloseTo(9500, 3);
		// An empty document parses to ZERO cases — and the runner refuses to
		// record a zero-case run, so a broken reporter cannot become a baseline.
		expect(parseJunitCases('<?xml version="1.0"?><testsuites></testsuites>').length).toBe(0);
	});

	test('ANTI-VACUITY: the classifiers separate flapping from order-sensitive and see the cap', () => {
		// Key 0 flips WITHIN the fixed runs (FLAPPING); key 1 is constant across
		// fixed runs and flips only when order runs join (ORDER_SENSITIVE, via
		// ABSENCE — the deregistered-test hole the old subset-compare scored as
		// a pass); key 2 never changes (stable green).
		const runs = {
			keys: [makeKey(SELF, 'a'), makeKey(SELF, 'b'), makeKey(SELF, 'c')],
			runs: [
				{
					kind: 'fixed',
					index: 0,
					seed: null,
					started: NOW,
					wall_ms: 1,
					exit_code: 0,
					statuses: 'ppp',
					durations_ms: [1, 1, 9100],
				},
				{
					kind: 'fixed',
					index: 1,
					seed: null,
					started: NOW,
					wall_ms: 1,
					exit_code: 1,
					statuses: 'fpp',
					durations_ms: [1, 1, 1],
				},
				{
					kind: 'order',
					index: 2,
					seed: 7,
					started: NOW,
					wall_ms: 1,
					exit_code: 0,
					statuses: 'pap',
					durations_ms: [1, -1, 1],
				},
			],
		} as Parameters<typeof classify>[0];
		const result = classify(runs, NOW);
		expect(result.flapping.map((e) => e.key)).toEqual([makeKey(SELF, 'a')]);
		expect(result.orderSensitive.map((e) => e.key)).toEqual([makeKey(SELF, 'b')]);
		expect(result.stableGreen).toEqual([makeKey(SELF, 'c')]);
		expect(result.orderSensitive[0]?.outcomes).toEqual({ pass: 2, fail: 0, skip: 0, absent: 1 });
		// Duration census: 9100 ms / 30000 ms > 0.3 ⇒ exactly key 2, worst case kept.
		const cap = capAdjacentEntries(runs, 30000, 0.3);
		expect(cap.map((e) => e.key)).toEqual([makeKey(SELF, 'c')]);
		expect(cap[0]?.worst_ms).toBe(9100);
	});

	test('ANTI-VACUITY: the comparator names every assertion a moved key breaks', () => {
		const key = (name: string): string => makeKey(SELF, name);
		const fixed = (index: number, statuses: string) => ({
			kind: 'fixed' as const,
			index,
			seed: null,
			started: NOW,
			wall_ms: 1,
			exit_code: 0,
			statuses,
			durations_ms: statuses.split('').map(() => 1),
		});
		// keys: same, gone, p→s, p→f, f→p, f→s, quarantined-and-moved
		const names = ['same', 'gone', 'p_s', 'p_f', 'f_p', 'f_s', 'noisy'];
		const baseline = {
			keys: names.map(key),
			runs: [fixed(0, 'ppppffp'), fixed(1, 'ppppfff')],
		} as Parameters<typeof compareCandidate>[0];
		const candidate = (name: string, status: 'pass' | 'fail' | 'skip') => ({
			file: SELF,
			name,
			status,
			durationMs: 1,
		});
		const result = compareCandidate(baseline, new Set([key('noisy')]), [
			candidate('same', 'pass'),
			candidate('p_s', 'skip'),
			candidate('p_f', 'fail'),
			candidate('f_p', 'pass'),
			candidate('f_s', 'skip'),
			candidate('noisy', 'fail'),
			candidate('new', 'pass'),
		]);
		expect(result.compared).toBe(6);
		expect(result.quarantined).toBe(1);
		expect(Object.fromEntries(result.violations.map((v) => [v.key, v.assertion]))).toEqual({
			[key('gone')]: 'key_set',
			[key('new')]: 'key_set',
			[key('p_s')]: 'pass_skip',
			[key('p_f')]: 'pass_fail',
			[key('f_p')]: 'fail_pass',
			[key('f_s')]: 'other',
		});
		// An unchanged candidate is EQUAL — else every violation above is vacuous.
		const equal = compareCandidate(baseline, new Set([key('noisy')]), [
			candidate('same', 'pass'),
			candidate('gone', 'pass'),
			candidate('p_s', 'pass'),
			candidate('p_f', 'pass'),
			candidate('f_p', 'fail'),
			candidate('f_s', 'fail'),
		]);
		expect(equal.violations).toEqual([]);
		// A candidate that measured nothing, and an unstable key nobody
		// quarantined, both REFUSE instead of comparing.
		expect(() => compareCandidate(baseline, new Set([key('noisy')]), [])).toThrow(/ZERO/);
		expect(() => compareCandidate(baseline, new Set(), [candidate('same', 'pass')])).toThrow(
			/not quarantined/,
		);
	});

	test('the JUnit parser keys an explicit ./ path like a discovery run', () => {
		const xml = `<testsuites><testsuite name="./${SELF}" file="./${SELF}"><testcase name="t" time="0" /></testsuite></testsuites>`;
		expect(parseJunitCases(xml)[0]?.file).toBe(SELF);
	});

	test('the artifact home is engineering/, never rewrite/ (absent on a clone)', () => {
		// Hard rule: nothing mechanically read may live under rewrite/. The gate
		// pins the resolved artifact directory itself, so a re-point of the tool
		// cannot silently move the contract out of the repo.
		expect(DEFAULT_ARTIFACT_DIR).toBe(join(REPO_ROOT, 'engineering', 'test_baseline'));
		expect(DEFAULT_ARTIFACT_DIR.includes('rewrite')).toBe(false);
	});
});
