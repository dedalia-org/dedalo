/**
 * PUBLICATION SCHEMA — an sql element's run writes the `publication_schema` row the
 * publication APIs read for `resolve_inverse_relations=true` / `resolve_portal`
 * (v6 wrote it on ontology save; v7 wrote none, so `true` answered 400 on every
 * v7-published database — pubapi_v2 lab finding F2, 2026-11-24).
 *
 *   PURE — compile: `dd_relations` is the element's own section → table map; the
 *          ontology's `properties.diffusion.publication_schema` is kept verbatim and
 *          its `dd_relations` entries win; `dd_relations` names the table the plan writes
 *          (a real table, not an in-element alias); the v6 top-level spelling is read
 *          as a fallback with a warning; a
 *          malformed map or a table named `publication_schema` is a compile error.
 *   PURE — merge: the run's map is laid over the stored row (elements sharing a
 *          database, v6 field maps no v7 property declares), dd_relations key by key.
 *   LIVE — the writer stores row 1 at ensureSchema; a pre-existing v6 row keeps its
 *          field maps and the run's entries win.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ParserClassifier } from '../../src/diffusion/plan/compile.ts';
import { compileElementPlan, PlanCompileError } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type {
	VirtualDiffusionTree,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';
import { closeAllTargetPools, getTargetPool } from '../../src/diffusion/targets/mariadb/db.ts';
import {
	mergePublicationSchema,
	PUBLICATION_SCHEMA_TABLE,
} from '../../src/diffusion/targets/mariadb/sql_generator.ts';
import { mariadbSqlWriter } from '../../src/diffusion/writers/mariadb_sql.ts';
import { dropSuiteScratchTables, requireSuiteMariadb } from '../helpers/suite_mariadb.ts';
import { zzdTargetDatabases } from '../helpers/zzd_diffusion_fixture.ts';

const testClassifier: ParserClassifier = () => 'runtime';

/** el → db → two tables (sec1 → 'objects', sec2 → 'images'), one varchar field each. */
function syntheticTree(
	elementProperties: Record<string, unknown>,
	firstTableName = 'objects',
	withAlias = false,
): VirtualDiffusionTree {
	const models: Record<string, string> = {
		dom: 'diffusion_domain',
		el: 'diffusion_element',
		db: 'database',
		tbl1: 'table',
		tbl2: 'table',
		tbl3: 'table_alias',
		f1: 'field_varchar',
		f2: 'field_varchar',
		f3: 'field_varchar',
	};
	const labels: Record<string, string> = {
		db: 'web_synthetic',
		tbl1: firstTableName,
		tbl2: 'images',
		f1: 'title',
		f2: 'caption',
		tbl3: 'objects_alias',
		f3: 'title',
	};
	const children: Record<string, string[]> = { tbl1: ['f1'], tbl2: ['f2'], tbl3: ['f3'] };
	const index = {
		nodeOf: async (tipo: string) =>
			models[tipo] === undefined
				? null
				: {
						tipo,
						parent: null,
						model: models[tipo],
						term: labels[tipo] === undefined ? null : { 'lg-eng': labels[tipo] },
						properties: null,
						relations: null,
					},
		childTipos: async (tipo: string) => children[tipo] ?? [],
		relatedByModel: async () => [],
		relationTipos: async () => [],
		resolveAlias: async () => null,
	};
	const pathOf = (...tipos: string[]) =>
		tipos.map((tipo) => ({
			tipo,
			model: models[tipo],
			label: labels[tipo] ?? tipo,
			realTipo: null,
		}));
	const nodeOf = (tipo: string, parents: string[], extra: Partial<VirtualTreeNode> = {}) =>
		({
			tipo,
			model: models[tipo],
			label: labels[tipo] ?? tipo,
			properties: tipo === 'el' ? elementProperties : null,
			realTipo: null,
			isAlias: false,
			parents: pathOf(...parents),
			childrenTipos: children[tipo] ?? [],
			directChildrenTipos: children[tipo] ?? [],
			relatedSections: [],
			...extra,
		}) as VirtualTreeNode;
	return {
		domainName: 'synthetic',
		domainTipo: 'dom',
		index,
		nodes: [
			nodeOf('dom', []),
			nodeOf('el', ['dom']),
			nodeOf('db', ['el', 'dom']),
			nodeOf('tbl1', ['db', 'el', 'dom'], { relatedSections: ['sec1'] }),
			nodeOf('tbl2', ['db', 'el', 'dom'], { relatedSections: ['sec2'] }),
			...(withAlias ? [nodeOf('tbl3', ['db', 'el', 'dom'], { relatedSections: ['sec1'] })] : []),
		],
	} as unknown as VirtualDiffusionTree;
}

const compile = (properties: Record<string, unknown>, firstTableName?: string, withAlias = false) =>
	compileElementPlan('el', {
		tree: syntheticTree(properties, firstTableName, withAlias),
		classifyParserFn: testClassifier,
	});

async function compileErrors(properties: Record<string, unknown>, firstTableName?: string) {
	try {
		await compile(properties, firstTableName);
	} catch (error) {
		expect(error).toBeInstanceOf(PlanCompileError);
		return (error as PlanCompileError).compileErrors;
	}
	throw new Error('expected a PlanCompileError');
}

describe('publication_schema — compile', () => {
	test('no ontology map: dd_relations is the element’s own section → table map', async () => {
		const plan = await compile({ diffusion: { type: 'sql' } });
		expect(plan.publicationSchema).toEqual({ dd_relations: { sec1: 'objects', sec2: 'images' } });
	});

	test('the ontology map is kept verbatim and its dd_relations entries win', async () => {
		const plan = await compile({
			diffusion: {
				type: 'sql',
				publication_schema: {
					image: 'images',
					dd_relations: { sec2: 'pictures', test1: 'interview' },
				},
			},
		});
		expect(plan.publicationSchema).toEqual({
			image: 'images',
			dd_relations: { sec1: 'objects', sec2: 'pictures', test1: 'interview' },
		});
	});

	test('dd_relations names the table the plan writes, not an in-element alias of it', async () => {
		const plan = await compile({ diffusion: { type: 'sql' } }, undefined, true);
		expect(plan.sections.find((s) => s.sectionTipo === 'sec1')?.tableName).toBe('objects');
		expect(plan.publicationSchema).toEqual({ dd_relations: { sec1: 'objects', sec2: 'images' } });
	});

	test('the v6 top-level spelling is read when the nested one is absent, with a warning', async () => {
		const plan = await compile({
			diffusion: { type: 'sql' },
			publication_schema: { image: 'images' },
		});
		expect(plan.publicationSchema).toEqual({
			image: 'images',
			dd_relations: { sec1: 'objects', sec2: 'images' },
		});
		expect(
			plan.warnings.some((w) => w.includes("top-level 'publication_schema' is the v6 spelling")),
		).toBe(true);
	});

	test('both spellings: the nested one wins and the top-level one is named as ignored', async () => {
		const plan = await compile({
			diffusion: { type: 'sql', publication_schema: { photo: 'images' } },
			publication_schema: { image: 'images' },
		});
		expect(plan.publicationSchema).toEqual({
			photo: 'images',
			dd_relations: { sec1: 'objects', sec2: 'images' },
		});
		expect(plan.warnings.some((w) => w.includes('is ignored'))).toBe(true);
	});
});

describe('publication_schema — merge over the stored row', () => {
	const ours = { image: 'images', dd_relations: { sec1: 'objects' } };

	test('no stored row, or an unreadable one: the run’s map as is', () => {
		expect(mergePublicationSchema(undefined, ours)).toEqual(ours);
		expect(mergePublicationSchema('not json', ours)).toEqual(ours);
		expect(mergePublicationSchema('[1]', ours)).toEqual(ours);
	});

	test('another element’s entries and v6 field maps survive; the run’s entries win', () => {
		const stored = JSON.stringify({
			image: 'old_images',
			informant: 'informant',
			dd_relations: { sec1: 'old_objects', test1: 'interview' },
		});
		expect(mergePublicationSchema(stored, ours)).toEqual({
			image: 'images',
			informant: 'informant',
			dd_relations: { sec1: 'objects', test1: 'interview' },
		});
	});

	test('a malformed map is a compile error, never dropped silently', async () => {
		expect(
			await compileErrors({ diffusion: { type: 'sql', publication_schema: ['images'] } }),
		).toEqual([
			expect.stringContaining('properties.diffusion.publication_schema must be an object'),
		]);
		expect(
			await compileErrors({ diffusion: { type: 'sql', publication_schema: { image: 7 } } }),
		).toEqual([
			expect.stringContaining('properties.diffusion.publication_schema must be an object'),
		]);
		expect(
			await compileErrors({
				diffusion: { type: 'sql', publication_schema: { dd_relations: { sec1: ['x'] } } },
			}),
		).toEqual([expect.stringContaining('publication_schema.dd_relations must be an object')]);
	});

	test('a table named publication_schema is a compile error', async () => {
		expect(await compileErrors({ diffusion: { type: 'sql' } }, PUBLICATION_SCHEMA_TABLE)).toEqual([
			expect.stringContaining(`a table named '${PUBLICATION_SCHEMA_TABLE}' collides`),
		]);
	});
});

// ---------------------------------------------------------------------------
// LIVE: the writer lands the row the APIs read.
// ---------------------------------------------------------------------------

const TARGET_DATABASE = zzdTargetDatabases()[0] as string;
const TABLE = 'dedalo_ts_test_pubschema';

function planWith(schema: Record<string, unknown>): PublicationPlan {
	const section: SectionPlan = {
		sectionTipo: 'test3',
		tableName: TABLE,
		tableTipo: 'testdd0',
		fields: [],
	};
	return {
		planId: 'suite-pubschema',
		elementTipo: 'testdd_element',
		format: 'sql',
		serviceName: null,
		target: { kind: 'table', database: TARGET_DATABASE },
		sections: [section],
		recursion: { maxLevels: 1 },
		langPolicy: { langs: ['lg-eng'], mainLang: 'lg-eng' },
		warnings: [],
		publicationSchema: schema,
	};
}

async function readSchemaRows(): Promise<{ id: number; data: string }[]> {
	return (await getTargetPool(TARGET_DATABASE).unsafe(
		`SELECT id, data FROM ${PUBLICATION_SCHEMA_TABLE}`,
		[],
	)) as { id: number; data: string }[];
}

describe('publication_schema — writer', () => {
	beforeAll(async () => {
		await requireSuiteMariadb('test/unit/diffusion_publication_schema_native.test.ts', [
			TARGET_DATABASE,
		]);
		await dropSuiteScratchTables(TARGET_DATABASE, [TABLE, PUBLICATION_SCHEMA_TABLE]);
	});
	afterAll(async () => {
		await dropSuiteScratchTables(TARGET_DATABASE, [TABLE, PUBLICATION_SCHEMA_TABLE]);
		await closeAllTargetPools();
	});

	test('ensureSchema stores the map as row 1, then merges the next run over it', async () => {
		const first = { image: 'images', dd_relations: { test3: TABLE } };
		await (await mariadbSqlWriter.open(planWith(first))).ensureSchema();
		const rowsAfterFirst = await readSchemaRows();
		expect(rowsAfterFirst.map((row) => [Number(row.id), JSON.parse(row.data)])).toEqual([
			[1, first],
		]);

		const second = { dd_relations: { test3: 'other_table', test1: 'interview' } };
		await (await mariadbSqlWriter.open(planWith(second))).ensureSchema();
		const rowsAfterSecond = await readSchemaRows();
		expect(rowsAfterSecond.map((row) => [Number(row.id), JSON.parse(row.data)])).toEqual([
			[1, { image: 'images', dd_relations: { test3: 'other_table', test1: 'interview' } }],
		]);
	});

	test('a v6-shaped row (MyISAM, utf8mb3) keeps its field maps', async () => {
		const pool = getTargetPool(TARGET_DATABASE);
		await dropSuiteScratchTables(TARGET_DATABASE, [PUBLICATION_SCHEMA_TABLE]);
		await pool.unsafe(
			`CREATE TABLE ${PUBLICATION_SCHEMA_TABLE} (id int(11) NOT NULL, data mediumtext NOT NULL, PRIMARY KEY (id)) ENGINE=MyISAM DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci`,
			[],
		);
		await pool.unsafe(`INSERT INTO ${PUBLICATION_SCHEMA_TABLE} (id, data) VALUES (1, ?)`, [
			JSON.stringify({ image: 'image', informant: 'informant' }),
		]);
		await (
			await mariadbSqlWriter.open(planWith({ dd_relations: { test3: TABLE } }))
		).ensureSchema();
		const rows = await readSchemaRows();
		expect(rows.map((row) => [Number(row.id), JSON.parse(row.data)])).toEqual([
			[1, { image: 'image', informant: 'informant', dd_relations: { test3: TABLE } }],
		]);
	});
});
