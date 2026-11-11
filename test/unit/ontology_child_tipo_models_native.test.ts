/**
 * getChildTipoModels (src/core/ontology/resolver.ts) — the cached children
 * accessor of the implicit EDIT walk (implicit.ts buildImplicitSectionEditConfig).
 *
 * The walk issued one raw SELECT per visited node on every build — 33 per
 * autocomplete keystroke on an `ontology_sections` portal, warm. Law held here:
 *  1. ORDER — the cached answer is exactly the raw `ORDER BY order_number, id`
 *     the walk always used (a tie in order_number falls to id, NOT tipo);
 *  2. COST — a warm build reads no children from the database;
 *  3. INVALIDATION — a real dd_ontology write (upsertDdOntologyNode, the hub)
 *     is seen by the very next build, with no manual cache clear.
 *
 * SCRATCH SURFACES ONLY: a `zzchildwalk` TLD section under the `dd14` area,
 * torn down with deleteTldNodes (which fires the hub).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithQueryTap } from '../../src/core/db/query_tap.ts';
import { getChildTipoModels } from '../../src/core/ontology/resolver.ts';
import { buildImplicitSectionEditConfig } from '../../src/core/relations/request_config/implicit.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzchildwalk';
const SECTION = `${TLD}1`;
const GROUP = `${TLD}2`;
const FIELD_A = `${TLD}3`;
const FIELD_B = `${TLD}4`;
const NESTED = `${TLD}5`;
const LATE = `${TLD}6`;
const HOST_AREA = 'dd14';

const node = (tipo: string, model: string, parent: string, order: number) =>
	upsertDdOntologyNode({
		tipo,
		model,
		parent,
		tld: TLD,
		order_number: order,
		term: { 'lg-eng': `child walk ${tipo}` },
	});

const editTipos = async (): Promise<string[]> => {
	const config = await buildImplicitSectionEditConfig({
		ownerTipo: SECTION,
		ownerSectionTipo: SECTION,
		mode: 'edit',
		ownerIsSection: true,
	});
	return (config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);
};

const rawChildren = async (parent: string) =>
	(await sql`
		SELECT tipo, model FROM dd_ontology WHERE parent = ${parent} ORDER BY order_number, id
	`) as { tipo: string; model: string | null }[];

beforeAll(async () => {
	await assertTestDatabase('ontology_child_tipo_models_native');
	await deleteTldNodes(TLD);
	await node(SECTION, 'section', HOST_AREA, 1);
	// inserted FIRST, ordered LAST: the order is order_number, not insertion
	await node(GROUP, 'section_group', SECTION, 2);
	// a tie on order_number: id (insertion) decides — FIELD_B before FIELD_A by tipo would be wrong
	await node(FIELD_B, 'component_input_text', SECTION, 1);
	await node(FIELD_A, 'component_input_text', SECTION, 1);
	await node(NESTED, 'component_input_text', GROUP, 1);
}, 60000);

afterAll(async () => {
	await deleteTldNodes(TLD); // fires the hub — leaves no scratch cache state
}, 60000);

describe('getChildTipoModels — the implicit edit walk, cached', () => {
	test('order: exactly the raw ORDER BY order_number, id (tie falls to id, not tipo)', async () => {
		for (const parent of [SECTION, GROUP]) {
			expect([...(await getChildTipoModels(parent))]).toEqual(await rawChildren(parent));
		}
		expect((await getChildTipoModels(SECTION)).map((row) => row.tipo)).toEqual([
			FIELD_B,
			FIELD_A,
			GROUP,
		]);
		expect(await editTipos()).toEqual([FIELD_B, FIELD_A, GROUP, NESTED]);
	});

	test('cost: a warm build reads no children from the database; a cold one does', async () => {
		await deleteTldNodes('zzchildwalknone'); // a hub fire: every ontology cache cold
		const cold = await runWithQueryTap('child walk cold', editTipos);
		const warm = await runWithQueryTap('child walk warm', editTipos);
		const childReads = (report: typeof cold.report) =>
			report.callers
				.filter((caller) => caller.frames.includes('getChildTipoModels'))
				.reduce((sum, caller) => sum + caller.count, 0);
		expect(childReads(cold.report)).toBeGreaterThanOrEqual(2); // SECTION + GROUP (anti-vacuity)
		expect(childReads(warm.report)).toBe(0);
		expect(warm.result).toEqual(cold.result);
	});

	test('invalidation: a dd_ontology write is seen by the next build, no manual clear', async () => {
		expect(await editTipos()).not.toContain(LATE); // warm cache holds the old children
		await node(LATE, 'component_input_text', GROUP, 2);
		expect(await editTipos()).toEqual([FIELD_B, FIELD_A, GROUP, NESTED, LATE]);
	});

	test('the answer is frozen: a caller cannot corrupt the cache', async () => {
		const children = await getChildTipoModels(SECTION);
		expect(Object.isFrozen(children)).toBe(true);
		expect(Object.isFrozen(children[0])).toBe(true);
	});
});
