/**
 * TEST-MEDIA-ROOT TRIPWIRE (DEC-12) — the FILESYSTEM half of "a test never
 * writes to production data", 2026-08-19.
 *
 * `test_db_marker_tripwire` closed the database: the suite runs on a database
 * that says in a row of its own that it is disposable, and every test-data
 * writer asks it. That work LEDGERED the surface it left open — `MEDIA_PATH`.
 * The client suite, `ensureMediaKit`, the media unit gates and every tool that
 * builds a derivative wrote into the INSTALLATION's media tree, beside 32 GB of
 * heritage masters that cannot be re-acquired.
 *
 * THE MECHANISM THIS GATE GUARDS, in one line: `DEDALO_TEST_MEDIA_ROOT` both
 * REPOINTS the media root and ARMS a refusal, and every door that resolves a
 * media root asks the directory for a `.dedalo_test_media` marker before it
 * writes. One key does both halves so a run cannot be armed at the installation's
 * root, nor repointed with the guard asleep (src/core/media/test_media_root.ts;
 * src/config/config.ts `buildMediaConfig`).
 *
 * SEVEN RULES, each with an anti-vacuity probe:
 *
 *  1. INVENTORY — DERIVED, not enumerated. Every file under `src/` and `tools/`
 *     that RESOLVES a media root (reads `config.media.rootPath`, comments
 *     stripped) either passes it through the guard, or delegates to a resolver
 *     that does (`requireMediaRoot`), or carries a NAMED reason in
 *     `EXEMPT_RESOLVERS`. A new door that forgets is caught by derivation, and a
 *     stale exemption is a failure — a dead exemption widens the law silently.
 *  2. REFUSAL, PROVED ON THE REAL DOORS. Each door is pointed at an UNMARKED
 *     temp root and must refuse naming itself, having written NOTHING (the
 *     directory is read back and must still be empty); then at a MARKED root,
 *     where it must succeed. A guard nobody proves in both directions is a guard
 *     that may be refusing for some other reason, or not refusing at all.
 *  3. THE MARKER LITERAL AGREES IN BOTH PLACES. It is spelled twice by
 *     necessity: `test/helpers/test_media_root.ts` runs in the preload, BEFORE
 *     `src/config/config.ts` may be imported (importing it there would freeze
 *     the media root and the DB connection at the installation's values), so it
 *     cannot import the canonical constant. This asserts the copy is identical.
 *  4. THE SEAM IS ACTUALLY ON, in this very process, and the root it names is
 *     marked and is NOT the installation's.
 *  5. ONE SETTER PER TIER, and no more. Exactly three places set the key — the
 *     `bun test` preload, `scripts/test_db_setup.ts` (which sweeps and rebuilds
 *     the tree) and `scripts/client_test_server.ts` (which hands it to the
 *     server it spawns) — and the preload is registered in `bunfig.toml`. A
 *     fourth setter, or a missing preload line, is how a tier quietly stops
 *     being covered.
 *  6. DB↔TREE PAIRING (2026-08-25, the parallel-shard work). A shard database is
 *     a clone (`<template>__shard<N>`), and its media tree must FOLLOW that name
 *     through `testMediaRootPath()` — NO shard-tier file sets
 *     `DEDALO_TEST_MEDIA_ROOT`. Setting both halves by hand is precisely how they
 *     come to disagree; the `<app>_test_test` debris this header records was that
 *     bug at N=1, and at N shards it can hand two shards ONE tree over TWO
 *     databases, where one shard's sweep deletes the other's corpus media
 *     mid-assertion. The tier is DERIVED (the provisioner plus its importers) and
 *     the forbidden-setter half is presence-gated on
 *     `scripts/lib/test_shard_db.ts`, written in parallel with this gate; the
 *     PAIRING half is behavioural and binds now — basename == database name, no
 *     two shards share a tree, no shard tree is (or contains, or is inside) the
 *     template's, and the DEFAULT derivation follows `DEDALO_TEST_DATABASE`, which
 *     is what makes "the runner sets only the database" a mechanism rather than a
 *     hope.
 *  7. THE EXPORT-ARTIFACTS ROOT (2026-09-24). tool_export's artifact store is a
 *     second file-write root with its own marker. 7a: exactly one module (the
 *     store) reads `config.ops.exportArtifactsDir` — derived by a scan. 7b: the
 *     store's mutating doors are DERIVED from the `ArtifactStore` interface and
 *     each is driven against an unmarked root holding a victim job: refusal
 *     (`export.store_unavailable`) and a byte-identical tree; the read-only
 *     methods are driven too and must leave the tree unchanged.
 *  8. THE JOB-REGISTRY DIRECTORY (2026-09-24). jobs.ts pfiles: armed with no
 *     explicit DEDALO_MEDIA_PROCESSES_DIR, a real job's file lands in the
 *     marked sibling `<test media root>.processes` and NOT in
 *     `<privateDir>/processes`; an explicit unmarked dir refuses
 *     (`media.invalid_path`, nothing created); an explicit marked one wins; the
 *     key's readers are a derived, closed set; the helper's marker copy equals
 *     the canonical one.
 *
 * HONEST LIMIT. This proves that every door RESOLVING a root asks the marker,
 * and that the doors refuse. It does not prove a module cannot compose an
 * absolute media path from parts it read out of `files_info` without ever
 * calling a resolver — the confinement chokepoint (`assertInsideMediaRoot`) is
 * what covers that direction, and it too resolves through `requireMediaRoot`.
 *
 * And rule 6's forbidden-setter half does not run while `scripts/lib/test_shard_db.ts`
 * is absent. What it leaves open is only "the provisioner exists and obeys" —
 * rule 5's three-setter census still refuses a fourth setter anywhere under
 * `scripts/`, shard tier or not, and rule 6b's pairing proof runs either way.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { Glob } from 'bun';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { config } from '../../src/config/config.ts';
import { NEW_IN_V7 } from '../../src/config/migration_map.ts';
import {
	mediaRootIsMarked,
	requireTestMediaRoot,
	TEST_MEDIA_MARKER as SRC_TEST_MEDIA_MARKER,
} from '../../src/core/media/test_media_root.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	assertDistinctFromInstallMediaRoot,
	TEST_MEDIA_MARKER,
	testMediaRootPath,
} from '../helpers/test_media_root.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (relPath: string): string => readFileSync(join(REPO_ROOT, relPath), 'utf8');

// ---------------------------------------------------------------------------
// RULE 1 — the inventory is DERIVED from the source.
// ---------------------------------------------------------------------------

/** Directories scanned whole, `.ts` only, tests excluded. */
const SCAN_DIRS = ['src', 'tools'];

/** The token that MAKES a file a media-root resolver. */
const ROOT_READ = 'config.media.rootPath';

/** The guards, and the resolver that delegates to them. */
const GUARD_CALLS = ['assertTestMediaRoot(', 'requireTestMediaRoot(', 'requireMediaRoot('];

/**
 * Files that read the root and are NOT write doors. Each reason is a fact about
 * what the file DOES with the value, never "it looked safe".
 */
const EXEMPT_RESOLVERS: Record<string, string> = {
	'src/server.ts':
		'SERVES bytes: `MEDIA_ROOT` is the read-only base of the static media route. It never creates a file, and refusing a READ would break the dev media route on a legitimately unmarked root.',
	'src/core/api/handlers/system_info.ts':
		'REPORTS the configured root back to an administrator as a string in a JSON body. It touches no filesystem path at all.',
	'src/core/section/record/duplicate_record.ts':
		'Reads it only as `!== null`, to decide whether media duplication runs; every path it then builds is produced by `media/path.ts`, which is guarded.',
	'src/core/security/session_media.ts':
		'Reads it ONLY to ask `mediaRootIsMarked` — the guard question itself, asked in the safe direction. Before the hourly sweeper reconciles markers it checks that this process is not holding a throwaway session store against an unmarked (i.e. production) root; a marked root is what makes the reconcile SAFE there, so calling the refusing guard would invert the test. It builds no path and writes nothing.',
	'tools/tool_export/server/artifact_store.ts':
		'Reads it ONLY as a path to stay AWAY from (`webServedTrees` — the placement rule refuses an export root that overlaps the web-served media tree). It never builds a path under it, never writes into it; its own writes go to the export root, which has its own marker guard (`assertExportArtifactsRoot`).',
	'src/config/writable_roots.ts':
		'THE BOOT CHECK of the writable roots (owner C32): reads every configured writer path — the media root among them — as a STRING to judge against the unit’s ReadWritePaths= manifest. It builds no path under it, reads no directory, writes nothing; a path outside the roots refuses the boot before any writer runs.',
	'src/core/media/stem_rules.ts':
		'Reads it only as `=== null` (no media root: no files can exist, the stem lock has nothing to judge); every location it then tests for existence is produced by `media/path.ts buildMediaLocation` from guarded options (resolveMediaPathOptions), and it never writes — the lock asks whether a file EXISTS, nothing more.',
};

/** Every `.ts` file under the scanned dirs, tests and node_modules excluded. */
function scannedFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			if (name === 'node_modules' || name === 'dist') continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
			out.push(relative(REPO_ROOT, full));
		}
	};
	for (const dir of SCAN_DIRS) walk(join(REPO_ROOT, dir));
	return out;
}

/** The files that resolve a media root, comments stripped so prose never counts. */
function resolverFiles(): string[] {
	return scannedFiles().filter((file) => stripComments(read(file)).includes(ROOT_READ));
}

describe('test media root — RULE 1: the resolver inventory is derived', () => {
	const resolvers = resolverFiles();

	test('the scan finds the resolvers we know about (anti-vacuity)', () => {
		// If the token or the walk broke, the inventory would be empty and every
		// assertion below would pass while proving nothing.
		expect(resolvers.length).toBeGreaterThan(5);
		for (const pinned of [
			'src/core/media/path.ts',
			'src/core/media/protection.ts',
			'src/core/install/media_tree.ts',
			'src/diffusion/targets/mediastore/media_index.ts',
		]) {
			expect(resolvers, `${pinned} must be classified as a media-root resolver`).toContain(pinned);
		}
	});

	test('every resolver asks the guard, or is exempt with a reason', () => {
		const unguarded = resolvers.filter((file) => {
			if (EXEMPT_RESOLVERS[file] !== undefined) return false;
			const source = stripComments(read(file));
			return !GUARD_CALLS.some((call) => source.includes(call));
		});
		expect(
			unguarded,
			`These files resolve a media root without asking the '${TEST_MEDIA_MARKER}' guard. Pass the root through assertTestMediaRoot('<door>') (or resolve it with requireMediaRoot), or add an entry to EXEMPT_RESOLVERS stating what the file does with the value: ${unguarded.join(', ')}`,
		).toEqual([]);
	});

	test('no exemption is stale', () => {
		const stale = Object.keys(EXEMPT_RESOLVERS).filter((file) => !resolvers.includes(file));
		expect(
			stale,
			`Exempt files that no longer resolve a media root (or no longer exist). Delete the entry — a dead exemption widens the law silently: ${stale.join(', ')}`,
		).toEqual([]);
	});

	test('every exemption carries a substantive reason', () => {
		const thin = Object.entries(EXEMPT_RESOLVERS)
			.filter(([, reason]) => reason.trim().length < 40)
			.map(([file]) => file);
		expect(thin, `An exemption reason must say what the file DOES: ${thin.join(', ')}`).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// RULE 2 — the doors REFUSE an unmarked root, and write nothing.
// ---------------------------------------------------------------------------

/** A fresh, deliberately UNDECLARED temp directory. */
function unmarkedRoot(): string {
	return mkdtempSync(join(tmpdir(), 'dedalo_unmarked_media_'));
}

/**
 * THE DOORS, by name. `run(root)` must WRITE when the root is marked and REFUSE
 * when it is not — both directions are asserted, so a door that throws for an
 * unrelated reason cannot masquerade as a refusal.
 */
const DOORS: readonly {
	name: string;
	run: (root: string) => unknown | Promise<unknown>;
}[] = [
	{
		name: 'requireMediaRoot',
		run: async (root) => {
			const { requireMediaRoot } = await import('../../src/core/media/path.ts');
			return requireMediaRoot(root);
		},
	},
	{
		name: 'buildMediaLocation (every quality path in the engine)',
		run: async (root) => {
			const { buildMediaLocation } = await import('../../src/core/media/path.ts');
			const { mediaTypeOf } = await import('../../src/core/concepts/media.ts');
			const spec = mediaTypeOf('component_image');
			if (spec === null) throw new Error('component_image spec unavailable');
			return buildMediaLocation(
				spec,
				{ componentTipo: 'test78', sectionTipo: 'test2', sectionId: 1, lang: null },
				spec.defaultQuality,
				'jpg',
				{ initialMediaPath: '', maxItemsFolder: null, mediaRoot: root },
			);
		},
	},
	{
		name: 'stagingDir (the upload endpoint the client suite drives)',
		run: async (root) => {
			const { stagingDir } = await import('../../src/core/media/ingest/add_file.ts');
			return stagingDir(1, 'test', root);
		},
	},
	{
		name: 'provisionMediaTree (the directory creator)',
		run: async (root) => {
			const { provisionMediaTree } = await import('../../src/core/install/media_tree.ts');
			return provisionMediaTree({ root, create: true });
		},
	},
	{
		name: 'ensureMediaKit (the corpus media planter)',
		run: async (root) => {
			const { ensureMediaKit } = await import('../../src/core/test_data/test_corpus/ensure.ts');
			return ensureMediaKit({ mediaRoot: root });
		},
	},
];

describe('test media root — RULE 2: every door refuses an unmarked root', () => {
	for (const door of DOORS) {
		test(`${door.name} refuses, names itself, and writes NOTHING`, async () => {
			const root = unmarkedRoot();
			try {
				let message = '';
				try {
					await door.run(root);
					throw new Error(`${door.name} did NOT refuse an unmarked media root`);
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(message).toContain(TEST_MEDIA_MARKER);
				expect(message).toContain('REFUSED');
				expect(message).toContain('NOTHING WAS WRITTEN');
				// The load-bearing half: the refusal happened BEFORE any write.
				expect(readdirSync(root)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test('provisionMediaTree WRITES into a marked root (the other direction)', async () => {
		const root = markMediaRoot(unmarkedRoot());
		try {
			const { provisionMediaTree } = await import('../../src/core/install/media_tree.ts');
			const report = provisionMediaTree({ root, create: true });
			expect(report.created.length).toBeGreaterThan(0);
			expect(existsSync(join(root, 'image'))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('the marker predicate is not vacuous', () => {
		const root = unmarkedRoot();
		try {
			expect(mediaRootIsMarked(root)).toBe(false);
			markMediaRoot(root);
			expect(mediaRootIsMarked(root)).toBe(true);
			// And the unconditional door agrees with the predicate in both states.
			expect(requireTestMediaRoot(root, 'probe')).toBe(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// RULE 3 — the marker literal is spelled the same in both homes.
// ---------------------------------------------------------------------------

describe('test media root — RULE 3: one marker, two spellings, no drift', () => {
	test('the preload-safe copy equals the canonical constant', () => {
		expect(TEST_MEDIA_MARKER).toBe(SRC_TEST_MEDIA_MARKER);
		expect(TEST_MEDIA_MARKER).toBe('.dedalo_test_media');
	});

	test('the copy exists for the stated reason: the helper must not import config', () => {
		// If this ever becomes false, the duplication is no longer necessary and the
		// helper should import the canonical constant instead.
		const helper = stripComments(read('test/helpers/test_media_root.ts'));
		expect(helper).not.toContain('config/config.ts');
	});
});

// ---------------------------------------------------------------------------
// RULE 4 — the seam is ON in this process, and points somewhere safe.
// ---------------------------------------------------------------------------

describe('test media root — RULE 4: this run is armed', () => {
	test('the guard is armed and the configured root IS the test root', () => {
		expect(config.media.testRoot).not.toBeNull();
		expect(config.media.rootPath).toBe(config.media.testRoot);
	});

	test('the suite root carries its marker', () => {
		const root = config.media.testRoot as string;
		expect(existsSync(join(root, TEST_MEDIA_MARKER))).toBe(true);
	});

	test('the suite root is NOT the installation media root, and cannot contain it', () => {
		// Asserted on the root THIS PROCESS ACTUALLY USES, not on a re-derivation:
		// `testMediaRootPath()`'s default reads DB_NAME, which the database preload
		// has already repointed by the time a test runs, so it would answer about a
		// different path. The derivation refuses on its own; calling it here is the
		// proof, not a restatement — it reads MEDIA_PATH the way the catalog does.
		const root = config.media.testRoot as string;
		expect(assertDistinctFromInstallMediaRoot(root)).toBe(root);
	});

	test('the path helper agrees with the seam when given the suite database name', () => {
		// The other half of the ordering rule: hand the helper the name explicitly and
		// it lands on exactly the directory the preload chose, from EITHER side of the
		// database repoint. (In this process `DB_NAME` already IS the suite database —
		// that is what `testDatabaseName()` can no longer be asked here, and why the
		// two script setters pass the name they resolved.)
		const suiteDb = process.env.DB_NAME ?? '';
		expect(suiteDb).not.toBe('');
		expect(testMediaRootPath(suiteDb)).toBe(config.media.testRoot as string);
	});

	test('the key is a declared, classified config key (not a stray env read)', () => {
		expect(CONFIG_CATALOG.DEDALO_TEST_MEDIA_ROOT).toBeDefined();
		expect(CONFIG_CATALOG.DEDALO_TEST_MEDIA_ROOT?.scope).toBe('test_seam');
		expect([...NEW_IN_V7]).toContain('DEDALO_TEST_MEDIA_ROOT');
	});
});

// ---------------------------------------------------------------------------
// RULE 5 — exactly three setters, and the preload is wired.
// ---------------------------------------------------------------------------

const SETTERS = [
	'test/preload/test_media.ts',
	'scripts/test_db_setup.ts',
	'scripts/client_test_server.ts',
];

describe('test media root — RULE 5: one setter per tier', () => {
	test('the three tiers set the key, and nothing else does', () => {
		// `scripts/` is scanned RECURSIVELY (the sibling test_db_marker gate's
		// Glob idiom). Until 2026-08-25 this was a flat readdirSync, so a setter
		// hidden under scripts/ci/ or scripts/lib/ would have been INVISIBLE to
		// this census — exactly the "fourth setter" this rule exists to refuse.
		// Verified at the widening: nothing under those subdirectories sets the
		// key today (scripts/lib/parity_census.ts only NAMES it in a string), so
		// the census membership did not change.
		const candidates = [
			...scannedFiles(),
			...[...new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, 'scripts') })].map(
				(n) => `scripts/${n}`,
			),
			...readdirSync(join(REPO_ROOT, 'test/preload'))
				.filter((n) => n.endsWith('.ts'))
				.map((n) => `test/preload/${n}`),
		];
		const setters = candidates.filter((file) =>
			/process\.env\.DEDALO_TEST_MEDIA_ROOT\s*=/.test(stripComments(read(file))),
		);
		expect(setters.sort()).toEqual([...SETTERS].sort());
	});

	test('the preload is registered in bunfig.toml, BEFORE the database repoint', () => {
		const bunfig = read('bunfig.toml');
		const mediaAt = bunfig.indexOf('./test/preload/test_media.ts');
		const dbAt = bunfig.indexOf('./test/preload/test_database.ts');
		const sessionAt = bunfig.indexOf('./test/preload/session_db.ts');
		expect(mediaAt).toBeGreaterThan(-1);
		// ORDER IS LOAD-BEARING: the tree is keyed by the suite database NAME, which
		// the preload derives as `<DB_NAME>_test` — it must read DB_NAME before
		// test_database.ts rewrites it, or the tree lands at `<app>_test_test` and
		// disagrees with the two script setters, which pass the name explicitly.
		expect(mediaAt).toBeLessThan(dbAt);
		expect(mediaAt).toBeLessThan(sessionAt);
	});

	test('test:db:setup SWEEPS the tree (it is rebuildable, not accumulating)', () => {
		expect(stripComments(read('scripts/test_db_setup.ts'))).toContain('rebuildTestMediaRoot(');
	});

	test('the client suite hands the key to the server it spawns', () => {
		const source = stripComments(read('scripts/client_test_server.ts'));
		expect(source).toContain('DEDALO_TEST_MEDIA_ROOT:');
	});
});

// ---------------------------------------------------------------------------
// RULE 6 — DB↔TREE PAIRING: a shard's media tree FOLLOWS its database name.
// ---------------------------------------------------------------------------

/**
 * WHY THIS RULE EXISTS (2026-08-25, the parallel-shard work).
 *
 * A sharded run gives each child process its own database — `<template>__shardN`,
 * a `CREATE DATABASE … TEMPLATE` clone, because the 7612 MB suite fixture cannot
 * be built N times. The database and the media tree are ONE fixture (`files_info`
 * rows in the database name files in the tree, test/helpers/test_media_root.ts),
 * so each shard needs its own tree too — and there are exactly two ways to give
 * it one:
 *
 *   (a) let it FOLLOW the database name through `testMediaRootPath()`, which
 *       keys the tree by the suite database and is already what the `bun test`
 *       preload calls; or
 *   (b) have the shard runner set `DEDALO_TEST_MEDIA_ROOT` itself, beside
 *       `DEDALO_TEST_DATABASE`.
 *
 * (b) IS THE BUG CLASS THIS FILE'S OWN HEADER ALREADY RECORDS. Setting the two
 * halves by hand is how they come to disagree: the measured `<app>_test_test`
 * debris came from exactly that — one side derived the name, the other passed
 * it, and the two landed in different directories with the database rows of one
 * fixture pointing at the files of another. With N shards the same mistake is
 * worse than debris: two shards can be handed the SAME tree while holding
 * DIFFERENT databases, and the corpus media one plants is deleted by the other's
 * sweep mid-assertion, with a failure naming a missing file nowhere near the
 * cause.
 *
 * So the law is (a), and it is stated negatively because that is the half a
 * runner can violate: NO shard-tier file sets `DEDALO_TEST_MEDIA_ROOT`. Rule 5
 * already pins the setter census to three files and would catch a fourth; this
 * rule says WHY the shard tier is not the fourth, and — the part rule 5 cannot
 * express — proves the derivation actually pairs, so "follow the database name"
 * is a mechanism rather than a hope.
 *
 * DERIVED, NOT ENUMERATED, and PRESENCE-GATED the same way rule 7 of
 * test_db_marker_tripwire is: `scripts/lib/test_shard_db.ts` is being written in
 * parallel with this gate. The tier is computed (the provisioner, plus every
 * file under `scripts/` that imports it), so a runner added later is covered the
 * day it lands; the pairing half below is BEHAVIOURAL and binds right now,
 * whether or not the provisioner exists.
 */

/** The shard provisioning path, and the namespace its clones live in. */
const SHARD_PROVISIONER = 'scripts/lib/test_shard_db.ts';
const SHARD_NAME_SHAPE = /__shard\d+$/;

/** Every `.ts` under `scripts/`, repo-relative — the tier can only live here. */
function scriptFiles(): string[] {
	return [...new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, 'scripts') })]
		.filter((name) => !name.endsWith('.test.ts'))
		.map((name) => `scripts/${name}`)
		.sort();
}

/**
 * THE SHARD TIER, derived: the provisioner itself plus every script that imports
 * it. An enumerated list would go stale the first time a runner is added, and a
 * stale list here means an uncovered setter — the exact failure rule 5's census
 * widening (flat readdir → recursive Glob, 2026-08-25) was fixed for.
 */
function shardTierFiles(): string[] {
	if (!existsSync(join(REPO_ROOT, SHARD_PROVISIONER))) return [];
	// Membership is "names the provisioner", comments stripped. Deliberately
	// OVER-inclusive: a script that merely mentions the module in a string joins
	// the tier and is held to the no-setter law it would not otherwise be held
	// to. Over-inclusion costs a false red on a file that must then say why it
	// sets the key; under-inclusion costs an uncovered setter, which is the
	// failure this rule exists for.
	return scriptFiles().filter(
		(file) => file === SHARD_PROVISIONER || stripComments(read(file)).includes('test_shard_db'),
	);
}

/** Does this source SET the media-root key? The same matcher rule 5 censuses with. */
function setsMediaRootKey(source: string): boolean {
	return /process\.env\.DEDALO_TEST_MEDIA_ROOT\s*=/.test(stripComments(source));
}

describe('test media root — RULE 6a: no shard sets DEDALO_TEST_MEDIA_ROOT', () => {
	test('the setter matcher is not vacuous (positive control)', () => {
		expect(setsMediaRootKey('process.env.DEDALO_TEST_MEDIA_ROOT = root;')).toBe(true);
		expect(setsMediaRootKey('process.env.DEDALO_TEST_MEDIA_ROOT=mediaRoot')).toBe(true);
		// …and prose about the key, or merely READING it, is not setting it.
		expect(setsMediaRootKey('// the shard must never set DEDALO_TEST_MEDIA_ROOT = x\n')).toBe(
			false,
		);
		expect(setsMediaRootKey('const root = process.env.DEDALO_TEST_MEDIA_ROOT ?? "";')).toBe(false);
		// The floor for the tier census itself: `scripts/` must be readable and
		// non-trivial, or every assertion below would pass over an empty set.
		expect(scriptFiles().length).toBeGreaterThan(10);
		expect(scriptFiles()).toContain('scripts/test_db_setup.ts');
		expect(scriptFiles()).toContain('scripts/lib/test_flags.ts');
	});

	test('the derived tier is empty (not landed) or contains the provisioner', () => {
		const tier = shardTierFiles();
		if (existsSync(join(REPO_ROOT, SHARD_PROVISIONER))) {
			expect(tier, 'the tier census must find the provisioner it is derived from').toContain(
				SHARD_PROVISIONER,
			);
		} else {
			expect(
				tier,
				`${SHARD_PROVISIONER} is absent, so there is no shard tier yet. This rule binds the day it lands.`,
			).toEqual([]);
		}
	});

	test('no shard-tier file sets the media-root key', () => {
		const offenders = shardTierFiles().filter((file) => setsMediaRootKey(read(file)));
		expect(
			offenders,
			`A shard must let its media tree FOLLOW its database name through testMediaRootPath() — setting DEDALO_TEST_MEDIA_ROOT beside DEDALO_TEST_DATABASE is how the two halves come to disagree (this file's header records the measured '<app>_test_test' debris from exactly that), and with N shards it can hand two shards the SAME tree over two DIFFERENT databases: ${offenders.join(', ')}`,
		).toEqual([]);
	});

	test('the three legitimate setters are not shard-tier files', () => {
		// Rule 5 pins the setter census to three; this states the relationship the
		// shard work must preserve — the tier and the setter set stay DISJOINT.
		const tier = new Set(shardTierFiles());
		const overlap = SETTERS.filter((file) => tier.has(file));
		expect(
			overlap,
			`A shard-tier file became a media-root setter. If a tier really must set the key, that is a change to the pairing law and belongs in rule 6's header, not in the setter list: ${overlap.join(', ')}`,
		).toEqual([]);
	});
});

describe('test media root — RULE 6b: the tree pairs with the database, by derivation', () => {
	/** Four shard names over the database THIS process is actually running on. */
	const templateDb = process.env.DB_NAME ?? '';
	const shardDbs = [1, 2, 3, 4].map((n) => `${templateDb}__shard${n}`);

	test('the probe has a real template name to work from (anti-vacuity)', () => {
		expect(templateDb).not.toBe('');
		for (const shard of shardDbs) expect(SHARD_NAME_SHAPE.test(shard)).toBe(true);
	});

	test("each shard's tree basename IS its database name, and no two collide", () => {
		const paths = shardDbs.map((db) => testMediaRootPath(db));
		for (const [index, path] of paths.entries()) {
			expect(
				path.slice(path.lastIndexOf(sep) + 1),
				'the tree is keyed by the database name — that pairing is the whole mechanism',
			).toBe(shardDbs[index] as string);
		}
		expect(new Set(paths).size, 'two shards must never share a tree').toBe(paths.length);
	});

	test("no shard's tree is the template's, and none contains another", () => {
		const template = testMediaRootPath(templateDb);
		for (const db of shardDbs) {
			const shardRoot = testMediaRootPath(db);
			expect(shardRoot, 'a shard must not sweep or plant in the template tree').not.toBe(template);
			// Containment either way would make one sweep destroy the other.
			expect(shardRoot.startsWith(template + sep)).toBe(false);
			expect(template.startsWith(shardRoot + sep)).toBe(false);
			// And it is still under the suite's own base, i.e. it inherits rule 4's
			// distinctness from the installation's media root.
			expect(assertDistinctFromInstallMediaRoot(shardRoot)).toBe(shardRoot);
		}
	});

	test('the DEFAULT derivation follows DEDALO_TEST_DATABASE — nobody has to set the tree', () => {
		// THE LOAD-BEARING HALF. The `bun test` preload calls ensureTestMediaRoot()
		// with NO argument, so a shard child process gets its tree from
		// testDatabaseName(), where an explicit DEDALO_TEST_DATABASE wins. This
		// proves the shard runner only has to set the DATABASE, which is precisely
		// why rule 6a can forbid it setting the tree.
		//
		// The env is mutated and restored exactly as the sibling marker gate's
		// distinctness probe does it: `test/` is outside the process.env ban (it is
		// where a process environment is composed), and other files in this run
		// derive the suite database from the same variable.
		const saved = process.env.DEDALO_TEST_DATABASE;
		try {
			for (const db of shardDbs) {
				process.env.DEDALO_TEST_DATABASE = db;
				expect(
					testMediaRootPath(),
					`with DEDALO_TEST_DATABASE=${db} the derived tree must be that shard's`,
				).toBe(testMediaRootPath(db));
			}
			// NEGATIVE CONTROL: with the key cleared the derivation must move — a
			// helper that ignored it would have passed every assertion above.
			delete process.env.DEDALO_TEST_DATABASE;
			expect(testMediaRootPath()).not.toBe(testMediaRootPath(shardDbs[0] as string));
		} finally {
			if (saved === undefined) delete process.env.DEDALO_TEST_DATABASE;
			else process.env.DEDALO_TEST_DATABASE = saved;
		}
	});
});

// ---------------------------------------------------------------------------
// RULE 7 — the EXPORT-ARTIFACTS root (2026-09-24, server-built exports).
// ---------------------------------------------------------------------------
//
// tool_export's artifact store is a second FILE-write root: spools, manifests
// and built files, plus `rm -rf` of whole job directories (delete, sweep). It
// has its own marker (`.dedalo_test_export_artifacts`), and under the seam its
// default root is `<test media root>.export_artifacts`, never the install's
// `DEDALO_EXPORT_ARTIFACTS_DIR`. Two ways that could silently stop holding,
// each closed by DERIVATION, not a list someone must remember to extend:
//
//  7a. A second module reads the configured root directly. Under `bun test` it
//      would get the INSTALLATION's `<private>/export_artifacts` (the seam
//      redirects only `defaultExportArtifactsRoot()`), and a sweep from there is
//      an `rm -rf` of real exports. So the key has exactly one reader.
//  7b. A store door forgets `writableRoot(...)`. The mutating doors are derived
//      from the `ArtifactStore` interface itself (every method not classified
//      READ-ONLY below); each is driven against an UNMARKED root holding a
//      victim job and must refuse with `export.store_unavailable`, leaving the
//      tree byte-identical. A new method is unclassified → red. The READ-ONLY
//      ones are driven too and must leave the tree unchanged, so the
//      classification is proved, not trusted.

const EXPORT_STORE_FILE = 'tools/tool_export/server/artifact_store.ts';

/** The ONLY files that may name the configured key (the definition + the store). */
const EXPORT_ROOT_KEY_OWNERS: Record<string, string> = {
	'src/config/config.ts': 'DEFINES the key (readString of DEDALO_EXPORT_ARTIFACTS_DIR).',
	[EXPORT_STORE_FILE]:
		'THE store: resolves the root through defaultExportArtifactsRoot(), which the seam redirects, and every write door asks assertExportArtifactsRoot.',
	'src/config/writable_roots.ts':
		'THE BOOT CHECK of the writable roots (owner C32): reads the configured value as a STRING to judge it against the unit’s ReadWritePaths= manifest (an explicit export dir outside the roots refuses the boot). It opens no store and writes nothing; the seam is irrelevant to a comparison.',
};

describe('test media root — RULE 7a: one reader of the export-artifacts root key', () => {
	const readers = scannedFiles().filter((file) =>
		/\bexportArtifactsDir\b/.test(stripComments(read(file))),
	);

	test('the scan finds the owners (anti-vacuity)', () => {
		for (const owner of Object.keys(EXPORT_ROOT_KEY_OWNERS)) expect(readers).toContain(owner);
	});

	test('nothing else reads the key', () => {
		const strays = readers.filter((file) => EXPORT_ROOT_KEY_OWNERS[file] === undefined);
		expect(
			strays,
			`These files read config.ops.exportArtifactsDir directly. Under bun test that is the INSTALLATION's export tree (only defaultExportArtifactsRoot() follows the seam). Go through openArtifactStore() instead: ${strays.join(', ')}`,
		).toEqual([]);
	});
});

/** `ArtifactStore`'s method names, parsed from the interface body. */
function artifactStoreMethods(): string[] {
	const source = stripComments(read(EXPORT_STORE_FILE));
	const body = /export interface ArtifactStore \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
	return [...body.matchAll(/^\s*(\w+)\s*\(/gm)].map((match) => match[1] as string).sort();
}

/**
 * Methods that write NOTHING (reads, pure refs, path allocation). Each reason is
 * what the method DOES; each is still driven below and must leave the tree as
 * it was.
 */
const STORE_READ_ONLY: Record<string, string> = {
	jobRef: 'Validates ids and composes a path; no IO at all.',
	readManifest: 'Reads manifest.json + request.json and joins them; creates and deletes nothing.',
	readJobState: 'Reads manifest.json (the mutable state half) only; writes nothing.',
	listJobStates: 'Reads the user directory and each manifest.json; writes nothing.',
	listJobs: 'Reads the user directory and its manifests; writes nothing.',
	usedBytes: 'Sums file sizes under the user directory (lstat only).',
	assertQuota: 'usedBytes() compared with the budget; throws or answers, writes nothing.',
	resolveArtifactFile: 'Answers a confined path or null (lstat/realpath only).',
	allocateFile: 'Composes the final + temp PATHS for a format; opens no file.',
};

type StoreModule = typeof import('../../tools/tool_export/server/artifact_store.ts');
type Store = ReturnType<StoreModule['openArtifactStore']>;

/** Snapshot of a tree: relative path → content (dirs as '<dir>'). */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const rel = relative(root, full);
			if (statSync(full).isDirectory()) {
				out[rel] = '<dir>';
				walk(full);
			} else out[rel] = readFileSync(full, 'utf8');
		}
	};
	walk(root);
	return out;
}

const VICTIM_USER = 7;
const VICTIM_JOB = 'exp_zzvictim_0123456789ab';

/** Drivers of the MUTATING doors: each must hit the door's first write. */
const STORE_WRITE_DRIVERS: Record<string, (store: Store, mod: StoreModule) => Promise<unknown>> = {
	createJob: (store) =>
		store.createJob({
			userId: VICTIM_USER,
			sectionTipo: 'test3',
			sections: ['test3'],
			options: {},
			recordScope: 'tripwire',
			applicationLang: 'lg-eng',
		}),
	writeManifest: (store) =>
		store.writeManifest(store.jobRef(VICTIM_USER, VICTIM_JOB), { status: 'ended' } as never),
	updateManifest: (store) =>
		store.updateManifest(store.jobRef(VICTIM_USER, VICTIM_JOB), { status: 'failed' } as never),
	deleteJob: (store) => store.deleteJob(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	deleteIdleJob: (store) => store.deleteIdleJob(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	deleteSpool: (store) => store.deleteSpool(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	openSpoolWriter: (store) => store.openSpoolWriter(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	openFileSink: (store) => {
		const job = store.jobRef(VICTIM_USER, VICTIM_JOB);
		return store.openFileSink(job, store.allocateFile(job, 'csv'));
	},
	linkSpoolAsFile: (store) => {
		const job = store.jobRef(VICTIM_USER, VICTIM_JOB);
		return store.linkSpoolAsFile(job, store.allocateFile(job, 'ndjson'), {
			source: 'grid.ndjson',
			rows: 1,
		});
	},
	// far future: every job is past its TTL, so a sweep that ran would delete it
	sweep: (store) => store.sweep({ now: Date.now() + 365 * 24 * 3600 * 1000 }),
};

const STORE_READ_DRIVERS: Record<string, (store: Store) => unknown> = {
	jobRef: (store) => store.jobRef(VICTIM_USER, VICTIM_JOB),
	readManifest: (store) => store.readManifest(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	readJobState: (store) => store.readJobState(store.jobRef(VICTIM_USER, VICTIM_JOB)),
	listJobStates: (store) => store.listJobStates(VICTIM_USER),
	listJobs: (store) => store.listJobs(VICTIM_USER),
	usedBytes: (store) => store.usedBytes(VICTIM_USER),
	assertQuota: (store) => store.assertQuota(VICTIM_USER, 1),
	resolveArtifactFile: (store) => store.resolveArtifactFile(VICTIM_USER, VICTIM_JOB, 'export.csv'),
	allocateFile: (store) => store.allocateFile(store.jobRef(VICTIM_USER, VICTIM_JOB), 'csv'),
};

/** An UNMARKED root holding one complete victim job (spool + manifest + a built file). */
function victimRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_unmarked_export_'));
	const jobDir = join(root, String(VICTIM_USER), VICTIM_JOB);
	mkdirSync(jobDir, { recursive: true });
	for (const [name, body] of Object.entries({
		'grid.ndjson': '{"t":"meta"}\n',
		'cols.ndjson': '',
		'grid.idx': '',
		'export.csv': 'a,b\n',
		// the immutable request half (SPOOL_FILES.request): readManifest joins it with the state
		'request.json': JSON.stringify({
			v: 1,
			user_id: VICTIM_USER,
			job_id: VICTIM_JOB,
			options: {},
			sections: ['test3'],
		}),
		'manifest.json': JSON.stringify({
			user_id: VICTIM_USER,
			job_id: VICTIM_JOB,
			status: 'ended',
			created_at: '2000-01-01T00:00:00.000Z',
			updated_at: '2000-01-01T00:00:00.000Z',
			ended_at: '2000-01-01T00:00:00.000Z',
			files: [],
		}),
	})) {
		writeFileSync(join(jobDir, name), body);
	}
	return root;
}

describe('test media root — RULE 7b: every mutating ArtifactStore door refuses an unmarked root', () => {
	const methods = artifactStoreMethods();

	test('the interface parse is not vacuous', () => {
		expect(methods.length).toBeGreaterThan(10);
		for (const known of ['createJob', 'sweep', 'readManifest']) expect(methods).toContain(known);
	});

	test('every method is classified exactly once (a new door must be driven)', () => {
		const classified = [...Object.keys(STORE_WRITE_DRIVERS), ...Object.keys(STORE_READ_ONLY)];
		expect(
			[...classified].sort(),
			'ArtifactStore gained or lost a method. A door that can create, write or delete gets a STORE_WRITE_DRIVERS entry; one that provably writes nothing gets a STORE_READ_ONLY reason (+ a STORE_READ_DRIVERS entry)',
		).toEqual(methods);
		expect(Object.keys(STORE_READ_DRIVERS).sort()).toEqual(Object.keys(STORE_READ_ONLY).sort());
		for (const [method, reason] of Object.entries(STORE_READ_ONLY)) {
			expect(reason.length, `${method}: a read-only reason says what it does`).toBeGreaterThan(20);
		}
	});

	test('the victim fixture is readable (the drivers reach real state)', async () => {
		const mod = await import('../../tools/tool_export/server/artifact_store.ts');
		expect(mod.exportArtifactsGuardArmed()).toBe(true);
		const root = victimRoot();
		try {
			const store = mod.openArtifactStore({ root, quotaBytes: 0 });
			const manifest = await store.readManifest(store.jobRef(VICTIM_USER, VICTIM_JOB));
			expect(manifest.status).toBe('ended');
			expect(await store.usedBytes(VICTIM_USER)).toBeGreaterThan(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const method of Object.keys(STORE_WRITE_DRIVERS)) {
		test(`${method} refuses with export.store_unavailable and leaves the tree untouched`, async () => {
			const mod = await import('../../tools/tool_export/server/artifact_store.ts');
			const root = victimRoot();
			try {
				const before = snapshot(root);
				const store = mod.openArtifactStore({ root, quotaBytes: 0, ttlHours: 1 });
				let caught: unknown = null;
				try {
					const opened = await (
						STORE_WRITE_DRIVERS[method] as (s: Store, m: StoreModule) => Promise<unknown>
					)(store, mod);
					// a door that wrongly OPENED something is closed before the assertion
					const handle = opened as { abort?: () => Promise<void> } | null;
					await handle?.abort?.();
				} catch (error) {
					caught = error;
				}
				expect((caught as { code?: string } | null)?.code, `${method} did not refuse`).toBe(
					'export.store_unavailable',
				);
				expect(String((caught as Error).message)).toContain(`ArtifactStore.${method}`);
				expect(String((caught as Error).message)).toContain('NOTHING WAS WRITTEN');
				expect(snapshot(root)).toEqual(before);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	for (const method of Object.keys(STORE_READ_DRIVERS)) {
		test(`read-only ${method} leaves an unmarked tree untouched`, async () => {
			const mod = await import('../../tools/tool_export/server/artifact_store.ts');
			const root = victimRoot();
			try {
				const before = snapshot(root);
				const store = mod.openArtifactStore({ root, quotaBytes: 0 });
				try {
					await (STORE_READ_DRIVERS[method] as (s: Store) => unknown)(store);
				} catch {
					// a read may refuse (e.g. quota); what matters is that it wrote nothing
				}
				expect(snapshot(root)).toEqual(before);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});

// ---------------------------------------------------------------------------
// RULE 8 — the JOB-REGISTRY (processes) directory (2026-09-24).
// ---------------------------------------------------------------------------
//
// src/core/media/jobs.ts mirrors every background job as a pfile. Its default
// was the INSTALLATION's `<privateDir>/processes`, and nothing moved it for a
// test run: ~5.4k suite pfiles were measured there (client-suite server, gates
// without an override). Under the seam the default now derives to the marked
// sibling `<test media root>.processes`; an explicit DEDALO_MEDIA_PROCESSES_DIR
// still wins, and either must carry `.dedalo_test_processes` or the job manager
// refuses before it creates, reads or writes. Driven through the REAL job
// manager — the outcome (where the file lands), not a spelling.

const PROCESSES_KEY = 'DEDALO_MEDIA_PROCESSES_DIR';

/** Run `body` with the explicit processes key set (or unset), restored after. */
async function withProcessesKey<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
	const previous = process.env[PROCESSES_KEY];
	if (value === undefined) Reflect.deleteProperty(process.env, PROCESSES_KEY);
	else process.env[PROCESSES_KEY] = value;
	try {
		return await body();
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, PROCESSES_KEY);
		else process.env[PROCESSES_KEY] = previous;
	}
}

/** Submit one trivial job on a fresh manager and wait for its terminal state. */
async function runProbeJob(): Promise<string> {
	const { MediaJobManager } = await import('../../src/core/media/jobs.ts');
	const manager = new MediaJobManager({});
	let settle: () => void = () => {};
	const settled = new Promise<void>((resolve) => {
		settle = resolve;
	});
	const record = manager.submit('tripwire_processes_probe', async () => 'ok', {
		lane: 'maintenance',
		onTerminal: () => settle(),
	});
	await settled;
	return record.id;
}

describe('test media root — RULE 8: the job registry never lands in the installation', () => {
	test('one marker, two spellings (the config-free helper copy equals the canonical one)', async () => {
		const src = await import('../../src/core/media/test_media_root.ts');
		const helper = await import('../helpers/test_media_root.ts');
		expect(helper.TEST_PROCESSES_MARKER).toBe(src.TEST_PROCESSES_MARKER);
		expect(src.TEST_PROCESSES_MARKER).toBe('.dedalo_test_processes');
		const testRoot = config.media.testRoot as string;
		expect(helper.testProcessesDirPath(testRoot)).toBe(src.testProcessesDirFor(testRoot));
	});

	test('armed, no explicit key: the pfile lands in the MARKED suite sibling, never <privateDir>/processes', async () => {
		const { privateDir } = await import('../../src/config/env.ts');
		const { jobFilePath } = await import('../../src/core/media/jobs.ts');
		const { testProcessesDirFor, TEST_PROCESSES_MARKER } = await import(
			'../../src/core/media/test_media_root.ts'
		);
		const suiteDir = testProcessesDirFor(config.media.testRoot as string);
		const installFile = (id: string): string => join(privateDir, 'processes', `${id}.json`);
		await withProcessesKey(undefined, async () => {
			const id = await runProbeJob();
			const landed = jobFilePath(id);
			try {
				expect(landed).toBe(join(suiteDir, `${id}.json`));
				expect(existsSync(landed), 'the job file was written').toBe(true);
				expect(existsSync(join(suiteDir, TEST_PROCESSES_MARKER))).toBe(true);
				expect(
					existsSync(installFile(id)),
					"an armed run wrote a job file into the INSTALLATION's processes tree",
				).toBe(false);
			} finally {
				// ONLY this probe's own file, wherever a regression put it
				rmSync(landed, { force: true });
				rmSync(installFile(id), { force: true });
			}
		});
	});

	test('armed, explicit UNMARKED dir: submit refuses loudly and creates nothing', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'dedalo_unmarked_processes_'));
		const target = join(scratch, 'processes');
		try {
			await withProcessesKey(target, async () => {
				let caught: unknown = null;
				try {
					await runProbeJob();
				} catch (error) {
					caught = error;
				}
				expect((caught as { code?: string } | null)?.code, 'submit did not refuse').toBe(
					'media.invalid_path',
				);
				expect(String((caught as Error).message)).toContain('NOTHING WAS WRITTEN');
				expect(String((caught as Error).message)).toContain('media jobs processesDir');
				expect(existsSync(target), 'the refusal created the directory').toBe(false);
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('armed, explicit UNMARKED dir: the refused submit is ATOMIC — no phantom live job holds its target', async () => {
		// A refusal raised AFTER registration left a 'queued' record with no worker:
		// hasLiveJobForTarget true forever, so every later build of that target was
		// refused as a duplicate. The outcome, on the real manager.
		const { MediaJobManager } = await import('../../src/core/media/jobs.ts');
		const manager = new MediaJobManager({});
		const kind = 'tripwire_processes_atomic';
		const target = {
			section_tipo: 'test3',
			section_id: 1,
			component_tipo: 'test99',
			lang: null,
			quality: 'original',
		};
		let terminalCalls = 0;
		const scratch = mkdtempSync(join(tmpdir(), 'dedalo_unmarked_processes_atomic_'));
		try {
			await withProcessesKey(join(scratch, 'processes'), async () => {
				expect(() =>
					manager.submit(kind, async () => 'ok', {
						lane: 'maintenance',
						target,
						onTerminal: () => {
							terminalCalls += 1;
						},
					}),
				).toThrow(/NOTHING WAS WRITTEN/);
				expect(
					manager.hasLiveJobForTarget(target),
					'the refused submit left a phantom live job on its target',
				).toBe(false);
				// nextId is kind_pid_counter; a fresh manager's first id
				expect(manager.stop(`${kind}_${process.pid}_1`), 'a controller survived').toBe(false);
			});
			// back on the suite's marked dir: the registry has no record either
			expect(manager.status(`${kind}_${process.pid}_1`)).toBeNull();
			expect(terminalCalls, 'onTerminal fired for a job that never existed').toBe(0);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('the runtime-path census and the job manager resolve the SAME processes dir', async () => {
		const { RUNTIME_PATH_CENSUS } = await import('../../src/core/install/runtime_paths.ts');
		const { jobFilePath } = await import('../../src/core/media/jobs.ts');
		const { markProcessesDir } = await import('../helpers/test_media_root.ts');
		const entry = RUNTIME_PATH_CENSUS.find((candidate) => candidate.id === 'media_processes_dir');
		expect(entry, 'census entry media_processes_dir').toBeDefined();
		const censusDir = (): string | null => entry?.resolve() ?? null;
		const jobsDir = (): string => dirname(jobFilePath('probe'));
		// seam armed, no explicit key (and empty = unset, the readers' rule)
		for (const unset of [undefined, '']) {
			await withProcessesKey(unset, async () => {
				expect(censusDir()).toBe(jobsDir());
				expect(censusDir()).toBe(
					(await import('../../src/core/media/test_media_root.ts')).testProcessesDirFor(
						config.media.testRoot as string,
					),
				);
			});
		}
		// explicit key (marked, so the armed door lets the job manager answer)
		const scratch = markProcessesDir(mkdtempSync(join(tmpdir(), 'dedalo_census_processes_')));
		try {
			await withProcessesKey(scratch, async () => {
				expect(censusDir()).toBe(scratch);
				expect(jobsDir()).toBe(scratch);
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		// no seam (census half: it reads env per call; the job manager's frozen
		// config cannot be disarmed in-process, hence the pure checks below)
		const { privateDir } = await import('../../src/config/env.ts');
		const seamKey = 'DEDALO_TEST_MEDIA_ROOT';
		const armed = process.env[seamKey];
		await withProcessesKey(undefined, async () => {
			Reflect.deleteProperty(process.env, seamKey);
			try {
				expect(censusDir()).toBe(join(privateDir, 'processes'));
			} finally {
				if (armed !== undefined) process.env[seamKey] = armed;
			}
		});
		// the pure derivation both call
		const { deriveProcessesDir } = await import('../../src/core/media/processes_dir.ts');
		expect(deriveProcessesDir(undefined, null, '/install/processes')).toBe('/install/processes');
		expect(deriveProcessesDir('', null, '/install/processes')).toBe('/install/processes');
		expect(deriveProcessesDir('/x', '/root', '/install/processes')).toBe('/x');
	});

	test('armed, explicit MARKED dir: the explicit key wins and the pfile lands there', async () => {
		const { markProcessesDir } = await import('../helpers/test_media_root.ts');
		const scratch = markProcessesDir(mkdtempSync(join(tmpdir(), 'dedalo_marked_processes_')));
		try {
			await withProcessesKey(scratch, async () => {
				const id = await runProbeJob();
				expect(existsSync(join(scratch, `${id}.json`))).toBe(true);
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('test:db:setup sweeps a MARKED suite dir and refuses an unmarked one at that path', async () => {
		const {
			rebuildTestProcessesDir,
			testProcessesDirPath,
			TEST_PROCESSES_MARKER: MARKER,
		} = await import('../helpers/test_media_root.ts');
		const base = mkdtempSync(join(tmpdir(), 'dedalo_processes_rebuild_'));
		const mediaRoot = join(base, 'suite_db');
		const dir = testProcessesDirPath(mediaRoot);
		try {
			expect(rebuildTestProcessesDir(mediaRoot)).toBe(dir);
			writeFileSync(join(dir, 'stale_job.json'), '{}');
			rebuildTestProcessesDir(mediaRoot);
			expect(existsSync(join(dir, 'stale_job.json')), 'the sweep kept a stale pfile').toBe(false);
			expect(existsSync(join(dir, MARKER))).toBe(true);
			rmSync(join(dir, MARKER));
			writeFileSync(join(dir, 'not_ours.json'), '{}');
			expect(() => rebuildTestProcessesDir(mediaRoot)).toThrow(/NOTHING WAS DELETED/);
			expect(existsSync(join(dir, 'not_ours.json'))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test('the key has exactly its known readers (a second resolver would skip the seam)', () => {
		const owners: Record<string, string> = {
			'src/core/media/jobs.ts':
				'THE resolver: processesDir() → resolveProcessesDir + assertProcessesDirDeclared.',
			'src/core/install/runtime_paths.ts':
				'The runtime-path census: a pure question, mirrors the derivation, writes nothing.',
			'src/config/catalog/media.ts': 'DEFINES the key.',
			'src/config/migration_map.ts': 'Lists the key as new in v7.',
		};
		const readers = scannedFiles().filter((file) =>
			stripComments(read(file)).includes(PROCESSES_KEY),
		);
		for (const owner of Object.keys(owners)) expect(readers).toContain(owner);
		expect(
			readers.filter((file) => owners[file] === undefined),
			'A new file names DEDALO_MEDIA_PROCESSES_DIR. Resolve the job-registry directory through src/core/media/jobs.ts (jobFilePath), whose resolver follows the test seam.',
		).toEqual([]);
	});
});
