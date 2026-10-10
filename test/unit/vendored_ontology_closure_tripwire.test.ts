/**
 * VENDORED ONTOLOGY CLOSURE TRIPWIRE (installer unification A6) — the ONE
 * domain file the installer reads from the vendored ontology dir,
 * `oh.copy.gz`, must stay INSTALLABLE ALONE over the core seed: everything it
 * structurally needs is either inside it or in a core TLD.
 *
 * WHY. An offline install (ONTOLOGY_SERVERS = [], or no network) gets exactly
 * core + the vendored `oh`. If a re-vendored `oh` began to reference a model or
 * a working node of another domain ontology (`tch`, `crm`, …), every offline
 * install would carry an `oh` with unresolved structure and the installer would
 * only WARN after the fact. This gate refuses that package at commit time.
 *
 * WHAT IS MEASURED (outcomes — the file is parsed, never its name pinned):
 *  - every structural reference of oh.copy.gz (parent / model / relations,
 *    src/core/ontology/ontology_references.ts) is classified with the
 *    diffusion-model set built from the SEED's own dd_ontology model rows;
 *  - every DEPENDENCY-class reference resolves within oh ∪ the seed's core-TLD
 *    tipos (grafts and diffusion relations are soft BY RULE);
 *  - the TLDs oh depends on ⊆ CORE (always installed), so oh installs alone
 *    over the core even while the vendored ontology.json declares no
 *    dependencies for it (a release that predates hierarchy60); and when it does
 *    declare them (the entry the installer reads, ontology_choice.ts
 *    vendoredOntologyCatalog), no MANDATORY ontology outside the core — an
 *    offline install could not serve it;
 *  - the installer reads only `oh` from that dir (VENDORED_DOMAIN_TLDS).
 * ANTI-VACUITY: > 400 references measured, both soft classes observed, and a
 * planted node whose model lives in a non-core TLD flips the verdict red.
 *
 * THE THESAURUS HALF (2026-10-10, WC-2026-10-10-hierarchy-json-manifest). The
 * release also vendors install/import/hierarchy/hierarchy.json — the one
 * thesaurus manifest the installer offers from. A thesaurus is installable
 * when it has an ENTRY there (data files or not: no data = an empty thesaurus),
 * so every `main: 'hierarchy1'` dependency the release declares — in ANY
 * vendored ontology.json entry or any hierarchy.json entry, mandatory or
 * optional — must name an entry (or a CORE hierarchy, which the seed always
 * activates), or an install of the declaring ontology is thinner than its
 * declaration says — a warning the operator cannot act on (a thesaurus never
 * blocks an install, owner decision 2026-10-10: a mandatory one without an
 * entry is a "strongly recommended" warning, an optional one a skip warning).
 * The release itself must not ship that warning. Every declaration must also survive THE
 * shared normalizer intact: an item it would drop is a dependency the
 * installer never sees. Measured through the installer's own collector +
 * plan (`collectHierarchyDependencies`, `hierarchyDependencyPlan`). The vendored
 * release declares no hierarchy1 dependency today (it predates hierarchy60),
 * so the floors count DECLARERS read, and planted declarations — one with an
 * entry, a mandatory and an optional one without — prove the verdict moves.
 * The manifest's own integrity (reader, digests, no lg data file, the retired
 * files absent, seed registry = CORE) is install_seed_drift_tripwire's.
 * Works on the current seed and on a core-only rebuild (only core-TLD rows of
 * the seed are counted as present). Hermetic: no database, no network.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { copyBlockRecords, copyBlocks } from '../../src/core/db/copy_text.ts';
import { CORE_HIERARCHIES } from '../../src/core/install/hierarchy_meta.ts';
import {
	collectHierarchyDependencies,
	type DependencyDeclarer,
	hierarchyDependencyPlan,
	VENDORED_DOMAIN_TLDS,
	vendoredInfoFrom,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import {
	HIERARCHY_IMPORT_DIR,
	SEED_DUMP_PATH,
	VENDORED_ONTOLOGY_DIR,
} from '../../src/core/install/paths.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	parseHierarchyManifestText,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';
import { normalizeOntologyDependencies } from '../../src/core/ontology/ontology_dependencies.ts';
import {
	classifyReference,
	danglingDependencies,
	diffusionModelSet,
	foreignDependencyTlds,
	type OntologyReference,
	referencesOfCopyRows,
} from '../../src/core/ontology/ontology_references.ts';
import { ontologyCopyRow } from '../../src/core/test_data/ontology_package_fixture.ts';

const VENDORED_TLD = VENDORED_DOMAIN_TLDS[0] ?? '';
const OWN = new Set([VENDORED_TLD]);
const CORE = new Set(CORE_ONTOLOGY_TLDS);

/** The vendored package's raw COPY lines. */
const packageLines = gunzipSync(
	readFileSync(join(VENDORED_ONTOLOGY_DIR, `${VENDORED_TLD}.copy.gz`)),
)
	.toString('utf8')
	.split('\n')
	.filter((line) => line !== '');

/** The seed's dd_ontology rows. */
const seedRows = (() => {
	const dump = gunzipSync(readFileSync(SEED_DUMP_PATH)).toString('utf8');
	const block = copyBlocks(dump).find((candidate) => candidate.table === 'dd_ontology');
	if (block === undefined) throw new Error('the seed carries no dd_ontology COPY block');
	return copyBlockRecords(block);
})();

const diffusionModels = diffusionModelSet(
	seedRows
		.filter((row) => row.is_model === 't')
		.map((row) => ({ tipo: row.tipo as string, parent: row.parent ?? null })),
);
const coreTipos = new Set(
	seedRows.filter((row) => CORE.has(row.tld ?? '')).map((row) => row.tipo as string),
);

function verdict(lines: readonly string[]) {
	const refs = referencesOfCopyRows(lines);
	const ownTipos = new Set(refs.map((ref) => ref.from));
	const present = (tipo: string) => ownTipos.has(tipo) || coreTipos.has(tipo);
	return {
		refs,
		dangling: danglingDependencies(refs, OWN, present, diffusionModels),
		foreign: foreignDependencyTlds(refs, OWN, diffusionModels),
	};
}

const measured = verdict(packageLines);

describe('vendored ontology closure', () => {
	test('the installer reads exactly one vendored domain file', () => {
		expect([...VENDORED_DOMAIN_TLDS]).toEqual(['oh']);
		expect(vendoredOntologyCatalog().entries.map((item) => item.tld)).toEqual(['oh']);
	});

	test('the measurement is not vacuous', () => {
		expect(packageLines.length).toBeGreaterThan(100);
		expect(coreTipos.size).toBeGreaterThan(3000);
		expect(diffusionModels.size).toBeGreaterThan(5);
		expect(measured.refs.length).toBeGreaterThan(400);
		const classes = new Set(
			measured.refs.map((ref: OntologyReference) => classifyReference(ref, OWN, diffusionModels)),
		);
		expect([...classes].sort()).toEqual(['dependency', 'diffusion', 'graft']);
	});

	test('every dependency-class reference resolves within the package or the core', () => {
		expect(measured.dangling.map((ref) => `${ref.from} ${ref.field}→${ref.to}`)).toEqual([]);
	});

	test('it depends only on core TLDs, and declares no ontology the offline set lacks', () => {
		expect(measured.foreign.length).toBeGreaterThan(0);
		expect(measured.foreign.filter((tld) => !CORE.has(tld))).toEqual([]);
		// A vendored declaration (absent until the release carries hierarchy60 —
		// then oh is installed alone, which the verdict above keeps safe) may not
		// make an offline install need an ontology only a server offers.
		const declared = vendoredOntologyCatalog().entries[0]?.dependencies ?? [];
		expect(
			declared
				.filter((item) => item.main === 'ontology35' && item.mandatory && !CORE.has(item.tld))
				.map((item) => item.tld),
		).toEqual([]);
	});

	test('a planted node whose model lives in a non-core TLD flips the verdict', () => {
		const parent = measured.refs[0]?.from ?? `${VENDORED_TLD}1`;
		const planted = ontologyCopyRow(VENDORED_TLD, {
			id: 999_999,
			parent,
			model: 'zzvq9',
			term: 'planted',
		});
		const red = verdict([...packageLines, planted]);
		expect(red.dangling.map((ref) => ref.to)).toEqual(['zzvq9']);
		expect(red.foreign).toContain('zzvq');
	});
});

// ---------------------------------------------------------------------------
// The thesaurus half: every declared hierarchy1 dependency has a manifest entry.
// ---------------------------------------------------------------------------

/** The vendored thesaurus manifest, through THE reader (a refusal reds the file). */
const hierarchyManifest = parseHierarchyManifestText(
	readFileSync(join(HIERARCHY_IMPORT_DIR, HIERARCHY_MANIFEST_FILE), 'utf8'),
);

/** The TLDs an install can activate: every manifest entry (data or not) — the offer. */
const listedThesauri: ReadonlySet<string> = new Set(
	hierarchyManifest.active_hierarchies.map((entry) => entry.tld),
);

/** Every vendored ontology.json entry's raw declaration, by TLD. */
const vendoredOntologyInfo = vendoredInfoFrom(
	JSON.parse(readFileSync(join(VENDORED_ONTOLOGY_DIR, 'ontology.json'), 'utf8')),
);

/**
 * Every declarer of the release — each vendored ontology.json entry and each
 * hierarchy.json entry — normalized through THE shared normalizer; a dropped
 * item lands in `dropped` (it would be invisible to the installer).
 */
function releaseDeclarers(dropped: string[]): DependencyDeclarer[] {
	const fromOntologies = [...vendoredOntologyInfo].map(([tld, entry]) => ({
		tld,
		dependencies: normalizeOntologyDependencies(tld, entry.dependencies, dropped),
	}));
	const fromThesauri = hierarchyManifest.active_hierarchies.map((entry) => ({
		tld: entry.tld,
		dependencies: entry.dependencies ?? null,
	}));
	return [...fromOntologies, ...fromThesauri];
}

/** The installer's verdict over a declarer set: what installs, what warns (a thesaurus never refuses). */
function thesaurusVerdict(declarers: readonly DependencyDeclarer[]) {
	const { dependencies } = collectHierarchyDependencies(declarers);
	return hierarchyDependencyPlan(dependencies, listedThesauri);
}

describe('vendored thesaurus closure', () => {
	const dropped: string[] = [];
	const declarers = releaseDeclarers(dropped);

	test('the measurement reads the whole release (both files, every entry)', () => {
		expect(vendoredOntologyInfo.size).toBeGreaterThan(100);
		expect(hierarchyManifest.active_hierarchies.length).toBeGreaterThan(100);
		expect(declarers.length).toBe(
			vendoredOntologyInfo.size + hierarchyManifest.active_hierarchies.length,
		);
	});

	test('every declaration survives the shared normalizer intact', () => {
		expect(dropped).toEqual([]);
	});

	// A thesaurus never blocks an install (owner, 2026-10-10), so an OPTIONAL
	// declaration without an entry is legitimate in a release — e.g. a thesaurus
	// still in development (inactive) on the master. A MANDATORY one without an
	// entry is a release mistake on the master: the installer would only warn,
	// so this gate is where it is caught.
	test('every MANDATORY declared hierarchy1 dependency names a manifest entry (or a core hierarchy)', () => {
		const verdict = thesaurusVerdict(declarers);
		const mandatoryMissing = verdict.warnings.filter((line) => line.includes('declared mandatory'));
		expect(mandatoryMissing, 'mandatory thesauri without an entry').toEqual([]);
	});

	test('planted declarations move the verdict (entry → install; none → warned, mandatory or not)', () => {
		const withEntry = [...listedThesauri].find(
			(tld) => !CORE_HIERARCHIES.some((c) => c.tld === tld),
		);
		expect(withEntry).toBeDefined();
		const planted: DependencyDeclarer = {
			tld: 'zzvt',
			dependencies: [
				{ tld: withEntry ?? '', main: 'hierarchy1', mandatory: true },
				{ tld: 'zzvtmissing', main: 'hierarchy1', mandatory: true },
				{ tld: 'zzvtoptional', main: 'hierarchy1', mandatory: false },
			],
		};
		// Measured RELATIVE to the release's own verdict: the release may already
		// carry optional declarations without an entry (see the gate above).
		const base = thesaurusVerdict(declarers);
		const red = thesaurusVerdict([...declarers, planted]);
		expect(red.install).toContain(withEntry ?? '');
		expect(red).not.toHaveProperty('errors');
		const added = red.warnings.filter((line) => !base.warnings.includes(line));
		expect(added.length).toBe(2);
		expect(added[0]).toContain("'zzvtmissing' (declared mandatory by 'zzvt')");
		expect(added[0]).toContain('strongly recommended');
		expect(added[1]).toContain('zzvtoptional');
		const malformed: string[] = [];
		normalizeOntologyDependencies(
			'zzvt',
			[{ tld: 'zzvq', main: 'nope', mandatory: true }],
			malformed,
		);
		expect(malformed.length).toBe(1);
	});
});
