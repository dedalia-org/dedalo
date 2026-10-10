/**
 * HIERARCHY FIXTURE ALLOWLIST — which vendored `<tld>1.copy.gz` hierarchies the
 * SUITE DATABASE actually needs, DERIVED BY SCANNING THE TEST TREE, never a
 * hand list.
 *
 * WHY THIS EXISTS (measured 2026-08-25). The suite database was 7612 MB, and
 * 97.6% of it was ONE KIND of data nobody asked for: `scripts/test_db_setup.ts`
 * globbed EVERY `*1.copy.gz` in install/import/hierarchy/ — 150 country
 * hierarchies, 127 MB gzipped — and the triggers on matrix_hierarchy then
 * derived 13.9M matrix_relation_index rows (1368 MB) and 5.6M
 * matrix_string_search rows (691 MB) on top of 2,267,790 geo hierarchy rows
 * (5370 MB). Meanwhile the tests only ever NAME a handful of those TLDs, and
 * most references are NAME-ONLY string work (safeExportTipo('es1')); exactly one gate declares itself volume-bound
 * (test/unit/search_late_row_lookup.test.ts — es1, "thousands of records").
 * Installing 136 hierarchies no test can name is not coverage, it is a
 * ~7.4 GiB tax on every rebuild of a disposable fixture.
 *
 * THE DERIVATION, not a hand list:
 *  - CANDIDATES are the vendored files themselves (`vendoredHierarchyTlds`):
 *    every `<tld>1.copy.gz` under install/import/hierarchy/. The files STAY in
 *    the repo regardless of this allowlist — deleting them would make a full
 *    install impossible; this module only decides what the SUITE database
 *    installs.
 *  - REFERENCES are found by scanning test/ and src/core/test_data/ (the
 *    situations the suite materializes) for tipo-shaped tokens:
 *      · in .ts files: the hierarchy SECTION tipo itself, `<tld>1` with a
 *        word boundary before and no digit after. Comments COUNT — a comment
 *        recording that an observer's targets are "the country hierarchies
 *        (ad1, al1, …, af1)" is a measured fact about the suite ontology, and
 *        over-inclusion is the safe direction. Requiring the literal `<tld>1`
 *        (not `<tld><digits>`) is what keeps `be32(...)`, `md5`, `pg15` and
 *        `id1`-style identifiers out of the census without a hand blocklist.
 *      · in .json files (fixture manifests, corpus records, the test-TLD
 *        clone maps): ANY quoted tipo in the TLD, `"<tld><digits>"` — JSON
 *        carries no code identifiers, so the looser grammar is safe there and
 *        catches foreign refs like "it3"/"ma5" that never spell `<tld>1`.
 *  - test/parity/fixtures/ is EXCLUDED, deliberately: the frozen oracle store
 *    is opaque harvested payload in which two-letter+digit sequences occur by
 *    accident, and scanning it marks EVERY candidate referenced — i.e. it
 *    reproduces the glob and makes the allowlist vacuous. Parity REQUESTS are
 *    built in the .ts gate files, which ARE scanned.
 *  - A TLD with any hit in either grammar STAYS. Uncertainty resolves toward
 *    keeping: never drop a hierarchy to hit a size target.
 *
 * MEASURED at the derivation's seed (2026-08-25): 14 of 150 TLDs referenced
 * (ad af al cl cu dz ee es fr it lg ma pt tn), 15.0 MB of the 127 MB (11.8%).
 * Same day, after the NAME_ONLY exclusions and the synthetic-fixture landing:
 * `ee it ma pt tn` out (justified by nothing but mapping keys / a refusal
 * ledger / CSS colour literals), and the record VOLUME the imports carried is
 * being replaced by the GENERATED `test*` hierarchies
 * (src/core/test_data/synthetic_hierarchy_fixture.ts, ~1,310 rows) — the
 * remaining geo imports (es fr cl cu ad af al dz) drain out of this derivation
 * as their consumer gates migrate onto the synthetic corpus and their
 * comments are scrubbed. `lg` (the engine-hardwired languages thesaurus:
 * select_lang's `lg1`, import_csv's pinned id 17344) is NOT a candidate since
 * 2026-10-08: it is a CORE hierarchy, activated against the terms the seed ships
 * in matrix_langs and never imported (src/core/install/hierarchy_meta.ts), so it
 * has no vendored file and can never appear in `imports`.
 *
 * CONSUMERS. scripts/test_db_setup.ts installs exactly `imports` (through the
 * installer's own code path, from the same vendored files) and then GENERATES
 * the synthetic hierarchies named in `tlds` beyond it. The generic_tld_tripwire
 * data side reads `tlds` as the set of matrix_hierarchy TLD heads the law
 * admits, so a new test naming a new TLD reddens the fixture until it is
 * rebuilt — the allowlist can drift STALE, never silently NARROW.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly:
 *  - It reads SOURCE, not runtime behaviour. A tipo assembled at runtime from
 *    fragments (`tld + '1'`) is invisible to both grammars — that failure mode
 *    UNDER-includes. Audited 2026-08-25: every geo-TLD reference in the tree
 *    is a literal token. The gate over this module is what keeps that audit
 *    from rotting silently.
 *  - Presence in the allowlist proves a NAME was written somewhere, not that
 *    the gate needs the record DATA (most name-only callers would pass on an
 *    empty table). That asymmetry is accepted: over-installing a referenced
 *    hierarchy costs megabytes; under-installing one costs a red gate on
 *    someone else's machine.
 *  - An EMPTY derivation is refused loudly rather than returned: the test
 *    tree provably names vendored hierarchy tipos (tier1_install_native's
 *    literal `ad1`), so zero hits means the scan broke, and a broken scan must
 *    never quietly build an empty fixture.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
// DB-FREE ON PURPOSE: the synthetic TLD names live in a constants-only module
// (the test_database_marker_constants pattern) so this file stays importable
// BEFORE test_db_setup's env repoint — the fixture module itself imports
// config/postgres at module scope and must never be pulled in here.
import { SYNTHETIC_HIERARCHY_TLDS } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';

const REPO = join(import.meta.dir, '..', '..');

/** The vendored hierarchy data directory — same constant test_db_setup uses. */
export const HIERARCHY_IMPORT_DIR = join(REPO, 'install', 'import', 'hierarchy');

/** Scan roots: the test tree + the situations the suite materializes. */
const SCAN_ROOTS = ['test', join('src', 'core', 'test_data')] as const;

/**
 * FILES WHOSE MENTION OF A TIPO IS A NAME, NOT A NEED.
 *
 * The scan below treats "this tree names `it1`" as "this tree needs `it1`'s
 * records". For source files that is right. For these three it is not, and the
 * difference was measured: the first derived allowlist imported 14 TLDs / 243k
 * thesaurus records, of which `ee it ma pt tn` — 103,536 rows, 42.6% of all
 * hierarchy data — were justified by NOTHING BUT these files.
 *
 *  - `test_tld_clone_manifest.json` and `test_tld_tipo_map.json` are TRANSLATION
 *    TABLES: they say "install tipo `it1` becomes test tipo `testXXX`". The
 *    install tipo appears as a MAPPING KEY. What the suite then reads is the
 *    `test*` twin, which the generic-TLD law requires and which this fixture
 *    materialises from repo-owned JSON — never `it1`'s 69,999 imported records.
 *  - `test_corpus/refused.json` is the ledger of records the corpus derive
 *    REFUSED. Treating it as evidence of need inverts its meaning exactly.
 *  - `test_tld_foreign_refs.json` (added 2026-08-25) is the ledger of
 *    tipo-SHAPED tokens the shipped test ontology carries that are DECLARED
 *    FALSE POSITIVES — its only geo-TLD hits are the CSS colour literals
 *    `#ee9916` and `#ad6738` inside cloned css blobs, each annotated "not an
 *    ontology TLD" in the file itself. Before this exclusion, that colour
 *    literal alone was what kept `ee1` (11,910 real toponymy rows, 720K)
 *    in the suite fixture: a hex colour is not a record need, and counting a
 *    false-positive LEDGER as evidence inverts its meaning the same way
 *    refused.json's did.
 *  - `test_corpus/test2827.json` and `test_corpus/test2822.json` (added
 *    2026-08-25, the synthetic-fixture migration's last census hits): DERIVED
 *    corpus files whose ONLY vendored-TLD tokens are PROVENANCE metadata —
 *    `source_section_tipo: "es1"` / `"dz1"` and the matching `source` blocks
 *    record which install record a `test*` twin was derived FROM. The suite
 *    reads the twin (`test2827`/`test2822` rows in matrix_test), never the
 *    es1/dz1 records — the same "mapping key, not record need" class as the
 *    tipo map. Measured before this entry: these two provenance strings alone
 *    kept `es` (69,889 toponymy rows) and `dz` imported into every rebuild.
 *    Audited: no other corpus file's provenance names a vendored TLD.
 *
 * A tipo named ONLY here is still available to any test that truly wants it —
 * the vendored `.copy.gz` files all stay in the repo. It is simply not poured
 * into the fixture on the strength of a mapping key.
 */
const NAME_ONLY_SOURCES = [
	join('src', 'core', 'test_data', 'test_tld_clone_manifest.json'),
	join('src', 'core', 'test_data', 'test_tld_tipo_map.json'),
	join('src', 'core', 'test_data', 'test_corpus', 'refused.json'),
	join('src', 'core', 'test_data', 'test_tld_foreign_refs.json'),
	join('src', 'core', 'test_data', 'test_corpus', 'test2827.json'),
	join('src', 'core', 'test_data', 'test_corpus', 'test2822.json'),
] as const;

/** The one exclusion — see the header for why the frozen store must not count. */
const EXCLUDED_PREFIX = join('test', 'parity', 'fixtures');

export interface HierarchyAllowlist {
	/**
	 * TLDs whose RECORDS the suite fixture is allowed to hold: the vendored
	 * imports still referenced by the test tree PLUS the synthetic `test*`
	 * hierarchies the fixture GENERATES (src/core/test_data/
	 * synthetic_hierarchy_fixture.ts). This is the set the generic_tld_tripwire
	 * data side admits into matrix_hierarchy — installing is `imports`' job.
	 */
	tlds: string[];
	/** TLDs to actually IMPORT from vendored files: referenced ∩ vendored, sorted. */
	imports: string[];
	/** Every vendored `<tld>1.copy.gz` TLD, sorted — the candidate universe. */
	vendored: string[];
	/** tld → repo-relative files whose scan hit it (the audit trail). */
	evidence: Map<string, string[]>;
}

/** Every TLD with a vendored `<tld>1.copy.gz` data file, sorted. */
export function vendoredHierarchyTlds(hierarchyDir: string = HIERARCHY_IMPORT_DIR): string[] {
	const tlds = readdirSync(hierarchyDir)
		.filter((file) => /^[a-z]+1\.copy\.gz$/.test(file))
		.map((file) => file.replace(/1\.copy\.gz$/, ''));
	return [...new Set(tlds)].sort();
}

/** Recursive .ts/.json listing under a root, honouring the fixture exclusion. */
function scanFiles(rootRel: string): string[] {
	const out: string[] = [];
	const walk = (dirAbs: string): void => {
		for (const entry of readdirSync(dirAbs)) {
			const abs = join(dirAbs, entry);
			const rel = relative(REPO, abs);
			if (rel === EXCLUDED_PREFIX || rel.startsWith(`${EXCLUDED_PREFIX}/`)) continue;
			const stat = statSync(abs);
			if (stat.isDirectory()) walk(abs);
			else if (/\.(ts|json)$/.test(entry)) out.push(rel);
		}
	};
	walk(join(REPO, rootRel));
	return out;
}

/**
 * Derive the allowlist. Pure filesystem scan — no DB, no config import, so
 * test_db_setup can import it statically BEFORE its env repoint.
 */
export function deriveHierarchyAllowlist(
	hierarchyDir: string = HIERARCHY_IMPORT_DIR,
): HierarchyAllowlist {
	const vendored = vendoredHierarchyTlds(hierarchyDir);
	if (vendored.length === 0) {
		throw new Error(
			`hierarchy allowlist: no <tld>1.copy.gz candidates found under ${hierarchyDir} — the vendored data is missing or the path is wrong. Refusing to derive from nothing.`,
		);
	}
	const alternation = vendored.join('|');
	// .ts grammar: the section tipo `<tld>1`, word boundary before, no digit
	// after. The leading group consumes one char, so overlaps cannot hide a hit.
	const tsGrammar = new RegExp(`(?:^|[^A-Za-z0-9_])(${alternation})1(?![0-9])`, 'g');
	// .json grammar: any quoted tipo in the TLD.
	const jsonGrammar = new RegExp(`"(${alternation})[0-9]+"`, 'g');

	const evidence = new Map<string, string[]>();
	for (const root of SCAN_ROOTS) {
		for (const rel of scanFiles(root)) {
			if ((NAME_ONLY_SOURCES as readonly string[]).includes(rel)) continue;
			const grammar = rel.endsWith('.json') ? jsonGrammar : tsGrammar;
			const text = readFileSync(join(REPO, rel), 'utf-8');
			const hit = new Set<string>();
			for (const match of text.matchAll(grammar)) {
				const tld = match[1];
				if (tld !== undefined) hit.add(tld);
			}
			for (const tld of hit) {
				const files = evidence.get(tld) ?? [];
				files.push(rel);
				evidence.set(tld, files);
			}
		}
	}

	const imports = [...evidence.keys()].sort();
	// Anti-vacuity, in the BUILDER itself (the fixture gate does the full
	// matching): an empty result on a tree that provably names vendored
	// hierarchy tipos means the scan broke, and a broken scan must not build an
	// empty fixture. (`lg1` no longer counts: lg is a CORE hierarchy with no
	// vendored file — see the header.)
	if (imports.length === 0) {
		throw new Error(
			'hierarchy allowlist: the reference scan found ZERO referenced TLDs, but the test tree provably names vendored hierarchy tipos (ad1 at least — tier1_install_native). The scanner is broken; refusing to build an empty hierarchy fixture.',
		);
	}
	// The allowed-records set = imports + the GENERATED synthetic hierarchies.
	// The synthetic TLDs are not vendored files and never reach the import step;
	// they are in `tlds` because the data-side law (generic_tld_tripwire) reads
	// this symbol to know which matrix_hierarchy TLD heads are legitimate.
	const tlds = [...new Set([...imports, ...SYNTHETIC_HIERARCHY_TLDS])].sort();
	return { tlds, imports, vendored, evidence };
}
