/**
 * SECTION CONTAINMENT — one law for every walker of a section's subtree
 * (T2-SL-3a, 2026-11-21).
 *
 * THE LAW (ontology/resolver.ts, "THE SECTION CONTAINMENT LAW"): a node whose
 * runtime model is `box elements` (stored `box elements`, `dataframe`,
 * `component_relation_struct`), `component_semantic_node`, or an area, is NOT
 * part of the section — neither the node nor anything under it. A nested
 * section is returned but not entered, unless the walker crosses nested
 * sections on purpose (the declared-components census).
 *
 * WHY A GATE: the walkers used to prune sections and areas only, each in its
 * own SQL. A field parked under a `box elements` container was then a search
 * field, a declared (wipeable) component and "the first component of its model"
 * — while the edit form, which filters by model, never showed it.
 *
 * Asserted on OUTCOMES, per walker: the pruned tipos are absent, the kept ones
 * present (a walker that returned nothing would not pass). The walkers that
 * inherit the law through the shared walk are driven too where they have a
 * public door: the archive extraction (ontology.json subtree) and the write
 * door's fixed-slot main (named main valid iff the every-main walk lists it).
 * The pair honesty check (tipoBelongsToSection) is pinned as deliberately NOT
 * the law: v6 let a root read and write a box-parked component.
 *
 * SITUATION (`zzsctn`, scratch TLD, no records), dropped in afterAll with
 * residue asserted 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import { ONTOLOGY_FILE } from '../../src/core/archive/manifest.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	findFirstDescendantTipoByModel,
	getContainingSectionTipo,
	getOrderedSubtree,
	getRecursiveChildrenTipos,
	isOutsideSectionContainment,
	tipoBelongsToSection,
	tipoInSectionContainment,
} from '../../src/core/ontology/resolver.ts';
import { editScopeComponents } from '../../src/core/ontology/virtual_scope.ts';
import { buildImplicitSectionEditConfig } from '../../src/core/relations/request_config/implicit.ts';
import {
	declaredSectionComponents,
	wipeScopeComponents,
} from '../../src/core/section/record/declared_components.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { sourceComponentLevel } from '../../src/core/security/write_door.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const SECTION = 'zzsctn1';
const GROUP = 'zzsctn2';
const KEPT_TEXT = 'zzsctn3';
/** A component_iri (declares the fixed dataframe slot dd560) inside the section… */
const KEPT_IRI = 'zzsctn4';
const BOX = 'zzsctn10';
const BOX_TEXT = 'zzsctn11';
const BOX_GROUP = 'zzsctn12';
/** The ONLY component_date of the section — and it sits under the box. */
const BOX_DATE = 'zzsctn13';
/** …and one parked under the box: not a valid main of the slot. */
const BOX_IRI = 'zzsctn14';
/** The fixed dataframe slot component_iri declares (descriptor fixedDataframeTipos). */
const IRI_SLOT = 'dd560';
const SEMANTIC = 'zzsctn20';
const SEMANTIC_TEXT = 'zzsctn21';
const LEGACY_DATAFRAME = 'zzsctn30';
const LEGACY_DATAFRAME_TEXT = 'zzsctn31';
const LEGACY_STRUCT = 'zzsctn35';
const AREA = 'zzsctn40';
const AREA_TEXT = 'zzsctn41';
const NESTED = 'zzsctn50';
const NESTED_TEXT = 'zzsctn51';
const NESTED_BOX = 'zzsctn52';
const NESTED_BOX_TEXT = 'zzsctn53';

/** Everything the law removes from a walk of SECTION, whatever the walker. */
const OUTSIDE = [
	BOX,
	BOX_TEXT,
	BOX_GROUP,
	BOX_DATE,
	BOX_IRI,
	SEMANTIC,
	SEMANTIC_TEXT,
	LEGACY_DATAFRAME,
	LEGACY_DATAFRAME_TEXT,
	LEGACY_STRUCT,
	AREA,
	AREA_TEXT,
	NESTED_BOX,
	NESTED_BOX_TEXT,
];

const S = situation({
	name: 'section containment',
	tld: 'zzsctn',
	nodes: [
		// test24 = the matrix_test table: the archive door needs the section to resolve one.
		{ tipo: SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: GROUP, parent: SECTION, model: 'section_group', order_number: 1 },
		{ tipo: KEPT_TEXT, parent: GROUP, model: 'component_input_text', order_number: 1 },
		{ tipo: KEPT_IRI, parent: GROUP, model: 'component_iri', order_number: 3 },
		{ tipo: BOX, parent: GROUP, model: 'box elements', order_number: 2 },
		{ tipo: BOX_TEXT, parent: BOX, model: 'component_input_text', order_number: 1 },
		{ tipo: BOX_GROUP, parent: BOX, model: 'section_group', order_number: 2 },
		{ tipo: BOX_DATE, parent: BOX_GROUP, model: 'component_date', order_number: 1 },
		{ tipo: BOX_IRI, parent: BOX_GROUP, model: 'component_iri', order_number: 2 },
		{ tipo: SEMANTIC, parent: SECTION, model: 'component_semantic_node', order_number: 2 },
		{ tipo: SEMANTIC_TEXT, parent: SEMANTIC, model: 'component_input_text', order_number: 1 },
		{ tipo: LEGACY_DATAFRAME, parent: SECTION, model: 'dataframe', order_number: 3 },
		{
			tipo: LEGACY_DATAFRAME_TEXT,
			parent: LEGACY_DATAFRAME,
			model: 'component_input_text',
			order_number: 1,
		},
		{ tipo: LEGACY_STRUCT, parent: SECTION, model: 'component_relation_struct', order_number: 4 },
		{ tipo: AREA, parent: SECTION, model: 'area', order_number: 5 },
		{ tipo: AREA_TEXT, parent: AREA, model: 'component_input_text', order_number: 1 },
		{ tipo: NESTED, parent: SECTION, model: 'section', order_number: 6 },
		{ tipo: NESTED_TEXT, parent: NESTED, model: 'component_input_text', order_number: 1 },
		{ tipo: NESTED_BOX, parent: NESTED, model: 'box elements', order_number: 2 },
		{ tipo: NESTED_BOX_TEXT, parent: NESTED_BOX, model: 'component_input_text', order_number: 1 },
	],
});

beforeAll(async () => {
	await dropSituation(S);
	await ensureSituation(S);
});

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

/** Assert none of OUTSIDE is in `tipos`, and that the walk did find `mustHold`. */
function expectContained(tipos: readonly string[], mustHold: readonly string[]): void {
	for (const kept of mustHold) expect(tipos).toContain(kept);
	expect(tipos.filter((tipo) => OUTSIDE.includes(tipo))).toEqual([]);
}

describe('the section containment law (T2-SL-3a)', () => {
	test('the predicate reads the RUNTIME model', () => {
		for (const model of [
			'box elements',
			'dataframe',
			'component_relation_struct',
			'component_semantic_node',
			'area',
			'area_thesaurus',
		]) {
			expect(isOutsideSectionContainment(model)).toBe(true);
		}
		for (const model of ['section', 'section_group', 'component_dataframe', 'component_date']) {
			expect(isOutsideSectionContainment(model)).toBe(false);
		}
		expect(isOutsideSectionContainment(null)).toBe(false);
	});

	test('getOrderedSubtree: pruned subtrees absent, nested section returned but not entered', async () => {
		const tipos = (await getOrderedSubtree(SECTION)).map((node) => node.tipo);
		expect(tipos).toEqual([GROUP, KEPT_TEXT, KEPT_IRI, NESTED]);
	});

	test('getRecursiveChildrenTipos: the same set', async () => {
		expect(await getRecursiveChildrenTipos(SECTION)).toEqual([GROUP, KEPT_TEXT, KEPT_IRI, NESTED]);
	});

	test('the law upward: getContainingSectionTipo / tipoInSectionContainment invert the walk', async () => {
		for (const tipo of [GROUP, KEPT_TEXT, KEPT_IRI]) {
			expect({ tipo, section: await getContainingSectionTipo(tipo) }).toEqual({
				tipo,
				section: SECTION,
			});
			expect(await tipoInSectionContainment(tipo, SECTION)).toBe(true);
		}
		for (const tipo of OUTSIDE) {
			expect({ tipo, section: await getContainingSectionTipo(tipo) }).toEqual({
				tipo,
				section: null,
			});
			expect(await tipoInSectionContainment(tipo, SECTION)).toBe(false);
		}
		// A nested section's own node answers the nested section, not the outer one.
		expect(await getContainingSectionTipo(NESTED_TEXT)).toBe(NESTED);
		expect(await tipoInSectionContainment(NESTED_TEXT, SECTION)).toBe(false);
	});

	test('the pair honesty check is NOT the law: a box-parked component still pairs (v6 root access)', async () => {
		expect(await tipoBelongsToSection(BOX_TEXT, SECTION)).toBe(true);
		expect(await tipoBelongsToSection(BOX_DATE, SECTION)).toBe(true);
	});

	test('findFirstDescendantTipoByModel: a component under a box is not "of the section"', async () => {
		expect(await findFirstDescendantTipoByModel(SECTION, 'component_date')).toBeNull();
		expect(await findFirstDescendantTipoByModel(SECTION, 'component_semantic_node')).toBeNull();
		expect(await findFirstDescendantTipoByModel(SECTION, 'component_input_text')).toBe(KEPT_TEXT);
	});

	test('declared components + wipe scope: nested sections crossed, boxes still pruned', async () => {
		const declared = (await declaredSectionComponents(SECTION)).map((c) => c.tipo);
		expect(declared).toEqual([KEPT_TEXT, KEPT_IRI, NESTED_TEXT]);
		const wipe = (await wipeScopeComponents(SECTION)).components.map((c) => c.tipo);
		expectContained(wipe, [KEPT_TEXT, KEPT_IRI, NESTED_TEXT]);
	});

	test('edit scope components + implicit edit form', async () => {
		expectContained(
			(await editScopeComponents(SECTION)).map((node) => node.tipo),
			[KEPT_TEXT],
		);
		const config = await buildImplicitSectionEditConfig({
			ownerTipo: SECTION,
			ownerSectionTipo: SECTION,
			mode: 'edit',
			ownerIsSection: true,
		});
		expectContained(
			config.flatMap((item) => item.show?.ddo_map ?? []).map((ddo) => ddo.tipo),
			[GROUP, KEPT_TEXT],
		);
	});

	test('the STRUCTURAL walk is not a section walk: it still returns every node', async () => {
		const tipos = (await getOrderedSubtree(SECTION, { crossSections: true })).map(
			(node) => node.tipo,
		);
		expect([...tipos].sort()).toEqual(
			[GROUP, KEPT_TEXT, KEPT_IRI, NESTED, NESTED_TEXT, ...OUTSIDE].sort(),
		);
	});

	test('archive extraction: the ontology.json subtree is the section walk', async () => {
		const scratch = scratchDir('section_containment_archive');
		rmSync(scratch, { recursive: true, force: true });
		try {
			const mediaRoot = resetMediaRoot(join(scratch, 'media_root'));
			const outDir = join(scratch, 'archive');
			await extractArchive({ sectionTipos: [SECTION], outDir, mediaRoot });
			const ontology = JSON.parse(readFileSync(join(outDir, ONTOLOGY_FILE), 'utf8')) as {
				subtree: { tipo: string }[];
			};
			expectContained(
				ontology.subtree.map((row) => row.tipo),
				[SECTION, GROUP, KEPT_TEXT, KEPT_IRI],
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('write door: a fixed-slot main is valid iff the every-main walk lists it', async () => {
		const root = await resolvePrincipal(-1);
		const frameRead = (mainTipo: string) =>
			sourceComponentLevel(
				root,
				{
					section_tipo: SECTION,
					tipo: IRI_SLOT,
					section_id: 1,
					caller_dataframe: { main_component_tipo: mainTipo, id_key: 1 },
				},
				'test',
			);
		// The every-main bound (no pairing) reads the walk: the kept main alone.
		expect(
			await sourceComponentLevel(
				root,
				{ section_tipo: SECTION, tipo: IRI_SLOT, section_id: 1 },
				'test',
			),
		).toBeGreaterThan(0);
		expect(await frameRead(KEPT_IRI)).toBeGreaterThan(0);
		let code: string | null = null;
		try {
			await frameRead(BOX_IRI);
		} catch (error) {
			if (!isDedaloError(error)) throw error;
			code = error.code;
		}
		expect(code).toBe('request.invalid_source');
	});
});
