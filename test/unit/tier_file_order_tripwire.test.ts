/**
 * TIER FILE ORDER — every tier runs ONE sorted, complete, `./`-prefixed file list.
 *
 * Diagnosed 2026-10-02: `bun test <dir>` runs files in raw readdir order, which is
 * hash order per filesystem, so the GitHub runner and the Mac's CI container ran
 * the unit tier's ~1000 files in different orders and order-dependent reds showed
 * on one host only. The fix lives in scripts/lib/test_order.ts (TS tiers: unit,
 * parity, MariaDB via `runTier`; the shard runner; verify) and its bash twin
 * scripts/ci/test_order.sh (the tripwire stages — held by tier_execution_tripwire,
 * which executes those stages with `bun` stubbed).
 *
 * Legs:
 *   1. BUN'S BEHAVIOUR, re-measured on the pinned bun every run (a scratch dir, no
 *      repo bunfig): `./` paths run in ARGV order (two permutations), and a missing
 *      `./path` is dropped SILENTLY — the two facts the design rests on. If bun
 *      changes either, this leg is red and test_order.ts's header must be re-read.
 *   2. COMPLETE vs the walk: `tierFiles` of the unit and parity tiers equals an
 *      independent listing (test_tree_corpus, sifted by bun's four test shapes) — nothing dropped,
 *      nothing invented — and is codepoint-sorted.
 *   3. THE CENSUS ARGV: `tierArgv` (what `runTier` spawns) hands bun the sorted
 *      `./` list and no bare directory; `runTier` spawns `tierArgv`.
 *   4. LOUD EDGES: a missing file / path / empty dir throws; `inventory` tolerates.
 *   5. THE BASH TWIN orders, de-duplicates, prefixes, and refuses a missing file.
 *   6. THE SHARDED MEASURE (`runTierSharded`, the unit check's `--bins=N`) hands the
 *      shard runner the SAME sorted list, merges per-bin runs only when disjoint,
 *      reads the runner's own plan file, and stays a CHECK-only stand-in; a drift
 *      names the files to re-run (`rerunCommand`).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { childEnv, REPO_ROOT, TIER_PATH } from '../../scripts/lib/parity_census.ts';
import { emptyDrift, rerunCommand } from '../../scripts/lib/red_baseline.ts';
import { TEST_TIMEOUT_FLAG } from '../../scripts/lib/test_flags.ts';
import {
	ARGV_BUDGET_BYTES,
	bunTestFileArgs,
	codepointCompare,
	tierFileArgs,
	tierFiles,
} from '../../scripts/lib/test_order.ts';
import {
	collectShardedRun,
	isPlantedFile,
	mergeRuns,
	runTier,
	SHARD_PLAN_LITERAL,
	SHARD_VERDICT_LITERAL,
	shardRunnerEnv,
	tierArgv,
} from '../../scripts/lib/tier_run.ts';
import {
	SHARD_PLAN_FILE,
	SHARD_VERDICT_FILE,
	writeShardVerdict,
} from '../../scripts/test_shard.ts';
import { TIER_PATHS as UNIT_TIER_PATHS, unitCliIo } from '../../scripts/unit_baseline.ts';
import { testTreeSourceFiles } from '../helpers/test_tree_corpus.ts';

const ROOT = resolve(import.meta.dir, '../..');

/** Bun's four test-file shapes, re-stated independently of test_order.ts. */
const BUN_TEST_SHAPE = /(\.test|_test|\.spec|_spec)\.(js|jsx|ts|tsx|mjs|cjs)$/;

/** The independent walks the tier lists are held equal to. */
// Through the registered lister of test/ (census_derivation SHARED_LISTERS), not a
// private walk: every `.ts` under test/, sifted by bun's test shapes and the tier's roots.
const TREE = testTreeSourceFiles();
const underTier = (roots: readonly string[]) =>
	TREE.filter((f) => BUN_TEST_SHAPE.test(f) && roots.some((root) => f.startsWith(`${root}/`))).sort(
		codepointCompare,
	);
const UNIT_WALK = underTier(UNIT_TIER_PATHS);
const PARITY_WALK = underTier([TIER_PATH]);

const isSorted = (list: readonly string[]): boolean =>
	list.every((item, i) => i === 0 || codepointCompare(list[i - 1] as string, item) < 0);

describe('tier file order', () => {
	test('1. bun runs `./` paths in argv order and drops a missing one silently (pinned bun, re-measured)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-test-order-'));
		try {
			mkdirSync(join(dir, 't'));
			const names = ['m_mid', 'z_last', 'a_first', 'q_x', 'b_y'];
			for (const name of names) {
				writeFileSync(
					join(dir, 't', `${name}.test.ts`),
					`import { test } from 'bun:test';\ntest('x', () => { console.log('RAN ${name}'); });\n`,
				);
			}
			const ran = (args: string[]): string[] => {
				const proc = Bun.spawnSync(['bun', 'test', TEST_TIMEOUT_FLAG, ...args], {
					cwd: dir,
					stdout: 'pipe',
					stderr: 'pipe',
				});
				const out = proc.stdout.toString() + proc.stderr.toString();
				return [...out.matchAll(/RAN (\w+)/g)].map((m) => m[1] as string);
			};
			const sorted = [...names].sort(codepointCompare);
			for (const order of [sorted, [...sorted].reverse()]) {
				expect(ran(order.map((n) => `./t/${n}.test.ts`))).toEqual(order);
			}
			// The silent drop the existence checks exist for.
			expect(ran(['./t/absent.test.ts', './t/a_first.test.ts'])).toEqual(['a_first']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('2. the walks are not empty (anti-vacuity floors)', () => {
		expect(UNIT_WALK.length).toBeGreaterThan(900);
		expect(PARITY_WALK.length).toBeGreaterThan(50);
	});

	for (const [name, paths, walked] of [
		['unit', UNIT_TIER_PATHS, UNIT_WALK],
		['parity', [TIER_PATH], PARITY_WALK],
	] as const) {
		test(`2. the ${name} tier's file list is sorted and complete vs the walk`, () => {
			const files = tierFiles(paths, REPO_ROOT);
			expect(files).toEqual(walked);
			expect(isSorted(files)).toBe(true);
		});

		test(`3. the ${name} census argv is the sorted ./ list, no bare path`, () => {
			const argv = tierArgv(paths, '/tmp/x.xml');
			expect(argv.slice(0, 2)).toEqual(['bun', 'test']);
			expect(argv).toContain(TEST_TIMEOUT_FLAG);
			const fileArgs = argv.slice(2).filter((arg) => !arg.startsWith('-'));
			expect(fileArgs).toEqual(tierFiles(paths, REPO_ROOT).map((f) => `./${f}`));
			for (const p of paths) expect(argv).not.toContain(p);
			expect(fileArgs.reduce((n, a) => n + a.length + 1, 0)).toBeLessThan(ARGV_BUDGET_BYTES);
		});
	}

	test('3b. runTier spawns tierArgv (the census argv IS the gated argv)', () => {
		const src = readFileSync(join(ROOT, 'scripts/lib/tier_run.ts'), 'utf8');
		const body = src.slice(src.indexOf('export function runTier('));
		expect(body).toMatch(/Bun\.spawnSync\(tierArgv\(paths, outfile\)/);
		expect(body.slice(0, body.indexOf('\n}\n'))).not.toMatch(/\.\.\.paths\b/);
	});

	test('4. loud edges: missing file/path/empty dir throw; inventory tolerates', () => {
		expect(() => bunTestFileArgs(['test/unit/zz_absent_order.test.ts'])).toThrow(/silently/);
		expect(() => tierFiles(['test/zz_absent_order'])).toThrow(/does not exist/);
		expect(() => tierFiles([])).toThrow(/no paths/);
		expect(() => tierFiles(['/abs'])).toThrow(/absolute/);
		expect(() => tierFiles(['../x'])).toThrow(/leaves/);
		expect(tierFiles(['test/zz_absent_order'], REPO_ROOT, { inventory: true })).toEqual([]);
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-test-order-empty-'));
		try {
			mkdirSync(join(dir, 'empty'));
			expect(() => tierFiles(['empty'], dir)).toThrow(/holds no test file/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		// De-duplicated and normalized: `./x` and `x` are one file.
		const one = 'test/unit/tier_file_order_tripwire.test.ts';
		expect(bunTestFileArgs([one, `./${one}`])).toEqual([`./${one}`]);
		expect(tierFileArgs([one])).toEqual([`./${one}`]);
		// Sorted whatever the caller's order (the shard bins and verify hand unsorted lists).
		const two = 'test/unit/tier_execution_tripwire.test.ts';
		expect(bunTestFileArgs([one, two])).toEqual([`./${two}`, `./${one}`]);
	});

	test('5. the bash twin sorts, de-duplicates, prefixes and refuses a missing file', () => {
		const a = 'test/unit/tier_file_order_tripwire.test.ts';
		const b = 'test/unit/tier_execution_tripwire.test.ts';
		const run = (args: string[]) => {
			const script = `source scripts/ci/test_order.sh; order_test_paths "$@"; rc=$?; printf 'P\\t%s\\n' "\${TEST_ORDER_PATHS[@]}"; echo "RC $rc"`;
			const proc = Bun.spawnSync(['bash', '-c', script, 'x', ...args], {
				cwd: ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const out = proc.stdout.toString().split('\n');
			return {
				paths: out.filter((l) => l.startsWith('P\t')).map((l) => l.slice(2)),
				rc: out.find((l) => l.startsWith('RC '))?.slice(3),
			};
		};
		expect(run([a, b, `./${a}`])).toEqual({ paths: [`./${b}`, `./${a}`], rc: '0' });
		const missing = run([a, 'test/unit/zz_absent_order.test.ts']);
		expect(missing.rc).not.toBe('0');
		expect(missing.paths).toEqual([`./${a}`]);
	});
});

describe('a PLANTED control file (outside the repository) runs verbatim — and only that', () => {
	// mariadb_tier.ts plants its calibration gates in the suite's marked MariaDB root,
	// outside the tree. The strict repo-relative rule refused them (the MariaDB stage's
	// four calibration controls went red, 2026-10-02); tierArgv passes such a file as-is.
	test('an existing absolute *.test.ts OUTSIDE the repo is planted; inside, missing or relative is not', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-planted-'));
		try {
			const outside = join(dir, 'tier_calibration.test.ts');
			writeFileSync(outside, "import { test } from 'bun:test';\ntest('x', () => {});\n");
			expect(isPlantedFile(outside)).toBe(true);
			expect(isPlantedFile(join(dir, 'missing.test.ts'))).toBe(false);
			expect(isPlantedFile(join(REPO_ROOT, 'test/unit/tier_file_order_tripwire.test.ts'))).toBe(
				false,
			);
			expect(isPlantedFile('test/unit/tier_file_order_tripwire.test.ts')).toBe(false);
			const argv = tierArgv([outside], join(dir, 'out.xml'));
			expect(argv.at(-1)).toBe(outside);
			expect(argv.filter((arg) => arg.endsWith('.test.ts'))).toEqual([outside]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('an absolute path INSIDE the repo still meets the strict rule (refused)', () => {
		expect(() =>
			tierArgv([join(REPO_ROOT, 'test/unit/tier_file_order_tripwire.test.ts')], '/dev/null'),
		).toThrow(/absolute/);
	});
});

describe('6. the SHARDED measure — same list, disjoint merge, check-only', () => {
	const run = (file: string, pass: number, fail: number) => ({
		cases: [
			...Array.from({ length: pass }, (_, i) => ({ file, name: `p${i}`, status: 'pass' as const })),
			...Array.from({ length: fail }, (_, i) => ({ file, name: `f${i}`, status: 'fail' as const })),
		],
		files: [file],
		totals: { tests: pass + fail, pass, fail, skip: 0 },
		perFile: { [file]: { tests: pass + fail, skipped: 0, assertions: pass + fail } },
	});

	test("runTierSharded hands test_shard the sorted tier list; the control-file literals equal the runner's", () => {
		const src = readFileSync(join(ROOT, 'scripts/lib/tier_run.ts'), 'utf8');
		const body = src.slice(src.indexOf('export function runTierSharded('));
		expect(body).toContain('const files = tierFileArgs(paths, REPO_ROOT);');
		expect(body).toMatch(/'scripts', 'test_shard\.ts'\)[\s\S]*\.\.\.files,/);
		expect(body).toContain('return collectShardedRun(dir, proc.exitCode, bins);');
		// Mirrored, not imported (see tier_run) — so pinned equal here.
		expect(SHARD_PLAN_LITERAL).toBe(SHARD_PLAN_FILE);
		expect(SHARD_VERDICT_LITERAL).toBe(SHARD_VERDICT_FILE);
	});

	describe('collectShardedRun — what a finished run directory must hold to be a measurement', () => {
		const junit = (file: string, pass: number): string =>
			`<?xml version="1.0"?>\n<testsuites>\n<testsuite name="${file}" file="${file}" tests="${pass}" assertions="${pass}" skipped="0" failures="0">\n` +
			Array.from(
				{ length: pass },
				(_, i) => `<testcase name="t${i}" classname="${file}"></testcase>\n`,
			).join('') +
			'</testsuite>\n</testsuites>\n';
		const dirs: string[] = [];
		const runDir = (opts: {
			plan?: number[];
			reports?: Record<number, string>;
			verdict?: { code: number; contact: boolean } | 'none';
		}): string => {
			const dir = mkdtempSync(join(tmpdir(), 'tier-shard-collect-'));
			dirs.push(dir);
			if (opts.plan !== undefined)
				writeFileSync(
					join(dir, SHARD_PLAN_FILE),
					JSON.stringify({ bins: opts.plan.map((index) => ({ index, files: 1 })) }),
				);
			for (const [index, xml] of Object.entries(opts.reports ?? {}))
				writeFileSync(join(dir, `bin${index}.xml`), xml);
			const verdict = opts.verdict ?? { code: 0, contact: false };
			if (verdict !== 'none') writeShardVerdict(dir, verdict.code, verdict.contact);
			return dir;
		};
		const both = { 1: junit('./a.test.ts', 2), 2: junit('./b.test.ts', 3) };
		afterAll(() => {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		});

		test('a complete, valid run merges every bin — a red bin (exit 1) is still a measurement', () => {
			const run = collectShardedRun(
				runDir({ plan: [1, 2], reports: both, verdict: { code: 1, contact: false } }),
				1,
				2,
			);
			expect(run.totals.tests).toBe(5);
			expect(run.files.sort()).toEqual(['./a.test.ts', './b.test.ts']);
		});

		test('no plan = the runner refused before any bin: not a smaller tier, no tier', () => {
			expect(() => collectShardedRun(runDir({ reports: both }), 1, 2)).toThrow(/wrote no plan/);
		});

		test('a planned bin without a report did not run — the survivors are NOT merged', () => {
			expect(() =>
				collectShardedRun(runDir({ plan: [1, 2], reports: { 1: both[1] } }), 1, 2),
			).toThrow(/bin\(s\) 2 .*wrote no JUnit report/);
		});

		test('TEMPLATE CONTACT, an interrupt, or no verdict at all invalidates complete reports', () => {
			expect(() =>
				collectShardedRun(
					runDir({ plan: [1, 2], reports: both, verdict: { code: 0, contact: true } }),
					1,
					2,
				),
			).toThrow(/INVALID.*TEMPLATE CONTACT/);
			expect(() =>
				collectShardedRun(
					runDir({ plan: [1, 2], reports: both, verdict: { code: 130, contact: false } }),
					130,
					2,
				),
			).toThrow(/INVALID.*interrupted/);
			expect(() =>
				collectShardedRun(runDir({ plan: [1, 2], reports: both, verdict: 'none' }), 1, 2),
			).toThrow(/wrote no verdict/);
		});

		test('only PLANNED bins are read — a stale bin of an older, larger plan is not this run', () => {
			const stale = { ...both, 3: junit('./a.test.ts', 9) };
			const run = collectShardedRun(runDir({ plan: [1, 2], reports: stale }), 0, 2);
			expect(run.totals.tests).toBe(5);
		});

		test('reports that hold zero test cases are refused, never read as a green tier', () => {
			const empty = { 1: junit('./a.test.ts', 0), 2: junit('./b.test.ts', 0) };
			expect(() => collectShardedRun(runDir({ plan: [1, 2], reports: empty }), 0, 2)).toThrow(
				/ZERO test cases/,
			);
		});
	});

	test('the shard RUNNER boots its config catalog: DB_NAME restored, the suite database still pinned', () => {
		const saved = {
			DB_NAME: process.env.DB_NAME,
			DEDALO_TEST_DATABASE: process.env.DEDALO_TEST_DATABASE,
		};
		try {
			process.env.DB_NAME = 'zz_app_db';
			process.env.DEDALO_TEST_DATABASE = 'zz_app_db_test';
			const env = shardRunnerEnv();
			expect(env.DB_NAME).toBe('zz_app_db');
			expect(env.DEDALO_TEST_DATABASE).toBe('zz_app_db_test');
			// …while a TEST child still never re-derives from it.
			expect(childEnv().DB_NAME).toBeUndefined();
		} finally {
			for (const [key, value] of Object.entries(saved))
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
		}
	});

	test('mergeRuns sums disjoint bins exactly and REFUSES a file reported twice', () => {
		const merged = mergeRuns([run('./a.test.ts', 2, 1), run('./b.test.ts', 3, 0)]);
		expect(merged.totals).toEqual({ tests: 6, pass: 5, fail: 1, skip: 0 });
		expect(merged.files).toEqual(['./a.test.ts', './b.test.ts']);
		expect(merged.cases).toHaveLength(6);
		expect(Object.keys(merged.perFile).sort()).toEqual(['./a.test.ts', './b.test.ts']);
		expect(() => mergeRuns([run('./a.test.ts', 1, 0), run('./a.test.ts', 1, 0)])).toThrow(
			/two bins/,
		);
	});

	test('--bins is a CHECK-only stand-in: sharded for --check, refused beside a writer', () => {
		expect(unitCliIo(['--check']).measure).toBe(runTier);
		expect(unitCliIo(['--check', '--bins=1']).measure).toBe(runTier);
		const sharded = unitCliIo(['--check', '--bins=4']);
		expect(sharded.measure).not.toBe(runTier);
		// The flag never reaches the shared CLI's argv (it knows no --bins).
		expect(sharded.argv).toEqual(['--check']);
		expect(() => unitCliIo(['--bins=4'])).toThrow(/CHECK-only/);
		expect(() => unitCliIo(['--report', '--bins=4'])).toThrow(/CHECK-only/);
		// The JSON check owns stdout; the sharded measure would interleave its bins there.
		expect(() => unitCliIo(['--check', '--json', '--bins=4'])).toThrow(/ONE JSON line/);
		// --record-new is dispatched first and WRITES, whatever read flag stands beside it.
		expect(() => unitCliIo(['--check', '--record-new', 'x', '--bins=4'])).toThrow(/CHECK-only/);
		expect(() => unitCliIo(['--check', '--bins=x'])).toThrow(/positive integer/);
	});

	test('a drift names exactly the files to re-run, sorted and ./-prefixed', () => {
		const drift = {
			...emptyDrift(),
			regressions: [
				'test/unit/b_native.test.ts: NEW red — x > y',
				'test/unit/a_tripwire.test.ts: NEW red — z',
			],
			stale: ['test/unit/b_native.test.ts: frozen red now PASSES — w'],
			floors: ['./test/integration/c.test.ts: assertions fell 9 → 3'],
		};
		const command = rerunCommand(drift);
		expect(command).toContain(
			`bun test ${TEST_TIMEOUT_FLAG} ./test/integration/c.test.ts ./test/unit/a_tripwire.test.ts ./test/unit/b_native.test.ts`,
		);
		expect(command).toContain('3 DRIFTED FILE(S)');
		// A recorded file that reported nothing and is GONE is not re-runnable; a present one is.
		const present = 'test/unit/tier_file_order_tripwire.test.ts';
		const silent = (file: string) => ({
			file,
			line: `${file}: recorded in per_file but reported nothing this run`,
		});
		const withSilent = rerunCommand({
			...emptyDrift(),
			floorsStale: [
				silent('./test/unit/zz_deleted_gate.test.ts').line,
				silent(`./${present}`).line,
			],
			floorsSilent: [silent('./test/unit/zz_deleted_gate.test.ts'), silent(`./${present}`)],
		});
		expect(withSilent).toContain(`./${present}`);
		expect(withSilent).not.toContain('zz_deleted_gate');
		// Tier-wide drift names no file: nothing to narrow to.
		expect(rerunCommand({ ...emptyDrift(), vacuity: ['the tier ran 0 files'] })).toBeNull();
	});
});
