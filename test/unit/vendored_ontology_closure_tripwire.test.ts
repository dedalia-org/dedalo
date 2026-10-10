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
 * Works on the current seed and on a core-only rebuild (only core-TLD rows of
 * the seed are counted as present). Hermetic: no database, no network.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { copyBlockRecords, copyBlocks } from '../../src/core/db/copy_text.ts';
import {
	VENDORED_DOMAIN_TLDS,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { SEED_DUMP_PATH, VENDORED_ONTOLOGY_DIR } from '../../src/core/install/paths.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
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
