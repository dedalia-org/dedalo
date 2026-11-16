/**
 * T1-3 / O09 — v6 `global_table_maps` IS PORTED: the aggregate tables
 * (mdcat `global_search`, numisdata `map_global`, dd `globalontology`) are
 * written, refreshed and withdrawn again.
 *
 * THE FINDING. Since the 2026-07-11 cutover the plan compiler only pushed a
 * `global_table_maps:<tipo>` warning: no writer, no delete, no reconcile knew a
 * global table, so on every install those tables froze — new records absent,
 * edited ones stale, withdrawn ones still public. v6 diffusion_sql::
 * save_global_table_data (:2477-2652) wrote one row per (record, lang) keyed
 * `<section_tipo>_<section_id>`, delete-then-insert, and its unpublish
 * (:1439-1483) removed it.
 *
 * WHAT IS ASSERTED (outcomes), each built here:
 *   A. compile, on the zzdif GLOBAL element (zzdif100, real dd_ontology rows):
 *      both source sections carry their compiled global table (name, VARCHAR
 *      key length, provenance, maps) and the old warning is gone; zzdif102's
 *      second map (an ALIAS-ONLY source, owner C11) compiles with its
 *      `sourceCarriers` naming the alias zzdif192 of element zzdif190.
 *   B. compile laws, hermetic (synthetic tree): a missing table_tipo in an
 *      INSTALLED package, a non-`table` target, a global name equal to a source
 *      table, two nodes under one global name, maps on a non-sql element — each
 *      refuses the element; an uninstalled package is the usual warning; an
 *      alias carrying OTHER own properties inherits the real node's maps
 *      (key-level, v6 :278-287); a map naming a column that exists on NO
 *      carrier REFUSES the element naming the column (owner C11 2026-11-13,
 *      WC-2026-11-12-global-table-maps addendum); a source only an ALIAS
 *      sharing the map carries compiles with `sourceCarriers` = that alias.
 *   C. the row derivation (pure, table-driven): composite key, provenance,
 *      lang kept, single passthrough with JSON decode, '[]' → NULL, multi-source
 *      JSON array, `format:'string'` with custom/default separator, automatic
 *      `section_id`/`lang` sources; a carrier absent from an item's
 *      `sourceCarriers` writes NULL (C11); the key grammar round-trips and
 *      rejects a foreign prefix.
 *   D. a REAL run (runJob → the sql writer → the suite MariaDB): `zzdif_global`
 *      holds one row per (published record, lang) of both sections with a
 *      VARCHAR key; a planted row of the unpublishable record and a planted
 *      stale lang row are gone; a re-run is idempotent and refreshes an edited
 *      value.
 *   E. the record-delete door withdraws the global row and confirms the target;
 *      an executor failing ONLY the global row leaves the target pending.
 *   F. the public-tier reconcile reports a planted global ghost and its apply
 *      removes it.
 *   G. the ALIAS-ONLY source (C11, real run): the real table's rows land in
 *      `zzdif_global_alias_only` with `title` NULL; the alias element's run
 *      (its own database) fills `title` from `extra`; the target's withdraw set
 *      names both global tables; a removed row of the alias-only table IS
 *      missing (publish writes it); an earlier engine's row is a ghost.
 *
 * MUTATIONS (each turns a leg red, measured 2026-11-12): drop the global DELETE
 * in `removeRecords` (D: the 940002 plant survives); key without the section
 * prefix (C, D); confirm a target on its source row alone (E: pending
 * expected); skip the global branch of the reconcile (F: no ghost).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	activityTable,
	deleteDiffusionRecord,
	registerNativeDiffusionSqlDelete,
	resetNativeDiffusionSqlDeleteForTests,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import {
	clearDiffusionTargetsCache,
	getAllSectionDiffusionTargets,
} from '../../src/core/diffusion_bridge/diffusion_map.ts';
import {
	globalRowKey,
	globalRowKeyLikePattern,
	parseGlobalRowKey,
} from '../../src/core/diffusion_bridge/global_tables.ts';
import { deleteJobsForTests, getJobById, listActiveJobs } from '../../src/diffusion/jobs/queue.ts';
import { pauseScheduler, resumeScheduler } from '../../src/diffusion/jobs/scheduler.ts';
import { bumpOntologyRevision } from '../../src/diffusion/plan/cache.ts';
import type { ParserClassifier } from '../../src/diffusion/plan/compile.ts';
import { compileElementPlan, validateElementPlan } from '../../src/diffusion/plan/compile.ts';
import { globalTableNamesOf } from '../../src/diffusion/plan/global_tables.ts';
import type { GlobalTablePlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type {
	OntologyIndex,
	RawOntologyNode,
	VirtualDiffusionTree,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';
import { buildVirtualDiffusionTree } from '../../src/diffusion/plan/virtual_tree.ts';
import { deriveGlobalRows } from '../../src/diffusion/project/global_table.ts';
import type { ProjectedRow } from '../../src/diffusion/project/lang_ladder.ts';
import { runJob } from '../../src/diffusion/runner.ts';
import { closeAllTargetPools, getTargetPool } from '../../src/diffusion/targets/mariadb/db.ts';
import { executeSqlDeleteTargets } from '../../src/diffusion/targets/mariadb/delete_record.ts';
import { listDeclaredPublicationTables } from '../../src/diffusion/targets/mariadb/lang_sweep.ts';
import {
	scanPublicTier,
	unpublishGhosts,
} from '../../src/diffusion/targets/mariadb/public_tier_reconcile.ts';
import { applyTableState } from '../../src/diffusion/targets/mediastore/media_index.ts';
import { enqueueClaimSeeded } from '../helpers/diffusion_job_harness.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { databasesOf, requireSuiteMariadb } from '../helpers/suite_mariadb.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_EXTRA_PUBLISHABLE_IDS,
	ZZDIF_GLOBAL_ALIAS_DATABASE,
	ZZDIF_GLOBAL_ALIAS_ELEMENT,
	ZZDIF_GLOBAL_ALIAS_ONLY_COLUMN,
	ZZDIF_GLOBAL_ALIAS_ONLY_TABLE,
	ZZDIF_GLOBAL_ALIAS_ONLY_TABLE_TIPO,
	ZZDIF_GLOBAL_ALIAS_TABLE,
	ZZDIF_GLOBAL_ALIAS_TABLE_TIPO,
	ZZDIF_GLOBAL_DATABASE,
	ZZDIF_GLOBAL_ELEMENT,
	ZZDIF_GLOBAL_LINKED_TABLE,
	ZZDIF_GLOBAL_PRIMARY_TABLE,
	ZZDIF_GLOBAL_SEPARATOR,
	ZZDIF_GLOBAL_TABLE,
	ZZDIF_GLOBAL_TABLE_TIPO,
	ZZDIF_LINKED_IDS,
	ZZDIF_LINKED_SECTION,
	ZZDIF_PUBLISHABLE_ID,
	ZZDIF_SECTION,
	ZZDIF_SITUATION,
	ZZDIF_UNPUBLISHABLE_ID,
} from '../helpers/zzdif_diffusion_domain.ts';

const runtimeClassifier: ParserClassifier = () => 'runtime';
const OWNER = -1;
const PUBLISHABLE_IDS = [ZZDIF_PUBLISHABLE_ID, ...ZZDIF_EXTRA_PUBLISHABLE_IDS];

// ── B: the hermetic compile situation ───────────────────────────────────────────

/** No install has this TLD in dd_ontology → "package not installed". */
const ABSENT_TLD = 'absentglobalpkg';

interface Raw {
	model: string;
	label: string;
	properties?: Record<string, unknown> | null;
	children?: string[];
}

function rawNode(tipo: string, raw: Raw): RawOntologyNode {
	return {
		tipo,
		parent: null,
		model: raw.model,
		term: { 'lg-eng': raw.label },
		properties: raw.properties ?? null,
		relations: null,
	};
}

/** The global node every hermetic case maps to (+ a field_text decoy and a namesake). */
const BASE_RAW: Record<string, Raw> = {
	ddgtm20: { model: 'table', label: 'gt_global', children: ['ddgtm21', 'ddgtm22', 'ddgtm23'] },
	ddgtm21: { model: 'field_varchar', label: 'section_id', properties: { varchar: 32 } },
	ddgtm22: { model: 'field_int', label: 'ref_section_id' },
	ddgtm23: { model: 'field_text', label: 'title' },
	ddgtm30: { model: 'field_text', label: 'not_a_table' },
	ddgtm40: { model: 'table', label: 'gt_source_a', children: ['ddgtm23'] },
	ddgtm50: { model: 'table', label: 'gt_global', children: ['ddgtm23'] },
	ddgtm9: { model: 'field_varchar', label: 'title' },
	ddgtm8: { model: 'field_varchar', label: 'extra' },
};

const titleMap = (tableTipo: string, target = 'title', source = 'title') => [
	{ table_tipo: tableTipo, columns_map: [{ target_column: target, source_columns: [source] }] },
];

interface TableCase {
	tipo: string;
	label: string;
	section: string;
	/** The node's OWN raw properties (what dd_ontology holds). */
	own: Record<string, unknown> | null;
	/** Alias case: the real table node the alias points at. */
	realTipo?: string;
	realProperties?: Record<string, unknown>;
	/** The node's DIRECT children (default: the one 'title' field ddgtm9). */
	children?: string[];
}

const ELEMENT_PATH = (format: string) => ({
	tipo: 'ddgtm1',
	model: 'diffusion_element',
	label: 'gt_element',
	realTipo: null,
	type: format,
});

function makeTree(tables: TableCase[], format: 'sql' | 'xml' = 'sql'): VirtualDiffusionTree {
	const raw: Record<string, RawOntologyNode> = {};
	const children: Record<string, string[]> = {};
	for (const [tipo, node] of Object.entries(BASE_RAW)) {
		raw[tipo] = rawNode(tipo, node);
		children[tipo] = node.children ?? [];
	}
	for (const table of tables) {
		raw[table.tipo] = rawNode(table.tipo, {
			model: table.realTipo !== undefined ? 'table_alias' : 'table',
			label: table.label,
			properties: table.own,
		});
		// A real node already in the tree (another TableCase) keeps its own row.
		if (table.realTipo !== undefined && raw[table.realTipo] === undefined) {
			raw[table.realTipo] = rawNode(table.realTipo, {
				model: 'table',
				label: `${table.label}_real`,
				properties: table.realProperties ?? null,
			});
		}
	}
	const index: OntologyIndex = {
		nodeOf: async (tipo) => raw[tipo] ?? null,
		childTipos: async (tipo) => children[tipo] ?? [],
		relatedByModel: async () => [],
		relationTipos: async () => [],
		resolveAlias: async () => null,
	};
	const element: VirtualTreeNode = {
		tipo: 'ddgtm1',
		model: 'diffusion_element',
		label: 'gt_element',
		properties:
			format === 'sql'
				? { diffusion: { type: 'sql' } }
				: { diffusion: { type: 'xml', service_name: 'gtm' } },
		realTipo: null,
		isAlias: false,
		parents: [],
		childrenTipos: [],
		directChildrenTipos: [],
		relatedSections: [],
	};
	const database: VirtualTreeNode = {
		...element,
		tipo: 'ddgtm2',
		model: 'database',
		label: 'gt_db',
		properties: null,
		parents: [ELEMENT_PATH(format)],
	};
	const tableNodes = tables.map(
		(table): VirtualTreeNode => ({
			tipo: table.tipo,
			model: table.realTipo !== undefined ? 'table_alias' : 'table',
			label: table.label,
			// The virtual tree's whole-bag rule: own when non-empty, else the real's.
			properties:
				table.own !== null && Object.keys(table.own).length > 0
					? table.own
					: (table.realProperties ?? null),
			realTipo: table.realTipo ?? null,
			isAlias: table.realTipo !== undefined,
			parents: [
				{ tipo: 'ddgtm2', model: 'database', label: 'gt_db', realTipo: null },
				ELEMENT_PATH(format),
			],
			childrenTipos: table.children ?? ['ddgtm9'],
			directChildrenTipos: table.children ?? ['ddgtm9'],
			relatedSections: [table.section],
		}),
	);
	return {
		domainName: 'gt_domain',
		domainTipo: 'ddgtm0',
		nodes: [element, database, ...tableNodes],
		index,
	} as VirtualDiffusionTree;
}

const sourceTable = (own: Record<string, unknown> | null): TableCase => ({
	tipo: 'ddgtm3',
	label: 'gt_source',
	section: 'ddgtm10',
	own,
});

async function validate(tree: VirtualDiffusionTree) {
	return validateElementPlan('ddgtm1', { tree, classifyParserFn: runtimeClassifier });
}

describe('B — compile laws (hermetic)', () => {
	test('a well-formed map compiles: anatomy, key length, provenance, maps', async () => {
		const plan = await compileElementPlan('ddgtm1', {
			tree: makeTree([sourceTable({ global_table_maps: titleMap('ddgtm20') })]),
			classifyParserFn: runtimeClassifier,
		});
		const global = plan.sections[0]?.globalTables?.[0] as GlobalTablePlan;
		expect(global.tableTipo).toBe('ddgtm20');
		expect(global.schema.tableName).toBe('gt_global');
		expect(global.schema.fields.map((field) => field.columnName)).toEqual([
			'ref_section_id',
			'title',
		]);
		expect(global.keyLength).toBe(32);
		expect(global.provenance).toEqual(['ref_section_id']);
		expect(global.columnsMap).toEqual([{ targetColumn: 'title', sourceColumns: ['title'] }]);
		expect(plan.warnings.filter((warning) => warning.startsWith('global_table_maps'))).toEqual([]);
	});

	const refusals: [string, TableCase[], 'sql' | 'xml', RegExp][] = [
		[
			'table_tipo missing in an INSTALLED package',
			[sourceTable({ global_table_maps: titleMap('dd999999') })],
			'sql',
			/table_tipo 'dd999999' not found in the ontology/,
		],
		[
			'table_tipo is not a table node',
			[sourceTable({ global_table_maps: titleMap('ddgtm30') })],
			'sql',
			/'ddgtm30' is a 'field_text', not a 'table' node/,
		],
		[
			'a map entry without table_tipo',
			[sourceTable({ global_table_maps: [{ columns_map: [] }] })],
			'sql',
			/global_table_maps entry without table_tipo/,
		],
		[
			'the global name is a source table of the element',
			[
				sourceTable({ global_table_maps: titleMap('ddgtm20') }),
				{ tipo: 'ddgtm7', label: 'gt_global', section: 'ddgtm11', own: null },
			],
			'sql',
			/global table 'gt_global' \(ddgtm20\) has the name of a source table/,
		],
		[
			'two different nodes under one global name',
			[
				sourceTable({ global_table_maps: titleMap('ddgtm20') }),
				{
					tipo: 'ddgtm7',
					label: 'gt_source_b',
					section: 'ddgtm11',
					own: { global_table_maps: titleMap('ddgtm50') },
				},
			],
			'sql',
			/global table name 'gt_global' is declared by two different nodes/,
		],
		[
			'maps on a non-sql element',
			[sourceTable({ global_table_maps: titleMap('ddgtm20') })],
			'xml',
			/global_table_maps on a non-sql element/,
		],
	];
	for (const [name, tables, format, error] of refusals) {
		test(`refused: ${name}`, async () => {
			const report = await validate(makeTree(tables, format));
			expect(report.result).toBeNull();
			expect(report.errors.some((line) => error.test(line))).toBe(true);
		});
	}

	test('an uninstalled package is a warning: the map is skipped, the element compiles', async () => {
		const report = await validate(
			makeTree([sourceTable({ global_table_maps: titleMap(`${ABSENT_TLD}1`) })]),
		);
		expect(report.errors).toEqual([]);
		expect(report.warnings).toContain(`uninstalled-tld:${ABSENT_TLD}@${ABSENT_TLD}1`);
		expect(report.result?.sections[0]?.globalTables).toBeUndefined();
	});

	test("an alias carrying OTHER own properties still inherits the real node's maps (key-level)", async () => {
		const report = await validate(
			makeTree([
				{
					...sourceTable({ is_publishable: true }),
					realTipo: 'ddgtm6',
					realProperties: { global_table_maps: titleMap('ddgtm20') },
				},
			]),
		);
		expect(report.errors).toEqual([]);
		expect(report.result?.sections[0]?.globalTables?.[0]?.schema.tableName).toBe('gt_global');
	});

	test('C11: a map naming a column that exists on NO carrier REFUSES the element, naming the column', async () => {
		// RED before: the map was silently not written, a `global_table_maps_unruled:` warning.
		const report = await validate(
			makeTree([
				sourceTable({
					global_table_maps: [
						{
							table_tipo: 'ddgtm20',
							columns_map: [
								{ target_column: 'filter_date', source_columns: ['title'] },
								{ target_column: 'title', source_columns: ['coins'] },
							],
						},
					],
				}),
			]),
		);
		expect(report.result).toBeNull();
		const line = report.errors.find((candidate) => candidate.includes('exist on no carrier'));
		expect(line).toBeDefined();
		expect(line).toContain("target 'filter_date'");
		expect(line).toContain("source 'coins' (→ title)");
		expect(line).toContain('carriers: ddgtm3 (title)');
		expect(report.warnings.filter((warning) => warning.includes('global_table_maps'))).toEqual([]);
	});

	test('C11: a source only an ALIAS sharing the map carries compiles — stamped with that carrier', async () => {
		const plan = await compileElementPlan('ddgtm1', {
			tree: makeTree([
				sourceTable({
					global_table_maps: [
						{
							table_tipo: 'ddgtm20',
							columns_map: [
								{ target_column: 'title', source_columns: ['title'] },
								{ target_column: 'ref_section_id', source_columns: ['extra'] },
							],
						},
					],
				}),
				// the alias: real ddgtm3's children + its own `extra`; no own maps → shares
				{
					tipo: 'ddgtm7',
					label: 'gt_source_alias',
					section: 'ddgtm11',
					own: null,
					realTipo: 'ddgtm3',
					children: ['ddgtm9', 'ddgtm8'],
				},
			]),
			classifyParserFn: runtimeClassifier,
		});
		const real = plan.sections.find((section) => section.tableTipo === 'ddgtm3');
		const alias = plan.sections.find((section) => section.tableTipo === 'ddgtm7');
		expect(real?.globalTables?.[0]?.columnsMap).toEqual([
			{ targetColumn: 'title', sourceColumns: ['title'] },
			{ targetColumn: 'ref_section_id', sourceColumns: ['extra'], sourceCarriers: ['ddgtm7'] },
		]);
		// the alias compiles the SAME map (inherited): every carrier has `title`, only it has `extra`
		expect(alias?.globalTables?.[0]?.columnsMap).toEqual(real?.globalTables?.[0]?.columnsMap);
		// the pure derivation: the real's rows write NULL there, the alias's rows the value
		const map = real?.globalTables?.[0] as GlobalTablePlan;
		const row: ProjectedRow = { sectionId: 1, lang: 'lg-eng', columns: { title: 'T', extra: 'E' } };
		expect(deriveGlobalRows(real as SectionPlan, map, [row])[0]?.columns).toEqual({
			title: 'T',
			ref_section_id: null,
		});
		expect(deriveGlobalRows(alias as SectionPlan, map, [row])[0]?.columns).toEqual({
			title: 'T',
			ref_section_id: 'E',
		});
	});

	test('the lang sweep declares the global tables a maps value names', async () => {
		const tree = makeTree([]);
		expect(await globalTableNamesOf(tree.index, titleMap('ddgtm20'))).toEqual(['gt_global']);
		expect(await globalTableNamesOf(tree.index, titleMap('ddgtm30'))).toEqual([]);
	});

	test('listDeclaredPublicationTables declares a global node OUTSIDE the domain subtree', async () => {
		// ddgtm20 lives only in the index, not in tree.nodes: the walk over the
		// domain's table nodes alone cannot find it — only the maps can.
		const tree = makeTree([sourceTable({ global_table_maps: titleMap('ddgtm20') })]);
		expect(tree.nodes.some((node) => node.tipo === 'ddgtm20')).toBe(false);
		const declared = await listDeclaredPublicationTables(tree);
		expect([...declared].sort()).toEqual(['gt_global', 'gt_source']);
		// A map to a non-table node declares nothing (publish never creates it).
		const decoy = makeTree([sourceTable({ global_table_maps: titleMap('ddgtm30') })]);
		expect([...(await listDeclaredPublicationTables(decoy))]).toEqual(['gt_source']);
	});
});

// ── C: the pure row derivation ──────────────────────────────────────────────────

describe('C — global row derivation (pure)', () => {
	const section: SectionPlan = {
		sectionTipo: 'test3',
		tableName: 'src_table',
		tableTipo: 'x1',
		fields: [],
	};
	const global = (
		columnsMap: GlobalTablePlan['columnsMap'],
		provenance: GlobalTablePlan['provenance'] = [],
	): GlobalTablePlan => ({
		tableTipo: 'x2',
		schema: { sectionTipo: '', tableName: 'g', tableTipo: 'x2', fields: [] },
		keyLength: 64,
		provenance,
		columnsMap,
	});
	const row: ProjectedRow = {
		sectionId: 7,
		lang: 'lg-eng',
		columns: {
			title: 'Title',
			code: 'C-1',
			json: '["a","b"]',
			empty: '[]',
			number: '42',
			none: null,
		},
	};
	const one = (map: GlobalTablePlan['columnsMap'][number]) =>
		deriveGlobalRows(section, global([map]), [row])[0]?.columns[map.targetColumn];

	test('key, lang and every provenance column', () => {
		const [derived] = deriveGlobalRows(
			section,
			global([], ['ref_section_id', 'ref_section_tipo', 'ref_table', 'link']),
			[row],
		);
		expect(derived?.sectionId).toBe('test3_7');
		expect(derived?.lang).toBe('lg-eng');
		expect(derived?.columns).toEqual({
			ref_section_id: '7',
			ref_section_tipo: 'test3',
			ref_table: 'src_table',
			link: '{"table":"src_table","section_id":7}',
		});
	});

	test('undeclared provenance columns are not written', () => {
		const [derived] = deriveGlobalRows(section, global([], ['ref_table']), [row]);
		expect(Object.keys(derived?.columns ?? {})).toEqual(['ref_table']);
	});

	const cases: [string, GlobalTablePlan['columnsMap'][number], string | null][] = [
		['plain single source', { targetColumn: 't', sourceColumns: ['title'] }, 'Title'],
		[
			'JSON single source decoded + re-encoded',
			{ targetColumn: 't', sourceColumns: ['json'] },
			'["a","b"]',
		],
		["'[]' → NULL", { targetColumn: 't', sourceColumns: ['empty'] }, null],
		['null source → NULL', { targetColumn: 't', sourceColumns: ['none'] }, null],
		['numeric string', { targetColumn: 't', sourceColumns: ['number'] }, '42'],
		['automatic section_id', { targetColumn: 't', sourceColumns: ['section_id'] }, '7'],
		['automatic lang', { targetColumn: 't', sourceColumns: ['lang'] }, 'lg-eng'],
		[
			'two sources → JSON array (null kept)',
			{ targetColumn: 't', sourceColumns: ['title', 'none'] },
			'["Title",null]',
		],
		[
			'two sources incl. decoded JSON → nested array',
			{ targetColumn: 't', sourceColumns: ['code', 'json'] },
			'["C-1",["a","b"]]',
		],
		[
			"format string, default separator ' | '",
			{ targetColumn: 't', sourceColumns: ['title', 'code'], format: 'string' },
			'Title | C-1',
		],
		[
			'format string, custom separator, array joined by |',
			{
				targetColumn: 't',
				sourceColumns: ['title', 'json', 'none'],
				format: 'string',
				separator: ' · ',
			},
			'Title · a|b · ',
		],
	];
	for (const [name, map, expected] of cases) {
		test(`map: ${name}`, () => {
			expect(one(map)).toBe(expected);
		});
	}

	test('C11: a carrier absent from the item sourceCarriers writes NULL; a named one the value', () => {
		const map = { targetColumn: 't', sourceColumns: ['title'], sourceCarriers: ['other_alias'] };
		expect(one(map)).toBeNull();
		expect(one({ ...map, sourceCarriers: ['other_alias', section.tableTipo] })).toBe('Title');
	});

	test('the key grammar round-trips and rejects a foreign or malformed key', () => {
		expect(globalRowKey('test3', 940001)).toBe('test3_940001');
		expect(parseGlobalRowKey('test3_940001', 'test3')).toBe(940001);
		expect(parseGlobalRowKey('test3_940001', 'test')).toBeNull();
		expect(parseGlobalRowKey('test30_1', 'test3')).toBeNull();
		expect(parseGlobalRowKey('test3_x1', 'test3')).toBeNull();
		expect(globalRowKeyLikePattern('test3')).toBe('test3\\_%');
	});
});

// ── A, D, E, F: the zzdif situation, a real run, the doors ─────────────────────

const savedEnv: Record<string, string | undefined> = {};
const createdJobIds: string[] = [];
function setEnv(key: string, value: string): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	process.env[key] = value;
}

function pool() {
	return getTargetPool(ZZDIF_GLOBAL_DATABASE);
}

/** The alias element's own database (C11: the alias's rows land there). */
function aliasPool() {
	return getTargetPool(ZZDIF_GLOBAL_ALIAS_DATABASE);
}

interface GlobalRow {
	section_id: string;
	lang: string | null;
	ref_section_id: number | null;
	ref_section_tipo: string | null;
	ref_table: string | null;
	link: string | null;
	title: string | null;
	title_code: string | null;
	both: string | null;
	sort_id: number | null;
}

async function globalRows(): Promise<GlobalRow[]> {
	try {
		return (await pool().unsafe(
			`SELECT * FROM \`${ZZDIF_GLOBAL_TABLE}\` ORDER BY section_id, lang`,
			[],
		)) as GlobalRow[];
	} catch (error) {
		if ((error as { errno?: number }).errno === 1146) return [];
		throw error;
	}
}

async function globalKeys(): Promise<string[]> {
	return [...new Set((await globalRows()).map((row) => row.section_id))].sort();
}

async function sourceTitles(table: string, column: string): Promise<Map<string, string | null>> {
	const rows = (await pool().unsafe(
		`SELECT section_id, lang, \`${column}\` AS value FROM \`${table}\``,
		[],
	)) as { section_id: number; lang: string | null; value: string | null }[];
	return new Map(rows.map((row) => [`${row.section_id}|${row.lang}`, row.value]));
}

async function runElement(
	sectionTipo: string,
	elementTipo: string = ZZDIF_GLOBAL_ELEMENT,
): Promise<void> {
	const job = await enqueueClaimSeeded(
		{ elementTipo, sectionTipo, type: 'sql', ownerUserId: OWNER },
		createdJobIds,
	);
	await runJob(job.job_id, job.attempt);
	const finished = await getJobById(job.job_id);
	expect(finished?.state, JSON.stringify(finished?.totals)).toBe('completed');
}

async function clearActivity(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${activityTable()}" WHERE section_tipo = 'dd1758'
		   AND relation->'dd1763'->0->>'section_tipo' = ANY($1::text[])`,
		[`{${ZZDIF_SECTION},${ZZDIF_LINKED_SECTION}}`],
	);
}

async function dropTables(): Promise<void> {
	for (const table of [
		ZZDIF_GLOBAL_PRIMARY_TABLE,
		ZZDIF_GLOBAL_LINKED_TABLE,
		ZZDIF_GLOBAL_TABLE,
		ZZDIF_GLOBAL_ALIAS_ONLY_TABLE,
	])
		await pool().unsafe(`DROP TABLE IF EXISTS \`${table}\``, []);
	for (const table of [ZZDIF_GLOBAL_ALIAS_TABLE, ZZDIF_GLOBAL_TABLE, ZZDIF_GLOBAL_ALIAS_ONLY_TABLE])
		await aliasPool().unsafe(`DROP TABLE IF EXISTS \`${table}\``, []);
}

beforeAll(async () => {
	await requireSuiteMariadb(import.meta.path, databasesOf(ZZDIF_SITUATION));
	await ensureDiffusionScratchTables();
	pauseScheduler();
	await ensureZzdifDomain();
	setEnv('DEDALO_DIFFUSION_DOMAIN', ZZDIF_DOMAIN_NAME);
	bumpOntologyRevision();
	clearDiffusionTargetsCache();
	const stale = (await listActiveJobs()).filter((row) => row.state === 'queued');
	await deleteJobsForTests(stale.map((row) => row.job_id));
	await clearActivity();
	await dropTables();
}, 120_000);

afterAll(async () => {
	const failures: unknown[] = [];
	const step = async (work: () => unknown): Promise<void> => {
		try {
			await work();
		} catch (error) {
			failures.push(error);
		}
	};
	await step(() => resetNativeDiffusionSqlDeleteForTests());
	await step(() => deleteJobsForTests(createdJobIds));
	// The source tables' media markers (writeRows applied them).
	await step(() =>
		applyTableState(
			ZZDIF_GLOBAL_DATABASE,
			ZZDIF_GLOBAL_PRIMARY_TABLE,
			ZZDIF_SECTION,
			[],
			[...PUBLISHABLE_IDS, ZZDIF_UNPUBLISHABLE_ID],
		),
	);
	await step(() =>
		applyTableState(
			ZZDIF_GLOBAL_DATABASE,
			ZZDIF_GLOBAL_LINKED_TABLE,
			ZZDIF_LINKED_SECTION,
			[],
			[...ZZDIF_LINKED_IDS],
		),
	);
	await step(() =>
		applyTableState(
			ZZDIF_GLOBAL_ALIAS_DATABASE,
			ZZDIF_GLOBAL_ALIAS_TABLE,
			ZZDIF_SECTION,
			[],
			[...PUBLISHABLE_IDS, ZZDIF_UNPUBLISHABLE_ID],
		),
	);
	await step(() => dropTables());
	await step(() => closeAllTargetPools());
	await step(() => clearActivity());
	await step(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	await step(() => bumpOntologyRevision());
	await step(() => clearDiffusionTargetsCache());
	await step(() => resumeScheduler());
	await step(async () => {
		const residue = await dropZzdifDomain();
		if (residue !== 0) throw new Error(`zzdif situation residue after drop: ${residue} rows`);
	});
	if (failures.length > 0) throw new AggregateError(failures, 'diffusion_global_table teardown');
}, 120_000);

describe('A — compile on the zzdif global element (real dd_ontology rows)', () => {
	test('both source sections carry the compiled global table; the alias-only map compiles with its carrier (C11)', async () => {
		const tree = await buildVirtualDiffusionTree(ZZDIF_DOMAIN_NAME);
		if (tree === null) throw new Error('zzdif domain not found');
		const plan = await compileElementPlan(ZZDIF_GLOBAL_ELEMENT, { tree });
		expect(plan.warnings.filter((warning) => warning.startsWith('global_table_maps'))).toEqual([]);
		const primary = plan.sections.find((section) => section.sectionTipo === ZZDIF_SECTION);
		// Both maps compile: the ruled one and (C11) the alias-only one.
		expect(primary?.globalTables?.length).toBe(2);
		const global = primary?.globalTables?.[0];
		expect(global?.tableTipo).toBe(ZZDIF_GLOBAL_TABLE_TIPO);
		expect(global?.schema.tableName).toBe(ZZDIF_GLOBAL_TABLE);
		expect(global?.keyLength).toBe(64);
		expect(global?.provenance).toEqual(['ref_section_id', 'ref_section_tipo', 'ref_table', 'link']);
		expect(global?.columnsMap.map((map) => map.targetColumn)).toEqual([
			'title',
			'title_code',
			'both',
			'sort_id',
		]);
		expect(global?.columnsMap.every((map) => map.sourceCarriers === undefined)).toBe(true);
		const aliasOnly = primary?.globalTables?.[1];
		expect(aliasOnly?.tableTipo).toBe(ZZDIF_GLOBAL_ALIAS_ONLY_TABLE_TIPO);
		expect(aliasOnly?.schema.tableName).toBe(ZZDIF_GLOBAL_ALIAS_ONLY_TABLE);
		expect(aliasOnly?.columnsMap).toEqual([
			{
				targetColumn: 'title',
				sourceColumns: [ZZDIF_GLOBAL_ALIAS_ONLY_COLUMN],
				sourceCarriers: [ZZDIF_GLOBAL_ALIAS_TABLE_TIPO],
			},
		]);
		const linked = plan.sections.find((section) => section.sectionTipo === ZZDIF_LINKED_SECTION);
		expect(linked?.globalTables?.[0]?.columnsMap).toEqual([
			{ targetColumn: 'title', sourceColumns: ['name'] },
		]);
		// The alias element compiles the SAME shared maps for its alias table.
		const aliasPlan = await compileElementPlan(ZZDIF_GLOBAL_ALIAS_ELEMENT, { tree });
		const alias = aliasPlan.sections.find((section) => section.sectionTipo === ZZDIF_SECTION);
		expect(alias?.tableTipo).toBe(ZZDIF_GLOBAL_ALIAS_TABLE_TIPO);
		expect(alias?.fields.map((field) => field.columnName)).toContain(
			ZZDIF_GLOBAL_ALIAS_ONLY_COLUMN,
		);
		expect(alias?.globalTables?.map((table) => table.schema.tableName)).toEqual([
			ZZDIF_GLOBAL_TABLE,
			ZZDIF_GLOBAL_ALIAS_ONLY_TABLE,
		]);
		expect(alias?.globalTables?.[1]?.columnsMap).toEqual(aliasOnly?.columnsMap);
	});
});

describe('D — a real run writes, withdraws and refreshes the global rows', () => {
	test('publish both sections: one row per (record, lang), VARCHAR key, plants removed, idempotent', async () => {
		// Pre-create the global table through a first run, then plant what a
		// previous publication would have left behind.
		await runElement(ZZDIF_SECTION);
		const langs = config.diffusion.langs;
		const firstLang = langs[0] ?? null;
		await pool().unsafe(
			`INSERT INTO \`${ZZDIF_GLOBAL_TABLE}\` (section_id, lang, title) VALUES (?, ?, 'ghost'), (?, 'lg-zzz', 'stale lang')`,
			[
				globalRowKey(ZZDIF_SECTION, ZZDIF_UNPUBLISHABLE_ID),
				firstLang,
				globalRowKey(ZZDIF_SECTION, ZZDIF_PUBLISHABLE_ID),
			],
		);
		await pool().unsafe(
			`UPDATE \`${ZZDIF_GLOBAL_TABLE}\` SET title = 'edited' WHERE section_id = ?`,
			[globalRowKey(ZZDIF_SECTION, ZZDIF_EXTRA_PUBLISHABLE_IDS[0])],
		);

		await runElement(ZZDIF_SECTION);
		await runElement(ZZDIF_LINKED_SECTION);

		const expectedKeys = [
			...PUBLISHABLE_IDS.map((id) => globalRowKey(ZZDIF_SECTION, id)),
			...ZZDIF_LINKED_IDS.map((id) => globalRowKey(ZZDIF_LINKED_SECTION, id)),
		].sort();
		expect(await globalKeys()).toEqual(expectedKeys);

		const rows = await globalRows();
		expect(
			rows.some((row) => row.lang === 'lg-zzz'),
			'the stale lang row survived',
		).toBe(false);
		expect(rows.length).toBe(expectedKeys.length * langs.length);

		const titles = await sourceTitles(ZZDIF_GLOBAL_PRIMARY_TABLE, 'title');
		const codes = await sourceTitles(ZZDIF_GLOBAL_PRIMARY_TABLE, 'code');
		const primaryRows = rows.filter((candidate) => candidate.ref_section_tipo === ZZDIF_SECTION);
		const linkedRows = rows.filter(
			(candidate) => candidate.ref_section_tipo === ZZDIF_LINKED_SECTION,
		);
		// Floors: the per-row loops below must have rows to judge.
		expect(primaryRows.length).toBeGreaterThan(0);
		expect(linkedRows.length).toBeGreaterThan(0);
		for (const row of primaryRows) {
			const id = Number(row.ref_section_id);
			const title = titles.get(`${id}|${row.lang}`) ?? null;
			const code = codes.get(`${id}|${row.lang}`) ?? null;
			expect(title, `source title of ${id} ${row.lang}`).not.toBeNull();
			expect(row.section_id).toBe(globalRowKey(ZZDIF_SECTION, id));
			expect(row.title).toBe(title);
			expect(row.title_code).toBe(`${title}${ZZDIF_GLOBAL_SEPARATOR}${code}`);
			expect(row.both).toBe(JSON.stringify([title, code]));
			expect(Number(row.sort_id)).toBe(id);
			expect(row.ref_table).toBe(ZZDIF_GLOBAL_PRIMARY_TABLE);
			expect(JSON.parse(row.link ?? 'null')).toEqual({
				table: ZZDIF_GLOBAL_PRIMARY_TABLE,
				section_id: id,
			});
		}
		const names = await sourceTitles(ZZDIF_GLOBAL_LINKED_TABLE, 'name');
		for (const row of linkedRows) {
			expect(row.title).toBe(names.get(`${row.ref_section_id}|${row.lang}`) ?? null);
			expect(row.ref_table).toBe(ZZDIF_GLOBAL_LINKED_TABLE);
		}

		const [keyColumn] = (await pool().unsafe(
			`SELECT COLUMN_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
			 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'section_id'`,
			[ZZDIF_GLOBAL_DATABASE, ZZDIF_GLOBAL_TABLE],
		)) as { type: string }[];
		expect(String(keyColumn?.type).toLowerCase()).toBe('varchar(64)');

		// Idempotent: a re-run leaves the same rows.
		await runElement(ZZDIF_SECTION);
		expect((await globalRows()).length).toBe(rows.length);
	}, 120_000);
});

describe('E — the record-delete door withdraws the global row', () => {
	const primaryKey = `${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_PRIMARY_TABLE}`;

	test('deleted with its source row; the target is confirmed', async () => {
		registerNativeDiffusionSqlDelete(executeSqlDeleteTargets);
		clearDiffusionTargetsCache();
		const id = ZZDIF_EXTRA_PUBLISHABLE_IDS[1] as number;
		expect(await globalKeys()).toContain(globalRowKey(ZZDIF_SECTION, id));
		const outcome = await deleteDiffusionRecord(ZZDIF_SECTION, id, false);
		expect(outcome.deleted).toContain(primaryKey);
		expect(await globalKeys()).not.toContain(globalRowKey(ZZDIF_SECTION, id));
	});

	test('an executor that fails ONLY the global row leaves the target pending', async () => {
		const id = ZZDIF_EXTRA_PUBLISHABLE_IDS[2] as number;
		registerNativeDiffusionSqlDelete(async (targets) => {
			const result = await executeSqlDeleteTargets(
				targets.filter((target) => target.table_name !== ZZDIF_GLOBAL_TABLE),
			);
			if (targets.some((target) => target.table_name === ZZDIF_GLOBAL_TABLE)) {
				result.errors.push(`${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_TABLE}: planted failure`);
			}
			return result;
		});
		try {
			const outcome = await deleteDiffusionRecord(ZZDIF_SECTION, id, false);
			expect(outcome.deleted).not.toContain(primaryKey);
			expect(outcome.pending).toContain(primaryKey);
			expect(await globalKeys()).toContain(globalRowKey(ZZDIF_SECTION, id));
		} finally {
			registerNativeDiffusionSqlDelete(executeSqlDeleteTargets);
		}
	});
});

describe('F — the public-tier reconcile finds and removes a global ghost', () => {
	test('a planted global row of an absent record is a ghost; apply removes it', async () => {
		const absentId = 949999;
		const ghostKey = globalRowKey(ZZDIF_SECTION, absentId);
		await pool().unsafe(
			`INSERT INTO \`${ZZDIF_GLOBAL_TABLE}\` (section_id, lang, title) VALUES (?, ?, 'ghost')`,
			[ghostKey, config.diffusion.langs[0] ?? null],
		);
		clearDiffusionTargetsCache();
		const scan = await scanPublicTier([ZZDIF_SECTION]);
		const ghosts = scan.ghosts.filter(
			(ghost) => ghost.target === `${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_TABLE}`,
		);
		expect(ghosts).toEqual([
			{
				store: 'mariadb',
				target: `${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_TABLE}`,
				section_tipo: ZZDIF_SECTION,
				section_id: absentId,
				reason: 'record_absent',
				global: true,
			},
		]);
		const applied = await unpublishGhosts(ghosts);
		expect(applied.failed).toEqual([]);
		expect(applied.removed).toBe(1);
		expect(await globalKeys()).not.toContain(ghostKey);
	});
});

describe('G — the ALIAS-ONLY source (C11): real rows NULL, alias rows fill; withdrawn; owed', () => {
	const aliasOnlyKey = `${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_ALIAS_ONLY_TABLE}`;
	const globalKey = `${ZZDIF_GLOBAL_DATABASE}|${ZZDIF_GLOBAL_TABLE}`;

	async function aliasOnlyTitles(db: ReturnType<typeof pool>): Promise<Map<string, string | null>> {
		const rows = (await db.unsafe(
			`SELECT section_id, lang, title FROM \`${ZZDIF_GLOBAL_ALIAS_ONLY_TABLE}\``,
			[],
		)) as { section_id: string; lang: string | null; title: string | null }[];
		return new Map(rows.map((row) => [`${row.section_id}|${row.lang}`, row.title]));
	}

	test("the target names both global tables (the WITHDRAW set is the maps' tables)", async () => {
		clearDiffusionTargetsCache();
		const targets = (await getAllSectionDiffusionTargets()).get(ZZDIF_SECTION) ?? [];
		const primary = targets.find((target) => target.table_name === ZZDIF_GLOBAL_PRIMARY_TABLE);
		expect(primary?.global_tables).toEqual([ZZDIF_GLOBAL_TABLE, ZZDIF_GLOBAL_ALIAS_ONLY_TABLE]);
		const alias = targets.find((target) => target.table_name === ZZDIF_GLOBAL_ALIAS_TABLE);
		expect(alias?.database_name).toBe(ZZDIF_GLOBAL_ALIAS_DATABASE);
		expect(alias?.global_tables).toEqual([ZZDIF_GLOBAL_TABLE, ZZDIF_GLOBAL_ALIAS_ONLY_TABLE]);
	});

	test("the real table's run writes the alias-only table with NULL; the alias's run fills it from `extra`", async () => {
		await runElement(ZZDIF_SECTION);
		const realTitles = await aliasOnlyTitles(pool());
		// floor: one row per (published record, lang)
		expect(realTitles.size).toBe(PUBLISHABLE_IDS.length * config.diffusion.langs.length);
		for (const [key, title] of realTitles) {
			expect(title, `real run wrote a value for ${key}`).toBeNull();
		}
		await runElement(ZZDIF_SECTION, ZZDIF_GLOBAL_ALIAS_ELEMENT);
		const aliasTitles = await aliasOnlyTitles(aliasPool());
		expect(aliasTitles.size).toBe(realTitles.size);
		// 940001 carries zzdif4 (the alias's `extra` source); the fillers do not
		const filled = [...aliasTitles].filter(([, title]) => title !== null);
		expect(filled.map(([key]) => key.split('|')[0])).toEqual(
			config.diffusion.langs.map(() => globalRowKey(ZZDIF_SECTION, ZZDIF_PUBLISHABLE_ID)),
		);
		expect(filled.every(([, title]) => (title ?? '').includes('summary'))).toBe(true);
		// the alias's SOURCE row carries the column too
		const [source] = (await aliasPool().unsafe(
			`SELECT \`${ZZDIF_GLOBAL_ALIAS_ONLY_COLUMN}\` AS extra FROM \`${ZZDIF_GLOBAL_ALIAS_TABLE}\` WHERE section_id = ? LIMIT 1`,
			[ZZDIF_PUBLISHABLE_ID],
		)) as { extra: string | null }[];
		expect(source?.extra ?? '').toContain('summary');
	}, 120_000);

	test('a row of the alias-only table removed behind publish IS missing (publish writes it); the ruled table too', async () => {
		const removedId = ZZDIF_PUBLISHABLE_ID;
		for (const table of [ZZDIF_GLOBAL_TABLE, ZZDIF_GLOBAL_ALIAS_ONLY_TABLE]) {
			await pool().unsafe(`DELETE FROM \`${table}\` WHERE section_id = ?`, [
				globalRowKey(ZZDIF_SECTION, removedId),
			]);
		}
		clearDiffusionTargetsCache();
		const scan = await scanPublicTier([ZZDIF_SECTION]);
		for (const key of [globalKey, aliasOnlyKey]) {
			expect(
				scan.missing.filter((entry) => entry.target === key).map((entry) => entry.section_id),
				key,
			).toEqual([removedId]);
		}
		await runElement(ZZDIF_SECTION);
	}, 120_000);

	test('a row an earlier engine left in the alias-only table is a ghost the apply withdraws', async () => {
		const ghostKey = globalRowKey(ZZDIF_SECTION, ZZDIF_UNPUBLISHABLE_ID);
		await pool().unsafe(
			`INSERT INTO \`${ZZDIF_GLOBAL_ALIAS_ONLY_TABLE}\` (section_id, lang, title) VALUES (?, ?, 'v6 row')`,
			[ghostKey, config.diffusion.langs[0] ?? null],
		);
		clearDiffusionTargetsCache();
		const ghosts = (await scanPublicTier([ZZDIF_SECTION])).ghosts.filter(
			(ghost) => ghost.target === aliasOnlyKey,
		);
		expect(ghosts.map((ghost) => [ghost.section_id, ghost.reason])).toEqual([
			[ZZDIF_UNPUBLISHABLE_ID, 'unpublishable'],
		]);
		const applied = await unpublishGhosts(ghosts);
		expect(applied.failed).toEqual([]);
		expect(applied.removed).toBe(1);
		expect((await aliasOnlyTitles(pool())).has(`${ghostKey}|${config.diffusion.langs[0]}`)).toBe(
			false,
		);
	});
});
