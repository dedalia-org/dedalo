/**
 * SHARD MARIADB SWEEP — a multi-bin shard run leaves no suite MariaDB server behind
 * (PUB-05 review 2026-09-30, S2).
 *
 * THE DEFECT. `bun run test:shard` gives each bin `DEDALO_TEST_DATABASE=<template>__shard<N>`,
 * so the preload arms each child at a socket of its own, and the first MariaDB gate a
 * shard runs cold-installs and starts a DETACHED `mariadbd` under
 * `../private/test_mariadb/<template>__shard<N>`. `sweepShardClones` — the entry sweep,
 * the exit sweep and `--sweep` — dropped the clone database, its vector twin and its
 * media twin, and had no MariaDB handling at all: every multi-bin run left up to N-1
 * servers running (~140 MB RSS each, measured on l3) and their datadirs (~157 MB each)
 * on the volume the shard header names as the binding limit.
 *
 * WHAT IS HELD (outcomes):
 *   - on lanes planted under a PRIVATE probe template: a MARKED `<probe>__shard<N>` lane
 *     root with a live "server" (a process whose command line names mariadbd and the
 *     lane's datadir — exactly what the helper checks before it signals) is stopped and
 *     removed, and reported in `mariadbSwept`; an UNMARKED one is refused, kept
 *     byte-for-byte, and reported in `mariadbRefused`; a MARKED one whose sweep FAILS is
 *     kept and reported in `mariadbFailed` with the real error — never as "unmarked"
 *     (review 2026-09-30 S3: the catch-all turned every failure into a false "no
 *     marker" claim); a lane root not at a shard name is untouched;
 *   - the CLI: `scripts/test_shard.ts --sweep` exits non-zero on a refusal alone and on
 *     a failure alone, and prints each with its own cause; the ENTRY sweep of a real
 *     multi-bin invocation (`--bins=2`) REFUSES to run on each alone, before a clone is
 *     provisioned. Both read ONE verdict, `sweepBlockers` (pure, every report field held:
 *     a clean report blocks nothing, each blocking field alone blocks). The exit sweep
 *     prints the same lines after the bins ran; it decides nothing and is not reached
 *     here (it needs provisioned clones);
 *   - THIS GATE NEVER SWEEPS A TEMPLATE IT DID NOT BUILD (review 2026-09-30 S2). It
 *     calls Bun.spawn, so test_footprint pins it to the shard runner's BASE bin, which
 *     runs on the unsuffixed template WHILE bins 2..N run on live `<template>__shard<N>`
 *     clones. Sweeping `testDatabaseName()` from here force-dropped those clones, their
 *     vector and media twins, and stopped their MariaDB lanes mid-run. Held by
 *     planting a sibling bin's surfaces of THIS lane's template (a marked lane with a
 *     live "server", a marked media twin) and requiring them intact, the server alive.
 *     The sibling's bin number is derived from this pid (`siblingBin`, 900-989: a real
 *     run numbers its bins from 1), and each planted marker carries this gate's token
 *     and pid, so what a KILLED run leaves is cleared by the next run that reuses the
 *     slot (`clearKilledPlant`) instead of redding it for good — a root without the
 *     token, or the token of a LIVE run, is never touched (review 2026-09-30, S3);
 *
 * DB TIER: `sweepShardClones` enumerates clones through psql on the suite cluster (and
 * the vector server). The probe templates match no database there; this file creates
 * none and drops none. It removes only roots it created itself.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SweepReport, sweepShardClones } from '../../scripts/lib/test_shard_db.ts';
import {
	entrySweepTrailer,
	loadCostModel,
	partition,
	sweepBlockers,
} from '../../scripts/test_shard.ts';
import { SUITE_MARIADB_MARKER_FILE, suiteMariadbPaths } from '../helpers/suite_mariadb_env.ts';
import { suiteMariadbLaneEntries } from '../helpers/suite_mariadb_lanes.ts';
import { testDatabaseName } from '../helpers/test_database.ts';
import { classifyTestFile } from '../helpers/test_footprint.ts';
import { testMediaBaseDir } from '../helpers/test_media_root.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
/** THIS lane's template — what a concurrent `test:shard` bin's surfaces are named after. */
const LIVE = testDatabaseName();
/** The ONLY template this gate sweeps: one it built, which names nothing real. */
const PROBE = `zz_shardsweep_probe_${process.pid}`;
/** Two CLI probes: a refusal alone and a failure alone must EACH make `--sweep` exit non-zero. */
const CLI_REFUSAL_PROBE = `zz_shardsweep_clir_${process.pid}`;
const CLI_FAILURE_PROBE = `zz_shardsweep_clif_${process.pid}`;

const MARKED = suiteMariadbPaths(`${PROBE}__shard97`);
const UNMARKED = suiteMariadbPaths(`${PROBE}__shard98`);
const BROKEN = suiteMariadbPaths(`${PROBE}__shard99`);
const NOT_A_SHARD = suiteMariadbPaths(`${PROBE}__notashard97`);
const CLI_UNMARKED = suiteMariadbPaths(`${CLI_REFUSAL_PROBE}__shard1`);
const CLI_BROKEN = suiteMariadbPaths(`${CLI_FAILURE_PROBE}__shard1`);
/** Every marker this gate plants carries it — what licenses clearing a KILLED run's plant. */
const PLANT_TOKEN = 'planted by test/unit/shard_mariadb_sweep_native.test.ts';

/** The sibling bin a run with `pid` plants: 900-989 (a real run numbers its bins from 1). */
function siblingBin(pid: number): number {
	return 900 + (pid % 90);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The marker content of a plant: this gate's token and the planting pid. */
function plantMarker(pid = process.pid): string {
	return `${JSON.stringify({ planted_by: PLANT_TOKEN, pid })}\n`;
}

/**
 * Remove `dir` ONLY when it is a plant of this gate by a pid that is DEAD (a killed run):
 * its `markerName` file carries the token and names that pid. Anything else — no
 * marker, another content, a live planter — is left exactly as it is.
 */
function clearKilledPlant(dir: string, markerName: string): boolean {
	let marker: { planted_by?: unknown; pid?: unknown };
	try {
		marker = JSON.parse(readFileSync(join(dir, markerName), 'utf8'));
	} catch {
		return false;
	}
	if (marker.planted_by !== PLANT_TOKEN || typeof marker.pid !== 'number') return false;
	if (marker.pid === process.pid || pidAlive(marker.pid)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

/** A concurrent shard bin's surfaces (a run on this lane's template, bin `siblingBin`). */
const SIBLING = `${LIVE}__shard${siblingBin(process.pid)}`;
const SIBLING_LANE = suiteMariadbPaths(SIBLING);
const SIBLING_MEDIA = join(testMediaBaseDir(), SIBLING);

const created: string[] = [];
const servers: ReturnType<typeof Bun.spawn>[] = [];

/** Create `dir` (non-recursively for the last segment) and own it; refuse a pre-existing one. */
function plant(dir: string): void {
	mkdirSync(join(dir, '..'), { recursive: true });
	try {
		mkdirSync(dir);
	} catch (error) {
		throw new Error(
			`${dir} already exists (${(error as NodeJS.ErrnoException).code}) — a planted root must never collide with a real one`,
		);
	}
	created.push(dir);
}

function plantLane(paths: ReturnType<typeof suiteMariadbPaths>, marked: boolean): void {
	plant(paths.root);
	mkdirSync(paths.datadir);
	if (marked) writeFileSync(join(paths.root, SUITE_MARIADB_MARKER_FILE), plantMarker());
}

/** A marked lane whose sweep FAILS: its `.lock` is a directory, so the lane lock cannot open. */
function plantBrokenLane(paths: ReturnType<typeof suiteMariadbPaths>): void {
	plantLane(paths, true);
	mkdirSync(paths.lockFile);
}

function fakeServer(paths: ReturnType<typeof suiteMariadbPaths>): ReturnType<typeof Bun.spawn> {
	const server = Bun.spawn(
		[process.execPath, '-e', 'await Bun.sleep(120000)', 'mariadbd', `--datadir=${paths.datadir}`],
		{ stdout: 'ignore', stderr: 'ignore' },
	);
	servers.push(server);
	writeFileSync(paths.pidFile, `${server.pid}\n`);
	return server;
}

type Report = Awaited<ReturnType<typeof sweepShardClones>> & {
	mariadbSwept?: string[];
	mariadbRefused?: string[];
	mariadbFailed?: { lane: string; error: string }[];
};

const MEDIA_KINDS = [
	['', '.dedalo_test_media'],
	['.processes', '.dedalo_test_processes'],
	['.export_artifacts', '.dedalo_test_export_artifacts'],
] as const;
const UNMARKED_PROCESSES = join(testMediaBaseDir(), `${PROBE}__shard98.processes`);

let report: Report;
let markedServer: ReturnType<typeof Bun.spawn>;
let siblingServer: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
	plantLane(MARKED, true);
	plantLane(UNMARKED, false);
	writeFileSync(join(UNMARKED.datadir, 'keep'), 'not the suite’s\n');
	plantBrokenLane(BROKEN);
	plantLane(NOT_A_SHARD, true);
	clearKilledPlant(SIBLING_LANE.root, SUITE_MARIADB_MARKER_FILE);
	clearKilledPlant(SIBLING_MEDIA, '.dedalo_test_media');
	plantLane(SIBLING_LANE, true);
	plant(SIBLING_MEDIA);
	writeFileSync(join(SIBLING_MEDIA, '.dedalo_test_media'), plantMarker());
	// A shard child's media root grows two marked SIBLINGS (job registry, export store).
	for (const [suffix, marker] of MEDIA_KINDS) {
		plant(join(testMediaBaseDir(), `${PROBE}__shard97${suffix}`));
		writeFileSync(join(testMediaBaseDir(), `${PROBE}__shard97${suffix}`, marker), plantMarker());
	}
	plant(UNMARKED_PROCESSES);
	markedServer = fakeServer(MARKED);
	siblingServer = fakeServer(SIBLING_LANE);
	await Bun.sleep(200);
	report = (await sweepShardClones(PROBE)) as Report;
}, 60_000);

afterAll(() => {
	for (const server of servers) server.kill('SIGKILL');
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('the shard sweep owns the suite MariaDB surface', () => {
	test('a marked shard lane is stopped and removed; an unmarked one refused and kept; a non-shard lane untouched', async () => {
		expect(report.mariadbSwept, 'the sweep reports the MariaDB lanes it removed').toEqual([
			`${PROBE}__shard97`,
		]);
		expect(report.mariadbRefused, 'the sweep reports the lane roots it refused').toEqual([
			`${PROBE}__shard98`,
		]);
		expect(existsSync(MARKED.root), 'the marked shard lane root is gone').toBe(false);
		expect(await markedServer.exited, 'the shard lane server was stopped, not orphaned').not.toBe(
			0,
		);
		expect(readFileSync(join(UNMARKED.datadir, 'keep'), 'utf8')).toBe('not the suite’s\n');
		expect(existsSync(NOT_A_SHARD.markerFile), 'a lane not at a shard name is untouched').toBe(
			true,
		);
		// What the sweep LEFT, read back through the sweep's own lister of the lane base
		// (the walk this gate reaches): exactly the refused, the failed and the non-shard
		// lane — the swept one gone, and no `.<lane>.swept-…` trash beside them. Floored,
		// so a lister rooted anywhere but the base the lanes live in is red, never an
		// empty green.
		const left = suiteMariadbLaneEntries().filter((entry) => entry.includes(`${PROBE}__`));
		expect(
			left.length,
			'the lane base as the sweep lists it holds the kept probe lanes',
		).toBeGreaterThanOrEqual(3);
		expect(left).toEqual(
			[`${PROBE}__notashard97`, `${PROBE}__shard98`, `${PROBE}__shard99`].sort(),
		);
	});

	test('a shard media twin AND its .processes/.export_artifacts siblings are swept by their own markers; an unmarked sibling is refused', () => {
		// MEASURED 2026-10-31: sweeping only the twin leaked both siblings after every run.
		const swept = MEDIA_KINDS.map(([suffix]) =>
			join(testMediaBaseDir(), `${PROBE}__shard97${suffix}`),
		);
		expect([...report.mediaSwept].sort()).toEqual([...swept].sort());
		for (const dir of swept) expect(existsSync(dir), dir).toBe(false);
		expect(report.mediaRefused).toEqual([UNMARKED_PROCESSES]);
		expect(existsSync(UNMARKED_PROCESSES)).toBe(true);
	});

	test('a MARKED lane whose sweep fails is reported as a failure with its cause — never as unmarked', () => {
		expect(report.mariadbRefused ?? [], 'a marked lane is not "refused"').not.toContain(
			`${PROBE}__shard99`,
		);
		const failed = report.mariadbFailed ?? [];
		expect(
			failed.map((entry) => entry.lane),
			'the failed lane is reported as failed',
		).toEqual([`${PROBE}__shard99`]);
		expect(failed[0]?.error ?? '', 'the failure carries the real error').toContain('EISDIR');
		expect(existsSync(BROKEN.markerFile), 'a failed sweep keeps the marked root').toBe(true);
	});

	test('the gate never sweeps a template it did not build: a concurrent bin of THIS lane keeps its lane, server and media', () => {
		expect(existsSync(SIBLING_LANE.markerFile), "a sibling bin's lane root survives").toBe(true);
		expect(siblingServer.exitCode, "a sibling bin's server is not signalled").toBeNull();
		expect(siblingServer.killed).toBe(false);
		expect(
			existsSync(join(SIBLING_MEDIA, '.dedalo_test_media')),
			"a sibling bin's media twin survives",
		).toBe(true);
		const names = [
			...report.dropped,
			...report.mediaSwept,
			...(report.mariadbSwept ?? []),
			...report.refused.map((refusal) => refusal.name),
			...report.mediaRefused,
			...(report.mariadbRefused ?? []),
		];
		const foreign = names.filter((name) => name.includes(LIVE));
		expect(foreign, "the sweep saw nothing of this lane's template").toEqual([]);
	});

	test('`test_shard.ts --sweep` exits non-zero on a refusal alone AND on a failure alone, each named with its own cause', async () => {
		plantLane(CLI_UNMARKED, false);
		plantBrokenLane(CLI_BROKEN);
		const sweep = async (template: string, args: string[] = ['--sweep']) => {
			const child = Bun.spawn(
				[process.execPath, join(REPO_ROOT, 'scripts', 'test_shard.ts'), ...args],
				{
					cwd: REPO_ROOT,
					env: { ...process.env, DEDALO_TEST_DATABASE: template },
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			const line = `${stdout}\n${stderr}`
				.split('\n')
				// The VERDICT line: since every bin of a multi-bin run is a clone, the
				// manifest also names `<template>__shard1` (bin 1's database).
				.find(
					(candidate) =>
						candidate.includes(`'${template}__shard1'`) && /REFUS|FAILED/.test(candidate),
				);
			return { code, line: line ?? '', output: `${stdout}\n${stderr}` };
		};

		const refusal = await sweep(CLI_REFUSAL_PROBE);
		expect(refusal.code, `--sweep exit on a refusal (output:\n${refusal.output})`).toBe(1);
		expect(refusal.line, 'the unmarked lane is REFUSED for its missing marker').toMatch(
			/REFUSED.*no \.dedalo_test_mariadb marker/,
		);
		expect(existsSync(CLI_UNMARKED.datadir)).toBe(true);

		const failure = await sweep(CLI_FAILURE_PROBE);
		expect(failure.code, `--sweep exit on a failure (output:\n${failure.output})`).toBe(1);
		expect(failure.line, 'the marked lane whose sweep failed is reported as a FAILURE').toMatch(
			/FAILED/,
		);
		expect(failure.line, 'with its real cause').toContain('EISDIR');
		expect(failure.line, 'and never with the false "no marker" claim').not.toContain(
			'no .dedalo_test_mariadb marker',
		);
		expect(existsSync(CLI_BROKEN.markerFile)).toBe(true);

		// THE ENTRY SWEEP of a real multi-bin run: the same two lanes, each alone, must
		// refuse the run before anything is provisioned.
		// SAFETY FIRST: the two files are UNPINNED, so bin 2 is a CLONE bin and a runner
		// whose refusal is broken dies at the disk probe (a probe template has no
		// database) BEFORE it spawns a single `bun test`. Measured under mutation: with
		// THIS file in the list, the base bin ran it on the probe template and it
		// recursed, each level provisioning a probe media root and vector database.
		const binFiles = [
			'test/unit/batch_scope_tripwire.test.ts',
			'test/unit/diffusion_boundaries.test.ts',
		];
		const footprints = new Map(binFiles.map((file) => [file, classifyTestFile(file)]));
		expect(
			partition(binFiles, 2, footprints, loadCostModel(binFiles)).some((bin) => bin.shard !== null),
			'the planned run has a CLONE bin, so nothing is spawned before the disk probe',
		).toBe(true);
		const bins = ['--bins=2', ...binFiles];
		const entryRefusal = await sweep(CLI_REFUSAL_PROBE, bins);
		expect(entryRefusal.code, `entry sweep on a refusal (output:\n${entryRefusal.output})`).toBe(1);
		expect(entryRefusal.line, 'the run is REFUSED for the unmarked lane').toMatch(
			/REFUSING to run.*no \.dedalo_test_mariadb marker/,
		);
		expect(entryRefusal.output).not.toContain('provisioned');
		expect(entryRefusal.output, 'an unmarked lane IS "not a shard clone"').toContain(
			'not a shard clone',
		);
		const entryFailure = await sweep(CLI_FAILURE_PROBE, bins);
		expect(entryFailure.code, `entry sweep on a failure (output:\n${entryFailure.output})`).toBe(1);
		expect(entryFailure.line, 'the run is REFUSED for the failed sweep').toMatch(
			/REFUSING to run.*FAILED/,
		);
		expect(entryFailure.line, 'with its real cause').toContain('EISDIR');
		expect(entryFailure.output).not.toContain('provisioned');
		// The trailer: a MARKED lane that failed to sweep is the suite's own clone — never
		// "not a shard clone" (review 2026-09-30, S3).
		expect(
			entryFailure.output,
			'a failed marked lane is never called "not a shard clone"',
		).not.toContain('not a shard clone');
		expect(entryFailure.output, 'the trailer names the failure').toContain('could not be swept');
	}, 60_000);

	test('the entry-sweep trailer states what the blockers MEAN: "not a shard clone" only for a refusal, a failure named as one, and "nothing removed" only when nothing was', () => {
		const clean: SweepReport = {
			dropped: [],
			refused: [],
			mediaSwept: [],
			mediaRefused: [],
			mariadbSwept: [],
			mariadbRefused: [],
			mariadbFailed: [],
		};
		const text = (field: Partial<SweepReport>) =>
			entrySweepTrailer({ ...clean, ...field }).join('\n');
		for (const refusal of [
			{ refused: [{ name: 'x__shard2', state: 'unmarked' }] },
			{ mediaRefused: ['/m/x__shard3'] },
			{ mariadbRefused: ['x__shard4'] },
		] as Partial<SweepReport>[]) {
			expect(text(refusal), `${Object.keys(refusal)[0]} is "not a shard clone"`).toContain(
				'not a shard clone',
			);
			expect(text(refusal)).not.toContain('could not be swept');
		}
		const failure = { mariadbFailed: [{ lane: 'x__shard5', error: 'EISDIR' }] };
		expect(text(failure), 'a failure alone is never "not a shard clone"').not.toContain(
			'not a shard clone',
		);
		expect(text(failure)).toContain('could not be swept');
		expect(text(failure), 'nothing was removed').toContain('Nothing was removed');
		const removedThenRefused = {
			dropped: ['x__shard1'],
			mariadbSwept: ['x__shard1'],
			mariadbRefused: ['x__shard4'],
		};
		expect(
			text(removedThenRefused),
			'a sweep that DID remove something never claims nothing was removed',
		).not.toContain('Nothing was removed');
		expect(text(removedThenRefused)).toContain('removed 2');
	});

	test('ONE verdict decides both doors: a clean report blocks nothing; each blocking field alone blocks, naming its item', () => {
		const clean: SweepReport = {
			dropped: ['x__shard1'],
			refused: [],
			mediaSwept: ['/m/x__shard1'],
			mediaRefused: [],
			mariadbSwept: ['x__shard1'],
			mariadbRefused: [],
			mariadbFailed: [],
		};
		expect(sweepBlockers(clean), 'a sweep that removed everything blocks nothing').toEqual([]);
		const alone: [Partial<SweepReport>, RegExp][] = [
			[{ refused: [{ name: 'x__shard2', state: 'unmarked' }] }, /x__shard2.*unmarked/],
			[{ mediaRefused: ['/m/x__shard3'] }, /\/m\/x__shard3.*\.dedalo_test_media/],
			[{ mariadbRefused: ['x__shard4'] }, /x__shard4.*no \.dedalo_test_mariadb marker/],
			[
				{ mariadbFailed: [{ lane: 'x__shard5', error: 'EISDIR: boom' }] },
				/x__shard5.*EISDIR: boom/,
			],
		];
		for (const [field, names] of alone) {
			const blockers = sweepBlockers({ ...clean, ...field });
			expect(blockers, `${Object.keys(field)[0]} alone blocks`).toHaveLength(1);
			expect(blockers[0]).toMatch(names);
		}
		expect(
			sweepBlockers({ ...clean, mariadbFailed: [{ lane: 'x__shard5', error: 'EISDIR' }] })[0],
			'a failed sweep is never called unmarked',
		).not.toContain('no .dedalo_test_mariadb marker');
	});

	test("a KILLED run's plant is cleared by the next run of its slot; an unmarked root, another content, or a LIVE planter's plant is kept", async () => {
		const dead = Bun.spawn([process.execPath, '-e', '0'], { stdout: 'ignore', stderr: 'ignore' });
		await dead.exited;
		const base = suiteMariadbPaths(`${PROBE}__shard1`).root;
		const at = (suffix: string) => join(base, '..', `${PROBE}__plant_${suffix}`);
		const killed = at('killed');
		const live = at('live');
		const foreign = at('foreign');
		const unmarked = at('unmarked');
		for (const dir of [killed, live, foreign, unmarked]) plant(dir);
		writeFileSync(join(killed, SUITE_MARIADB_MARKER_FILE), plantMarker(dead.pid));
		writeFileSync(join(live, SUITE_MARIADB_MARKER_FILE), plantMarker(process.pid));
		writeFileSync(join(foreign, SUITE_MARIADB_MARKER_FILE), '{}\n');
		writeFileSync(join(unmarked, 'keep'), 'x');
		expect(siblingBin(dead.pid)).toBeGreaterThanOrEqual(900);
		expect(siblingBin(dead.pid)).toBeLessThan(990);
		expect(clearKilledPlant(killed, SUITE_MARIADB_MARKER_FILE), 'a killed run’s plant').toBe(true);
		expect(existsSync(killed)).toBe(false);
		for (const dir of [live, foreign, unmarked]) {
			expect(clearKilledPlant(dir, SUITE_MARIADB_MARKER_FILE), dir).toBe(false);
			expect(existsSync(dir), `${dir} is kept`).toBe(true);
		}
	});
});
