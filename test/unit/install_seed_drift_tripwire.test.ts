/**
 * Install seed integrity — the vendored thesaurus directory
 * install/import/hierarchy/ must be INTERNALLY COHERENT, because that directory
 * is the only thing the install wizard has before an ontology exists.
 *
 * WHAT THIS GATE USED TO BE, AND WHY IT CHANGED.
 *  - 2026-08-22: it asserted the three metadata JSONs were byte-identical to
 *    copies under client/dedalo/core/installer/. Nothing read the client copies
 *    (the wizard renders what src/core/install/context.ts serves); they were
 *    deleted and the anti-fork assertion points the other way (no copy may
 *    come back).
 *  - 2026-10-10 (WC-2026-10-10-hierarchy-json-manifest): the three hand-written
 *    files (hierarchies.json, hierarchies_typologies.json,
 *    hierarchies_to_install.json) are DELETED, replaced by ONE exported
 *    manifest, hierarchy.json, read through THE strict reader
 *    (src/core/ontology/hierarchy_manifest_format.ts). The seed registry no
 *    longer carries the optional thesauri: their rows are written at
 *    activation from the manifest entry, so the seed ships the CORE rows only.
 *
 * The invariants below are the ones whose violation actually breaks something:
 * a manifest the reader refuses is an install that cannot start; a listed data
 * file that is missing or whose bytes do not match its digest is a thesaurus
 * the importer must refuse; a data file no entry lists is never offered nor
 * verified; a CORE hierarchy (lg — activated by the seed restore, its terms the
 * seed's own matrix_langs, never imported) with a data file would duplicate its
 * terms into matrix_hierarchy where nothing reads them; a non-core seed
 * registry row is a frozen second copy of the manifest's metadata.
 *
 * THE SEED DUMP ITSELF (installer unification A2, 2026-10-09; reconciled with
 * the seed COMPILER the same day). The seed is CORE-ONLY and COMPILED from repo
 * sources (src/core/install/seed_build.ts, `bun run seed:build`); WHO wrote it
 * and FROM WHAT is install_seed_manifest_tripwire's, WHAT a restore holds is
 * install_seed_contract_native's. This gate keeps the two equalities neither
 * of those measures, read hermetically from the committed bytes:
 *  - ONE core list: the compiler's SEED_ONTOLOGY_TLDS IS CORE_ONTOLOGY_TLDS,
 *    the catalog default of ACTIVE_ONTOLOGY_TLDS = CORE_ONTOLOGY_TLDS (same
 *    order — config may not import core, so this equality keeps the two
 *    literals one list), and the dump's dd_ontology TLDs = matrix_ontology
 *    sections = CORE exactly (no domain TLD — `oh` is an install answer — and
 *    no `test` TLD, no matrix_test row: those are the suite's);
 *  - the core's structural DEPENDENCY-class references to tipos the seed does
 *    not hold (src/core/ontology/ontology_references.ts, diffusion model set
 *    derived from the seed's own model rows) equal
 *    engineering/install_seed_contract.json EXACTLY, every reason non-empty.
 *    Graft and diffusion references are soft by rule and never listed.
 *  - every core ontology35 registry row's misc.hierarchy60 equals the release
 *    entry's declaration through the compiler's own releaseDependencies
 *    (absent ⇔ not declared): the seed is compiled through the import door, and
 *    the installer's CLI plan (vendored ontology.json) and wizard step (these
 *    rows) must read ONE truth (WC-2026-10-10-ontology-dependencies-hierarchy60).
 * Anti-vacuity: floors on rows/references, and a planted dangling dependency
 * must be reported.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DEFAULTS_KEYS } from '../../src/config/catalog/defaults.ts';
import { copyBlockRecords, copyBlocks, splitCopyRow } from '../../src/core/db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { CORE_HIERARCHIES } from '../../src/core/install/hierarchy_meta.ts';
import { SEED_DUMP_PATH } from '../../src/core/install/paths.ts';
import { type ReleaseOntology, releaseDependencies } from '../../src/core/install/seed_build.ts';
import {
	ONTOLOGY_RELEASE_DIR,
	SEED_ONTOLOGY_TLDS,
	SEED_REGISTRY_PATH,
} from '../../src/core/install/seed_sources.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	hierarchyDataFileNames,
	parseHierarchyManifestText,
	sha256Hex,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';
import {
	danglingDependencies,
	diffusionModelSet,
	type OntologyReference,
	referencesOfRows,
} from '../../src/core/ontology/ontology_references.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SERVER_DIR = join(ROOT, 'install/import/hierarchy');
const CLIENT_INSTALLER_DIR = join(ROOT, 'client/dedalo/core/installer');

/** The vendored manifest, through THE reader (a refusal fails the whole gate, loudly). */
const manifest = parseHierarchyManifestText(
	readFileSync(join(SERVER_DIR, HIERARCHY_MANIFEST_FILE), 'utf8'),
);
const entries = manifest.active_hierarchies;

/** Every vendored `<tld>1|2.copy.gz` file name. */
const vendoredDataFiles = readdirSync(SERVER_DIR).filter((name) =>
	/^[a-z]+[12]\.copy\.gz$/.test(name),
);

/** The tld of each seed registry row (install/db/seed/matrix_hierarchy_main.copy.gz). */
const seedRegistryTlds = gunzipSync(readFileSync(SEED_REGISTRY_PATH))
	.toString('utf8')
	.split('\n')
	.filter((line) => line !== '')
	.map((line) => {
		const cell = splitCopyRow(line)[MATRIX_COPY_COLUMNS.indexOf('string')] ?? null;
		const strings =
			cell === null ? {} : (JSON.parse(cell) as Record<string, { value?: unknown }[]>);
		return String(strings.hierarchy6?.[0]?.value ?? '').toLowerCase();
	});

describe('install seed tripwire — the vendored thesaurus manifest', () => {
	test('the scan sees a real manifest (a zero-length pass is not a pass)', () => {
		expect(entries.length).toBeGreaterThan(100);
		expect(vendoredDataFiles.length).toBeGreaterThan(100);
		expect(manifest.typologies.length).toBeGreaterThan(0);
		expect(seedRegistryTlds.length).toBeGreaterThan(0);
	});

	test('the three retired hand-written files are absent', () => {
		const retired = [
			'hierarchies.json',
			'hierarchies_typologies.json',
			'hierarchies_to_install.json',
		].filter((name) => existsSync(join(SERVER_DIR, name)));
		expect(retired, 'replaced by hierarchy.json (WC-2026-10-10-hierarchy-json-manifest)').toEqual(
			[],
		);
	});

	test('every listed data file is vendored and its bytes match the digest', () => {
		let checked = 0;
		const broken: string[] = [];
		for (const entry of entries) {
			for (const item of entry.data_files) {
				const path = join(SERVER_DIR, item.file);
				if (!existsSync(path)) broken.push(`${entry.tld}: ${item.file} missing`);
				else if (sha256Hex(readFileSync(path)) !== item.sha256)
					broken.push(`${entry.tld}: ${item.file} sha256 mismatch`);
				checked++;
			}
		}
		expect(checked, 'the digest scan saw the data files').toBeGreaterThan(100);
		expect(broken).toEqual([]);
	});

	test('every vendored data file is listed by an entry (never offered, never verified otherwise)', () => {
		const listed = new Set(entries.flatMap((entry) => entry.data_files.map((item) => item.file)));
		expect(vendoredDataFiles.filter((name) => !listed.has(name)).sort()).toEqual([]);
	});

	test('a CORE hierarchy is listed as metadata, with no data file (its terms are matrix_langs)', () => {
		expect(CORE_HIERARCHIES.length).toBeGreaterThan(0);
		for (const { tld } of CORE_HIERARCHIES) {
			const entry = entries.find((candidate) => candidate.tld === tld);
			expect(entry, `${tld} has a manifest entry`).toBeDefined();
			expect(entry?.data_files, `${tld} data_files`).toEqual([]);
			for (const name of hierarchyDataFileNames(tld)) {
				expect(existsSync(join(SERVER_DIR, name)), `${name} is not vendored`).toBe(false);
			}
		}
	});

	test('the seed registry ships the CORE rows exactly (optional thesauri activate from the manifest)', () => {
		expect([...seedRegistryTlds].sort()).toEqual(CORE_HIERARCHIES.map((meta) => meta.tld).sort());
	});

	test('the seed dump is vendored', () => {
		expect(existsSync(join(ROOT, 'install/db/dedalo_install.pgsql.gz'))).toBe(true);
	});

	test('NO hierarchy metadata copy exists under client/', () => {
		// "Link, never duplicate". A re-introduced copy is drift by construction:
		// nothing reads it, so nothing would notice it going stale.
		const copies = readdirSync(CLIENT_INSTALLER_DIR).filter((name) =>
			/^hierarch(y|ies).*\.json$/.test(name),
		);
		expect(copies, 'dead duplicate of the install seed metadata').toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The seed DUMP: core-only, one core list, the pinned dangling references.
// ---------------------------------------------------------------------------

interface ContractEntry {
	from: string;
	field: string;
	to: string;
	reason: string;
}

interface SeedOntologyRow {
	tipo: string;
	tld: string | null;
	parent: string | null;
	model_tipo: string | null;
	relations: { tipo?: unknown }[] | null;
	is_model: boolean;
}

const seedBlocks = copyBlocks(gunzipSync(readFileSync(SEED_DUMP_PATH)).toString('utf8'));
const blockRecords = (table: string) => {
	const block = seedBlocks.find((candidate) => candidate.table === table);
	return block === undefined ? [] : copyBlockRecords(block);
};
const distinct = (values: (string | null | undefined)[]) =>
	[...new Set(values.map((value) => value ?? ''))].sort();
const parseRelations = (raw: string | null | undefined): { tipo?: unknown }[] | null => {
	if (raw === null || raw === undefined || raw === '') return null;
	const parsed = JSON.parse(raw) as unknown;
	return Array.isArray(parsed) ? (parsed as { tipo?: unknown }[]) : null;
};

const ontologyRows: SeedOntologyRow[] = blockRecords('dd_ontology').map((row) => ({
	tipo: row.tipo ?? '',
	tld: row.tld ?? null,
	parent: row.parent ?? null,
	model_tipo: row.model_tipo ?? null,
	relations: parseRelations(row.relations),
	is_model: row.is_model === 't',
}));
const contract = JSON.parse(
	readFileSync(join(ROOT, 'engineering/install_seed_contract.json'), 'utf8'),
) as { known_dangling_dependencies: ContractEntry[] };

const presentTipos = new Set(ontologyRows.map((row) => row.tipo));
const seedDiffusionModels = diffusionModelSet(ontologyRows.filter((row) => row.is_model));
const coreSet = new Set(CORE_ONTOLOGY_TLDS);

/** The core's dependency-class references to tipos `present` does not hold, as stable keys. */
function danglingKeys(rows: typeof ontologyRows, present: ReadonlySet<string>): string[] {
	const dangling: OntologyReference[] = danglingDependencies(
		referencesOfRows(rows),
		coreSet,
		present,
		seedDiffusionModels,
	);
	return dangling.map((ref) => `${ref.from} ${ref.field} ${ref.to}`).sort();
}

describe('install seed dump — core-only, one core list', () => {
	test('the readers see a real seed (a zero-length pass is not a pass)', () => {
		expect(ontologyRows.length).toBeGreaterThan(3000);
		expect(referencesOfRows(ontologyRows).length).toBeGreaterThan(5000);
		// The diffusion model grouper and its descendants are in the core.
		expect(seedDiffusionModels.size).toBeGreaterThan(10);
		expect(seedBlocks.length).toBeGreaterThan(20);
		expect(blockRecords('matrix_langs').length).toBeGreaterThan(1000);
	});

	test('the dump is core-only: dd_ontology TLDs = matrix_ontology sections = CORE; no test3 row', () => {
		expect(distinct(ontologyRows.map((row) => row.tld))).toEqual([...CORE_ONTOLOGY_TLDS].sort());
		expect(distinct(blockRecords('matrix_ontology').map((row) => row.section_tipo))).toEqual(
			CORE_ONTOLOGY_TLDS.map((tld) => `${tld}0`).sort(),
		);
		expect(blockRecords('matrix_test')).toEqual([]);
	});

	test('ONE core list: compiler TLDs = CORE_ONTOLOGY_TLDS = catalog ACTIVE_ONTOLOGY_TLDS default (same order)', () => {
		expect(SEED_ONTOLOGY_TLDS).toEqual(CORE_ONTOLOGY_TLDS);
		expect<string[]>([...DEFAULTS_KEYS.ACTIVE_ONTOLOGY_TLDS.default]).toEqual([
			...CORE_ONTOLOGY_TLDS,
		]);
	});

	test("the core's dangling DEPENDENCY references = engineering/install_seed_contract.json, exactly", () => {
		const pinned = contract.known_dangling_dependencies;
		const thin = pinned
			.filter((entry) => entry.reason.trim().length < 40)
			.map((entry) => entry.from);
		expect(thin, 'every pinned exception carries its reason').toEqual([]);
		expect(danglingKeys(ontologyRows, presentTipos)).toEqual(
			pinned.map((entry) => `${entry.from} ${entry.field} ${entry.to}`).sort(),
		);
	});

	test('the dangling measurement is not vacuous: a planted core reference to an absent tipo is reported', () => {
		// A WORKING node (a non-diffusion model) relating to a tipo of an absent TLD.
		const nonDiffusion = ontologyRows.find(
			(row) =>
				row.tld === 'dd' && row.model_tipo !== null && !seedDiffusionModels.has(row.model_tipo),
		);
		expect(nonDiffusion).toBeDefined();
		const planted = {
			...(nonDiffusion as (typeof ontologyRows)[number]),
			tipo: 'dd999999',
			relations: [{ tipo: 'zzseedplant1' }],
		};
		expect(danglingKeys([...ontologyRows, planted], presentTipos)).toContain(
			'dd999999 relations zzseedplant1',
		);
	});
});

// ---------------------------------------------------------------------------
// The seed's core REGISTRY rows carry the release's declared dependencies.
// ---------------------------------------------------------------------------

const releaseEntries =
	(
		JSON.parse(readFileSync(join(ONTOLOGY_RELEASE_DIR, 'ontology.json'), 'utf8')) as {
			active_ontologies?: ReleaseOntology[];
		}
	).active_ontologies ?? [];

/** tld → the stored misc.hierarchy60 value of its ontology35 row (undefined = no key). */
function seedRegistryDeclarations(): Map<string, unknown> {
	const declared = new Map<string, unknown>();
	for (const row of blockRecords('matrix_ontology_main')) {
		if (row.section_tipo !== 'ontology35') continue;
		const strings = JSON.parse(row.string ?? '{}') as Record<string, { value?: unknown }[]>;
		const tld = strings.hierarchy6?.[0]?.value;
		if (typeof tld !== 'string') continue;
		const misc = JSON.parse(row.misc ?? 'null') as Record<string, { value?: unknown }[]> | null;
		declared.set(tld, misc?.hierarchy60?.[0]?.value);
	}
	return declared;
}

describe('install seed dump — core registry rows carry the release declarations', () => {
	test("each core row's misc.hierarchy60 = releaseDependencies(its release entry); absent ⇔ not declared", () => {
		const declared = seedRegistryDeclarations();
		for (const tld of CORE_ONTOLOGY_TLDS) {
			expect(declared.has(tld), `the seed holds the ${tld} registry row`).toBe(true);
			const entry = releaseEntries.find((candidate) => candidate.tld === tld);
			expect(entry, `the release has a ${tld} entry`).toBeDefined();
			const expected = releaseDependencies(entry as ReleaseOntology);
			expect(declared.get(tld) ?? null, `${tld} hierarchy60`).toEqual(expected);
		}
	});
});
