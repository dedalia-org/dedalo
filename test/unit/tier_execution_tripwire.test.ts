/**
 * TIER EXECUTION — a tier script must actually RUN the array it declares.
 *
 * P0-1 of the 2026-08-26 deep audit, gate 1 of 3. The sibling gates answer
 * different halves: `ci_workflow_tripwire` rule 3c answers "is every tripwire
 * ASSIGNED to a tier", `tier_assignment_tripwire` answers "does every test FILE have
 * an executing home", and this one answers the question underneath both — "does the
 * tier script execute anything at all?"
 *
 * It is not a hypothetical failure. `hermetic.sh` ran `bun run lint` before its
 * tripwire block under `set -e`, so for 45 commits a red lint meant ZERO tripwires
 * executed while the tier reported one red line about formatting. Every gate in the
 * array was green by never running. The stages are independent now (`tier_status`),
 * and this gate holds the shape that made the silence possible:
 *
 *   1. each tier script contains a `bun test` invocation that expands its OWN array
 *      (`"${NAME[@]}"`, not a hard-coded path list that can drift from the array).
 *      A stage MAY split the ordered array over several invocations (hermetic.sh: a
 *      parallel batch + a serial lane, 2026-10-21) — then every entry reaches bun
 *      EXACTLY ONCE across them, proved by executing the stage with bun stubbed;
 *   2. that array is non-empty, and parses to the count the script itself reports;
 *   3. the invocation is not conditional on an earlier stage's success — no `&&`
 *      chain from a previous command, which is the `set -e` failure in another
 *      spelling;
 *   4. the timeout is passed explicitly, because Bun 1.4.0 SILENTLY IGNORES
 *      `[test] timeout` in bunfig — a tier without it runs on an unchosen 5 s cap
 *      and turns load into flakes (measured: two DB gates that pass in isolation).
 *
 * Census: TOTAL over the tier scripts, derived by scanning `scripts/ci/` for files
 * that declare a `*_TRIPWIRES` array — a new tier cannot be added without landing
 * here.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const CI_DIR = join(ROOT, 'scripts/ci');

/** The literal copy of TEST_TIMEOUT_MS every tier must pass on the command line. */
const REQUIRED_TIMEOUT_FLAG = '--timeout=30000';

interface Tier {
	file: string;
	source: string;
	arrayName: string;
}

/**
 * DERIVED, not enumerated: any script in `scripts/ci/` declaring a `*_TRIPWIRES=(`
 * array is a tier and is held to every rule below. A third tier added without an
 * execution line fails here on the day it lands.
 */
function discoverTiers(): Tier[] {
	const tiers: Tier[] = [];
	for (const entry of readdirSync(CI_DIR).sort()) {
		if (!entry.endsWith('.sh')) continue;
		const source = readFileSync(join(CI_DIR, entry), 'utf8');
		const declaration = source.match(/^([A-Z0-9_]*TRIPWIRES)=\(/m);
		if (declaration?.[1] === undefined) continue;
		tiers.push({ file: `scripts/ci/${entry}`, source, arrayName: declaration[1] });
	}
	return tiers;
}

/** The entries of a bash array literal, in declaration order. */
function arrayEntries(source: string, name: string): string[] {
	const start = source.indexOf(`${name}=(`);
	const end = source.indexOf('\n)', start);
	if (start === -1 || end === -1) return [];
	return source
		.slice(start + name.length + 2, end)
		.split('\n')
		.map((line) => line.replace(/#.*$/, '').trim())
		.filter((line) => line.length > 0);
}

interface Stage {
	lines: string[];
	/** Index of `order_test_paths "${NAME[@]}"`, -1 when absent. */
	orderLine: number;
	/** Every `bun test … "${TEST_ORDER_PATHS[@]}"` line of the stage, in order (empty when none). */
	bunLines: number[];
	/** The stage's last line: its `[ "$tw_rc" -eq 0 ]` verdict, else its last bun line. */
	endLine: number;
}

function tierStage(tier: Tier): Stage {
	const lines = tier.source.split('\n');
	const orderLine = lines.findIndex(
		(line) =>
			!line.trimStart().startsWith('#') &&
			line.includes(`order_test_paths "\${${tier.arrayName}[@]}"`),
	);
	if (orderLine === -1) return { lines, orderLine, bunLines: [], endLine: -1 };
	const verdict = lines.findIndex(
		(line, index) => index > orderLine && line.trimStart().startsWith('[ "$tw_rc" -eq 0 ]'),
	);
	const bunLines: number[] = [];
	for (let index = orderLine + 1; index < (verdict === -1 ? lines.length : verdict); index++) {
		const line = lines[index] ?? '';
		if (
			!line.trimStart().startsWith('#') &&
			line.includes('bun test') &&
			line.includes('"${TEST_ORDER_PATHS[@]}"')
		) {
			bunLines.push(index);
			// Without a verdict line the stage is the classic two lines: order, then ONE bun.
			if (verdict === -1) break;
		}
	}
	return {
		lines,
		orderLine,
		bunLines,
		endLine: verdict === -1 ? (bunLines.at(-1) ?? -1) : verdict - 1,
	};
}

/** Every top-level bash array literal of the tier (its own array, plus a lane the stage reads). */
function arrayBlocks(source: string): string[] {
	const blocks: string[] = [];
	for (const match of source.matchAll(/^[A-Z0-9_]+=\($/gm)) {
		const start = match.index ?? 0;
		blocks.push(source.slice(start, source.indexOf('\n)', start) + 2));
	}
	return blocks;
}

/**
 * Run the tier's array blocks + its stage lines under bash, `bun` stubbed to print its
 * argv — one entry per `bun` call. `env` reaches the stage (a mode switch it reads);
 * `prelude` lines run just before the stage (a stand-in for a tool the stage may call).
 */
function runStageWithStubBun(
	tier: Tier,
	env: Record<string, string> = {},
	prelude: string[] = [],
): { calls: string[][]; rc: number } {
	const stage = tierStage(tier);
	if (stage.orderLine === -1 || stage.bunLines.length === 0) {
		throw new Error(`${tier.file}: no ordered tripwire stage to execute`);
	}
	const script = [
		'set -euo pipefail',
		'source scripts/ci/test_order.sh',
		...arrayBlocks(tier.source),
		'tw_rc=0',
		"bun() { printf 'CALL\\n'; printf 'ARG\\t%s\\n' \"$@\"; }",
		...prelude,
		...stage.lines.slice(stage.orderLine, stage.endLine + 1),
		'printf \'RC\\t%s\\n\' "$tw_rc"',
	].join('\n');
	const proc = Bun.spawnSync(['bash', '-c', script], {
		cwd: ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: process.env.PATH ?? '', ...env },
	});
	const calls: string[][] = [];
	let rcLine: string | undefined;
	for (const line of proc.stdout.toString().split('\n')) {
		if (line === 'CALL') calls.push([]);
		else if (line.startsWith('ARG\t')) calls.at(-1)?.push(line.slice(4));
		else if (line.startsWith('RC\t')) rcLine = line;
	}
	if (proc.exitCode !== 0 || rcLine === undefined) {
		throw new Error(
			`${tier.file}: the stubbed stage did not complete (exit ${proc.exitCode}): ${proc.stderr}`,
		);
	}
	return { calls, rc: Number(rcLine.slice(3)) };
}

/** The test paths a call hands bun (its non-flag args after `test`). */
const callPaths = (call: string[]): string[] => call.filter((arg) => !arg.startsWith('-')).slice(1);

const TIERS = discoverTiers();

describe('tier execution — a declared array is an EXECUTED array', () => {
	test('the discovery found tiers (the scan is not silently empty)', () => {
		// Without this every assertion below passes over an empty list — the exact
		// vacuity this whole gate exists to make impossible.
		expect(TIERS.length).toBeGreaterThanOrEqual(2);
		expect(TIERS.map((t) => t.file)).toContain('scripts/ci/hermetic.sh');
		expect(TIERS.map((t) => t.file)).toContain('scripts/ci/db_tier.sh');
	});

	for (const tier of TIERS) {
		describe(tier.file, () => {
			test('runs its own array through bun test', () => {
				// `"${NAME[@]}"` and not a path list: an invocation that re-spells the
				// files can drift from the array silently, which is the same failure as
				// not running at all, one refactor later. The array reaches bun through
				// `order_test_paths` (scripts/ci/test_order.sh: sorted `./` paths — a bare
				// name is a bun FILTER run in per-host readdir order), so the stage is two
				// lines: the ordering call on the OWN array, then `bun test` on its result.
				const stage = tierStage(tier);
				expect(
					stage.orderLine,
					`${tier.file} declares ${tier.arrayName} but never orders it (\`order_test_paths "\${${tier.arrayName}[@]}"\`). ` +
						'A declared array that nothing runs is a tier reporting green by silence.',
				).toBeGreaterThanOrEqual(0);
				expect(
					stage.bunLines.length,
					`${tier.file}: no \`bun test … "\${TEST_ORDER_PATHS[@]}"\` line follows the ordering of ${tier.arrayName}.`,
				).toBeGreaterThan(0);
			});

			test('the array is non-empty', () => {
				const entries = arrayEntries(tier.source, tier.arrayName);
				expect(
					entries.length,
					`${tier.file}: ${tier.arrayName} is empty — the tier runs, and proves nothing.`,
				).toBeGreaterThan(0);
				for (const entry of entries) {
					expect(entry.startsWith('test/'), `${tier.file}: '${entry}' is not a test path`).toBe(
						true,
					);
				}
			});

			test('bun receives exactly the array, each entry once, sorted and ./-prefixed (stage executed, bun stubbed)', () => {
				// OUTCOME, not spelling: the stage's own lines run under bash with `bun`
				// replaced by a function that prints its argv. Reverting to the bare array,
				// dropping the sort, or running a different list all change what bun gets.
				// A stage split over several calls (parallel batch + serial lane) must hand
				// over every entry EXACTLY once: a lane that dropped a file, or ran one twice,
				// changes the concatenation.
				const entries = arrayEntries(tier.source, tier.arrayName);
				const expected = [...new Set(entries)].sort().map((entry) => `./${entry}`);
				const { calls, rc } = runStageWithStubBun(tier);
				expect(
					rc,
					`${tier.file}: the stage reported tw_rc=${rc} with every array entry present`,
				).toBe(0);
				for (const call of calls) {
					expect(call[0]).toBe('test');
					// A call with no path is bun DISCOVERING the whole test root — never a lane.
					expect(
						callPaths(call).length,
						`${tier.file}: a bun test call with no path`,
					).toBeGreaterThan(0);
				}
				expect(calls.flatMap(callPaths).sort()).toEqual(expected);
			});

			test('every invocation passes the explicit timeout', () => {
				// Bun 1.4.0 silently ignores `[test] timeout` in bunfig.toml, so a tier
				// without the flag runs on an unchosen 5 s cap: gates that pass in
				// isolation fail under a loaded runner, and the tier's red set becomes
				// load-dependent rather than a statement about the code.
				for (const call of runStageWithStubBun(tier).calls) {
					expect(
						call.includes(REQUIRED_TIMEOUT_FLAG),
						`${tier.file}: the bun test invocation must pass ${REQUIRED_TIMEOUT_FLAG} explicitly ` +
							'(bunfig [test] timeout is silently ignored by Bun).',
					).toBe(true);
				}
			});

			test('the invocation is not gated behind an earlier stage succeeding', () => {
				// The 45-commit failure in another spelling. `set -e` was one way to make
				// the tripwires conditional on lint; `previous && bun test ...` is the
				// other, and it survives the tier_status refactor unnoticed.
				const stage = tierStage(tier);
				for (const index of [stage.orderLine, ...stage.bunLines]) {
					const line = stage.lines[index] ?? '';
					const command = line.includes('bun test') ? 'bun test' : 'order_test_paths';
					const beforeCommand = line.slice(0, line.indexOf(command));
					expect(
						beforeCommand.includes('&&'),
						`${tier.file}: the tripwire run is chained behind an earlier command with '&&' — ` +
							'a red earlier stage would skip every gate. Record the earlier verdict and run this ' +
							'stage unconditionally.',
					).toBe(false);
				}
			});
		});
	}

	// hermetic.sh splits its array: a --parallel batch, then HERMETIC_SERIAL_LANE alone
	// (2026-10-21); DEDALO_HERMETIC_SERIAL=1 (the nightly) runs it all in one process.
	describe('scripts/ci/hermetic.sh — parallel batch, serial lane, serial switch', () => {
		const hermetic = TIERS.find((t) => t.file === 'scripts/ci/hermetic.sh');
		if (hermetic === undefined) throw new Error('hermetic.sh is not a discovered tier');
		const lane = arrayEntries(hermetic.source, 'HERMETIC_SERIAL_LANE').map((e) => `./${e}`);

		test('default: the batch runs --parallel with timings, the lane runs serial and holds exactly the lane', () => {
			const { calls, rc } = runStageWithStubBun(hermetic);
			expect(rc).toBe(0);
			// An empty lane is the goal (fix the file, delete its line): then the batch is all.
			expect(calls.length).toBe(lane.length > 0 ? 2 : 1);
			const [batch = [], serial = []] = calls;
			expect(batch).toContain('--parallel');
			expect(batch.some((arg) => arg.startsWith('--timings='))).toBe(true);
			expect(serial).not.toContain('--parallel');
			expect(callPaths(serial)).toEqual([...lane].sort());
			for (const path of lane) expect(callPaths(batch)).not.toContain(path);
		});

		test('DEDALO_HERMETIC_SERIAL=1: ONE serial call over the whole array', () => {
			const { calls, rc } = runStageWithStubBun(hermetic, { DEDALO_HERMETIC_SERIAL: '1' });
			expect(rc).toBe(0);
			expect(calls.length).toBe(1);
			expect(calls[0]).not.toContain('--parallel');
			const expected = [...new Set(arrayEntries(hermetic.source, hermetic.arrayName))]
				.sort()
				.map((entry) => `./${entry}`);
			expect(callPaths(calls[0] ?? [])).toEqual(expected);
		});

		test('the lane partition does not ride a pipe: a reader that exits early changes nothing', () => {
			// 2026-11-19, a push refused by this file's own stage. The lane lookup was
			// `printf '%s\n' lane… | grep -qxF path` under `pipefail`: bash writes one
			// line per write, grep -q leaves at its first match, and under the parallel
			// batch's load the next write hit a closed pipe (141) — a lane file was
			// read as "not in the lane", the count check went red. Load-dependent, so
			// it is made deterministic here: grep exits without reading a line. A
			// partition done in the shell never asks. (order_test_paths keeps its own
			// sed | sort — readers that consume all their input, so no early exit.)
			const earlyExit = ['grep() { return 0; }'];
			const baseline = runStageWithStubBun(hermetic);
			const { calls, rc } = runStageWithStubBun(hermetic, {}, earlyExit);
			expect(rc).toBe(0);
			expect(calls).toEqual(baseline.calls);
		});

		test('NEGATIVE CONTROL — a lane entry that is not a HERMETIC_TRIPWIRES entry reds the stage', () => {
			const planted = hermetic.source.replace(
				'HERMETIC_SERIAL_LANE=(\n',
				'HERMETIC_SERIAL_LANE=(\n\ttest/unit/zz_not_a_tripwire.test.ts\n',
			);
			expect(planted).not.toBe(hermetic.source);
			expect(runStageWithStubBun({ ...hermetic, source: planted }).rc).not.toBe(0);
		});
	});

	// EVERY tier keeps its stages independent, not just the one that was caught.
	//
	// `hermetic.sh` ran lint before its tripwires under `set -e`, so a red lint meant
	// zero gates executed — 45 commits of a tier reporting a formatting error while
	// proving nothing. That was fixed in Batch 0. `db_tier.sh` had the identical shape
	// and, the moment the unit and parity stages landed BELOW its tripwire block, the
	// identical consequence: one red gate would skip the entire 725-file unit tier.
	// Both are pinned here so neither can regress, and so a third tier inherits the
	// rule by landing in TIERS.
	for (const tier of TIERS) {
		test(`${tier.file} keeps its stages independent (the 45-commit regression)`, () => {
			expect(
				tier.source.includes('tier_status=0'),
				`${tier.file} has no tier_status accumulator: under \`set -e\` the first red stage ends ` +
					'the script and every stage after it is skipped while the log shows one failure.',
			).toBe(true);
			expect(
				/tier_status=1|tier_status=\$\?/.test(tier.source),
				`${tier.file} never RAISES tier_status — the accumulator is declared and unused, which ` +
					'reports green while a stage was red.',
			).toBe(true);
			expect(
				/\[ "\$tier_status" -eq 0 \]|exit "?\$tier_status"?/.test(tier.source),
				`${tier.file} never EXITS on tier_status — it records every verdict and then returns 0, ` +
					'which is a tier that cannot fail.',
			).toBe(true);
		});
	}
});
