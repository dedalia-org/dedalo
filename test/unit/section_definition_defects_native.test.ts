/**
 * TWO ONTOLOGY DEFINITION DEFECTS A SECTION LIST MUST SURVIVE (feature crawl #3, #4).
 *
 *  #4 — a section_list relation naming a model='label' node (dd1500/dd1560 list dd1478 and
 *       dd1543): the implicit column builder resolved the label node's term and the label
 *       guard refused it — internal.invariant on a dev server, a blank column in production.
 *       Label nodes are inert program strings: never a column.
 *  #3 — a section whose matrix_table is not a v7 record table (rsc370 → the v6
 *       `matrix_structurations`, never migrated): the search assembler's identifier gate
 *       answered internal.invariant (an engine bug). It is a DEFINITION defect the install
 *       must correct: ontology.invalid_node.
 *
 * Scratch TLDs zzlbl (situation) and zzbt (one node, torn down by TLD — dropSituation would
 * sweep the node's nonexistent table). dd1478 / dd489 are seed ontology, read only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { buildImplicitComponentListConfig } from '../../src/core/relations/request_config/implicit.ts';
import { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const LABEL_NODE = 'dd1478';
const LEGACY_TABLE_NODE = 'dd489'; // matrix_table 'matrix_structurations'

const LIST_SITUATION = situation({
	name: 'section_list with a label node',
	tld: 'zzlbl',
	nodes: [
		{ tipo: 'zzlbl1', parent: 'test1', model: 'section', term: { 'lg-eng': 'zzlbl section' } },
		{ tipo: 'zzlbl2', parent: 'zzlbl1', model: 'component_input_text', order_number: 1 },
		{
			tipo: 'zzlbl3',
			parent: 'zzlbl1',
			model: 'section_list',
			order_number: 2,
			relations: [{ tipo: 'zzlbl2' }, { tipo: LABEL_NODE }],
		},
	],
});

describe.if(DB_READY)('#4 a label node in a section_list is never a column', () => {
	beforeAll(async () => {
		await assertTestDatabase('section_definition_defects_native #4');
		await ensureSituation(LIST_SITUATION);
	});
	afterAll(async () => {
		expect(await dropSituation(LIST_SITUATION)).toBe(0);
	});

	test('the label node is dropped; the component column stays', async () => {
		expect(await getModelByTipo(LABEL_NODE)).toBe('label'); // non-vacuity
		const config = await buildImplicitComponentListConfig('zzlbl3', {
			ownerTipo: 'zzlbl1',
			ownerSectionTipo: 'zzlbl1',
			mode: 'list',
			ownerIsSection: true,
		});
		expect(config[0]?.show?.ddo_map.map((ddo) => ddo.tipo)).toEqual(['zzlbl2']);
	});
});

describe.if(DB_READY)('#3 a section naming a non-record table is an ontology defect', () => {
	beforeAll(async () => {
		await assertTestDatabase('section_definition_defects_native #3');
		await deleteTldNodes('zzbt');
		await upsertDdOntologyNode({
			tipo: 'zzbt1',
			parent: 'test1',
			model: 'section',
			tld: 'zzbt',
			term: { 'lg-eng': 'zzbt legacy-table section' },
			relations: [{ tipo: LEGACY_TABLE_NODE }],
		});
	});
	afterAll(async () => {
		await assertTestDatabase('section_definition_defects_native #3 teardown');
		await deleteTldNodes('zzbt');
	});

	test('a list read answers ontology.invalid_node, not internal.invariant', async () => {
		expect(await getMatrixTableFromTipo('zzbt1')).toBe('matrix_structurations'); // non-vacuity
		const sqo = sanitizeClientSqo({ section_tipo: ['zzbt1'], limit: 1 });
		const error = await buildSearchSql(sqo).then(
			() => null,
			(e: unknown) => e as { code?: string; message?: string },
		);
		expect(error?.code).toBe('ontology.invalid_node');
		expect(error?.message).toContain('matrix_structurations');
	});
});
