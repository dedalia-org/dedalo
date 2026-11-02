/**
 * TEST-FILE FOOTPRINT — what a test file can TOUCH, derived from its source,
 * never from a hand list.
 *
 * WHY THIS EXISTS. The Phase 3 shard runner (scripts/test_shard.ts) runs test
 * files in N concurrent `bun test` child processes, each on its own cloned
 * database. Before it may do that it has to know, per file, which shared
 * surfaces the file reaches: a file that spawns its own subprocess, a file that
 * writes the suite media tree, a file whose imports the scanner cannot even
 * resolve. Guessing is how the 2026-08-19 era ended (a gate deleted a real
 * ontology node, test218, out of a live install because nobody had derived what
 * it touched), so the classification is DERIVED: walk the transitive import
 * graph with the EXISTING `extractImportSpecifiers` from
 * `test/helpers/no_write_scan.ts` — the one extractor that already covers
 * dynamic `import()`, the exact hole that once let a full matrix write past a
 * no-write gate; this module deliberately does NOT grow a second extractor —
 * then literal-scan every reached file for the surface signals below.
 *
 * THE BANDS (bandOf):
 *   A — pure/static: no DB, no filesystem/process effects seen. Safe anywhere.
 *   B — filesystem / scratch-media / process effects, but DB-free.
 *   C — DB-touching: the corpus doors, zz* scratch TLDs, the canonical test3
 *       records, the diffusion table seams, the SHARED suite media root (which
 *       is keyed by the database name and therefore moves WITH the database),
 *       a reachable pool — or anything the scanner could not resolve.
 *
 * FAIL-CLOSED, LOUDLY. An import specifier that does not resolve to a file on
 * disk lands the whole file in band C AND pins it, with the offending
 * `from -> specifier` edge recorded in `unresolvedImports` so the refusal can
 * name it. Guessing narrower would be silently narrowing scope (hard rule).
 *
 * PINNED IS STRONGER THAN BAND C. Any file whose test-side source matches
 * `Bun.spawn` / `process.execPath` is PINNED regardless of its DB
 * classification: a spawned child reaches Postgres with whatever env it
 * inherits and evades every in-process role guard, so in an UNSEALED plan
 * (`--shard=M/N`) such a file runs only in the BASE bin — the one whose
 * environment is byte-identical to today's serial run. A multi-bin run is
 * SEALED instead (scripts/test_shard.ts header): every bin on a clone, the
 * template closed to connections, so an escaping child fails loudly and the
 * pin is not applied. The spawn scan covers the test file and its `test/`
 * import closure, not `src/`: an engine spawn site executes INSIDE the child's
 * fully-composed environment, while a test-authored spawn is the test choosing
 * its own env — the hazard being censused.
 *
 * MEDIA IS TWO DIFFERENT SURFACES, ON PURPOSE. Reaching
 * `test/helpers/media_scratch_root.ts` means per-call `mkdtemp` roots that two
 * processes can never collide on (band B). Reaching `src/core/media/**`,
 * `test/helpers/test_media_root.ts` or the `DEDALO_TEST_MEDIA_ROOT` seam means
 * the SHARED suite media tree — one fixture with the suite database
 * (`files_info` rows name files in it), so it classifies with the database
 * (band C) and follows a shard's database automatically
 * (`testMediaRootPath()` derives the tree from the database name).
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It reads SOURCE, not runtime behaviour. A surface reached through an
 *    argv-assembled spawn of an arbitrary script, or a tipo assembled from
 *    fragments, is invisible to the literal scans; the unresolved-import rule
 *    catches only the IMPORT-shaped half of that hole.
 *  - Band A means "no effect signal SEEN", not "provably pure". The fs/process
 *    literal scan covers test-side files only (see above), so a test that
 *    reaches the filesystem exclusively through a `src/` module it imports can
 *    classify A. That is acceptable for the consumer this exists for — the
 *    shard runner gives EVERY bin a full database and media tree, so an
 *    under-banded file is mis-labelled, not mis-scheduled.
 *  - Co-location constraints (which files must share ONE bin) are NOT here:
 *    that is `scripts/lib/test_components.ts`'s union-find census, and the
 *    partitioner consumes both.
 *
 * HERMETIC: filesystem reads of tracked source. No DB, no network.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { extractImportSpecifiers } from './no_write_scan.ts';
import { stripComments } from './strip_comments.ts';

/** Repo root — this file lives at test/helpers/. */
const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The one pool. Reaching it transitively is the DB signal. */
const POOL_MODULE = 'src/core/db/postgres.ts';
/** The scratch-media helper — per-call mkdtemp roots, collision-free (band B). */
const SCRATCH_MEDIA_HELPER = 'test/helpers/media_scratch_root.ts';
/** The SHARED suite media tree's derivation module (band C — moves with the DB). */
const SUITE_MEDIA_HELPER = 'test/helpers/test_media_root.ts';

/**
 * Same TLD grammar as scripts/lib/test_components.ts's census: a quote
 * IMMEDIATELY before the zz head, so identifiers and prose never count.
 */
const ZZ_LITERAL = /['"`](zz[a-z]*)(?=[0-9'"`]|\$\{)/g;
/** The corpus doors — delete-then-insert / assert-residue-0, both destructive. */
const CORPUS_DOOR = /\b(?:ensureTestCorpus|dropTestCorpus)\s*\(/;
/** The canonical test3 rewriters (both spellings — the wrapper restores too). */
const CANONICAL_TEST3 = /\b(?:ensureCanonicalTest3|restoreCanonicalTest3)\b/;
/** The diffusion table seams (env keys and the constants that read them). */
const DIFFUSION_TABLE = /\bDIFFUSION_(?:JOBS|ACTIVITY)_TABLE\b/;
/** A test-authored subprocess — evades in-process guards; PINS the file. */
const SPAWN = /\bBun\.spawn(?:Sync)?\b|\bprocess\.execPath\b/;
/** A raw ad-hoc connection (the preload-probe idiom) — DB without the pool. */
const RAW_SQL = /\bnew SQL\s*\(/;
/** The shared-media seam named directly (scripts compose it; tests may read it). */
const MEDIA_SEAM = /\bDEDALO_TEST_MEDIA_ROOT\b/;
/** Filesystem / process effects in TEST-side source (band B floor). */
const FS_OR_PROCESS = /\bnode:fs\b|\bnode:child_process\b|\bmkdtemp|\bmkdirSync\b|\brmSync\b/;

export type FootprintBand = 'A' | 'B' | 'C';

export interface TestFootprint {
	/** Repo-relative test file this footprint describes. */
	file: string;
	/** Every repo-relative `.ts` file the import graph reaches (file included). */
	closure: string[];
	/** `from -> specifier` edges the resolver could not land on a file. */
	unresolvedImports: string[];
	/** Distinct zz* TLD heads carried anywhere in the closure. */
	zzTlds: string[];
	/** Calls a corpus door (`ensureTestCorpus` / `dropTestCorpus`). */
	corpusCaller: boolean;
	/** Rewrites the canonical test3 records (1/2/27). */
	canonicalTest3: boolean;
	/** Names a diffusion table seam. */
	diffusionTables: boolean;
	/** Reaches the pool (or a raw `new SQL(` probe). */
	dbTouching: boolean;
	/** Reaches the SHARED suite media root (src/core/media/**, the seam, or its helper). */
	sharedMediaRoot: boolean;
	/** Reaches only per-call scratch media roots. */
	scratchMedia: boolean;
	/** Test-side filesystem / process effect literals. */
	fsOrProcess: boolean;
	/** Test-side `Bun.spawn` / `process.execPath` — see the header. */
	spawnsProcesses: boolean;
	/** spawn or unresolved: may run ONLY in the base (serial-identical) bin. */
	pinned: boolean;
}

function toRepoRelative(path: string): string {
	const absolute = resolve(REPO_ROOT, path);
	return relative(REPO_ROOT, absolute);
}

/**
 * Resolve one relative specifier the way Bun does for this repo's idioms:
 * exact path (imports here spell `.ts` out), then the extension/index
 * fallbacks. `null` = does not land on a file — the caller records it as
 * unresolved and fail-closes.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
	const base = resolve(REPO_ROOT, dirname(fromFile), specifier);
	const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if (statSync(candidate).isDirectory()) continue;
		return relative(REPO_ROOT, candidate);
	}
	return null;
}

/** Only TypeScript is walked and scanned; other resolvable leaves (json, css…) carry no code. */
function isScannable(file: string): boolean {
	return file.endsWith('.ts') || file.endsWith('.tsx');
}

function isTestSide(file: string): boolean {
	return file.startsWith('test/');
}

/** One file's own signals + resolved edges — cached, because 783 test files share most of their closures. */
interface FileScan {
	zzTlds: string[];
	corpusCaller: boolean;
	canonicalTest3: boolean;
	diffusionTables: boolean;
	rawSql: boolean;
	mediaSeam: boolean;
	fsOrProcess: boolean;
	spawnsProcesses: boolean;
	imports: string[];
	unresolved: string[];
}

const scanCache = new Map<string, FileScan>();

function scanFile(file: string): FileScan {
	const cached = scanCache.get(file);
	if (cached !== undefined) return cached;
	const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
	const testSide = isTestSide(file);
	const imports: string[] = [];
	const unresolved: string[] = [];
	for (const specifier of extractImportSpecifiers(source)) {
		if (!specifier.startsWith('.')) continue; // bare/builtin — not repo source
		const resolved = resolveSpecifier(file, specifier);
		if (resolved === null) {
			unresolved.push(`${file} -> ${specifier}`);
			continue;
		}
		if (isScannable(resolved)) imports.push(resolved);
	}
	const scan: FileScan = {
		zzTlds: [...new Set([...source.matchAll(ZZ_LITERAL)].map((m) => m[1] as string))],
		corpusCaller: CORPUS_DOOR.test(source),
		canonicalTest3: CANONICAL_TEST3.test(source),
		diffusionTables: DIFFUSION_TABLE.test(source),
		rawSql: RAW_SQL.test(source),
		// Test-side only — see the header for why engine spawn sites and engine
		// fs use are not what this census convicts.
		mediaSeam: testSide && MEDIA_SEAM.test(source),
		fsOrProcess: testSide && FS_OR_PROCESS.test(source),
		spawnsProcesses: testSide && SPAWN.test(source),
		imports,
		unresolved,
	};
	scanCache.set(file, scan);
	return scan;
}

/**
 * Classify one test file. `path` may be absolute or repo-relative. Throws when
 * the file itself does not exist — a partitioner fed a phantom file must stop,
 * not schedule it.
 */
export function classifyTestFile(path: string): TestFootprint {
	const file = toRepoRelative(path);
	const absolute = join(REPO_ROOT, file);
	if (!existsSync(absolute)) {
		throw new Error(`test_footprint: '${file}' does not exist — refusing to classify a phantom`);
	}

	const closure: string[] = [];
	const unresolvedImports: string[] = [];
	const seen = new Set<string>([file]);
	const queue = [file];
	const zzTlds = new Set<string>();
	let corpusCaller = false;
	let canonicalTest3 = false;
	let diffusionTables = false;
	let rawSql = false;
	let mediaSeam = false;
	let fsOrProcess = false;
	let spawnsProcesses = false;

	while (queue.length > 0) {
		const current = queue.shift() as string;
		closure.push(current);
		const scan = scanFile(current);

		for (const tld of scan.zzTlds) zzTlds.add(tld);
		corpusCaller ||= scan.corpusCaller;
		canonicalTest3 ||= scan.canonicalTest3;
		diffusionTables ||= scan.diffusionTables;
		rawSql ||= scan.rawSql;
		mediaSeam ||= scan.mediaSeam;
		fsOrProcess ||= scan.fsOrProcess;
		spawnsProcesses ||= scan.spawnsProcesses;
		unresolvedImports.push(...scan.unresolved);

		for (const resolved of scan.imports) {
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			queue.push(resolved);
		}
	}

	closure.sort();
	const dbTouching = closure.includes(POOL_MODULE) || rawSql;
	const sharedMediaRoot =
		mediaSeam ||
		closure.includes(SUITE_MEDIA_HELPER) ||
		closure.some((f) => f.startsWith('src/core/media/'));
	const scratchMedia = closure.includes(SCRATCH_MEDIA_HELPER);

	return {
		file,
		closure,
		unresolvedImports: [...new Set(unresolvedImports)].sort(),
		zzTlds: [...zzTlds].sort(),
		corpusCaller,
		canonicalTest3,
		diffusionTables,
		dbTouching,
		sharedMediaRoot,
		scratchMedia,
		fsOrProcess,
		spawnsProcesses,
		pinned: spawnsProcesses || unresolvedImports.length > 0,
	};
}

/**
 * The band, from the footprint alone (pure — a gate can feed it synthetic
 * footprints as positive controls). Unresolvable ⇒ the MOST-CONSTRAINED band,
 * per the fail-closed rule in the header.
 */
export function bandOf(footprint: TestFootprint): FootprintBand {
	if (
		footprint.unresolvedImports.length > 0 ||
		footprint.dbTouching ||
		footprint.corpusCaller ||
		footprint.canonicalTest3 ||
		footprint.diffusionTables ||
		footprint.sharedMediaRoot ||
		footprint.zzTlds.length > 0
	) {
		return 'C';
	}
	if (footprint.spawnsProcesses || footprint.scratchMedia || footprint.fsOrProcess) return 'B';
	return 'A';
}
