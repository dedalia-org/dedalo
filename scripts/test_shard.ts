/**
 * THE SHARD RUNNER — run the suite as N concurrent `bun test` child processes,
 * one cloned database per shard (`bun run test:shard`).
 *
 * WHY THIS IS NOT `bun test --parallel=N` (measured against Bun 1.4.0, the
 * pinned version, 2026-08-25). `--parallel` implies `--isolate`, which re-runs
 * all five bunfig preloads PER FILE — 779× the Postgres existence probe, and
 * `restoreCanonicalTest3` on every one — and its worker assignment is dynamic,
 * so a failure is not reproducible from a printed file list. This runner
 * instead spawns N ORDINARY `bun test <explicit file list>` child processes,
 * one per shard: one global, one module registry, five preloads exactly once
 * each — semantics byte-identical to today's serial run, with a
 * deterministic, printable, re-runnable file set (`--print`).
 *
 * THE PARTITION IS CONSTRAINED, AND A PLAIN LPT BIN-PACK WOULD BE INCORRECT,
 * not merely suboptimal. The co-location census
 * (scripts/lib/test_components.ts) measured ONE dominant connected component
 * of 95 files welded by shared destructive surfaces; an unconstrained pack
 * would put an UNSCOPED `dropTestCorpus()` caller in a different bin from a
 * scoped one, deleting the peer bin's fixture mid-run and flipping
 * `expect(…).toBe(0)` red non-deterministically. So: every connected component
 * is pinned ENTIRELY into one bin BEFORE the remainder is cost-balanced, and
 * every file whose footprint spawns subprocesses (test/helpers/
 * test_footprint.ts — a spawned child reaches Postgres with inherited env and
 * evades every in-process role guard) is pinned into the BASE bin, whose
 * environment is byte-identical to the serial run.
 *
 * THE DISCRIMINATOR IS TOTAL OR ABSENT, NEVER PARTIAL. A shard assignment
 * moves ALL FOUR surfaces at once: `DEDALO_TEST_DATABASE`, the resolved media
 * root, `DIFFUSION_JOBS_TABLE`, `DIFFUSION_ACTIVITY_TABLE`. A half-repointed
 * shard is WORSE than a shared one because it looks isolated. The media root
 * is moved BY NOT SETTING IT: `testMediaRootPath()` derives the tree FROM the
 * database name, so it follows the shard database for free — setting
 * `DEDALO_TEST_MEDIA_ROOT` by hand as well is exactly how the two would come
 * to disagree. With no shard assignment (a single bin, or `--shard=M/N`) every
 * surface is exactly today's literal: serial is a byte-identical no-op.
 *
 * TWO BUDGETS, BOTH REFUSE RATHER THAN CLAMP, both printing their arithmetic:
 *  - DISK: the volume holding the PG data directory is at 96% capacity with
 *    ~38.7 GiB free (measured 2026-08-25), and each FILE_COPY clone of the
 *    7.6 GB suite database is real bytes. Free space is re-checked AFTER EACH
 *    clone and the remainder aborted rather than filling the volume.
 *  - CONNECTIONS: every child runs with the SAME pool configuration a serial
 *    `bun test` resolves (DB_POOL_MAX, DB_MAINTENANCE_POOL_MAX,
 *    DB_POOL_ACQUIRE_TIMEOUT_MS — read through the config catalog, so
 *    ../private/.env and the catalog defaults apply exactly as they do serially)
 *    and pinned explicitly into its env. A sharded run that shrinks the pool is
 *    not the suite it claims to equal: MEASURED 2026-10-30, the old cap of 3
 *    (premise "a shard runs one file at a time") exhausted the pool in the
 *    lock/race gates — one FILE holds several connections at once by design
 *    (matrix_row_lock_native, tm_save_order_native, tree_cycle_race_native) —
 *    and every later file in the bin died on db.pool_exhausted: 1558 moved keys
 *    vs the serial campaign. The cluster must be sized for the suite, never the
 *    suite for the cluster: the budget counts BOTH pools per process and
 *    REFUSES (raise max_connections) before anything is cloned.
 *
 * COST comes from engineering/test_baseline/timings.json WHEN PRESENT; when
 * absent the pack falls back to file count and the manifest SAYS SO — never
 * pretending to a balance nobody measured.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It does not prove a sharded run EQUALS the serial baseline — that is the
 *    test-baseline campaign's four acceptance assertions
 *    (engineering/test_baseline/README.md), run against a shard's output.
 *  - The component census is source-derived; a surface it cannot see (see its
 *    header) is a surface this partition cannot protect.
 *  - The budgets are point-in-time reads; another process eating the disk or
 *    the connection headroom mid-run is caught only by the post-clone
 *    re-check and the children's own (now loud, bounded) pool errors.
 */

import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { readNumber } from '../src/config/readers.ts';
import { connectionsPerProcess } from '../src/core/db/connection_budget.ts';
import { testDatabaseName } from '../test/helpers/test_database.ts';
import { bandOf, classifyTestFile, type TestFootprint } from '../test/helpers/test_footprint.ts';
import { childEnv } from './lib/parity_census.ts';
import { buildTestComponentCensus } from './lib/test_components.ts';
import { TEST_TIMEOUT_FLAG } from './lib/test_flags.ts';
import { bunTestFileArgs, tierFiles } from './lib/test_order.ts';
import {
	assertShardableTemplate,
	cloneShardMedia,
	provisionShardDatabase,
	psql,
	type SweepReport,
	shardDatabaseName,
	sweepShardClones,
} from './lib/test_shard_db.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const TIMINGS_PATH = join(REPO_ROOT, 'engineering', 'test_baseline', 'timings.json');

/** Keep this many bytes free on the PG volume AFTER all clones (the volume is at 96%). */
export const DISK_HEADROOM_BYTES = 8 * 1024 ** 3;
/** Per-child request pool — what a serial run resolves (catalog + ../private/.env), never smaller. */
export const SHARD_POOL_MAX = Math.max(1, readNumber('DB_POOL_MAX'));
/** Per-child MAINTENANCE pool (PERF-11) — likewise the serial value. */
export const SHARD_MAINTENANCE_POOL_MAX = Math.max(1, readNumber('DB_MAINTENANCE_POOL_MAX'));
/**
 * The PHYSICAL backends one child process may hold — the request pool, BOTH
 * maintenance pools (the gate bounds slots in use; each Bun pool keeps its idle
 * sockets), the dedicated cancel/verdict connections. The budget counts THIS
 * (src/core/db/connection_budget.ts, measured by statement_ceiling_scope_native).
 */
export const SHARD_CONNECTIONS_PER_PROCESS = connectionsPerProcess(
	SHARD_POOL_MAX,
	SHARD_MAINTENANCE_POOL_MAX,
);
/**
 * The serial value too, 0 (wait forever) included: a hung acquire is still
 * bounded — loudly, by name — by the per-test timeout every child runs under
 * (TEST_TIMEOUT_FLAG), exactly as in a serial run. Cluster exhaustion is not
 * an acquire wait at all (Postgres refuses the connection outright).
 */
export const SHARD_POOL_ACQUIRE_TIMEOUT_MS = Math.max(0, readNumber('DB_POOL_ACQUIRE_TIMEOUT_MS'));
/** A pinned test may spawn ONE concurrent subprocess with its own pool. */
export const EXPECTED_CONCURRENT_GRANDCHILDREN = 1;

/**
 * Named in the disk refusal so the operator knows where the bytes ARE
 * (measured 2026-08-25 on this workstation; verify with `psql -l` before
 * dropping anything — the sweep's own guarded path applies to shard clones
 * only, and these two are not shard clones).
 */
const RECLAIMABLE_HINT =
	"reclaimable on this workstation (measured 2026-08-25): 'dedalo_mib_v7_test' " +
	'(7800 MB — the suite database of an install this checkout no longer points at) and ' +
	"'dedalo_install_p4_48373' (218 MB orphan install).";

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * The same discovery `bun test` performs under bunfig `root = "test"`: every
 * file under test/ whose basename matches bun's four test shapes (one walk,
 * scripts/lib/test_order.ts). Today that is exactly the `*.test.ts` set; the
 * other shapes are matched so a file bun would RUN can never be a file this
 * runner cannot SEE.
 */
export function discoverTestFiles(): string[] {
	return tierFiles(['test'], REPO_ROOT);
}

// ── costs ────────────────────────────────────────────────────────────────────

interface CostModel {
	/** file → cost. Milliseconds when measured; 1 per file in fallback mode. */
	cost: (file: string) => number;
	/** One honest sentence for the manifest. */
	provenance: string;
}

export function loadCostModel(files: readonly string[]): CostModel {
	if (!existsSync(TIMINGS_PATH)) {
		return {
			cost: () => 1,
			provenance:
				'timings.json ABSENT — cost = file count (1 per file); the balance is UNMEASURED. ' +
				"Run 'bun run test:timings' to measure it.",
		};
	}
	const body = JSON.parse(readFileSync(TIMINGS_PATH, 'utf8')) as {
		files?: Record<string, number>;
	};
	const timed = body.files ?? {};
	const known = files.filter((f) => typeof timed[f] === 'number');
	if (known.length === 0) {
		return {
			cost: () => 1,
			provenance:
				'timings.json present but covers NONE of the selected files — cost = file count; the balance is UNMEASURED.',
		};
	}
	// Median-of-measured for the unmeasured stragglers: honest middle, and the
	// manifest names how many needed it.
	const sorted = known.map((f) => timed[f] as number).sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] as number;
	const missing = files.length - known.length;
	return {
		cost: (file) => timed[file] ?? median,
		provenance:
			`costs from engineering/test_baseline/timings.json (${known.length} of ${files.length} ` +
			`files measured${missing > 0 ? `; ${missing} unmeasured at the median ${median} ms` : ''}).`,
	};
}

// ── partition ────────────────────────────────────────────────────────────────

export interface Bin {
	/** 1-based. Bin 1 is the BASE bin: serial-identical env, no clone. */
	index: number;
	/** null = base surfaces; a number = the `__shard<N>` clone this bin runs on. */
	shard: number | null;
	files: string[];
	cost: number;
}

interface Atom {
	files: string[];
	cost: number;
	/** Welded by the census (must stay whole) — named for the manifest. */
	component: boolean;
	/** Must run in the base bin (spawning / unresolvable footprint). */
	pinnedToBase: boolean;
}

/**
 * Build the atoms: census components first (an atom even when the run set
 * holds only PART of a component — the co-located part must still co-locate),
 * then every remaining file alone.
 */
export function buildAtoms(
	files: readonly string[],
	footprints: ReadonlyMap<string, TestFootprint>,
): Atom[] {
	const inRun = new Set(files);
	const census = buildTestComponentCensus();
	const atoms: Atom[] = [];
	const claimed = new Set<string>();
	for (const component of census.components) {
		const members = component.files.filter((f) => inRun.has(f));
		if (members.length === 0) continue;
		for (const member of members) claimed.add(member);
		atoms.push({
			files: members,
			cost: 0,
			component: true,
			pinnedToBase: members.some((f) => footprints.get(f)?.pinned ?? true),
		});
	}
	for (const file of files) {
		if (claimed.has(file)) continue;
		atoms.push({
			files: [file],
			cost: 0,
			component: false,
			// A file with no footprint would be a scheduling of the unknown —
			// fail-closed to the base bin, same direction as bandOf's rule.
			pinnedToBase: footprints.get(file)?.pinned ?? true,
		});
	}
	return atoms;
}

/**
 * The constrained partition: pinned atoms into bin 1, then longest-processing-
 * time-first over the rest. Deterministic — ties break on the first file name —
 * so `--shard=M/N` computes the SAME bins on any machine with the same tree.
 */
export function partition(
	files: readonly string[],
	binCount: number,
	footprints: ReadonlyMap<string, TestFootprint>,
	costs: CostModel,
): Bin[] {
	const atoms = buildAtoms(files, footprints);
	for (const atom of atoms) {
		atom.cost = atom.files.reduce((sum, f) => sum + costs.cost(f), 0);
	}
	const bins: Bin[] = Array.from({ length: binCount }, (_, i) => ({
		index: i + 1,
		shard: i === 0 ? null : i + 1,
		files: [],
		cost: 0,
	}));
	const ordered = [...atoms].sort(
		(a, b) => b.cost - a.cost || (a.files[0] ?? '').localeCompare(b.files[0] ?? ''),
	);
	for (const atom of ordered.filter((a) => a.pinnedToBase)) {
		const base = bins[0] as Bin;
		base.files.push(...atom.files);
		base.cost += atom.cost;
	}
	for (const atom of ordered.filter((a) => !a.pinnedToBase)) {
		const target = bins.reduce((least, bin) => (bin.cost < least.cost ? bin : least));
		target.files.push(...atom.files);
		target.cost += atom.cost;
	}
	for (const bin of bins) bin.files.sort();
	return bins.filter((bin) => bin.files.length > 0);
}

// ── budgets (pure — the arithmetic is testable with synthetic inputs) ────────

/**
 * THE ONE VERDICT over a sweep report (PUB-05 review 2026-09-30, S3): one line per item
 * that BLOCKS — `--sweep` exits 1 on any, the entry sweep refuses the run on any, the
 * exit sweep prints them. Empty = nothing blocks. Pure, so every field is held without
 * a multi-bin run (shard_mariadb_sweep_native); a field added to `SweepReport` that
 * blocks belongs HERE, once, not in three hand-copied conditions.
 */
export function sweepBlockers(report: SweepReport): string[] {
	return [
		...report.refused.map(
			(refusal) =>
				`REFUSED to drop '${refusal.name}': ${refusal.state} — it did not declare itself a disposable test database naming itself. Investigate before dropping by hand.`,
		),
		...report.mediaRefused.map(
			(dir) =>
				`REFUSED to remove '${dir}': no .dedalo_test_media marker — not a declared test media root.`,
		),
		...report.mariadbRefused.map(
			(lane) =>
				`REFUSED to remove suite MariaDB lane '${lane}': no .dedalo_test_mariadb marker — the suite did not create it.`,
		),
		...report.mariadbFailed.map(
			(failure) =>
				`FAILED to sweep suite MariaDB lane '${failure.lane}' (marked, kept): ${failure.error}`,
		),
	];
}

/**
 * What an entry-sweep refusal MEANS, after its blockers (review 2026-09-30, S3). "Not a
 * shard clone" is said only when something at a shard name was REFUSED for its missing
 * marker; a MARKED lane whose sweep FAILED is the suite's own clone and is named as a
 * failure. "Nothing was removed" is said only when the sweep removed nothing — it may
 * already have dropped marked clones before it met the blocker. Held by
 * shard_mariadb_sweep_native.
 */
export function entrySweepTrailer(report: SweepReport): string[] {
	const lines: string[] = [];
	if (report.refused.length + report.mediaRefused.length + report.mariadbRefused.length > 0)
		lines.push(
			'something at a shard name is not a shard clone — provisioning over it would destroy it.',
		);
	if (report.mariadbFailed.length > 0)
		lines.push(
			'a MARKED suite MariaDB lane could not be swept (its error is above) — fix the cause, then `bun scripts/test_shard.ts --sweep`.',
		);
	const removed = report.dropped.length + report.mediaSwept.length + report.mariadbSwept.length;
	lines.push(
		removed > 0
			? `The sweep removed ${removed} marked surface(s), listed above; no clone was built and no test ran.`
			: 'Nothing was removed, no clone was built, no test ran.',
	);
	return lines;
}

export interface DiskBudgetInput {
	freeBytes: number;
	headroomBytes: number;
	templateBytes: number;
	clonesNeeded: number;
}

export interface BudgetVerdict {
	ok: boolean;
	arithmetic: string;
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export function assessDiskBudget(input: DiskBudgetInput): BudgetVerdict {
	const usable = input.freeBytes - input.headroomBytes;
	const maxShards = Math.max(0, Math.floor(usable / input.templateBytes));
	const arithmetic =
		`disk budget: maxShards = floor((free ${gib(input.freeBytes)} − headroom ` +
		`${gib(input.headroomBytes)}) / template ${gib(input.templateBytes)}) = ${maxShards}; ` +
		`clones needed: ${input.clonesNeeded}`;
	return { ok: input.clonesNeeded <= maxShards, arithmetic };
}

export interface ConnectionBudgetInput {
	maxConnections: number;
	superuserReserved: number;
	liveBackends: number;
	children: number;
	/** Physical backends ONE process may hold (connectionsPerProcess — every pool, idle included). */
	poolMaxPerChild: number;
	expectedConcurrentGrandchildren: number;
}

export function assessConnectionBudget(input: ConnectionBudgetInput): BudgetVerdict {
	const demanded =
		input.children * input.poolMaxPerChild * (1 + input.expectedConcurrentGrandchildren);
	const required = demanded + input.superuserReserved + input.liveBackends;
	const arithmetic =
		`connection budget: ${input.children} children × pool ${input.poolMaxPerChild} × ` +
		`(1 + ${input.expectedConcurrentGrandchildren} spawned grandchild) = ${demanded}; ` +
		`+ ${input.superuserReserved} superuser-reserved + ${input.liveBackends} live = ` +
		`${required}, against max_connections ${input.maxConnections}`;
	return { ok: required < input.maxConnections, arithmetic };
}

// ── live probes for the budgets ──────────────────────────────────────────────

async function probeDisk(template: string): Promise<{ freeBytes: number; templateBytes: number }> {
	const dataDir = (await psql('postgres', ['-t', '-A', '-c', 'SHOW data_directory'])).trim();
	let freeBytes: number;
	try {
		const stats = statfsSync(dataDir);
		freeBytes = Number(stats.bavail) * Number(stats.bsize);
	} catch (error) {
		throw new Error(
			`REFUSING: cannot statfs the PG data volume ('${dataDir}'): ${String(error)}. ` +
				'Without a free-space reading no clone is safe on a 96%-full volume.',
		);
	}
	const templateBytes = Number(
		(
			await psql(
				'postgres',
				['-t', '-A', '-v', `db=${template}`, '-f', '-'],
				"SELECT pg_database_size((SELECT oid FROM pg_database WHERE datname = :'db'))\n",
			)
		).trim(),
	);
	if (!Number.isFinite(templateBytes) || templateBytes <= 0) {
		throw new Error(
			`REFUSING: pg_database_size('${template}') did not answer — does the suite database exist? Build it with 'bun run test:db:setup'.`,
		);
	}
	return { freeBytes, templateBytes };
}

async function probeConnections(): Promise<{
	maxConnections: number;
	superuserReserved: number;
	liveBackends: number;
}> {
	const read = async (sql: string): Promise<number> =>
		Number((await psql('postgres', ['-t', '-A', '-c', sql])).trim());
	return {
		maxConnections: await read('SHOW max_connections'),
		superuserReserved: await read('SHOW superuser_reserved_connections'),
		liveBackends: await read('SELECT count(*) FROM pg_stat_activity'),
	};
}

// ── child environment ────────────────────────────────────────────────────────

/**
 * Compose one child's environment. Serial (a single bin) is a byte-identical
 * no-op: the untouched parent env, exactly what `bun test` gets today. In a
 * multi-bin run every child starts from `childEnv()` — the SAME per-run-seam
 * strip parity_census and test_baseline use, so an inherited seam can never
 * double-derive — plus the serial pool configuration, pinned; a shard-assigned child then moves the
 * discriminator surfaces TOGETHER (header: total or absent, never partial).
 */
export function composeChildEnv(
	template: string,
	shard: number | null,
	multiBin: boolean,
): Record<string, string | undefined> {
	if (!multiBin) return { ...process.env };
	const env = childEnv();
	env.DB_POOL_MAX = String(SHARD_POOL_MAX);
	env.DB_MAINTENANCE_POOL_MAX = String(SHARD_MAINTENANCE_POOL_MAX);
	env.DB_POOL_ACQUIRE_TIMEOUT_MS = String(SHARD_POOL_ACQUIRE_TIMEOUT_MS);
	if (shard !== null) {
		env.DEDALO_TEST_DATABASE = shardDatabaseName(template, shard);
		// THE DIFFUSION TABLES ARE DELIBERATELY *NOT* SUFFIXED, and that is a
		// correction the first real sharded run forced.
		//
		// Suffixing them was belt-and-braces inherited from the shared-database
		// design, where two processes really would claim each other's jobs out of
		// one fixed table. A shard does not share a database: it gets its own
		// FILE_COPY clone, so `dedalo_ts_test_diffusion_jobs` inside shard 2 is
		// already a different relation from the same name inside shard 3. The
		// database boundary IS the isolation, and a second one bought nothing.
		//
		// What it cost was real. The clone inherits the template's tables under
		// their BASE names; nothing creates the suffixed ones. The suffixed name
		// only materialises if a schema-ensure runs first, and MEASURED on the
		// first sharded run, two files query the queue without one —
		// diffusion_actions and delete_multi_native both died in a hook with
		// `relation "dedalo_ts_test_diffusion_jobs__shard2" does not exist`,
		// taking all 8 of diffusion_actions' registered tests with them. Serial
		// never noticed because the base-named tables were already sitting in the
		// shared database, masking the missing ensure.
		//
		// So: the shard moves the DATABASE (and with it the media tree, which
		// testMediaRootPath() derives from the database name). The queue tables
		// travel inside the database, as they should.
		for (const key of ['DIFFUSION_JOBS_TABLE', 'DIFFUSION_ACTIVITY_TABLE'] as const) {
			// UNSET IS THE NORMAL CASE NOW: the shard does not repoint these (the
			// database clone already isolates them), so the child inherits whatever
			// test/preload/session_db.ts composes. Only a value that IS present has
			// a grammar to violate — asserting on `undefined` turned the correction
			// above into a spurious refusal.
			const value = env[key];
			if (value === undefined) continue;
			if (!/^dedalo_ts_test_[a-z0-9_]*$/.test(value)) {
				throw new Error(`composed ${key}='${value}' violates the scratch-table grammar`);
			}
		}
		// DEDALO_TEST_MEDIA_ROOT is DELIBERATELY not set: the child's preload
		// derives the tree from DEDALO_TEST_DATABASE (testMediaRootPath), so the
		// media root follows the database — one key, two surfaces, zero drift.
	}
	return env;
}

// ── manifest ─────────────────────────────────────────────────────────────────

export function printManifest(
	template: string,
	bins: readonly Bin[],
	costs: CostModel,
	footprints: ReadonlyMap<string, TestFootprint>,
): void {
	console.log(`shard manifest — template '${template}', ${bins.length} bin(s)`);
	console.log(costs.provenance);
	const bands = { A: 0, B: 0, C: 0 };
	for (const fp of footprints.values()) bands[bandOf(fp)]++;
	console.log(
		`footprints: ${footprints.size} files (band A ${bands.A} / B ${bands.B} / C ${bands.C}; ` +
			`pinned to base: ${[...footprints.values()].filter((f) => f.pinned).length})`,
	);
	for (const bin of bins) {
		const surface =
			bin.shard === null
				? 'BASE surfaces (byte-identical serial env)'
				: `database '${shardDatabaseName(template, bin.shard)}' + derived media root + suffixed diffusion tables`;
		console.log(
			`\n== bin ${bin.index} — ${bin.files.length} files, cost ${Math.round(bin.cost)} ==`,
		);
		console.log(`   ${surface}`);
		// `./`-prefixed and sorted: the exact argv the bin ran (a bare name is a bun FILTER).
		console.log(`   re-run alone: bun test ${TEST_TIMEOUT_FLAG} <files below, in this order>`);
		for (const file of bunTestFileArgs(bin.files, REPO_ROOT)) console.log(`   ${file}`);
	}
}

// ── run ──────────────────────────────────────────────────────────────────────

async function pump(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
	const decoder = new TextDecoder();
	let buffered = '';
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		const lines = buffered.split('\n');
		buffered = lines.pop() ?? '';
		for (const line of lines) console.log(`${prefix} ${line}`);
	}
	if (buffered !== '') console.log(`${prefix} ${buffered}`);
}

interface ChildResult {
	bin: Bin;
	exitCode: number;
}

async function runBins(
	template: string,
	bins: readonly Bin[],
	junitDir: string | null,
): Promise<number> {
	const multiBin = bins.length > 1;
	const running: ReturnType<typeof Bun.spawn>[] = [];
	const results: ChildResult[] = [];
	let interrupted = false;
	const onSignal = (): void => {
		interrupted = true;
		for (const proc of running) proc.kill();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	try {
		await Promise.all(
			bins.map(async (bin) => {
				const env = composeChildEnv(template, multiBin ? bin.shard : null, multiBin);
				const reporterArgs =
					junitDir === null
						? []
						: ['--reporter=junit', `--reporter-outfile=${join(junitDir, `bin${bin.index}.xml`)}`];
				const proc = Bun.spawn(
					[
						'bun',
						'test',
						TEST_TIMEOUT_FLAG,
						...reporterArgs,
						...bunTestFileArgs(bin.files, REPO_ROOT),
					],
					{
						cwd: REPO_ROOT,
						env,
						stdout: 'pipe',
						stderr: 'pipe',
					},
				);
				running.push(proc);
				const prefix = `[bin ${bin.index}]`;
				await Promise.all([
					pump(proc.stdout as ReadableStream<Uint8Array>, prefix),
					pump(proc.stderr as ReadableStream<Uint8Array>, prefix),
				]);
				results.push({ bin, exitCode: await proc.exited });
			}),
		);
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	}
	console.log('\n== shard summary ==');
	for (const result of [...results].sort((a, b) => a.bin.index - b.bin.index)) {
		console.log(
			`bin ${result.bin.index}: exit ${result.exitCode} (${result.bin.files.length} files)`,
		);
	}
	if (interrupted) return 130;
	return results.every((r) => r.exitCode === 0) ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface CliOptions {
	print: boolean;
	sweep: boolean;
	bins: number;
	/** `--shard=M/N` — run bin M of an N-way partition on the BASE surfaces. */
	shardOf: { m: number; n: number } | null;
	/**
	 * `--junit-dir=<dir>` — write one JUnit XML per bin, named bin<N>.xml.
	 *
	 * The ACCEPTANCE path, not a convenience. Bun's default reporter emits a line
	 * only for FAILURES: comparing a sharded run to a serial one on its printed
	 * totals cannot tell which keys moved, and a test that stops being REGISTERED
	 * makes the failure count go DOWN, which reads as an improvement. MEASURED on
	 * the first real sharded run: 8616 tests vs the serial 8621, with skips at 35
	 * vs 55 — a discrepancy invisible in a pass/fail tally. JUnit is the only
	 * reporter carrying a record per test with its file, so the three-state
	 * (file, suite, name) -> pass|fail|skip map in engineering/test_baseline/
	 * README.md can be built for a sharded run at all.
	 */
	junitDir: string | null;
	files: string[];
}

export function parseArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		print: false,
		sweep: false,
		bins: 4,
		shardOf: null,
		junitDir: null,
		files: [],
	};
	for (const arg of argv) {
		if (arg === '--print') options.print = true;
		else if (arg === '--sweep') options.sweep = true;
		else if (arg.startsWith('--bins=')) {
			const bins = Number(arg.slice('--bins='.length));
			if (!Number.isInteger(bins) || bins < 1) {
				throw new Error(`--bins must be a positive integer, got '${arg}'`);
			}
			options.bins = bins;
		} else if (arg.startsWith('--shard=')) {
			const match = /^--shard=(\d+)\/(\d+)$/.exec(arg);
			if (match === null) throw new Error(`--shard must be M/N, got '${arg}'`);
			const m = Number(match[1]);
			const n = Number(match[2]);
			if (m < 1 || n < 1 || m > n) throw new Error(`--shard=${m}/${n} is out of range`);
			options.shardOf = { m, n };
		} else if (arg.startsWith('--junit-dir=')) {
			const dir = arg.slice('--junit-dir='.length);
			if (dir === '') throw new Error('--junit-dir requires a directory path');
			options.junitDir = dir;
		} else if (arg.startsWith('--')) {
			throw new Error(
				`unknown argument '${arg}'. Flags: --print, --sweep, --bins=N, --shard=M/N, --junit-dir=DIR; positional args are explicit test files.`,
			);
		} else {
			options.files.push(arg);
		}
	}
	return options;
}

async function main(): Promise<number> {
	const options = parseArgs(Bun.argv.slice(2));
	const template = assertShardableTemplate(testDatabaseName());

	if (options.sweep) {
		const report = await sweepShardClones(template);
		for (const name of report.dropped) console.log(`[sweep] dropped clone database ${name}`);
		for (const dir of report.mediaSwept) console.log(`[sweep] removed media twin ${dir}`);
		for (const lane of report.mariadbSwept)
			console.log(`[sweep] stopped + removed suite MariaDB lane ${lane}`);
		const blockers = sweepBlockers(report);
		for (const blocker of blockers) console.error(`[sweep] ${blocker}`);
		return blockers.length > 0 ? 1 : 0;
	}

	// Resolve the file set: explicit list (validated), else bun's own discovery.
	let files: string[];
	if (options.files.length > 0) {
		files = options.files.map((f) => f.replace(/^\.\//, ''));
		const phantom = files.filter((f) => !existsSync(join(REPO_ROOT, f)));
		if (phantom.length > 0) {
			throw new Error(`named test files do not exist: ${phantom.join(', ')}`);
		}
	} else {
		files = discoverTestFiles();
	}
	if (files.length === 0) throw new Error('no test files discovered — nothing to shard');

	const footprints = new Map<string, TestFootprint>();
	for (const file of files) footprints.set(file, classifyTestFile(file));
	const costs = loadCostModel(files);

	if (options.shardOf !== null) {
		// The credless fallback: partition deterministically, run ONE bin on the
		// BASE surfaces (each --shard invocation is its own machine/CI job with
		// its own suite database — no clones, no budgets, no env repoint).
		const shardOf = options.shardOf;
		const bins = partition(files, shardOf.n, footprints, costs);
		const mine = bins.find((bin) => bin.index === shardOf.m);
		if (mine === undefined) {
			console.log(
				`[shard] partition produced ${bins.length} non-empty bins; bin ${shardOf.m} is empty — nothing to run.`,
			);
			return 0;
		}
		printManifest(template, [mine], costs, footprints);
		if (options.print) return 0;
		return runBins(template, [mine], options.junitDir);
	}

	const binCount = Math.max(1, Math.min(options.bins, files.length));
	if (binCount !== options.bins) {
		console.log(`[shard] --bins=${options.bins} clamped to ${binCount} (${files.length} files).`);
	}
	const bins = partition(files, binCount, footprints, costs);
	printManifest(template, bins, costs, footprints);
	if (options.print) return 0;

	// ── entry sweep: a stale clone of an old schema is worse than no clone. ──
	const entry = await sweepShardClones(template);
	for (const name of entry.dropped) console.log(`[shard] entry sweep dropped stale clone ${name}`);
	for (const dir of entry.mediaSwept) console.log(`[shard] entry sweep removed media twin ${dir}`);
	for (const lane of entry.mariadbSwept)
		console.log(`[shard] entry sweep removed suite MariaDB lane ${lane}`);
	const entryBlockers = sweepBlockers(entry);
	if (entryBlockers.length > 0) {
		for (const blocker of entryBlockers)
			console.error(`[shard] REFUSING to run — the entry sweep ${blocker}`);
		for (const line of entrySweepTrailer(entry)) console.error(`[shard] ${line}`);
		return 1;
	}

	const clones = bins.filter((bin) => bin.shard !== null);
	if (clones.length > 0) {
		// ── the two budgets, before a single byte moves. ──
		const disk = await probeDisk(template);
		const diskVerdict = assessDiskBudget({
			freeBytes: disk.freeBytes,
			headroomBytes: DISK_HEADROOM_BYTES,
			templateBytes: disk.templateBytes,
			clonesNeeded: clones.length,
		});
		console.log(`[shard] ${diskVerdict.arithmetic}`);
		if (!diskVerdict.ok) {
			console.error(
				`[shard] REFUSING: not enough disk for ${clones.length} clone(s). ${RECLAIMABLE_HINT} Or lower --bins.`,
			);
			return 1;
		}
		const conn = await probeConnections();
		const connVerdict = assessConnectionBudget({
			...conn,
			children: bins.length,
			poolMaxPerChild: SHARD_CONNECTIONS_PER_PROCESS,
			expectedConcurrentGrandchildren: EXPECTED_CONCURRENT_GRANDCHILDREN,
		});
		console.log(`[shard] ${connVerdict.arithmetic}`);
		if (!connVerdict.ok) {
			console.error(
				'[shard] REFUSING: the cluster cannot seat every shard pool at the serial pool size. Raise max_connections (ALTER SYSTEM SET max_connections = …; restart) or lower --bins — never shrink the child pool: a smaller pool is not the suite the serial baseline measured.',
			);
			return 1;
		}

		// ── provision, re-checking free space AFTER EACH clone. ──
		for (const bin of clones) {
			const shard = bin.shard as number;
			const name = await provisionShardDatabase(template, shard);
			console.log(`[shard] provisioned ${name} (FILE_COPY clone of ${template})`);
			const media = await cloneShardMedia(template, shard);
			if (media !== null) console.log(`[shard] media twin ready: ${media}`);
			const remaining = clones.filter((c) => (c.shard as number) > shard).length;
			if (remaining > 0) {
				const after = await probeDisk(template);
				if (after.freeBytes - DISK_HEADROOM_BYTES < disk.templateBytes) {
					throw new Error(
						`[shard] aborting after ${name}: free space fell to ${(after.freeBytes / 1024 ** 3).toFixed(2)} GiB and ${remaining} clone(s) remain — refusing to fill a 96%-full volume. ${RECLAIMABLE_HINT}`,
					);
				}
			}
		}
	}

	try {
		return await runBins(template, bins, options.junitDir);
	} finally {
		// Exit sweep — SIGKILL defeats this (and the signal handlers), which is
		// why the ENTRY sweep above and the named `--sweep` command exist too.
		const exit = await sweepShardClones(template);
		for (const name of exit.dropped) console.log(`[shard] swept clone ${name}`);
		for (const dir of exit.mediaSwept) console.log(`[shard] swept media twin ${dir}`);
		for (const lane of exit.mariadbSwept) console.log(`[shard] swept suite MariaDB lane ${lane}`);
		for (const blocker of sweepBlockers(exit)) console.error(`[shard] exit sweep ${blocker}`);
	}
}

if (import.meta.main) {
	process.exit(await main());
}
