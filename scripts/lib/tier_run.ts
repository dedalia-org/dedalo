/**
 * THE TIER RUNNER — the ONE way a ratcheted tier (unit, parity, MariaDB) is RUN
 * and measured: `bun test` on the tier's sorted file list under the JUnit
 * reporter, parsed by scripts/lib/parity_census.ts (`parseJunit`, `childEnv`).
 *
 * Split out of parity_census.ts (2026-10-02) when running a tier started to
 * WALK its paths (scripts/lib/test_order.ts): the census's pure halves — the
 * JUnit parser, the child env, the case types — are imported by gates that never
 * run a tier, and must not reach a tree walk they do not floor.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { junitReportsIn } from './junit_reports.ts';
import { childEnv, type ParityRun, parseJunit, REPO_ROOT, TIER_PATH } from './parity_census.ts';
import { TEST_TIMEOUT_FLAG } from './test_flags.ts';
import { tierFileArgs } from './test_order.ts';

export function runParityTier(): ParityRun {
	return runTier([TIER_PATH]);
}

/**
 * The census child's argv. The tier's PATHS are never handed to bun as-is: a
 * directory runs in raw readdir order (differs per host filesystem) and a bare
 * file is a substring filter run in that same order. `tierFileArgs` expands them
 * to ONE codepoint-sorted, `./`-prefixed file list, so the unit/parity/MariaDB
 * tiers run in the same order on every host (scripts/lib/test_order.ts; gate:
 * tier_file_order_tripwire).
 */
export function tierArgv(paths: readonly string[], outfile: string): string[] {
	// A PLANTED file — an existing absolute test file OUTSIDE the repository — is a
	// harness's own control (mariadb_tier.ts plants its calibration gates in the suite's
	// marked MariaDB root, never in the tree). It is passed verbatim, after the tier's
	// sorted list: an absolute path is bun's PATH mode, and a single planted file has
	// no order to fix. Anything else keeps test_order's strict repo-relative rule.
	const planted = paths.filter((path) => isPlantedFile(path));
	const tier = paths.filter((path) => !isPlantedFile(path));
	return [
		'bun',
		'test',
		TEST_TIMEOUT_FLAG,
		'--reporter=junit',
		`--reporter-outfile=${outfile}`,
		...(tier.length > 0 ? tierFileArgs(tier, REPO_ROOT) : []),
		...planted,
	];
}

/** An existing absolute `*.test.ts` file outside the repository (see tierArgv). */
export function isPlantedFile(path: string): boolean {
	if (!isAbsolute(path) || !path.endsWith('.test.ts')) return false;
	const rel = relative(REPO_ROOT, path);
	if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return false;
	return existsSync(path) && statSync(path).isFile();
}

/**
 * Run ANY tier under the JUnit reporter and parse it. Generalized from
 * `runParityTier` when the unit tier needed the same measure (P0-1, 2026-08-29) —
 * one runner, so the seam-stripping (`childEnv`) and the timeout can never differ
 * between two tiers that are both meant to be ratcheted the same way.
 */
export function runTier(paths: string[]): ParityRun {
	// RECURSION GUARD. A tier whose `paths` include `test/unit` measures the very
	// directory every gate lives in, so a gate that CALLS this — the natural
	// `unit_baseline_tripwire` twin of `parity_baseline_tripwire` — would spawn a child
	// `bun test test/unit`, which runs that gate again, which spawns another: unbounded,
	// at roughly five minutes per level. The parity tier is safe only by accident of
	// layout (its paths are `test/parity` while its gate lives in `test/unit`), so the
	// guard belongs here rather than in either instance.
	//
	// Found by adversarial review 2026-08-29, before such a gate was written.
	if (process.env.DEDALO_TIER_CENSUS_RUNNING === '1') {
		throw new Error(
			`tier_census: refusing to run \`bun test ${paths.join(' ')}\` from inside a tier census that is already running. A tier whose paths contain the directory its own gate lives in would recurse without bound; if you are writing that gate, it must read the frozen baseline rather than re-measure the tier.`,
		);
	}
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-tier-census-'));
	const outfile = join(dir, 'tier.junit.xml');
	try {
		const proc = Bun.spawnSync(tierArgv(paths, outfile), {
			cwd: REPO_ROOT,
			stdout: 'pipe',
			stderr: 'pipe',
			env: childEnv(),
		});
		let xml: string;
		try {
			xml = readFileSync(outfile, 'utf8');
		} catch {
			throw new Error(
				`tier_census: \`bun test ${paths.join(' ')} ${TEST_TIMEOUT_FLAG}\` wrote no JUnit report (exit ${proc.exitCode}). The tier did not run; the census refuses to report an empty result set.\n--- stderr tail ---\n${proc.stderr.toString().split('\n').slice(-25).join('\n')}`,
			);
		}
		const run = parseJunit(xml);
		run.stderrTail = proc.stderr.toString().split('\n').slice(-40).join('\n');
		if (run.totals.tests === 0) {
			throw new Error(
				`tier_census: \`bun test ${paths.join(' ')} ${TEST_TIMEOUT_FLAG}\` reported ZERO test cases (exit ${proc.exitCode}) — the tier is not being measured. Fix the runner, never the floor.`,
			);
		}
		return run;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Merge per-bin census runs into ONE run, as if a single `bun test` had reported
 * them. Bins are DISJOINT by construction (scripts/test_shard.ts partition is total
 * and disjoint — shard_partition_tripwire), so a file reported by two runs is a
 * runner defect and REFUSED: summing it would double its floor and hide a lost one.
 */
export function mergeRuns(runs: readonly ParityRun[]): ParityRun {
	const merged: ParityRun = {
		cases: [],
		files: [],
		totals: { tests: 0, pass: 0, fail: 0, skip: 0 },
		perFile: {},
	};
	const seen = new Set<string>();
	for (const run of runs) {
		for (const file of run.files) {
			if (seen.has(file)) {
				throw new Error(
					`tier_census: '${file}' was reported by two bins — the shard partition is not disjoint; refusing to merge.`,
				);
			}
			seen.add(file);
			merged.files.push(file);
		}
		merged.cases.push(...run.cases);
		merged.totals.tests += run.totals.tests;
		merged.totals.pass += run.totals.pass;
		merged.totals.fail += run.totals.fail;
		merged.totals.skip += run.totals.skip;
		Object.assign(merged.perFile, run.perFile);
		if (run.stderrTail !== undefined) {
			merged.stderrTail = `${merged.stderrTail ?? ''}${run.stderrTail}\n`;
		}
	}
	return merged;
}

/**
 * The shard runner's two control files (the literals mirror scripts/test_shard.ts
 * SHARD_PLAN_FILE / SHARD_VERDICT_FILE — not imported: that module's graph reaches
 * the config catalog, which this census module must not freeze;
 * tier_file_order_tripwire pins the pair equal).
 */
export const SHARD_PLAN_LITERAL = 'shard_plan.json';
export const SHARD_VERDICT_LITERAL = 'shard_verdict.json';

/**
 * The JUnit reports of one finished sharded run directory — exactly the PLANNED bins'
 * (a stale `bin<N>.xml` of an older, larger plan in a reused directory is not this
 * run), and only when the run is a measurement: plan present, every planned bin
 * reported, verdict `valid: true`. Shared by {@link collectShardedRun} and the
 * campaign comparator (scripts/test_baseline_compare.ts), whose EQUAL licenses sharding.
 */
export function shardedRunReports(dir: string, context: string): string[] {
	let planned: number[];
	try {
		const plan = JSON.parse(readFileSync(join(dir, SHARD_PLAN_LITERAL), 'utf8')) as {
			bins: { index: number }[];
		};
		planned = plan.bins.map((bin) => bin.index);
	} catch {
		throw new Error(
			`tier_census: the sharded run ${context} wrote no plan — it refused or died before spawning a bin (its log says which: a disk or connection budget refusal can be avoided with --unit-bins 1 on ci:local). The tier did not run.`,
		);
	}
	const present = new Set(junitReportsIn(dir, /^bin\d+\.xml$/));
	const reports = planned.map((index) => join(dir, `bin${index}.xml`));
	const missing = planned.filter((_, i) => !present.has(reports[i] as string));
	if (missing.length > 0 || planned.length === 0) {
		throw new Error(
			`tier_census: bin(s) ${missing.join(', ') || '(none planned)'} of the sharded run ${context} wrote no JUnit report — they did not run; a merge of the rest would measure a smaller tier as complete.`,
		);
	}
	let verdict: { valid?: unknown; reason?: unknown };
	try {
		verdict = JSON.parse(readFileSync(join(dir, SHARD_VERDICT_LITERAL), 'utf8'));
	} catch {
		throw new Error(
			`tier_census: the sharded run ${context} wrote no verdict — the runner died after its bins; its isolation was never checked, so the reports are not a measurement.`,
		);
	}
	if (verdict.valid !== true) {
		throw new Error(
			`tier_census: the sharded run ${context} is INVALID: ${String(verdict.reason ?? 'no reason given')} — its reports are not the tier.`,
		);
	}
	return reports;
}

/**
 * Read one finished sharded run out of its `--junit-dir`. Refuses — never merges
 * the survivors — unless the runner's PLAN exists, every planned bin reported, the
 * runner's VERDICT says the run is valid (no template contact, not interrupted:
 * a red test exits a bin 1 too, so the exit code alone cannot tell a failing tier
 * from an invalid run), and at least one test case was measured.
 */
export function collectShardedRun(dir: string, exitCode: number | null, bins: number): ParityRun {
	const reports = shardedRunReports(dir, `(--bins=${bins}, exit ${exitCode})`);
	const run = mergeRuns(reports.map((path) => parseJunit(readFileSync(path, 'utf8'))));
	if (run.totals.tests === 0) {
		throw new Error(
			`tier_census: the sharded run (--bins=${bins}, exit ${exitCode}) reported ZERO test cases — the tier is not being measured. Fix the runner, never the floor.`,
		);
	}
	return run;
}

/**
 * The env the shard RUNNER gets: `childEnv()` (seams stripped, the suite database
 * pinned as DEDALO_TEST_DATABASE) PLUS the application's DB_NAME back. The runner is
 * not a `bun test` process — it loads the config catalog for the serial pool sizes,
 * and the catalog REQUIRES DB_NAME; childEnv strips it (right for a test child, whose
 * preload re-derives from it). MEASURED 2026-10-31 in the CI image, which has no
 * ../private/.env to fall back on: the runner died at import, "wrote no plan". The
 * pinned DEDALO_TEST_DATABASE still wins every name derivation, so this cannot move
 * the template; each bin's env is recomposed from childEnv by the runner.
 */
export function shardRunnerEnv(): Record<string, string | undefined> {
	const env = childEnv();
	const appDb = readEnv('DB_NAME');
	if (appDb !== undefined && appDb !== '') env.DB_NAME = appDb;
	return env;
}

/**
 * Run a tier SHARDED: the same sorted file list (`tierFileArgs`), handed to the
 * shard runner (`scripts/test_shard.ts --bins=N`, sealed template, one clone per
 * bin, serial pool) under the same `childEnv()`, one JUnit report per bin, merged.
 * EQUAL to {@link runTier} on every key — measured 2026-10-31 against the K=5/J=8
 * serial campaign (engineering/test_baseline/README.md, `test:baseline:compare`) — and that
 * equality is the ONLY licence for using it where `runTier` stood: a tier whose
 * reds moved under sharding is not the tier its baseline froze.
 *
 * Every bin must report: a bin with no JUnit file did not run (a crashed child, a
 * refused budget), and a merge of the others would read as a smaller tier.
 */
export function runTierSharded(paths: string[], bins: number): ParityRun {
	if (process.env.DEDALO_TIER_CENSUS_RUNNING === '1') {
		throw new Error(
			`tier_census: refusing to run a sharded \`bun test ${paths.join(' ')}\` from inside a tier census that is already running (see runTier's recursion guard).`,
		);
	}
	if (!Number.isInteger(bins) || bins < 2) {
		throw new Error(`tier_census: runTierSharded needs bins >= 2, got ${bins} — use runTier`);
	}
	const dir = mkdtempSync(join(tmpdir(), 'dedalo-tier-shard-'));
	try {
		const files = tierFileArgs(paths, REPO_ROOT);
		const proc = Bun.spawnSync(
			[
				'bun',
				'run',
				join(REPO_ROOT, 'scripts', 'test_shard.ts'),
				`--bins=${bins}`,
				`--junit-dir=${dir}`,
				...files,
			],
			{ cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', env: shardRunnerEnv() },
		);
		return collectShardedRun(dir, proc.exitCode, bins);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
