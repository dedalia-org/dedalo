/**
 * SHARD PARTITION TRIPWIRE — the Phase 3 shard runner's partition, environment
 * discriminator and budget refusals, held to their contracts BEFORE a single
 * clone exists.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The shard runner (scripts/test_shard.ts) splits the suite into N concurrent
 * `bun test` child processes, each on a FILE_COPY clone of the 7.6 GB suite
 * database (measured 2026-08-25). Every one of its guarantees is a computation,
 * and each computation has a silent failure mode the composite run cannot see:
 *
 *  - A partition that DROPS a file reports a green composite that simply never
 *    ran that file — the exact "silently narrow scope" failure the hard rules
 *    forbid. Totality is therefore asserted against bun's OWN discovery set,
 *    not against a list the partitioner hands back about itself.
 *  - A partition that SPLITS a welded component (the census measured ONE
 *    dominant component of 95 files welded by TLD-wide destructive drops,
 *    whole-corpus ensureTestCorpus() calls and the canonical-test3 rewriters,
 *    2026-08-25) puts two mutually destructive files in different processes:
 *    one deletes the other's fixture mid-assertion, non-deterministically.
 *  - A HALF-moved environment is worse than an unmoved one, because it looks
 *    isolated: the four discriminator surfaces (DEDALO_TEST_DATABASE, the
 *    DERIVED media root, DIFFUSION_JOBS_TABLE, DIFFUSION_ACTIVITY_TABLE) must
 *    move together or not at all.
 *  - A re-derivation over an already-sharded env yields `<t>__shard2__shard2`
 *    — a database no sweep enumerates and no budget counted.
 *  - A budget that CLAMPS instead of refusing fills a volume measured at 96%
 *    capacity, or exhausts max_connections. And a child pool SMALLER than the
 *    serial one is a different suite: the lock/race gates hold several
 *    connections from ONE file, so a cap of 3 exhausted the pool and failed
 *    every later file in the bin (MEASURED 2026-10-30, 1558 moved keys). The
 *    child pins the SERIAL pool configuration; a process opens BOTH its
 *    request pool and its maintenance pool (DB_MAINTENANCE_POOL_MAX): the
 *    budget counts both, and refuses rather than shrink.
 *
 * ── ANTI-VACUITY ─────────────────────────────────────────────────────────────
 * Every derived set has a floor (discovery > 700 files; the census still holds
 * a multi-file component of ≥ 40 files; all three footprint bands populated),
 * and the classifier is pinned BY NAME at three files whose classifications
 * were measured 2026-08-25: locator_law (pure A), json_codec_roundtrip
 * (whole-corpus caller, welded to test_corpus_fixture), diffusion_dispatch_gate
 * (spawner, pinned to the base bin of an unsealed plan). A classifier that answers one value for
 * everything, or an emptied scan, is RED on those names, not quietly green.
 * The pure matchers (bandOf, the budget assessors, the fixed-path scans) are
 * additionally fed SYNTHETIC inputs that MUST fail them.
 *
 * ── WHAT THIS DOES NOT PROVE, stated plainly ─────────────────────────────────
 *  - It proves the PLAN, not the run: no clone is created, no child spawned, no
 *    byte written. That a sharded run EQUALS the serial baseline is the
 *    test-baseline campaign's four acceptance assertions
 *    (engineering/test_baseline/README.md), fed a real run's output.
 *  - The footprint and component censuses read SOURCE (their own headers carry
 *    the honest limits); a surface they cannot see is a surface this partition
 *    gate cannot protect either.
 *  - The budget arithmetic is asserted over synthetic inputs; the live probes
 *    (statfs, pg_stat_activity) are exercised only by a real
 *    `bun run test:shard` run.
 *
 * HERMETIC: filesystem reads of tracked source + pure computation. NO Postgres,
 * no network, no clone, no child process — runnable on a machine with nothing
 * but the checkout.
 *
 * Registration (scripts/verify.ts TRIPWIRES + engineering/TRIPWIRES.md) is a
 * separate, deliberate edit — see the index's own contract.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildTestComponentCensus } from '../../scripts/lib/test_components.ts';
import {
	assertShardableTemplate,
	shardDatabaseName,
	treeFingerprint,
} from '../../scripts/lib/test_shard_db.ts';
import {
	assessConnectionBudget,
	assessDiskBudget,
	type Bin,
	composeChildEnv,
	discoverTestFiles,
	EXPECTED_CONCURRENT_GRANDCHILDREN,
	loadCostModel,
	partition,
	planBins,
	SHARD_CONNECTIONS_PER_PROCESS,
	SHARD_MAINTENANCE_POOL_MAX,
	SHARD_POOL_MAX,
} from '../../scripts/test_shard.ts';
import { readNumber } from '../../src/config/readers.ts';
import { connectionsPerProcess } from '../../src/core/db/connection_budget.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { testDatabaseName } from '../helpers/test_database.ts';
import { bandOf, classifyTestFile, type TestFootprint } from '../helpers/test_footprint.ts';
import { testMediaRootPath } from '../helpers/test_media_root.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ── the plan, computed ONCE the way the runner computes it ───────────────────

const FILES = discoverTestFiles();
const FOOTPRINTS = new Map<string, TestFootprint>();
for (const file of FILES) FOOTPRINTS.set(file, classifyTestFile(file));
const COSTS = loadCostModel(FILES);
const CENSUS = buildTestComponentCensus();
const BINS = partition(FILES, 4, FOOTPRINTS, COSTS);

/** bin index for a file, over a computed partition. -1 = not scheduled. */
function binOf(bins: readonly Bin[], file: string): number {
	for (const bin of bins) if (bin.files.includes(file)) return bin.index;
	return -1;
}

// The three files whose classifications pin the classifier (measured
// 2026-08-25 — see the header). Existence is asserted, so a rename reddens
// this gate instead of silently unpinning it.
const PURE_CONTROL = 'test/unit/locator_law.test.ts';
const CORPUS_CONTROL = 'test/unit/json_codec_roundtrip.test.ts';
const CORPUS_TWIN = 'test/unit/test_corpus_fixture.test.ts';
// A file that REALLY spawns: queue_fence_tripwire runs the diffusion runner as
// a child to prove it refuses a missing/non-integer --epoch. The previous
// control, diffusion_dispatch_gate.test.ts, only ASSERTED ON the spelling of a
// spawn in src/ — and when that assertion became a regex (`/Bun\.spawn\(/`)
// the classifier stopped seeing a spawn in it, correctly: it never spawned
// anything. A positive control must be an instance of the class, not a file
// that mentions it.
const SPAWNER_CONTROL = 'test/unit/queue_fence_tripwire.test.ts';

describe("shard partition — totality and disjointness against bun's own discovery", () => {
	test('anti-vacuity floor: discovery saw the real suite', () => {
		// 783 files measured 2026-08-25. A discovery that collapses (glob broke,
		// root moved) must be RED here, or every assertion below is about nothing.
		expect(FILES.length).toBeGreaterThan(700);
		expect(new Set(FILES).size).toBe(FILES.length);
		for (const control of [PURE_CONTROL, CORPUS_CONTROL, CORPUS_TWIN, SPAWNER_CONTROL]) {
			expect(FILES, `named control '${control}' left the suite — re-pin this gate`).toContain(
				control,
			);
		}
	});

	test('every discovered file lands in EXACTLY one bin — for several bin counts', () => {
		// A file in no bin is a test the composite run silently never runs (the
		// "never silently narrow scope" hard rule); a file in two bins runs twice
		// against fixtures that assume single ownership.
		for (const binCount of [1, 2, 4, 12]) {
			const bins = partition(FILES, binCount, FOOTPRINTS, COSTS);
			const placed = bins.flatMap((bin) => bin.files);
			expect(
				placed.length,
				`bin count ${binCount}: ${placed.length} placements over ${FILES.length} files — a file is dropped or duplicated`,
			).toBe(FILES.length);
			expect([...placed].sort()).toEqual([...FILES].sort());
		}
	});
});

describe('shard partition — component closure', () => {
	test('anti-vacuity floor: the census still measures a welded suite', () => {
		// Measured 2026-08-25: 10 multi-file components, the dominant one 95
		// files. A census that answers "no components" un-welds everything and
		// makes the closure assertion below vacuously green.
		expect(CENSUS.components.length).toBeGreaterThanOrEqual(3);
		expect(CENSUS.components[0]?.files.length ?? 0).toBeGreaterThanOrEqual(40);
	});

	test('every connected component lands wholly in one bin', () => {
		for (const component of CENSUS.components) {
			const bins = new Set(
				component.files.filter((f) => FILES.includes(f)).map((f) => binOf(BINS, f)),
			);
			expect(
				[...bins],
				`component [${component.files[0]} …, ${component.files.length} files] is split across bins ${[...bins].join(', ')} — two processes will destroy each other's shared surface (${component.edges[0]?.kind} '${component.edges[0]?.surface}')`,
			).toHaveLength(1);
			expect(bins.has(-1)).toBe(false);
		}
	});

	test('by name: the whole-corpus caller co-locates with its welded twin', () => {
		// json_codec_roundtrip and test_corpus_fixture are the two UNSCOPED
		// corpus callers (measured 2026-08-25) — each conflicts with EVERY corpus
		// caller, so they can never sit in different bins.
		const fp = FOOTPRINTS.get(CORPUS_CONTROL) as TestFootprint;
		expect(fp.corpusCaller).toBe(true);
		expect(bandOf(fp)).toBe('C');
		expect(binOf(BINS, CORPUS_CONTROL)).toBe(binOf(BINS, CORPUS_TWIN));
	});
});

describe('shard partition — the classifier is pinned by name (positive controls)', () => {
	test('a pure file classifies band A and unpinned', () => {
		const fp = FOOTPRINTS.get(PURE_CONTROL) as TestFootprint;
		expect(bandOf(fp), `${PURE_CONTROL} must classify pure (band A)`).toBe('A');
		expect(fp.pinned).toBe(false);
		expect(fp.dbTouching).toBe(false);
	});

	test('a spawner classifies pinned and runs in the BASE bin of an UNSEALED (--shard=M/N) plan', () => {
		// --shard=M/N runs one bin per machine on that machine's own base
		// surfaces: the pin keeps spawners where the env is serial-identical.
		const fp = FOOTPRINTS.get(SPAWNER_CONTROL) as TestFootprint;
		expect(fp.spawnsProcesses, `${SPAWNER_CONTROL} must classify as a spawner`).toBe(true);
		expect(fp.pinned).toBe(true);
		const bin = BINS.find((b) => b.files.includes(SPAWNER_CONTROL)) as Bin;
		expect(bin.index).toBe(1);
		expect(bin.shard).toBeNull();
	});

	test('a SEALED (multi-bin) plan puts EVERY bin on a clone and pins nothing to a base bin', () => {
		// The template is closed to connections for a multi-bin run, so no bin
		// may be scheduled on it (shard null) — and with nothing on the template
		// the spawner pin has nothing left to protect: the pinned files must be
		// cost-balanced across bins, not stacked into bin 1.
		const sealed = partition(FILES, 4, FOOTPRINTS, COSTS, true);
		expect(sealed.map((b) => b.shard)).toEqual([1, 2, 3, 4]);
		const pinnedFiles = FILES.filter((f) => FOOTPRINTS.get(f)?.pinned ?? true);
		expect(pinnedFiles.length).toBeGreaterThan(0);
		const binsHoldingPinned = sealed.filter((b) => b.files.some((f) => pinnedFiles.includes(f)));
		expect(binsHoldingPinned.length).toBeGreaterThan(1);
		// …and the partition stays TOTAL and DISJOINT under the seal.
		const placed = sealed.flatMap((b) => b.files);
		expect(new Set(placed).size).toBe(placed.length);
		expect([...placed].sort()).toEqual([...FILES].sort());
	});

	test('a plan that collapses to ONE bin is never sealed — it would run on the sealed template', () => {
		// partition() drops empty bins: two files welded into one census component
		// fill one bin of a --bins=2 request. A sealed one-bin plan would give that
		// bin a clone name the runner never applies (runBins repoints only
		// multi-bin runs) and run it on the template it just sealed. MEASURED by the
		// 2026-10-31 review of the seal; the plan must fall back to serial.
		const welded = CENSUS.components.find((c) => c.files.length >= 2);
		expect(welded, 'the census holds a multi-file component').toBeDefined();
		const pair = (welded as { files: string[] }).files.slice(0, 2);
		const plan = planBins(pair, 2, FOOTPRINTS, COSTS);
		expect(plan.bins.length).toBe(1);
		expect(plan.sealed).toBe(false);
		expect(plan.bins[0]?.shard).toBeNull();
		// …and a real multi-bin plan IS sealed, every bin on a clone.
		const full = planBins(FILES, 4, FOOTPRINTS, COSTS);
		expect(full.sealed).toBe(true);
		expect(full.bins.every((b) => b.shard !== null)).toBe(true);
	});

	test('the template media fingerprint sees a write, a create-then-delete, and a created root', () => {
		// The DB seal cannot cover the filesystem; this fingerprint is the run's
		// only witness of a process writing the TEMPLATE's media tree. Driven on a
		// scratch tree (pure fs, no media door), every contact shape must differ.
		const scratch = mkdtempSync(join(tmpdir(), 'shard_fp_'));
		try {
			const root = join(scratch, 'media');
			expect(treeFingerprint(root), 'absent root').toBeNull();
			Bun.spawnSync(['mkdir', '-p', join(root, 'sub')]);
			writeFileSync(join(root, 'sub', 'a.jpg'), 'one');
			const before = treeFingerprint(root);
			expect(before).not.toBeNull();
			expect(treeFingerprint(root), 'untouched = equal').toBe(before);
			// a size change
			writeFileSync(join(root, 'sub', 'a.jpg'), 'one-more');
			const afterWrite = treeFingerprint(root);
			expect(afterWrite).not.toBe(before);
			// a file created then deleted leaves only the directory mtime behind
			Bun.sleepSync(20);
			writeFileSync(join(root, 'sub', 'tmp.bin'), 'x');
			rmSync(join(root, 'sub', 'tmp.bin'));
			expect(treeFingerprint(root)).not.toBe(afterWrite);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('the classifier is not degenerate: all three bands are populated', () => {
		const bands = { A: 0, B: 0, C: 0 };
		for (const fp of FOOTPRINTS.values()) bands[bandOf(fp)]++;
		// A classifier that answers ONE value for everything (an emptied scan, a
		// broken import walk) zeroes two of these.
		expect(bands.A).toBeGreaterThan(0);
		expect(bands.B).toBeGreaterThan(0);
		expect(bands.C).toBeGreaterThan(0);
	});

	test('bandOf itself, on synthetic footprints that MUST land where stated', () => {
		const blank: TestFootprint = {
			file: 'synthetic.test.ts',
			closure: [],
			unresolvedImports: [],
			zzTlds: [],
			corpusCaller: false,
			canonicalTest3: false,
			diffusionTables: false,
			dbTouching: false,
			sharedMediaRoot: false,
			scratchMedia: false,
			fsOrProcess: false,
			spawnsProcesses: false,
			pinned: false,
		};
		expect(bandOf(blank)).toBe('A');
		// An unresolvable import fail-closes to the MOST constrained band.
		expect(bandOf({ ...blank, unresolvedImports: ['x -> ./gone.ts'], pinned: true })).toBe('C');
		expect(bandOf({ ...blank, corpusCaller: true })).toBe('C');
		expect(bandOf({ ...blank, spawnsProcesses: true, pinned: true })).toBe('B');
	});
});

describe('shard env — the discriminator is total or absent, never partial', () => {
	const TEMPLATE = 'shardgate_tpl';

	test('a shard assignment moves the database and its derived tree, and nothing else', () => {
		const env = composeChildEnv(TEMPLATE, 2, true);
		// 1. the database — the ONE surface a shard assignment sets by name.
		expect(env.DEDALO_TEST_DATABASE).toBe(`${TEMPLATE}__shard2`);
		// 2 + 3. the diffusion queue tables are NOT repointed, and this is the
		// corrected contract rather than an omission. A shard owns a whole
		// database clone, so the base-named tables inside it are already distinct
		// relations from every peer's; a name suffix on top bought nothing and
		// cost a real regression — the clone inherits the template's tables under
		// their BASE names, so the suffixed relation existed nowhere and two files
		// died in a hook with `relation "…__shard2" does not exist`, taking 8
		// registered tests with them (MEASURED, first sharded run).
		expect(env.DIFFUSION_JOBS_TABLE ?? '').not.toMatch(/__shard\d+/);
		expect(env.DIFFUSION_ACTIVITY_TABLE ?? '').not.toMatch(/__shard\d+/);
		// Whatever they are, they stay inside the scratch grammar schema.ts uses
		// to refuse a production table.
		for (const key of ['DIFFUSION_JOBS_TABLE', 'DIFFUSION_ACTIVITY_TABLE'] as const) {
			const value = env[key];
			if (value !== undefined) expect(value).toMatch(/^dedalo_ts_test_[a-z0-9_]*$/);
		}
		// 4. the media root moves BY NOT BEING SET: the child derives its tree
		// FROM the database name. Setting it here as well is exactly how the two
		// surfaces would come to disagree — so the key must be ABSENT…
		expect(env.DEDALO_TEST_MEDIA_ROOT).toBeUndefined();
		// …and the derivation must actually land on the shard's own tree.
		expect(basename(testMediaRootPath(env.DEDALO_TEST_DATABASE as string))).toBe(
			`${TEMPLATE}__shard2`,
		);
		// The pools are the SERIAL configuration, pinned by value — what a plain
		// `bun test` resolves through the catalog — never a shard-only shrink.
		expect(Number(env.DB_POOL_MAX)).toBe(Math.max(1, readNumber('DB_POOL_MAX')));
		expect(Number(env.DB_MAINTENANCE_POOL_MAX)).toBe(
			Math.max(1, readNumber('DB_MAINTENANCE_POOL_MAX')),
		);
		expect(Number(env.DB_POOL_ACQUIRE_TIMEOUT_MS)).toBe(
			Math.max(0, readNumber('DB_POOL_ACQUIRE_TIMEOUT_MS')),
		);
		// The catalog default (10) is the floor a lock/race gate was written for.
		expect(Number(env.DB_POOL_MAX)).toBeGreaterThanOrEqual(10);
	});

	test('no shard assignment moves NONE of the four', () => {
		// CONTROL THE INPUT, because this gate RUNS INSIDE ITS OWN SUBJECT.
		//
		// composeChildEnv() reads process.env. Under `bun run test:shard` this file
		// executes in a shard CHILD, whose environment legitimately carries
		// DEDALO_TEST_DATABASE=<template>__shardN — so the assertion below read the
		// inherited suffix and failed, reporting a defect in the runner that was
		// really the gate observing its own execution context. MEASURED: this was
		// one of exactly four pass->fail transitions in the first serial-vs-sharded
		// junit comparison, and the only one that was the gate's own fault.
		//
		// The claim being made is about the FUNCTION ("given no shard, it adds no
		// suffix"), never about the ambient environment, so the keys are
		// cleared for the duration and restored afterwards.
		//
		// THE ADDRESSING KEYS ARE CLEARED TOO (2026-08-31). Clearing
		// DEDALO_TEST_DATABASE alone stopped being sufficient once childEnv() began
		// RESOLVING the suite database instead of leaving the child to re-derive it
		// (scripts/lib/parity_census.ts): with the explicit key gone, the derivation
		// falls to DB_NAME, which in a shard child is `<template>__shardN` — so the
		// composed name would be `<template>__shardN_test` and this gate would once
		// more report the runner for what is its own inherited context. Same defect
		// the block above describes, one key further down the chain.
		const SHARD_KEYS = [
			'DEDALO_TEST_DATABASE',
			'DB_NAME',
			'DEDALO_DATABASE_CONN',
			'DIFFUSION_JOBS_TABLE',
			'DIFFUSION_ACTIVITY_TABLE',
			'DEDALO_TEST_MEDIA_ROOT',
		] as const;
		const saved = new Map<string, string | undefined>();
		for (const key of SHARD_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		try {
			assertNoShardSuffix(composeChildEnv(TEMPLATE, null, true), SHARD_KEYS);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	function assertNoShardSuffix(
		env: Record<string, string | undefined>,
		keys: readonly string[],
	): void {
		for (const key of keys) {
			expect(env[key] ?? '', `${key} must not carry a shard suffix without a shard`).not.toMatch(
				/__shard\d+/,
			);
		}
	}

	test('serial no-op — the set and unset cases asserted AGAINST each other', () => {
		// Both halves together are what an emptied composeChildEnv cannot fake:
		// returning {} fails the serial equality; returning process.env verbatim
		// fails the shard difference.
		const serial = composeChildEnv(TEMPLATE, null, false);
		expect(serial).toEqual({ ...process.env });
		const sharded = composeChildEnv(TEMPLATE, 2, true);
		expect(sharded.DEDALO_TEST_DATABASE).toBe(`${TEMPLATE}__shard2`);
		expect(sharded.DEDALO_TEST_DATABASE).not.toBe(serial.DEDALO_TEST_DATABASE);
	});
});

describe('shard env — value idempotence: <base>__shard2__shard2 is unreachable', () => {
	test('the derivation applied twice REFUSES, on the value', () => {
		// Pure half: derive once, feed the result back — must throw, so no
		// stacked suffix can ever name a database the sweep does not enumerate.
		expect(assertShardableTemplate('scratch_base')).toBe('scratch_base');
		const once = shardDatabaseName('scratch_base', 2);
		expect(once).toBe('scratch_base__shard2');
		expect(() => assertShardableTemplate(once)).toThrow(/__shard/);
	});

	test('driven through the ENV seam, set and unset, env restored after', () => {
		const saved = process.env.DEDALO_TEST_DATABASE;
		try {
			// SET to an already-sharded name — the exact state of a process running
			// INSIDE a shard child: re-derivation must refuse, not stack suffixes.
			process.env.DEDALO_TEST_DATABASE = 'scratch_base__shard2';
			expect(testDatabaseName()).toBe('scratch_base__shard2');
			expect(() => assertShardableTemplate(testDatabaseName())).toThrow(/__shard/);

			// UNSET — the parent-runner state: the derived template must be
			// shardable exactly once, and refuse on the second application.
			delete process.env.DEDALO_TEST_DATABASE;
			const template = assertShardableTemplate(testDatabaseName());
			expect(template).not.toMatch(/__shard\d+$/);
			expect(() => assertShardableTemplate(shardDatabaseName(template, 2))).toThrow(/__shard/);
		} finally {
			if (saved === undefined) delete process.env.DEDALO_TEST_DATABASE;
			else process.env.DEDALO_TEST_DATABASE = saved;
		}
	});
});

describe('shard tier — no fixed cross-shard path, no fixed database identifier', () => {
	// The tier: the runner, its provisioning library and the classifier. Two
	// concurrent shard children sharing a FIXED path under tmpdir(), or a
	// hard-coded database identifier in a CREATE/DROP, is cross-shard state by
	// construction — the per-call mkdtemp / interpolated-identifier forms are
	// the only ones allowed.
	const TIER = [
		'scripts/test_shard.ts',
		'scripts/lib/test_shard_db.ts',
		'test/helpers/test_footprint.ts',
	];

	/** `join(tmpdir(), '<literal>')` outside a mkdtemp call, in a source that writes. */
	function fixedTmpdirFaults(source: string): string[] {
		const writes =
			/\bwriteFileSync\b|\bmkdirSync\b|\bappendFileSync\b|\bBun\.write\b|\bcreateWriteStream\b|\brmSync\b|\bcp\b/.test(
				source,
			);
		if (!writes) return [];
		const faults: string[] = [];
		for (const match of source.matchAll(/join\(\s*tmpdir\(\)/g)) {
			const before = source.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
			if (!/mkdtemp(?:Sync)?\s*\($/.test(before.trimEnd())) {
				faults.push(`fixed tmpdir path at offset ${match.index}`);
			}
		}
		return faults;
	}

	/** CREATE/DROP DATABASE naming a fixed quoted identifier instead of an interpolation. */
	function fixedDatabaseIdentifierFaults(source: string): string[] {
		const faults: string[] = [];
		for (const match of source.matchAll(
			/(?:CREATE|DROP)\s+DATABASE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"(?!\$\{)/g,
		)) {
			faults.push(`fixed database identifier at offset ${match.index}`);
		}
		return faults;
	}

	test('anti-vacuity floor: the tier is present and the scan sees its real symbols', () => {
		// An emptied or re-pointed scan must be RED: the combined tier source must
		// still carry the load-bearing names, or this whole block reads nothing.
		const combined = TIER.map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');
		expect(combined.length).toBeGreaterThan(10000);
		expect(combined).toContain('sweepShardClones');
		expect(combined).toContain('provisionShardDatabase');
		expect(combined).toContain('classifyTestFile');
	});

	test('the tier carries neither fault', () => {
		for (const file of TIER) {
			const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
			expect(fixedTmpdirFaults(source), `${file}: fixed tmpdir path`).toEqual([]);
			expect(fixedDatabaseIdentifierFaults(source), `${file}: fixed DB identifier`).toEqual([]);
		}
	});

	test('positive controls: synthetic offenders MUST fail the matchers', () => {
		expect(
			fixedTmpdirFaults(`writeFileSync(join(tmpdir(), 'dedalo_shared_scratch'), body);`),
		).not.toEqual([]);
		expect(
			fixedTmpdirFaults(`const dir = mkdtempSync(join(tmpdir(), 'dedalo-shard-')); rmSync(dir);`),
		).toEqual([]);
		// A read-only tmpdir mention (no write in the file) is not convicted.
		expect(fixedTmpdirFaults(`const t = join(tmpdir(), 'x');`)).toEqual([]);
		expect(
			fixedDatabaseIdentifierFaults(
				`await psql('postgres', ['-c', 'DROP DATABASE "dedalo_ts_test__shard2"']);`,
			),
		).not.toEqual([]);
		expect(
			// eslint-style template interpolation — the only allowed identifier form.
			// biome-ignore format: the string mirrors the tier's own spelling.
			fixedDatabaseIdentifierFaults('await psql(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);'),
		).toEqual([]);
	});
});

describe('shard budgets — refusal driven by synthetic inputs, both directions', () => {
	const GIB = 1024 ** 3;

	test('disk: too little free space REFUSES, with the arithmetic printed', () => {
		const verdict = assessDiskBudget({
			freeBytes: 10 * GIB,
			headroomBytes: 8 * GIB,
			templateBytes: 7.6 * GIB,
			clonesNeeded: 3,
		});
		expect(verdict.ok).toBe(false);
		// The arithmetic must NAME its numbers — a refusal an operator cannot
		// check is an order, not a budget.
		expect(verdict.arithmetic).toContain('maxShards');
		expect(verdict.arithmetic).toContain('= 0');
		expect(verdict.arithmetic).toContain('3');
	});

	test('disk: generous space PASSES the same arithmetic', () => {
		const verdict = assessDiskBudget({
			freeBytes: 100 * GIB,
			headroomBytes: 8 * GIB,
			templateBytes: 7.6 * GIB,
			clonesNeeded: 3,
		});
		expect(verdict.ok).toBe(true);
	});

	test('connections: an over-committed cluster REFUSES — the wait-forever default makes this a hang, not an error', () => {
		const verdict = assessConnectionBudget({
			maxConnections: 100,
			superuserReserved: 3,
			liveBackends: 19,
			children: 13,
			poolMaxPerChild: 10,
			expectedConcurrentGrandchildren: 1,
		});
		expect(verdict.ok).toBe(false);
		expect(verdict.arithmetic).toContain('13 children');
		expect(verdict.arithmetic).toContain('max_connections 100');
	});

	test('connections: the shipped shard shape is counted PHYSICALLY, and REFUSES rather than shrink', () => {
		// A child may hold its request pool, BOTH maintenance pools (the
		// non-transactional lane is a second Bun pool: the gate bounds slots in
		// use, not idle sockets) and the dedicated cancel/verdict connections —
		// the formula statement_ceiling_scope_native measures in pg_stat_activity.
		// Budgeting only the gate slots under-counts every child.
		expect(SHARD_CONNECTIONS_PER_PROCESS).toBe(
			connectionsPerProcess(SHARD_POOL_MAX, SHARD_MAINTENANCE_POOL_MAX),
		);
		const shape = {
			superuserReserved: 3,
			liveBackends: 29,
			children: 4,
			poolMaxPerChild: SHARD_CONNECTIONS_PER_PROCESS,
			expectedConcurrentGrandchildren: EXPECTED_CONCURRENT_GRANDCHILDREN,
		};
		// The stock cluster (100) cannot seat four serial-size children: REFUSED…
		expect(assessConnectionBudget({ ...shape, maxConnections: 100 }).ok).toBe(false);
		// …a cluster sized for the suite can.
		expect(assessConnectionBudget({ ...shape, maxConnections: 300 }).ok).toBe(true);
	});
});
