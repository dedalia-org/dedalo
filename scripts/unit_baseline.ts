/**
 * UNIT RED BASELINE — generator and drift checker for the unit tier
 * (test/unit + test/integration).
 *
 *   bun run scripts/unit_baseline.ts            # rewrite the JSON baseline (default) —
 *                                  # IN THE CI IMAGE ONLY (recordOnlyInCiImage): the door is
 *                                  # `bun run ci:local --docker --record-unit-baseline`
 *   bun run scripts/unit_baseline.ts --check [--bins=N]  # print drift, exit 1 if any;
 *                                  # --bins=N measures sharded (runTierSharded) — REFUSES first
 *                                  # (no measure) a baseline whose ci_image stamp is not the
 *                                  # running image's (red_baseline.ts ciImageStampVerdict)
 *   bun run scripts/unit_baseline.ts --report   # failing tests per file
 *   bun run scripts/unit_baseline.ts --record-new [file…]  # ONLY a new file's per_file
 *                                  # floor, measured; refuses a red (scripts/lib/red_baseline.ts
 *                                  # recordNewDecision) — no file: every unrecorded one.
 *                                  # A WRITE too, so IN THE CI IMAGE ONLY: the door is
 *                                  # `bun run ci:local --docker --record-unit-baseline --new <file>[,<file>…]`
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * The unit tier is the engine's real gate tier: 727 files, 8800 cases, and by
 * the 2026-08-26 audit's own measure only ~118 of the repo's 803 test files were
 * named in ANY CI tier array — the other ~685 executed nowhere. Naming the whole
 * tier in CI is the fix, but the tier is not green: the CENSUS of 2026-08-29
 * measured 8779 pass / 14 skip / 7 fail across 7 files. A tier with reds cannot
 * block, and a tier that cannot block is not a gate — it is a report nobody
 * reads. This is the floor that lets it block anyway.
 *
 * ── QUOTE THE CENSUS, NEVER YOUR OWN `bun test` ──────────────────────────────
 * Every number above is the one the CENSUS produced, i.e. what `runTier()` in
 * scripts/lib/parity_census.ts wrote into engineering/unit_baseline.json — NOT
 * what a plain interactive `bun test test/unit test/integration` prints in your
 * shell. The census is what the gate asserts, so the census is what the prose
 * here and in `whyRed` must quote — an earlier revision of this docblock quoted a
 * hand-run `bun test` and shipped numbers that matched no artifact on disk.
 *
 * TWO DIFFERENT REASONS A HAND RUN DISAGREES, and they are not interchangeable —
 * an earlier revision cited the second for a delta only the first explains:
 *
 *   SIZE (tier_files, tier_tests) — ordinary GROWTH. This tier gains gates on most
 *   commits, and a count taken minutes apart legitimately differs; the two gates
 *   written alongside this file moved it 725 -> 727 while it was being measured.
 *   A differing hand count is normal, not a dirty shell, which is exactly why
 *   `exactCounts` is false here and size is held by the anti-vacuity floors alone.
 *
 *   PASS / FAIL / SKIP — the environment. `childEnv()` STRIPS the nine per-run seam
 *   keys of `PER_RUN_SEAMS` (DB_NAME, DEDALO_DATABASE_CONN, DEDALO_TEST_MEDIA_ROOT,
 *   DEDALO_SESSION_DB_PATH, DEDALO_TS_STATE_PATH,
 *   DEDALO_TEST_SKIP_CANONICAL_RESTORE, DEDALO_TEST_DB_DISABLE,
 *   DIFFUSION_ACTIVITY_TABLE, DIFFUSION_JOBS_TABLE) and PINS
 *   `ORACLE_MODE=fixtures`, so a shell carrying any of them measures a differently
 *   addressed tier. HERE the artifact is right and the shell is dirty — and this
 *   is the only half that claim applies to.
 *
 * ── FREEZING IS NOT NORMALIZING ──────────────────────────────────────────────
 * Freezing the 7 reds is the opposite of accepting them. The list is SHRINK-ONLY
 * and keyed per FILE and per TEST NAME: a failing test that is not on it is a
 * regression and fails CI, and a LISTED test that starts PASSING is also a
 * failure, so the entry must be removed the day the bug is fixed. The list can
 * therefore never outlive the bug it names — it is a ratchet, not an amnesty.
 * Per NAME and not per count, because a file that stops failing test A and
 * starts failing test B has an unchanged count, which is exactly the regression
 * a count-only ratchet would miss.
 *
 * ── ONE IMPLEMENTATION ───────────────────────────────────────────────────────
 * All the machinery — the artifact shape, the drift rules, the anti-laundering
 * refusal, the anti-vacuity floors, the CLI — lives in
 * scripts/lib/red_baseline.ts, extracted from scripts/parity_baseline.ts on
 * 2026-08-29 for exactly this second instance. This file is a {@link TierSpec}
 * and nothing else; a copied generator would have inherited none of the four
 * adversarial-review fixes baked into that one. The measure itself is
 * scripts/lib/parity_census.ts, which RUNS the tier under bun's JUnit reporter.
 *
 * NOT hermetic: running the tier is the measure, and the DB-backed gates in it
 * need the suite database (`bun run test:db:setup`). Expect ~5 minutes.
 */

import type { ParityRun } from './lib/parity_census.ts';
import { wantsCheckJson } from './lib/ratchet_check.ts';
import {
	type BaselineCliIo,
	buildBaseline as buildBaselineFor,
	computeDrift as computeDriftFor,
	loadBaseline as loadBaselineFor,
	type RedBaseline,
	realBaselineCliIo,
	runBaselineCli,
	type TierDrift,
	type TierSpec,
} from './lib/red_baseline.ts';
import { runTier, runTierSharded } from './lib/tier_run.ts';

export { formatDrift } from './lib/red_baseline.ts';

/** The frozen baseline. In engineering/ because a gate reads it (rewrite/ may not be read). */
export const BASELINE_PATH = 'engineering/unit_baseline.json';

/** The one instruction most failure messages end with. */
export const FIX_COMMAND = 'bun run scripts/unit_baseline.ts';

/** The paths that ARE the unit tier. One array, so a re-point is one edit. */
export const TIER_PATHS = ['test/unit', 'test/integration'];

/**
 * Anti-vacuity floors on the SCAN, well below the census-measured tier
 * (727 files / 8800 cases) so ordinary churn — a merged file, a deleted obsolete gate, a
 * describe collapsed into one case — never trips them, but a tier that silently
 * stopped running (a moved path, a crashed runner, a reporter that wrote
 * nothing, a `bun test` invoked on a directory that no longer exists) cannot
 * pass by measuring nothing. The gap is deliberately large in the direction of
 * "impossible to reach by accident": losing 127 files or 1800 cases is not
 * churn, it is a broken runner. Fix the runner, never the floor.
 */
export const TIER_FILE_FLOOR = 600;
export const TIER_TEST_FLOOR = 7000;

/**
 * THE UNIT TIER, as a {@link TierSpec}.
 *
 * Note the contrast with PARITY_TIER's `whyRed`: parity's reds are permanent by
 * construction (the oracle is decommissioned), these are not. Every one of the
 * seven is a bug with an owner, and the only correct direction for these numbers
 * is DOWN.
 *
 * `exactCounts` is FALSE here and TRUE on the parity tier, and that asymmetry is
 * the whole difference between the two ratchets: parity cannot grow (no new
 * differential can ever be harvested), so its size counts are asserted exactly;
 * the unit tier gains gates on most commits, and asserting tier_files/tier_tests/
 * tier_pass/tier_skip exactly would redden CI every single time somebody WROTE a
 * test — which teaches the team to regenerate a baseline without reading it,
 * the exact reflex this file exists to prevent. So the unit tier freezes its
 * DEBT exactly (failing_files/failing_tests plus the named failing set) and holds
 * its SIZE with the anti-vacuity floors alone.
 */
export const UNIT_TIER: TierSpec = {
	id: 'unit',
	paths: TIER_PATHS,
	baselinePath: BASELINE_PATH,
	fixCommand: FIX_COMMAND,
	fileFloor: TIER_FILE_FLOOR,
	testFloor: TIER_TEST_FLOOR,
	// FALSE because this tier GROWS on most commits — see the `exactCounts` paragraph in
	// the docblock above for why exact size equality here would train the very reflex the
	// ratchet exists to prevent. Debt frozen exactly, size held by the floors above.
	exactCounts: false,
	// The floors and the red set are facts about the platform the tier runs on (the
	// runner's image: its media toolchain, a bare uid, a clone without the desk's audits/
	// or ../private): a desk recording freezes the desk, and the runner reports the
	// difference as drift. Both writers (the full one and --record-new) refuse outside the
	// image (red_baseline.ts ciImageMarkerMatches); ci:local --docker --record-unit-baseline
	// [--new <files>] is the door.
	recordOnlyInCiImage: true,
	// The CI-image stamp (red_baseline.ts ciImageStampVerdict): the full writer stamps every
	// record with the image it measured in, and --check refuses a foreign or missing stamp.
	// The pre-stamp transition (the artifact recorded before the stamp existed, pinned by
	// sha256 + image) ENDED with the first stamped full record (2026-10-23, CI image
	// 93116f58…): null, and it stays null — a stamped file beside a live transition is refused.
	unstampedTransition: null,
	whyRed:
		"Why these reds exist — and why, UNLIKE the parity tier, they are NOT permanent. RECORDED IN THE CI IMAGE (2026-10-02, `bun run ci:local --docker --record-unit-baseline` on the sorted tier order; the writer refuses anywhere else): 0 frozen reds. History: 7 reds (2026-08-29) -> 3 (2026-08-30: the RAG gates stopped inheriting the machine's embedding provider; a leaked setTimeout in client_request_coalescing_tripwire stopped killing arbitrary victims) -> 2 (gate_vacuity's banked-budget case passes) -> 0 (2026-10-02: the dd1 install seed re-synced for ontology_parser; info_widget's media_icons golden builds its own term target). The stage is BLOCKING in scripts/ci/db_tier.sh since 2026-10-02 (zero drift on three executed GitHub db runs of 674c1f4f76; the 'loaded runner' leg of the old criterion was not separately exercised — engineering/CI.md): any drift from this file fails the db tier, on the runner and on the desk gate alike. Per-file floors are the image's, and a desk differs from them in BOTH directions: it asserts more where it has what a runner lacks (the sibling v6 tree, audits/, a GeoIP database, translated locales, its own ../private config) and less where the image has what the desk lacks (librsvg: media_svg_thumb skips 7 on a Mac, 0 in the image) — so a desk number is never a floor, either way. Any entry a future recording accepts (--allow-regression --reason) is expected to be FIXED; the list is shrink-only and a listed test that passes is red, so these numbers may only go DOWN.",
};

/** Tier-named aliases of the shared types, mirroring what parity_baseline.ts exports, so a gate can import either tier alike. */
export type UnitBaseline = RedBaseline;
export type UnitDrift = TierDrift;

export function buildBaseline(run: ParityRun): UnitBaseline {
	return buildBaselineFor(UNIT_TIER, run);
}
export function loadBaseline(): UnitBaseline {
	return loadBaselineFor(UNIT_TIER);
}
export function computeDrift(run: ParityRun, baseline: UnitBaseline): UnitDrift {
	return computeDriftFor(UNIT_TIER, run, baseline);
}

/**
 * Measuring the tier is `runTier(TIER_PATHS)` and nothing else — wrapped here so no
 * caller re-derives the path list.
 *
 * NOTE for the `unit_baseline_tripwire` gate this tier still wants: that gate must read
 * the FROZEN BASELINE and must NOT call this. `TIER_PATHS` contains `test/unit`, which is
 * where the gate itself would live, so re-measuring spawns a child `bun test test/unit`
 * that runs the gate that spawns another — unbounded, at ~5 minutes a level. `runTier`
 * refuses it (the DEDALO_TIER_CENSUS_RUNNING guard in scripts/lib/parity_census.ts), but
 * a refusal is a crash, not a design: read the JSON.
 */
export function runUnitTier(): ParityRun {
	return runTier(TIER_PATHS);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * `--bins=N` (N >= 2) — measure the tier SHARDED (`runTierSharded`: sealed template,
 * one clone per bin, serial pool, merged JUnit) instead of one `bun test`. CHECK ONLY:
 * the baseline is defined by the serial run, and a sharded run is admissible as its
 * measure because it was proved EQUAL to the serial campaign on every key (tier_run.ts) —
 * a writer must record the definition, never the stand-in, so `--bins` beside a writing
 * mode is refused. `--bins=1` (or none) is the serial `runTier`.
 */
export function unitCliIo(argv: readonly string[]): BaselineCliIo {
	const io = realBaselineCliIo();
	const binsArg = argv.find((arg) => arg.startsWith('--bins='));
	const rest = argv.filter((arg) => !arg.startsWith('--bins='));
	if (binsArg === undefined) return { ...io, argv: rest };
	const bins = Number(binsArg.slice('--bins='.length));
	if (!Number.isInteger(bins) || bins < 1) {
		throw new Error(`unit_baseline: --bins must be a positive integer, got '${binsArg}'`);
	}
	// Mirrors runBaselineCli's `writing` test: --record-new is dispatched FIRST and
	// writes whatever read flag stands beside it, so it is never a read here either.
	const reading =
		!rest.includes('--record-new') && (rest.includes('--check') || wantsCheckJson(rest));
	if (bins > 1 && !reading) {
		throw new Error(
			'unit_baseline: --bins=N (sharded measure) is a CHECK-only option — the baseline is recorded serially, from the run that defines it.',
		);
	}
	if (bins > 1 && wantsCheckJson(rest)) {
		throw new Error(
			'unit_baseline: --check --json promises ONE JSON line on stdout; the sharded measure streams its bins there — run the JSON check serial (no --bins).',
		);
	}
	return {
		...io,
		argv: rest,
		measure: bins > 1 ? (paths) => runTierSharded(paths, bins) : runTier,
	};
}

if (import.meta.main) runBaselineCli(UNIT_TIER, unitCliIo(process.argv.slice(2)));
