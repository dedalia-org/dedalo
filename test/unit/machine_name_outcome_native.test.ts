/**
 * G1 — MACHINE-NAME OUTCOME gate (WC-2026-11-04-ontology-machine-names, plan
 * §10 G1): every consumer that NAMES something by an ontology node — the
 * matrix table of a section, the inverse-relation table list, the diffusion
 * domain / database / table / COLUMN names of a compiled plan, the rdf file a
 * record is published to AND the one the delete side removes, the rdf
 * importer's class and predicate names, a table alias's child dedup, a
 * collided name refusing its element's compile, a nameless matrix_table refusing its
 * section, an un-derived row's reading, the label chain's last step — answers
 * the node's dd_ontology.machine_name, never a lang-picked translation. (The
 * `model` column's consumer, the parser, is G2's: it needs source records.)
 *
 * THE SITUATION (zz scratch TLD `zzmn`, torn down after): name nodes whose
 * machine name differs from EVERY decoy ontology5 value, including an
 * `lg-spa` decoy (what the deleted `lg-spa → first non-empty` readers picked)
 * and a decoy in a 6-char lang that sorts FIRST in jsonb (`lg-aaa`, what a
 * first-non-empty scan picked when lg-spa was missing).
 *
 * THE MUTATION PROOF: the floor test asserts that the legacy reading of every
 * named node is a decoy, so restoring any deleted reader (or reading `term`
 * instead of `machine_name`) turns its outcome leg red. Measured 2026-11-04:
 * with `nameOrLabelOf`'s machine-name branch disabled, 9 of the legs go red
 * (only the floor and the label-chain leg, which do not read through it, stay green).
 *
 * Needs the suite DB (situation writes dd_ontology; assertTestDatabase).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteDdOntologyNode, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { resolvePublishedFile } from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import { publishedRecordFileName } from '../../src/core/diffusion_bridge/published_files.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { labelByTipo, nameOrLabelOf, termByTipo } from '../../src/core/ontology/labels.ts';
import { getMatrixTableFromTipo, getTermByTipo } from '../../src/core/ontology/resolver.ts';
import {
	clearRelatedTablesCache,
	getRelationTables,
} from '../../src/core/search/search_related.ts';
import {
	dropSituation,
	ensureSituation,
	modelTipoFor,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { compileElementPlan } from '../../src/diffusion/plan/compile.ts';
import {
	buildVirtualDiffusionTree,
	getDatabaseNameForElement,
} from '../../src/diffusion/plan/virtual_tree.ts';
import {
	engineRdfOntologyReader,
	loadRdfImportOntology,
} from '../../tools/tool_import_rdf/server/rdf_import_plan.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';

const TLD = 'zzmn';
const DOMAIN_NAME = 'zzmn_domain';
const DB_NAME = 'zzmn_db';
const TABLE_NAME = 'zzmn_table';
const MATRIX_TABLE_NAME = 'matrix_test';
const CLASS_NAME = 'zzmn:Class';
const UNLABELLED_NAME = 'zzmn_unlabelled';
const COLUMN_NAME = 'zzmn_column';
const PREDICATE_NAME = 'zzmn:predicate';
const RDF_CLASS_NAME = 'zzmn:Published';
const RDF_SERVICE = 'zzmnsvc';

/** Decoys: a first-sorting lang and an lg-spa value, both ≠ the machine name. */
function decoys(prefix: string): Record<string, string> {
	return { 'lg-aaa': `${prefix}_first_decoy`, 'lg-spa': `${prefix}_spa_decoy` };
}

/** A name node stated explicitly (the door keeps a stated pair). */
function named(machineName: string | null, term: Record<string, string>) {
	return { machine_name: machineName, use_machine_name: true, term };
}

const SITUATION = situation({
	name: 'machine_name_outcome',
	tld: TLD,
	nodes: [
		// diffusion: domain → element → database + table
		{
			tipo: 'zzmn0',
			parent: 'dd1190',
			model: 'diffusion_domain',
			...named(DOMAIN_NAME, decoys('domain')),
		},
		{
			tipo: 'zzmn1',
			parent: 'zzmn0',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzmn element label' },
			properties: { diffusion: { type: 'sql' } },
		},
		{ tipo: 'zzmn2', parent: 'zzmn1', model: 'database', ...named(DB_NAME, decoys('db')) },
		{
			tipo: 'zzmn3',
			parent: 'zzmn1',
			model: 'table',
			...named(TABLE_NAME, decoys('table')),
			relations: [{ tipo: 'zzmn5' }],
		},
		// a second sql element: the COLLISION table and the table ALIAS live here
		// (an alias consumes its real table inside its own element; a nameless
		// table refuses its element's compile — zzmn1 must stay compilable)
		{
			tipo: 'zzmn19',
			parent: 'zzmn0',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzmn second element' },
			properties: { diffusion: { type: 'sql' } },
		},
		// a COLLISION the parser could not name: no name, never a guess
		{
			tipo: 'zzmn4',
			parent: 'zzmn19',
			model: 'table',
			...named(null, decoys('collision')),
			relations: [{ tipo: 'zzmn5' }],
		},
		// a section whose matrix table is named by a matrix_table node
		{
			tipo: 'zzmn5',
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'zzmn section' },
			relations: [{ tipo: 'zzmn6' }],
		},
		// Under dd627 with inverse_relations: getRelationTables lists it — and its
		// allowlist assert THROWS on a decoy, so a lang reading cannot pass quietly.
		{
			tipo: 'zzmn6',
			parent: 'dd627',
			model: 'matrix_table',
			...named(MATRIX_TABLE_NAME, decoys('matrix')),
			properties: { inverse_relations: true },
		},
		// the section's one component, and the field_* column that publishes it
		{
			tipo: 'zzmn11',
			parent: 'zzmn5',
			model: 'component_input_text',
			term: { 'lg-spa': 'zzmn source' },
		},
		{
			tipo: 'zzmn12',
			parent: 'zzmn3',
			model: 'field_text',
			...named(COLUMN_NAME, decoys('column')),
			relations: [{ tipo: 'zzmn11' }],
		},
		// a table ALIAS: its merged children are deduplicated by MACHINE NAME —
		// zzmn17 shares zzmn12's name (zzmn12 is dropped) while zzmn18 shares only
		// zzmn17's lg-spa LABEL (zzmn18 is kept). A label dedup inverts both.
		{
			tipo: 'zzmn16',
			parent: 'zzmn19',
			model: 'table_alias',
			...named('zzmn_alias', decoys('alias')),
			relations: [{ tipo: 'zzmn3' }],
		},
		{
			tipo: 'zzmn17',
			parent: 'zzmn16',
			model: 'field_text',
			...named(COLUMN_NAME, decoys('alias_column')),
			relations: [{ tipo: 'zzmn11' }],
		},
		{
			tipo: 'zzmn18',
			parent: 'zzmn3',
			model: 'field_text',
			...named('zzmn_other_column', { 'lg-spa': 'alias_column_spa_decoy' }),
			relations: [{ tipo: 'zzmn11' }],
		},
		// an rdf element: its owl:Class names the per-record file on BOTH sides
		{
			tipo: 'zzmn13',
			parent: 'zzmn0',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzmn rdf element' },
			properties: { diffusion: { type: 'rdf', service_name: RDF_SERVICE } },
		},
		{
			tipo: 'zzmn14',
			parent: 'zzmn13',
			model: 'owl:Class',
			...named(RDF_CLASS_NAME, decoys('published')),
			relations: [{ tipo: 'zzmn5' }],
		},
		// a name node with NO label at all: the label chain ends in its name
		{ tipo: 'zzmn7', parent: 'test1', model: 'table', ...named(UNLABELLED_NAME, {}) },
		// rdf: an external-ontology root with one owl:Class child
		{
			tipo: 'zzmn8',
			parent: 'test1',
			model: 'external_ontology',
			term: { 'lg-spa': 'zzmn rdf root' },
			properties: { xmlns: { zzmn: 'urn:zzmn#' } },
		},
		{
			tipo: 'zzmn9',
			parent: 'zzmn8',
			model: 'owl:Class',
			...named(CLASS_NAME, decoys('class')),
			relations: [{ tipo: 'zzmn5' }],
		},
		{
			tipo: 'zzmn15',
			parent: 'zzmn9',
			model: 'rdf:predicate',
			...named(PREDICATE_NAME, decoys('predicate')),
			relations: [{ tipo: 'zzmn11' }],
		},
	],
});

/** The deleted readers' rule: lg-spa, else the first non-empty value. */
function legacyReading(term: Record<string, string> | undefined): string | null {
	if (term === undefined) return null;
	return term['lg-spa'] ?? Object.values(term).find((value) => value !== '') ?? null;
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	await clearOntologyDerivedCaches();
});

afterAll(async () => {
	expect(await dropSituation(SITUATION)).toBe(0);
	await clearOntologyDerivedCaches();
});

describe('machine-name outcome (G1)', () => {
	test('floor: the legacy reading of every named node is a decoy', () => {
		for (const node of SITUATION.nodes) {
			if (node.use_machine_name !== true || node.machine_name === null) continue;
			if (Object.keys(node.term ?? {}).length === 0) continue;
			expect(legacyReading(node.term ?? undefined), node.tipo).not.toBe(node.machine_name);
		}
	});

	test("a section's matrix table is its matrix_table node's machine name", async () => {
		expect(await getMatrixTableFromTipo('zzmn5')).toBe(MATRIX_TABLE_NAME);
	});

	test('a matrix_table node with no machine name refuses the section — never another table', async () => {
		// Upserted here, not in SITUATION: ensureSituation resolves every section's
		// table, which is exactly what this node refuses. dropSituation sweeps the tld.
		await assertTestDatabase('machine_name_outcome nameless matrix_table');
		const sectionModel = await modelTipoFor('section');
		const matrixModel = await modelTipoFor('matrix_table');
		await upsertDdOntologyNode({
			tipo: 'zzmn21',
			tld: TLD,
			parent: 'test1',
			model: 'matrix_table',
			model_tipo: matrixModel,
			...named(null, decoys('matrix_collision')),
		});
		await upsertDdOntologyNode({
			tipo: 'zzmn20',
			tld: TLD,
			parent: 'test1',
			model: 'section',
			model_tipo: sectionModel,
			term: { 'lg-spa': 'zzmn nameless-table section' },
			relations: [{ tipo: 'zzmn21' }],
		});
		await clearOntologyDerivedCaches();
		let caught: unknown = null;
		try {
			await getMatrixTableFromTipo('zzmn20');
		} catch (error) {
			caught = error;
		}
		await deleteDdOntologyNode('zzmn20');
		await deleteDdOntologyNode('zzmn21');
		await clearOntologyDerivedCaches();
		expect((caught as { code?: string } | null)?.code).toBe('ontology.invalid_node');
		expect(String((caught as Error | null)?.message)).toContain('zzmn21');
	});

	test('an UN-DERIVED row reads lg-spa, never the configurable label-fallback lang', async () => {
		// The label-fallback lang is a boot constant: measured in a child bound to lg-eng.
		const probe = `const { nameOrLabelOf, ONTOLOGY_LABEL_FALLBACK_LANG: lang } = await import(${JSON.stringify(`${import.meta.dir}/../../src/core/ontology/labels.ts`)});
const term = { 'lg-eng': 'english_stray', 'lg-spa': 'spa_name' };
console.log(JSON.stringify([lang, nameOrLabelOf({ term, use_machine_name: null }), nameOrLabelOf({ term, use_machine_name: false })]));
process.exit(0);`;
		const child = Bun.spawn([process.execPath, '-e', probe], {
			env: { ...Bun.env, DEDALO_STRUCTURE_LANG: 'lg-eng' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		const last = out.trim().split('\n').pop() ?? '';
		// the label row DOES follow the fallback lang (the probe is honest), the un-derived one never
		expect(JSON.parse(last)).toEqual(['lg-eng', 'spa_name', 'english_stray']);
	}, 30000);

	test('the diffusion domain is matched by its machine name, never a label', async () => {
		expect(await buildVirtualDiffusionTree('domain_spa_decoy')).toBeNull();
		expect(await buildVirtualDiffusionTree('domain_first_decoy')).toBeNull();
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		expect(tree?.domainTipo).toBe('zzmn0');
	});

	test('database and table names are machine names; a collision names nothing', async () => {
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (tree === null) throw new Error('zzmn domain not found');
		expect(getDatabaseNameForElement(tree, 'zzmn1')).toBe(DB_NAME);
		const byTipo = new Map(tree.nodes.map((node) => [node.tipo, node]));
		expect(byTipo.get('zzmn3')?.label).toBe(TABLE_NAME);
		expect(byTipo.get('zzmn4')?.label ?? null).toBeNull();
		// the element (a LABEL node) keeps its label
		expect(byTipo.get('zzmn1')?.label).toBe('zzmn element label');
	});

	test('the inverse-relation table list reads the matrix_table node by its machine name', async () => {
		clearRelatedTablesCache();
		// a decoy reading would reach assertMatrixTable and throw (zzmn6 has inverse_relations)
		const tables = await getRelationTables();
		expect(tables).toContain(MATRIX_TABLE_NAME);
		for (const decoy of Object.values(decoys('matrix'))) expect(tables).not.toContain(decoy);
		clearRelatedTablesCache();
	});

	test('a compiled sql plan names its table and its field_* column by their machine names', async () => {
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (tree === null) throw new Error('zzmn domain not found');
		const plan = await compileElementPlan('zzmn1', { tree });
		const tableNames = plan.sections.map((section) => section.tableName);
		expect(tableNames).toContain(TABLE_NAME);
		const table = plan.sections.find((section) => section.tableName === TABLE_NAME);
		expect(table?.fields.map((field) => field.columnName)).toContain(COLUMN_NAME);
	});

	test('a table whose name collided refuses its element compile — never a guessed name', async () => {
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (tree === null) throw new Error('zzmn domain not found');
		const failure = await compileElementPlan('zzmn19', { tree }).then(
			() => null,
			(error: unknown) => String((error as Error).message),
		);
		expect(failure).toContain("table node 'zzmn4'");
		for (const decoy of Object.values(decoys('collision'))) expect(failure).not.toContain(decoy);
	});

	test('publish and delete sides name the same rdf file: the owl:Class machine name', async () => {
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (tree === null) throw new Error('zzmn domain not found');
		const plan = await compileElementPlan('zzmn13', { tree });
		const section = plan.sections.find((candidate) => candidate.sectionTipo === 'zzmn5');
		// the publish side: the rdf writer names the file from SectionPlan.tableName
		expect(section?.tableName).toBe(RDF_CLASS_NAME);
		const published = publishedRecordFileName('rdf', 'zzmn5', 1, section?.tableName ?? null);
		// the delete side reads the owl:Class row itself
		const resolution = await resolvePublishedFile(
			'zzmn13',
			'rdf',
			'zzmn5',
			1,
			scratchMediaRoot('machine_name_outcome'),
		);
		expect(resolution.kind).toBe('file');
		if (resolution.kind !== 'file' || published === null) throw new Error('no rdf file name');
		expect(resolution.path.endsWith(`/${published}`)).toBe(true);
		expect(published as string).toBe(
			publishedRecordFileName('rdf', 'zzmn5', 1, RDF_CLASS_NAME) ?? '',
		);
	});

	test('a table alias deduplicates its merged children by machine name, never by label', async () => {
		const tree = await buildVirtualDiffusionTree(DOMAIN_NAME);
		const alias = tree?.nodes.find((node) => node.tipo === 'zzmn16');
		expect(alias?.realTipo).toBe('zzmn3');
		expect(alias?.label).toBe('zzmn_alias');
		const merged = alias?.childrenTipos ?? [];
		expect(merged).toContain('zzmn17');
		expect(merged).toContain('zzmn18');
		expect(merged).not.toContain('zzmn12');
	});

	test('the rdf importer names a class and a predicate by their machine names', async () => {
		const ontology = await loadRdfImportOntology('zzmn8', engineRdfOntologyReader());
		expect(ontology.nodes.get('zzmn9')?.name).toBe(CLASS_NAME);
		expect(ontology.nodes.get('zzmn15')?.name).toBe(PREDICATE_NAME);
	});

	test('the label chain ends in the machine name; a real label still wins', async () => {
		expect(await termByTipo('zzmn7', 'lg-eng')).toBe(UNLABELLED_NAME);
		expect(await labelByTipo('zzmn7', 'lg-eng')).toBe(UNLABELLED_NAME);
		expect(await getTermByTipo('zzmn7', 'lg-eng')).toBe(UNLABELLED_NAME);
		// a labelled name node shows a label (the chain's first steps)
		expect(await termByTipo('zzmn3', 'lg-spa')).toBe('table_spa_decoy');
	});

	test('nameOrLabelOf over the stored rows agrees with every consumer', () => {
		const byTipo = new Map(SITUATION.nodes.map((node) => [node.tipo, node]));
		expect(nameOrLabelOf(byTipo.get('zzmn3'))).toBe(TABLE_NAME);
		expect(nameOrLabelOf(byTipo.get('zzmn4'))).toBeNull();
		expect(nameOrLabelOf(byTipo.get('zzmn1'))).toBe('zzmn element label');
		// what the deleted readers WOULD have answered is a decoy (the mutation proof)
		expect(nameOrLabelOf({ term: byTipo.get('zzmn3')?.term ?? null })).not.toBe(TABLE_NAME);
	});
});
